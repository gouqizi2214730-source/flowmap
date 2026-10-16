"""Fresh interpreters exercise real provider loading at each production seam."""

from __future__ import annotations

import json
import subprocess
import sys
import textwrap

import pytest


_PROBE = r'''
import asyncio
import importlib.abc
import importlib.machinery
import json
import sys
import threading
from types import SimpleNamespace

from flowmap_server.api.market_cache import _equity_quote
from flowmap_server.core.backfill import _equity_candles
from flowmap_server.feeds.equity import EquityFeed
from flowmap_server.config import Config

TARGET = "crocodile.equity.providers.yahoo.client"
assert TARGET not in sys.modules, "production import was already cached"
assert "yfinance" not in sys.modules, "heavy dependency was already cached"
main_thread = threading.get_ident()
entered = threading.Event()
release = threading.Event()
executions = []
import_calls = []
clients = []
fetches = []
bars = [SimpleNamespace(open=10.0, high=13.0, low=9.0, close=12.0,
                        volume=17.0, source_ts=123456789, local_ts=987654321)]

class Loader:
    def __init__(self, original):
        self.original = original

    def create_module(self, spec):
        return self.original.create_module(spec)

    def exec_module(self, module):
        executions.append(threading.get_ident())
        entered.set()
        assert release.wait(10), "main loop did not release cold import"
        self.original.exec_module(module)  # actual pandas/pyarrow/yfinance imports
        original_init = module.YahooClient.__init__

        def init(client, *args, **kwargs):
            assert threading.get_ident() == main_thread
            original_init(client, *args, **kwargs)
            clients.append(client)

        async def fetch(client, symbol, interval):
            fetches.append((threading.get_ident(), symbol, interval))
            return bars

        module.YahooClient.__init__ = init
        module.YahooClient.fetch_intraday_bars = fetch

class Finder:
    def find_spec(self, fullname, path=None, target=None):
        if fullname == TARGET:
            spec = importlib.machinery.PathFinder.find_spec(fullname, path)
            spec.loader = Loader(spec.loader)
            return spec

sys.meta_path.insert(0, Finder())
real_import = importlib.import_module

def counted_import(name, *args, **kwargs):
    if name == TARGET:
        import_calls.append(threading.get_ident())
    return real_import(name, *args, **kwargs)

importlib.import_module = counted_import

async def invoke(seam):
    if seam == "quote":
        quote = await _equity_quote("aapl")
        assert (quote.symbol, quote.price, quote.spark, quote.as_of_ns) == (
            "AAPL", 12.0, [12.0], 123456789)
    elif seam == "backfill":
        (candle,) = await _equity_candles("aapl", max_cols=1)
        assert (candle.t0_ns, candle.o, candle.h, candle.l, candle.c, candle.volume,
                candle.buy_volume, candle.sell_volume) == (
            123456789, 10.0, 13.0, 9.0, 12.0, 17.0, None, None)
    else:
        result = await EquityFeed("aapl", Config())._default_fetch_bars()
        assert result is bars

async def first_run():
    seam = sys.argv[1]
    tasks = [asyncio.create_task(invoke(name)) for name in (
        [seam] if seam != "concurrent-cancel" else ["quote", "backfill", "feed"])]
    ticks = 0
    try:
        for _ in range(400):
            if entered.is_set():
                break
            await asyncio.sleep(0.005)
        assert entered.is_set()
        if seam == "concurrent-cancel":
            tasks[0].cancel()
        for _ in range(8):
            ticks += 1
            await asyncio.sleep(0.005)
        assert not clients and not any(task.done() for task in tasks)
        assert executions and all(t != main_thread for t in executions)
        if seam == "concurrent-cancel":
            tasks[0].cancel()  # repeated cancellation still owns the import
            await asyncio.sleep(0)
            assert not tasks[0].done()
    finally:
        release.set()
    results = await asyncio.gather(*tasks, return_exceptions=True)
    if seam == "concurrent-cancel":
        assert isinstance(results[0], asyncio.CancelledError)
        assert results[1:] == [None, None]
        assert len(clients) == 2  # cancelled caller never constructs its client
    else:
        assert results == [None]
    for client in clients:
        await client.close()
    assert len(executions) == 1
    assert len(import_calls) == 1  # coalesced admission, not extra import-lock workers
    assert all(t == main_thread and symbol == "AAPL" and interval == "1m"
               for t, symbol, interval in fetches)
    return ticks

ticks = asyncio.run(first_run())
# A new event loop must not inherit an old loop-bound Task or Future.
asyncio.run(invoke("backfill"))
asyncio.run(clients[-1].close())
assert len(executions) == 1
assert len(import_calls) == 1
assert "pandas" in sys.modules and "yfinance" in sys.modules
print(json.dumps({"seam": sys.argv[1], "ticks_while_import_held": ticks,
                  "real_provider_exec_count": len(executions),
                  "client_count": len(clients)}))
'''


@pytest.mark.parametrize("seam", ["quote", "backfill", "feed", "concurrent-cancel"])
def test_real_cold_provider_import_stays_off_loop_and_preserves_values(seam):
    result = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(_PROBE), seam],
        capture_output=True, text=True, encoding="utf-8", timeout=40,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    proof = json.loads(result.stdout)
    assert proof["ticks_while_import_held"] == 8
    assert proof["real_provider_exec_count"] == 1
