"""Recorded depth beyond the RAM ring remains safe, bounded scroll-back."""

from __future__ import annotations

import asyncio
import threading

import numpy as np
import polars as pl
import pytest

from flowmap_server.core.grid import Grid, GridCfg
from flowmap_server.core.record import Recorder, TailData
from flowmap_server.core.session import HISTORY_MAX_COLS, Session
from flowmap_server.proto import events, wire

DT = 250_000_000
START = 1_000_000_000_000


class IdleFeed:
    market = "sim"
    symbol = "DISK-HISTORY"
    capability = {"depth": "L2"}


def _cfg(p0: float = 84.0) -> GridCfg:
    return GridCfg(
        tick=0.5, tick_multiple=1, dt_ns=DT, p0=p0,
        rows=64, ring_columns=4, mode=events.MODE_L2,
    )


def _book(grid: Grid, ts: int, size: float = 3.0):
    bid = np.array([99.5, 100.0])
    ask = np.array([100.5, 101.0])
    sizes = np.full(2, size)
    return grid.on_book(ts, bid, sizes, ask, sizes)


def _drive(grid: Grid, n: int = 12, start: int = START):
    _book(grid, start)
    cols = []
    for i in range(1, n + 1):
        cols.extend(_book(grid, start + i * DT, float(i)))
    return cols


def _record(root: Recorder, grid: Grid, cols):
    rec = root.open_session(IdleFeed.market, IdleFeed.symbol)
    for epoch in sorted({c.epoch for c in cols}):
        rec.record_epoch(grid.epoch_params_for(epoch))
    for col in cols:
        rec.record_column(col)
    rec.flush()
    return rec


def _response(frame: bytes) -> events.HistoryResponse:
    offset = 0
    messages = []
    while offset < len(frame):
        message, offset = wire.decode(frame, offset)
        messages.append(message)
    assert all(isinstance(m, events.EpochStart) for m in messages[:-1])
    assert isinstance(messages[-1], events.HistoryResponse)
    return messages[-1]


def _make_legacy(root_dir):
    for path in root_dir.rglob("*.parquet"):
        table = pl.read_parquet(path)
        if "recording_id" in table.columns:
            table.drop("recording_id").write_parquet(path)


async def test_evicted_recorded_columns_merge_with_ram_and_continue_to_start(tmp_path):
    root = Recorder(tmp_path, 1.0)
    grid = Grid(_cfg())
    all_cols = _drive(grid)
    sess = Session("disk", feed=IdleFeed(), grid=grid, recorder=root)
    sess._rec = _record(root, grid, all_cols)

    resp = _response(await sess.handle_history_async(
        events.HistoryRequest(req_id=5, before_t=START + 10 * DT, n_cols=6)
    ))
    assert resp.req_id == 5
    assert [d.col_seq for d in resp.depth_cols] == list(range(4, 10))
    assert [b.col_seq for b in resp.bar_cols] == list(range(4, 10))
    assert resp.oldest_available_t_ns == 0, "RAM cache edge must not stop scroll-back"
    np.testing.assert_array_equal(resp.depth_cols[0].bid, all_cols[4].bid)

    first = _response(await sess.handle_history_async(
        events.HistoryRequest(req_id=6, before_t=START + 4 * DT, n_cols=4)
    ))
    assert [d.col_seq for d in first.depth_cols] == [0, 1, 2, 3]
    empty = _response(await sess.handle_history_async(
        events.HistoryRequest(req_id=7, before_t=START, n_cols=4)
    ))
    assert empty.depth_cols == empty.bar_cols == []


async def test_ram_complete_page_avoids_disk_and_does_not_claim_ram_exhaustion(tmp_path, monkeypatch):
    root = Recorder(tmp_path, 1.0)
    grid = Grid(_cfg())
    cols = _drive(grid)
    sess = Session("ram", feed=IdleFeed(), grid=grid, recorder=root)
    sess._rec = _record(root, grid, cols)

    def forbidden(*args, **kwargs):
        raise AssertionError("a complete RAM page must never read disk")

    monkeypatch.setattr(root, "load_tail", forbidden)
    resp = _response(await sess.handle_history_async(
        events.HistoryRequest(req_id=8, before_t=START + 12 * DT, n_cols=4)
    ))
    assert [d.col_seq for d in resp.depth_cols] == [8, 9, 10, 11]
    assert resp.oldest_available_t_ns == 0


async def test_without_recorder_keeps_ram_fast_path():
    grid = Grid(_cfg())
    _drive(grid)
    sess = Session("no-disk", feed=IdleFeed(), grid=grid)
    req = events.HistoryRequest(req_id=9, before_t=START + 12 * DT, n_cols=4)
    assert await sess.handle_history_async(req) == sess.handle_history(req)


