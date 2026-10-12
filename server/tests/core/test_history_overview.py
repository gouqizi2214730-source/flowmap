"""Time overview covers genuine density far beyond a native GPU/RAM window."""

from __future__ import annotations

import asyncio
import json
import threading

import msgspec
import numpy as np
import polars as pl
import pytest

from flowmap_server.core.grid import FinalizedColumn, Grid, GridCfg
from flowmap_server.core.overview import (
    GAP_MARKER_PREFIX,
    MAX_COARSE_RANGES,
    MAX_GAP_MARKERS,
    RESOLUTION_MARKER_PREFIX,
    OverviewBuilder,
    OverviewCache,
    _bounded_coarse_ranges,
    native_group_epochs,
    recorded_batches,
    warm_part_index,
)
from flowmap_server.core.record import Recorder
from flowmap_server.core.session import Session
from flowmap_server.proto import events, wire

DT = 250_000_000
START = 1_000_000_000_000


class Feed:
    market = "sim"
    symbol = "OVERVIEW"
    capability = {"depth": "L2"}


def epoch(rows=8, p0=98.0, index=0):
    return events.EpochParams(epoch=index, tick=0.5, tick_multiple=1, dt_ns=DT, p0=p0, rows=rows)


def column(seq, params, size=None, t0=None):
    quantity = float(seq % 11 + 1) if size is None else size
    bid = np.zeros(params.rows, dtype=np.float32)
    ask = np.zeros(params.rows, dtype=np.float32)
    bid[4] = quantity
    ask[5] = quantity * 2
    time = START + seq * DT if t0 is None else t0
    bar = events.BarColumn(
        epoch=params.epoch,
        col_seq=seq,
        t0_ns=time,
        o=100 + seq,
        h=102 + seq,
        l=99 + seq,
        c=101 + seq,
        vol_buy=2,
        vol_sell=1,
        cvd_cum=seq + 1,
        vwap_num_cum=100 * (seq + 1),
        vwap_den_cum=seq + 1,
    )
    return FinalizedColumn(epoch=params.epoch, col_seq=seq, t0_ns=time, bid=bid, ask=ask, bar=bar)


def grid_for(params, columns, ring=4):
    grid = Grid(
        GridCfg(
            tick=params.tick,
            tick_multiple=params.tick_multiple,
            dt_ns=params.dt_ns,
            p0=params.p0,
            rows=params.rows,
            ring_columns=ring,
            mode=events.MODE_L2,
        )
    )
    grid.preload(columns[-ring:], [params])
    return grid


def response(frame):
    messages = []
    offset = 0
    while offset < len(frame):
        event, offset = wire.decode(frame, offset)
        messages.append(event)
    assert isinstance(messages[0], events.EpochStart)
    assert isinstance(messages[-1], events.HistoryResponse)
    return messages[-1]


def request(start, end, stride, count=256, req=31):
    return events.HistoryRequest(
        req_id=req, before_t=2**63 - 1, n_cols=count, start_col=start, end_col=end, stride=stride
    )


def record(root, params, columns, part_rows=64):
    writer = root.open_session(Feed.market, Feed.symbol)
    writer.record_epoch(params)
    for i, col in enumerate(columns):
        writer.record_column(col)
        if (i + 1) % part_rows == 0:
            writer.flush()
    writer.flush()
    return writer


def test_old_history_wire_is_byte_identical_and_new_fields_round_trip():
    old = events.HistoryRequest(req_id=7, before_t=111, n_cols=64)
    assert msgspec.json.encode(old) == b'{"req_id":7,"before_t":111,"n_cols":64}'
    new = request(128, 65535, 256)
    decoded, _ = wire.decode(wire.encode(new))
    assert decoded == new


async def test_wide_overview_reads_all_partitions_and_preserves_genuine_old_density(tmp_path):
    params = epoch()
    # More than 32,768 native source columns and >16 part files. The count
    # still bounds only the 10 output bins, never truncates source depth.
    columns = [column(i, params) for i in range(40960)]
    root = Recorder(tmp_path, 1.0)
    writer = record(root, params, columns, part_rows=2048)
    grid = grid_for(params, columns)
    session = Session("wide", feed=Feed(), grid=grid, recorder=root)
    session._rec = writer
    reply = response(await session.handle_history_async(request(0, 40959, 4096)))
    assert [c.col_seq for c in reply.depth_cols] == list(range(0, 40960, 4096))
    for i, depth in enumerate(reply.depth_cols):
        source = columns[i * 4096 : (i + 1) * 4096]
        np.testing.assert_allclose(depth.bid[4], np.mean([c.bid[4] for c in source]), rtol=1e-6)
        assert depth.bid.sum() > 0, "old depth must not be fabricated from trades"
        bar = reply.bar_cols[i]
        assert bar.vol_buy == 8192 and bar.vol_sell == 4096
        assert bar.o == source[0].bar.o and bar.c == source[-1].bar.c
        assert bar.h == source[-1].bar.h and bar.l == source[0].bar.l
        assert bar.cvd_cum == source[-1].bar.cvd_cum
        assert bar.vwap_den_cum == source[-1].bar.vwap_den_cum
        assert depth.t0_ns == source[0].t0_ns
    assert session._overview_cache.bytes <= 32 * 1024 * 1024


