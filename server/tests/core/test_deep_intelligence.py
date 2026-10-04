"""Unit tests for FlowMap Deep Intelligence modules (Sprint 1)."""

from __future__ import annotations

import tempfile
import pytest

from flowmap_server.core.gex import OptionContract, calculate_gex, bs_gamma
from flowmap_server.data.warehouse import DuckWarehouse
from flowmap_server.feeds.darkpool import DarkPoolCollector
from flowmap_server.feeds.contracts import DefenseContractsListener
from flowmap_server.feeds.capitol import CapitolTradesWatcher
from flowmap_server.feeds.aviation import CorporateJetTracker
from flowmap_server.feeds.headcount import HeadcountVelocityTracker
from flowmap_server.feeds.macro import MacroStressPoller
from flowmap_server.nlp.edgar_diff import compute_risk_delta, extract_risk_factors
from flowmap_server.nlp.vocal_stress import compute_vocal_stress_score, analyze_transcript_qa_segment


def test_black_scholes_gamma() -> None:
    # Spot 100, Strike 100, Tau 0.25 (3 mo), IV 20%
    g = bs_gamma(spot=100.0, strike=100.0, tau=0.25, iv=0.20, r=0.045)
    assert g > 0.03 and g < 0.05

    # Out of money vs at the money
    g_otm = bs_gamma(spot=100.0, strike=150.0, tau=0.25, iv=0.20, r=0.045)
    assert g_otm < g


def test_calculate_gex() -> None:
    contracts = [
        OptionContract(strike=100.0, is_call=True, open_interest=1000.0, implied_vol=0.20, dte_days=30),
        OptionContract(strike=110.0, is_call=True, open_interest=5000.0, implied_vol=0.22, dte_days=30),
        OptionContract(strike=90.0, is_call=False, open_interest=4000.0, implied_vol=0.25, dte_days=30),
    ]
    res = calculate_gex(symbol="AAPL", spot=105.0, contracts=contracts)
    assert res.symbol == "AAPL"
    assert res.call_wall == 110.0
    assert res.put_wall == 90.0
    assert len(res.strikes) == 3


def test_duckdb_warehouse() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        wh = DuckWarehouse(f"{tmpdir}/test_wh.duckdb")
        wh.insert_gex_snapshot(1000, "AAPL", 150.0, 148.0, 155.0, 145.0, 2500000.0)
        wh.insert_intelligence(1000, "defense_contract", "PLTR", "TITAN Award", 178000000.0, "US Army", "USASpending")
        wh.insert_darkpool_volume("2024-06-14", "AAPL", 500000.0, 20000.0, 950000.0, 0.526, True)

        latest_gex = wh.get_latest_gex("AAPL")
        assert latest_gex is not None
        assert latest_gex["call_wall"] == 155.0
        assert latest_gex["put_wall"] == 145.0

        intel = wh.get_intelligence("PLTR")
        assert len(intel) == 1
        assert intel[0]["symbol"] == "PLTR"

        wh.close()


def test_edgar_risk_diff() -> None:
    prev_text = "Item 1A. Risk Factors\nWe face market competition.\nCybersecurity threats are rising."
    curr_text = "Item 1A. Risk Factors\nWe face market competition.\nCybersecurity threats are rising.\nThe Department of Justice has initiated an investigation regarding our accounting."

    extracted = extract_risk_factors(curr_text)
    assert "Risk Factors" in extracted or "competition" in extracted

    delta = compute_risk_delta(prev_text, curr_text)
    assert delta["added_count"] == 1
    assert len(delta["critical_flags"]) > 0
    assert delta["is_material_change"] is True


def test_vocal_stress_scorer() -> None:
    calm = compute_vocal_stress_score(f0_mean=130.0, f0_std=18.0, jitter_pct=0.8, shimmer_pct=2.1, pause_ratio=0.10)
    assert calm["classification"] == "CALM_CONFIDENT"
    assert calm["stress_score"] < 0.40

    stressed = compute_vocal_stress_score(f0_mean=155.0, f0_std=60.0, jitter_pct=2.8, shimmer_pct=6.5, pause_ratio=0.45)
    assert stressed["classification"] == "SEVERE_EVASION_WARNING"
    assert stressed["stress_score"] >= 0.70

    qa = analyze_transcript_qa_segment(
        speaker="CEO",
        question="Can you explain the sudden decline in gross margins?",
        answer="Well, we hope and believe that at this time potentially as far as I know the situation is temporary.",
    )
    assert qa["stress_score"] > 0.40


@pytest.mark.asyncio
async def test_feeds_offline_fallbacks() -> None:
    # Contracts
    with tempfile.TemporaryDirectory() as tmpdir:
        wh = DuckWarehouse(f"{tmpdir}/wh.duckdb")
        listener = DefenseContractsListener(wh)
        awards = await listener.fetch_recent_contracts()
        assert len(awards) > 0
        await listener.close()

        # Capitol
        capitol = CapitolTradesWatcher(wh)
        trades = await capitol.fetch_recent_trades()
        assert len(trades) > 0
        await capitol.close()

        # Aviation
        aero = CorporateJetTracker()
        flights = await aero.check_aircraft_states()
        assert len(flights) > 0
        await aero.close()

        # Headcount
        hc = HeadcountVelocityTracker()
        talent = await hc.fetch_company_headcount("PLTR")
        assert talent["total_openings"] > 0
        await hc.close()

        # Macro
        macro = MacroStressPoller(warehouse=wh)
        stress = await macro.compute_current_stress()
        assert stress["stress_score"] >= 0.0
        await macro.close()

        wh.close()
