"""Time-weighted density grid with epochs and a float16 column ring.

Design spec §8.1–8.2. Semantics that are load-bearing for the whole product:

- **Density is time-weighted resting size.** Each book update integrates the
  *previous* book state over ``(ts_ns - prev_ts)`` into the current column's
  accumulator; finalize divides the accumulator by ``dt_ns``. Two different
  update cadences over the same book therefore produce byte-identical columns
  (this kills the v1 bug where venue update-rate masqueraded as liquidity).
- **Precision:** accumulation happens in float64; the division by ``dt_ns``
  happens in float64 and only the finished density is cast to float16 for
  ring storage.
- **Epochs:** all columns in an epoch share ``(p0, tick, tick_multiple, dt)``.
  When mid exits the central 70 % of the span, :meth:`Grid.maybe_reanchor`
  bumps the epoch and recenters ``p0`` (snapped to the ``tick * tick_multiple``
  grid). History in the ring is NEVER rewritten — old columns keep their epoch.
  A linear accumulator is row-shifted into the new epoch's coordinates. A
  hybrid accumulator is conservatively redistributed by its buckets' physical
  price overlap; unresolved coarse buckets stay unresolved. A column finalized
  after a mid-interval re-anchor carries the new epoch.
- **Interval boundaries:** interval ``k`` covers ``[k*dt, (k+1)*dt)``. An
  ``on_book`` at exactly a boundary finalizes the ending interval using the
  previous book integrated to the boundary; the new state applies from the
  boundary forward. A zero-span duplicate call whose timestamp equals the end
  of the most recently finalized column re-returns that column (idempotent —
  the ring and ``col_seq`` are untouched; callers dedup by ``col_seq``).
- **Bars:** ``vol_buy`` / ``vol_sell`` and OHLC are per-interval;
  ``cvd_cum`` / ``vwap_num_cum`` / ``vwap_den_cum`` are session-cumulative.
  Unknown-side trades feed neither volume bucket and leave cvd unchanged,
  but DO count toward the vwap sums. Intervals without trades carry the
  previous close as ``o == h == l == c`` (NaN before the first trade ever).

Time advancement is driven by :meth:`Grid.on_book` only; :meth:`Grid.on_trade`
accumulates into the current interval's bar and never finalizes columns.
"""

from __future__ import annotations

import math

import msgspec
import numpy as np

from flowmap_server.core.price_scale import (
    SCALE_HYBRID,
    PriceScale,
    epoch_scale_fields,
    linear_scale,
    make_hybrid,
    row_to_price,
    scale_of,
)
from flowmap_server.core.price_scale_np import rows_for_prices
from flowmap_server.proto.events import (
    MODE_SYNTH_PROFILE,
    SIDE_BUY,
    SIDE_SELL,
    BarColumn,
    BookUpdate,
    DepthColumn,
    EpochParams,
)

_NAN = float("nan")


# Extra coverage factor applied to a percentage band, so the grid still holds
# the requested range after mid drifts within it and the re-anchor trip fires.
BAND_MARGIN = 1.25

# How far mid may drift, as a RATIO of the anchor mid, before the grid
# re-anchors. A ratio trip, not a span-fraction trip: with an asymmetric band
# (e.g. -100%/+1000%) mid sits at ~1/11 of the span, i.e. permanently below a
# `p0 + 0.15*span` low guard, which would re-anchor on EVERY book update and
# storm epochs forever.
BAND_TRIP_RATIO = 1.25

# Price-adaptive ticking for feeds that declare ``price_adaptive_tick``.
# The fixed crypto fallback tick ($0.50) is calibrated for BTC-scale
# instruments: at a $2.5k mid it spans ±512 USD, at a $0.08 mid the book
# collapses into <1 row (and the axis frame reaches negative prices). A fixed
# tick at/above ``mid * TICK_COARSE_RATIO`` is "coarse" for that instrument and
# is replaced by the 5th significant digit of its own price.
TICK_COARSE_RATIO = 1e-3
# Significant digits kept by the adapted tick: tick = 10**floor(log10(mid))
# scaled down to the TICK_SIG_DIGITS-th digit. 5 digits gives DOGE $0.0825 ->
# 1e-6 (half-frame $0.0010, ~10 rows per $0.00001 venue tick) and SOL $99.6 ->
# 1e-3, while every mid keeps a strictly positive frame at 2048 rows.
TICK_SIG_DIGITS = 5

# Native ticks give BTC only ~$20 of deep-core coverage at 2048 rows.
# Group depth into venue-tick multiples; trade/quote prices stay exact.
DEEP_CORE_MIN_SPAN_RATIO = 0.01


def deep_core_multiple(mid: float, tick: float, rows: int) -> int:
    if not (math.isfinite(mid) and mid > 0 and math.isfinite(tick) and tick > 0 and rows > 0):
        return 1
    required = max(1, math.ceil(mid * DEEP_CORE_MIN_SPAN_RATIO / (rows * tick)))
    decade = 10 ** int(math.floor(math.log10(required)))
    return next(n * decade for n in (1, 2, 5, 10) if n * decade >= required)


def adaptive_tick_for(mid: float, tick: float) -> float:
    """Price-proportional tick for a small instrument, else the given tick.

    Returns ``tick`` unchanged when it is already fine enough relative to
    ``mid`` (``tick < mid * TICK_COARSE_RATIO``) — BTC/ETH keep their $0.50
    step byte-for-byte. Otherwise the tick becomes the 5th significant digit
    of the mid itself (a power-of-10 fraction of price). Any non-finite or
    non-positive input is returned unchanged: this is called straight off feed
    data, never raises.
    """
    if not math.isfinite(mid) or mid <= 0.0:
        return tick
    if not math.isfinite(tick) or tick <= 0.0:
        return tick
    if tick < mid * TICK_COARSE_RATIO:
        return tick
    decade = 10.0 ** math.floor(math.log10(mid))
    return decade * 10.0 ** -(TICK_SIG_DIGITS - 1)