async def test_output_pages_align_absolute_groups_without_permanent_source_truncation(tmp_path):
    params = epoch()
    columns = [column(i, params) for i in range(600)]
    root = Recorder(tmp_path, 1.0)
    writer = record(root, params, columns)
    session = Session("pages", feed=Feed(), grid=grid_for(params, columns), recorder=root)
    session._rec = writer
    first = response(await session.handle_history_async(request(0, 599, 100, count=2)))
    second = response(await session.handle_history_async(request(200, 599, 100, count=2)))
    final = response(await session.handle_history_async(request(400, 599, 100, count=2)))
    assert [c.col_seq for r in [first, second, final] for c in r.depth_cols] == list(
        range(0, 600, 100)
    )
    assert all(b.vol_buy == 200 for r in [first, second, final] for b in r.bar_cols)


async def test_cached_immutable_bins_do_not_repeat_disk_and_partial_tail_refreshes(
    tmp_path, monkeypatch
):
    params = epoch()
    columns = [column(i, params) for i in range(13)]
    root = Recorder(tmp_path, 1.0)
    writer = record(root, params, columns)
    grid = grid_for(params, columns)
    session = Session("cache", feed=Feed(), grid=grid, recorder=root)
    session._rec = writer
    first = response(await session.handle_history_async(request(0, 7, 4)))
    assert [c.col_seq for c in first.depth_cols] == [0, 4]

    def forbidden(*args, **kwargs):
        raise AssertionError("immutable overview must reuse its cached real bins")

    monkeypatch.setattr("flowmap_server.core.session.add_recording", forbidden)
    second = response(await session.handle_history_async(request(0, 7, 4)))
    np.testing.assert_array_equal(first.depth_cols[0].bid, second.depth_cols[0].bid)
    tail = response(await session.handle_history_async(request(12, 15, 4)))
    assert tail.bar_cols[0].vol_buy == 2
    # Complete the same final group. It must not retain the one-source average.
    for i in range(13, 17):
        grid.on_book(
            START + i * DT, np.array([100.0]), np.array([20.0]), np.array([100.5]), np.array([20.0])
        )
        if i < 16:
            grid.on_trade(START + i * DT + 1, 100.0, 2.0, events.SIDE_BUY)
            grid.on_trade(START + i * DT + 2, 100.0, 1.0, events.SIDE_SELL)
    last = response(await session.handle_history_async(request(12, 15, 4)))
    assert last.bar_cols[0].vol_buy == 8
    assert last.depth_cols[0].bid[4] == pytest.approx((columns[12].bid[4] + 60) / 4)


async def test_other_recording_identity_cannot_donate_same_numbered_depth(tmp_path):
    params = epoch()
    columns = [column(i, params) for i in range(12)]
    root = Recorder(tmp_path, 1.0)
    record(root, params, [column(i, params, size=999) for i in range(12)])
    session = Session("foreign", feed=Feed(), grid=grid_for(params, columns), recorder=root)
    session._rec = root.open_session(Feed.market, Feed.symbol)
    reply = response(await session.handle_history_async(request(0, 7, 4)))
    assert reply.depth_cols == reply.bar_cols == []


def test_epoch_projection_keeps_real_price_and_conserves_overlapping_quantity():
    old, current = epoch(), epoch(p0=97.5, index=1)
    cache = OverviewCache()
    builder = OverviewBuilder(current, 0, 1, 2, 2**63 - 1, 1, cache)
    before = column(0, old, size=10)
    after = column(1, current, size=10)
    # Both source columns carry the identical $100 bid wall under different
    # row origins. Same-index accumulation would create a false second wall.
    after.bid[:] = 0
    after.bid[5] = 10
    builder.add([before, after], {0: old, 1: current})
    result = builder.finish()[0]
    assert result.epoch == 1
    assert result.bid[5] == 10 and result.bid[4] == 0
    assert result.bid.sum() == 10


