"""OpenSky positions for a caller-supplied, verified aircraft registry.

ADS-B positions do not establish executive travel, destination or deal intent.
No corporate-to-aircraft mapping is assumed by default.
"""

from __future__ import annotations

from decimal import Decimal
import logging
import math
import re
import time
from typing import Any

import aiohttp

from flowmap_server import __version__

log = logging.getLogger(__name__)
_OPENSKY_API_URL = 'https://opensky-network.org/api/states/all'


def _finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


class CorporateJetTracker:
    """Read ADS-B state vectors only for explicitly supplied registry entries."""

    def __init__(self, verified_registry: dict[str, dict[str, str]] | None = None) -> None:
        self.registry: dict[str, dict[str, str]] = {}
        for icao, info in (verified_registry or {}).items():
            if not re.fullmatch(r'[0-9a-fA-F]{6}', icao):
                raise ValueError('aircraft registry requires six-digit ICAO identifiers')
            if not all(isinstance(info.get(key), str) and info[key].strip() for key in ('symbol', 'company', 'tail')):
                raise ValueError('aircraft registry requires verified symbol, company and tail')
            self.registry[icao.lower()] = dict(info)
        self._session: aiohttp.ClientSession | None = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(headers={'User-Agent': f'FlowMap-AeroTracker/{__version__}'})
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def check_aircraft_states(self) -> list[dict[str, Any]]:
        """Return valid matched source positions with the source position clock."""
        if not self.registry:
            return []
        session = await self._get_session()
        events: list[dict[str, Any]] = []
        for icao, info in self.registry.items():
            try:
                async with session.get(_OPENSKY_API_URL, params={'icao24': icao}, timeout=aiohttp.ClientTimeout(total=8)) as resp:
                    if resp.status != 200:
                        continue
                    data = await resp.json()
                    states = data.get('states') if isinstance(data, dict) else None
                    if not isinstance(states, list):
                        continue
                    received_at_ns = time.time_ns()
                    for state in states:
                        if not isinstance(state, (list, tuple)) or len(state) < 10 or str(state[0]).lower() != icao:
                            continue
                        position_time, lon, lat = state[3], state[5], state[6]
                        if (not all(_finite_number(value) for value in (position_time, lon, lat))
                                or position_time <= 0 or not -180 <= lon <= 180 or not -90 <= lat <= 90):
                            continue
                        source_ns = int(Decimal(str(position_time)) * 1_000_000_000)
                        if source_ns <= 0 or source_ns > 2**63 - 1:
                            continue
                        altitude = state[7] if _finite_number(state[7]) else None
                        on_ground = state[8] if isinstance(state[8], bool) else None
                        velocity = state[9] if _finite_number(state[9]) and state[9] >= 0 else None
                        events.append({
                            'ts_ns': source_ns, 'received_at_ns': received_at_ns,
                            'source': 'OpenSky ADS-B state vector',
                            'registry_source': 'caller-supplied verified registry',
                            'icao24': icao, 'symbol': info['symbol'], 'company': info['company'],
                            'tail': info['tail'], 'lat': lat, 'lon': lon,
                            'altitude_m': altitude, 'on_ground': on_ground, 'velocity_mps': velocity,
                            'status': 'On ground' if on_ground is True else 'Airborne' if on_ground is False else 'Position observed',
                        })
            except Exception as exc:
                log.debug('OpenSky query for %s failed: %s', icao, exc)
        return events