"""Coalesced cold Yahoo imports, with no server-loop import-lock wait."""

from __future__ import annotations

import asyncio
import concurrent.futures
import importlib
import threading
import time
import math
import ssl
import weakref
from collections import OrderedDict
from urllib.parse import quote

import aiohttp
import certifi

from crocodile.core.schema.enums import AssetClass
from crocodile.core.schema.records import OHLCV

from flowmap_server.feeds.base import ts_ns_sane

_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="yahoo-import")
_lock = threading.Lock()
_imports: concurrent.futures.Future | None = None


def _import_types():
    return (
        importlib.import_module("crocodile.equity.providers.yahoo.client"),
        importlib.import_module("crocodile.core.scheduler.calendar"),
    )


async def yahoo_types():
    """Return provider/calendar classes; clients keep their current loop owner.

    Share a concurrent future, not a loop-bound Task, across first callers.
    Cancellation drains an already admitted import before propagating; Python
    imports cannot be interrupted safely. Failed imports may be retried.
    """
    global _imports
    with _lock:
        if _imports is None or (_imports.done() and _imports.exception() is not None):
            _imports = _executor.submit(_import_types)
        imported = _imports
    future = asyncio.wrap_future(imported)
    try:
        yahoo, calendar = await asyncio.shield(future)
    except asyncio.CancelledError:
        while not future.done():
            try:
                await asyncio.shield(future)
            except asyncio.CancelledError:
                pass
            except Exception:
                break
        if not future.cancelled():
            future.exception()
        raise
    # Read current module attributes so instrumentation/embedders can still
    # replace a provider class; this does not re-enter the import machinery.
    return yahoo.YahooClient, calendar.USMarketCalendar


# The keyless chart, picker quote and reconstructed-history callers all need
# the same small data set. Use Yahoo's chart response directly, as yfinance's
# history.py does, without importing pandas/yfinance or entering their shared
# blocking cookie/session worker. These are sampled 1m bars, never a tick tape.
# Endpoint/parameters: github.com/ranaroussi/yfinance/blob/main/yfinance/scrapers/history.py
_BAR_FRESH_S = 60.0
_BAR_DEADLINE_S = 6.0
_BAR_CACHE_SIZE = 64
_BAR_MAX_REQUESTS = 8
_BAR_MAX_INFLIGHT = 32
_BAR_RESPONSE_LIMIT = 2_000_000
_states: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()
_ssl_context: ssl.SSLContext | None = None


class _BarsState:
    def __init__(self) -> None:
        self.cache: OrderedDict[str, tuple[float, tuple[OHLCV, ...]]] = OrderedDict()
        self.tasks: dict[str, asyncio.Task] = {}
        self.slots = asyncio.Semaphore(_BAR_MAX_REQUESTS)


def _parse_bars(data: object, symbol: str, *, now_ns: int) -> tuple[OHLCV, ...]:
    """Decode only published, complete OHLCV rows; never fill null gaps."""
    if not isinstance(data, dict):
        raise ValueError("invalid Yahoo chart response")
    chart = data.get("chart")
    if not isinstance(chart, dict) or chart.get("error"):
        raise ValueError("Yahoo chart unavailable")
    result = chart.get("result")
    if not isinstance(result, list) or not result or not isinstance(result[0], dict):
        return ()
    row = result[0]
    timestamps = row.get("timestamp")
    indicators = row.get("indicators")
    quotes = indicators.get("quote") if isinstance(indicators, dict) else None
    if not isinstance(timestamps, list) or not isinstance(quotes, list) or not quotes or not isinstance(quotes[0], dict):
        return ()
    values = quotes[0]
    names = ("open", "high", "low", "close", "volume")
    if any(not isinstance(values.get(name), list) for name in names):
        return ()
    out: dict[int, OHLCV] = {}
    for i, stamp in enumerate(timestamps):
        try:
            if isinstance(stamp, bool) or not isinstance(stamp, (int, float)):
                continue
            ts = int(stamp * 1_000_000_000)
            prices = [float(values[name][i]) for name in names]
            o, h, l, c, volume = prices
        except (TypeError, ValueError, OverflowError, IndexError):
            continue
        if not ts_ns_sane(ts, now_ns=now_ns) or not all(math.isfinite(v) for v in prices):
            continue
        if min(o, h, l, c) <= 0.0 or volume < 0.0 or h < max(o, l, c) or l > min(o, h, c):
            continue
        out[ts] = OHLCV(
            source="yahoo", symbol=symbol, symbol_raw=symbol,
            source_ts=ts, local_ts=now_ns, asset_class=AssetClass.EQUITY,
            interval="1m", open=o, high=h, low=l, close=c, volume=volume,
            vwap=None, num_trades=None,
        )
    return tuple(out[ts] for ts in sorted(out))


