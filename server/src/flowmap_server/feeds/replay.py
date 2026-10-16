"""Recording-backed replay feed (spec docs/superpowers/specs/2026-09-03-replay-engine-design.md).

Serves a symbol's RECORDED session as a paced ``Feed``: every recorded
column becomes one synthesized :class:`BookState` snapshot at the column's
``t0_ns`` (each nonzero density row mapped back to its row price via the
epoch's scale), with the recorded trades and markers of the same interval.
The Session installs the recorded aggregates into the existing Grid ring;
snapshots supply sparse row-centre quotes without integrating an old book
through missing intervals. Ring, mips and wire snapshots use the stock path.

Pacing is wall-clock based and controllable mid-stream via :meth:`control`
(``Seek`` / ``SetSpeed`` / ``Pause`` / ``Resume`` from the WS transport). At
end-of-recording the feed PARKS instead of ending: a normally-ending feed
would tear the session down, and a replayed past has no "live" to resume —
a ``Seek`` backwards rewinds the cursor and iteration continues.

Fidelity note: density and bars are recorded aggregates, and reconstructed
quotes use recorded row centres. These are not original raw L2 snapshots;
within-interval microstructure cannot be recovered from aggregate columns.
"""

from __future__ import annotations

import asyncio
import bisect
import time
from collections.abc import AsyncIterator

import numpy as np

from flowmap_server.core.price_scale import row_to_price, scale_of
from flowmap_server.core.record import TailData
from flowmap_server.feeds.base import BookState, FeedEvent
from flowmap_server.proto import events

__all__ = ["ReplayFeed"]

_PARK_POLL_S = 0.2  # end-of-recording / paused tick
_TICK_S = 0.02  # clock wait granularity while pacing


class _Clock:
    """Recorded-time position driven by wall time and a speed multiplier."""

    def __init__(self, t0: int) -> None:
        self.t = int(t0)
        self.speed = 1.0
        self.paused = False
        self._wall0 = time.monotonic()

    def now(self) -> int:
        if self.paused:
            return self.t
        return int(self.t + (time.monotonic() - self._wall0) * self.speed * 1e9)

    def pause(self) -> None:
        self.t = self.now()
        self.paused = True

    def resume(self) -> None:
        self.paused = False
        self._wall0 = time.monotonic()

    def set_speed(self, x: float) -> None:
        self.t = self.now()
        self.speed = max(0.0, float(x))
        self._wall0 = time.monotonic()

    def seek(self, t: int) -> None:
        self.t = int(t)
        self._wall0 = time.monotonic()


