"""Slow recorded history must not block control traffic or cross subscriptions."""

from __future__ import annotations

import asyncio
import time

from flowmap_server.api import ws as ws_mod
from flowmap_server.proto import events, wire


def request(identity=1):
    return events.HistoryRequest(req_id=identity, before_t=2**63 - 1, n_cols=64,
                                 start_col=0, end_col=8191, stride=128)


def response(identity):
    return wire.encode(events.HistoryResponse(req_id=identity, epoch=0,
                       oldest_available_t_ns=0, depth_cols=[], bar_cols=[],
                       markers=[], big_trades=[]))


class Socket:
    def __init__(self):
        self.sent = []
        self.messages = asyncio.Queue()
        self.closed = False
        self.auto_pong = False

    async def receive(self):
        return await self.messages.get()

    async def send_bytes(self, data):
        self.sent.append(data)
        event, _ = wire.decode(data)
        if self.auto_pong and isinstance(event, events.Ping):
            self.messages.put_nowait({"type": "websocket.receive", "bytes": wire.encode(
                events.Pong(echo_ns=event.server_send_ns, client_recv_ns=0))})

    async def close(self, **kwargs):
        self.closed = True
        self.messages.put_nowait({"type": "websocket.disconnect"})


class Session:
    def __init__(self, release=None):
        self.release = release
        self.started = asyncio.Event()
        self.cancelled = False
        self.calls = []

    async def handle_history_async(self, req):
        self.calls.append(req.req_id)
        self.started.set()
        try:
            if self.release is not None:
                await self.release.wait()
            return response(req.req_id)
        except asyncio.CancelledError:
            self.cancelled = True
            raise


class Manager:
    def __init__(self, sessions):
        self.sessions = sessions
        self.unsubscribed = []

    async def subscribe(self, sub, client):
        return self.sessions[sub.symbol]

    async def unsubscribe(self, session, client):
        self.unsubscribed.append(session)


async def test_pong_and_symbol_switch_proceed_while_history_is_blocked():
    release = asyncio.Event()
    old, new = Session(release), Session()
    manager = Manager({"NEW": new})
    socket = Socket()
    conn = ws_mod._Connection(socket, manager)
    conn._session = old
    await conn._handle_frame(wire.encode(request()))
    await asyncio.wait_for(old.started.wait(), 1)
    await asyncio.wait_for(conn._handle_frame(wire.encode(events.Pong(
        echo_ns=time.monotonic_ns(), client_recv_ns=0))), 1)
    assert 0 <= conn.latency_ms < 50
    await asyncio.wait_for(conn._handle_frame(wire.encode(events.Subscribe(
        market="sim", symbol="NEW", mode="live"))), 1)
    assert conn._session is new and manager.unsubscribed == [old]
    old_work = conn._history_work
    await conn._handle_frame(wire.encode(request(2)))
    assert conn._history_pending is not None
    assert new.calls == []  # old executor work drains, never concurrent
    release.set()
    await asyncio.wait_for(old_work, 1)
    await asyncio.wait_for(new.started.wait(), 1)
    delivery = conn._history_response
    if delivery is not None:
        await asyncio.wait_for(delivery, 1)
    assert socket.sent == [response(2)]
    assert not old.cancelled


async def test_single_worker_and_one_coalesced_pending_request_bound_a_burst():
    release = asyncio.Event()
    session = Session(release)
    socket = Socket()
    conn = ws_mod._Connection(socket, Manager({}))
    conn._session = session
    await conn._handle_frame(wire.encode(request(1)))
    await session.started.wait()
    worker = conn._history_work
    for identity in range(2, 100):
        await conn._handle_frame(wire.encode(request(identity)))
        assert conn._history_work is worker
    assert conn._history_pending[2].req_id == 99
    delivery = conn._history_response
    release.set()
    await asyncio.wait_for(delivery, 1)
    if conn._history_response is not None:
        await asyncio.wait_for(conn._history_response, 1)
    assert session.calls == [1, 99]
    assert socket.sent == [response(1), response(99)]


async def test_unsubscribe_discards_response_waiting_for_the_send_lock():
    socket = Socket()
    session = Session()
    manager = Manager({})
    conn = ws_mod._Connection(socket, manager)
    conn._session = session
    await conn._send_lock.acquire()
    try:
        await conn._handle_frame(wire.encode(request()))
        await session.started.wait()
        worker = conn._history_work
        await asyncio.wait_for(worker, 1)
        await conn._handle_frame(wire.encode(events.Unsubscribe()))
        assert conn._session is None
    finally:
        conn._send_lock.release()
    await asyncio.sleep(0)
    assert socket.sent == []
    assert manager.unsubscribed == [session]


async def test_live_pongs_prevent_false_timeout_during_a_long_overview(monkeypatch):
    monkeypatch.setattr(ws_mod, "PING_INTERVAL_S", 0.01)
    monkeypatch.setattr(ws_mod, "LIVENESS_TIMEOUT_S", 0.04)
    release = asyncio.Event()
    session = Session(release)
    socket = Socket()
    socket.auto_pong = True
    conn = ws_mod._Connection(socket, Manager({}))
    conn._session = session
    # This fake starts with an active subscription; complete its handshake
    # before exercising the steady-state history/keepalive traffic.
    await conn._send(wire.encode(events.Hello(
        protocol_version=1, session_id="history-test", grid_epoch=0,
        epoch_params=events.EpochParams(
            epoch=0, tick=1.0, tick_multiple=1, dt_ns=250_000_000, p0=0.0, rows=64),
        capability={}, norm_seed=1.0,
    )))
    socket.messages.put_nowait({"type": "websocket.receive", "bytes": wire.encode(request())})
    running = asyncio.create_task(conn.run())
    await session.started.wait()
    try:
        await asyncio.sleep(0.12)  # three liveness windows, with real receive-loop Pongs
        assert not socket.closed
        assert not running.done()
        assert conn.latency_ms < 20
        worker = conn._history_work
        socket.messages.put_nowait({"type": "websocket.disconnect"})
        await asyncio.wait_for(running, 1)
        assert conn._history_response is None and conn._history_pending is None
        release.set()
        await asyncio.wait_for(worker, 1)
        await asyncio.sleep(0)
        assert response(1) not in socket.sent
    finally:
        release.set()
        if not running.done():
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)