@pytest.mark.parametrize("foreign_start,foreign_p0", [
    (START - 100 * DT, 84.0), (START, 83.5),
])
async def test_foreign_timeline_or_geometry_cannot_donate_depth(
    tmp_path, foreign_start, foreign_p0
):
    root = Recorder(tmp_path, 1.0)
    current = Grid(_cfg())
    _drive(current)
    foreign = Grid(_cfg(foreign_p0))
    _record(root, foreign, _drive(foreign, start=foreign_start))
    # Legacy/unscoped callers have no logical recording ID to prove identity.
    # They must satisfy the current exact sequence/time origin as well.
    sess = Session("foreign", feed=IdleFeed(), grid=current, recorder=root)
    resp = _response(await sess.handle_history_async(
        events.HistoryRequest(req_id=10, before_t=START + 8 * DT, n_cols=4)
    ))
    assert resp.depth_cols == resp.bar_cols == []


async def test_disk_page_runs_off_loop_and_caps_reader_work(tmp_path, monkeypatch):
    root = Recorder(tmp_path, 1.0)
    grid = Grid(_cfg())
    cols = _drive(grid)
    sess = Session("off-loop", feed=IdleFeed(), grid=grid, recorder=root)
    sess._rec = _record(root, grid, cols)
    real = root.load_tail
    started, release = threading.Event(), threading.Event()
    calls = []
    loop_thread = threading.get_ident()

    def blocked(*args, **kwargs):
        assert threading.get_ident() != loop_thread
        calls.append(kwargs)
        started.set()
        assert release.wait(timeout=5)
        return real(*args, **kwargs)

    monkeypatch.setattr(root, "load_tail", blocked)
    task = asyncio.create_task(sess.handle_history_async(
        events.HistoryRequest(req_id=11, before_t=START + 8 * DT, n_cols=1000)
    ))
    try:
        assert await asyncio.to_thread(started.wait, 5)
        # Live grid work remains possible while Parquet IO is still blocked.
        live = _book(grid, START + 13 * DT)
        assert live and live[0].col_seq == 12
        assert not task.done()
        assert calls[0]["limit_cols"] == HISTORY_MAX_COLS
        assert calls[0]["max_column_parts"] == 16
        assert calls[0]["include_events"] is False
    finally:
        release.set()
    assert len(_response(await task).depth_cols) == 8


async def test_warm_restart_recording_identity_preserves_real_time_seam(tmp_path):
    root = Recorder(tmp_path, 1.0)
    previous = Grid(_cfg())
    cols = _drive(previous)
    old_rec = _record(root, previous, cols)
    tail = root.load_tail(
        IdleFeed.market, IdleFeed.symbol, max_age_ns=12 * DT,
        now_ns=START + 12 * DT, limit_cols=4,
    )
    assert tail is not None and tail.recording_id == old_rec.recording_id

    restarted = Grid(_cfg())
    sess = Session("warm", feed=IdleFeed(), grid=restarted, recorder=root)
    sess._rec = root.open_session(IdleFeed.market, IdleFeed.symbol)
    assert sess._apply_tail(tail)
    assert sess._rec.recording_id == old_rec.recording_id
    # Several offline seconds pass. Sequence continues at 12; true time starts
    # at interval 40. None of the missing wall-time intervals are fabricated.
    for i in range(40, 46):
        for col in _book(restarted, START + i * DT):
            sess._rec.record_column(col)
    sess._rec.flush()
    latest = restarted.history(2**62, 1)[0]
    assert latest.t0_ns - latest.col_seq * DT != START
    resp = _response(await sess.handle_history_async(
        events.HistoryRequest(req_id=12, before_t=START + 8 * DT, n_cols=4)
    ))
    assert [d.col_seq for d in resp.depth_cols] == [4, 5, 6, 7]
    assert [d.t0_ns for d in resp.depth_cols] == [START + i * DT for i in range(4, 8)]


async def test_scoped_recording_rejects_another_id_even_with_identical_grid(tmp_path, monkeypatch):
    root = Recorder(tmp_path, 1.0)
    grid = Grid(_cfg())
    cols = _drive(grid)
    sess = Session("id", feed=IdleFeed(), grid=grid, recorder=root)
    sess._rec = _record(root, grid, cols)
    valid = root.load_tail(
        IdleFeed.market, IdleFeed.symbol, max_age_ns=12 * DT,
        now_ns=START + 12 * DT, limit_cols=8,
    )
    assert valid is not None
    valid.recording_id = "foreign-cold-start"
    monkeypatch.setattr(root, "load_tail", lambda *args, **kwargs: valid)
    resp = _response(await sess.handle_history_async(
        events.HistoryRequest(req_id=13, before_t=START + 8 * DT, n_cols=4)
    ))
    assert resp.depth_cols == []


