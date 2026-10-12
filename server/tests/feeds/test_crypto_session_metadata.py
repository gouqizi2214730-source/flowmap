"""Public connector metadata reaches real Hello and bounded live Status."""

from __future__ import annotations

import asyncio
import contextlib
from types import SimpleNamespace

import pytest
from crocodile.core.config import Settings
from crocodile.core.schema.enums import AssetClass
from crocodile.core.schema.records import BookDelta, BookSnapshot

from flowmap_server.config import Config
from flowmap_server.core.grid import Grid, GridCfg
from flowmap_server.core.session import Session
from flowmap_server.feeds.crypto import CryptoFeed
from flowmap_server.proto import events, wire

TS = 1_700_000_000_000_000_000


def session_for(feed, clock=lambda: 0):
    return Session(
        "metadata",
        feed=feed,
        grid=Grid(
            GridCfg(
                tick=0.5,
                tick_multiple=1,
                dt_ns=250_000_000,
                p0=100.0,
                rows=32,
                ring_columns=8,
                mode=events.MODE_L2,
            )
        ),
        clock=clock,
    )


def messages(frames):
    result = []
    for frame in frames:
        offset = 0
        while offset < len(frame):
            item, offset = wire.decode(frame, offset)
            result.append(item)
    return result


@pytest.mark.parametrize(
    "exchange,settings,endpoint,format",
    [
        ("binance", Settings(binance_wire_format="json"), "binance-spot-json-ws", "json"),
        (
            "binance",
            Settings(binance_wire_format="sbe", binance_sbe_api_key="private-test-key"),
            "binance-spot-sbe-ws",
            "sbe",
        ),
        (
            "deribit",
            Settings(
                deribit_interval="raw",
                deribit_client_id="private-client-id",
                deribit_client_secret="private-client-secret",
            ),
            "deribit-raw-ws",
            "json",
        ),
    ],
)
async def test_real_session_first_hello_declares_selected_connector_without_secrets(
    monkeypatch, exchange, settings, endpoint, format
):
    async def resolve(market, symbol):
        return symbol

    async def price_tick(market, symbol):
        return 0.5

    monkeypatch.setattr("flowmap_server.feeds.crypto.resolve_symbol_cached", resolve)
    monkeypatch.setattr("flowmap_server.data.venues.venue_price_tick", price_tick)
    feed = CryptoFeed(
        exchange,
        "BTCUSDT" if exchange == "binance" else "BTC-PERPETUAL",
        "spot" if exchange == "binance" else "",
        Config(),
        engine_settings=settings,
    )
    await feed.prepare()
    hello = messages(session_for(feed)._snapshot_frames())[0]
    assert isinstance(hello, events.Hello)
    assert hello.capability["endpoint_id"] == endpoint
    assert hello.capability["wire_format"] == format
    assert hello.capability["coverage"]["kind"] == "visible_l2"
    assert hello.capability["book_top_n"] == feed._cfg.book_top_n
    assert hello.capability["raw_capture"] is False
    assert hello.capability["source_book_events"] == hello.capability["unique_book_changes"] == 0
    assert b"private-" not in wire.encode(hello)


def book(sequence, amount=2.0, *, snapshot=False):
    header = dict(
        source="binance",
        symbol="binance:BTCUSDT",
        symbol_raw="BTCUSDT",
        local_ts=TS,
        source_ts=TS,
        asset_class=AssetClass.CRYPTO,
        bids=[(100.0, amount)],
        asks=[(101.0, 3.0)],
    )
    return (
        BookSnapshot(**header, depth=1, sequence_id=sequence)
        if snapshot
        else BookDelta(**header, seq_id=sequence, prev_seq_id=sequence - 1)
    )