def test_reprojection_distributes_coarse_bucket_by_real_price_overlap():
    old = epoch(rows=8)
    current = epoch(rows=16, p0=98)
    current = msgspec.structs.replace(current, tick=0.25)
    builder = OverviewBuilder(current, 0, 0, 1, 2**63 - 1, 0, OverviewCache())
    builder.add([column(0, old, size=12)], {0: old})
    out = builder.finish()[0]
    # One source half-dollar bin spans two full quarter-dollar target bins
    # plus two half bins because row quantities are centred on their price.
    assert out.bid.sum() == pytest.approx(12)
    assert np.count_nonzero(out.bid) == 3


async def test_overview_disk_and_aggregation_do_not_block_live_feed(tmp_path, monkeypatch):
    params = epoch()
    columns = [column(i, params) for i in range(20)]
    root = Recorder(tmp_path, 1.0)
    writer = record(root, params, columns)
    grid = grid_for(params, columns)
    session = Session("off-loop", feed=Feed(), grid=grid, recorder=root)
    session._rec = writer
    started, release = threading.Event(), threading.Event()
    real = __import__("flowmap_server.core.overview", fromlist=["add_recording"]).add_recording
    loop_thread = threading.get_ident()

    def blocked(*args):
        assert threading.get_ident() != loop_thread
        started.set()
        assert release.wait(timeout=5)
        return real(*args)

    monkeypatch.setattr("flowmap_server.core.session.add_recording", blocked)
    task = asyncio.create_task(session.handle_history_async(request(0, 19, 5)))
    try:
        assert await asyncio.to_thread(started.wait, 5)
        # Work on the mutable live grid remains on the loop and proceeds while
        # disk IO waits. This would deadlock if aggregation ran on that loop.
        grid.on_book(
            START + 21 * DT, np.array([100.0]), np.array([5.0]), np.array([100.5]), np.array([5.0])
        )
        await asyncio.sleep(0)
        assert not task.done()
    finally:
        release.set()
    assert len(response(await task).depth_cols) == 4


def test_source_batches_remain_bounded_even_inside_one_large_part(tmp_path):
    params = epoch(rows=64)
    columns = [column(i, params) for i in range(270)]
    root = Recorder(tmp_path, 1.0)
    writer = record(root, params, columns, part_rows=1000)
    batches = list(
        recorded_batches(
            root, Feed.market, Feed.symbol, [(0, 269)], writer.recording_id, {0: params}, []
        )
    )
    assert sum(len(cols) for cols, _ in batches) == 270
    assert max(len(cols) for cols, _ in batches) <= 64


def test_lru_is_bounded_and_duplicate_source_cannot_double_mean_or_volume():
    params = epoch()
    cache = OverviewCache(byte_limit=800)
    builder = OverviewBuilder(params, 0, 7, 2, 2**63 - 1, 7, cache)
    cols = [column(i, params) for i in range(8)]
    builder.add(cols, {0: params})
    builder.add(cols, {0: params})
    out = builder.finish()
    assert all(c.bar.vol_buy == 4 for c in out)
    assert cache.bytes <= 800


def test_proven_legacy_only_matches_exact_sequence_time_and_geometry(tmp_path):
    params = epoch()
    cols = [column(i, params) for i in range(12)]
    root = Recorder(tmp_path, 1.0)
    record(root, params, cols)
    for path in tmp_path.rglob("*.parquet"):
        table = pl.read_parquet(path)
        table.drop("recording_id").write_parquet(path)
    valid = list(
        recorded_batches(
            root, Feed.market, Feed.symbol, [(0, 7)], "new-id", {0: params}, [(START, 0, 11)]
        )
    )
    assert sum(len(c) for c, _ in valid) == 8
    foreign = list(
        recorded_batches(
            root,
            Feed.market,
            Feed.symbol,
            [(0, 7)],
            "new-id",
            {0: params},
            [(START - 100 * DT, 0, 11)],
        )
    )
    assert foreign == []


def test_persisted_scalar_index_reuses_metadata_and_validates_replaced_parts(tmp_path, monkeypatch):
    params = epoch()
    cols = [column(i, params) for i in range(12)]
    root = Recorder(tmp_path, 1.0)
    writer = record(root, params, cols)
    warm_part_index(root, Feed.market, Feed.symbol)
    directory = root._symbol_dir(Feed.market, Feed.symbol)
    index = directory / ".flowmap-overview-index.json"
    assert index.is_file()

    from flowmap_server.core import overview

    real = overview._read_parquet_safe

    def forbid_scalar_read(path, *, columns=None):
        assert columns is None, "unchanged scalar metadata must come from validated index"
        return real(path, columns=columns)

    monkeypatch.setattr(overview, "_read_parquet_safe", forbid_scalar_read)
    reused = Recorder(tmp_path, 1.0)
    warm_part_index(reused, Feed.market, Feed.symbol)
    batches = list(
        recorded_batches(
            reused, Feed.market, Feed.symbol, [(0, 7)], writer.recording_id, {0: params}, []
        )
    )
    assert sum(len(batch) for batch, _ in batches) == 8
    monkeypatch.undo()

    # A stale/custom cache file cannot override a replaced authoritative part.
    path = next(directory.glob("*-columns-*.parquet"))
    table = pl.read_parquet(path).with_columns((pl.col("col_seq") + 100).alias("col_seq"))
    table.write_parquet(path)
    fresh = Recorder(tmp_path, 1.0)
    warm_part_index(fresh, Feed.market, Feed.symbol)
    assert (
        list(
            recorded_batches(
                fresh, Feed.market, Feed.symbol, [(0, 7)], writer.recording_id, {0: params}, []
            )
        )
        == []
    )


