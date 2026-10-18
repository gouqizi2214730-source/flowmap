"""Preview warming/SWR uses real cached observations and owns background work."""

import asyncio
from types import SimpleNamespace

import pytest

from flowmap_server.api.app import create_app
from flowmap_server.api import app as app_module
from flowmap_server.api.market_cache import MarketDataCache, QuoteData
from flowmap_server.config import Config
from flowmap_server.data import universe


def observation(market="equity", symbol="AAPL", price=42., stamp=123):
    return QuoteData(market=market, symbol=symbol, price=price, change_pct=1.5,
                     spark=[price - 1, price], as_of_ns=stamp)


async def no_movers(market, limit):
    return []


async def test_swr_returns_real_stale_data_while_single_shared_refresh_is_blocked():
    now = {"value": 0}
    entered, release = asyncio.Event(), asyncio.Event()
    calls = []

    async def quote(market, symbol):
        calls.append((market, symbol))
        if len(calls) > 1:
            entered.set()
            await release.wait()
            return observation(price=43., stamp=456)
        return observation()

    cache = MarketDataCache(quote_fn=quote, movers_fn=no_movers, ttl_ns=10,
                            clock=lambda: now["value"], stale_while_revalidate=True)
    good = await cache.quote("equity", "aapl")
    now["value"] = 20
    stale = await asyncio.wait_for(cache.quote("equity", "aapl"), .1)
    assert (stale.price, stale.spark, stale.as_of_ns) == (42., [41., 42.], 123)
    assert stale.stale and stale.reachable and not good.stale
    await entered.wait()
    repeats = await asyncio.gather(*(cache.quote("equity", "AAPL") for _ in range(10)))
    assert all(q.stale and q.as_of_ns == 123 for q in repeats)
    fresh_waiter = asyncio.create_task(cache.quote("equity", "AAPL", wait_for_refresh=True))
    await asyncio.sleep(0)
    assert len(calls) == 2 and len(cache._quote_refreshes) == 1 and not fresh_waiter.done()
    release.set()
    fresh = await fresh_waiter
    assert (fresh.price, fresh.as_of_ns, fresh.spark) == (43., 456, [42., 43.])
    assert not fresh.stale and len(calls) == 2
    await cache.aclose()


@pytest.mark.parametrize("outcome", ["empty", "error"])
async def test_swr_never_erases_good_price_history_on_empty_or_failed_refresh(outcome):
    now = {"value": 0}
    calls = []

    async def quote(market, symbol):
        calls.append(True)
        if len(calls) == 1:
            return observation()
        if outcome == "error":
            raise RuntimeError("provider unavailable")
        return QuoteData(market=market, symbol=symbol, price=None, spark=[], as_of_ns=999)

    cache = MarketDataCache(quote_fn=quote, movers_fn=no_movers, ttl_ns=10,
                            clock=lambda: now["value"], stale_while_revalidate=True)
    await cache.quote("equity", "AAPL")
    now["value"] = 20
    await cache.quote("equity", "AAPL")
    await asyncio.gather(*cache._quote_refreshes.values())
    cached = await cache.quote("equity", "AAPL")
    assert (cached.price, cached.spark, cached.as_of_ns) == (42., [41., 42.], 123)
    assert cached.stale and cached.reachable == (outcome == "empty")
    assert len(calls) == 2  # failure cooldown avoids a provider call per hover
    await cache.aclose()


async def test_swr_missing_quote_still_waits_for_genuine_provider_history():
    entered, release = asyncio.Event(), asyncio.Event()

    async def quote(market, symbol):
        entered.set()
        await release.wait()
        return observation()

    cache = MarketDataCache(quote_fn=quote, movers_fn=no_movers, stale_while_revalidate=True)
    request = asyncio.create_task(cache.quote("equity", "AAPL"))
    await entered.wait()
    assert not request.done() and not cache._quotes
    release.set()
    assert (await request).as_of_ns == 123
    await cache.aclose()


async def test_swr_admission_is_bounded_and_close_cancels_and_drains_owned_workers():
    now = {"value": 0}
    started = asyncio.Queue()
    cleaned = []

    async def quote(market, symbol):
        if now["value"] == 0:
            return observation(symbol=symbol)
        started.put_nowait(symbol)
        try:
            await asyncio.Event().wait()
        finally:
            await asyncio.sleep(0)  # close waits for asynchronous cleanup too
            cleaned.append(symbol)

    cache = MarketDataCache(quote_fn=quote, movers_fn=no_movers, ttl_ns=10,
                            clock=lambda: now["value"], stale_while_revalidate=True,
                            max_quote_refreshes=2)
    for symbol in ("A", "B", "C"):
        await cache.quote("equity", symbol)
    now["value"] = 20
    await asyncio.gather(*(cache.quote("equity", s) for s in ("A", "B", "C")))
    assert [await started.get(), await started.get()] == ["A", "B"]
    assert len(cache._quote_refreshes) == 2
    await cache.aclose()
    assert sorted(cleaned) == ["A", "B"] and not cache._quote_refreshes
    assert not cache._quote_locks
    assert (await cache.quote("equity", "C")).stale
    assert started.empty()  # no new fetch after close


