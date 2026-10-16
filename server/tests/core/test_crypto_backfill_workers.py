"""Offline responsiveness and ownership checks for crypto candle providers."""

from __future__ import annotations

import asyncio
import concurrent.futures
import ssl
import sys
import threading
from types import SimpleNamespace

import pytest

from flowmap_server.core import backfill

NOW = 1_700_000_000 * 10**9


def _owner():
    return threading.get_ident(), asyncio.get_running_loop()


async def _pulse_until(released: threading.Event) -> int:
    count = 0
    while not released.is_set():
        count += 1
        await asyncio.sleep(0.005)
    return count


async def _wait_for(predicate):
    async with asyncio.timeout(2.0):
        while not predicate():
            await asyncio.sleep(0.005)


def _native_spies(monkeypatch, context, *, close_hold=None):
    import aiohttp

    events = []

    class Session:
        def __init__(self, *, connector, timeout):
            events.append(("create", _owner(), connector.ssl, timeout.total))

        async def close(self):
            if close_hold:
                events.append(("closing", _owner()))
                await close_hold.wait()
            events.append(("close", _owner()))

    def connector(*, ssl):
        events.append(("connector", _owner()))
        assert ssl is context
        return SimpleNamespace(ssl=ssl)

    async def records(*args, **kwargs):
        events.append(("request", _owner()))
        yield SimpleNamespace(source_ts=NOW, local_ts=NOW + 1, open=1, high=3,
                              low=1, close=2, volume=10, buy_volume=None, sell_volume=6)

    monkeypatch.setattr(aiohttp, "TCPConnector", connector)
    monkeypatch.setattr(aiohttp, "ClientSession", Session)
    monkeypatch.setattr("crocodile.crypto.client.backfill.iter_backfill", records)
    return events


async def test_concurrent_native_ca_is_off_loop_coalesced_and_sessions_stay_owned(monkeypatch):
    import certifi

    server = _owner()
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    events = _native_spies(monkeypatch, context)
    released = threading.Event()
    calls = []

    def slow_ca(*, cafile):
        calls.append((threading.get_ident(), cafile))
        assert released.wait(1.0), "CA construction watchdog"
        return context

    monkeypatch.setattr(backfill, "_CA_CONTEXT_FUTURES", {}, raising=False)
    monkeypatch.setattr(ssl, "create_default_context", slow_ca)
    pulse = asyncio.create_task(_pulse_until(released))
    timer = threading.Timer(0.15, released.set)
    timer.start()
    try:
        requests = [backfill._native_candles("binance", "BTCUSDT", "spot",
                    interval="1m", max_bars=1, now_ns=NOW) for _ in range(5)]
        got = await asyncio.gather(*requests)
        assert await pulse >= 5, "server heartbeat stopped during CA loading"
        assert calls == [(calls[0][0], certifi.where())] and calls[0][0] != server[0]
        assert context.check_hostname and context.verify_mode == ssl.CERT_REQUIRED
        assert all(event[1] == server for event in events)
        assert sum(event[0] == "close" for event in events) == 5
        assert all(row == [backfill.Candle(NOW, 1, 3, 1, 2, 10, None, 6)] for row in got)
        await backfill._native_candles("binance", "BTCUSDT", "coinm",
                                      interval="1m", max_bars=1, now_ns=NOW)
        assert len(calls) == 1
    finally:
        released.set()
        timer.join()
        await pulse


