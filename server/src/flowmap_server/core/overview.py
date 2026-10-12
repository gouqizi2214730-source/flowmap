"""Bounded working memory for genuine recorded-depth time overviews.

The native ring is a cache, not the user's viewing limit. An overview has at
most 256 output columns, accumulated from as many source partitions as that
range needs. Source density is decoded in small batches, then discarded.
Completed bins can be reused without another density read. All disk reads and
aggregation are performed by Session's executor, away from the live feed loop.
"""

from __future__ import annotations

import bisect
import json
import logging
import os
import threading
import uuid
from collections import OrderedDict
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import msgspec
import numpy as np
import polars as pl

from flowmap_server.core.grid import FinalizedColumn
from flowmap_server.core.price_scale import row_to_price, scale_of
from flowmap_server.core.record import Recorder, _by_name, _epoch_from_row, _read_parquet_safe
from flowmap_server.proto.events import BarColumn, EpochParams, Marker

logger = logging.getLogger(__name__)
SOURCE_BATCH_COLS = 64
CACHE_BYTES = 32 * 1024 * 1024
MAX_GAP_MARKERS = 1024
GAP_MARKER_PREFIX = "history-gap:v1 "
RESOLUTION_MARKER_PREFIX = "flowmap.depth-resolution.v1 "
MAX_COARSE_RANGES = 8
# Only scalar identity/bounds, a few MiB even with years of small part files.
# The production BTC folder already exceeds 12k parts across unrelated runs.
_INDEX_PARTS = 65_536
_PartBounds = tuple[int, int, tuple[str, ...], int]
_PartSnapshot = list[tuple[Path, _PartBounds | None]]


class _Gap(msgspec.Struct, frozen=True):
    left_col: int
    right_col: int
    left_t0_ns: int
    left_end_t_ns: int
    right_t0_ns: int


class _CachedBin(msgspec.Struct, frozen=True):
    column: FinalizedColumn
    last_time: int
    weight: int
    last_sequence: int
    last_dt_ns: int
    gaps: tuple[_Gap, ...]
    params: EpochParams
    coarse_ranges: tuple[tuple[float, float, float], ...] = ()
    bid_integral: np.ndarray | None = None
    ask_integral: np.ndarray | None = None

    @property
    def bytes(self) -> int:
        return (
            self.column.bid.nbytes
            + self.column.ask.nbytes
            + 256
            + len(self.gaps) * 128
            + len(self.coarse_ranges) * 128
            + len(msgspec.json.encode(self.params))
            + (0 if self.bid_integral is None else self.bid_integral.nbytes)
            + (0 if self.ask_integral is None else self.ask_integral.nbytes)
        )


class OverviewCache:
    """Byte-bounded LRU of bins/prefixes built only from finalized sources."""

    def __init__(self, byte_limit: int = CACHE_BYTES) -> None:
        self.byte_limit = byte_limit
        self.bytes = 0
        # Output, final source timestamp, integrated duration, final source seq.
        # A contiguous finalized prefix may be reused and extended; the live
        # forming column is never in this cache.
        self._bins: OrderedDict[tuple[bytes, int, int], _CachedBin] = OrderedDict()

    def get(self, key: tuple[bytes, int, int]) -> _CachedBin | None:
        column = self._bins.get(key)
        if column is not None:
            self._bins.move_to_end(key)
        return column

    def put(
        self,
        key: tuple[bytes, int, int],
        column: FinalizedColumn,
        last_time: int,
        weight: int,
        last_sequence: int,
        last_dt_ns: int,
        gaps: tuple[_Gap, ...],
        params: EpochParams,
        coarse_ranges: tuple[tuple[float, float, float], ...] = (),
        bid_integral: np.ndarray | None = None,
        ask_integral: np.ndarray | None = None,
    ) -> None:
        entry = _CachedBin(
            column,
            last_time,
            weight,
            last_sequence,
            last_dt_ns,
            gaps,
            params,
            coarse_ranges,
            bid_integral,
            ask_integral,
        )
        size = entry.bytes
        previous = self._bins.get(key)
        if previous is not None and previous.last_sequence > last_sequence:
            return  # a historical boundary read cannot replace a fuller bin
        previous = self._bins.pop(key, None)
        if previous is not None:
            self.bytes -= previous.bytes
        if size > self.byte_limit:
            return
        while self._bins and self.bytes + size > self.byte_limit:
            _, dropped = self._bins.popitem(last=False)
            self.bytes -= dropped.bytes
        self._bins[key] = entry
        self.bytes += size


def _native_geometry(rows: int) -> bytes:
    # Cache belongs to one Session/recording. Its historical group geometry
    # must not be invalidated merely because the live core rolls again.
    return b"native-group-epoch:v1:" + str(rows).encode("ascii")


def _bounded_coarse_ranges(ranges) -> tuple[tuple[float, float, float], ...]:
    """Exact piecewise widest footprint; disjoint gaps are never filled.

    The old eight-range GPU uniform cap is no longer a CPU metadata limit.
    Adjacent segments merge only when their physical source width matches.
    """
    from collections import Counter

    events = {}
    for low, high, width in ranges:
        if not (
            np.isfinite(low)
            and np.isfinite(high)
            and np.isfinite(width)
            and high > low
            and width > 0
        ):
            continue
        events.setdefault(float(low), []).append((float(width), 1))
        events.setdefault(float(high), []).append((float(width), -1))
    active = Counter()
    merged = []
    prior = None
    for edge in sorted(events):
        if prior is not None and active and edge > prior:
            width = max(active)
            if merged and merged[-1][1] == prior and merged[-1][2] == width:
                merged[-1] = merged[-1][0], edge, width
            else:
                merged.append((prior, edge, width))
        for width, delta in events[edge]:
            active[width] += delta
            if active[width] <= 0:
                del active[width]
        prior = edge
    return tuple(merged)