def queued_feed(incoming, *, settings=Settings(), cfg=Config()):
    made = []

    class Connector:
        name = "binance"
        market = "spot"
        symbols = ["BTCUSDT"]
        ws_url = ""
        transport = None
        wire_format = "json"
        capture_endpoint_id = "binance-spot-json-ws"
        coverage = {"kind": "visible_l2"}

        def __init__(self, out):
            self.out = out

        async def run(self):
            while True:
                await self.out.put(await incoming.get())

    def factory(out):
        result = Connector(out)
        made.append(result)
        return result

    return CryptoFeed(
        "binance", "BTCUSDT", "spot", cfg, connector_factory=factory, engine_settings=settings
    ), made


async def until(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(0.005)


async def test_real_session_status_exposes_monotonic_canonical_counts_at_most_one_hz():
    incoming = asyncio.Queue()
    feed, made = queued_feed(incoming)
    await feed.prepare()
    clock = [0]
    session = session_for(feed, lambda: clock[0])

    class Client:
        def __init__(self):
            self.frames = []
            self.status_times = []

        def offer(self, frame, **kwargs):
            self.frames.append(frame)
            if any(isinstance(item, events.Status) for item in messages([frame])):
                self.status_times.append(clock[0])

    client = Client()
    first = messages(session.attach(client))[0]
    assert first.capability["endpoint_id"] == "binance-spot-json-ws"
    runner = await session.start()

    def statuses():
        return [item for item in messages(client.frames) if isinstance(item, events.Status)]

    try:
        await incoming.put(book(1, snapshot=True))
        await until(lambda: feed.capability["source_book_events"] == 1)
        clock[0] = 1_000_000_000
        await until(lambda: len(statuses()) == 1)
        assert statuses()[0].capability["source_book_events"] == 1
        assert statuses()[0].capability["unique_book_changes"] == 1
        for seq in range(2, 52):
            await incoming.put(book(seq))
        await until(lambda: feed.capability["source_book_events"] == 51)
        await asyncio.sleep(0.04)
        assert len(statuses()) == 1
        clock[0] = 2_000_000_000
        await until(lambda: len(statuses()) == 2)
        assert statuses()[1].capability["source_book_events"] == 51
        assert statuses()[1].capability["unique_book_changes"] == 1
        await incoming.put(book(52, amount=4.0))
        await until(lambda: feed.capability["source_book_events"] == 52)
        clock[0] = 3_000_000_000
        await until(lambda: len(statuses()) == 3)
        assert statuses()[2].capability["unique_book_changes"] == 2
        assert client.status_times == [1_000_000_000, 2_000_000_000, 3_000_000_000]
        assert all(status.feed_state == "live" for status in statuses())
        assert len(made) == 1  # Hello preparation reuses the exact first connection
    finally:
        runner.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await runner


async def test_capture_restart_replaces_identity_and_clears_prior_sealed_summary(
    tmp_path, monkeypatch
):
    from crocodile.core.capture.writer import CaptureWriter

    captures = []

    async def create(path, context, *, queue_bytes):
        class Capture:
            async def close(self):
                return SimpleNamespace(
                    stats=SimpleNamespace(
                        fsynced_records=0,
                        received_frames=0,
                        peak_durable_lag_ns=0,
                        durable_lag_overruns=0,
                    )
                )

        captures.append(context.capture_id)
        return Capture()

    monkeypatch.setattr(CaptureWriter, "create", create)
    incoming = asyncio.Queue()
    feed, _ = queued_feed(
        incoming, settings=Settings(raw_capture=True), cfg=Config(data_dir=str(tmp_path))
    )
    await feed.prepare()
    first = feed.events()
    await incoming.put(book(1, snapshot=True))
    await anext(first)
    first_id = feed.capability["capture_id"]
    await first.aclose()
    assert feed.capability["capture_summary"]["sealed"]
    assert feed.capability["capture_summary"]["capture_id"] == first_id
    second = feed.events()
    await incoming.put(book(2, snapshot=True))
    await anext(second)
    second_id = feed.capability["capture_id"]
    assert second_id != first_id and "capture_summary" not in feed.capability
    assert feed.capability["source_book_events"] == 2
    await second.aclose()
    assert feed.capability["capture_summary"]["capture_id"] == second_id
    assert captures == [first_id, second_id]