async def test_swr_timeout_keeps_native_timestamp_and_marks_provider_unreachable():
    now = {"value": 0}

    async def quote(market, symbol):
        if now["value"] == 0:
            return observation()
        await asyncio.Event().wait()

    cache = MarketDataCache(quote_fn=quote, movers_fn=no_movers, ttl_ns=10,
                            clock=lambda: now["value"], stale_while_revalidate=True,
                            quote_refresh_timeout_s=.02)
    await cache.quote("equity", "AAPL")
    now["value"] = 20
    await cache.quote("equity", "AAPL")
    await asyncio.gather(*cache._quote_refreshes.values())
    cached = await cache.quote("equity", "AAPL")
    assert cached.as_of_ns == 123 and cached.spark == [41., 42.]
    assert cached.stale and not cached.reachable
    await cache.aclose()


async def test_production_movers_populate_partial_quote_cache_before_sweep_finishes(monkeypatch):
    monkeypatch.setattr(universe, "CRYPTO_SYMBOLS", ["FAST", "SLOW"])
    release, fast_done = asyncio.Event(), asyncio.Event()
    calls = []

    async def provider(market, symbol):
        calls.append((market, symbol))
        if symbol == "SLOW":
            await release.wait()
        else:
            fast_done.set()
        return observation(market, symbol)

    monkeypatch.setattr(app_module, "default_quote_fn", provider)
    app = create_app(Config(), manager=SimpleNamespace())
    cache = app.state.market_cache
    assert cache._stale_while_revalidate
    sweep = asyncio.create_task(cache.movers("crypto", 100))
    await fast_done.wait()
    await asyncio.sleep(0)
    hover = await asyncio.wait_for(cache.quote("binance-spot", "FAST"), .1)
    assert hover.spark == [41., 42.] and hover.as_of_ns == 123
    assert not sweep.done() and calls.count(("binance-spot", "FAST")) == 1
    same_hover = asyncio.create_task(cache.quote("binance-spot", "SLOW"))
    await asyncio.sleep(0)
    assert not same_hover.done() and calls.count(("binance-spot", "SLOW")) == 1
    release.set()
    assert len(await sweep) == 2 and (await same_hover).symbol == "SLOW"
    assert len(calls) == 2
    await cache.aclose()


async def test_crypto_and_equity_background_warmups_start_concurrently():
    started, cleaned = asyncio.Queue(), []

    async def movers(market, limit):
        started.put_nowait(market)
        try:
            await asyncio.Event().wait()
        finally:
            cleaned.append(market)

    async def quote(market, symbol):
        raise AssertionError("not needed")

    cache = MarketDataCache(quote_fn=quote, movers_fn=movers)
    prewarm = asyncio.create_task(cache.run_background(("crypto", "equity"), 30.))
    assert {await asyncio.wait_for(started.get(), .1), await asyncio.wait_for(started.get(), .1)} == {"crypto", "equity"}
    prewarm.cancel()
    await asyncio.gather(prewarm, return_exceptions=True)
    assert sorted(cleaned) == ["crypto", "equity"]
    await cache.aclose()


async def test_lifespan_drains_refresh_cleanup_before_recording_shutdown():
    now, order = {"value": 0}, []
    entered = asyncio.Event()

    async def quote(market, symbol):
        if now["value"] == 0:
            return observation()
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            await asyncio.sleep(0)
            order.append("provider cleaned")

    async def flush_all():
        order.append("recordings flushed")

    cache = MarketDataCache(quote_fn=quote, movers_fn=no_movers, ttl_ns=10,
                            clock=lambda: now["value"], stale_while_revalidate=True)
    await cache.quote("equity", "AAPL")
    app = create_app(Config(), manager=SimpleNamespace(flush_all=flush_all), market_cache=cache)
    async with app.router.lifespan_context(app):
        now["value"] = 20
        assert (await cache.quote("equity", "AAPL")).as_of_ns == 123
        await entered.wait()
    assert order == ["provider cleaned", "recordings flushed"]
    assert cache._closed and not cache._quote_refreshes and not cache._quote_locks