def test_index_cancel_does_not_read_density_or_claim_complete_warmup(tmp_path):
    params = epoch()
    root = Recorder(tmp_path, 1.0)
    record(root, params, [column(i, params) for i in range(12)])
    warm_part_index(root, Feed.market, Feed.symbol, stop=lambda: True)
    directory = root._symbol_dir(Feed.market, Feed.symbol)
    assert not (directory / ".flowmap-overview-index.json").exists()
    assert directory not in root._overview_warmed


def test_finalized_prefix_refresh_is_weighted_exactly_once_and_keeps_real_time_knots():
    fast = epoch()
    slow = msgspec.structs.replace(fast, epoch=1, dt_ns=2 * DT)
    a, b = column(0, fast, size=10, t0=0), column(1, slow, size=30, t0=700 * DT)
    cache = OverviewCache()
    initial = OverviewBuilder(slow, 0, 1, 4, 2**63 - 1, 1, cache)
    initial.add([a, b], {0: fast, 1: slow})
    first = initial.finish()[0]
    assert first.bid[4] == pytest.approx((10 + 2 * 30) / 3)
    assert first.t0_ns == 0 and initial.last_time == 700 * DT
    assert [json.loads(m.text.removeprefix(GAP_MARKER_PREFIX)) for m in initial.gap_markers()] == [
        {
            "left_col": 0,
            "right_col": 1,
            "left_t0_ns": "0",
            "left_end_t_ns": str(DT),
            "right_t0_ns": str(700 * DT),
        }
    ]

    c = column(2, fast, size=50, t0=1500 * DT)
    refreshed = OverviewBuilder(slow, 0, 2, 4, 2**63 - 1, 2, cache)
    refreshed.add([a, b, c, c], {0: fast, 1: slow})
    out = refreshed.finish()[0]
    assert out.bid[4] == pytest.approx((10 + 2 * 30 + 50) / 4)
    assert out.ask[5] == pytest.approx(2 * (10 + 2 * 30 + 50) / 4)
    assert out.bar.vol_buy == 6 and out.bar.vol_sell == 3
    assert out.bar.o == a.bar.o and out.bar.c == c.bar.c
    assert out.t0_ns == 0 and refreshed.last_time == 1500 * DT
    cached = OverviewBuilder(slow, 0, 2, 4, 2**63 - 1, 2, cache)
    assert cached.missing_source_ranges() == []
    assert cached.first_time == 0 and cached.last_time == 1500 * DT
    gaps = [json.loads(m.text.removeprefix(GAP_MARKER_PREFIX)) for m in cached.gap_markers()]
    assert [(g["left_col"], g["right_col"]) for g in gaps] == [(0, 1), (1, 2)]
    assert gaps[1]["left_t0_ns"] == str(700 * DT)
    assert gaps[1]["left_end_t_ns"] == str(702 * DT), (
        "use source epoch duration, not current target cadence"
    )


