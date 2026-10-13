"""A delayed initial handshake cannot be overtaken by application pings."""

from __future__ import annotations

import asyncio

import pytest

from flowmap_server.api import ws as ws_mod
from flowmap_server.proto import events, wire


def hello_frame() -> bytes:
    return wire.encode(events.Hello(
        protocol_version=1, session_id="delayed-handshake", grid_epoch=0,
        epoch_params=events.EpochParams(
            epoch=0, tick=1.0, tick_multiple=1, dt_ns=250_000_000, p0=0.0, rows=64),
        capability={}, norm_seed=1.0,
    ))


class Socket:
    def __init__(self):
        self.sent = []
        self.closed = False
        self.send_started = asyncio.Event()
        self.release_send = asyncio.Event()
        self.release_send.set()
        self.fail_send = False

    async def send_bytes(self, data):
        self.send_started.set()
        await self.release_send.wait()
        if self.fail_send:
            raise RuntimeError("send failed")
        self.sent.append(data)

    async def close(self):
        self.closed = True


class PingTicks:
    """Advance complete ping iterations without a wall-clock timing race."""

    def __init__(self, monkeypatch):
        self.ready = asyncio.Queue()
        self.ticks = asyncio.Queue()
        monkeypatch.setattr(ws_mod.asyncio, "sleep", self.sleep)

    async def sleep(self, interval):
        assert interval == ws_mod.PING_INTERVAL_S
        self.ready.put_nowait(None)
        await self.ticks.get()

    async def next(self):
        self.ticks.put_nowait(None)
        await asyncio.wait_for(self.ready.get(), 1)


async def test_ping_waits_for_initial_hello_then_resumes(monkeypatch):
    ticks = PingTicks(monkeypatch)
    socket = Socket()
    conn = ws_mod._Connection(socket, None)
    running = asyncio.create_task(conn._ping_loop())
    try:
        await asyncio.wait_for(ticks.ready.get(), 1)
        for _ in range(3):
            await ticks.next()
        assert socket.sent == []
        hello = hello_frame()
        await conn._send(hello)
        await ticks.next()
        assert socket.sent[0] == hello
        assert isinstance(wire.decode(socket.sent[1])[0], events.Ping)
    finally:
        running.cancel()
        await asyncio.gather(running, return_exceptions=True)


async def test_ping_waits_for_hello_send_completion(monkeypatch):
    ticks = PingTicks(monkeypatch)
    socket = Socket()
    socket.release_send.clear()
    conn = ws_mod._Connection(socket, None)
    running = asyncio.create_task(conn._ping_loop())
    sending = asyncio.create_task(conn._send(hello_frame()))
    try:
        await asyncio.wait_for(ticks.ready.get(), 1)
        await asyncio.wait_for(socket.send_started.wait(), 1)
        await ticks.next()
        assert socket.sent == []
        socket.release_send.set()
        await asyncio.wait_for(sending, 1)
        await ticks.next()
        decoded = [wire.decode(frame)[0] for frame in socket.sent]
        assert [type(event) for event in decoded] == [events.Hello, events.Ping]
    finally:
        socket.release_send.set()
        running.cancel()
        sending.cancel()
        await asyncio.gather(running, sending, return_exceptions=True)


async def test_failed_hello_send_does_not_enable_pings(monkeypatch):
    ticks = PingTicks(monkeypatch)
    socket = Socket()
    socket.fail_send = True
    conn = ws_mod._Connection(socket, None)
    with pytest.raises(RuntimeError, match="send failed"):
        await conn._send(hello_frame())
    socket.fail_send = False
    running = asyncio.create_task(conn._ping_loop())
    try:
        await asyncio.wait_for(ticks.ready.get(), 1)
        await ticks.next()
        assert socket.sent == []
    finally:
        running.cancel()
        await asyncio.gather(running, return_exceptions=True)


async def test_silent_peer_still_expires_before_hello(monkeypatch):
    ticks = PingTicks(monkeypatch)
    socket = Socket()
    conn = ws_mod._Connection(socket, None)
    monkeypatch.setattr(ws_mod.time, "monotonic_ns", lambda: (
        conn._last_recv_ns + int((ws_mod.LIVENESS_TIMEOUT_S + 1) * 1e9)))
    running = asyncio.create_task(conn._ping_loop())
    try:
        await asyncio.wait_for(ticks.ready.get(), 1)
        ticks.ticks.put_nowait(None)
        await asyncio.wait_for(running, 1)
        assert socket.closed
        assert socket.sent == []
    finally:
        running.cancel()
        await asyncio.gather(running, return_exceptions=True)
