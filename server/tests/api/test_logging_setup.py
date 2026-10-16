"""Production root/Uvicorn output stays off the request loop even with a stuck sink."""

from __future__ import annotations

import asyncio
import builtins
import io
import logging
import re
import socket
import threading
import time

import httpx
import pytest
import uvicorn

from flowmap_server import __main__ as entry
from flowmap_server import logging_setup as setup


class HeldStream(io.StringIO):
    def __init__(self):
        super().__init__()
        self.started = threading.Event()
        self.release = threading.Event()
        self.threads = []

    def flush(self):
        self.threads.append(threading.get_ident())
        self.started.set()
        if not self.release.wait(10):
            raise RuntimeError("test did not release the output stream")
        super().flush()


@pytest.fixture
def logging_output(monkeypatch):
    assert setup._state is None
    streams = []

    def configure(level="info", path=None, *, held=False, capacity=2048):
        stream = HeldStream() if held else io.StringIO()
        streams.append(stream)
        monkeypatch.setattr(setup.sys, "stderr", stream)
        monkeypatch.setattr(setup, "_QUEUE_CAPACITY", capacity)
        output = entry.configure_logging(level, path)
        return output, stream

    yield configure
    for stream in streams:
        if isinstance(stream, HeldStream):
            stream.release.set()
    assert setup.shutdown_logging(5), "test leaked a logging output thread"
    assert all(not stream.closed for stream in streams)


def test_file_format_exceptions_and_deferred_message_formatting(logging_output, tmp_path):
    path = tmp_path / "server.log"
    output, stream = logging_output(path=str(path))
    producer = threading.get_ident()
    formatted = []

    class Message:
        def __str__(self):
            formatted.append(threading.get_ident())
            return "refused subscribe: session limit reached"

    logging.getLogger("flowmap_server.api.ws").warning("%s", Message())
    try:
        raise ValueError("provider detail")
    except ValueError:
        logging.getLogger("uvicorn.error").exception("request failed %s", "honestly")
    assert setup.shutdown_logging(5)
    text = path.read_text(encoding="utf-8")
    assert text == stream.getvalue()
    assert re.search(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d WARNING flowmap_server.api.ws:", text)
    assert "refused subscribe: session limit reached" in text
    assert "uvicorn.error: request failed honestly" in text
    assert "Traceback (most recent call last)" in text and "ValueError: provider detail" in text
    assert formatted and set(formatted) == {output.thread.ident} and producer not in formatted


def test_levels_idempotency_and_borrowed_logger_restoration(logging_output):
    names = ("", "uvicorn", "uvicorn.error", "uvicorn.access", "other-library")
    before = [(logging.getLogger(name), logging.getLogger(name).handlers[:],
               logging.getLogger(name).level, logging.getLogger(name).propagate,
               logging.getLogger(name).disabled) for name in names]
    unrelated = before[-1]
    output, stream = logging_output("warning")
    assert entry.configure_logging("debug", "ignored-second-call.log") is output
    for name in names[:-1]:
        logger = logging.getLogger(name)
        assert logger.handlers == [output.handler] and logger.level == logging.WARNING
        logger.info("filtered info")
        logger.warning("useful %s", name or "root")
    assert (unrelated[0].handlers, unrelated[0].level, unrelated[0].propagate,
            unrelated[0].disabled) == unrelated[1:]
    assert setup.shutdown_logging(5)
    assert "filtered info" not in stream.getvalue()
    assert stream.getvalue().count("useful") == 4
    for logger, handlers, level, propagate, disabled in before:
        assert (logger.handlers, logger.level, logger.propagate, logger.disabled) == (
            handlers, level, propagate, disabled)


def test_filtered_records_leave_configured_file_empty(logging_output, tmp_path):
    path = tmp_path / "server.log"
    _, stream = logging_output("warning", str(path))
    logging.getLogger("flowmap_server.api.ws").debug("noisy per-message detail")
    logging.getLogger("uvicorn.access").info("filtered access")
    assert setup.shutdown_logging(5)
    assert path.read_text(encoding="utf-8") == stream.getvalue() == ""


async def test_blocked_flush_does_not_stop_actual_uvicorn_access_error_or_http(logging_output):
    output, stream = logging_output(held=True)
    ticks = 0

    async def heartbeat():
        nonlocal ticks
        while True:
            ticks += 1
            await asyncio.sleep(0.005)

    async def app(scope, receive, send):
        if scope["path"] == "/error":
            raise RuntimeError("actual ASGI failure")
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"healthy"})

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(
        app, log_config=None, log_level="info", lifespan="off", http="h11", ws="none"))
    server_task = asyncio.create_task(server.serve(sockets=[sock]))
    pulse = asyncio.create_task(heartbeat())
    try:
        logging.getLogger("flowmap_server.api.ws").warning("hold root output")
        assert await asyncio.to_thread(stream.started.wait, 2)
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", timeout=2) as client:
            responses = await asyncio.gather(*(client.get(path) for path in (
                "/ok", "/error", "/ok", "/ok", "/ok", "/ok")))
        assert [r.status_code for r in responses] == [200, 500, 200, 200, 200, 200]
        await asyncio.sleep(0.03)
        assert ticks >= 5 and not stream.release.is_set()
        assert all(thread == output.thread.ident for thread in stream.threads)
    finally:
        server.should_exit = True
        await asyncio.wait_for(server_task, 5)
        pulse.cancel()
        await asyncio.gather(pulse, return_exceptions=True)
        sock.close()
        stream.release.set()
    assert setup.shutdown_logging(5)
    text = stream.getvalue()
    assert text.count('"GET /ok HTTP/1.1" 200') == 5
    assert text.count('"GET /error HTTP/1.1" 500') == 1
    assert "uvicorn.access:" in text and "uvicorn.error:" in text
    assert "actual ASGI failure" in text and "hold root output" in text


