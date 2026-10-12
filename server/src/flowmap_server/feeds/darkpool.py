"""FINRA TRF & Dark Pool aggregator feed (FLOW <GO>).

Pulls daily off-exchange and dark pool volume reports:
- FINRA Reg SHO Consolidated Short Sale Volume:
  https://cdn.finra.org/equity/regsho/daily/CNMSshvol{YYYYMMDD}.txt
- Off-Exchange Short Ratio = short_volume / total_volume
- Flags short ratio >= 50% as "Institutional Divergence (Distribution / Accumulation)".
- Stores observations in DuckWarehouse for live query and historical analysis.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
import logging
from typing import Any

import aiohttp

from flowmap_server.data.warehouse import DuckWarehouse

log = logging.getLogger(__name__)

_FINRA_CDN_REGSHO = "https://cdn.finra.org/equity/regsho/daily"


class DarkPoolCollector:
    """Aggregates off-exchange FINRA TRF / Dark Pool volume metrics."""

    def __init__(self, warehouse: DuckWarehouse | None = None) -> None:
        self.warehouse = warehouse or DuckWarehouse()
        self._session: aiohttp.ClientSession | None = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(headers={"User-Agent": "FlowMap/1.4.0 (research)"})
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def fetch_regsho_daily(
        self,
        target_date: date | None = None,
        symbols: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Fetch and parse daily FINRA Reg SHO file for target date."""
        target = target_date or (datetime.now(UTC).date() - timedelta(days=1))
        # Skip weekends backwards
        while target.weekday() >= 5:
            target -= timedelta(days=1)

        date_str = target.strftime("%Y%m%d")
        iso_date = target.strftime("%Y-%m-%d")
        url = f"{_FINRA_CDN_REGSHO}/CNMSshvol{date_str}.txt"

        session = await self._get_session()
        try:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status != 200:
                    log.warning("FINRA Reg SHO daily returned %s for %s", resp.status, date_str)
                    return []
                text = await resp.text(errors="replace")
        except Exception as exc:
            log.warning("Failed fetching FINRA Reg SHO daily %s: %s", url, exc)
            return []

        results: list[dict[str, Any]] = []
        sym_filter = {s.upper() for s in symbols} if symbols else None

        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("Date|"):
                continue
            parts = line.split("|")
            if len(parts) < 5:
                continue

            sym = parts[1].strip().upper()
            if sym_filter and sym not in sym_filter:
                continue

            try:
                short_vol = float(parts[2].strip() or 0.0)
                short_exempt = float(parts[3].strip() or 0.0)
                total_vol = float(parts[4].strip() or 0.0)
            except (ValueError, TypeError):
                continue

            if total_vol <= 0:
                continue

            short_ratio = round(short_vol / total_vol, 4)
            is_div = short_ratio >= 0.50

            row = {
                "date": iso_date,
                "symbol": sym,
                "short_volume": short_vol,
                "short_exempt_volume": short_exempt,
                "total_volume": total_vol,
                "short_ratio": short_ratio,
                "is_institutional_divergence": is_div,
            }
            results.append(row)

            # Persist to warehouse
            self.warehouse.insert_darkpool_volume(
                iso_date,
                sym,
                short_vol,
                short_exempt,
                total_vol,
                short_ratio,
                is_div,
            )

        log.info("Ingested %d FINRA Reg SHO records for date %s", len(results), iso_date)
        return results
