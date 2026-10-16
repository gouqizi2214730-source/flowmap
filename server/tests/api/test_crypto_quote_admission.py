"""Crypto admission remains full-pool, ordered and honest at the deadline."""

from __future__ import annotations

import asyncio

from flowmap_server.api import market_cache as market
from flowmap_server.core.backfill import Candle
from flowmap_server.data.universe import CRYPTO_SYMBOLS


async def test_crypto_four_active_admits_entire_pool_and_ranks_same_wire_values(monkeypatch):
    active = peak = 0
    admitted = []
    expected = {}

    async def fetch(mkt, symbol):
        nonlocal active, peak
        index = CRYPTO_SYMBOLS.index(symbol)
        admitted.append(symbol)
        active += 1
        peak = max(peak, active)
        try:
            await asyncio.sleep(0.001 * (index % 3 + 1))
            quote = market.QuoteData(
                market=mkt, symbol=symbol, price=100.0 + index,
                change_pct=float((-1) ** index * (index + 1)),
                spark=[90.0, 100.0 + index], as_of_ns=10**9 + index,
                reachable=True, stale=False,
            )
            expected[symbol] = market.mover_to_json(quote)
            return quote
        finally:
            active -= 1

    monkeypatch.setattr(market, "_crypto_quote", fetch)
    got = await market.default_movers_fn("crypto", 100)
    assert admitted == list(CRYPTO_SYMBOLS) and len(admitted) == 40
    assert peak == 4 and active == 0
    assert [quote.symbol for quote in got] == list(reversed(CRYPTO_SYMBOLS))
    assert [market.mover_to_json(quote) for quote in got] == [expected[q.symbol] for q in got]


async def test_bounded_crypto_sweep_partial_results_keep_original_indices_and_skip_late_quotes():
    admitted = []
    closed = []

    async def fetch(symbol):
        admitted.append(symbol)
        if symbol == "slow":
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                await asyncio.sleep(0.02)
                closed.append(symbol)
                # Providers that finish during cleanup must not appear as timely.
                return market.QuoteData("binance-spot", symbol, 100, 99)
        await asyncio.sleep(0.001)
        if symbol == "bad":
            raise ValueError("unavailable quote")
        return market.QuoteData("binance-spot", symbol, 100, 1)

    got = await market._bounded_quote_sweep(fetch, ["slow", "A", "bad", "B", "C"],
                                          0.05, max_in_flight=4)
    assert admitted == ["slow", "A", "bad", "B", "C"]
    assert [quote.symbol if quote else None for quote in got] == [None, "A", None, "B", "C"]
    assert closed == ["slow"]


async def test_real_crypto_quote_fields_remain_source_timed_without_invented_splits(monkeypatch):
    from flowmap_server.core import backfill

    calls = []
    candles = [Candle(11, 10, 12, 9, 10, 8, None, None),
               Candle(22, 10, 13, 9, 12, 8, 3, 5)]

    async def klines(*args, **kwargs):
        calls.append((args, kwargs))
        return candles

    monkeypatch.setattr(backfill, "crypto_klines", klines)
    quote = await market._crypto_quote("binance-spot", "BTCUSDT")
    assert (quote.market, quote.symbol, quote.price, quote.change_pct, quote.spark,
            quote.as_of_ns, quote.reachable, quote.stale) == (
        "binance-spot", "BTCUSDT", 12, 20, [10, 12], 22, True, False,
    )
    assert calls[0][0] == ("binance-spot", "BTCUSDT")
    assert calls[0][1]["interval"] == "1h" and calls[0][1]["max_bars"] == 25
    assert candles[0].buy_volume is None and candles[0].sell_volume is None
    candles.clear()
    quote = await market._crypto_quote("binance-spot", "BTCUSDT")
    assert quote.price is None and quote.stale and quote.reachable
    assert quote.as_of_ns == calls[-1][1]["now_ns"]