async def test_inside_bin_disk_page_seams_preserve_exact_timestamps_and_survive_cache(
    tmp_path, monkeypatch
):
    params = epoch()
    # Two genuine restart seams lie inside the first 128-source bin and one
    # coincides with a 64-source disk partition boundary. Process newest parts
    # first, so endpoint stitching must work in both temporal directions.
    cols = [
        column(
            i,
            params,
            t0=START + i * DT + (30 * DT if i >= 23 else 0) + (100 * DT if i >= 64 else 0),
        )
        for i in range(140)
    ]
    root = Recorder(tmp_path, 1.0)
    writer = record(root, params, cols)
    session = Session("seams", feed=Feed(), grid=grid_for(params, cols), recorder=root)
    session._rec = writer
    first = response(await session.handle_history_async(request(0, 139, 128)))
    internal = [m for m in first.markers if m.text.startswith(GAP_MARKER_PREFIX)]
    assert [m.ts_ns for m in internal] == [cols[23].t0_ns, cols[64].t0_ns]
    metadata = [json.loads(m.text.removeprefix(GAP_MARKER_PREFIX)) for m in internal]
    assert [(g["left_col"], g["right_col"]) for g in metadata] == [(22, 23), (63, 64)]
    for gap in metadata:
        left, right = cols[gap["left_col"]], cols[gap["right_col"]]
        assert gap["left_t0_ns"] == str(left.t0_ns)
        assert gap["left_end_t_ns"] == str(left.t0_ns + DT)
        assert gap["right_t0_ns"] == str(right.t0_ns)
    # Offline wall-clock time adds neither fabricated resting density nor
    # trade volume to the integrated average.
    assert first.depth_cols[0].bid[4] == pytest.approx(np.mean([c.bid[4] for c in cols[:128]]))
    assert first.bar_cols[0].vol_buy == 256

    def forbidden(*args, **kwargs):
        raise AssertionError("seam metadata must survive cached output without disk reads")

    monkeypatch.setattr("flowmap_server.core.session.add_recording", forbidden)
    cached = response(await session.handle_history_async(request(0, 139, 128)))
    assert [m for m in cached.markers if m.text.startswith(GAP_MARKER_PREFIX)] == internal


def test_gap_metadata_retains_all_seams_and_incomplete_source_does_not_invent_a_seam():
    params = epoch()
    builder = OverviewBuilder(
        params,
        0,
        MAX_GAP_MARKERS + 5,
        MAX_GAP_MARKERS + 6,
        2**63 - 1,
        MAX_GAP_MARKERS + 5,
        OverviewCache(),
    )
    builder.add(
        [column(i, params, t0=START + i * 100 * DT) for i in range(MAX_GAP_MARKERS + 6)],
        {0: params},
    )
    assert len(builder.gap_markers()) == MAX_GAP_MARKERS + 5
    missing = OverviewBuilder(params, 0, 2, 3, 2**63 - 1, 2, OverviewCache())
    missing.add([column(0, params), column(2, params, t0=START + 100 * DT)], {0: params})
    assert missing.gap_markers() == [], (
        "only adjacent genuine source columns prove a recording seam"
    )


async def test_old_hybrid_groups_keep_native_fine_levels_and_publish_all_epoch_maps(
    tmp_path, monkeypatch
):
    from flowmap_server.core.price_scale import epoch_scale_fields, make_hybrid

    def hybrid(mid, index):
        scale = make_hybrid(mid, 4096, 2048, 0.5, 11, 0.01)
        assert scale is not None
        params = events.EpochParams(
            epoch=index,
            tick=0.01,
            tick_multiple=50,
            dt_ns=DT,
            p0=scale.core_p0,
            rows=4096,
            **epoch_scale_fields(scale),
        )
        return params, scale

    old, old_scale = hybrid(82916, 0)
    current, current_scale = hybrid(81812, 1)
    cols = []
    for seq in range(8):
        params, scale = (old, old_scale) if seq < 4 else (current, current_scale)
        col = column(seq, params)
        center = scale.dn_rows + scale.core_rows // 2
        col.bid[:] = col.ask[:] = 0
        col.bid[center - np.arange(8)] = np.arange(1, 9)
        col.ask[center + 1 + np.arange(8)] = np.arange(2, 10)
        cols.append(col)
    root = Recorder(tmp_path, 1.0)
    writer = root.open_session(Feed.market, Feed.symbol)
    writer.record_epoch(old)
    writer.record_epoch(current)
    for col in cols:
        writer.record_column(col)
    writer.flush()
    grid = Grid(
        GridCfg(
            tick=0.01,
            tick_multiple=50,
            dt_ns=DT,
            p0=current.p0,
            rows=4096,
            ring_columns=4,
            mode=events.MODE_L2,
            band_up=10,
            band_down=0.99,
            band_hybrid=True,
            core_rows=2048,
        )
    )
    grid.preload(cols[4:], [old, current])
    session = Session("native-epochs", feed=Feed(), grid=grid, recorder=root)
    session._rec = writer
    frame = await session.handle_history_async(request(0, 7, 4))
    messages, offset = [], 0
    while offset < len(frame):
        event, offset = wire.decode(frame, offset)
        messages.append(event)
    reply = messages[-1]
    assert [c.epoch for c in reply.depth_cols] == [old.epoch, current.epoch]
    announced = {e.epoch: e.epoch_params for e in messages[:-1]}
    assert announced == {old.epoch: old, current.epoch: current}
    assert reply.epoch == current.epoch  # request/session identity remains current
    for index, depth in enumerate(reply.depth_cols):
        expected = cols[index * 4]
        np.testing.assert_array_equal(depth.bid, expected.bid)
        np.testing.assert_array_equal(depth.ask, expected.ask)
        assert np.count_nonzero(depth.bid) == np.count_nonzero(depth.ask) == 8
        assert depth.bid.sum() == 36 and depth.ask.sum() == 44
        assert reply.bar_cols[index].epoch == depth.epoch
        assert depth.col_seq == index * 4 and depth.t0_ns == expected.t0_ns

    # A later live core cannot invalidate or reproject immutable old groups.
    rolled = grid.maybe_reanchor(88000)
    assert rolled is not None

    def forbidden(*args, **kwargs):
        raise AssertionError("completed native groups must not repeat scalar or density disk reads")

    monkeypatch.setattr("flowmap_server.core.session.add_recording", forbidden)
    monkeypatch.setattr(pl, "scan_parquet", forbidden)
    cached = response(await session.handle_history_async(request(0, 7, 4)))
    assert [c.epoch for c in cached.depth_cols] == [old.epoch, current.epoch]
    assert cached.epoch == rolled.epoch
    np.testing.assert_array_equal(cached.depth_cols[0].bid, reply.depth_cols[0].bid)
    assert session._overview_cache.bytes <= 32 * 1024 * 1024