async def test_legacy_preloaded_depth_survives_warm_restart_and_ram_eviction(tmp_path):
    root = Recorder(tmp_path, 1.0)
    previous = Grid(_cfg())
    cols = _drive(previous)
    _record(root, previous, cols)
    _make_legacy(tmp_path)
    tail = root.load_tail(
        IdleFeed.market, IdleFeed.symbol, max_age_ns=12 * DT,
        now_ns=START + 12 * DT, limit_cols=4,
    )
    assert tail is not None and tail.recording_id is None
    grid = Grid(_cfg())
    sess = Session("legacy-warm", feed=IdleFeed(), grid=grid, recorder=root)
    sess._rec = root.open_session(IdleFeed.market, IdleFeed.symbol)
    current_id = sess._rec.recording_id
    assert sess._apply_tail(tail)
    assert sess._rec.recording_id == current_id
    sess._rec.record_epoch(grid.current_epoch_params())
    for i in range(40, 46):
        for col in _book(grid, START + i * DT):
            sess._rec.record_column(col)
    sess._rec.flush()
    assert grid.oldest_retained_t0_ns() > tail.newest_t0_ns
    resp = _response(await sess.handle_history_async(
        events.HistoryRequest(req_id=14, before_t=START + 8 * DT, n_cols=4)
    ))
    assert [d.col_seq for d in resp.depth_cols] == [4, 5, 6, 7]
    assert [d.t0_ns for d in resp.depth_cols] == [START + i * DT for i in range(4, 8)]


async def test_legacy_affine_proof_reaches_sequence_zero_far_before_preloaded_tail(tmp_path):
    root = Recorder(tmp_path, 1.0)
    previous = Grid(_cfg())
    cols = _drive(previous, n=512)
    _record(root, previous, cols)
    _make_legacy(tmp_path)
    tail = root.load_tail(
        IdleFeed.market, IdleFeed.symbol, max_age_ns=512 * DT,
        now_ns=START + 512 * DT, limit_cols=4,
    )
    assert tail is not None
    assert [c.col_seq for c in tail.columns] == [508, 509, 510, 511]
    grid = Grid(_cfg())
    sess = Session("legacy-deep", feed=IdleFeed(), grid=grid, recorder=root)
    sess._rec = root.open_session(IdleFeed.market, IdleFeed.symbol)
    assert sess._apply_tail(tail)
    # Only the last four legacy rows were ever preloaded. Their exact affine
    # proves older rows in that same cadence, all the way back to sequence zero.
    for i in range(600, 606):
        _book(grid, START + i * DT)
    resp = _response(await sess.handle_history_async(
        events.HistoryRequest(req_id=18, before_t=START + 4 * DT, n_cols=4)
    ))
    assert [d.col_seq for d in resp.depth_cols] == [0, 1, 2, 3]
    assert [d.t0_ns for d in resp.depth_cols] == [START + i * DT for i in range(4)]
    np.testing.assert_array_equal(resp.depth_cols[0].bid, cols[0].bid)


async def test_legacy_fallback_rejects_an_unrelated_older_timeline(tmp_path):
    root = Recorder(tmp_path, 1.0)
    proven = Grid(_cfg())
    cols = _drive(proven)
    tail = TailData(
        epochs=[proven.current_epoch_params()], columns=cols[-4:], trades=[],
        markers=[], newest_t0_ns=cols[-1].t0_ns,
    )
    foreign = Grid(_cfg())
    _record(root, foreign, _drive(foreign, n=8, start=START - 100 * DT))
    _make_legacy(tmp_path)
    grid = Grid(_cfg())
    sess = Session("legacy-foreign", feed=IdleFeed(), grid=grid, recorder=root)
    sess._rec = root.open_session(IdleFeed.market, IdleFeed.symbol)
    assert sess._apply_tail(tail)
    for i in range(40, 46):
        _book(grid, START + i * DT)
    resp = _response(await sess.handle_history_async(
        events.HistoryRequest(req_id=15, before_t=START + 8 * DT, n_cols=4)
    ))
    assert resp.depth_cols == resp.bar_cols == []


async def test_known_old_epoch_cannot_shift_current_heatmap_geometry(tmp_path):
    root = Recorder(tmp_path, 1.0)
    grid = Grid(_cfg())
    cols = _drive(grid)
    sess = Session("old-epoch", feed=IdleFeed(), grid=grid, recorder=root)
    sess._rec = _record(root, grid, cols)
    # The server knows epoch zero exactly, but the client's resident heatmap
    # has one current row transform. Old p0 must not silently shift its data.
    assert grid.maybe_reanchor(160.0) is not None
    assert grid.epoch_params_for(0).p0 != grid.current_epoch_params().p0
    resp = _response(await sess.handle_history_async(
        events.HistoryRequest(req_id=16, before_t=START + 8 * DT, n_cols=4)
    ))
    assert resp.depth_cols == resp.bar_cols == []