class ReplayFeed:
    """One recorded session, replayed. Construct via
    ``SessionManager._replay_feed`` (the recorder supplies the ``TailData``)."""

    market: str
    symbol: str
    capability: dict[str, object]

    def __init__(self, *, market: str, symbol: str, tail: TailData, speed: float = 1.0,
                 paused: bool = False) -> None:
        self.market = market
        self.symbol = symbol
        # Preserve the legacy depth schema; explicit provenance distinguishes
        # recorded aggregate density from an original raw L2 book.
        self.capability = {"depth": "L2", "tape": "tick", "trade_side": "exchange", "replay": True}
        self.capability["depth_provenance"] = "recorded-density"
        self.capability["quote_provenance"] = "recorded-row-centres"
        # Legacy Feed consumers retain this hint. Production Session replay
        # installs immutable recorded epoch geometry directly.
        self.price_adaptive_tick = market != "sim"

        self._cols = sorted(tail.columns, key=lambda c: c.t0_ns)
        self._t0s = [c.t0_ns for c in self._cols]
        self._epochs = {e.epoch: e for e in tail.epochs}
        self._scales = {e.epoch: scale_of(e) for e in tail.epochs}
        self._dts = {e.epoch: e.dt_ns for e in tail.epochs}
        # Cache only occupied rows, per immutable epoch. No full row geometry
        # is allocated for every column (BTC recordings contain mostly zeros).
        self._prices: dict[int, dict[int, float]] = {}
        self.generation = 0
        self.position = self._t0s[0]
        self.ended = False
        self.start_ns = self._t0s[0]
        self.end_ns = self._t0s[-1] + self._dts[self._cols[-1].epoch]

        # Bucket trades/markers under the column whose interval contains them
        # (greatest t0 <= ts), matching how they were recorded.
        self._by_t0: dict[int, list[FeedEvent]] = {}
        for t in sorted(tail.trades, key=lambda t: t.ts_ns):
            self._bucket(t.ts_ns, t)
        for m in sorted(tail.markers, key=lambda m: m.ts_ns):
            self._bucket(m.ts_ns, m)

        self._clock = _Clock(self._t0s[0])
        self._clock.set_speed(speed)
        if paused:
            self._clock.pause()
            self._clock.seek(self.start_ns)
        self._cursor = 0

    def playback(self) -> dict[str, object]:
        # String ns retain precision inside capability JSON (including REST).
        return {"start_ns": str(self.start_ns), "end_ns": str(self.end_ns),
                "position_ns": str(self.position), "columns": len(self._cols),
                "paused": self._clock.paused, "speed": self._clock.speed,
                "ended": self.ended, "generation": self.generation}

    def index_at(self, t: int) -> int:
        return min(len(self._cols) - 1, max(0, bisect.bisect_right(self._t0s, t) - 1))

    def snapshot_at(self, i: int) -> BookState:
        col = self._cols[i]
        return self._snapshot(col, self._scales[col.epoch])

    def acknowledge(self, i: int) -> None:
        self.position = self._t0s[i]
        self.ended = i == len(self._cols) - 1
        if self.ended:
            self._clock.pause()
            self._clock.seek(self.position)

    def _bucket(self, ts: int, ev: FeedEvent) -> None:
        i = bisect.bisect_right(self._t0s, ts) - 1
        if i < 0:
            return  # before the first column: nothing to attach it to
        if ts >= self._t0s[i] + self._dts[self._cols[i].epoch]:
            return  # in a recording gap / after the terminal interval
        self._by_t0.setdefault(self._t0s[i], []).append(ev)

    # -- transport controls ------------------------------------------------------

    def control(self, ev: events.Seek | events.SetSpeed | events.Pause | events.Resume) -> None:
        """Apply one replay transport control (called by the session layer)."""
        if isinstance(ev, events.Seek):
            self.generation += 1
            self.ended = False
            self._clock.seek(self._t0s[self.index_at(ev.t)])
            # Move the cursor to the column whose interval contains t.
            self._cursor = self.index_at(ev.t)
        elif isinstance(ev, events.SetSpeed):
            self._clock.set_speed(ev.x)
        elif isinstance(ev, events.Pause):
            self._clock.pause()
        elif isinstance(ev, events.Resume):
            if not self.ended:
                self._clock.resume()

    # -- stream --------------------------------------------------------------------

    async def events(self) -> AsyncIterator[FeedEvent]:
        """Yield the recorded session, paced. Restart contract: resumes from
        the current cursor; at end-of-recording the feed parks (a Seek
        rewinds) instead of ending — a normal end would tear the session
        down. The cursor is RE-READ every iteration, so a Seek issued while
        the feed is running takes effect immediately: a mid-stream backward
        seek jumps back at once instead of stalling and then continuing
        forward from the old position."""
        while True:
            i = self._cursor
            if i >= len(self._cols):
                await asyncio.sleep(_PARK_POLL_S)
                continue  # a Seek may have rewound us
            col = self._cols[i]
            generation = self.generation
            if self._clock.now() < col.t0_ns:
                # Not due yet (or paused before it): poll — a Pause/Seek may
                # change the target between ticks.
                await asyncio.sleep(_TICK_S)
                continue

            scale = self._scales.get(col.epoch)
            if scale is not None:
                yield self._snapshot(col, scale)

            for ev in self._by_t0.get(col.t0_ns, ()):
                if generation != self.generation:
                    break
                yield ev

            # Advance only if no Seek landed while we were suspended at the
            # yields above: control() owns the cursor then, and blindly
            # writing i+1 would silently swallow a mid-stream seek.
            if self._cursor == i and generation == self.generation:
                self._cursor = i + 1

    def _snapshot(self, col, scale) -> BookState:
        """Synthesize the column's book snapshot: each nonzero density row is
        one level at that row's price. f16 -> f64 widens losslessly."""
        cache = self._prices.setdefault(col.epoch, {})
        def levels(values):
            values = np.asarray(values)
            rows = np.flatnonzero(np.isfinite(values) & (values > 0))
            for row in rows:
                key = int(row)
                if key not in cache:
                    cache[key] = row_to_price(scale, key)
            px = np.fromiter((cache[int(r)] for r in rows), dtype=np.float64, count=len(rows))
            finite = np.isfinite(px)
            return px[finite], values[rows[finite]].astype(np.float64)
        bid_px, bid_sz = levels(col.bid)
        ask = col.ask
        if ask is not None:
            ask_px, ask_sz = levels(ask)
        else:
            ask_px = np.empty(0, dtype=np.float64)
            ask_sz = np.empty(0, dtype=np.float64)
        return BookState(
            ts_ns=int(col.t0_ns),
            bid_px=bid_px,
            bid_sz=bid_sz,
            ask_px=ask_px,
            ask_sz=ask_sz,
            revision=self.generation,
            provenance="recorded-density",
        )