class GridCfg(msgspec.Struct, frozen=True):
    """Immutable grid configuration for one session."""

    tick: float
    tick_multiple: int
    dt_ns: int
    p0: float
    rows: int
    ring_columns: int
    mode: int  # MODE_L2 | MODE_L1_BAND | MODE_SYNTH_PROFILE
    # Percentage coverage around the reference price, as fractions: ``band_up``
    # 9.0 means "+900% above mid". ``None`` selects the legacy fixed-span grid
    # (``tick_multiple`` as given, ``p0`` recentred on the central-70% rule).
    band_up: float | None = None
    band_down: float | None = None
    # Opt into the HYBRID price scale (log wing / linear core / log wing) for
    # this band. Off by default, so every existing grid stays linear.
    band_hybrid: bool = False
    # Rows given to the linear core; 0 => rows // 2.
    core_rows: int = 0
    # Opt into price-proportional ticking on the legacy (native) linear grid:
    # at the first real mid a fallback tick too coarse for the instrument is
    # replaced by ``adaptive_tick_for(mid, tick)`` (see there). Off by default
    # so explicit ticks and every existing grid stay exactly as configured.
    auto_tick: bool = False


def band_frame(
    mid: float,
    band_up: float,
    band_down: float,
    tick: float,
    rows: int,
) -> tuple[float, int] | None:
    """``(p0, tick_multiple)`` covering ``[mid*(1-down), mid*(1+up)]``.

    The grid is a LINEAR affine over a FIXED row count, so range and resolution
    are the same knob: widening the band can only make ``tick_multiple`` — and
    therefore every row — coarser. That is inherent, not an implementation
    choice, and it is why the default band is ``None``.

    ``tick_multiple`` is derived from the SNAPPED frame (p0 is rounded onto the
    step grid first, then the multiple is re-checked), so the returned frame
    provably covers the requested range rather than falling one row short.

    Returns ``None`` for a non-finite or non-positive ``mid``: a feed-derived
    NaN reaching ``math.ceil`` would raise inside :meth:`Grid.maybe_reanchor`,
    which the session calls with no ``try`` — killing the session task.
    """
    if not math.isfinite(mid) or mid <= 0.0 or rows <= 0 or tick <= 0.0:
        return None
    lo = mid * max(0.0, 1.0 - band_down)
    hi = mid * (1.0 + band_up)
    span = (hi - lo) * BAND_MARGIN
    if not math.isfinite(span) or span <= 0.0:
        return None
    tm = max(1, math.ceil(span / (rows * tick)))
    step = tick * tm
    p0 = max(0.0, math.floor((lo - (span - (hi - lo)) / 2.0) / step) * step)
    # Re-check against the SNAPPED frame; rounding p0 down can uncover the top.
    while p0 + rows * step < hi and tm < 1 << 30:
        tm += 1
        step = tick * tm
        p0 = max(0.0, math.floor((lo - (span - (hi - lo)) / 2.0) / step) * step)
    return (p0, tm)


class FinalizedColumn(msgspec.Struct):
    """A finalized density column plus its bar, as stored in the ring."""

    epoch: int
    col_seq: int
    t0_ns: int
    bid: np.ndarray  # venue units, f16 or unpacked f32, length rows
    ask: np.ndarray  # venue units, f16 or unpacked f32, length rows
    bar: BarColumn


