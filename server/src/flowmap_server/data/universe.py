"""Bundled symbol universe + directory builder (GOAL 2, no network).

These lists are the OFFLINE FALLBACK and the first-paint default — not the
reachable universe. Live per-venue enumeration lives in
:mod:`flowmap_server.data.venues`, which the merged engine made possible
(``crypto.instruments.universe`` and the native connectors' ``list_instruments``
did not exist in the fork this file was written against).

They are still worth shipping:

- **First paint.** ``/api/universe?market=all`` stays pure, so the picker opens
  instantly instead of waiting on a venue round-trip.
- **Offline.** A venue outage degrades discovery to this shortlist rather than
  to an empty picker.
- **Equity.** The engine can enumerate the full US listing set through SEC +
  Tiingo, but that is a multi-megabyte pull; the curated large-caps remain the
  default surface, and any ticker outside them is still subscribable by typing
  it — the directory bounds what is BROWSABLE, never what is reachable.

The directory builder is pure: callers pass in the honest, feed-derived
capability dicts (so a directory entry can never claim more than a real subscribe
delivers) and get back the merged ``(sim + crypto + equity)`` universe. Both
``/api/symbols`` and ``/api/universe`` build on this one function.
"""

from __future__ import annotations

import json
from pathlib import Path

__all__ = [
    "CRYPTO_SYMBOLS",
    "CRYPTO_MARKET",
    "EQUITY_TICKERS",
    "build_directory",
    "filter_directory",
]

# Shared with the client so the first symbol-picker paint needs no HTTP round
# trip. Capabilities stay feed-derived in build_directory, never in this data.
_BUNDLED = json.loads(Path(__file__).with_name("universe.json").read_text(encoding="utf-8"))
CRYPTO_MARKET: str = _BUNDLED["crypto_market"]
CRYPTO_SYMBOLS: tuple[str, ...] = tuple(_BUNDLED["crypto_symbols"])
EQUITY_TICKERS: tuple[str, ...] = tuple(_BUNDLED["equity_tickers"])


def build_directory(
    *,
    sim_symbol: str,
    sim_capability: dict[str, object],
    crypto_capability: dict[str, object],
    equity_capability: dict[str, object],
) -> tuple[dict[str, object], ...]:
    """The merged ``(sim + crypto + equity)`` directory.

    Capabilities are passed in (feed-derived) so the directory can never drift
    from what a real subscribe delivers. Crypto entries carry a ``note`` (live
    enumeration is unavailable offline); sim/equity carry none.
    """
    entries: list[dict[str, object]] = [
        {"market": "sim", "symbol": sim_symbol, "capability": sim_capability}
    ]
    entries += [
        {
            "market": CRYPTO_MARKET,
            "symbol": s,
            "capability": crypto_capability,
            "note": "curated shortlist — pick a venue to enumerate it live",
        }
        for s in CRYPTO_SYMBOLS
    ]
    entries += [
        {"market": "equity", "symbol": s, "capability": equity_capability}
        for s in EQUITY_TICKERS
    ]
    return tuple(entries)


def filter_directory(
    directory: tuple[dict[str, object], ...],
    *,
    q: str = "",
    market: str = "all",
    limit: int | None = None,
) -> list[dict[str, object]]:
    """Case-insensitive substring filter over symbols, optional market gate and
    result cap. ``market`` is ``all`` | ``crypto`` | ``equity`` | ``sim`` (or an
    exact market string like ``binance-spot``)."""
    needle = q.lower()
    out: list[dict[str, object]] = []
    for e in directory:
        if not _market_matches(str(e["market"]), market):
            continue
        if needle and needle not in str(e["symbol"]).lower():
            continue
        out.append(e)
        if limit is not None and len(out) >= limit:
            break
    return out


def _market_matches(entry_market: str, want: str) -> bool:
    if want in ("", "all"):
        return True
    if want == "crypto":
        # Any venue the engine can reach, not the three this file used to know.
        from flowmap_server.feeds.crypto import is_crypto_market

        return is_crypto_market(entry_market)
    if want == "equity":
        return entry_market == "equity"
    if want == "sim":
        return entry_market == "sim"
    return entry_market == want
