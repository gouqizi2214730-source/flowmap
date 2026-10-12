"""Parquet self-recording, size-capped retention, and tail-load.

Design spec §7 (replay column: every live session self-records) and §8.1
(restart: rehydrate the ring tail from the newest recording if fresh, else
cold start + gap marker — the *wiring* into Session is a later task; this
module only provides the storage primitives).

Layout::

    base_dir/{market}/{symbol}/{YYYYMMDD-HH}-{kind}-{part:06d}.parquet

with ``kind`` in {columns, trades, markers, epochs}. Load-bearing decisions:

- **No wall-clock reads anywhere.** Hour buckets derive from event
  timestamps (``t0_ns`` / ``ts_ns``, interpreted as UTC ns since epoch), and
  retention orders files by *filename*, never mtime: the ``YYYYMMDD-HH``
  prefix plus the zero-padded part counter make lexicographic order equal
  chronological order. Everything is deterministic under synthetic clocks.
- **Parquet cannot append.** :class:`SessionRecorder` buffers rows in memory
  and every ``flush()`` writes fresh *part files* with a monotonically
  increasing 6-digit suffix. The counter is shared across kinds/hours within
  a session and seeded past any parts (and live claims) already on disk, so a
  restarted session never collides with (or sorts before) its predecessor's
  files. CONCURRENT writers on the same (market, symbol) each claim their
  part numbers atomically at write time (an exclusive ``.claim-{n:06d}``
  marker; see :meth:`SessionRecorder._claim_part`) — two live sessions used
  to run independent counters from the same on-disk scan and silently rename
  over each other's parts.
- **Flush is exception-safe.** Each part is written to a ``*.tmp`` name and
  atomically renamed into place (``os.replace``, same filesystem), and a
  group's rows leave the buffer the moment its file lands — so a failure on
  a later group raises WITHOUT resurrecting already-written groups on retry
  (no duplicate col_seqs on disk). As defense in depth the load path also
  dedups columns by ``col_seq`` (newest file wins). A crash mid-write leaves
  at most a ``*.tmp`` orphan, which no glob ever matches.
- **f16 fidelity.** Ring densities are float16; Parquet has no f16, so
  arrays are stored as ``list[f32]``. f16→f32 widening is exact, and every
  stored value *is* an exact f16 (it was cast from one in the grid), so the
  f32→f16 cast on load is bit-lossless (pinned by test 1).
- **Bar identity.** ``BarColumn.epoch/col_seq/t0_ns`` always equal the
  enclosing :class:`FinalizedColumn`'s (grid invariant: ``_snap_bar`` runs at
  finalize time), so only the payload bar fields are stored flat and the
  identity fields are rebuilt from the column row on load.
- **Epoch rows have no timestamp**, so at flush time they are bucketed into
  the hour of the newest event timestamp seen so far (falling back to hour 0
  before any timestamped event). Correctness never depends on the bucket —
  ``load_tail`` reads *all* epochs files — the choice only keeps the epochs
  file near the newest data in retention order.
- **Retention tradeoff** (kept deliberately simple): ``enforce_retention``
  deletes the lexicographically oldest ``*.parquet`` files *globally* —
  across symbols and kinds — until the total size is within the cap, with
  two exemptions: ``*-epochs-*`` files are never deleted (they cost bytes
  against a GB-scale cap, and orphaning them would make every surviving
  column unplaceable), and the newest columns part of each symbol always
  survives (so a symbol's tail is never wiped outright). Consequence: the
  total can stay above the cap when only exempt files remain. Retention may
  still delete trades/markers out from under surviving columns; ``load_tail``
  simply returns fewer events. If columns DO end up orphaned from their
  epochs (manual deletion, corruption), ``load_tail`` degrades to ``None``
  (cold start + gap marker per §8.1) rather than serving columns it cannot
  place on a price grid.
- **Corrupt-file tolerance.** ``load_tail`` skips unreadable/truncated
  Parquet files (crash mid-write on the §8.1 restart path) with a warning
  instead of raising; if that leaves no usable fresh columns it returns
  ``None``.
- **Ranged reads.** ``load_tail`` prunes candidate files by their filename
  hour prefix before opening them: columns files entirely before the age
  cutoff, and trades/markers files outside the loaded ``[t_lo, t_hi)``
  window, are never read.
"""

from __future__ import annotations

import itertools
import json
import logging
import os
import re
import threading
import uuid
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path

import msgspec
import numpy as np
import polars as pl

from flowmap_server.core.grid import FinalizedColumn
from flowmap_server.proto.events import BarColumn, EpochParams, Marker, Trade

__all__ = ["Recorder", "SessionRecorder", "TailData"]

logger = logging.getLogger(__name__)

_GB = 1_000_000_000
_HOUR_KEY_LEN = 11  # "YYYYMMDD-HH" — fixed width, so string compare == time compare
# Sentinel "hour key" above every real bucket — the no-upper-bound case of the
# ranged file prune in ``load_tail``.
_HOUR_KEY_MAX = "99991231-99"

# Caps on trades/markers materialized by ONE tail load. The window is bounded
# in columns, but a busy symbol can still carry hundreds of thousands of tape
# rows across it; the old path built every in-window row as a Python object.
# Past a cap the OLDEST rows are dropped (every caller serves a NEWEST-window
# read) and ``TailData.trades_truncated``/``markers_truncated`` say so.
_TRADES_MAX_PER_LOAD = 250_000
_MARKERS_MAX_PER_LOAD = 25_000
_COLUMN_TIME_CACHE_PARTS = 4096