def test_native_representative_is_group_midpoint_and_partial_cache_rebuilds_when_it_changes():
    old, current = epoch(index=0), epoch(index=1, p0=97.5)
    cols = [column(seq, old if seq < 2 else current, size=10) for seq in range(8)]
    # Same real price under both epochs.
    for col in cols[2:]:
        col.bid[:] = 0
        col.bid[5] = 10
    epochs = {0: old, 1: current}
    cache = OverviewCache()
    refs = [(c.col_seq, c.t0_ns, c.epoch) for c in cols]
    first_targets = native_group_epochs(
        current, 0, 1, 8, 2**63 - 1, cache, refs[:2], None, "", "", None, epochs, []
    )
    assert first_targets == {0: old}
    first = OverviewBuilder(current, 0, 1, 8, 2**63 - 1, 1, cache, group_targets=first_targets)
    first.add(cols[:2], epochs)
    assert first.finish()[0].epoch == old.epoch
    targets = native_group_epochs(
        current, 0, 7, 8, 2**63 - 1, cache, list(reversed(refs)), None, "", "", None, epochs, []
    )
    assert targets == {0: current}
    full = OverviewBuilder(current, 0, 7, 8, 2**63 - 1, 7, cache, group_targets=targets)
    assert full.missing_source_ranges() == [(0, 7)]
    full.add(list(reversed(cols)), epochs)
    output = full.finish()[0]
    assert output.epoch == current.epoch
    assert output.bid[5] == 10 and output.bid.sum() == 10
    assert output.bar.vol_buy == 16 and output.t0_ns == cols[0].t0_ns
    assert full.output_epochs == {current.epoch: current}


def test_native_midpoint_projection_conserves_quantity_when_source_epochs_cross_inside_group():
    old, current = epoch(index=0), epoch(index=1, p0=97.5)
    cols = [column(seq, old if seq < 4 else current, size=12) for seq in range(8)]
    epochs = {0: old, 1: current}
    targets = native_group_epochs(
        current,
        0,
        7,
        8,
        2**63 - 1,
        OverviewCache(),
        [(c.col_seq, c.t0_ns, c.epoch) for c in cols],
        None,
        "",
        "",
        None,
        epochs,
        [],
    )
    assert targets == {0: old}  # midpoint tie chooses lower genuine sequence
    builder = OverviewBuilder(
        current, 0, 7, 8, 2**63 - 1, 7, OverviewCache(), group_targets=targets
    )
    builder.add(cols[:4], epochs)
    builder.add(cols[4:], epochs)
    output = builder.finish()[0]
    assert output.epoch == old.epoch
    assert output.bid.sum() == 12 and output.ask.sum() == 24
    assert output.bid[3] == output.bid[4] == 6
    assert output.col_seq == 0 and output.t0_ns == cols[0].t0_ns


def test_many_rolling_epoch_projection_plans_stay_bounded():
    target = epoch(rows=8)
    builder = OverviewBuilder(target, 0, 79, 80, 2**63 - 1, 79, OverviewCache())
    for seq in range(80):
        source = epoch(rows=8, p0=98 - seq * 0.001, index=seq + 1)
        builder.add([column(seq, source)], {source.epoch: source})
    assert len(builder._projection) <= 32


