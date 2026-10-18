"""Offline equity prewarm concurrency, deadline, and client ownership tests."""

import asyncio
from types import SimpleNamespace

import pytest

from flowmap_server.api import market_cache as market
from flowmap_server.data import universe


def _quote(symbol, i=0):
    return market.QuoteData(
        market="equity",
        symbol=symbol,
        price=100.0 + i,
        change_pct=float(i % 3 - 1),
        spark=[99.0, 100.0 + i],
        as_of_ns=1000 + i,
        stale=bool(i % 2),
        reachable=bool(i % 3),
    )


async def test_default_equity_sweep_caps_real_fetches_and_preserves_ranking(monkeypatch):
    symbols = [f"E{i}" for i in range(40)]
    monkeypatch.setattr(universe, "EQUITY_TICKERS", symbols)
    release = asyncio.Event()
    started = asyncio.Queue()
    active = 0
    maximum = 0
    quotes = {s: _quote(s, i) for i, s in enumerate(symbols)}
    calls = []

    async def fetch(symbol):
        nonlocal active, maximum
        calls.append(symbol)
        active += 1
        maximum = max(maximum, active)
        started.put_nowait(symbol)
        try:
            await release.wait()
            await asyncio.sleep(0)
            return quotes[symbol]
        finally:
            active -= 1

    monkeypatch.setattr(market, "_equity_quote", fetch)
    task = asyncio.create_task(market.default_movers_fn("equity", 40))
    try:
        assert [await asyncio.wait_for(started.get(), 1.0) for _ in range(4)] == symbols[:4]
        await asyncio.sleep(0)
        assert calls == symbols[:4] and active == 4
        release.set()
        result = await task
        expected = sorted(quotes.values(), key=lambda q: abs(q.change_pct), reverse=True)
        assert result == expected  # stable tie ordering and all quote flags/fields
        assert calls == symbols and maximum == 4 and active == 0
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)


async def test_crypto_sweep_keeps_all_candidates_with_bounded_admission(monkeypatch):
    symbols = [f"C{i}" for i in range(8)]
    monkeypatch.setattr(universe, "CRYPTO_SYMBOLS", symbols)
    release = asyncio.Event()
    started = asyncio.Queue()
    calls = []

    async def fetch(provider, symbol):
        calls.append((provider, symbol))
        started.put_nowait(symbol)
        await release.wait()
        return _quote(symbol)

    monkeypatch.setattr(market, "_crypto_quote", fetch)
    task = asyncio.create_task(market.default_movers_fn("crypto", 8))
    try:
        assert [await asyncio.wait_for(started.get(), 1.0) for _ in range(4)] == symbols[:4]
        await asyncio.sleep(0)
        assert calls == [("binance-spot", s) for s in symbols[:4]]
        release.set()
        got = await task
        assert calls == [("binance-spot", s) for s in symbols]
        assert [q.symbol for q in got] == symbols
        assert all(q.market == "binance-spot" for q in got)
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)


async def test_deadline_keeps_partial_results_and_never_starts_remaining_calls():
    symbols = ["FAST", "H1", "H2", "H3", "H4", "NEVER1", "NEVER2"]
    calls = []
    cleanup = []
    fast = _quote("FAST")

    async def fetch(symbol):
        calls.append(symbol)
        if symbol == "FAST":
            return fast
        try:
            await asyncio.Event().wait()
        finally:
            cleanup.append(symbol)

    result = await market._bounded_quote_sweep(fetch, symbols, 0.02, max_in_flight=4)
    assert result == [fast, None, None, None, None, None, None]
    assert calls == symbols[:5]
    assert sorted(cleanup) == ["H1", "H2", "H3", "H4"]
    await asyncio.sleep(0)
    assert calls == symbols[:5]  # cancelled workers cannot schedule the tail


async def test_cancelled_sweep_drains_active_fetches_without_starting_tail():
    symbols = [f"E{i}" for i in range(40)]
    started = asyncio.Queue()
    calls = []
    cleaned = []

    async def fetch(symbol):
        calls.append(symbol)
        started.put_nowait(symbol)
        try:
            await asyncio.Event().wait()
        finally:
            await asyncio.sleep(0)  # asynchronous client cleanup must finish
            cleaned.append(symbol)

    task = asyncio.create_task(market._bounded_quote_sweep(fetch, symbols, 5, max_in_flight=4))
    assert [await asyncio.wait_for(started.get(), 1.0) for _ in range(4)] == symbols[:4]
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert calls == symbols[:4] and cleaned == symbols[:4]
    await asyncio.sleep(0)
    assert calls == symbols[:4]


