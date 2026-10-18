"""Offline Yahoo history parsing, cache, deadline and cancellation regressions."""

import asyncio
import json
import time
from types import SimpleNamespace

import pytest

from flowmap_server.feeds import _yahoo as yahoo


STAMP = 1_792_180_740  # Fri 2026-10-16 19:59 UTC, provider bar-open timestamp


def _payload():
    return {"chart": {"error": None, "result": [{
        "timestamp": [STAMP, STAMP + 60],
        "indicators": {"quote": [{
            "open": [100.0, 101.0], "high": [102.0, 104.0],
            "low": [99.0, 100.0], "close": [101.0, 103.0], "volume": [25, 40],
        }]},
    }]}}


def _bars():
    return yahoo._parse_bars(_payload(), "AAPL", now_ns=(STAMP + 100000) * 10**9)


def test_parse_preserves_real_prices_volume_and_native_timestamps():
    bars = _bars()
    assert len(bars) == 2
    assert (bars[0].source, bars[0].symbol, bars[0].interval) == ("yahoo", "AAPL", "1m")
    assert (bars[0].open, bars[0].high, bars[0].low, bars[0].close, bars[0].volume) == (
        100.0, 102.0, 99.0, 101.0, 25.0,
    )
    assert [bar.source_ts for bar in bars] == [STAMP * 10**9, (STAMP + 60) * 10**9]


@pytest.mark.parametrize("value", [None, float("nan"), float("inf"), -2.0, 0.0])
def test_parse_never_forward_fills_invalid_price(value):
    payload = _payload()
    payload["chart"]["result"][0]["indicators"]["quote"][0]["close"][0] = value
    bars = yahoo._parse_bars(payload, "AAPL", now_ns=(STAMP + 100000) * 10**9)
    assert len(bars) == 1 and bars[0].source_ts == (STAMP + 60) * 10**9


@pytest.mark.parametrize("indicators", [None, [], "bad", {"quote": None}, {"quote": [None]}])
def test_parse_partial_unavailable_shape_is_empty(indicators):
    payload = _payload()
    payload["chart"]["result"][0]["indicators"] = indicators
    assert yahoo._parse_bars(payload, "AAPL", now_ns=(STAMP + 100000) * 10**9) == ()


async def test_concurrent_quote_chart_fetches_coalesce_and_cancel_promptly(monkeypatch):
    started, release = asyncio.Event(), asyncio.Event()
    calls = []
    bars = _bars()

    async def request(symbol):
        calls.append(symbol)
        started.set()
        await release.wait()
        return bars

    monkeypatch.setattr(yahoo, "_request_bars", request)
    quote = asyncio.create_task(yahoo.equity_bars("aapl"))
    chart = asyncio.create_task(yahoo.equity_bars("AAPL"))
    await started.wait()
    quote.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(quote, 0.1)
    assert not chart.done() and calls == ["AAPL"]
    release.set()
    assert await chart == bars
    assert await yahoo.equity_bars("AAPL") == bars and calls == ["AAPL"]


async def test_stale_cache_is_immediate_while_refresh_runs_and_survives_failure(monkeypatch):
    bars = _bars()
    loop = asyncio.get_running_loop()
    state = yahoo._BarsState()
    yahoo._states[loop] = state
    state.cache["AAPL"] = (loop.time() - 1000, bars)
    release = asyncio.Event()

    async def request(symbol):
        await release.wait()
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(yahoo, "_request_bars", request)
    assert await asyncio.wait_for(yahoo.equity_bars("AAPL"), 0.1) == bars
    task = state.tasks["AAPL"]
    assert await yahoo.equity_bars("AAPL") == bars
    assert state.tasks["AAPL"] is task
    release.set()
    await asyncio.gather(task, return_exceptions=True)
    assert state.cache["AAPL"][1] == bars and not state.tasks


async def test_total_deadline_includes_admission_and_cleans_request(monkeypatch):
    cleaned = asyncio.Event()

    async def request(symbol):
        try:
            await asyncio.Event().wait()
        finally:
            cleaned.set()

    monkeypatch.setattr(yahoo, "_BAR_DEADLINE_S", 0.02)
    monkeypatch.setattr(yahoo, "_request_bars", request)
    before = time.monotonic()
    with pytest.raises(TimeoutError):
        await yahoo.equity_bars("AAPL")
    assert time.monotonic() - before < 0.2 and cleaned.is_set()
    assert not yahoo._states[asyncio.get_running_loop()].tasks


async def test_request_reads_chunked_complete_json_and_falls_back_same_provider(monkeypatch):
    data = json.dumps(_payload()).encode()
    entered = []
    closed = []

    class Content:
        async def iter_chunked(self, size):
            for offset in range(0, len(data), 13):
                yield data[offset:offset + 13]

    class Response:
        content = Content()

        def raise_for_status(self):
            if len(entered) == 1:
                raise yahoo.aiohttp.ClientError("first Yahoo host unavailable")

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

    class Client:
        def __init__(self, **kwargs):
            pass

        def get(self, url, **kwargs):
            entered.append((url, kwargs))
            return Response()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            closed.append(True)

    monkeypatch.setattr(yahoo.aiohttp, "ClientSession", Client)
    monkeypatch.setattr(yahoo.aiohttp, "TCPConnector", lambda **kw: SimpleNamespace())
    bars = await yahoo._request_bars("BRK.B")
    assert len(bars) == 2 and bars[-1].close == 103.0
    assert "query1.finance.yahoo.com" in entered[0][0]
    assert "query2.finance.yahoo.com" in entered[1][0]
    assert entered[1][1]["params"] == {
        "interval": "1m", "range": "5d", "includePrePost": "false",
    }
    assert closed == [True]
