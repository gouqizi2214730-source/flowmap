from __future__ import annotations

import pytest
from crocodile.core.config import Settings
from crocodile.core.schema.enums import AssetClass
from crocodile.core.schema.records import BookSnapshot, BookDelta
from flowmap_server.config import Config
from flowmap_server.feeds.crypto import CryptoFeed, _BridgeSink


def test_explicit_sbe_reaches_engine_factory_and_preserves_transport_headers():
    feed = CryptoFeed(
        "binance",
        "BTCUSDT",
        "spot",
        Config(),
        engine_settings=Settings(binance_wire_format="sbe", binance_sbe_api_key="test-only"),
    )
    conn = feed._default_connector(_BridgeSink(lambda _: None))
    assert conn.decoder_id == "binance-sbe"
    assert "X-MBX-APIKEY" in conn.make_transport()._headers
    assert "test-only" not in str(feed.capability)


@pytest.mark.asyncio
async def test_bridge_retains_sequence_and_provenance_without_counting_repeated_sizes():
    events = []
    metrics = {}
    sink = _BridgeSink(events.append, metadata=metrics)
    header = dict(
        source="binance",
        symbol="binance:BTCUSDT",
        symbol_raw="BTCUSDT",
        local_ts=1_700_000_000_000_000_000,
        source_ts=1_700_000_000_000_000_000,
        asset_class=AssetClass.CRYPTO,
    )
    await sink.put(
        BookSnapshot(**header, bids=[(100.0, 2.0)], asks=[(101.0, 3.0)], depth=1, sequence_id=10)
    )
    await sink.put(BookDelta(**header, bids=[(100.0, 2.0)], asks=[], seq_id=11, prev_seq_id=10))
    assert events[-1].sequence_id == 11
    assert events[-1].prev_sequence_id == 10
    assert events[-1].source == "binance"
    assert events[-1].provenance == "native"
    assert metrics["source_book_events"] == 2
    assert metrics["unique_book_changes"] == 1