def mixed_btc_resolution_fixture():
    from flowmap_server.core.price_scale import (
        epoch_scale_fields,
        make_hybrid,
        price_to_row,
        scale_of,
    )

    params = []
    for mid, index in [(82916.0, 1), (81712.0, 2)]:
        scale = make_hybrid(mid, 4096, 2048, 0.5, 11, 0.01)
        assert scale is not None
        params.append(
            events.EpochParams(
                epoch=index,
                tick=0.01,
                tick_multiple=50,
                dt_ns=DT,
                p0=scale.core_p0,
                rows=4096,
                **epoch_scale_fields(scale),
            )
        )
    old, current = params
    columns = []
    for seq in range(16):
        source, quantity = (old, 1000) if seq < 4 else (current, 1)
        col = column(seq, source)
        col.bid[:] = col.ask[:] = 0
        row = round(price_to_row(scale_of(source), 81776.4))
        col.bid[row] = quantity
        columns.append(col)
    return old, current, columns


def test_resolution_marker_preserves_coarse_source_interval_and_prefix_cache():
    from flowmap_server.core.price_scale import row_to_price, scale_of

    old, current, cols = mixed_btc_resolution_fixture()
    epochs = {old.epoch: old, current.epoch: current}
    cache = OverviewCache()
    # A cached coarse prefix already interpreted in the chosen fine map must
    # retain its provenance when the real fine sources extend that group.
    prefix = OverviewBuilder(current, 0, 3, 16, 2**63 - 1, 15, cache, group_targets={0: current})
    prefix.add(cols[:4], epochs)
    prefix.finish()
    complete = OverviewBuilder(current, 0, 15, 16, 2**63 - 1, 15, cache, group_targets={0: current})
    assert complete.missing_source_ranges() == [(4, 15)]
    complete.add(cols[4:], epochs)
    output = complete.finish()[0]
    assert output.epoch == current.epoch
    assert np.count_nonzero(output.bid) == 560
    assert output.bid.sum(dtype=np.float64) == pytest.approx(250.75, abs=1e-5)
    marker = complete.resolution_markers()[0]
    assert marker.kind == "info" and marker.ts_ns == cols[0].t0_ns
    metadata = json.loads(marker.text.removeprefix(RESOLUTION_MARKER_PREFIX))
    assert {key: metadata[key] for key in ["col_seq", "epoch", "stride", "t0_ns"]} == {
        "col_seq": 0,
        "epoch": current.epoch,
        "stride": 16,
        "t0_ns": str(cols[0].t0_ns),
    }
    source = scale_of(old)
    row = int(np.flatnonzero(cols[0].bid)[0])
    low, high = row_to_price(source, row - 0.5), row_to_price(source, row + 0.5)
    assert metadata["ranges"] == [[low, high, high - low]]
    assert high - low == pytest.approx(279.4321526, abs=0.0001)
    reused = OverviewBuilder(current, 0, 15, 16, 2**63 - 1, 15, cache, group_targets={0: current})
    reused.finish()
    assert reused.resolution_markers() == complete.resolution_markers()


def test_coarse_resolution_ranges_preserve_disjoint_gaps_and_exact_width_segments():
    original = [(float(index * 10), float(index * 10 + 1), float(index + 2)) for index in range(20)]
    result = _bounded_coarse_ranges(original)
    assert len(result) == len(original) > MAX_COARSE_RANGES
    assert all(
        any(left <= low and right >= high and maximum >= width for left, right, maximum in result)
        for low, high, width in original
    )
    assert _bounded_coarse_ranges([(1, 4, 3), (3, 5, 7), (5, 8, 5)]) == (
        (1.0, 3.0, 3.0),
        (3.0, 5.0, 7.0),
        (5.0, 8.0, 5.0),
    )


async def test_mixed_native_group_sends_physical_resolution_metadata_and_reuses_it(
    tmp_path, monkeypatch
):
    old, current, cols = mixed_btc_resolution_fixture()
    root = Recorder(tmp_path, 1.0)
    writer = root.open_session(Feed.market, Feed.symbol)
    writer.record_epoch(old)
    writer.record_epoch(current)
    for col in cols:
        writer.record_column(col)
    writer.flush()
    grid = Grid(
        GridCfg(
            tick=0.01,
            tick_multiple=50,
            dt_ns=DT,
            p0=current.p0,
            rows=4096,
            ring_columns=4,
            mode=events.MODE_L2,
            band_up=10,
            band_down=0.99,
            band_hybrid=True,
            core_rows=2048,
        )
    )
    grid.preload(cols[-4:], [old, current])
    session = Session("resolution-provenance", feed=Feed(), grid=grid, recorder=root)
    session._rec = writer
    reply = response(await session.handle_history_async(request(0, 15, 16)))
    assert reply.depth_cols[0].bid.sum(dtype=np.float64) == pytest.approx(250.75, abs=1e-5)
    assert reply.depth_cols[0].epoch == current.epoch
    provenance = [m for m in reply.markers if m.text.startswith(RESOLUTION_MARKER_PREFIX)]
    assert len(provenance) == 1
    assert len(json.loads(provenance[0].text.removeprefix(RESOLUTION_MARKER_PREFIX))["ranges"]) == 1

    def forbidden(*args, **kwargs):
        raise AssertionError("completed provenance must survive with no source rereads")

    monkeypatch.setattr("flowmap_server.core.session.add_recording", forbidden)
    monkeypatch.setattr(pl, "scan_parquet", forbidden)
    grid.maybe_reanchor(88000)
    cached = response(await session.handle_history_async(request(0, 15, 16)))
    assert cached.markers == reply.markers
    np.testing.assert_array_equal(cached.depth_cols[0].bid, reply.depth_cols[0].bid)