async def test_cleanup_cannot_replace_deadline_result_with_late_quote():
    cleaned = asyncio.Event()

    async def fetch(symbol):
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cleaned.set()
            return _quote(symbol)  # a provider that finishes during cancellation

    assert await market._bounded_quote_sweep(fetch, ["LATE", "NEVER"], 0.01, max_in_flight=1) == [
        None,
        None,
    ]
    assert cleaned.is_set()


async def test_provider_suppressing_cancellation_cannot_start_tail():
    started = asyncio.Event()
    calls = []

    async def fetch(symbol):
        calls.append(symbol)
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            return _quote(symbol)

    task = asyncio.create_task(
        market._bounded_quote_sweep(fetch, ["FIRST", "NEVER"], 5, max_in_flight=1)
    )
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 1.0)
    assert calls == ["FIRST"]


async def test_async_yahoo_history_does_not_hold_sweep_after_deadline(monkeypatch):
    from flowmap_server.feeds import _yahoo as yahoo

    started = asyncio.Queue()
    cleaned = []

    async def request(symbol):
        started.put_nowait(symbol)
        try:
            await asyncio.Event().wait()
        finally:
            cleaned.append(symbol)

    monkeypatch.setattr(yahoo, "_request_bars", request)
    monkeypatch.setattr(yahoo, "_BAR_DEADLINE_S", 0.05)
    symbols = [f"E{i}" for i in range(8)]
    task = asyncio.create_task(
        market._bounded_quote_sweep(market._equity_quote, symbols, 0.01, max_in_flight=4)
    )
    assert [await started.get() for _ in range(4)] == symbols[:4]
    # A sweep detaches promptly; the shared history request remains available
    # to a chart consumer and independently expires at its own short deadline.
    assert await asyncio.wait_for(task, 0.1) == [None] * 8
    assert cleaned == []
    state = yahoo._states[asyncio.get_running_loop()]
    await asyncio.gather(*tuple(state.tasks.values()), return_exceptions=True)
    assert sorted(cleaned) == symbols[:4] and started.empty() and not state.tasks


