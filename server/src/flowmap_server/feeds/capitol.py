"""Congressional & Senate Stock Portfolio Watcher (GOV <GO>).

Tracks trading disclosures filed by members of the US House and Senate:
- Open-Source JSON feed:
  https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json
- Filters recent transactions (purchases, sales, exchanges).
- Maps politicians to stock tickers and key committees (Armed Services, Financial Services).
- Ingests into DuckWarehouse and broadcasts as MARKET_INTELLIGENCE events.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import json
import logging
import time
from typing import Any

import aiohttp

from flowmap_server import __version__
from flowmap_server.data.warehouse import DuckWarehouse

log = logging.getLogger(__name__)

_HOUSE_TRANSACTIONS_URL = (
    "https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json"
)


class CapitolTradesWatcher:
    """Monitors legislative stock filings from Capitol Hill politicians."""

    def __init__(self, warehouse: DuckWarehouse | None = None) -> None:
        self.warehouse = warehouse or DuckWarehouse()
        self._session: aiohttp.ClientSession | None = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(headers={"User-Agent": f"FlowMap-CapitolWatcher/{__version__}"})
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def fetch_recent_trades(
        self,
        lookback_days: int = 30,
        symbols: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Fetch and parse congressional stock filings."""
        session = await self._get_session()
        raw_data: list[dict[str, Any]] = []

        try:
            async with session.get(_HOUSE_TRANSACTIONS_URL, timeout=aiohttp.ClientTimeout(total=20)) as resp:
                if resp.status == 200:
                    raw_data = await resp.json(content_type=None)
                else:
                    log.warning("Capitol transactions returned status %d", resp.status)
        except Exception as exc:
            log.warning("Failed querying Congressional Stock Watcher: %s", exc)

        if not isinstance(raw_data, list):
            return []

        results: list[dict[str, Any]] = []
        now = datetime.now(UTC)
        cutoff = (now - timedelta(days=lookback_days)).date()
        now_ns = time.time_ns()

        sym_filter = {s.strip().upper() for s in symbols} if symbols is not None else None

        for item in raw_data:
            if not isinstance(item, dict):
                continue
            ticker = str(item.get("ticker") or "").strip().upper()
            if not ticker or ticker == "--":
                continue
            if sym_filter is not None and ticker not in sym_filter:
                continue

            trans_date = str(item.get("transaction_date", ""))
            parsed_date = None
            for date_format in ("%Y-%m-%d", "%m/%d/%Y"):
                try:
                    parsed_date = datetime.strptime(trans_date, date_format).date()
                    break
                except ValueError:
                    continue
            if parsed_date is None or not cutoff <= parsed_date <= now.date():
                continue

            rep = str(item.get("representative") or "").strip()
            ttype = str(item.get("type") or "").strip().lower()
            amount_str = str(item.get("amount") or "").strip()
            party = str(item.get("party") or "").strip()
            state = str(item.get("state") or "").strip()

            headline = f"🏛️ {rep or 'Representative unavailable'} {ttype.upper() or 'TRANSACTION'}: {ticker}"
            if amount_str:
                headline += f" ({amount_str})"
            detail = json.dumps({
                "politician": rep or None,
                "chamber": "House",
                "type": ttype.title() if ttype else None,
                "amount_range": amount_str or None,
                "date": parsed_date.isoformat(),
                "transaction_date": trans_date,
                "disclosure_date": item.get("disclosure_date") or None,
                "party": party or None,
                "state": state or None,
            }, ensure_ascii=False)

            ev = {
                "ts_ns": now_ns,
                "kind": "capitol",
                "symbol": ticker,
                "headline": headline,
                # Disclosures report a range, not an exact transaction amount.
                "amount_usd": None,
                "detail": detail,
                "source": "House Stock Watcher",
            }
            results.append(ev)
            self.warehouse.insert_intelligence(
                now_ns,
                "capitol",
                ticker,
                headline,
                None,
                detail,
                "House Stock Watcher",
            )

        return results
