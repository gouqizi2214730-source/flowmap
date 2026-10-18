"""Fresh interpreters pin the lightweight production Yahoo minute-history seams."""

from __future__ import annotations

import json
import subprocess
import sys
import textwrap


_PROBE = r'''
import asyncio
import json
import sys
from types import SimpleNamespace
from flowmap_server.api.market_cache import _equity_quote
from flowmap_server.core.backfill import _equity_candles
from flowmap_server.feeds.equity import EquityFeed
from flowmap_server.config import Config
from flowmap_server.feeds import _yahoo as yahoo

bars = (SimpleNamespace(open=10., high=13., low=9., close=12., volume=17.,
                        source_ts=1700000000000000000, local_ts=1700000000000000123),)
requests = []
started = release = None

async def request(symbol):
    requests.append(symbol)
    started.set()
    await release.wait()
    return bars

yahoo._request_bars = request

async def invoke(seam):
    if seam == "quote":
        quote = await _equity_quote("aapl")
        assert (quote.symbol, quote.price, quote.spark, quote.as_of_ns) == (
            "AAPL", 12., [12.], 1700000000000000000)
    elif seam == "backfill":
        (candle,) = await _equity_candles("aapl", max_cols=1)
        assert (candle.t0_ns, candle.o, candle.h, candle.l, candle.c, candle.volume,
                candle.buy_volume, candle.sell_volume) == (
            1700000000000000000, 10., 13., 9., 12., 17., None, None)
    else:
        assert await EquityFeed("aapl", Config())._default_fetch_bars() is bars

async def first_run():
    global started, release
    started, release = asyncio.Event(), asyncio.Event()
    tasks = [asyncio.create_task(invoke(name)) for name in ["quote", "backfill", "feed"]]
    await started.wait()
    for _ in range(8):
        await asyncio.sleep(0)
    assert requests == ["AAPL"] and not any(task.done() for task in tasks)
    tasks[0].cancel()
    try:
        await asyncio.wait_for(tasks[0], .1)
        raise AssertionError("cancelled quote returned")
    except asyncio.CancelledError:
        pass
    assert not any(task.done() for task in tasks[1:])
    release.set()
    await asyncio.gather(*tasks[1:])
    assert "crocodile.equity.providers.yahoo.client" not in sys.modules
    assert "pandas" not in sys.modules and "yfinance" not in sys.modules

asyncio.run(first_run())
async def second_run():
    global started, release
    started, release = asyncio.Event(), asyncio.Event()
    release.set()
    await invoke("backfill")
asyncio.run(second_run())
assert requests == ["AAPL", "AAPL"]
print(json.dumps({"requests": len(requests), "heavy_imports": False}))
'''


def test_production_minute_history_is_coalesced_cancellable_and_has_no_heavy_imports():
    result = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(_PROBE)], capture_output=True,
        text=True, encoding="utf-8", timeout=20,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads(result.stdout) == {"requests": 2, "heavy_imports": False}
