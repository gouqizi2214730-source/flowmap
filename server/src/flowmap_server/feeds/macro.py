"""Macro Liquidity & Credit Stress Engine (MACRO <GO>).

Queries St. Louis Fed FRED API & US Treasury endpoints for systemic macro liquidity:
- SOFR (Secured Overnight Financing Rate): Key dollar repo benchmark.
- BAMLH0A0HYM2 (US High Yield Option-Adjusted Spread): Corporate credit default risk (CDS proxy).
- T10Y2Y (10-Year minus 2-Year Treasury Yield Curve): Recession inversion warning.
- Produces normalized composite Institutional Stress Score (0.0 to 1.0).
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
import logging
import math
from typing import Any

import aiohttp

from flowmap_server import __version__
from flowmap_server.data.warehouse import DuckWarehouse

log = logging.getLogger(__name__)

_FRED_OBS_URL = "https://api.stlouisfed.org/fred/series/observations"


class MacroStressPoller:
    """Monitors credit risk spreads and yield curve inversions."""

    def __init__(
        self,
        api_key: str | None = None,
        warehouse: DuckWarehouse | None = None,
    ) -> None:
        self.api_key = api_key.strip() if api_key else None
        self.warehouse = warehouse or DuckWarehouse()
        self._session: aiohttp.ClientSession | None = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(headers={"User-Agent": f"FlowMap-MacroStress/{__version__}"})
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def fetch_series_observation(self, series_id: str) -> float | None:
        """Fetch latest numeric observation for a FRED series ID."""
        if not self.api_key:
            return None
        session = await self._get_session()
        params = {
            "series_id": series_id,
            "api_key": self.api_key,
            "file_type": "json",
            "sort_order": "desc",
            "limit": 5,
        }
        try:
            async with session.get(_FRED_OBS_URL, params=params, timeout=aiohttp.ClientTimeout(total=8)) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    obs = data.get("observations", []) if isinstance(data, dict) else []
                    if not isinstance(obs, list):
                        return None
                    for item in obs:
                        if not isinstance(item, dict):
                            continue
                        raw_value = item.get("value")
                        if raw_value is None or raw_value == "." or isinstance(raw_value, bool):
                            continue
                        try:
                            value = float(raw_value)
                        except (TypeError, ValueError, OverflowError):
                            continue
                        return value if math.isfinite(value) else None
        except Exception as exc:
            log.debug("FRED query for %s failed: %s", series_id, exc)
        return None

    async def compute_current_stress(self) -> dict[str, Any]:
        """Compute composite macro credit and liquidity stress."""
        sofr_val, hy_val, t10y2y_val = await asyncio.gather(
            self.fetch_series_observation("SOFR"),
            self.fetch_series_observation("BAMLH0A0HYM2"),
            self.fetch_series_observation("T10Y2Y"),
            return_exceptions=True,
        )

        observations = {
            "SOFR": sofr_val,
            "BAMLH0A0HYM2": hy_val,
            "T10Y2Y": t10y2y_val,
        }
        missing = [name for name, value in observations.items()
                   if not isinstance(value, (float, int)) or isinstance(value, bool) or not math.isfinite(value)]
        today_str = datetime.now(UTC).strftime("%Y-%m-%d")
        if missing:
            return {
                "date": today_str,
                "available": False,
                "source": "FRED",
                "missing_series": missing,
                "sofr": None,
                "hy_spread_pct": None,
                "yield_curve_10y2y": None,
                "stress_score": None,
                "status": "UNAVAILABLE",
                "inversion_alert": None,
            }
        sofr, hy_spread, yield_curve = float(sofr_val), float(hy_val), float(t10y2y_val)

        # Stress score logic:
        # High Yield Spread > 4.5% is elevated, > 6.0% is severe crisis
        # Yield Curve < 0 is inverted
        hy_score = min(max((hy_spread - 3.0) / 3.0, 0.0), 1.0)
        curve_score = min(max((-yield_curve) / 0.5, 0.0), 1.0) if yield_curve < 0 else 0.0
        composite_score = round(0.6 * hy_score + 0.4 * curve_score, 3)

        if composite_score >= 0.70:
            status = "SEVERE_STRESS"
        elif composite_score >= 0.35:
            status = "ELEVATED"
        else:
            status = "NORMAL_LIQUIDITY"

        self.warehouse.insert_macro_stress(
            today_str,
            sofr,
            hy_spread,
            yield_curve,
            composite_score,
            status,
        )

        return {
            "date": today_str,
            "available": True,
            "source": "FRED",
            "missing_series": [],
            "sofr": sofr,
            "hy_spread_pct": hy_spread,
            "yield_curve_10y2y": yield_curve,
            "stress_score": composite_score,
            "status": status,
            "inversion_alert": yield_curve < 0.0,
        }
