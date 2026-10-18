"""Finite complete-directory preview warming and network-free delta snapshots."""

import asyncio
from types import SimpleNamespace

import httpx

from flowmap_server.api import app as app_module
from flowmap_server.api import market_cache as module
from flowmap_server.api.app import create_app
from flowmap_server.api.market_cache import MarketDataCache, QuoteData
from flowmap_server.config import Config
from flowmap_server.data.universe import CRYPTO_MARKET, CRYPTO_SYMBOLS, EQUITY_TICKERS


def quote(market, symbol, price=100., stamp=123):
    return QuoteData(market=market, symbol=symbol, price=price, change_pct=1.,
                     spark=[price - 1, price], as_of_ns=stamp)


async def no_movers(market, limit):
    return []


async def assert_unavailable_quote_route(cache, symbol):
    app = create_app(Config(), manager=SimpleNamespace(), market_cache=cache)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await asyncio.wait_for(client.get("/api/quote", params={"market": "equity", "symbol": symbol}), .1)
        data = response.json()
        assert response.status_code == 200
        assert data["price"] is None and data["spark"] == []
        assert data["stale"] and not data["reachable"]


async def test_production_catalog_includes_all_260_and_last_equities_beyond_movers(monkeypatch):
    calls = []

    async def provider(market, symbol):
        calls.append((market, symbol))
        return quote(market, symbol)

    monkeypatch.setattr(app_module, "default_quote_fn", provider)
    app = create_app(Config(), manager=SimpleNamespace())
    cache = app.state.market_cache
    expected = tuple((CRYPTO_MARKET, symbol) for symbol in CRYPTO_SYMBOLS) + tuple(
        ("equity", symbol) for symbol in EQUITY_TICKERS)
    assert len(expected) == 260 and len(EQUITY_TICKERS) == 220
    assert ("equity", "SPY") in expected[80:] and ("equity", "GLD") in expected[80:]
    assert cache.preview_snapshot()["warming"]
    await cache.run_preview_catalog()
    snapshot = cache.preview_snapshot()
    assert set(calls) == set(expected) and len(calls) == 260
    assert snapshot["total"] == snapshot["completed"] == snapshot["ready"] == 260
    assert len(snapshot["quotes"]) == 260 and not snapshot["warming"]
    await cache.run_preview_catalog()  # not another full pass every interval
    assert len(calls) == 260
    await cache.aclose()


async def test_catalog_caps_two_workers_and_publishes_partial_quotes_before_completion():
    started, release = asyncio.Queue(), asyncio.Event()
    active = maximum = 0
    calls = []

    async def provider(market, symbol):
        nonlocal active, maximum
        calls.append(symbol)
        active += 1
        maximum = max(maximum, active)
        started.put_nowait(symbol)
        try:
            if symbol != "FAST":
                await release.wait()
            return quote(market, symbol)
        finally:
            active -= 1

    cache = MarketDataCache(quote_fn=provider, movers_fn=no_movers,
                            preview_catalog=[("equity", s) for s in ("FAST", "SLOW", "TAIL", "LAST")])
    task = asyncio.create_task(cache.run_preview_catalog())
    assert {await started.get(), await started.get(), await started.get()} == {"FAST", "SLOW", "TAIL"}
    partial = cache.preview_snapshot()
    assert partial["warming"] and partial["completed"] == partial["ready"] == 1
    assert [q["symbol"] for q in partial["quotes"]] == ["FAST"]
    assert not task.done() and maximum == active == 2
    release.set()
    await task
    assert cache.preview_snapshot()["completed"] == 4
    assert maximum == 2 and calls == ["FAST", "SLOW", "TAIL", "LAST"]
    await cache.aclose()


async def test_foreground_hover_shares_catalog_request_and_movers_keep_their_small_scope(monkeypatch):
    from flowmap_server.data import universe

    monkeypatch.setattr(universe, "EQUITY_TICKERS", ["AAPL", "LAST"])
    entered, release = asyncio.Event(), asyncio.Event()
    calls = []

    async def provider(market, symbol):
        calls.append(symbol)
        entered.set()
        await release.wait()
        return quote(market, symbol)

    cache = None

    async def movers(market, limit):
        return await module.default_movers_fn(market, limit, quote_fn=cache.quote)

    cache = MarketDataCache(quote_fn=provider, movers_fn=movers, preview_catalog=[("equity", "AAPL")])
    catalog = asyncio.create_task(cache.run_preview_catalog())
    await entered.wait()
    hover = asyncio.create_task(cache.quote("equity", "AAPL"))
    sweep = asyncio.create_task(cache.movers("equity", 100))
    await asyncio.sleep(0)
    assert calls.count("AAPL") == 1 and not hover.done()
    release.set()
    await asyncio.gather(catalog, hover, sweep)
    assert calls.count("AAPL") == calls.count("LAST") == 1
    await cache.aclose()