class _Coverage:
    """Disjoint sequence runs; duplicate parts do not need a per-column set."""

    def __init__(self) -> None:
        self.runs: list[tuple[int, int]] = []
        self.count = 0

    def add(self, sequence: int) -> bool:
        i = bisect.bisect_right(self.runs, (sequence, 2**32))
        if i and self.runs[i - 1][1] >= sequence:
            return False
        low = high = sequence
        if i and self.runs[i - 1][1] == sequence - 1:
            low = self.runs[i - 1][0]
            i -= 1
            self.runs.pop(i)
        if i < len(self.runs) and self.runs[i][0] == sequence + 1:
            high = self.runs.pop(i)[1]
        self.runs.insert(i, (low, high))
        self.count += 1
        return True

    def add_range(self, low: int, high: int) -> None:
        """Cached prefixes restore compact runs without walking source rows."""
        out: list[tuple[int, int]] = []
        placed = False
        for first, last in self.runs:
            if last + 1 < low:
                out.append((first, last))
            elif high + 1 < first:
                if not placed:
                    out.append((low, high))
                    placed = True
                out.append((first, last))
            else:
                low, high = min(low, first), max(high, last)
        if not placed:
            out.append((low, high))
        self.runs = out
        self.count = sum(last - first + 1 for first, last in out)


class _Bin:
    def __init__(self, rows: int) -> None:
        self.bid = np.zeros(rows, dtype=np.float64)
        self.ask = np.zeros(rows, dtype=np.float64)
        self.weight = 0
        self.coverage = _Coverage()
        # Keep scalar bars, never array views that retain a whole source batch.
        self.first: BarColumn | None = None
        self.last: BarColumn | None = None
        self.last_dt_ns = 1
        self.high = -np.inf
        self.low = np.inf
        self.buy = 0.0
        self.sell = 0.0
        self.coarse_ranges: tuple[tuple[float, float, float], ...] = ()


