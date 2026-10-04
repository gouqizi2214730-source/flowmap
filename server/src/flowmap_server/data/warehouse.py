"""Local DuckDB analytical warehouse for FlowMap deep intelligence.

Persists and queries:
1. FINRA Dark Pool & Reg SHO TRF volumes
2. Gamma Exposure (GEX) historical snapshots & walls
3. Market Intelligence (DoD contracts, Congressional stock trades, FDA milestones)
4. SEC EDGAR Item 1A Risk Factors diff audits
5. Macro liquidity & credit risk spreads
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any

import duckdb

log = logging.getLogger(__name__)


class DuckWarehouse:
    """Local embedded DuckDB warehouse for FlowMap quantitative intelligence."""

    def __init__(self, db_path: str | Path | None = None) -> None:
        if db_path is None:
            # Default to local app storage or in-memory
            base_dir = Path(os.environ.get("FLOWMAP_DATA_DIR", ".flowmap_data"))
            base_dir.mkdir(parents=True, exist_ok=True)
            self._db_path = str(base_dir / "warehouse.duckdb")
        else:
            self._db_path = str(db_path)

        self._con = duckdb.connect(self._db_path)
        self._init_schema()

    def _init_schema(self) -> None:
        """Initialize relational analytical schema."""
        self._con.execute(
            """
            CREATE TABLE IF NOT EXISTS darkpool_volume (
                date VARCHAR,
                symbol VARCHAR,
                short_volume DOUBLE,
                short_exempt_volume DOUBLE,
                total_volume DOUBLE,
                short_ratio DOUBLE,
                is_institutional_divergence BOOLEAN,
                updated_ts BIGINT
            );

            CREATE TABLE IF NOT EXISTS gex_snapshots (
                ts_ns BIGINT,
                symbol VARCHAR,
                spot_price DOUBLE,
                gamma_flip DOUBLE,
                call_wall DOUBLE,
                put_wall DOUBLE,
                net_gex DOUBLE
            );

            CREATE TABLE IF NOT EXISTS market_intelligence (
                ts_ns BIGINT,
                kind VARCHAR,
                symbol VARCHAR,
                headline VARCHAR,
                amount_usd DOUBLE,
                detail VARCHAR,
                source VARCHAR
            );

            CREATE TABLE IF NOT EXISTS macro_stress (
                date VARCHAR,
                sofr DOUBLE,
                hy_spread DOUBLE,
                yield_10y2y DOUBLE,
                stress_score DOUBLE,
                status VARCHAR,
                updated_ts BIGINT
            );

            CREATE TABLE IF NOT EXISTS sec_risk_diffs (
                symbol VARCHAR,
                filing_date VARCHAR,
                form VARCHAR,
                added_risk_count INTEGER,
                deleted_risk_count INTEGER,
                critical_flags VARCHAR,
                updated_ts BIGINT
            );
            """
        )

    def insert_darkpool_volume(
        self,
        date_str: str,
        symbol: str,
        short_vol: float,
        short_exempt_vol: float,
        total_vol: float,
        short_ratio: float,
        is_divergence: bool,
    ) -> None:
        now_ts = time.time_ns()
        self._con.execute(
            """
            INSERT INTO darkpool_volume VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                date_str,
                symbol.upper(),
                short_vol,
                short_exempt_vol,
                total_vol,
                short_ratio,
                is_divergence,
                now_ts,
            ],
        )

    def insert_gex_snapshot(
        self,
        ts_ns: int,
        symbol: str,
        spot_price: float,
        gamma_flip: float,
        call_wall: float,
        put_wall: float,
        net_gex: float,
    ) -> None:
        self._con.execute(
            """
            INSERT INTO gex_snapshots VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [ts_ns, symbol.upper(), spot_price, gamma_flip, call_wall, put_wall, net_gex],
        )

    def insert_intelligence(
        self,
        ts_ns: int,
        kind: str,
        symbol: str,
        headline: str,
        amount_usd: float | None,
        detail: str,
        source: str,
    ) -> None:
        self._con.execute(
            """
            INSERT INTO market_intelligence VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [ts_ns, kind, symbol.upper(), headline, amount_usd, detail, source],
        )

    def insert_macro_stress(
        self,
        date_str: str,
        sofr: float,
        hy_spread: float,
        yield_10y2y: float,
        stress_score: float,
        status: str,
    ) -> None:
        now_ts = time.time_ns()
        self._con.execute(
            """
            INSERT INTO macro_stress VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [date_str, sofr, hy_spread, yield_10y2y, stress_score, status, now_ts],
        )

    def get_latest_gex(self, symbol: str) -> dict[str, Any] | None:
        res = self._con.execute(
            """
            SELECT ts_ns, symbol, spot_price, gamma_flip, call_wall, put_wall, net_gex
            FROM gex_snapshots
            WHERE symbol = ?
            ORDER BY ts_ns DESC
            LIMIT 1
            """,
            [symbol.upper()],
        ).fetchone()
        if not res:
            return None
        return {
            "ts_ns": res[0],
            "symbol": res[1],
            "spot_price": res[2],
            "gamma_flip": res[3],
            "call_wall": res[4],
            "put_wall": res[5],
            "net_gex": res[6],
        }

    def get_intelligence(self, symbol: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        if symbol:
            rows = self._con.execute(
                """
                SELECT ts_ns, kind, symbol, headline, amount_usd, detail, source
                FROM market_intelligence
                WHERE symbol = ?
                ORDER BY ts_ns DESC
                LIMIT ?
                """,
                [symbol.upper(), limit],
            ).fetchall()
        else:
            rows = self._con.execute(
                """
                SELECT ts_ns, kind, symbol, headline, amount_usd, detail, source
                FROM market_intelligence
                ORDER BY ts_ns DESC
                LIMIT ?
                """,
                [limit],
            ).fetchall()

        return [
            {
                "ts_ns": r[0],
                "kind": r[1],
                "symbol": r[2],
                "headline": r[3],
                "amount_usd": r[4],
                "detail": r[5],
                "source": r[6],
            }
            for r in rows
        ]

    def close(self) -> None:
        self._con.close()
