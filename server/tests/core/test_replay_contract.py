"""Recorded-price, real Session/Grid and WS-generation replay regressions."""
from __future__ import annotations

import asyncio
import threading
from types import SimpleNamespace

import httpx
import numpy as np
import pytest

from flowmap_server.api.app import create_app
from flowmap_server.api.ws import _Connection
from flowmap_server.config import Config
from flowmap_server.core.grid import FinalizedColumn, Grid, GridCfg
from flowmap_server.core.price_scale import epoch_scale_fields, make_hybrid, row_to_price, scale_of
from flowmap_server.core.record import Recorder, TailData
from flowmap_server.core.session import ClientTx, Session, SessionManager
from flowmap_server.feeds.replay import ReplayFeed
from flowmap_server.feeds.base import BookState
from flowmap_server.proto import events, wire

DT = 250_000_000
T0 = 1_791_900_000_000_000_000
ROWS = 128


def fixture(n=48, *, hybrid=False):
    scale = make_hybrid(83_475, ROWS, 64, .5, 11, .01) if hybrid else None
    ep = events.EpochParams(epoch=0, tick=.5, tick_multiple=1, rows=ROWS,
                           dt_ns=DT, p0=83_443, **(epoch_scale_fields(scale) if scale else {}))
    columns, trades = [], []
    for i in range(n):
        bid, ask = np.zeros(ROWS, np.float16), np.zeros(ROWS, np.float16)
        bid[50], ask[54] = 2 + i, 3 + i
        if hybrid:
            bid[0], ask[-1] = .5, 1.5
        bar = events.BarColumn(epoch=0, col_seq=i, t0_ns=T0+i*DT,
            o=83_475, h=83_476, l=83_474, c=83_475+i*.5,
            vol_buy=2, vol_sell=1, cvd_cum=i+1, vwap_num_cum=83_475*(i+1), vwap_den_cum=i+1)
        columns.append(FinalizedColumn(epoch=0, col_seq=i, t0_ns=bar.t0_ns, bid=bid, ask=ask, bar=bar))
        trades.append(events.Trade(ts_ns=bar.t0_ns+7, price=bar.c, size=1,
                     side=events.SIDE_BUY, side_src=events.SIDE_SRC_EXCHANGE, venue="binance"))
    return TailData(epochs=[ep], columns=columns, trades=trades, markers=[], newest_t0_ns=columns[-1].t0_ns)


def session_for(tail):
    feed = ReplayFeed(market="binance", symbol="BTCUSDT", tail=tail, paused=True)
    ep = tail.epochs[0]
    grid = Grid(GridCfg(tick=ep.tick, tick_multiple=ep.tick_multiple, dt_ns=ep.dt_ns,
                      p0=ep.p0, rows=ep.rows, ring_columns=128, mode=events.MODE_L2))
    session = Session("test-replay", feed=feed, grid=grid)
    session._reset_replay_at(0)
    return session


def decoded(frames):
    result = []
    for frame in frames:
        offset = 0
        while offset < len(frame):
            event, offset = wire.decode(frame, offset)
            if event is not None:
                result.append(event)
    return result


@pytest.mark.parametrize("hybrid", [False, True])
def test_sparse_positive_btc_inverse_and_real_grid_quote(hybrid):
    tail = fixture(2, hybrid=hybrid)
    session = session_for(tail)
    feed, ep = session._feed, tail.epochs[0]
    book = feed.snapshot_at(0)
    expected_bid = [row_to_price(scale_of(ep), int(r)) for r in np.flatnonzero(tail.columns[0].bid)]
    expected_ask = [row_to_price(scale_of(ep), int(r)) for r in np.flatnonzero(tail.columns[0].ask)]
    np.testing.assert_allclose(book.bid_px, expected_bid, rtol=1e-14)
    np.testing.assert_allclose(book.ask_px, expected_ask, rtol=1e-14)
    assert book.ts_ns == T0 and np.all(book.bid_px > 0)
    np.testing.assert_array_equal(book.bid_sz, tail.columns[0].bid[tail.columns[0].bid > 0])
    assert len(feed._prices[0]) == len(expected_bid) + len(expected_ask)
    assert len(feed._prices[0]) < ROWS
    np.testing.assert_array_equal(session._grid._state[0], tail.columns[0].bid)
    assert session._grid.history(2**63-1, 1)[0].bid.sum() > 0
    assert session._bbo.bid_px == expected_bid[-1]
    assert session._bbo.ask_px == expected_ask[0]
    assert session._bbo.ts_ns == T0