class OverviewBuilder:
    def __init__(
        self,
        target: EpochParams,
        start: int,
        end: int,
        stride: int,
        before_t: int,
        latest_sequence: int,
        cache: OverviewCache,
        *,
        group_targets: dict[int, EpochParams] | None = None,
    ) -> None:
        self.target = target
        self.start, self.end, self.stride = start, end, stride
        self.before_t = before_t
        self.latest_sequence = latest_sequence
        self.cache = cache
        self.group_targets = group_targets
        self.geometry = (
            _native_geometry(target.rows)
            if group_targets is not None
            else msgspec.json.encode(target)
        )
        self.output_epochs: dict[int, EpochParams] = {}
        self.bins: dict[int, _Bin] = {}
        self.ready: dict[int, FinalizedColumn] = {}
        self._coarse_ranges: dict[int, tuple[tuple[float, float, float], ...]] = {}
        # Epochs roll frequently now. Bound transient plans as well as output
        # bins; a plan contains at most source.rows + target.rows overlaps.
        self._projection: OrderedDict[
            tuple[bytes, bytes],
            tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray] | None,
        ] = OrderedDict()
        self.first_time: int | None = None
        self.last_time: int | None = None
        # Only run boundaries survive, not one timestamp object per source.
        # Real discontinuities are recorded separately and capped.
        self._source_coverage = _Coverage()
        self._source_endpoints: dict[int, tuple[int, int]] = {}
        self._gaps: dict[tuple[int, int], _Gap] = {}
        first_group = start // stride * stride
        for group in range(first_group, end + 1, stride):
            # Boundary bins are partial requests and cannot reuse full bins.
            if group < start:
                continue
            cached = cache.get((self.geometry, stride, group))
            if cached is not None and cached.last_time < before_t and cached.last_sequence <= end:
                group_target = self._target_for(group)
                if cached.params != group_target:
                    # A newly completed group's midpoint can choose a newer
                    # native frame. Re-read its genuine sources instead of
                    # reprojecting an already averaged coarse prefix again.
                    continue
                self.output_epochs[group_target.epoch] = group_target
                column, last_time, weight, last_sequence = (
                    cached.column,
                    cached.last_time,
                    cached.weight,
                    cached.last_sequence,
                )
                if last_sequence == min(group + stride - 1, end):
                    self.ready[group] = column
                    self._coarse_ranges[group] = cached.coarse_ranges
                else:
                    item = self.bins[group] = _Bin(group_target.rows)
                    item.bid[:] = (
                        cached.bid_integral
                        if cached.bid_integral is not None
                        else column.bid.astype(np.float64) * weight
                    )
                    item.ask[:] = (
                        cached.ask_integral
                        if cached.ask_integral is not None
                        else column.ask.astype(np.float64) * weight
                    )
                    item.weight = weight
                    item.coverage.runs = [(group, last_sequence)]
                    item.coverage.count = last_sequence - group + 1
                    item.first = column.bar
                    item.last = msgspec.structs.replace(
                        column.bar, col_seq=last_sequence, t0_ns=last_time
                    )
                    item.last_dt_ns = cached.last_dt_ns
                    item.high, item.low = column.bar.h, column.bar.l
                    item.buy, item.sell = column.bar.vol_buy, column.bar.vol_sell
                    item.coarse_ranges = cached.coarse_ranges
                self.first_time = (
                    column.t0_ns if self.first_time is None else min(self.first_time, column.t0_ns)
                )
                self.last_time = (
                    last_time if self.last_time is None else max(self.last_time, last_time)
                )
                for gap in cached.gaps:
                    self._gaps[(gap.left_col, gap.right_col)] = gap
                self._remember_source_range(
                    group, last_sequence, column.t0_ns, last_time, cached.last_dt_ns
                )

    def _maybe_gap(
        self, left_col: int, left: tuple[int, int] | None, right_col: int, right_t0: int
    ) -> None:
        if left is None or right_col != left_col + 1:
            return
        left_t0, left_dt = left
        left_end = left_t0 + max(1, left_dt)
        if right_t0 > left_end + max(1, left_dt // 2):
            self._gaps[(left_col, right_col)] = _Gap(
                left_col, right_col, left_t0, left_end, right_t0
            )

    def _remember_source_range(
        self, low: int, high: int, first_t0: int, last_t0: int, last_dt: int
    ) -> None:
        self._maybe_gap(low - 1, self._source_endpoints.get(low - 1), low, first_t0)
        successor = self._source_endpoints.get(high + 1)
        if successor is not None:
            self._maybe_gap(high, (last_t0, last_dt), high + 1, successor[0])
        self._source_coverage.add_range(low, high)
        self._source_endpoints[low] = (first_t0, self.target.dt_ns)
        self._source_endpoints[high] = (last_t0, last_dt)
        boundaries = {edge for run in self._source_coverage.runs for edge in run}
        self._source_endpoints = {
            seq: value for seq, value in self._source_endpoints.items() if seq in boundaries
        }

    def gap_markers(self) -> list[Marker]:
        """Internal metadata travels in existing cold Marker.text JSON.

        ns fields are strings to preserve integer precision in JavaScript.
        The client turns this into a human label and exact raw time knots.
        """
        return [
            Marker(
                ts_ns=gap.right_t0_ns,
                kind="gap",
                price=None,
                size=None,
                text=GAP_MARKER_PREFIX
                + json.dumps(
                    {
                        "left_col": gap.left_col,
                        "right_col": gap.right_col,
                        "left_t0_ns": str(gap.left_t0_ns),
                        "left_end_t_ns": str(gap.left_end_t_ns),
                        "right_t0_ns": str(gap.right_t0_ns),
                    },
                    separators=(",", ":"),
                ),
            )
            for gap in sorted(self._gaps.values(), key=lambda entry: entry.right_t0_ns)
        ]

    def resolution_markers(self) -> list[Marker]:
        """Physical source-resolution metadata in the existing cold wire shape.

        Coarse-to-fine projection conserves mass but cannot create known fine
        levels. Only active source cells exceeding twice an overlapped target
        cell width contribute. Native same-map groups need no extra marker.
        """
        return [
            Marker(
                ts_ns=self.ready[group].t0_ns,
                kind="info",
                text=RESOLUTION_MARKER_PREFIX
                + json.dumps(
                    {
                        "col_seq": group,
                        "epoch": self.ready[group].epoch,
                        "stride": self.stride,
                        "t0_ns": str(self.ready[group].t0_ns),
                        "ranges": ranges,
                    },
                    separators=(",", ":"),
                ),
            )
            for group, ranges in sorted(self._coarse_ranges.items())
            if ranges
        ]

    def missing_ranges(self) -> list[tuple[int, int]]:
        ranges: list[tuple[int, int]] = []
        for group in range(self.start // self.stride * self.stride, self.end + 1, self.stride):
            if group in self.ready:
                continue
            low, high = max(group, self.start), min(group + self.stride - 1, self.end)
            if ranges and ranges[-1][1] + 1 == low:
                ranges[-1] = ranges[-1][0], high
            else:
                ranges.append((low, high))
        return ranges

    def missing_source_ranges(self) -> list[tuple[int, int]]:
        """Subtract genuine RAM/earlier-part coverage before density IO."""
        missing: list[tuple[int, int]] = []
        for group in range(self.start // self.stride * self.stride, self.end + 1, self.stride):
            if group in self.ready:
                continue
            cursor, high = max(group, self.start), min(group + self.stride - 1, self.end)
            item = self.bins.get(group)
            for low_run, high_run in item.coverage.runs if item is not None else []:
                if cursor < low_run:
                    missing.append((cursor, min(high, low_run - 1)))
                cursor = max(cursor, high_run + 1)
            if cursor <= high:
                missing.append((cursor, high))
        merged: list[tuple[int, int]] = []
        for low, high in missing:
            if high < low:
                continue
            if merged and merged[-1][1] + 1 == low:
                merged[-1] = merged[-1][0], high
            else:
                merged.append((low, high))
        return merged

    def _target_for(self, group: int) -> EpochParams:
        return (
            self.target
            if self.group_targets is None
            else self.group_targets.get(group, self.target)
        )

    def _plan(self, source: EpochParams, target: EpochParams):
        key = msgspec.json.encode(source), msgspec.json.encode(target)
        if key in self._projection:
            self._projection.move_to_end(key)
            return self._projection[key]
        if len(self._projection) >= 32:
            self._projection.popitem(last=False)
        source_scale, target_scale = scale_of(source), scale_of(target)
        if source_scale == target_scale:
            self._projection[key] = None
            return None
        # Rows carry nearest-bin quantities. Integrate their true price
        # intervals, rather than treating equal row indices as equal prices.
        src_edges = np.array([row_to_price(source_scale, r - 0.5) for r in range(source.rows + 1)])
        dst_edges = np.array([row_to_price(target_scale, r - 0.5) for r in range(target.rows + 1)])
        if (
            not np.all(np.isfinite(src_edges))
            or not np.all(np.diff(src_edges) > 0)
            or not np.all(np.isfinite(dst_edges))
            or not np.all(np.diff(dst_edges) > 0)
        ):
            raise ValueError("invalid overview price geometry")
        sources, targets, weights = [], [], []
        i = j = 0
        while i < source.rows and j < target.rows:
            low = max(src_edges[i], dst_edges[j])
            high = min(src_edges[i + 1], dst_edges[j + 1])
            if high > low:
                sources.append(i)
                targets.append(j)
                weights.append((high - low) / (src_edges[i + 1] - src_edges[i]))
            if src_edges[i + 1] <= dst_edges[j + 1]:
                i += 1
            else:
                j += 1
        src, dst = np.array(sources, dtype=np.int32), np.array(targets, dtype=np.int32)
        source_widths, target_widths = np.diff(src_edges), np.diff(dst_edges)
        minimum_target_width = np.full(source.rows, np.inf)
        np.minimum.at(minimum_target_width, src, target_widths[dst])
        coarse_rows = np.flatnonzero(source_widths > 2 * minimum_target_width).astype(np.int32)
        coarse_ranges = np.column_stack(
            (
                np.maximum(src_edges[coarse_rows], dst_edges[0]),
                np.minimum(src_edges[coarse_rows + 1], dst_edges[-1]),
                source_widths[coarse_rows],
            )
        )
        plan = (src, dst, np.array(weights, dtype=np.float64), coarse_rows, coarse_ranges)
        self._projection[key] = plan
        return plan

    def add(self, columns: list[FinalizedColumn], epochs: dict[int, EpochParams]) -> None:
        for col in columns:
            if not self.start <= col.col_seq <= self.end or col.t0_ns >= self.before_t:
                continue
            group = col.col_seq // self.stride * self.stride
            if group in self.ready:
                continue
            source = epochs.get(col.epoch)
            if (
                source is None
                or len(col.bid) != source.rows
                or len(col.ask) != source.rows
                or not np.all(np.isfinite(col.bid))
                or not np.all(np.isfinite(col.ask))
                or np.any(col.bid < 0)
                or np.any(col.ask < 0)
            ):
                continue
            target = self._target_for(group)
            plan = self._plan(source, target)
            item = self.bins.get(group)
            if item is None:
                item = self.bins[group] = _Bin(target.rows)
            if not item.coverage.add(col.col_seq):
                continue
            self._remember_source_range(
                col.col_seq, col.col_seq, col.t0_ns, col.t0_ns, max(1, source.dt_ns)
            )
            weight = max(1, source.dt_ns)
            if plan is None:
                item.bid += col.bid.astype(np.float64) * weight
                item.ask += col.ask.astype(np.float64) * weight
            else:
                src, dst, fractions, coarse_rows, coarse_ranges = plan
                item.bid += np.bincount(
                    dst, weights=col.bid[src] * fractions * weight, minlength=target.rows
                )
                item.ask += np.bincount(
                    dst, weights=col.ask[src] * fractions * weight, minlength=target.rows
                )
                active = (col.bid[coarse_rows] > 0) | (col.ask[coarse_rows] > 0)
                if np.any(active):
                    item.coarse_ranges = _bounded_coarse_ranges(
                        [*item.coarse_ranges, *coarse_ranges[active]]
                    )
            item.weight += weight
            if item.first is None or col.col_seq < item.first.col_seq:
                item.first = col.bar
            if item.last is None or col.col_seq > item.last.col_seq:
                item.last = col.bar
                item.last_dt_ns = max(1, source.dt_ns)
            if np.isfinite(col.bar.h):
                item.high = max(item.high, col.bar.h)
            if np.isfinite(col.bar.l):
                item.low = min(item.low, col.bar.l)
            item.buy += col.bar.vol_buy
            item.sell += col.bar.vol_sell
            self.first_time = (
                col.t0_ns if self.first_time is None else min(self.first_time, col.t0_ns)
            )
            self.last_time = col.t0_ns if self.last_time is None else max(self.last_time, col.t0_ns)

    def add_integrals(self, fragment) -> None:
        """Fold a checksummed native component without making display means.

        Partial/duplicate leaves are rejected by the caller and filled from
        the exact raw reader. The duration is the genuine integrated source
        duration; clock gaps do not donate quantity or volume.
        """
        from flowmap_server.core.pyramid import _spans

        spans = fragment.get("spans") or _spans(fragment.get("samples", []))
        if not spans:
            return
        group = spans[0][0] // self.stride * self.stride
        target = self._target_for(group)
        item = self.bins.setdefault(group, _Bin(target.rows))
        # Collapse genuine affine spans before touching global coverage/gap
        # bookkeeping. This preserves every seam while avoiding a full
        # history-sized set/dictionary rewrite for every source column.
        for low, high, first_time, last_time, duration in spans:
            if any(first <= high and last >= low for first, last in item.coverage.runs):
                raise ValueError("duplicate persistent source contribution")
            item.coverage.add_range(low, high)
            self._remember_source_range(low, high, first_time, last_time, duration)
        for comp in fragment["components"]:
            source = comp["params"]
            plan = self._plan(source, target)
            if plan is None:
                item.bid += comp["bid"]
                item.ask += comp["ask"]
            else:
                src, dst, fractions, coarse_rows, coarse_ranges = plan
                item.bid += np.bincount(
                    dst, weights=comp["bid"][src] * fractions, minlength=target.rows
                )
                item.ask += np.bincount(
                    dst, weights=comp["ask"][src] * fractions, minlength=target.rows
                )
                active = (comp["bid"][coarse_rows] > 0) | (comp["ask"][coarse_rows] > 0)
                item.coarse_ranges = _bounded_coarse_ranges(
                    [*item.coarse_ranges, *coarse_ranges[active]]
                )
            item.weight += comp["weight"]
        first, last = fragment["first"], fragment["last"]
        if item.first is None or first.col_seq < item.first.col_seq:
            item.first = first
        if item.last is None or last.col_seq > item.last.col_seq:
            item.last, item.last_dt_ns = last, spans[-1][4]
        item.high, item.low = max(item.high, fragment["high"]), min(item.low, fragment["low"])
        item.buy += fragment["buy"]
        item.sell += fragment["sell"]
        self.first_time = (
            first.t0_ns if self.first_time is None else min(self.first_time, first.t0_ns)
        )
        self.last_time = last.t0_ns if self.last_time is None else max(self.last_time, last.t0_ns)

    def finish(self) -> list[FinalizedColumn]:
        for group, item in self.bins.items():
            first, last = item.first, item.last
            if first is None or last is None or item.weight <= 0:
                continue
            target = self._target_for(group)
            self.output_epochs[target.epoch] = target
            bar = BarColumn(
                epoch=target.epoch,
                col_seq=group,
                t0_ns=first.t0_ns,
                o=first.o,
                h=float(item.high) if np.isfinite(item.high) else first.h,
                l=float(item.low) if np.isfinite(item.low) else first.l,
                c=last.c,
                vol_buy=item.buy,
                vol_sell=item.sell,
                cvd_cum=last.cvd_cum,
                vwap_num_cum=last.vwap_num_cum,
                vwap_den_cum=last.vwap_den_cum,
            )
            output = FinalizedColumn(
                epoch=target.epoch,
                col_seq=group,
                t0_ns=first.t0_ns,
                bid=(item.bid / item.weight).astype(np.float32),
                ask=(item.ask / item.weight).astype(np.float32),
                bar=bar,
            )
            self.ready[group] = output
            self._coarse_ranges[group] = item.coarse_ranges
            if (
                group >= self.start
                and item.coverage.runs == [(group, last.col_seq)]
                and last.col_seq <= self.latest_sequence
            ):
                self.cache.put(
                    (self.geometry, self.stride, group),
                    output,
                    last.t0_ns,
                    item.weight,
                    last.col_seq,
                    item.last_dt_ns,
                    tuple(
                        gap for gap in self._gaps.values() if group <= gap.right_col <= last.col_seq
                    ),
                    target,
                    item.coarse_ranges,
                    item.bid.copy(),
                    item.ask.copy(),
                )
        return [self.ready[group] for group in sorted(self.ready)]


def _recording_epochs(
    directory: Path,
    recording_id: str | None,
    known_epochs: dict[int, EpochParams],
    legacy_segments: list[tuple[int, int, int]],
) -> dict[str, dict[int, EpochParams]]:
    epoch_maps: dict[str, dict[int, EpochParams]] = {}
    conflicts: set[tuple[str, int]] = set()
    for path in sorted(directory.glob("*-epochs-*.parquet"), key=_by_name):
        table = _read_parquet_safe(path)
        if table is None:
            continue
        for row in table.iter_rows(named=True):
            identity = row.get("recording_id", "") or ""
            if identity != (recording_id or "") and not (identity == "" and legacy_segments):
                continue
            epoch = _epoch_from_row(row)
            mapping = epoch_maps.setdefault(identity, {})
            if epoch.epoch in mapping and mapping[epoch.epoch] != epoch:
                conflicts.add((identity, epoch.epoch))
            mapping[epoch.epoch] = epoch
    for identity, epoch in conflicts:
        epoch_maps[identity].pop(epoch, None)
    for identity, mapping in epoch_maps.items():
        for epoch, params in list(mapping.items()):
            if (epoch in known_epochs and known_epochs[epoch] != params) or (
                not identity and known_epochs.get(epoch) != params
            ):
                mapping.pop(epoch)
    return epoch_maps


def native_group_epochs(
    target: EpochParams,
    start: int,
    end: int,
    stride: int,
    before_t: int,
    cache: OverviewCache,
    ram_refs: list[tuple[int, int, int]],
    root: Recorder | None,
    market: str,
    symbol: str,
    recording_id: str | None,
    known_epochs: dict[int, EpochParams],
    legacy_segments: list[tuple[int, int, int]],
    parts: _PartSnapshot | None = None,
) -> dict[int, EpochParams]:
    """Choose each time group's native epoch nearest its source midpoint.

    Only scalar epoch/sequence/time metadata is scanned before aggregation.
    Genuine density still streams once in <=64-column batches. Complete cache
    hits require no disk reads; RAM and newer immutable parts win duplicates.
    At most one scalar representative survives per bounded output group.
    """
    targets: dict[int, EpochParams] = {}
    candidates: dict[int, tuple[tuple[int, int], EpochParams]] = {}
    missing: list[tuple[int, int]] = []
    geometry = _native_geometry(target.rows)
    for group in range(start // stride * stride, end + 1, stride):
        cached = cache.get((geometry, stride, group))
        if (
            group >= start
            and cached is not None
            and cached.last_time < before_t
            and cached.last_sequence == min(group + stride - 1, end)
        ):
            targets[group] = cached.params
        else:
            low, high = max(start, group), min(end, group + stride - 1)
            if missing and missing[-1][1] + 1 == low:
                missing[-1] = missing[-1][0], high
            else:
                missing.append((low, high))
    if not missing:
        return targets

    def consider(sequence: int, time: int, params: EpochParams | None) -> None:
        if (
            params is None
            or params.rows != target.rows
            or not start <= sequence <= end
            or time >= before_t
        ):
            return
        group = sequence // stride * stride
        if group in targets:
            return
        # Integer twice-distance preserves exact ordering for huge sequences.
        center2 = max(start, group) + min(end, group + stride - 1)
        rank = abs(2 * sequence - center2), sequence
        previous = candidates.get(group)
        if previous is None or rank < previous[0]:
            candidates[group] = rank, params

    for sequence, time, epoch in ram_refs:
        consider(sequence, time, known_epochs.get(epoch))
    if root is not None and root._enabled:
        directory = root._symbol_dir(market, symbol)
        if directory.is_dir():
            if parts is None:
                parts = []
            if not parts:
                warm_part_index(root, market, symbol, parts=parts)
            from flowmap_server.core.pyramid import pyramid_for

            pyramid = pyramid_for(root, market, symbol, recording_id)
            summary_doc = pyramid.snapshot()
            mappings = pyramid.epoch_maps(
                known_epochs, legacy_segments, summary_doc, getattr(parts, "epoch_stamps", None)
            )
            native_maps = mappings.get(recording_id or "", {})
            allowed = [recording_id or ""]
            if legacy_segments and "" not in allowed:
                allowed.append("")
            for path, bounds in parts:
                if (
                    bounds is None
                    or not any(lo <= bounds[1] and hi >= bounds[0] for lo, hi in missing)
                    or not any(identity in allowed for identity in bounds[2])
                ):
                    continue
                prepared = pyramid._valid(
                    path, native_maps, getattr(parts, "stamps", {}).get(path), summary_doc
                )
                if (
                    prepared is not None
                    and prepared.get("prepared_range", [bounds[0], bounds[1]])[0]
                    <= max(start, bounds[0])
                    and prepared.get("prepared_range", [bounds[0], bounds[1]])[1]
                    >= min(end, bounds[1])
                    and all(f["max_t"] < before_t for f in prepared["fragments"])
                ):
                    for low, high, timestamp, params in pyramid.representatives(
                        [(path, bounds)], native_maps, start, end, before_t, prepared
                    ):
                        for group in range(low // stride * stride, high + 1, stride):
                            center = (max(start, group) + min(end, group + stride - 1)) // 2
                            consider(max(low, min(high, center)), timestamp, params)
                    continue
                schema = pl.read_parquet_schema(path)
                if "recording_id" not in schema and recording_id and not legacy_segments:
                    continue
                names = ["epoch", "col_seq", "t0_ns"]
                if "recording_id" in schema:
                    names.append("recording_id")
                wanted = pl.lit(False)
                for low, high in missing:
                    wanted |= pl.col("col_seq").is_between(low, high)
                scalars = (
                    pl.scan_parquet(path)
                    .select(names)
                    .filter(wanted & (pl.col("t0_ns") < before_t))
                )
                if "recording_id" in schema:
                    scalars = scalars.filter(pl.col("recording_id").fill_null("").is_in(allowed))
                for row in scalars.collect(engine="streaming").iter_rows(named=True):
                    identity = row.get("recording_id", "") or ""
                    params = mappings.get(identity, {}).get(row["epoch"])
                    if not identity and (
                        params is None
                        or not any(
                            low <= row["col_seq"] <= high
                            and row["t0_ns"] == origin + row["col_seq"] * params.dt_ns
                            for origin, low, high in legacy_segments
                        )
                    ):
                        continue
                    consider(row["col_seq"], row["t0_ns"], params)
    targets.update({group: value[1] for group, value in candidates.items()})
    return targets


def _part_bounds(
    root: Recorder, path: Path, stamp: tuple[int, int] | None = None
) -> _PartBounds | None:
    """Bounded scalar index; no density is read for unrelated old part files."""
    if stamp is None:
        try:
            stat = path.stat()
        except OSError:
            return None
        stamp = (stat.st_size, stat.st_mtime_ns)
    with root._column_time_lock:
        cache = getattr(root, "_overview_part_bounds", None)
        if cache is None:
            cache = root._overview_part_bounds = {}
        cached = cache.get(path)
        if cached is not None and cached[:2] == stamp:
            return cached[2]
    try:
        names = ["col_seq"]
        if "recording_id" in pl.read_parquet_schema(path):
            names.append("recording_id")
        frame = _read_parquet_safe(path, columns=names)
    except (pl.exceptions.PolarsError, OSError):
        frame = None
    bounds = None
    if frame is not None and frame.height:
        identities = (
            tuple(frame["recording_id"].fill_null("").unique().to_list())
            if "recording_id" in frame.columns
            else ("",)
        )
        bounds = int(frame["col_seq"].min()), int(frame["col_seq"].max()), identities, frame.height
    with root._column_time_lock:
        if path not in cache and len(cache) >= _INDEX_PARTS:
            cache.pop(next(iter(cache)))
        cache[path] = (*stamp, bounds)
    return bounds


def _load_part_index(root: Recorder, directory: Path) -> None:
    """Persist only replaceable scalar metadata; never alter recorded density."""
    index = directory / ".flowmap-overview-index.json"
    try:
        if index.stat().st_size > 32 * 1024 * 1024:
            return
        payload = json.loads(index.read_text(encoding="utf-8"))
        if payload.get("version") != 1:
            return
        entries = payload["parts"]
        if not isinstance(entries, list) or len(entries) > _INDEX_PARTS:
            return
        valid = {}
        for item in entries:
            name, size, stamp, low, high, identities, count = item
            if (
                not isinstance(name, str)
                or Path(name).name != name
                or not name.endswith(".parquet")
                or "-columns-" not in name
                or not all(
                    isinstance(value, int) and value >= 0
                    for value in [size, stamp, low, high, count]
                )
                or not 0 <= low <= high < 2**32
                or not isinstance(identities, list)
                or not all(
                    isinstance(identity, str) and len(identity) <= 128 for identity in identities
                )
            ):
                continue
            valid[directory / name] = size, stamp, (low, high, tuple(identities), count)
        with root._column_time_lock:
            cache = getattr(root, "_overview_part_bounds", None)
            if cache is None:
                cache = root._overview_part_bounds = {}
            for path, entry in valid.items():
                if path not in cache:
                    if len(cache) >= _INDEX_PARTS:
                        cache.pop(next(iter(cache)))
                    cache[path] = entry
    except (OSError, ValueError, KeyError, TypeError):
        # A cache miss/corrupt index is harmless: exact file stamps below
        # validate every reused entry; source data remains authoritative.
        return


def _save_part_index(root: Recorder, directory: Path, paths: list[Path]) -> None:
    with root._column_time_lock:
        cache = getattr(root, "_overview_part_bounds", {})
        entries = []
        for path in paths:
            item = cache.get(path)
            if item is not None and item[2] is not None:
                low, high, identities, count = item[2]
                entries.append([path.name, item[0], item[1], low, high, list(identities), count])
    index = directory / ".flowmap-overview-index.json"
    temporary = directory / f".flowmap-overview-index-{uuid.uuid4().hex}.tmp"
    try:
        temporary.write_text(
            json.dumps({"version": 1, "parts": entries}, separators=(",", ":")), encoding="utf-8"
        )
        os.replace(temporary, index)
    except OSError:
        logger.debug("could not persist optional overview scalar index for %s", directory)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def warm_part_index(
    root: Recorder,
    market: str,
    symbol: str,
    stop: Callable[[], bool] | None = None,
    *,
    parts: _PartSnapshot | None = None,
) -> None:
    """Warm scalar metadata off-loop, with two bounded IO workers.

    A reused index only costs file-stamp checks on the next launch. Directory
    globbing notices new immutable parts; retained/rewritten parts are always
    validated by size/mtime. The optional cache file never replaces source data.
    """
    if not root._enabled:
        return
    directory = root._symbol_dir(market, symbol)
    if not directory.is_dir():
        return
    with root._column_time_lock:
        locks = getattr(root, "_overview_warm_locks", None)
        if locks is None:
            locks = root._overview_warm_locks = {}
        lock = locks.setdefault(directory, threading.Lock())
        warmed = getattr(root, "_overview_warmed", None)
        if warmed is None:
            warmed = root._overview_warmed = set()
    with lock:
        was_warmed = directory in warmed
        if (was_warmed and parts is None) or (stop is not None and stop()):
            return
        if not was_warmed:
            _load_part_index(root, directory)
        # A fresh directory scan validates every request's file size/mtime.
        # On Windows these regular-file attributes come from enumeration,
        # avoiding one handle-opening Path.stat for every historical part.
        # DirEntry metadata never survives this request or warmup.
        entries = []
        named_index = getattr(parts, "index_by_name", {})
        with os.scandir(directory) as scan:
            for entry in scan:
                if "-columns-" not in entry.name or not entry.name.endswith(".parquet"):
                    if (
                        hasattr(parts, "epoch_stamps")
                        and "-epochs-" in entry.name
                        and entry.name.endswith(".parquet")
                        and entry.is_file(follow_symlinks=False)
                    ):
                        stat = entry.stat(follow_symlinks=False)
                        parts.epoch_stamps.append([entry.name, stat.st_size, stat.st_mtime_ns])
                    continue
                try:
                    if not entry.is_file(follow_symlinks=False):
                        continue
                    stat = entry.stat(follow_symlinks=False)
                except OSError:
                    continue  # an immutable part may have just been retained away
                stamp = stat.st_size, stat.st_mtime_ns
                indexed = named_index.get(entry.name)
                if indexed is not None and indexed[1][:2] == stamp:
                    bounds = indexed[1][2]
                    if bounds is not None and (bounds[1] < parts.start or bounds[0] > parts.end):
                        continue
                    path = indexed[0]
                    if path is None:
                        path = Path(entry.path)
                        named_index[entry.name] = path, indexed[1]
                        with root._column_time_lock:
                            root._overview_part_bounds.setdefault(path, indexed[1])
                else:
                    path = Path(entry.path)
                entries.append((path, stamp))
        entries.sort(key=lambda entry: entry[0].name, reverse=True)
        if hasattr(parts, "epoch_stamps"):
            parts.epoch_stamps.sort()
        paths = [entry[0] for entry in entries]
        if hasattr(parts, "stamps"):
            parts.stamps = dict(entries)
        # Do not enqueue years of files as one huge futures list. Only 64
        # tiny scalar jobs are in flight; density is never read by prewarming.
        with ThreadPoolExecutor(
            max_workers=2, thread_name_prefix="flowmap-history-index"
        ) as executor:
            for first in range(0, len(paths), SOURCE_BATCH_COLS):
                if stop is not None and stop():
                    return
                batch = entries[first : first + SOURCE_BATCH_COLS]
                with root._column_time_lock:
                    cache = getattr(root, "_overview_part_bounds", {})
                    bounds = [
                        cache[path][2] if path in cache and cache[path][:2] == stamp else None
                        for path, stamp in batch
                    ]
                    misses = [
                        i
                        for i, (path, stamp) in enumerate(batch)
                        if path not in cache or cache[path][:2] != stamp
                    ]
                refreshed = executor.map(lambda i: _part_bounds(root, *batch[i]), misses)
                for i, value in zip(misses, refreshed):
                    bounds[i] = value
                    path, stamp = batch[i]
                    named_index[path.name] = path, (*stamp, value)
                if parts is not None:
                    parts.extend(zip((entry[0] for entry in batch), bounds))
        if stop is not None and stop():
            return
        if not was_warmed:
            _save_part_index(root, directory, paths)
        warmed.add(directory)


def _validated_chunks(
    table: pl.DataFrame,
    epoch_maps: dict[str, dict[int, EpochParams]],
    legacy_segments: list[tuple[int, int, int]],
    root: Recorder,
):
    if "recording_id" not in table.columns:
        table = table.with_columns(pl.lit("").alias("recording_id"))
    for identity in table["recording_id"].fill_null("").unique().to_list():
        mapping = epoch_maps.get(identity, {})
        selected = table.filter(pl.col("recording_id").fill_null("") == identity)
        selected = selected.filter(pl.col("epoch").is_in(list(mapping)))
        if not identity:
            safe = pl.lit(False)
            for origin, low, high in legacy_segments:
                for epoch, params in mapping.items():
                    safe |= (
                        (pl.col("epoch") == epoch)
                        & pl.col("col_seq").is_between(low, high)
                        & (
                            pl.col("t0_ns")
                            == origin + pl.col("col_seq").cast(pl.Int64) * params.dt_ns
                        )
                    )
            selected = selected.filter(safe)
        for epoch in selected["epoch"].unique().to_list():
            chunk = selected.filter(pl.col("epoch") == epoch)
            if chunk.height:
                yield root._columns_from_table(chunk, mapping), mapping


def recorded_batches(
    root: Recorder,
    market: str,
    symbol: str,
    ranges: list[tuple[int, int]],
    recording_id: str | None,
    known_epochs: dict[int, EpochParams],
    legacy_segments: list[tuple[int, int, int]],
    parts: _PartSnapshot | None = None,
    *,
    epoch_maps: dict[str, dict[int, EpochParams]] | None = None,
) -> Iterator[tuple[list[FinalizedColumn], dict[int, EpochParams]]]:
    """Newest immutable part wins; rows stream in byte-bounded source batches.

    Scoped UUIDs are authoritative. Unscoped files may donate columns only
    from a successfully preloaded legacy cadence, with its exact known epoch.
    A cold run with a reused sequence is never joined to the live timeline.
    """
    if not root._enabled or not ranges:
        return
    directory = root._symbol_dir(market, symbol)
    if not directory.is_dir():
        return
    if parts is None:
        parts = []
        warm_part_index(root, market, symbol, parts=parts)
    if epoch_maps is None:
        epoch_maps = _recording_epochs(directory, recording_id, known_epochs, legacy_segments)
    for path, bounds in parts:
        if bounds is None or not any(
            low <= bounds[1] and high >= bounds[0] for low, high in ranges
        ):
            continue
        allowed = [recording_id or ""]
        if legacy_segments and "" not in allowed:
            allowed.append("")
        if not any(identity in allowed for identity in bounds[2]):
            continue
        try:
            schema = pl.read_parquet_schema(path)
            if "recording_id" not in schema:
                if recording_id and not legacy_segments:
                    continue
                identity_expr = pl.lit("")
            else:
                identity_expr = pl.col("recording_id").fill_null("")
            range_expr = pl.lit(False)
            for low, high in ranges:
                range_expr |= pl.col("col_seq").is_between(low, high)
            rows_hint = max(
                [e.rows for mapping in epoch_maps.values() for e in mapping.values()] or [4096]
            )
            batch_size = max(1, min(SOURCE_BATCH_COLS, (2 * 1024 * 1024) // (rows_hint * 8)))
            if bounds[3] <= batch_size:
                # Production flushes have <=64 source columns. Reading that
                # one bounded part directly avoids several lazy-engine jobs
                # and never incurs the large-part whole-file memory problem.
                table = _read_parquet_safe(path)
                if table is not None:
                    table = table.filter(range_expr & identity_expr.is_in(allowed))
                    table = table.unique(
                        subset=["col_seq", "t0_ns"], keep="last", maintain_order=True
                    )
                    yield from _validated_chunks(table, epoch_maps, legacy_segments, root)
                continue
            # Sort scalar identity only. Sorting a large density part before
            # slicing can otherwise retain all its list arrays in memory.
            scalar_names = ["epoch", "col_seq", "t0_ns"]
            if "recording_id" in schema:
                scalar_names.append("recording_id")
            scalars = pl.scan_parquet(path).select(scalar_names).filter(range_expr)
            scalars = (
                scalars.filter(identity_expr.is_in(allowed))
                .sort(["col_seq", "t0_ns"], descending=True)
                .unique(subset=["col_seq", "t0_ns"], keep="first", maintain_order=True)
                .collect(engine="streaming")
            )
            # A density batch is at most ~2 MiB on the production 4096-row
            # grid. Even a very large legacy part is never collected whole.
            offset = 0
            while offset < scalars.height:
                identities = scalars.slice(offset, batch_size)
                # Exact sequence/time pairs prevent another same-ID cadence
                # with reused sequence numbers donating a false timestamp.
                wanted = pl.struct(["col_seq", "t0_ns"]).is_in(
                    identities.select(["col_seq", "t0_ns"]).to_struct("").implode()
                )
                table = (
                    pl.scan_parquet(path)
                    .filter(wanted & identity_expr.is_in(allowed))
                    .collect(engine="streaming")
                )
                table = table.unique(
                    subset=[
                        "col_seq",
                        "t0_ns",
                        *(["recording_id"] if "recording_id" in schema else []),
                    ],
                    keep="last",
                    maintain_order=True,
                )
                offset += identities.height
                yield from _validated_chunks(table, epoch_maps, legacy_segments, root)
        except (pl.exceptions.PolarsError, OSError, ValueError, TypeError) as exc:
            logger.warning("overview skips unusable recording part %s: %s", path, exc)


def add_recording(
    builder: OverviewBuilder,
    root: Recorder,
    market: str,
    symbol: str,
    recording_id: str | None,
    known_epochs: dict[int, EpochParams],
    legacy_segments: list[tuple[int, int, int]],
    parts: _PartSnapshot | None = None,
) -> None:
    from flowmap_server.core.pyramid import pyramid_for

    if parts is None:
        parts = []
        warm_part_index(root, market, symbol, parts=parts)
    store = pyramid_for(root, market, symbol, recording_id)
    mappings = store.epoch_maps(
        known_epochs, legacy_segments, stamps=getattr(parts, "epoch_stamps", None)
    )
    store.add_available(builder, mappings.get(recording_id or "", {}), parts)
    if not builder.missing_source_ranges():
        return
    for columns, epochs in recorded_batches(
        root,
        market,
        symbol,
        builder.missing_source_ranges(),
        recording_id,
        known_epochs,
        legacy_segments,
        parts,
    ):
        builder.add(columns, epochs)