async def _request_bars(symbol: str) -> tuple[OHLCV, ...]:
    global _ssl_context
    if _ssl_context is None:
        # Local CA construction only; avoids platform-specific system roots.
        _ssl_context = ssl.create_default_context(cafile=certifi.where())
    timeout = aiohttp.ClientTimeout(total=3.0, connect=1.5)
    async with aiohttp.ClientSession(
        timeout=timeout, headers={"User-Agent": "Mozilla/5.0"},
        connector=aiohttp.TCPConnector(ssl=_ssl_context),
    ) as client:
        last_error: Exception | None = None
        for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com"):
            try:
                async with client.get(
                    f"https://{host}/v8/finance/chart/{quote(symbol, safe='')}",
                    params={"interval": "1m", "range": "5d", "includePrePost": "false"},
                ) as response:
                    response.raise_for_status()
                    chunks = []
                    size = 0
                    async for chunk in response.content.iter_chunked(64_000):
                        size += len(chunk)
                        if size > _BAR_RESPONSE_LIMIT:
                            raise ValueError("Yahoo chart response too large")
                        chunks.append(chunk)
                    import json

                    bars = _parse_bars(json.loads(b"".join(chunks)), symbol, now_ns=time.time_ns())
                    if bars:
                        return bars
            except (aiohttp.ClientError, TimeoutError, ValueError) as exc:
                last_error = exc
        if last_error is not None:
            raise last_error
        return ()


async def equity_bars(symbol: str) -> tuple[OHLCV, ...]:
    """Bounded shared Yahoo minute history, with immediate cached re-selection.

    A stale cache remains truthful at its original provider timestamps and is
    returned while one background refresh runs. Cancellation detaches only the
    caller: other quote/chart consumers retain their one shared request, which
    is itself limited to six seconds including admission. No loop-bound task
    or aiohttp session survives into a different event loop.
    """
    symbol = symbol.upper()
    if not symbol or len(symbol) > 64:
        raise ValueError("invalid equity symbol")
    loop = asyncio.get_running_loop()
    state = _states.setdefault(loop, _BarsState())
    cached = state.cache.get(symbol)
    if cached is not None:
        state.cache.move_to_end(symbol)
        if loop.time() - cached[0] < _BAR_FRESH_S:
            return cached[1]
    task = state.tasks.get(symbol)
    if task is None:
        if len(state.tasks) >= _BAR_MAX_INFLIGHT:
            if cached is not None:
                return cached[1]
            raise RuntimeError("equity history request capacity reached")

        async def refresh():
            try:
                async with asyncio.timeout(_BAR_DEADLINE_S):
                    async with state.slots:
                        bars = await _request_bars(symbol)
                # An empty/error response cannot erase a usable prior session.
                if bars:
                    state.cache[symbol] = (loop.time(), bars)
                    state.cache.move_to_end(symbol)
                    while len(state.cache) > _BAR_CACHE_SIZE:
                        state.cache.popitem(last=False)
                return bars or (cached[1] if cached else ())
            finally:
                state.tasks.pop(symbol, None)

        task = asyncio.create_task(refresh(), name=f"equity-history:{symbol}")
        state.tasks[symbol] = task
        # A stale refresh may have no waiter. Retrieve its exception, retaining
        # the old data, so an unavailable provider cannot produce task warnings.
        task.add_done_callback(lambda done: None if done.cancelled() else done.exception())
    if cached is not None:
        return cached[1]
    return await asyncio.shield(task)