def test_hybrid_wing_joins_match_scalar_inverse():
    tail = fixture(1, hybrid=True)
    ep = tail.epochs[0]
    col = tail.columns[0]
    col.bid[:] = 1
    feed = ReplayFeed(market="binance", symbol="BTCUSDT", tail=tail)
    np.testing.assert_allclose(feed.snapshot_at(0).bid_px,
        [row_to_price(scale_of(ep), r) for r in range(ROWS)], rtol=1e-14)


@pytest.mark.parametrize("target", [12, 3, 42, 0, 47])
async def test_real_session_paused_seek_resets_all_state_and_resumes(target):
    tail = fixture()
    session = session_for(tail)
    client = ClientTx()
    session.attach(client)
    # Old queued event and old generation book cannot survive the Seek.
    client.offer(wire.encode(tail.trades[-1]), col_msg=False)
    stale = session._feed.snapshot_at(40)
    identity = session.session_id
    session.feed_control(events.SetSpeed(x=7))
    session.feed_control(events.Seek(t=T0 + target * DT + 19))
    assert session.session_id != identity
    output = decoded(client.drain(2**31))
    hello = next(e for e in output if isinstance(e, events.Hello))
    playback = hello.capability["playback"]
    assert playback["position_ns"] == str(T0+target*DT)
    assert playback["start_ns"] == str(T0) and playback["end_ns"] == str(T0+48*DT)
    assert playback["paused"] and playback["speed"] == 7
    assert playback["ended"] == (target == 47)
    assert all(e.ts_ns < T0+(target+1)*DT for e in output if isinstance(e, events.Trade))
    history = session._grid.history(2**63-1, 128)
    assert history[-1].t0_ns == T0+target*DT
    assert history[-1].bar.cvd_cum == target+1
    assert session._grid._cvd_cum == target+1
    assert session._bbo.ts_ns == T0+target*DT
    session._on_book(stale)
    assert session._grid._prev_ts == T0+target*DT
    assert session._grid.current_partial() is None
    if target < 47:
        session.feed_control(events.Resume())
        book = await asyncio.wait_for(anext(session._feed.events()), 1)
        session._on_book(book)
        assert session._grid._prev_ts == T0+(target+1)*DT
        assert session._grid._cvd_cum == target+2


def test_one_column_is_visible_paused_and_ended_on_attach():
    session = session_for(fixture(1))
    output = decoded(session._snapshot_frames())
    assert next(e for e in output if isinstance(e, events.Hello)).capability["playback"]["ended"]
    columns = [e for e in output if isinstance(e, events.DepthColumn) and e.final]
    assert len(columns) == 1 and columns[0].final and columns[0].bid.sum() > 0


def test_initial_crossed_snapshot_preserves_recorded_density_and_bars_without_quote():
    tail = fixture(1)
    tail.columns[0].ask[:] = 0
    tail.columns[0].ask[49] = 3
    session = session_for(tail)
    output = decoded(session._snapshot_frames())
    hello = next(e for e in output if isinstance(e, events.Hello))
    assert hello.capability["depth_provenance"] == "recorded-density"
    assert session._bbo is None and not any(isinstance(e, events.BBO) for e in output)
    book = next(e for e in output if isinstance(e, events.BookUpdate))
    np.testing.assert_array_equal(book.bid, tail.columns[0].bid)
    np.testing.assert_array_equal(book.ask, tail.columns[0].ask)
    assert session._grid.history(2**63-1, 1)[0].bar == tail.columns[0].bar