async def test_bounded_overflow_is_reported_by_worker_and_output_recovers(logging_output):
    output, stream = logging_output(held=True, capacity=2)
    logger = logging.getLogger("uvicorn.access")
    logger.info("first record")
    assert await asyncio.to_thread(stream.started.wait, 2)
    for index in range(20):
        logger.info("queued %d", index)
    assert output.queue.qsize() == 2 and output.dropped == 18
    await asyncio.sleep(0.02)  # same-loop progress while admission is saturated
    assert not stream.release.is_set()
    stream.release.set()
    await asyncio.wait_for(asyncio.to_thread(output.queue.join), 2)
    logger.info("after recovery marker")
    assert setup.shutdown_logging(5)
    text = stream.getvalue()
    assert "dropped 18 records (queue capacity 2, total 18)" in text
    assert text.count("Logging output recovered") == 1
    assert "after recovery marker" in text and output.reported_drops == output.dropped
    assert set(stream.threads) == {output.thread.ident}


async def test_full_queue_shutdown_is_bounded_and_later_drains(logging_output):
    output, stream = logging_output(held=True, capacity=1)
    logging.getLogger("uvicorn.error").error("in-flight output")
    assert await asyncio.to_thread(stream.started.wait, 2)
    logging.warning("queued before shutdown")
    logging.warning("overflow before shutdown")
    start = time.perf_counter()
    assert not setup.shutdown_logging(0.02)
    assert time.perf_counter() - start < 0.5
    assert output.queue.qsize() == 1 and not output.finished.is_set()
    with pytest.raises(RuntimeError, match="still draining"):
        entry.configure_logging()
    # stdlib logging shutdown cannot flush/close our borrowed blocked stream.
    # Isolate the call from pytest's own handlers by targeting only our handler.
    logging.shutdown([(lambda: output.handler)])
    assert not stream.closed
    stream.release.set()
    assert setup.shutdown_logging(5)
    assert "queued before shutdown" in stream.getvalue()
    assert "dropped 1 records" in stream.getvalue()
    assert not output.thread.is_alive()


def test_output_and_format_errors_are_counted_and_reported_after_recovery(
    logging_output, monkeypatch, tmp_path,
):
    path = tmp_path / "server.log"
    producer = threading.get_ident()
    attempts = []
    real_open = builtins.open

    def intermittent_open(*args, **kwargs):
        attempts.append(threading.get_ident())
        if len(attempts) == 1:
            raise PermissionError("temporary file denial")
        return real_open(*args, **kwargs)

    monkeypatch.setattr(setup, "open", intermittent_open, raising=False)
    output, stream = logging_output(path=str(path))
    logger = logging.getLogger("flowmap_server.api.ws")
    logger.warning("first record survives on stderr")
    logger.warning("bad format %s %s", "only-one-arg")
    logger.warning("later good record")
    assert setup.shutdown_logging(5)
    assert output.sink_errors == 2 and output.reported_errors == 2
    assert set(attempts) == {output.thread.ident} and producer not in attempts
    text = stream.getvalue()
    assert "first record survives on stderr" in text and "later good record" in text
    assert "output/format errors since last report" in text
    assert "later good record" in path.read_text(encoding="utf-8")


def test_main_disables_uvicorn_dictconfig_and_drains_on_failure(logging_output, monkeypatch):
    output, stream = logging_output()

    def run(app, **kwargs):
        assert kwargs["log_config"] is None
        assert logging.getLogger("uvicorn.access").handlers == [output.handler]
        logging.getLogger("uvicorn.error").error("startup failure retained")
        raise RuntimeError("startup failed")

    monkeypatch.setattr(entry, "_benchmark_provenance", lambda: None)
    monkeypatch.setattr(entry, "create_app", lambda cfg: object())
    monkeypatch.setattr(entry.uvicorn, "run", run)
    with pytest.raises(RuntimeError, match="startup failed"):
        entry.main()
    assert output.finished.is_set() and setup._state is None
    assert "startup failure retained" in stream.getvalue()