_COLUMNS_SCHEMA = {
    "recording_id": pl.String,
    "epoch": pl.UInt32,
    "col_seq": pl.UInt32,
    "t0_ns": pl.Int64,
    "bid": pl.List(pl.Float32),
    "ask": pl.List(pl.Float32),
    "o": pl.Float64,
    "h": pl.Float64,
    "l": pl.Float64,
    "c": pl.Float64,
    "vol_buy": pl.Float64,
    "vol_sell": pl.Float64,
    "cvd_cum": pl.Float64,
    "vwap_num_cum": pl.Float64,
    "vwap_den_cum": pl.Float64,
}
_TRADES_SCHEMA = {
    "recording_id": pl.String,
    "ts_ns": pl.Int64,
    "price": pl.Float64,
    "size": pl.Float64,
    "side": pl.UInt8,
    "side_src": pl.UInt8,
    "venue": pl.String,
}
_MARKERS_SCHEMA = {
    "recording_id": pl.String,
    "ts_ns": pl.Int64,
    "kind": pl.String,
    "text": pl.String,
    "price": pl.Float64,
    "size": pl.Float64,
}
_EPOCHS_SCHEMA = {
    "recording_id": pl.String,
    "epoch": pl.UInt32,
    "tick": pl.Float64,
    "tick_multiple": pl.Int64,
    "dt_ns": pl.Int64,
    "p0": pl.Float64,
    "rows": pl.Int64,
    # Trailing hybrid-scale fields (H1) mirror EpochParams in proto/events.py:
    # without them a recorded hybrid epoch round-trips as linear and a restart
    # re-bins every live book with the wrong row<->price map. Old recordings
    # written before these columns existed simply lack them — load_tail reads
    # them with defaults, which IS the linear state they were recorded under.
    "scale_kind": pl.Int64,
    "dn_rows": pl.Int64,
    "core_rows": pl.Int64,
    "core_p0": pl.Float64,
    "core_step": pl.Float64,
    "lo_price": pl.Float64,
    "hi_price": pl.Float64,
}