@pytest.mark.parametrize("seek", [False, True])
async def test_valid_crossed_valid_quotes_are_current_for_playback_and_paused_seek(seek):
    tail = fixture(3)
    tail.columns[1].ask[:] = 0
    tail.columns[1].ask[49] = 4
    session = session_for(tail)
    client = ClientTx()
    snapshot = session.attach(client)
    assert next(e for e in decoded(snapshot) if isinstance(e, events.BBO)).ts_ns == T0
    stream = session._feed.events()
    if not seek:
        session.feed_control(events.SetSpeed(x=1000))
        session.feed_control(events.Resume())
    try:
        for target in (1, 2):
            if seek:
                session.feed_control(events.Seek(t=T0+target*DT))
            else:
                while True:
                    ev = await asyncio.wait_for(anext(stream), 1)
                    if isinstance(ev, BookState):
                        session._on_book(ev)
                        break
            output = decoded(client.drain(2**31))
            book = next(e for e in output if isinstance(e, events.BookUpdate))
            assert book.t0_ns == T0+target*DT
            np.testing.assert_array_equal(book.bid, tail.columns[target].bid)
            np.testing.assert_array_equal(book.ask, tail.columns[target].ask)
            history = session._grid.history(2**63-1, 128)
            assert history[-1].bar == tail.columns[target].bar
            quotes = [e for e in output if isinstance(e, events.BBO)]
            if target == 1:
                assert session._bbo is None and not quotes
            else:
                assert len(quotes) == 1 and quotes[0].ts_ns == T0+2*DT
                assert session._bbo.ts_ns == T0+2*DT
    finally:
        await stream.aclose()


async def test_ws_seek_discards_history_and_frames_waiting_at_generation_boundary():
    session = session_for(fixture())
    socket = SimpleNamespace(sent=[])
    async def send(data):
        socket.sent.append(data)
    socket.send_bytes = send
    conn = _Connection(socket, None)
    conn._session = session
    session.attach(conn._client)
    old_id = session.session_id
    await conn._send_lock.acquire()
    old_send = asyncio.create_task(conn._send(wire.encode(session._feed._cols[-1].bar), old_id))
    try:
        await conn._handle_frame(wire.encode(events.Seek(t=T0+3*DT)))
    finally:
        conn._send_lock.release()
    await old_send
    assert socket.sent == []
    assert conn._history_generation == 1
    output = decoded(conn._client.drain(2**31))
    assert isinstance(output[0], events.Hello)
    assert [e.col_seq for e in output if isinstance(e, events.DepthColumn)][-1] == 3


async def test_targeted_cached_availability_and_exact_window_errors(tmp_path, monkeypatch):
    root = Recorder(tmp_path / "recordings", 1)
    tail = fixture(12)
    rec = root.open_session("binance", "BTCUSDT")
    rec.record_epoch(tail.epochs[0])
    for col in tail.columns:
        rec.record_column(col)
    rec.close()
    mgr = SessionManager(Config(ring_columns=8, max_rows=128), recorder=root)
    app = create_app(Config(data_dir=str(tmp_path / "recordings")))
    app.state.manager = mgr
    calls, event_loop_thread = [], threading.get_ident()
    original = root._column_time_bounds
    def probe(path):
        calls.append((path, threading.get_ident()))
        return original(path)
    monkeypatch.setattr(root, "_column_time_bounds", probe)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        for _ in range(2):
            response = await client.get("/api/recordings/availability", params={"market": "binance", "symbol": "BTCUSDT"})
            assert response.json()["latest_column_ns"] == str(T0+11*DT)
            assert response.json()["coverage"] == "filename-hour-buckets"
        assert len(calls) == 1 and calls[0][1] != event_loop_thread
        params = {"market": "binance", "symbol": "BTCUSDT", "start_ns": T0, "end_ns": T0+12*DT}
        assert (await client.get("/api/recordings/window", params=params)).status_code == 422
        params.update(start_ns=T0+4*DT, end_ns=T0+8*DT)
        response = await client.get("/api/recordings/window", params=params)
        assert response.status_code == 200 and response.json()["columns"] == 4
        assert response.json()["start_ns"] == str(T0+4*DT)
        assert response.json()["end_ns"] == str(T0+8*DT)
        params.update(start_ns=T0+20*DT, end_ns=T0+24*DT)
        assert (await client.get("/api/recordings/window", params=params)).status_code == 422
        params.update(start_ns=T0, end_ns=T0)
        assert (await client.get("/api/recordings/window", params=params)).status_code == 422
