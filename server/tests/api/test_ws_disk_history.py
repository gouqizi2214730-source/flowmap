"""WebSocket history dispatch uses the off-loop disk-capable session path."""

from __future__ import annotations

import asyncio

from flowmap_server.api.ws import _Connection
from flowmap_server.proto import events, wire


async def test_history_dispatch_schedules_recorded_history_reader():
    received = []
    frame = wire.encode(events.HistoryResponse(
        req_id=17, epoch=0, oldest_available_t_ns=0,
        depth_cols=[], bar_cols=[], markers=[], big_trades=[],
    ))

    class Socket:
        async def send_bytes(self, data):
            received.append(data)

    class HistorySession:
        async def handle_history_async(self, req):
            assert req.req_id == 17
            await asyncio.sleep(0)
            return frame

        def handle_history(self, req):
            raise AssertionError("WS must use the disk-capable async reader")

    connection = _Connection(Socket(), manager=None)
    connection._session = HistorySession()
    assert await connection._handle_frame(wire.encode(events.HistoryRequest(
        req_id=17, before_t=123, n_cols=64,
    )))
    assert connection._history_response is not None
    await connection._history_response
    assert received == [frame]
