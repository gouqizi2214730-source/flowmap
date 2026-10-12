"""Corporate Headcount & Hiring Velocity Tracker (GEO & EXHAUST <GO>).

Monitors job board activity across public tech & growth companies:
- Uses the Greenhouse public jobs API (no API key required).
- Endpoint: https://boards-api.greenhouse.io/v1/boards/{company}/jobs
- Categorizes openings into R&D / Engineering, Sales & Marketing, and G&A.
- Counts current openings with an explicitly labelled department heuristic.
  No historical baseline is collected, so hiring velocity remains unknown.
"""

from __future__ import annotations

import logging
import re
from typing import Any

import aiohttp

from flowmap_server import __version__

log = logging.getLogger(__name__)

_GREENHOUSE_BASE = "https://boards-api.greenhouse.io/v1/boards/{company}/jobs"

COMPANY_BOARD_MAP: dict[str, str] = {
    "PLTR": "palantirtechnologies",
    "SNOW": "snowflake",
    "DDOG": "datadog",
    "NET": "cloudflare",
    "CRWD": "crowdstrike",
    "MDB": "mongodb",
}


class HeadcountVelocityTracker:
    """Tracks talent expansion and engineering hiring velocity."""

    def __init__(self) -> None:
        self._session: aiohttp.ClientSession | None = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(headers={"User-Agent": f"FlowMap-TalentTracker/{__version__}"})
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def fetch_company_headcount(self, symbol: str) -> dict[str, Any]:
        """Fetch active job openings and breakdown by department."""
        sym_clean = symbol.upper()
        board_slug = COMPANY_BOARD_MAP.get(sym_clean, sym_clean.lower())

        url = _GREENHOUSE_BASE.format(company=board_slug)
        session = await self._get_session()
        jobs: list[dict[str, Any]] | None = None

        try:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=8)) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    candidate = data.get("jobs") if isinstance(data, dict) else None
                    if isinstance(candidate, list) and all(isinstance(job, dict) for job in candidate):
                        jobs = candidate
        except Exception as exc:
            log.debug("Greenhouse query for %s failed: %s", board_slug, exc)

        if jobs is None:
            return {
                "symbol": sym_clean,
                "available": False,
                "source": url,
                "total_openings": None,
                "rd_engineering_openings": None,
                "sales_openings": None,
                "ga_openings": None,
                "talent_index_delta_pct": None,
                "signal": "UNAVAILABLE",
                "department_classification": "title_and_department_keyword_heuristic",
            }

        rd_count = 0
        sales_count = 0
        ga_count = 0

        for j in jobs:
            title = str(j.get("title") or "").lower()
            departments = j.get("departments")
            dept = " ".join(str(d.get("name") or "") for d in departments if isinstance(d, dict)).lower() if isinstance(departments, list) else ""
            comb = f"{title} {dept}"

            if re.search(r"\b(engineer(?:ing)?|developer|research|software|ai|hardware)\b", comb):
                rd_count += 1
            elif any(k in comb for k in ["sales", "account", "marketing", "business dev"]):
                sales_count += 1
            else:
                ga_count += 1

        total = len(jobs)
        return {
            "symbol": sym_clean,
            "available": True,
            "source": url,
            "total_openings": total,
            "rd_engineering_openings": rd_count,
            "sales_openings": sales_count,
            "ga_openings": ga_count,
            "talent_index_delta_pct": None,
            "signal": "CURRENT_OPENINGS",
            "department_classification": "title_and_department_keyword_heuristic",
        }