class Grid:
    """Per-session density grid: time-weighted accumulation, epochs, ring."""

    def __init__(self, cfg: GridCfg) -> None:
        if cfg.rows <= 0 or cfg.ring_columns <= 0 or cfg.dt_ns <= 0:
            raise ValueError("rows, ring_columns and dt_ns must be positive")
        self._cfg = cfg
        # tick_multiple is MUTABLE only until the first real-mid band anchor,
        # then frozen for the session (see maybe_reanchor). ``_tick`` is mutable
        # for the same reason on auto_tick grids: the fallback tick cannot
        # serve a sub-dollar instrument, so the first real mid may install a
        # price-proportional one (never after a column exists or a tail was
        # preloaded — the client draws all resident columns through ONE row
        # affine).
        self._tick = cfg.tick
        self._tick_multiple = cfg.tick_multiple
        self._step = self._tick * cfg.tick_multiple
        self._p0 = cfg.p0
        self._epoch = 0
        # Band state. `_anchor_mid` is the mid the current frame was built for;
        # the ratio trip is measured against it. None until the first book.
        self._banded = cfg.band_up is not None and cfg.band_down is not None
        self._anchor_mid: float | None = None
        self._band_anchored = False
        # True once the tick is frozen for the session: set by a rehydrated/
        # backfilled frame (preload) or by the first real mid on an auto_tick
        # grid. The adaptive path only fires while this is False.
        self._tick_anchored = False
        # True once ANY column with nonzero density has been finalized. A live
        # feed can emit trades before the first depth snapshot, finalizing
        # all-zero columns; adapting the tick is still safe then (nothing real
        # was painted), but never once ink is in the ring — the client draws
        # every resident column through ONE row affine.
        self._frozen_nonzero = False
        # The row<->price map. For a linear grid this is kept in lockstep with
        # _p0/_step, which remain the truth there; a hybrid band replaces it
        # wholesale on its first real-mid anchor.
        self._scale: PriceScale = linear_scale(self._p0, self._step, cfg.rows)
        # Per-epoch params table (spec §6.3): snapshot/history must be able to
        # announce EVERY epoch still present in the ring, not just the current
        # one. Populated here (epoch 0) and on every re-anchor; kept for the
        # session lifetime (re-anchors are rare, entries are tiny).
        self._epoch_params: dict[int, EpochParams] = {
            0: EpochParams(
                epoch=0,
                tick=self._tick,
                tick_multiple=cfg.tick_multiple,
                dt_ns=cfg.dt_ns,
                p0=cfg.p0,
                rows=cfg.rows,
            )  # epoch 0 is always the linear seed; a band installs its own on
            #  the first real mid, which bumps the epoch.
        }

        rows = cfg.rows
        # Current-interval accumulator and dense book state, [2, rows] f64
        # (channel 0 = bid, channel 1 = ask).
        self._acc = np.zeros((2, rows), dtype=np.float64)
        self._state = np.zeros((2, rows), dtype=np.float64)
        # Raw last book (price/size copies) so the dense state can be rebuilt
        # against a new p0 at re-anchor (out-of-range levels return then).
        self._last_book: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray] | None = None

        self._prev_ts: int | None = None
        self._cur_idx: int | None = None  # current interval index; t0 = idx * dt_ns
        self._count = 0  # next col_seq (may exceed finalized count after a capped gap skip) (never resets)
        # Oldest col_seq ever placed in the ring. 0 for a cold grid; a
        # :meth:`preload` of a recorded tail that starts mid-sequence raises it
        # so history()/oldest_retained_t0_ns() never dereference ring slots
        # that were never written (their bars are None).
        self._oldest_seq = 0

        # Ring storage: float16 [ring_columns, 2, rows] + parallel metadata.
        rc = cfg.ring_columns
        self._ring = np.zeros((rc, 2, rows), dtype=np.float16)
        # Block-floating storage keeps the f16 RAM budget without clipping
        # large base-unit books (SHIB/PEPE) to 65504. Wire and recordings carry
        # reconstructed venue units, not the packed mantissas.
        self._ring_scale = np.ones(rc, dtype=np.float64)
        self._ring_epoch = np.zeros(rc, dtype=np.uint32)
        self._ring_t0 = np.zeros(rc, dtype=np.int64)
        self._ring_seq = np.zeros(rc, dtype=np.uint32)
        self._ring_bars: list[BarColumn | None] = [None] * rc

        # Bar state for the current interval.
        self._o = self._h = self._l = self._c = _NAN
        self._prev_close = _NAN
        self._bar_has_trade = False
        self._vol_buy = 0.0
        self._vol_sell = 0.0
        # Session-cumulative accumulators.
        self._cvd_cum = 0.0
        self._vwap_num_cum = 0.0
        self._vwap_den_cum = 0.0

    @property
    def cfg(self) -> GridCfg:
        """The immutable grid configuration (read-only)."""
        return self._cfg

    # -- rehydration (spec §8.1 restart) ---------------------------------------

    def preload(self, columns: list[FinalizedColumn], epochs: list[EpochParams]) -> None:
        """Seed the ring from a recorded tail (spec §8.1 restart rehydration).

        Only valid on a *virgin* grid — before any :meth:`on_book` or
        :meth:`on_trade` has anchored time (raises ``RuntimeError``
        otherwise). Restores:

        - the ring contents (densities, t0, epoch, col_seq, bars),
        - the col_seq counter (``columns[-1].col_seq + 1`` is the next seq),
        - the epoch params table, the current epoch and its ``p0`` frame,
        - bar continuity (``prev_close`` and the session-cumulative
          cvd/vwap accumulators continue from the tail's last bar).

        ``columns`` must be chronological with strictly increasing
        ``col_seq``/``t0_ns`` (what :meth:`Recorder.load_tail` returns) and
        ``epochs`` must cover every epoch they reference; every epoch must
        match this grid's ``(dt_ns, rows)`` and carry either the nominal
        ``tick`` or the NEWEST epoch's tick (an ``auto_tick`` grid records the
        adapted one — e.g. DOGE 1e-6). A tail whose tick is still too coarse
        for its own recorded price (a pre-fix DOGE recording at $0.50) is
        rejected too: the caller cold-starts and the backfill re-bins the
        history in a usable frame instead of perpetuating the collapse.
        ``ValueError`` otherwise.

        Live columns then continue at ``col_seq = columns[-1].col_seq + 1``
        with wall-anchored ``t0`` — the seq<->t0 affinity intentionally
        breaks across the restart gap (there was no data; the session emits
        a ``Marker{kind=gap}`` there). The ring stays seq-contiguous, which
        is what :meth:`history` and the snapshot path rely on.
        """
        if self._cur_idx is not None or self._count != 0:
            raise RuntimeError("preload is only valid before any on_book/on_trade")
        if not columns:
            return
        cfg = self._cfg
        ep_map = {e.epoch: e for e in epochs}
        missing = {c.epoch for c in columns} - ep_map.keys()
        if missing:
            raise ValueError(f"columns reference unknown epochs {sorted(missing)}")
        # In band mode tick_multiple is DERIVED from the first real mid, so a
        # recorded tail legitimately carries a different one from cfg. A tail
        # that spans the FIRST band anchor carries BOTH: epoch 0 columns were
        # written under the nominal cfg multiple before the mid froze a banded
        # one (M3). So the shape fields must match for every epoch, but the
        # multiple only has to be either the nominal one or the NEWEST epoch's
        # frozen one — anything else is a shape change and rejects the tail.
        # The tick gets the same treatment on an auto_tick grid: the adapted
        # tick (e.g. DOGE 1e-6) is not cfg.tick but is what the tail carries.
        newest = ep_map[columns[-1].epoch]
        newest_tm = newest.tick_multiple
        allowed_tm = {cfg.tick_multiple, newest_tm}
        allowed_tick = {cfg.tick, newest.tick} if cfg.auto_tick else {cfg.tick}
        for e in ep_map.values():
            if e.tick not in allowed_tick or (e.dt_ns, e.rows) != (cfg.dt_ns, cfg.rows):
                raise ValueError(
                    f"epoch {e.epoch} params {e} do not match grid cfg "
                    f"(tick={cfg.tick}, dt_ns={cfg.dt_ns}, rows={cfg.rows})"
                )
            if e.tick_multiple not in allowed_tm:
                raise ValueError(
                    f"epoch {e.epoch} tick_multiple {e.tick_multiple} matches "
                    f"neither cfg {cfg.tick_multiple} nor the tail's frozen "
                    f"{newest_tm}"
                )
        # Refuse a tail recorded on a tick its own price has outgrown (a
        # pre-fix DOGE/USDT recording: $0.50 rows on a $0.08 asset). Keeping
        # it would perpetuate the sub-row collapse; the caller cold-starts and
        # the backfill re-bins the candles in the adapted frame.
        newest_close = columns[-1].bar.c
        # A hybrid tail's fine resolution is authoritative. A large price
        # drift must roll its restored core, not recompute a coarser multiple
        # or reject the unchanged native step used by its historical epochs.
        if (
            cfg.auto_tick
            and math.isfinite(newest_close)
            and newest_close > 0.0
            and newest.tick >= newest_close * TICK_COARSE_RATIO
        ):
            raise ValueError(
                f"recorded tick {newest.tick} is too coarse for the recorded "
                f"price {newest_close}; re-bin via cold start"
            )
        columns = columns[-cfg.ring_columns :]
        prev = None
        for c in columns:
            if len(c.bid) != cfg.rows or len(c.ask) != cfg.rows:
                raise ValueError(f"column seq={c.col_seq} has wrong row count")
            if prev is not None:
                # Contiguity — not just monotonicity — is load-bearing: history()
                # and _column_from_ring assume every seq in [oldest, _count) was
                # written. A gap-cap skip in a prior session can make load_tail
                # return a non-contiguous window (e.g. ring_columns raised between
                # runs); reject it so _apply_tail degrades to a cold start (§8.1)
                # instead of crashing the first attach with a missing-bar assert.
                if c.col_seq != prev.col_seq + 1:
                    raise ValueError(
                        f"columns must be contiguous to rehydrate; "
                        f"seq {prev.col_seq} -> {c.col_seq}"
                    )
                if c.t0_ns <= prev.t0_ns:
                    raise ValueError("columns must be strictly increasing in t0_ns")
            prev = c

        rc = cfg.ring_columns
        for c in columns:
            i = c.col_seq % rc
            packed, scale = self._pack_density(np.stack((c.bid, c.ask)))
            self._ring[i] = packed
            self._ring_scale[i] = scale
            self._ring_epoch[i] = c.epoch
            self._ring_t0[i] = c.t0_ns
            self._ring_seq[i] = c.col_seq
            self._ring_bars[i] = c.bar
        last = columns[-1]
        self._count = last.col_seq + 1
        self._oldest_seq = columns[0].col_seq
        self._epoch = last.epoch
        self._epoch_params.update(ep_map)
        self._p0 = ep_map[last.epoch].p0
        # Adopt the tail's frame, including its FROZEN tick_multiple (and, on
        # an auto_tick grid, its adapted tick), and reconstruct the band anchor
        # from the restored p0. Without this a rehydrated banded session would
        # treat its first book as the initial anchor and emit a spurious
        # EpochStart (and, worse, recompute the multiple against a grid whose
        # history was written with another one).
        self._tick = newest.tick
        self._tick_multiple = newest.tick_multiple
        self._step = self._tick * self._tick_multiple
        # The restored frame freezes the tick; each historical column keeps
        # its own epoch map when the live core subsequently rolls.
        self._tick_anchored = True
        if self._banded:
            self._band_anchored = True
            self._anchor_mid = self._p0 + (self._cfg.rows * self._step) / 2.0
        # Rebuild the row<->price map from the tail's epoch, not the __init__
        # linear seed (H1): a hybrid tail restored without its scale would bin
        # every live book with the linear map from core_p0 — wing rows land on
        # wrong prices or off-grid. scale_of returns the same hybrid/linear
        # kind the epoch was recorded with; a stale hybrid core can then roll
        # on the next real midpoint without changing old columns.
        self._scale = scale_of(ep_map[last.epoch])
        # Bar continuity across the restart.
        self._prev_close = last.bar.c
        self._o = self._h = self._l = self._c = last.bar.c
        self._cvd_cum = last.bar.cvd_cum
        self._vwap_num_cum = last.bar.vwap_num_cum
        self._vwap_den_cum = last.bar.vwap_den_cum

    def reset_replay(self) -> None:
        """Discard replay time and derived state without reallocating the ring."""
        self._ring_bars[:] = [None] * self._cfg.ring_columns
        self._count = self._oldest_seq = 0
        self._cur_idx = self._prev_ts = None
        self._last_book = None
        self._acc.fill(0)
        self._state.fill(0)
        self._o = self._h = self._l = self._c = self._prev_close = _NAN
        self._bar_has_trade = False
        self._vol_buy = self._vol_sell = self._cvd_cum = 0.0
        self._vwap_num_cum = self._vwap_den_cum = 0.0
        self._epoch_params.clear()

    def install_replay_column(self, col: FinalizedColumn, ep: EpochParams, seq: int) -> FinalizedColumn:
        """Install the recorded aggregate directly; it is already finalized.

        Reintegrating a recorded density as raw L2 invents missing intervals,
        loses the first/terminal column and adds trades twice to recorded CVD.
        Replay uses its own contiguous local sequence, retaining actual times,
        recorded epoch geometry and bars. Live ingest is unaffected.
        """
        if len(col.bid) != self._cfg.rows or len(col.ask) != self._cfg.rows:
            raise ValueError("recorded replay row count changed")
        if self._count == 0:
            self._oldest_seq = seq
        self._epoch = ep.epoch
        self._epoch_params[ep.epoch] = ep
        self._tick, self._tick_multiple, self._p0 = ep.tick, ep.tick_multiple, ep.p0
        self._step = ep.tick * ep.tick_multiple
        self._scale = scale_of(ep)
        bar = msgspec.structs.replace(col.bar, col_seq=seq)
        result = FinalizedColumn(epoch=col.epoch, col_seq=seq, t0_ns=col.t0_ns,
                                 bid=col.bid, ask=col.ask, bar=bar)
        i = seq % self._cfg.ring_columns
        packed, scale = self._pack_density(np.stack((col.bid, col.ask)))
        self._ring[i], self._ring_scale[i] = packed, scale
        self._ring_epoch[i], self._ring_t0[i], self._ring_seq[i] = col.epoch, col.t0_ns, seq
        self._ring_bars[i] = bar
        self._count = seq + 1
        self._prev_ts = col.t0_ns
        # No forming interval: the visible right edge is this actual record.
        self._cur_idx = None
        self._state[0], self._state[1] = col.bid, col.ask
        self._o, self._h, self._l, self._c = bar.o, bar.h, bar.l, bar.c
        self._prev_close = bar.c
        self._cvd_cum = bar.cvd_cum
        self._vwap_num_cum, self._vwap_den_cum = bar.vwap_num_cum, bar.vwap_den_cum
        return result

    # -- book / density --------------------------------------------------------

    def on_book(
        self,
        ts_ns: int,
        bid_px: np.ndarray,
        bid_sz: np.ndarray,
        ask_px: np.ndarray,
        ask_sz: np.ndarray,
    ) -> list[FinalizedColumn]:
        """Apply a book state observed at ``ts_ns``.

        Time-weighted: the PREVIOUS book state is integrated over
        ``(ts_ns - prev_ts)``. May finalize 0..k columns (k > 1 if ts jumps
        intervals; skipped intervals emit columns (capped at ring_columns; older intervals are skipped) with the persisted book
        integrated across them). Returns the finalized columns.
        """
        dt = self._cfg.dt_ns
        out: list[FinalizedColumn] = []

        if self._cur_idx is None:
            self._cur_idx = ts_ns // dt
            self._prev_ts = ts_ns
            self._set_book(bid_px, bid_sz, ask_px, ask_sz)
            return out

        assert self._prev_ts is not None
        duplicate = ts_ns == self._prev_ts
        # Non-monotonic timestamps: clamp to zero span (state still replaced).
        cursor = self._prev_ts
        ts_eff = max(ts_ns, cursor)

        # Gap cap: a huge ts jump (e.g. weekend reconnect) would otherwise
        # finalize gap/dt columns — ~900k columns / ~14 GiB of return list for
        # a weekend at dt=250ms — only for all but the last ring_columns of
        # them to be immediately evicted. If the jump crosses more than
        # ring_columns + 1 whole intervals: finalize the current (partial)
        # interval normally, then skip straight to the last ring_columns
        # intervals before ts. col_seq advances by the number of SKIPPED
        # intervals so (col_seq delta == t0 delta / dt_ns) stays true across
        # the gap and t0<->col_seq bookkeeping can rely on monotonicity;
        # skipped seqs are never written to the ring and history() treats
        # them as evicted (a capped call always overwrites the whole ring).
        rc = self._cfg.ring_columns
        if ts_eff // dt - self._cur_idx > rc + 1:
            end = (self._cur_idx + 1) * dt
            span = end - cursor
            if span > 0:
                self._acc += self._state * span
            out.append(self._finalize_current())
            self._cur_idx += 1
            new_idx = ts_eff // dt - rc
            self._count += new_idx - self._cur_idx  # skipped interval count
            self._cur_idx = new_idx
            cursor = new_idx * dt

        while True:
            end = (self._cur_idx + 1) * dt
            if ts_eff < end:
                break
            span = end - cursor
            if span > 0:
                self._acc += self._state * span
            out.append(self._finalize_current())
            cursor = end
            self._cur_idx += 1
        span = ts_eff - cursor
        if span > 0:
            self._acc += self._state * span

        self._prev_ts = ts_eff
        self._set_book(bid_px, bid_sz, ask_px, ask_sz)

        if duplicate and not out and self._count > 0:
            # Zero-span call at exactly the end of the most recently finalized
            # column: re-return it (idempotent; callers dedup by col_seq).
            i = (self._count - 1) % self._cfg.ring_columns
            if int(self._ring_t0[i]) + dt == ts_ns:
                out.append(self._column_from_ring(i))
        return out

    def _set_book(
        self,
        bid_px: np.ndarray,
        bid_sz: np.ndarray,
        ask_px: np.ndarray,
        ask_sz: np.ndarray,
    ) -> None:
        self._last_book = (
            np.array(bid_px, dtype=np.float64, copy=True),
            np.array(bid_sz, dtype=np.float64, copy=True),
            np.array(ask_px, dtype=np.float64, copy=True),
            np.array(ask_sz, dtype=np.float64, copy=True),
        )
        self._state[0] = self._map_levels(bid_px, bid_sz)
        self._state[1] = self._map_levels(ask_px, ask_sz)

    def _map_levels(self, px: np.ndarray, sz: np.ndarray) -> np.ndarray:
        """Scatter price levels into a dense [rows] float64 profile.

        ``row = round((px - p0) / (tick * tick_multiple))``; out-of-range
        levels are dropped (they return after a re-anchor). Non-finite prices
        or sizes (NaN/inf) are dropped BEFORE the rint/int cast — they would
        otherwise poison the density texels and raise RuntimeWarnings.
        """
        rows = self._cfg.rows
        px64 = np.asarray(px, dtype=np.float64)
        sz64 = np.asarray(sz, dtype=np.float64)
        finite = np.isfinite(px64) & np.isfinite(sz64)
        px64 = px64[finite]
        sz64 = sz64[finite]
        if self._scale.kind == SCALE_HYBRID:
            # Non-uniform grid: rows come from the piecewise map. It returns NaN
            # for a non-positive price (log space has no zero), so re-filter —
            # an unfiltered rint(NaN) would bin those onto row 0.
            rf = rows_for_prices(self._scale, px64)
            ok = np.isfinite(rf)
            r = np.rint(rf[ok]).astype(np.int64)
            sz64 = sz64[ok]
        else:
            r = np.rint((px64 - self._p0) / self._step).astype(np.int64)
        mask = (r >= 0) & (r < rows)
        return np.bincount(r[mask], weights=sz64[mask], minlength=rows)

    @staticmethod
    def _pack_density(density: np.ndarray) -> tuple[np.ndarray, float]:
        peak = float(np.max(density))
        if not math.isfinite(peak):
            finite = density[np.isfinite(density)]
            peak = float(finite.max()) if finite.size else 0.0
        scale = 2.0 ** max(0, math.ceil(math.log2(peak / 60000.0))) if peak > 60000 else 1.0
        return (density / scale).astype(np.float16), scale

    @staticmethod
    def _unpack_density(packed: np.ndarray, scale: float) -> np.ndarray:
        return packed.copy() if scale == 1.0 else packed.astype(np.float32) * scale

    def _finalize_current(self) -> FinalizedColumn:
        assert self._cur_idx is not None
        dt = self._cfg.dt_ns
        t0 = self._cur_idx * dt
        # Integrate in venue units, then pack with a per-column exponent.
        density16, scale = self._pack_density(self._acc / float(dt))
        density = self._unpack_density(density16, scale)
        bar = self._snap_bar(t0)

        i = self._count % self._cfg.ring_columns
        self._ring[i] = density16
        self._ring_scale[i] = scale
        self._ring_epoch[i] = self._epoch
        self._ring_t0[i] = t0
        self._ring_seq[i] = self._count
        self._ring_bars[i] = bar
        if not self._frozen_nonzero and float(density16.max()) > 0.0:
            self._frozen_nonzero = True

        col = FinalizedColumn(
            epoch=self._epoch,
            col_seq=self._count,
            t0_ns=t0,
            bid=density[0],
            ask=density[1],
            bar=bar,
        )
        self._count += 1
        self._acc[:] = 0.0
        self._reset_interval_bar()
        return col

    def _column_from_ring(self, i: int) -> FinalizedColumn:
        bar = self._ring_bars[i]
        assert bar is not None
        return FinalizedColumn(
            epoch=int(self._ring_epoch[i]),
            col_seq=int(self._ring_seq[i]),
            t0_ns=int(self._ring_t0[i]),
            bid=self._unpack_density(self._ring[i, 0], self._ring_scale[i]),
            ask=self._unpack_density(self._ring[i, 1], self._ring_scale[i]),
            bar=bar,
        )

    # -- trades / bars ---------------------------------------------------------

    def on_trade(self, ts_ns: int, price: float, size: float, side: int) -> None:
        """Feed a trade into the current interval's bar accumulators.

        Never advances intervals or finalizes columns — time advancement is
        driven by :meth:`on_book`. A trade arriving before any book update
        anchors the current interval at ``ts_ns // dt_ns``.

        A malformed print (non-finite or non-positive price, non-finite or
        negative size) is ignored ENTIRELY — not even time-anchoring:
        ``cvd_cum`` and the ``vwap_*`` sums are session-cumulative, so a
        single NaN or negative print would poison every later bar, and a
        ``+inf`` price would do the same through ``vwap_num_cum`` forever
        (``price > 0`` alone admits it). Same rationale as the finite
        filter in ``_map_levels``; the raw print still reaches the tape and
        the recording via the session, only the DERIVED aggregates are
        protected. A zero-size print is kept (some venues publish them at the
        real price; dropping them would skew OHLC away from venue truth).
        """
        if (
            not (price > 0.0)
            or not math.isfinite(price)
            or not math.isfinite(size)
            or size < 0.0
        ):
            return
        if self._cur_idx is None:
            self._cur_idx = ts_ns // self._cfg.dt_ns
            self._prev_ts = ts_ns

        if self._bar_has_trade:
            self._h = max(self._h, price)
            self._l = min(self._l, price)
        else:
            self._o = self._h = self._l = price
            self._bar_has_trade = True
        self._c = price

        if side == SIDE_BUY:
            self._vol_buy += size
            self._cvd_cum += size
        elif side == SIDE_SELL:
            self._vol_sell += size
            self._cvd_cum -= size
        # SIDE_UNKNOWN: neither volume bucket, cvd unchanged.
        self._vwap_num_cum += price * size
        self._vwap_den_cum += size

    def _snap_bar(self, t0_ns: int) -> BarColumn:
        return BarColumn(
            epoch=self._epoch,
            col_seq=self._count,
            t0_ns=t0_ns,
            o=self._o,
            h=self._h,
            l=self._l,
            c=self._c,
            vol_buy=self._vol_buy,
            vol_sell=self._vol_sell,
            cvd_cum=self._cvd_cum,
            vwap_num_cum=self._vwap_num_cum,
            vwap_den_cum=self._vwap_den_cum,
        )

    def _reset_interval_bar(self) -> None:
        self._prev_close = self._c  # may be NaN before the first trade ever
        self._o = self._h = self._l = self._c = self._prev_close
        self._bar_has_trade = False
        self._vol_buy = 0.0
        self._vol_sell = 0.0
        # *_cum accumulators persist across intervals (session-cumulative).

    # -- partial (right-edge) emission -----------------------------------------

    def _make_depth(
        self,
        epoch: int,
        col_seq: int,
        t0_ns: int,
        bid: np.ndarray,
        ask: np.ndarray,
        final: bool,
    ) -> DepthColumn:
        """Single owner of the density->wire conversion: cast to float32 and
        drop the ask channel in SYNTH_PROFILE mode."""
        synth = self._cfg.mode == MODE_SYNTH_PROFILE
        return DepthColumn(
            epoch=epoch,
            col_seq=col_seq,
            t0_ns=t0_ns,
            mode=self._cfg.mode,
            final=final,
            bid=bid.astype(np.float32),
            ask=None if synth else ask.astype(np.float32),
        )

    def to_depth(self, col: FinalizedColumn) -> DepthColumn:
        """Convert a finalized (f16 ring) column to a wire DepthColumn
        (float32, ``final=True``, ask dropped in SYNTH_PROFILE mode)."""
        return self._make_depth(col.epoch, col.col_seq, col.t0_ns, col.bid, col.ask, final=True)

    def current_partial(self) -> DepthColumn | None:
        """Progressive right-edge emit: the in-progress column so far.

        The partial integral (accumulated through the latest ``on_book``
        timestamp) is divided by the full ``dt_ns``, so the value converges to
        the finalized column as the interval fills. Returns ``None`` before the
        grid has been anchored by any event; after a trade-only anchor the
        density is all zeros but the column (t0/col_seq) is already meaningful.
        """
        if self._cur_idx is None:
            return None
        density = self._acc / float(self._cfg.dt_ns)
        return self._make_depth(
            self._epoch,
            self._count,
            self._cur_idx * self._cfg.dt_ns,
            density[0],
            density[1],
            final=False,
        )

    def book_update(self, ts_ns: int) -> BookUpdate:
        """Current resting size for DOM; separate from integrated heatmap data."""
        return BookUpdate(epoch=self._epoch, col_seq=self._count, t0_ns=ts_ns,
                          mode=self._cfg.mode, final=False,
                          bid=self._state[0].astype(np.float32),
                          ask=None if self._cfg.mode == MODE_SYNTH_PROFILE else self._state[1].astype(np.float32))

    def bar_partial(self) -> BarColumn:
        """The current interval's bar state (not yet finalized)."""
        t0 = 0 if self._cur_idx is None else self._cur_idx * self._cfg.dt_ns
        return self._snap_bar(t0)

    # -- epochs / re-anchor ----------------------------------------------------

    def maybe_reanchor(self, mid: float) -> EpochParams | None:
        """Re-anchor the price frame around ``mid`` when it has drifted too far.

        Two regimes:

        - **Legacy (no band):** re-anchor if ``mid`` sits outside the central
          70 % of the fixed span, recentring ``p0``.
        - **Hybrid:** the FIRST call builds the broad frame and freezes the
          fine core's step and row count. Later calls roll the core when mid
          exits its central 70 %, preserving each historical epoch's map.
        - **Linear banded:** the FIRST call with a usable mid builds the percentage
          frame and FREEZES ``tick_multiple`` for the session; afterwards a
          re-anchor fires on a RATIO trip (``mid`` outside
          ``[anchor/BAND_TRIP_RATIO, anchor*BAND_TRIP_RATIO]``) and moves
          ``p0`` ONLY.

        Auto-tick grids (``cfg.auto_tick``, feeds serving sub-dollar
        instruments) get one extra step before the legacy rule: the FIRST call
        with a usable mid may replace a fallback tick too coarse for the
        instrument with a price-proportional one (``adaptive_tick_for``) and
        centre the frame in the same commit. That is safe exactly once — no
        column with nonzero density has been finalized (pre-book trade
        intervals may emit all-zero columns; they stay zero under the new
        affine), and a preloaded frame sets ``_tick_anchored`` in
        :meth:`preload`, so a rehydrated grid never adapts.

        Freezing the multiple keeps native resolution stable throughout the
        session. History in the ring is NEVER rewritten. Linear accumulators
        shift by whole rows; hybrid accumulators redistribute by physical-price
        overlap rather than treating a moving log wing as a row translation.
        A non-finite / non-positive ``mid`` is ignored rather than raised — this
        is called straight off feed data with no ``try`` around it.
        """
        cfg = self._cfg
        if not math.isfinite(mid) or mid <= 0:
            return None

        # Resolve the fallback BEFORE any band branch uses the step. Deep,
        # wide and full views used to bypass this and keep the sim's $0.50.
        tick_changed = False
        if cfg.auto_tick and not self._tick_anchored:
            self._tick_anchored = True
            new_tick = adaptive_tick_for(mid, self._tick)
            if new_tick != self._tick and not self._frozen_nonzero:
                self._tick = new_tick
                self._tick_multiple = 1
                self._step = new_tick
                self._acc[:] = 0
                tick_changed = True

        if self._banded and cfg.band_hybrid:
            assert cfg.band_up is not None and cfg.band_down is not None
            rolling = self._band_anchored and self._scale.kind == SCALE_HYBRID
            if rolling:
                span = self._scale.core_rows * self._scale.core_step
                if self._scale.core_p0 + 0.15 * span <= mid <= self._scale.core_p0 + 0.85 * span:
                    return None
                core_rows = self._scale.core_rows
                core_step = self._scale.core_step
            else:
                core_rows = cfg.core_rows if cfg.core_rows > 0 else cfg.rows // 2
                self._tick_multiple = max(self._tick_multiple, deep_core_multiple(mid, self._tick, core_rows))
                self._step = self._tick * self._tick_multiple
                # A native tick can cover more than the entire price of a cheap
                # coin. Choose the core row count once, then preserve it on rolls.
                core_rows = min(core_rows, max(2, int(mid * 0.2 / self._step)))
                core_step = self._step
            scale = make_hybrid(
                mid=mid,
                rows=cfg.rows,
                core_rows=core_rows,
                core_step=core_step,
                up_mult=1.0 + cfg.band_up,
                dn_floor=max(1e-6, 1.0 - cfg.band_down),
            )
            if scale is not None:
                self._band_anchored = True
                self._anchor_mid = mid
                self._step = scale.core_step
                return self._commit_anchor(scale.core_p0, rebuild_state=True, new_scale=scale)
            if rolling:
                # An extreme fall may no longer fit the frozen core above zero.
                # Preserve the last valid hybrid rather than changing resolution.
                return None
            # Near the minimum venue price a positive hybrid core may not fit;
            # still anchor a valid positive linear band below.

        if self._banded:
            assert cfg.band_up is not None and cfg.band_down is not None
            if not self._band_anchored:
                frame = band_frame(mid, cfg.band_up, cfg.band_down, self._tick, cfg.rows)
                if frame is None:
                    return None
                new_p0, tm = frame
                # First real anchor: adopt the multiple and freeze it.
                self._tick_multiple = tm
                self._step = self._tick * tm
                self._band_anchored = True
                self._anchor_mid = mid
                return self._commit_anchor(new_p0, rebuild_state=True)

            anchor = self._anchor_mid
            if anchor is None or anchor <= 0.0:
                self._anchor_mid = mid
                return None
            ratio = mid / anchor
            if 1.0 / BAND_TRIP_RATIO <= ratio <= BAND_TRIP_RATIO:
                return None
            # p0 ONLY — the multiple is frozen, so this is an exact row shift.
            span = cfg.rows * self._step
            new_p0 = max(0.0, round((mid - span / 2.0) / self._step) * self._step)
            self._anchor_mid = mid
            return self._commit_anchor(new_p0, rebuild_state=True)

        # --- legacy fixed-span rule --------------------------------------
        span = cfg.rows * self._step
        if tick_changed:
            new_p0 = max(0.0, round((mid - span / 2.0) / self._step) * self._step)
            self._anchor_mid = mid
            return self._commit_anchor(new_p0, rebuild_state=True)
        lo = self._p0 + 0.15 * span
        hi = self._p0 + 0.85 * span
        if lo <= mid <= hi:
            return None
        new_p0 = max(0.0, round((mid - span / 2.0) / self._step) * self._step)
        return self._commit_anchor(new_p0, rebuild_state=True)

    def _commit_anchor(
        self, new_p0: float, *, rebuild_state: bool, new_scale: PriceScale | None = None
    ) -> EpochParams:
        """Move the frame to ``new_p0``, bump the epoch, publish the params.

        Hybrid maps must be remapped by actual r±.5 price intervals. The
        linear path keeps its exact integer shift when the step is unchanged.
        """
        cfg = self._cfg
        target = new_scale or linear_scale(new_p0, self._step, cfg.rows)
        if self._scale.kind == SCALE_HYBRID or target.kind == SCALE_HYBRID:
            self._reproject_rows(self._acc, self._scale, target)
        elif self._scale.step != target.step:
            self._acc[:] = 0.0
        elif self._p0 != new_p0:
            delta = (new_p0 - self._p0) / self._step
            offset = round(delta)
            if abs(delta - offset) < 1e-9:
                self._shift_rows(self._acc, offset)
            else:
                self._acc[:] = 0.0
        self._p0 = new_p0
        self._scale = target
        self._epoch += 1
        if rebuild_state and self._last_book is not None:
            bid_px, bid_sz, ask_px, ask_sz = self._last_book
            self._state[0] = self._map_levels(bid_px, bid_sz)
            self._state[1] = self._map_levels(ask_px, ask_sz)
        params = EpochParams(
            epoch=self._epoch,
            tick=self._tick,
            tick_multiple=self._tick_multiple,
            dt_ns=cfg.dt_ns,
            p0=new_p0,
            rows=cfg.rows,
            **epoch_scale_fields(self._scale),
        )
        self._epoch_params[self._epoch] = params
        return params

    def _reproject_rows(self, a: np.ndarray, source: PriceScale, target: PriceScale) -> None:
        """Move bucket mass by physical overlap, preserving unresolved density.

        Nearest-row binning owns [r-.5,r+.5]. The union of source and target
        price edges splits their shared coverage into intervals owned by one
        source and one target row each. Local scatter avoids subtracting large
        cumulative totals, which could erase a small level beside a huge one.
        Only mass outside target coverage is discarded; finalized ring rows
        and the accumulated time/bar state are untouched.
        """
        if not np.any(a):
            return
        rows = self._cfg.rows
        source_edges = np.fromiter((row_to_price(source, r - 0.5) for r in range(rows + 1)),
                                   dtype=np.float64, count=rows + 1)
        target_edges = np.fromiter((row_to_price(target, r - 0.5) for r in range(rows + 1)),
                                   dtype=np.float64, count=rows + 1)
        lo = max(source_edges[0], target_edges[0])
        hi = min(source_edges[-1], target_edges[-1])
        if hi <= lo:
            a[:] = 0.0
            return
        edges = np.unique(np.concatenate(([lo, hi],
            source_edges[(source_edges > lo) & (source_edges < hi)],
            target_edges[(target_edges > lo) & (target_edges < hi)])))
        source_rows = np.searchsorted(source_edges, edges[:-1], side="right") - 1
        target_rows = np.searchsorted(target_edges, edges[:-1], side="right") - 1
        share = np.diff(edges) / np.diff(source_edges)[source_rows]
        for channel in range(a.shape[0]):
            a[channel] = np.bincount(target_rows, weights=a[channel, source_rows] * share,
                                     minlength=rows)

    def epoch_params_for(self, epoch: int) -> EpochParams:
        """Params of any epoch this grid has lived through.

        Raises ``KeyError`` for epochs the grid never entered.
        """
        return self._epoch_params[epoch]

    @property
    def scale(self) -> PriceScale:
        """The live row<->price map (linear unless a hybrid band anchored)."""
        return self._scale

    def current_epoch_params(self) -> EpochParams:
        """Params of the live (current) epoch."""
        return self._epoch_params[self._epoch]

    def _shift_rows(self, a: np.ndarray, offset: int) -> None:
        """In-place row shift along the last axis: ``new[r] = old[r + offset]``.

        Rows shifted out of range are dropped; vacated rows become zero.
        """
        if offset == 0:
            return
        rows = self._cfg.rows
        if abs(offset) >= rows:
            a[...] = 0.0
            return
        if offset > 0:
            a[..., : rows - offset] = a[..., offset:]
            a[..., rows - offset :] = 0.0
        else:
            k = -offset
            a[..., k:] = a[..., : rows - k]
            a[..., :k] = 0.0

    # -- history ---------------------------------------------------------------

    def oldest_retained_t0_ns(self) -> int | None:
        """``t0_ns`` of the oldest column still retained in the ring, or
        ``None`` when no column has been finalized yet. This is what
        ``HistoryResponse.oldest_available_t_ns`` reports for the RAM ring."""
        rc = self._cfg.ring_columns
        retained = min(self._count - self._oldest_seq, rc)
        if retained == 0:
            return None
        return int(self._ring_t0[(self._count - retained) % rc])

    def history(self, before_t_ns: int, n: int) -> list[FinalizedColumn]:
        """The most recent ``n`` retained columns with ``t0_ns < before_t_ns``.

        ``before_t_ns`` is EXCLUSIVE. Returns chronological (oldest first).
        Only columns still retained in the ring are served; arrays are copies.
        """
        rc = self._cfg.ring_columns
        retained = min(self._count - self._oldest_seq, rc)
        if retained == 0 or n <= 0:
            return []
        seqs = np.arange(self._count - retained, self._count, dtype=np.int64)
        idxs = seqs % rc
        keep = self._ring_t0[idxs] < before_t_ns
        chosen = idxs[keep][-n:]
        return [self._column_from_ring(int(i)) for i in chosen]

    def retained_sequence_range(self) -> tuple[int, int] | None:
        """Scalar cache bounds; overview requests need no full-ring copy."""
        retained = min(self._count - self._oldest_seq, self._cfg.ring_columns)
        return None if retained <= 0 else (self._count - retained, self._count - 1)

    def history_sequence_batch(self, start: int, end: int, limit: int = 64) -> list[FinalizedColumn]:
        """Copy a small explicit sequence interval on the feed's event loop.

        Executor readers never race the mutable ring. Session yields between
        these byte-bounded snapshots, aggregates them off-loop, and discards
        each source batch after its quantities have joined the output bins.
        """
        retained = self.retained_sequence_range()
        if retained is None or limit <= 0:
            return []
        low = max(start, retained[0])
        high = min(end, retained[1], low + min(limit, 64) - 1)
        return [self._column_from_ring(seq % self._cfg.ring_columns)
                for seq in range(low, high + 1)]