def test_same_map_and_inactive_coarse_sources_do_not_claim_extra_uncertainty():
    old, current, cols = mixed_btc_resolution_fixture()
    epochs = {old.epoch: old, current.epoch: current}
    native = OverviewBuilder(
        current, 4, 15, 16, 2**63 - 1, 15, OverviewCache(), group_targets={0: current}
    )
    native.add(cols[4:], epochs)
    native.finish()
    assert native.resolution_markers() == []
    for col in cols[:4]:
        col.bid[:] = 0
    mixed = OverviewBuilder(
        current, 0, 15, 16, 2**63 - 1, 15, OverviewCache(), group_targets={0: current}
    )
    mixed.add(cols, epochs)
    mixed.finish()
    assert mixed.resolution_markers() == []


def test_request_part_snapshot_is_shared_and_fresh_windows_metadata_validates_replacements(
    tmp_path, monkeypatch
):
    from pathlib import Path
    from flowmap_server.core import overview

    params = epoch()
    root = Recorder(tmp_path, 1.0)
    writer = record(root, params, [column(seq, params) for seq in range(12)])
    directory = root._symbol_dir(Feed.market, Feed.symbol)
    path = next(directory.glob("*-columns-*.parquet"))
    bounds_calls = []
    actual_bounds, actual_stat = overview._part_bounds, Path.stat

    def counted_bounds(*args, **kwargs):
        bounds_calls.append(args[1])
        return actual_bounds(*args, **kwargs)

    def prohibit_column_handle_stat(self, *args, **kwargs):
        assert "-columns-" not in self.name, (
            "fresh DirEntry attributes must replace per-part Path.stat"
        )
        return actual_stat(self, *args, **kwargs)

    monkeypatch.setattr(overview, "_part_bounds", counted_bounds)
    monkeypatch.setattr(Path, "stat", prohibit_column_handle_stat)
    shared = []
    targets = native_group_epochs(
        params,
        0,
        7,
        4,
        2**63 - 1,
        OverviewCache(),
        [],
        root,
        Feed.market,
        Feed.symbol,
        writer.recording_id,
        {params.epoch: params},
        [],
        shared,
    )
    assert targets == {0: params, 4: params}
    assert bounds_calls == [path]
    batches = list(
        recorded_batches(
            root,
            Feed.market,
            Feed.symbol,
            [(0, 7)],
            writer.recording_id,
            {params.epoch: params},
            [],
            shared,
        )
    )
    assert sum(len(columns) for columns, _ in batches) == 8
    assert bounds_calls == [path], "density pass must reuse the request's validated part snapshot"

    # A later request must enumerate fresh size/mtime attributes, including
    # replacements and brand-new immutable parts after prewarm completed.
    table = pl.read_parquet(path).with_columns((pl.col("col_seq") + 100).alias("col_seq"))
    table.write_parquet(path)
    refreshed = []
    warm_part_index(root, Feed.market, Feed.symbol, parts=refreshed)
    assert (
        list(
            recorded_batches(
                root,
                Feed.market,
                Feed.symbol,
                [(0, 7)],
                writer.recording_id,
                {params.epoch: params},
                [],
                refreshed,
            )
        )
        == []
    )
    monkeypatch.setattr(
        Path, "stat", actual_stat
    )  # writer part claims legitimately stat their destination
    writer.record_column(column(12, params))
    writer.flush()
    monkeypatch.setattr(Path, "stat", prohibit_column_handle_stat)
    latest = []
    warm_part_index(root, Feed.market, Feed.symbol, parts=latest)
    new_batches = list(
        recorded_batches(
            root,
            Feed.market,
            Feed.symbol,
            [(12, 12)],
            writer.recording_id,
            {params.epoch: params},
            [],
            latest,
        )
    )
    assert [col.col_seq for columns, _ in new_batches for col in columns] == [12]