def _hour_key(ts_ns: int) -> str:
    """UTC ``YYYYMMDD-HH`` bucket for an epoch-ns timestamp."""
    return datetime.fromtimestamp(ts_ns // 1_000_000_000, tz=timezone.utc).strftime("%Y%m%d-%H")


# Hour buckets this recorder writes; anything else in a ``*-columns-`` name is
# a stray file the inventory must skip, not crash on (``strptime`` would raise).
_HOUR_KEY_RE = re.compile(r"\d{8}-\d{2}")


def _safe_component(name: str) -> str:
    """Filesystem-safe path component for market/symbol.

    Refuses — with ``ValueError``, like every other invalid input — the
    traversal names ``"."`` and ``".."``. Path separators (``/``, ``\\``,
    ``:``) are rewritten to ``_`` rather than refused: ccxt spellings like
    ``"ETH/BTC"`` and ``"BTC/USDC:USDC"`` are a documented, legitimate input
    class and must keep recording (refusing them would silently disable
    recording for the whole session). A separator-bearing name cannot become
    a traversal once its separators are gone."""
    if name in (".", ".."):
        raise ValueError(f"invalid recording path component: {name!r}")
    for ch in "/\\:":
        name = name.replace(ch, "_")
    return name or "_"


def _hour_start_ns(key: str) -> int:
    """UTC ns for the START of a ``YYYYMMDD-HH`` hour bucket (the inverse of
    :func:`_hour_key` at hour resolution)."""
    dt = datetime.strptime(key, "%Y%m%d-%H").replace(tzinfo=timezone.utc)
    return int(dt.timestamp()) * 1_000_000_000


def _by_name(p: Path) -> tuple[str, str]:
    return (p.name, str(p))


def _hour_prefix(p: Path) -> str:
    """The ``YYYYMMDD-HH`` filename prefix (we wrote the name; fixed width)."""
    return p.name[:_HOUR_KEY_LEN]


def _part_number(p: Path) -> int:
    return int(p.stem.rsplit("-", 1)[-1])


def _epoch_from_row(row: dict) -> EpochParams:
    return EpochParams(
        epoch=int(row["epoch"]),
        tick=row["tick"],
        tick_multiple=int(row["tick_multiple"]),
        dt_ns=int(row["dt_ns"]),
        p0=row["p0"],
        rows=int(row["rows"]),
        scale_kind=int(row.get("scale_kind", 0) or 0),
        dn_rows=int(row.get("dn_rows", 0) or 0),
        core_rows=int(row.get("core_rows", 0) or 0),
        core_p0=float(row.get("core_p0", 0.0) or 0.0),
        core_step=float(row.get("core_step", 0.0) or 0.0),
        lo_price=float(row.get("lo_price", 0.0) or 0.0),
        hi_price=float(row.get("hi_price", 0.0) or 0.0),
    )


def _bounded_rows(
    d: Path,
    pattern: str,
    lo_key: str,
    hi_key: str,
    in_range: pl.Expr,
    limit: int,
    recording_id: str | None = None,
) -> tuple[Iterator[dict[str, object]], bool]:
    """Stream rows matching ``in_range``, capped at the NEWEST ``limit``.

    The old comprehension built every in-window row as a Python object; a
    busy symbol across a full ring window can carry hundreds of thousands of
    trades. Past the cap the OLDEST rows are dropped (every caller is serving
    a NEWEST-window read) and the second tuple element is True so the caller
    can surface the truncation honestly. Below the cap rows stream lazily and
    order is unchanged (callers sort)."""
    frames: list[pl.DataFrame] = []
    total = 0
    for path in sorted(d.glob(pattern), key=_by_name):
        if not (lo_key <= _hour_prefix(path) <= hi_key):
            continue
        df = _read_parquet_safe(path)
        if df is None:
            continue
        if recording_id is not None:
            if "recording_id" not in df.columns and recording_id:
                continue
            if "recording_id" in df.columns:
                df = df.filter(pl.col("recording_id").fill_null("") == recording_id)
        fresh = df.filter(in_range)
        if fresh.height:
            frames.append(fresh)
            total += fresh.height
    if not frames:
        return iter(()), False
    if total > limit:
        logger.warning(
            "recording %s for %s: capping at %d rows (dropping the oldest %d)",
            pattern,
            d.name,
            limit,
            total - limit,
        )
        merged = pl.concat(frames).sort("ts_ns").tail(limit)
        return iter(merged.iter_rows(named=True)), True
    return (
        iter(itertools.chain.from_iterable(f.iter_rows(named=True) for f in frames)),
        False,
    )


def _read_parquet_safe(path: Path, *, columns: list[str] | None = None) -> pl.DataFrame | None:
    """Read a recording part file, tolerating corruption.

    A truncated/garbage file (crash mid-write predates the temp+rename flush,
    or disk damage) must not crash the §8.1 restart path: log a warning and
    skip it. Returns ``None`` when the file is unreadable.
    """
    try:
        return pl.read_parquet(path, columns=columns)
    except (pl.exceptions.PolarsError, OSError) as exc:
        logger.warning("skipping unreadable recording file %s: %s", path, exc)
        return None


class TailData(msgspec.Struct):
    """Result of :meth:`Recorder.load_tail` — everything Session rehydration
    needs, chronological (oldest first). ``epochs`` contains exactly the
    epochs referenced by ``columns``, sorted by epoch number.

    ``truncated`` — the column cap (``limit_cols``) bit: older recorded
    columns exist that this read did not serve. ``trades_truncated`` /
    ``markers_truncated`` — the newest-N tape caps bit (oldest rows dropped).
    Callers that serve the tail to a user must surface these (log/flag), never
    present a capped read as the whole history."""

    epochs: list[EpochParams]
    columns: list[FinalizedColumn]
    trades: list[Trade]
    markers: list[Marker]
    newest_t0_ns: int
    truncated: bool = False
    trades_truncated: bool = False
    markers_truncated: bool = False
    recording_id: str | None = None


class SessionRecorder:
    """Append-only buffered Parquet writer for ONE (market, symbol).

    ``record_*`` buffer in memory; ``flush()`` writes one part file per
    (hour, kind) that has buffered rows and clears the buffers; ``close()``
    flushes and rejects further writes. Created via
    :meth:`Recorder.open_session` — not directly.
    """

    def __init__(self, sym_dir: Path | None, *, enabled: bool) -> None:
        self._enabled = enabled and sym_dir is not None
        # Epoch numbers and column sequences belong to a grid run, not the
        # symbol directory. Cold starts reuse them; scope every kind to this
        # writer so another run can never donate its price geometry or tape.
        self.recording_id = uuid.uuid4().hex
        self._dir = sym_dir
        self._closed = False
        self._columns: list[FinalizedColumn] = []
        self._trades: list[Trade] = []
        self._markers: list[Marker] = []
        self._epochs: list[EpochParams] = []
        self._max_ts_ns = 0  # newest event timestamp seen (buckets epoch rows)
        # Serializes part-number allocation between THIS recorder's threads
        # (the session flushes from an executor thread; close() may run on the
        # loop while that write is still in flight). Cross-WRITER exclusion is
        # the exclusive .claim marker, not this lock.
        self._part_lock = threading.Lock()
        self._part = self._scan_next_part() if self._enabled else 0

    def _scan_next_part(self) -> int:
        """Seed the part counter past anything already on disk — landed parts
        AND live ``.claim-*`` markers from concurrent/crashed writers — so a
        restart never collides and lexicographic file order stays
        chronological. The first actual claim re-validates exclusively (see
        :meth:`_claim_part`): a stale scan can never double-allocate."""
        assert self._dir is not None
        newest = -1
        for p in self._dir.glob("*.parquet"):
            tail = p.stem.rsplit("-", 1)[-1]
            if tail.isdigit():
                newest = max(newest, int(tail))
        for p in self._dir.glob(".claim-*"):
            tail = p.name[len(".claim-") :]
            if tail.isdigit():
                newest = max(newest, int(tail))
        return newest + 1

    def _claim_part(self, kind: str, hour: str) -> tuple[int, Path, Path, Path]:
        """Atomically claim this writer's next unused part number.

        Returns ``(n, path, tmp, marker)``. Two live recorders on the same
        (market, symbol) each scan the same directory at open and would
        otherwise count from the same number — their ``os.replace`` final
        writes silently clobber each other and a whole recording is lost.
        The claim is an exclusive ``O_CREAT|O_EXCL`` marker file, so exactly
        one writer can hold a number no matter how the open-time scans raced.
        The caller releases the marker once the part lands (the parquet then
        guards its own number) or on failure (nothing landed: the number
        returns to the pool). A crash between claim and rename leaves the
        tiny marker behind; scanners count it, so the number is never
        reused.
        """
        assert self._dir is not None
        while True:
            with self._part_lock:
                n = self._part
                path = self._dir / f"{hour}-{kind}-{n:06d}.parquet"
                marker = self._dir / f".claim-{n:06d}"
                if path.exists():
                    self._part = n + 1  # landed elsewhere: number spent
                    continue
                try:
                    fd = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                except FileExistsError:
                    self._part = n + 1  # another writer holds the number
                    continue
                os.close(fd)
                if path.exists():
                    # A raced writer landed this exact part between our two
                    # checks (its claim release can interleave with our
                    # marker create): give the number back untouched.
                    marker.unlink(missing_ok=True)
                    self._part = n + 1
                    continue
                tmp = path.with_name(path.name + ".tmp")  # no glob matches *.tmp
                self._part = n + 1
            return n, path, tmp, marker

    def _check_open(self) -> None:
        if self._closed:
            raise RuntimeError("SessionRecorder is closed")

    # -- record ----------------------------------------------------------------

    def record_epoch(self, params: EpochParams) -> None:
        self._check_open()
        if not self._enabled:
            return
        self._epochs.append(params)

    def record_column(self, col: FinalizedColumn) -> None:
        self._check_open()
        if not self._enabled:
            return
        self._columns.append(col)
        self._max_ts_ns = max(self._max_ts_ns, col.t0_ns)

    def record_trade(self, t: Trade) -> None:
        self._check_open()
        if not self._enabled:
            return
        self._trades.append(t)
        self._max_ts_ns = max(self._max_ts_ns, t.ts_ns)

    def record_marker(self, m: Marker) -> None:
        self._check_open()
        if not self._enabled:
            return
        self._markers.append(m)
        self._max_ts_ns = max(self._max_ts_ns, m.ts_ns)

    # -- flush / close ---------------------------------------------------------

    def flush(self) -> None:
        """Write all buffered rows to new Parquet part files. One file per
        (hour, kind) that has rows; nothing is written for empty buffers.

        Exception-safe, and RAISES on IO failure: each part is written to a
        ``*.tmp`` name and atomically renamed into place (``os.replace``,
        same filesystem — readers never observe a truncated ``*.parquet``),
        and a group's rows are dropped from the buffer the moment its file
        lands. A failure on a later group therefore propagates with only the
        UNWRITTEN groups still buffered — retrying flush() can never write a
        duplicate col_seq. Callers that must survive IO failure (the T11
        session feed loop) must wrap flush(): log + disable recording for
        the session; never kill the live session over a recording error.
        """
        if not self._enabled:
            return
        self._flush_kind("columns", self._columns, lambda c: c.t0_ns, self._columns_frame)
        self._flush_kind("trades", self._trades, lambda t: t.ts_ns, self._trades_frame)
        self._flush_kind("markers", self._markers, lambda m: m.ts_ns, self._markers_frame)
        # Epochs carry no timestamp: bucket into the newest hour seen so far
        # (hour 0 if nothing timestamped was ever recorded). load_tail reads
        # every epochs file, so the bucket never affects correctness.
        self._flush_kind("epochs", self._epochs, lambda _e: self._max_ts_ns, self._epochs_frame)

    def _flush_kind(self, kind, rows, ts_of, to_frame) -> None:
        if not rows:
            return
        assert self._dir is not None
        groups: dict[str, list] = {}
        for r in rows:
            groups.setdefault(_hour_key(ts_of(r)), []).append(r)
        try:
            for hour in sorted(groups):
                _n, path, tmp, marker = self._claim_part(kind, hour)
                try:
                    to_frame(groups[hour]).write_parquet(tmp)
                    tmp.replace(path)  # atomic os.replace on the same fs
                except BaseException:
                    tmp.unlink(missing_ok=True)
                    marker.unlink(missing_ok=True)  # nothing landed: number reusable
                    raise
                marker.unlink(missing_ok=True)  # landed: the part guards its number
                groups[hour] = []  # landed: never re-written on a retry
        finally:
            # Keep only the rows of groups that did NOT land.
            rows[:] = [r for group in groups.values() for r in group]

    def take_buffers(self) -> tuple[list, list, list, list] | None:
        """Detach the buffered rows for one off-loop flush.

        Called on the owner's thread (the asyncio loop): swapping the buffer
        lists out here means a flush running in an executor thread touches
        ONLY the snapshot — rows recorded while it writes stay in the live
        buffers and land in the next flush, with no shared mutable state.
        Returns ``None`` when every buffer is empty (callers skip the thread
        hop instead of writing nothing)."""
        if not (self._columns or self._trades or self._markers or self._epochs):
            return None
        bufs = (self._columns, self._trades, self._markers, self._epochs)
        self._columns, self._trades, self._markers, self._epochs = [], [], [], []
        return bufs

    def restore_buffers(self, bufs: tuple[list, list, list, list]) -> None:
        """Re-attach a FAILED flush's unwritten rows to the live buffers.

        ``flush_buffers`` leaves whatever did not land on disk in the snapshot
        lists. The owning session now RETRIES transient flush failures after
        a cooldown (session docstring) instead of disabling recording, so
        those rows must return to the FRONT of the live buffers — they are
        the OLDEST rows of the failed snapshot, and prepending keeps buffer
        order chronological. Without the restore, a retry would silently skip
        everything the failed flush was holding."""
        columns, trades, markers, epochs = bufs
        if columns:
            self._columns[:0] = columns
        if trades:
            self._trades[:0] = trades
        if markers:
            self._markers[:0] = markers
        if epochs:
            self._epochs[:0] = epochs

    def flush_buffers(self, bufs: tuple[list, list, list, list]) -> None:
        """Write a :meth:`take_buffers` snapshot to part files.

        Same per-(hour, kind) grouping, temp+rename atomicity, part-number
        progression, and exception-safety as :meth:`flush` — safe to run off
        the event loop because it touches only the snapshot lists plus the
        locked part counter. On failure the UNWRITTEN rows stay in the
        snapshot lists; the owning session restores them to the live buffers
        (:meth:`restore_buffers`) and retries after a cooldown — a transient
        IO failure delays a part, it does not end the recording."""
        columns, trades, markers, epochs = bufs
        self._flush_kind("columns", columns, lambda c: c.t0_ns, self._columns_frame)
        self._flush_kind("trades", trades, lambda t: t.ts_ns, self._trades_frame)
        self._flush_kind("markers", markers, lambda m: m.ts_ns, self._markers_frame)
        # Epochs carry no timestamp: bucket into the newest hour seen so far
        # (hour 0 if nothing timestamped was ever recorded). load_tail reads
        # every epochs file, so the bucket never affects correctness.
        self._flush_kind("epochs", epochs, lambda _e: self._max_ts_ns, self._epochs_frame)

    def _columns_frame(self, cols: list[FinalizedColumn]) -> pl.DataFrame:
        return pl.DataFrame(
            {
                "recording_id": [self.recording_id] * len(cols),
                "epoch": [c.epoch for c in cols],
                "col_seq": [c.col_seq for c in cols],
                "t0_ns": [c.t0_ns for c in cols],
                # f16 -> f32 is exact; stored as list[f32] (Parquet has no f16).
                "bid": [np.asarray(c.bid, dtype=np.float32) for c in cols],
                "ask": [np.asarray(c.ask, dtype=np.float32) for c in cols],
                "o": [c.bar.o for c in cols],
                "h": [c.bar.h for c in cols],
                "l": [c.bar.l for c in cols],
                "c": [c.bar.c for c in cols],
                "vol_buy": [c.bar.vol_buy for c in cols],
                "vol_sell": [c.bar.vol_sell for c in cols],
                "cvd_cum": [c.bar.cvd_cum for c in cols],
                "vwap_num_cum": [c.bar.vwap_num_cum for c in cols],
                "vwap_den_cum": [c.bar.vwap_den_cum for c in cols],
            },
            schema=_COLUMNS_SCHEMA,
        )

    def _trades_frame(self, trades: list[Trade]) -> pl.DataFrame:
        return pl.DataFrame(
            {
                "recording_id": [self.recording_id] * len(trades),
                "ts_ns": [t.ts_ns for t in trades],
                "price": [t.price for t in trades],
                "size": [t.size for t in trades],
                "side": [t.side for t in trades],
                "side_src": [t.side_src for t in trades],
                "venue": [t.venue for t in trades],
            },
            schema=_TRADES_SCHEMA,
        )

    def _markers_frame(self, markers: list[Marker]) -> pl.DataFrame:
        return pl.DataFrame(
            {
                "recording_id": [self.recording_id] * len(markers),
                "ts_ns": [m.ts_ns for m in markers],
                "kind": [m.kind for m in markers],
                "text": [m.text for m in markers],
                "price": [m.price for m in markers],
                "size": [m.size for m in markers],
            },
            schema=_MARKERS_SCHEMA,
        )

    def _epochs_frame(self, epochs: list[EpochParams]) -> pl.DataFrame:
        return pl.DataFrame(
            {
                "recording_id": [self.recording_id] * len(epochs),
                "epoch": [e.epoch for e in epochs],
                "tick": [e.tick for e in epochs],
                "tick_multiple": [e.tick_multiple for e in epochs],
                "dt_ns": [e.dt_ns for e in epochs],
                "p0": [e.p0 for e in epochs],
                "rows": [e.rows for e in epochs],
                "scale_kind": [e.scale_kind for e in epochs],
                "dn_rows": [e.dn_rows for e in epochs],
                "core_rows": [e.core_rows for e in epochs],
                "core_p0": [e.core_p0 for e in epochs],
                "core_step": [e.core_step for e in epochs],
                "lo_price": [e.lo_price for e in epochs],
                "hi_price": [e.hi_price for e in epochs],
            },
            schema=_EPOCHS_SCHEMA,
        )

    def close(self) -> None:
        """Flush any buffered rows and reject further writes."""
        if self._closed:
            return
        self.flush()
        self._closed = True


class Recorder:
    """Recording root: opens per-symbol writers, loads tails, prunes."""

    def __init__(self, base_dir: Path, gb_cap: float, *, enabled: bool = True) -> None:
        self._base = Path(base_dir)
        self._cap_bytes = int(gb_cap * _GB)
        self._enabled = enabled
        # Retention walks now run in executor threads (one per flushing
        # session): the lock keeps two walks from racing each other's
        # rglob/unlink pass. Works from both loop and worker threads.
        self._retention_lock = threading.Lock()
        # Part files are immutable after their atomic rename. A timestamp-only
        # index lets ranged pages skip newer files within the same hour without
        # reading density arrays or using up the bounded disk-page allowance.
        # Size/mtime also invalidate replaced legacy/test files safely.
        self._column_time_cache: dict[Path, tuple[int, int, tuple[int, int] | None]] = {}
        self._column_time_lock = threading.Lock()
        self.retention_status = {
            "coverage_loss": False,
            "deleted_parts": 0,
            "deleted_columns_parts": 0,
            "deleted_bytes": 0,
            "generation": 0,
            "recent_deleted": [],
        }
        try:
            previous = json.loads((self._base / ".flowmap-retention.json").read_bytes())
            if isinstance(previous, dict):
                self.retention_status.update(previous)
        except (OSError, ValueError):
            pass

    def open_session(self, market: str, symbol: str) -> SessionRecorder:
        """Create the append-only writer for one (market, symbol). When
        recording is disabled the writer no-ops and touches no filesystem."""
        if not self._enabled:
            return SessionRecorder(None, enabled=False)
        d = self._symbol_dir(market, symbol)
        d.mkdir(parents=True, exist_ok=True)
        return SessionRecorder(d, enabled=True)

    def _symbol_dir(self, market: str, symbol: str) -> Path:
        return self._base / _safe_component(market) / _safe_component(symbol)

    # -- tail load -------------------------------------------------------------

    def _column_time_bounds(self, path: Path) -> tuple[int, int] | None:
        try:
            stat = path.stat()
        except OSError:
            return None
        stamp = (stat.st_size, stat.st_mtime_ns)
        with self._column_time_lock:
            cached = self._column_time_cache.get(path)
            if cached is not None and cached[:2] == stamp:
                return cached[2]
        frame = _read_parquet_safe(path, columns=["t0_ns"])
        bounds = None
        if frame is not None and frame.height:
            minimum, maximum = frame["t0_ns"].min(), frame["t0_ns"].max()
            if minimum is not None and maximum is not None:
                bounds = (int(minimum), int(maximum))
        with self._column_time_lock:
            if (
                path not in self._column_time_cache
                and len(self._column_time_cache) >= _COLUMN_TIME_CACHE_PARTS
            ):
                self._column_time_cache.pop(next(iter(self._column_time_cache)))
            self._column_time_cache[path] = (*stamp, bounds)
        return bounds

    def load_tail(
        self,
        market: str,
        symbol: str,
        *,
        max_age_ns: int,
        now_ns: int,
        limit_cols: int,
        end_ns: int | None = None,
        recording_id: str | None = None,
        max_column_parts: int | None = None,
        include_events: bool = True,
    ) -> TailData | None:
        """The newest recorded columns for (market, symbol) that satisfy
        ``t0_ns >= now_ns - max_age_ns`` (and, when *end_ns* is given,
        ``t0_ns < end_ns`` — the inclusive-exclusive upper bound a WINDOWED
        replay needs; default ``None`` keeps the open-ended behavior), capped
        at ``limit_cols``, plus every epoch they reference and the
        trades/markers inside their time range (themselves capped at the
        newest ``_TRADES_MAX_PER_LOAD`` / ``_MARKERS_MAX_PER_LOAD``).

        ``TailData.truncated`` is True when older recorded columns exist that
        this capped read did not serve; the tape flags mark the row caps.
        ``max_column_parts`` bounds density-file reads. Timestamp-only probes
        skip files outside a ranged window before spending that allowance.

        Returns ``None`` when recording is disabled, nothing fresh exists, or
        the epochs referenced by the surviving columns were pruned (the
        recording is then unusable for rehydration — spec §8.1 says cold
        start + gap marker, which is the caller's job).
        """
        if not self._enabled or limit_cols <= 0:
            return None
        d = self._symbol_dir(market, symbol)
        if not d.is_dir():
            return None
        cutoff = now_ns - max_age_ns
        upper = None if end_ns is None else max(0, end_ns)

        # Ranged read: a columns file whose hour prefix ends before the
        # cutoff hour cannot contain fresh rows — never open it. Symmetric on
        # the upper side: a file whose hour bucket starts at/after the end
        # bucket cannot contain ``t0 < end_ns`` rows.
        cut_key = _hour_key(max(cutoff, 0))
        hi_key = _HOUR_KEY_MAX if upper is None else _hour_key(max(upper - 1, 0))
        candidates = [
            p for p in d.glob("*-columns-*.parquet") if cut_key <= _hour_prefix(p) <= hi_key
        ]
        # Newest -> oldest over part files (filename order == chronological);
        # stop as soon as we have limit_cols or hit an entirely-stale file.
        # A file entirely ABOVE the window (possible with *end_ns*) yields no
        # fresh rows but must NOT stop the scan — older files can still hold
        # in-window rows.
        fresh_expr = (
            (pl.col("t0_ns") >= cutoff)
            if upper is None
            else (pl.col("t0_ns") >= cutoff) & (pl.col("t0_ns") < upper)
        )
        frames: list[pl.DataFrame] = []
        have = 0
        paths = sorted(candidates, key=_by_name, reverse=True)
        scan_capped = False
        density_reads = 0
        for i, path in enumerate(paths):
            if max_column_parts is not None and upper is not None:
                bounds = self._column_time_bounds(path)
                if bounds is None or bounds[0] >= upper or bounds[1] < cutoff:
                    continue
            if max_column_parts is not None and density_reads >= max(0, max_column_parts):
                scan_capped = True
                break
            density_reads += 1
            df = _read_parquet_safe(path)
            if df is None or df.height == 0:
                continue  # unreadable (warned) or empty: try the next-older part
            if recording_id is not None:
                if "recording_id" not in df.columns:
                    if recording_id:
                        continue
                else:
                    df = df.filter(pl.col("recording_id").fill_null("") == recording_id)
                    if df.height == 0:
                        continue
            fresh = df.filter(fresh_expr)
            if fresh.height:
                # Internal source metadata is scalar; it never duplicates the
                # large density arrays. Old files remain readable explicitly
                # as legacy, without modifying any recording on disk.
                if "recording_id" not in fresh.columns:
                    fresh = fresh.with_columns(pl.lit("").alias("recording_id"))
                frames.append(fresh.with_columns(pl.lit(_part_number(path)).alias("_part")))
                have += fresh.height
                if have >= limit_cols:
                    # Older candidate parts (if any) were never opened — the
                    # read hit its cap and cannot know whether they hold more
                    # in-window rows. Only stopping at the last candidate
                    # proves completeness; anything earlier is reported as
                    # truncated (honest uncertainty: the flag drives a log).
                    scan_capped = i < len(paths) - 1
                    break
            elif int(df["t0_ns"].max()) < cutoff:
                break  # older files are older still
        if not frames:
            return None  # nothing fresh (or every candidate unreadable)
        table = pl.concat(frames, how="diagonal_relaxed").sort(["t0_ns", "_part"])
        # TailData has one params table and u32 sequences. It cannot represent
        # multiple independent cold-start runs with duplicate epoch/seq IDs.
        # Select the latest run in this time window, rather than merging old
        # high sequences with a newer run that started again at zero.
        recording_id = table["recording_id"][-1] or ""
        run = table.filter(pl.col("recording_id") == recording_id)
        truncated = scan_capped or run.height < table.height
        table = run.unique(subset=["col_seq", "t0_ns"], keep="last", maintain_order=True)
        seqs = table["col_seq"].to_numpy().astype(np.int64)
        resets = np.flatnonzero(np.diff(seqs) <= 0)
        if len(resets):
            table = table.slice(int(resets[-1]) + 1)
            truncated = True
        truncated = truncated or table.height > limit_cols
        table = table.tail(limit_cols)

        # Resolve epochs BEFORE materializing columns: the row count comes from
        # the epochs (and the vectorized bid/ask reshape below needs it).
        needed_epochs = set(table["epoch"].to_numpy().tolist())
        epoch_map: dict[int, EpochParams] = {}
        legacy_epochs: list[tuple[int, str, EpochParams]] = []
        for path in sorted(d.glob("*-epochs-*.parquet"), key=_by_name):
            df = _read_parquet_safe(path)
            if df is None:
                continue
            for row in df.iter_rows(named=True):
                row_id = row.get("recording_id", "") or ""
                if row_id != recording_id:
                    continue
                params = _epoch_from_row(row)
                if not recording_id:
                    legacy_epochs.append((_part_number(path), _hour_prefix(path), params))
                elif params.epoch in epoch_map and epoch_map[params.epoch] != params:
                    logger.warning(
                        "conflicting epoch geometry in recording %s; cold start", recording_id
                    )
                    return None
                else:
                    epoch_map[params.epoch] = params
        if not recording_id:
            # Old files lack run identity. Infer only from the append-only part
            # order. An initial flush writes columns BEFORE its epoch metadata,
            # so that following metadata belongs to the column only if no
            # intervening columns part starts another flush/run. A ranged read
            # must never choose an arbitrary future same-numbered epoch.
            column_paths = {_part_number(p): p for p in d.glob("*-columns-*.parquet")}
            column_parts = sorted(column_paths)
            for part in table["_part"].unique().to_list():
                rows = table.filter(pl.col("_part") == part)
                next_part = next((p for p in column_parts if p > part), 2**63)
                hour = _hour_key(int(rows["t0_ns"].max()))
                for epoch in rows["epoch"].unique().to_list():
                    following = [
                        entry
                        for entry in legacy_epochs
                        if part < entry[0] < next_part
                        and entry[1] <= hour
                        and entry[2].epoch == epoch
                    ]
                    preceding = [
                        entry
                        for entry in legacy_epochs
                        if entry[0] < part and entry[1] <= hour and entry[2].epoch == epoch
                    ]
                    choices = following or preceding
                    if not following and (not choices or int(rows["col_seq"].min()) == 0):
                        # A single flush may have columns in several hour files
                        # before its one epochs file. Verify only scalar identity
                        # across those parts; never infer geometry through a
                        # sequence reset, time seam, or another epoch.
                        future = [
                            entry
                            for entry in legacy_epochs
                            if entry[0] > part and entry[2].epoch == epoch
                        ]
                        if future:
                            candidate = min(future, key=lambda entry: entry[0])
                            chain_parts = [p for p in column_parts if part <= p < candidate[0]]
                            if len(chain_parts) <= 16:
                                chain = [
                                    _read_parquet_safe(
                                        column_paths[p], columns=["epoch", "col_seq", "t0_ns"]
                                    )
                                    for p in chain_parts
                                ]
                                if all(frame is not None and frame.height for frame in chain):
                                    identity = pl.concat(chain).sort("col_seq")
                                    seq = identity["col_seq"].to_numpy().astype(np.int64)
                                    times = identity["t0_ns"].to_numpy().astype(np.int64)
                                    if (
                                        identity["epoch"].unique().to_list() == [epoch]
                                        and np.all(np.diff(seq) == 1)
                                        and np.all(np.diff(times) == candidate[2].dt_ns)
                                        and candidate[1] == _hour_key(int(times[-1]))
                                    ):
                                        following = [candidate]
                                        choices = following
                    # A reset at seq zero needs its own initial epoch metadata;
                    # borrowing a previous run's identical ID is unprovable.
                    if not choices or (int(rows["col_seq"].min()) == 0 and not following):
                        logger.warning(
                            "ambiguous legacy recording epoch %s at part %s; cold start",
                            epoch,
                            part,
                        )
                        return None
                    params = max(choices, key=lambda entry: entry[0])[2]
                    if epoch in epoch_map and epoch_map[epoch] != params:
                        logger.warning(
                            "ambiguous legacy recording geometry for epoch %s; cold start", epoch
                        )
                        return None
                    epoch_map[epoch] = params
        if not needed_epochs.issubset(epoch_map):
            return None  # epochs pruned: recording unusable -> cold start

        try:
            columns = self._columns_from_table(table, epoch_map)
        except (ValueError, TypeError) as exc:
            # A ragged/corrupt column block must degrade to a cold start (§8.1)
            # like every other unusable tail — not disable recording for the
            # whole session by escaping into _boot's except.
            logger.warning("recorded column arrays unusable (%s); cold start", exc)
            return None

        # Trades/markers within the loaded column range [t0_min, t_hi), where
        # t_hi is the last column's interval end clamped by *upper* when a
        # windowed read asked for one. Ranged read: only open files whose
        # hour prefix intersects the window.
        t_lo = columns[0].t0_ns
        t_hi = columns[-1].t0_ns + epoch_map[columns[-1].epoch].dt_ns
        if upper is not None:
            t_hi = min(t_hi, upper)
        lo_key = _hour_key(max(t_lo, 0))
        hi_key = _hour_key(max(t_hi - 1, 0))
        in_range = (pl.col("ts_ns") >= t_lo) & (pl.col("ts_ns") < t_hi)
        trade_rows, trades_truncated = (
            _bounded_rows(
                d,
                "*-trades-*.parquet",
                lo_key,
                hi_key,
                in_range,
                _TRADES_MAX_PER_LOAD,
                recording_id=recording_id,
            )
            if include_events
            else (iter(()), False)
        )
        trades = [
            Trade(
                ts_ns=int(row["ts_ns"]),
                price=row["price"],
                size=row["size"],
                side=int(row["side"]),
                side_src=int(row["side_src"]),
                venue=row["venue"],
            )
            for row in trade_rows
        ]
        trades.sort(key=lambda t: t.ts_ns)
        marker_rows, markers_truncated = (
            _bounded_rows(
                d,
                "*-markers-*.parquet",
                lo_key,
                hi_key,
                in_range,
                _MARKERS_MAX_PER_LOAD,
                recording_id=recording_id,
            )
            if include_events
            else (iter(()), False)
        )
        markers = [
            Marker(
                ts_ns=int(row["ts_ns"]),
                kind=row["kind"],
                text=row["text"],
                price=row["price"],
                size=row["size"],
            )
            for row in marker_rows
        ]
        markers.sort(key=lambda m: m.ts_ns)

        return TailData(
            epochs=[epoch_map[e] for e in sorted(needed_epochs)],
            columns=columns,
            trades=trades,
            markers=markers,
            newest_t0_ns=columns[-1].t0_ns,
            truncated=truncated,
            trades_truncated=trades_truncated,
            markers_truncated=markers_truncated,
            recording_id=recording_id or None,
        )

    def newest_column_t0(self, market: str, symbol: str) -> int | None:
        """Newest recorded column ``t0_ns`` on disk — the freshness probe the
        SessionManager uses to re-validate a parked replay session on
        re-attach (a replay feed is a snapshot of the recording taken when it
        was built; growth past its tail means the parked replay is stale).

        Reads at most ONE part file: part names are chronological, so the
        newest non-empty readable ``*-columns-*`` part holds the globally
        newest ``t0_ns``. Returns ``None`` when recording is disabled or no
        readable column data exists — callers must treat "unknown" as
        not-stale rather than inventing staleness they cannot see.
        """
        if not self._enabled:
            return None
        d = self._symbol_dir(market, symbol)
        if not d.is_dir():
            return None
        for path in sorted(d.glob("*-columns-*.parquet"), key=_by_name, reverse=True):
            df = _read_parquet_safe(path)
            if df is None or df.height == 0:
                continue  # unreadable (warned) or empty: try the next-older part
            return int(df["t0_ns"].max())
        return None

    @staticmethod
    def _columns_from_table(
        table: pl.DataFrame, epoch_map: dict[int, EpochParams]
    ) -> list[FinalizedColumn]:
        """Materialize FinalizedColumns columnar-ly (H3).

        The bid/ask ``List(Float32)`` columns hold ``height × rows`` values; a
        per-row ``iter_rows`` pass materialized ~134M Python floats at a full
        32 768-column × 2048-row ring and blocked the first attach for tens of
        seconds. The two list columns flatten to one numpy f32 block each and
        reshape in C; only the 13 scalar columns walk Python. Keep f32 venue
        units: a cast to f16 here would overflow high-quantity coin books.
        """
        height = table.height
        rows = int(epoch_map[int(table["epoch"][-1])].rows)
        bid = np.ascontiguousarray(
            table["bid"].list.explode().to_numpy(), dtype=np.float32
        ).reshape(height, rows)
        ask = np.ascontiguousarray(
            table["ask"].list.explode().to_numpy(), dtype=np.float32
        ).reshape(height, rows)
        out: list[FinalizedColumn] = []
        for i, row in enumerate(table.drop(["bid", "ask"]).iter_rows(named=True)):
            epoch = int(row["epoch"])
            col_seq = int(row["col_seq"])
            t0_ns = int(row["t0_ns"])
            bar = BarColumn(
                # Identity fields equal the column's (grid invariant, see module doc).
                epoch=epoch,
                col_seq=col_seq,
                t0_ns=t0_ns,
                o=row["o"],
                h=row["h"],
                l=row["l"],
                c=row["c"],
                vol_buy=row["vol_buy"],
                vol_sell=row["vol_sell"],
                cvd_cum=row["cvd_cum"],
                vwap_num_cum=row["vwap_num_cum"],
                vwap_den_cum=row["vwap_den_cum"],
            )
            out.append(
                FinalizedColumn(
                    epoch=epoch, col_seq=col_seq, t0_ns=t0_ns, bid=bid[i], ask=ask[i], bar=bar
                )
            )
        return out

    # -- retention -------------------------------------------------------------

    def load_all(self, market: str, symbol: str) -> TailData | None:
        """Every recorded column for a symbol — explicitly UNBOUNDED.

        Same machinery/contract as :meth:`load_tail` (dedup, epoch resolution,
        corrupt-file tolerance) with the freshness window and column cap
        removed: ``cutoff`` collapses to 0 and ``limit`` to effectively
        unbounded. The tapes are still capped by the newest-N constants.

        Kept for explicit full-history callers/tests; the replay SUBSCRIBE
        path deliberately does NOT use it — a no-window subscribe is bounded
        to the newest window (FLOWMAP_REPLAY_MAX_COLS / ring_columns) in
        :meth:`SessionManager._replay_feed_blocking` rather than materializing
        a multi-GB recording. ``None`` when nothing usable is recorded (cold
        start for a replay subscribe is a refusal — the client gets an
        explicit error)."""
        return self.load_tail(
            market,
            symbol,
            max_age_ns=2**62,
            now_ns=2**62,
            limit_cols=2**31,
        )

    def inventory(self) -> list[dict[str, object]]:
        """Read-only recording inventory (backs ``GET /api/recordings``).

        One row per (market, symbol) directory holding at least one Parquet
        part: total size, part count, and the first/last recorded timestamps
        derived from the columns files' ``YYYYMMDD-HH`` name prefixes — the
        filename metadata the recorder already maintains, so the walk never
        opens a Parquet file (a multi-GB recording lists as cheaply as a
        small one). Timestamps are UTC ns: the first hour bucket's start and
        the last hour bucket's END (hour resolution is what the names
        honestly carry; ``None`` when a symbol has no columns parts)."""
        if not self._enabled or not self._base.is_dir():
            return []
        rows: list[dict[str, object]] = []
        for market_dir in sorted(self._base.iterdir(), key=lambda p: p.name):
            if not market_dir.is_dir():
                continue
            for sym_dir in sorted(market_dir.iterdir(), key=lambda p: p.name):
                if not sym_dir.is_dir():
                    continue
                files = sorted(sym_dir.glob("*.parquet"), key=_by_name)
                if not files:
                    continue
                total = 0
                for f in files:
                    try:
                        total += f.stat().st_size
                    except FileNotFoundError:
                        pass  # pruned concurrently: not part of the total
                hours = sorted(
                    {
                        h
                        for f in files
                        if "-columns-" in f.name and _HOUR_KEY_RE.fullmatch(h := _hour_prefix(f))
                    }
                )
                first_ns = last_ns = None
                if hours:
                    first_ns = _hour_start_ns(hours[0])
                    last_ns = _hour_start_ns(hours[-1]) + 3_600 * 1_000_000_000
                rows.append(
                    {
                        "market": market_dir.name,
                        "symbol": sym_dir.name,
                        "path": sym_dir.relative_to(self._base).as_posix(),
                        "size_bytes": total,
                        "parts": len(files),
                        "first_ts_ns": first_ns,
                        "last_ts_ns": last_ns,
                    }
                )
        return rows

    def enforce_retention(self) -> list[Path]:
        """Prune recordings until total ``*.parquet`` size fits the cap.

        Deletes the lexicographically oldest files first — by *filename*
        (hour prefix + part counter), globally across symbols and kinds —
        with two exemptions (see module docstring): ``*-epochs-*`` files are
        never deleted, and neither is the newest columns part of any symbol.
        The total may therefore remain above the cap when only exempt files
        are left. Never reads clocks or mtimes; tolerates files deleted
        concurrently. Returns the deleted paths in deletion order.

        Serialized by an internal lock: every flushing session runs its own
        walk in an executor thread, and two overlapping rglob/unlink passes
        over the same tree are wasted work at best."""
        if not self._enabled or not self._base.is_dir():
            return []
        with self._retention_lock:
            return self._enforce_retention_locked()

    def _enforce_retention_locked(self) -> list[Path]:
        entries: list[tuple[Path, int]] = []
        for f in sorted(self._base.rglob("*.parquet"), key=_by_name):
            try:
                entries.append((f, f.stat().st_size))
            except FileNotFoundError:
                continue  # deleted concurrently: not part of the total
        total = sum(size for _f, size in entries)
        # Protect the newest columns part per symbol dir (entries are sorted
        # ascending by name, so the last seen per parent is the newest).
        newest_columns: dict[Path, Path] = {}
        for f, _size in entries:
            if "-columns-" in f.name:
                newest_columns[f.parent] = f
        protected = set(newest_columns.values())
        pruned: list[Path] = []
        for f, size in entries:
            if total <= self._cap_bytes:
                break
            if "-epochs-" in f.name or f in protected:
                continue
            f.unlink(missing_ok=True)
            total -= size
            pruned.append(f)
            self.retention_status["deleted_parts"] += 1
            self.retention_status["deleted_bytes"] += size
            if "-columns-" in f.name:
                self.retention_status["deleted_columns_parts"] += 1
            self.retention_status["coverage_loss"] = True
            self.retention_status["recent_deleted"].append(f.relative_to(self._base).as_posix())
            self.retention_status["recent_deleted"] = self.retention_status["recent_deleted"][-256:]
        if pruned:
            self.retention_status["generation"] += 1
            logger.warning(
                "recording retention removed authoritative sources: %s", self.retention_status
            )
            try:
                from flowmap_server.core.pyramid import _atomic

                _atomic(
                    self._base / ".flowmap-retention.json",
                    msgspec.json.encode(self.retention_status),
                )
            except OSError:
                logger.exception("retention coverage-loss telemetry could not be persisted")
            from flowmap_server.core.pyramid import collect_retained_caches

            collect_retained_caches(self, [part.parent for part in pruned])
        return pruned
