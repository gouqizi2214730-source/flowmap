"""Coalesced cold Yahoo imports, with no server-loop import-lock wait."""

from __future__ import annotations

import asyncio
import concurrent.futures
import importlib
import threading

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