def _ccxt_fake(monkeypatch, *, hold=None, error=None, supported=True, listed=True,
               fetch_hold=None, close_hold=None, constructor_hold=None, rows=None):
    import ccxt.async_support as ccxt_async

    events = []
    kwargs = []

    class Exchange:
        def __init__(self, options):
            events.append(("create", _owner()))
            if constructor_hold:
                assert constructor_hold.wait(1.0), "constructor watchdog"
            if error == "create":
                raise ValueError("constructor failure")
            kwargs.append(options)
            self.has = {"fetchOHLCV": supported}
            self.markets_by_id = {}

        async def load_markets(self):
            events.append(("load", _owner()))
            if hold:
                assert hold.wait(1.0), "metadata watchdog"
            if error == "load":
                raise ValueError("metadata failure")
            return {"BTC/USDT": {}} if listed else {}

        async def fetch_ohlcv(self, symbol, interval, *, since, limit):
            events.append(("fetch", _owner(), symbol, interval, since, limit))
            if fetch_hold:
                while not fetch_hold.is_set():
                    await asyncio.sleep(0.005)
            if error == "fetch":
                raise ValueError("fetch failure")
            return rows if rows is not None else [[NOW // 10**6, 1, 3, 1, 2, 10]]

        async def close(self):
            events.append(("closing", _owner()))
            if close_hold:
                while not close_hold.is_set():
                    await asyncio.sleep(0.005)
            events.append(("close", _owner()))
            if error == "close":
                raise ValueError("close failure")

    monkeypatch.setattr(ccxt_async, "binance", Exchange)
    monkeypatch.setattr("flowmap_server.data.venues.ccxt_knows", lambda exchange: True)
    return events, kwargs


@pytest.mark.parametrize("phase", ["create", "load"])
async def test_ccxt_metadata_heartbeat_and_entire_sdk_lifecycle_are_worker_owned(monkeypatch, phase):
    server = _owner()
    released = threading.Event()
    events, kwargs = _ccxt_fake(monkeypatch, **{
        "constructor_hold" if phase == "create" else "hold": released,
    })
    pulse = asyncio.create_task(_pulse_until(released))
    timer = threading.Timer(0.15, released.set)
    timer.start()
    try:
        result = await backfill._ccxt_candles("binance", "BTCUSDT", "usdm",
                                             interval="1h", max_bars=25, now_ns=NOW)
        assert await pulse >= 5, "server heartbeat stopped during ccxt metadata parsing"
        owners = {event[1] for event in events}
        assert len(owners) == 1 and server not in owners
        assert [event[0] for event in events] == ["create", "load", "fetch", "closing", "close"]
        assert result == [backfill.Candle(NOW, 1, 3, 1, 2, 10)]
        assert kwargs == [{"enableRateLimit": True, "timeout": 15000,
                           "options": {"defaultType": "swap"}}]
        assert events[2][2:] == ("BTC/USDT", "1h", (NOW - 25 * 3600 * 10**9) // 10**6, 25)
    finally:
        released.set()
        timer.join()
        await pulse


async def test_real_certifi_context_keeps_certificate_and_hostname_validation(monkeypatch):
    monkeypatch.setattr(backfill, "_CA_CONTEXT_FUTURES", {})
    _, session = await backfill._hardened_backfill("binance", "spot")
    try:
        context = session.connector._ssl
        assert context.check_hostname and context.verify_mode == ssl.CERT_REQUIRED
        assert context.cert_store_stats()["x509_ca"] > 0
        assert session.timeout.total == 15.0
    finally:
        await session.close()


async def test_ca_failure_is_shared_without_sessions_and_later_request_retries(monkeypatch):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    events = _native_spies(monkeypatch, context)
    entered, released = threading.Event(), threading.Event()
    calls = []
    failing = True

    def factory(*, cafile):
        calls.append(cafile)
        entered.set()
        assert released.wait(1.0), "CA failure watchdog"
        if failing:
            raise ValueError("trust bundle failure")
        return context

    monkeypatch.setattr(backfill, "_CA_CONTEXT_FUTURES", {})
    monkeypatch.setattr(ssl, "create_default_context", factory)
    tasks = [asyncio.create_task(backfill._native_candles(
        "binance", "BTCUSDT", "spot", interval="1m", max_bars=1, now_ns=NOW,
    )) for _ in range(5)]
    try:
        await _wait_for(entered.is_set)
        await asyncio.sleep(0.02)
        assert not events and len(calls) == 1
        released.set()
        errors = await asyncio.gather(*tasks, return_exceptions=True)
        assert all(isinstance(error, ValueError) for error in errors)
        assert not events and len(calls) == 1
        failing = False
        await backfill._native_candles("binance", "BTCUSDT", "spot",
                                      interval="1m", max_bars=1, now_ns=NOW)
        assert len(calls) == 2 and [event[0] for event in events] == [
            "connector", "create", "request", "close",
        ]
    finally:
        released.set()
        await asyncio.gather(*tasks, return_exceptions=True)


async def test_cancel_during_shared_ca_drains_without_creating_cancelled_session(monkeypatch):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    events = _native_spies(monkeypatch, context)
    entered, released = threading.Event(), threading.Event()
    calls = []

    def factory(*, cafile):
        calls.append(cafile)
        entered.set()
        assert released.wait(1.0), "CA cancellation watchdog"
        return context

    monkeypatch.setattr(backfill, "_CA_CONTEXT_FUTURES", {})
    monkeypatch.setattr(ssl, "create_default_context", factory)
    first = asyncio.create_task(backfill._native_candles(
        "binance", "BTCUSDT", "spot", interval="1m", max_bars=1, now_ns=NOW,
    ))
    second = asyncio.create_task(backfill._native_candles(
        "binance", "ETHUSDT", "spot", interval="1m", max_bars=1, now_ns=NOW,
    ))
    try:
        await _wait_for(entered.is_set)
        first.cancel()
        await asyncio.sleep(0)
        first.cancel()
        await asyncio.sleep(0.02)
        assert not first.done() and not events
        released.set()
        with pytest.raises(asyncio.CancelledError):
            await first
        assert await second == [backfill.Candle(NOW, 1, 3, 1, 2, 10, None, 6)]
        assert len(calls) == 1 and sum(event[0] == "create" for event in events) == 1
        assert sum(event[0] == "close" for event in events) == 1
    finally:
        released.set()
        await asyncio.gather(first, second, return_exceptions=True)


async def test_native_factory_failure_closes_session_on_owner_loop(monkeypatch):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    events = _native_spies(monkeypatch, context)

    async def ca(cafile):
        return context

    def bad_factory(**kwargs):
        raise ValueError("native constructor failure")

    monkeypatch.setattr(backfill, "_certifi_context", ca)
    monkeypatch.setattr("crocodile.crypto.exchanges.binance.backfill.BinanceBackfill", bad_factory)
    with pytest.raises(ValueError, match="native constructor failure"):
        await backfill._hardened_backfill("binance", "spot")
    assert [event[0] for event in events] == ["connector", "create", "close"]
    assert all(event[1] == _owner() for event in events)


async def test_missing_dependency_keeps_engine_default_fallback(monkeypatch):
    monkeypatch.setitem(sys.modules, "certifi", None)
    assert await backfill._hardened_backfill("binance", "spot") == (None, None)


async def test_native_request_cancellation_drains_held_close_after_repeated_cancel(monkeypatch):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    close_release = asyncio.Event()
    events = _native_spies(monkeypatch, context, close_hold=close_release)
    entered = asyncio.Event()

    async def ca(cafile):
        return context

    async def records(*args, **kwargs):
        entered.set()
        await asyncio.Event().wait()
        yield  # pragma: no cover — cancelled native request has no data

    monkeypatch.setattr(backfill, "_certifi_context", ca)
    monkeypatch.setattr("crocodile.crypto.client.backfill.iter_backfill", records)
    task = asyncio.create_task(backfill._native_candles(
        "binance", "BTCUSDT", "spot", interval="1m", max_bars=1, now_ns=NOW,
    ))
    try:
        await entered.wait()
        task.cancel()
        await _wait_for(lambda: any(event[0] == "closing" for event in events))
        task.cancel()
        await asyncio.sleep(0.01)
        assert not task.done()
        close_release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert sum(event[0] == "close" for event in events) == 1
        assert all(event[1] == _owner() for event in events)
    finally:
        close_release.set()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize("native", ["success", "empty", "error", "unavailable"])
async def test_actual_ccxt_worker_keeps_native_first_fallback_routes(monkeypatch, native):
    events, _ = _ccxt_fake(monkeypatch)
    server = _owner()
    native_calls = []
    native_row = backfill.Candle(NOW + 1, 1, 3, 1, 2, 10, 4, 6)

    async def identity(market, symbol):
        assert _owner() == server
        return symbol

    async def fetch(*args, **kwargs):
        assert _owner() == server
        native_calls.append((args, kwargs))
        if native == "error":
            raise ValueError("native endpoint failure")
        return [native_row] if native == "success" else []

    monkeypatch.setattr("flowmap_server.data.venues.resolve_symbol", identity)
    monkeypatch.setattr(backfill, "_native_candles", fetch)
    if native == "unavailable":
        monkeypatch.setattr("crocodile.crypto.client.backfill.SUPPORTED_CHANNELS", {})
    result = await backfill.crypto_klines("binance-usdm", "BTCUSDT",
                                         interval="1m", max_bars=1, now_ns=NOW)
    if native == "success":
        assert result == [native_row] and not events
    else:
        assert result == [backfill.Candle(NOW, 1, 3, 1, 2, 10, None, None)]
        assert sum(event[0] == "close" for event in events) == 1
        assert all(event[1] != server for event in events)
    assert len(native_calls) == (0 if native == "unavailable" else 1)


@pytest.mark.parametrize("phase", ["create", "load", "fetch", "close"])
async def test_ccxt_errors_propagate_and_created_clients_close_once(monkeypatch, phase):
    events, _ = _ccxt_fake(monkeypatch, error=phase)
    with pytest.raises(ValueError, match="failure"):
        await backfill._ccxt_candles("binance", "BTCUSDT", "spot",
                                     interval="1m", max_bars=1, now_ns=NOW)
    assert sum(event[0] == "close" for event in events) == (0 if phase == "create" else 1)
    assert len({event[1] for event in events}) == 1 and events[0][1] != _owner()


@pytest.mark.parametrize("reason", ["unsupported", "absent", "unknown"])
async def test_ccxt_unavailable_paths_keep_empty_results_and_close(monkeypatch, reason):
    events, _ = _ccxt_fake(monkeypatch, supported=reason != "unsupported", listed=reason != "absent")
    if reason == "unknown":
        monkeypatch.setattr("flowmap_server.data.venues.ccxt_knows", lambda exchange: False)
    assert await backfill._ccxt_candles("binance", "BTCUSDT", "spot",
                                      interval="1m", max_bars=1, now_ns=NOW) == []
    assert not any(event[0] == "fetch" for event in events)
    assert sum(event[0] == "close" for event in events) == (0 if reason == "unknown" else 1)


async def test_ccxt_genuine_rows_timestamp_cap_missing_fields_and_absent_split(monkeypatch):
    _ccxt_fake(monkeypatch, rows=[
        [1, 1, 2, 1, 2, 10], [2, None, 2, 1, 2, 10], [3, 1, 3, 1, 2, None],
    ])
    assert await backfill._ccxt_candles("binance", "BTCUSDT", "spot",
                                      interval="1m", max_bars=2, now_ns=NOW) == [
        backfill.Candle(3 * 10**6, 1, 3, 1, 2, 0, None, None),
    ]


async def test_running_ccxt_cancellation_stops_fetch_and_drains_close_despite_repeated_cancel(monkeypatch):
    metadata_release, close_release = threading.Event(), threading.Event()
    events, _ = _ccxt_fake(monkeypatch, hold=metadata_release, close_hold=close_release)
    task = asyncio.create_task(backfill._ccxt_candles(
        "binance", "BTCUSDT", "spot", interval="1m", max_bars=1, now_ns=NOW,
    ))
    try:
        await _wait_for(lambda: any(event[0] == "load" for event in events))
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0.02)
        assert not task.done()
        metadata_release.set()
        await _wait_for(lambda: any(event[0] == "closing" for event in events))
        task.cancel()
        await asyncio.sleep(0.02)
        assert not task.done() and not any(event[0] == "fetch" for event in events)
        close_release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert sum(event[0] == "close" for event in events) == 1
    finally:
        metadata_release.set()
        close_release.set()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize("phase", ["fetch", "close"])
async def test_ccxt_cancellation_during_async_io_or_close_still_finishes_owned_close(monkeypatch, phase):
    fetch_release, close_release = threading.Event(), threading.Event()
    if phase == "close":
        fetch_release.set()
    events, _ = _ccxt_fake(monkeypatch, fetch_hold=fetch_release, close_hold=close_release)
    task = asyncio.create_task(backfill._ccxt_candles(
        "binance", "BTCUSDT", "spot", interval="1m", max_bars=1, now_ns=NOW,
    ))
    try:
        await _wait_for(lambda: any(event[0] == ("fetch" if phase == "fetch" else "closing")
                                  for event in events))
        task.cancel()
        await _wait_for(lambda: any(event[0] == "closing" for event in events))
        assert not task.done()
        close_release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert sum(event[0] == "close" for event in events) == 1
    finally:
        fetch_release.set()
        close_release.set()
        await asyncio.gather(task, return_exceptions=True)


async def test_queued_ccxt_cancellation_never_constructs_later_client(monkeypatch):
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    monkeypatch.setattr(backfill, "_CCXT_EXECUTOR", executor)
    fetch_release = threading.Event()
    events, _ = _ccxt_fake(monkeypatch, fetch_hold=fetch_release)
    first = asyncio.create_task(backfill._ccxt_candles(
        "binance", "BTCUSDT", "spot", interval="1m", max_bars=1, now_ns=NOW,
    ))
    second = None
    try:
        await _wait_for(lambda: any(event[0] == "fetch" for event in events))
        second = asyncio.create_task(backfill._ccxt_candles(
            "binance", "ETHUSDT", "spot", interval="1m", max_bars=1, now_ns=NOW,
        ))
        await asyncio.sleep(0.02)
        second.cancel()
        with pytest.raises(asyncio.CancelledError):
            await second
        fetch_release.set()
        assert await first == [backfill.Candle(NOW, 1, 3, 1, 2, 10)]
        assert sum(event[0] == "create" for event in events) == 1
        assert sum(event[0] == "close" for event in events) == 1
    finally:
        fetch_release.set()
        await asyncio.gather(*(task for task in (first, second) if task), return_exceptions=True)
        executor.shutdown()


async def test_symbol_resolution_shared_task_remains_server_owned_before_actual_workers(monkeypatch):
    from flowmap_server.feeds import crypto

    monkeypatch.setattr(crypto, "_RESOLVED_SYMBOLS", {})
    monkeypatch.setattr(crypto, "_PENDING_RESOLVES", {})
    server = _owner()
    release = asyncio.Event()
    translations = []
    events, _ = _ccxt_fake(monkeypatch)

    async def translate(market, symbol):
        translations.append(_owner())
        await release.wait()
        return "BTCUSDT"

    async def no_native(*args, **kwargs):
        assert _owner() == server
        return []

    monkeypatch.setattr("flowmap_server.data.venues.resolve_symbol", translate)
    monkeypatch.setattr(backfill, "_native_candles", no_native)
    tasks = [asyncio.create_task(backfill.crypto_klines(
        "binance-spot", "BTC/USDT", interval="1m", max_bars=1, now_ns=NOW,
    )) for _ in range(2)]
    try:
        await _wait_for(lambda: bool(translations))
        assert len(crypto._PENDING_RESOLVES) == 1
        assert all(task.get_loop() is server[1] for task in crypto._PENDING_RESOLVES.values())
        release.set()
        assert await asyncio.gather(*tasks) == [[backfill.Candle(NOW, 1, 3, 1, 2, 10)]] * 2
        assert translations == [server] and not crypto._PENDING_RESOLVES
        assert all(event[1] != server for event in events)
    finally:
        release.set()
        await asyncio.gather(*tasks, return_exceptions=True)


def test_two_server_loops_share_context_but_never_sdk_loops_or_sessions(monkeypatch):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    native_events = _native_spies(monkeypatch, context)
    ccxt_events, _ = _ccxt_fake(monkeypatch)
    ca_calls = []
    monkeypatch.setattr(backfill, "_CA_CONTEXT_FUTURES", {})
    monkeypatch.setattr(ssl, "create_default_context", lambda **kw: ca_calls.append(kw) or context)

    async def request():
        owner = _owner()
        await backfill._native_candles("binance", "BTCUSDT", "spot",
                                      interval="1m", max_bars=1, now_ns=NOW)
        await backfill._ccxt_candles("binance", "BTCUSDT", "spot",
                                    interval="1m", max_bars=1, now_ns=NOW)
        return owner

    servers = [asyncio.run(request()), asyncio.run(request())]
    assert servers[0][1] is not servers[1][1] and len(ca_calls) == 1
    assert {event[1] for event in native_events} == set(servers)
    worker_owners = {event[1] for event in ccxt_events}
    assert len(worker_owners) == 2 and not worker_owners.intersection(servers)
    assert all(owner[1].is_closed() for owner in worker_owners)


def test_concurrent_server_loops_coalesce_initial_ca_without_loop_bound_futures(monkeypatch):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    events = _native_spies(monkeypatch, context)
    calls = []
    released = threading.Event()

    def ca(**kwargs):
        calls.append(threading.get_ident())
        assert released.wait(1.0), "cross-loop CA watchdog"
        return context

    monkeypatch.setattr(backfill, "_CA_CONTEXT_FUTURES", {})
    monkeypatch.setattr(ssl, "create_default_context", ca)

    async def request():
        owner = _owner()
        result = await backfill._native_candles("binance", "BTCUSDT", "spot",
                                               interval="1m", max_bars=1, now_ns=NOW)
        assert result == [backfill.Candle(NOW, 1, 3, 1, 2, 10, None, 6)]
        return owner

    timer = threading.Timer(0.15, released.set)
    timer.start()
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            requests = [executor.submit(asyncio.run, request()) for _ in range(2)]
            servers = {request.result(timeout=2.0) for request in requests}
        assert len(servers) == 2 and len(calls) == 1
        assert {event[1] for event in events} == servers
        assert sum(event[0] == "close" for event in events) == 2
    finally:
        released.set()
        timer.join()


@pytest.mark.parametrize("cancel_again", [False, True])
async def test_sweep_deadline_stops_admission_discards_late_workers_and_drains_cleanup(monkeypatch, cancel_again):
    from flowmap_server.api.market_cache import QuoteData, _bounded_quote_sweep

    fetch_release, close_release = threading.Event(), threading.Event()
    events, _ = _ccxt_fake(monkeypatch, fetch_hold=fetch_release, close_hold=close_release)
    admitted = []

    async def fetch(symbol):
        admitted.append(symbol)
        rows = await backfill._ccxt_candles("binance", "BTCUSDT", "spot",
                                            interval="1m", max_bars=1, now_ns=NOW)
        return QuoteData("binance-spot", symbol, rows[-1].c, 1)

    task = asyncio.create_task(_bounded_quote_sweep(fetch, [str(i) for i in range(40)],
                                                  0.1, max_in_flight=4))
    try:
        await _wait_for(lambda: sum(event[0] == "closing" for event in events) == 4)
        assert admitted == ["0", "1", "2", "3"] and not task.done()
        if cancel_again:
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            await asyncio.sleep(0.02)
            assert not task.done()
        close_release.set()
        if cancel_again:
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            assert await task == [None] * 40
        assert admitted == ["0", "1", "2", "3"]
        assert sum(event[0] == "create" for event in events) == 4
        assert sum(event[0] == "close" for event in events) == 4
    finally:
        fetch_release.set()
        close_release.set()
        await asyncio.gather(task, return_exceptions=True)