async def test_gex_uses_shared_gate_and_borrows_a_live_default_session(monkeypatch):
    import threading
    from datetime import UTC, datetime, timedelta
    from unittest.mock import AsyncMock, Mock

    import requests
    import yfinance as yf
    from yfinance.data import YfData

    from crocodile.equity.providers.yahoo import client as yahoo
    from flowmap_server.core.gex import (
        OptionContract,
        calculate_gex,
        fetch_options_and_calculate_gex,
    )

    data = YfData()
    original_session = data._session
    client = yahoo.YahooClient(
        rate_limiter=SimpleNamespace(acquire=AsyncMock(), update_backoff=Mock())
    )
    default_session = requests.Session()
    monkeypatch.setattr(yahoo, "_YF_DEFAULT_SESSION", default_session)
    quote_started, quote_release = threading.Event(), threading.Event()
    gex_started, gex_release = threading.Event(), threading.Event()
    quote_closed, default_closed = [], []
    default_requests = []
    expiration = datetime.now(UTC).date() + timedelta(days=30)
    expiry_ts = int(datetime.combine(expiration, datetime.min.time(), UTC).timestamp())
    payload = {
        "optionChain": {
            "result": [{
                "expirationDates": [expiry_ts],
                "quote": {"regularMarketPrice": 100.0},
                "options": [{
                    "calls": [{"strike": 110, "openInterest": 2000,
                               "impliedVolatility": 0.20}],
                    "puts": [{"strike": 90, "openInterest": 2000,
                              "impliedVolatility": 0.20}],
                }],
            }],
        },
    }

    def make_request(self, url, request_method, **kwargs):
        assert self is data
        return request_method(url=url)

    def quote_get(**kwargs):
        assert data._session is client.session
        quote_started.set()
        assert quote_release.wait(2.0), "bounded quote ownership watchdog"
        return SimpleNamespace(url="https://example.invalid/mock")

    def default_get(**kwargs):
        assert data._session is default_session and not default_closed
        default_requests.append(kwargs["url"])
        gex_started.set()
        assert gex_release.wait(2.0), "bounded GEX ownership watchdog"
        return SimpleNamespace(url="https://example.invalid/mock", json=lambda: payload)

    original_close = client.session.close

    def quote_close():
        assert gex_release.is_set() and data._session is not client.session
        quote_closed.append(True)
        original_close()

    def forbidden(*args, **kwargs):
        raise AssertionError("GEX regression attempted network I/O")

    monkeypatch.setattr(requests.Session, "request", forbidden)
    try:
        from curl_cffi.requests import Session
    except ImportError:
        pass
    else:
        monkeypatch.setattr(Session, "request", forbidden)
    monkeypatch.setattr(YfData, "_make_request", make_request)
    monkeypatch.setattr(client.session, "get", quote_get)
    monkeypatch.setattr(client.session, "close", quote_close)
    monkeypatch.setattr(default_session, "get", default_get)
    monkeypatch.setattr(default_session, "close", lambda: default_closed.append(True))

    def quote_call(session):
        ticker = yf.Ticker("QUOTE", session=session)
        assert ticker._data is data
        return ticker._data.get("https://example.invalid/mock")

    quote = asyncio.create_task(client._execute_yf_call(quote_call))
    gex = close = None
    try:
        assert await asyncio.to_thread(quote_started.wait, 2.0)
        gex = asyncio.create_task(fetch_options_and_calculate_gex("TEST", spot_price=100.0))
        await asyncio.sleep(0)
        assert not gex.done() and not default_requests
        assert data._session is client.session
        quote_release.set()
        await quote
        assert await asyncio.to_thread(gex_started.wait, 2.0)
        close = asyncio.create_task(client.close())
        await asyncio.sleep(0)  # heartbeat while close waits for the GEX worker
        assert not close.done() and not quote_closed and not default_closed
        gex_release.set()
        result = await gex
        await close
        expected = calculate_gex(
            "TEST", 100.0,
            [OptionContract(110, True, 2000, 0.20, 30),
             OptionContract(90, False, 2000, 0.20, 30)],
        )
        expected.model_provenance["options_source"] = "yfinance option chain, first six expirations"
        expected.model_provenance["spot_source"] = "caller supplied"
        assert result == expected and result.available
        assert quote_closed == [True] and not default_closed
        assert len(default_requests) == 2 and data._session is default_session
        assert await fetch_options_and_calculate_gex("TEST", spot_price=100.0) == expected
        assert len(default_requests) == 4 and not default_closed
        ticker = yf.Ticker("DEFAULT")  # actual no-explicit-session construction
        assert ticker._data._session is default_session
        ticker._data.get("https://example.invalid/mock")
        ticker.session.close()  # a separate, unused TickerBase session
        assert not default_closed
    finally:
        quote_release.set()
        gex_release.set()
        await asyncio.gather(*(t for t in (quote, gex, close) if t), return_exceptions=True)
        if not quote_closed:
            await client.close()
        with yahoo._YF_WORKER_LOCK:
            data._set_session(original_session)
        requests.Session.close(default_session)


@pytest.mark.parametrize("outcome", ["success", "empty", "error", "cancel"])
async def test_equity_quote_preserves_outcomes_from_shared_history(monkeypatch, outcome):
    from flowmap_server.feeds import _yahoo as yahoo

    started = asyncio.Event()
    bars = [
        SimpleNamespace(close=10.0, source_ts=1000, local_ts=2000),
        SimpleNamespace(close=12.0, source_ts=3000, local_ts=4000),
    ]

    async def history(symbol):
        assert symbol == "AAPL"
        started.set()
        if outcome == "error":
            raise RuntimeError("provider error")
        if outcome == "cancel":
            await asyncio.Event().wait()
        return [] if outcome == "empty" else bars

    monkeypatch.setattr(yahoo, "equity_bars", history)
    task = asyncio.create_task(market._equity_quote("aapl"))
    await started.wait()
    if outcome == "cancel":
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    elif outcome == "error":
        with pytest.raises(RuntimeError, match="provider error"):
            await task
    else:
        quote = await task
        assert quote.symbol == "AAPL" and quote.reachable
        if outcome == "empty":
            assert quote.price is None and quote.stale
        else:
            assert (quote.price, quote.change_pct, quote.spark, quote.as_of_ns) == (
                12.0, 20.0, [10.0, 12.0], 3000,
            )
