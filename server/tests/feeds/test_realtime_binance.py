"""Subscription cadence regression: Binance must not use its 1 Hz default."""

import pytest

from flowmap_server.config import Config
from flowmap_server.feeds.crypto import CryptoFeed


@pytest.mark.parametrize("market", ["spot", "usdm", "coinm"])
def test_binance_requests_fast_depth_without_changing_trade_or_bbo(market):
    feed = CryptoFeed("binance", "BTCUSDT", market, Config())
    conn = feed._default_connector(None)
    topics = conn.subscribe_channels()
    assert "btcusdt@depth@100ms" in topics
    assert "btcusdt@depth" not in topics
    assert "btcusdt@bookTicker" in topics
    assert "btcusdt@aggTrade" in topics
    assert len(topics) == len(set(topics))


def test_transport_and_forming_column_refresh_exceed_30_hz():
    from flowmap_server.api.ws import FLUSH_INTERVAL_S
    from flowmap_server.core.session import FLUSH_INTERVAL_NS

    assert 0 < FLUSH_INTERVAL_S < 1 / 30
    assert 0 < FLUSH_INTERVAL_NS < 1e9 / 30