async def test_snapshot_deltas_reset_generation_eviction_and_timestamps_are_pure():
    now = {"value": 0}
    calls = []

    async def provider(market, symbol):
        calls.append(symbol)
        return quote(market, symbol, stamp=123 + len(calls))

    cache = MarketDataCache(quote_fn=provider, movers_fn=no_movers, max_entries=2,
                            ttl_ns=10, clock=lambda: now["value"])
    assert cache.preview_snapshot()["quotes"] == [] and calls == []
    await cache.quote("equity", "A")
    first = cache.preview_snapshot()
    assert first["revision"] == 1
    assert [q["symbol"] for q in first["quotes"]] == ["A"]
    assert cache.preview_snapshot(1, first["generation"])["quotes"] == []
    await cache.quote("equity", "B")
    second = cache.preview_snapshot(1, first["generation"])
    assert second["revision"] == 2 and [q["symbol"] for q in second["quotes"]] == ["B"]
    await cache.quote("equity", "C")
    now["value"] = 100
    before = list(calls)
    for snapshot in (cache.preview_snapshot(0), cache.preview_snapshot(10000), cache.preview_snapshot(1, "old-process")):
        assert {q["symbol"] for q in snapshot["quotes"]} == {"B", "C"}
        assert all(q["stale"] and q["asOf"] in (125, 126) for q in snapshot["quotes"])
    assert calls == before
    assert len(cache._quote_revisions) == len(cache._quotes) == 2
    assert ("equity", "A") not in cache._quote_revisions
    await cache.aclose()


async def test_preview_route_returns_cached_delta_without_provider_or_missing_cache_io():
    calls = []

    async def provider(market, symbol):
        calls.append(symbol)
        return quote(market, symbol)

    cache = MarketDataCache(quote_fn=provider, movers_fn=no_movers)
    await cache.quote("equity", "AAPL")
    app = create_app(Config(), manager=SimpleNamespace(), market_cache=cache)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        first = (await client.get("/api/previews", params={"after": 0})).json()
        assert first["quotes"][0]["spark"] == [99., 100.]
        delta = (await client.get("/api/previews", params={"after": first["revision"], "generation": first["generation"]})).json()
        assert delta["quotes"] == [] and calls == ["AAPL"]
        assert (await client.get("/api/previews?after=invalid")).status_code == 422
        app.state.market_cache = None
        assert (await client.get("/api/previews")).json() == {
            "quotes": [], "revision": 0, "generation": "", "warming": False,
            "total": 0, "completed": 0, "ready": 0,
        }
    await cache.aclose()


async def test_empty_and_failed_catalog_entries_complete_without_invented_graphs():
    calls = []

    async def provider(market, symbol):
        calls.append(symbol)
        if symbol == "FAIL":
            raise RuntimeError("offline")
        return QuoteData(market=market, symbol=symbol, price=None, spark=[], stale=True)

    cache = MarketDataCache(quote_fn=provider, movers_fn=no_movers,
                            preview_catalog=[("equity", "EMPTY"), ("equity", "FAIL")])
    await cache.run_preview_catalog()
    state = cache.preview_snapshot()
    assert state["total"] == state["completed"] == 2 and state["ready"] == 0
    assert not state["warming"]
    assert {q["symbol"] for q in state["quotes"]} == {"EMPTY", "FAIL"}
    assert all(not q["spark"] and q["price"] is None for q in state["quotes"])
    failed = next(q for q in state["quotes"] if q["symbol"] == "FAIL")
    assert failed["stale"] and not failed["reachable"]
    assert (await cache.quote("equity", "FAIL")).price is None
    await assert_unavailable_quote_route(cache, "FAIL")
    assert calls == ["EMPTY", "FAIL"]
    await cache.aclose()


async def test_catalog_deadline_counts_attempt_and_cancels_provider(monkeypatch):
    monkeypatch.setattr(module, "_PREVIEW_QUOTE_TIMEOUT_S", .02)
    cleaned = []
    calls = []

    async def provider(market, symbol):
        calls.append(symbol)
        try:
            await asyncio.Event().wait()
        finally:
            cleaned.append(symbol)

    cache = MarketDataCache(quote_fn=provider, movers_fn=no_movers,
                            preview_catalog=[("equity", "SLOW")])
    await asyncio.wait_for(cache.run_preview_catalog(), .2)
    assert cleaned == ["SLOW"] and cache.preview_snapshot()["completed"] == 1
    unavailable = cache.preview_snapshot()["quotes"]
    assert len(unavailable) == 1 and unavailable[0]["symbol"] == "SLOW"
    assert unavailable[0]["price"] is None and unavailable[0]["spark"] == []
    assert unavailable[0]["stale"] and not unavailable[0]["reachable"]
    assert not cache._quote_locks
    assert (await cache.quote("equity", "SLOW")).price is None and calls == ["SLOW"]
    await assert_unavailable_quote_route(cache, "SLOW")
    assert calls == ["SLOW"]
    await cache.aclose()


