"""Bounded, nonblocking production logging; only the output thread touches sinks.

Shutdown stops admission and drains the queue. ``stop`` waits at most its timeout;
an unresponsive OS stream cannot be interrupted, so the daemon may finish later
or lose pending diagnostics at process exit. Sink objects deliberately are not
logging Handlers: logging.shutdown must not wait on their in-flight I/O locks.
The caller's stderr is borrowed and is never closed. Interpreter finalization
may itself flush stderr, so a bounded join is not a bound on process exit.
"""

from __future__ import annotations

import atexit
import copy
import logging
import queue
import sys
import threading
from typing import TextIO

_QUEUE_CAPACITY = 2048
_SHUTDOWN_TIMEOUT = 2.0
_state: LogOutput | None = None
_configuration_lock = threading.Lock()


class _Admission(logging.Handler):
    def __init__(self, output: LogOutput) -> None:
        super().__init__()
        self.output = output

    def emit(self, record: logging.LogRecord) -> None:
        # Do not use QueueHandler.prepare: it formats messages/exceptions on
        # the producer. Keep exc_info and args for formatting on the worker.
        self.output.enqueue(copy.copy(record))


class LogOutput:
    def __init__(self, stream: TextIO, log_file: str | None, capacity: int) -> None:
        self.queue: queue.Queue[logging.LogRecord] = queue.Queue(maxsize=capacity)
        self.stream = stream
        self.log_file = log_file
        self.formatter = logging.Formatter(
            "%(asctime)s %(levelname)-7s %(name)s: %(message)s", "%Y-%m-%d %H:%M:%S"
        )
        self._file: TextIO | None = None
        self._lock = threading.Lock()
        self._stopping = threading.Event()
        self.finished = threading.Event()
        self.dropped = 0
        self.reported_drops = 0
        self.sink_errors = 0
        self.reported_errors = 0
        self.saved: list[tuple[logging.Logger, list[logging.Handler], int, bool, bool]] = []
        self.handler = _Admission(self)
        self.thread = threading.Thread(target=self._run, name="flowmap-log-output", daemon=True)

    def enqueue(self, record: logging.LogRecord) -> None:
        # This lock guards only admission/counters, never formatting or I/O.
        with self._lock:
            if self._stopping.is_set():
                self.dropped += 1
                return
            try:
                self.queue.put_nowait(record)
            except queue.Full:
                self.dropped += 1

    def _write(self, record: logging.LogRecord) -> bool:
        try:
            text = self.formatter.format(record) + "\n"
        except Exception:
            self.sink_errors += 1
            return False
        succeeded = False
        try:
            self.stream.write(text)
            self.stream.flush()
            succeeded = True
        except Exception:
            self.sink_errors += 1
        if self.log_file:
            try:
                if self._file is None:
                    self._file = open(self.log_file, "a", encoding="utf-8")
                self._file.write(text)
                self._file.flush()
                succeeded = True
            except Exception:
                self.sink_errors += 1
        return succeeded

    def _report_pending(self) -> None:
        with self._lock:
            dropped = self.dropped
        errors = self.sink_errors
        if dropped == self.reported_drops and errors == self.reported_errors:
            return
        marker = logging.LogRecord(
            "flowmap_server.logging", logging.WARNING, __file__, 0,
            "Logging output recovered: dropped %d records (queue capacity %d, total %d); "
            "%d output/format errors since last report",
            (dropped - self.reported_drops, self.queue.maxsize, dropped,
             errors - self.reported_errors), None,
        )
        if self._write(marker):
            self.reported_drops = dropped
            self.reported_errors = errors

    def _run(self) -> None:
        try:
            if self.log_file:
                try:
                    # Preserve an empty configured log file even when level
                    # filtering admits no records; opening also stays off-loop.
                    self._file = open(self.log_file, "a", encoding="utf-8")
                except Exception:
                    self.sink_errors += 1
            while True:
                try:
                    record = self.queue.get(timeout=0.05)
                except queue.Empty:
                    if self._stopping.is_set():
                        break
                    continue
                try:
                    if self._write(record):
                        self._report_pending()
                finally:
                    self.queue.task_done()
            self._report_pending()
        finally:
            if self._file is not None:
                try:
                    self._file.close()
                except Exception:
                    self.sink_errors += 1
            self.finished.set()

    def stop(self, timeout: float = _SHUTDOWN_TIMEOUT) -> bool:
        """Stop admission; return whether the owned worker drained within timeout.

        An Event avoids QueueListener's full-queue sentinel failure. A later
        call may wait again for a previously blocked worker to finish.
        """
        with self._lock:
            self._stopping.set()
        self.thread.join(max(0.0, timeout))
        return self.finished.is_set()


def configure_logging(level: str = "info", log_file: str | None = None) -> LogOutput:
    """Configure root and Uvicorn once; preserve other named loggers' settings.

    Uvicorn must be started with log_config=None so its dictConfig cannot put
    synchronous handlers back on the access/error path.
    """
    global _state
    with _configuration_lock:
        if _state is not None:
            if not _state._stopping.is_set():
                return _state
            if not _state.finished.is_set():
                raise RuntimeError("Previous logging output is still draining")
            _state.handler.close()
            _state = None
        numeric_level = logging.getLevelNamesMapping().get(level.upper())
        if numeric_level is None:
            raise ValueError(f"Unknown logging level: {level!r}")
        output = LogOutput(sys.stderr, log_file, _QUEUE_CAPACITY)
        for name in ("", "uvicorn", "uvicorn.error", "uvicorn.access"):
            logger = logging.getLogger(name)
            output.saved.append((logger, logger.handlers[:], logger.level,
                                 logger.propagate, logger.disabled))
            logger.handlers = [output.handler]
            logger.setLevel(numeric_level)
            logger.propagate = False
            logger.disabled = False
        output.thread.start()
        _state = output
        return output


def shutdown_logging(timeout: float = _SHUTDOWN_TIMEOUT) -> bool:
    """Restore borrowed logger state and wait for the owned output to drain."""
    global _state
    with _configuration_lock:
        output = _state
        if output is None:
            return True
        for logger, handlers, level, propagate, disabled in output.saved:
            logger.handlers = handlers
            logger.setLevel(level)
            logger.propagate = propagate
            logger.disabled = disabled
        # Retain a timed-out worker until drained; reconfiguration must not
        # start a second writer while the first still owns the file/stream.
        drained = output.stop(timeout)
        if drained:
            output.handler.close()
            _state = None
        return drained


atexit.register(shutdown_logging)