async def test_lifespan_starts_catalog_without_blocking_and_drains_before_cache_and_recordings():
    entered, order = asyncio.Queue(), []

    async def provider(market, symbol):
        entered.put_nowait(symbol)
        try:
            await asyncio.Event().wait()
        finally:
            await asyncio.sleep(0)
            order.append(symbol)

    async def flush_all():
        assert sorted(order) == ["A", "B"]
        order.append("recordings")

    cache = MarketDataCache(quote_fn=provider, movers_fn=no_movers,
                            preview_catalog=[("equity", s) for s in ("A", "B", "NEVER")])
    app = create_app(Config(), manager=SimpleNamespace(flush_all=flush_all), market_cache=cache)
    async with app.router.lifespan_context(app):
        # Lifespan entry returns while both provider calls remain unresolved.
        assert {await entered.get(), await entered.get()} == {"A", "B"}
        assert cache.preview_snapshot()["warming"]
        assert cache.preview_snapshot()["completed"] == 0
    assert order[-1] == "recordings" and "NEVER" not in order
    assert not cache._preview_task and not cache._quote_locks and not cache._quote_refreshes
    assert cache._closed and not cache.preview_snapshot()["warming"]


async def test_cache_close_also_owns_catalog_cancellation_without_app_lifespan():
    entered, cleaned = asyncio.Event(), []

    async def provider(market, symbol):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleaned.append(symbol)

    cache = MarketDataCache(quote_fn=provider, movers_fn=no_movers,
                            preview_catalog=[("equity", "A")])
    task = asyncio.create_task(cache.run_preview_catalog())
    await entered.wait()
    await cache.aclose()
    assert task.done() and cleaned == ["A"] and not cache._quote_locks
    assert cache.preview_snapshot()["total"] == 1


async def test_new_cache_generation_resets_cursor_even_after_new_revision_passes_old_one():
    async def provider(market, symbol):
        return quote(market, symbol)

    old = MarketDataCache(quote_fn=provider, movers_fn=no_movers)
    await old.quote("equity", "OLD")
    cursor = old.preview_snapshot()
    new = MarketDataCache(quote_fn=provider, movers_fn=no_movers)
    await new.quote("equity", "A")
    await new.quote("equity", "B")
    assert new.preview_snapshot()["revision"] > cursor["revision"]
    reset = new.preview_snapshot(cursor["revision"], cursor["generation"])
    assert reset["generation"] != cursor["generation"]
    assert [q["symbol"] for q in reset["quotes"]] == ["A", "B"]
    delta = new.preview_snapshot(cursor["revision"], reset["generation"])
    assert [q["symbol"] for q in delta["quotes"]] == ["B"]
    await old.aclose()
    await new.aclose()


async def test_failed_catalog_refresh_preserves_good_native_time_and_graph():
    now, calls = {"value": 0}, []

    async def provider(market, symbol):
        calls.append(symbol)
        if len(calls) > 1:
            raise RuntimeError("provider down")
        return quote(market, symbol, stamp=777)

    cache = MarketDataCache(quote_fn=provider, movers_fn=no_movers, ttl_ns=10,
                            clock=lambda: now["value"], stale_while_revalidate=True,
                            preview_catalog=[("equity", "AAPL")])
    await cache.quote("equity", "AAPL")
    now["value"] = 20
    await cache.run_preview_catalog()
    cached = cache.preview_snapshot()["quotes"][0]
    assert cached["price"] == 100. and cached["spark"] == [99., 100.]
    assert cached["asOf"] == 777 and cached["stale"] and not cached["reachable"]
    assert cache.preview_snapshot()["ready"] == 1
    await cache.aclose()


async def test_catalog_timeout_never_replaces_a_good_observation_arriving_during_cleanup(monkeypatch):
    monkeypatch.setattr(module, "_PREVIEW_QUOTE_TIMEOUT_S", .02)
    cache = None

    async def provider(market, symbol):
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            # Another completed observation becomes available during provider
            # cancellation; the negative result must leave its native data intact.
            cache._store_quote((market, symbol), quote(market, symbol, stamp=888))
            raise

    cache = MarketDataCache(quote_fn=provider, movers_fn=no_movers,
                            preview_catalog=[("equity", "AAPL")])
    await cache.run_preview_catalog()
    result = cache.preview_snapshot()["quotes"][0]
    assert result["asOf"] == 888 and result["spark"] == [99., 100.]
    assert result["price"] == 100. and result["reachable"] and not result["stale"]
    await cache.aclose()
