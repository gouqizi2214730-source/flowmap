"""Model output must distinguish measured inputs, assumptions and missing data."""

from datetime import UTC, datetime, timedelta
import math
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from flowmap_server.core.gex import OptionContract, bs_gamma, calculate_gex, fetch_options_and_calculate_gex
from flowmap_server.feeds.aviation import CorporateJetTracker
from flowmap_server.nlp.vocal_stress import analyze_transcript_qa_segment, compute_vocal_stress_score


def option(strike=100.0, is_call=True, oi=1000.0, iv=0.20, dte=30.0):
    return OptionContract(strike, is_call, oi, iv, dte)


def assert_unavailable(result, spot=None):
    assert result.available is False
    assert result.spot_price == spot
    assert result.strikes == []
    assert result.strike_gex == []
    assert result.call_wall is None
    assert result.put_wall is None
    assert result.gamma_flip is None
    assert result.net_gex is None
    assert result.unavailable_reason


@pytest.mark.parametrize("spot", [0.0, -1.0, float("nan"), float("inf"), True, 10**1000])
def test_invalid_spot_produces_no_gex_levels(spot):
    assert_unavailable(calculate_gex("TEST", spot, [option()]))


@pytest.mark.parametrize("field,value", [
    ("strike", 0.0), ("strike", float("inf")), ("implied_vol", 0.0),
    ("implied_vol", float("nan")), ("open_interest", -1.0),
    ("open_interest", float("inf")), ("dte_days", 0.0), ("dte_days", float("nan")),
    ("is_call", "call"),
])
def test_invalid_contract_produces_no_partial_model(field, value):
    invalid = option()
    setattr(invalid, field, value)
    assert_unavailable(calculate_gex("TEST", 100.0, [option(90), invalid]), spot=100.0)


def test_missing_chain_and_numerical_overflow_remain_unavailable():
    assert_unavailable(calculate_gex("TEST", 100.0, []), spot=100.0)
    assert_unavailable(calculate_gex("TEST", 1e308, [option()]), spot=1e308)
    assert_unavailable(calculate_gex("TEST", 100.0, [option(oi=1e308)]), spot=100.0)


@pytest.mark.parametrize("kwargs", [
    {"spot": float("nan")}, {"strike": 0}, {"tau": 0}, {"iv": -1},
    {"r": float("inf")}, {"spot": True},
])
def test_black_scholes_rejects_nonphysical_values(kwargs):
    values = dict(spot=100.0, strike=100.0, tau=0.25, iv=0.20, r=0.045)
    values.update(kwargs)
    with pytest.raises(ValueError):
        bs_gamma(**values)


def test_gex_formula_and_provenance_explicitly_describe_assumptions():
    calls, puts = option(110, oi=4000), option(90, is_call=False, oi=3000)
    result = calculate_gex("test", 100.0, [calls, puts])
    expected = sum(opt.open_interest * bs_gamma(100, opt.strike, opt.dte_days / 365,
                   opt.implied_vol) * 100**2 * 100 * (1 if opt.is_call else -1)
                   for opt in (calls, puts))
    assert result.available is True
    assert result.net_gex == pytest.approx(expected)
    assert result.call_wall == 110
    assert result.put_wall == 90
    assert result.model_provenance["risk_free_rate_source"] == "fixed model assumption"
    assert result.model_provenance["contract_multiplier"] == 100
    assert "unit relative spot move" in result.model_provenance["scale"]
    assert "actual positions unknown" in result.model_provenance["dealer_position_convention"]


@pytest.mark.parametrize("contracts", [
    [option(90), option(110)], [option(90, False), option(110, False)],
    [option(90), option(90, False), option(110), option(110, False)],
    [option(90, oi=2000), option(90, False), option(110, oi=2000), option(110, False)],
])
def test_gamma_flip_requires_a_sign_change_not_a_minimum_magnitude(contracts):
    result = calculate_gex("TEST", 100.0, contracts)
    assert result.available is True
    assert result.gamma_flip is None
    if all(opt.is_call for opt in contracts):
        assert result.put_wall is None
    if all(not opt.is_call for opt in contracts):
        assert result.call_wall is None


def model_net(spot, contracts):
    return math.fsum(opt.open_interest * bs_gamma(spot, opt.strike, opt.dte_days / 365,
                     opt.implied_vol) * (1 if opt.is_call else -1) for opt in contracts)


def test_gamma_flip_is_bisected_inside_a_real_opposite_sign_bracket():
    contracts = [option(90, False, oi=2000), option(110, True, oi=2000)]
    result = calculate_gex("TEST", 100.0, contracts)
    assert model_net(90, contracts) < 0 < model_net(110, contracts)
    assert result.gamma_flip is not None
    assert 90 < result.gamma_flip < 110
    assert abs(model_net(result.gamma_flip, contracts)) < 1e-6
    assert model_net(result.gamma_flip - 0.001, contracts) < 0
    assert model_net(result.gamma_flip + 0.001, contracts) > 0


def test_multiple_gamma_roots_select_the_root_nearest_current_spot():
    contracts = [option(80, True, oi=1000), option(100, False, oi=2000),
                 option(120, True, oi=1000)]
    lower = calculate_gex("TEST", 85, contracts).gamma_flip
    upper = calculate_gex("TEST", 115, contracts).gamma_flip
    assert lower is not None and upper is not None
    assert 80 < lower < 100 < upper < 120
    assert abs(model_net(lower, contracts)) < 1e-6
    assert abs(model_net(upper, contracts)) < 1e-6


class Frame:
    def __init__(self, rows):
        self.rows = rows

    def iterrows(self):
        return enumerate(self.rows)


def yahoo(monkeypatch, *, price=100.0, calls=None, puts=None, unavailable=False):
    expiration = (datetime.now(UTC).date() + timedelta(days=30)).isoformat()
    ticker = SimpleNamespace(fast_info=SimpleNamespace(last_price=price), options=[expiration])
    if unavailable:
        ticker.option_chain = lambda _: (_ for _ in ()).throw(OSError("offline"))
    else:
        ticker.option_chain = lambda _: SimpleNamespace(calls=Frame(calls or []), puts=Frame(puts or []))
    import yfinance as yf

    monkeypatch.setattr(yf, "Ticker", lambda _, **kwargs: ticker)


@pytest.mark.parametrize("source_price", [None, float("nan"), 0.0])
async def test_missing_yahoo_price_never_becomes_a_guessed_spot(monkeypatch, source_price):
    yahoo(monkeypatch, price=source_price)
    assert_unavailable(await fetch_options_and_calculate_gex("TEST"))


@pytest.mark.parametrize("failure", [False, True])
async def test_empty_or_failed_yahoo_chain_does_not_create_synthetic_contracts(monkeypatch, failure):
    yahoo(monkeypatch, unavailable=failure)
    assert_unavailable(await fetch_options_and_calculate_gex("TEST", spot_price=101), spot=101)


@pytest.mark.parametrize("iv", [None, 0.0, float("nan")])
async def test_source_iv_is_required_instead_of_defaulting_to_point_25(monkeypatch, iv):
    yahoo(monkeypatch, calls=[{"strike": 100, "openInterest": 1000, "impliedVolatility": iv}])
    assert_unavailable(await fetch_options_and_calculate_gex("TEST"), spot=100)


async def test_real_yahoo_chain_retains_source_and_model_provenance(monkeypatch):
    yahoo(monkeypatch,
          calls=[{"strike": 110, "openInterest": 2000, "impliedVolatility": 0.20}],
          puts=[{"strike": 90, "openInterest": 2000, "impliedVolatility": 0.20}])
    result = await fetch_options_and_calculate_gex("TEST")
    assert result.available is True
    assert result.strikes == [90, 110]
    assert result.gamma_flip is not None
    assert result.model_provenance["options_source"].startswith("yfinance option chain")
    assert result.model_provenance["spot_source"] == "yfinance fast_info.last_price"


REGISTRY = {"abcdef": {"symbol": "TEST", "company": "Verified fixture", "tail": "TEST-1"}}


class Response:
    def __init__(self, states=None, *, status=200, error=None):
        self.states, self.status, self.error = states, status, error

    async def __aenter__(self):
        if self.error:
            raise self.error
        return self

    async def __aexit__(self, *_):
        return False

    async def json(self):
        return {"states": self.states}


class Session:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.response


def position(**changes):
    data = ["abcdef", "CALLSIGN", "Country", 1_700_000_000.25, 1_700_000_001, 12.0, 40.0, 3000, False, 125]
    for key, value in changes.items():
        data[{"icao": 0, "time": 3, "lon": 5, "lat": 6, "altitude": 7, "ground": 8, "velocity": 9}[key]] = value
    return data


async def test_default_aircraft_registry_has_no_unverified_mappings_or_http(monkeypatch):
    tracker = CorporateJetTracker()
    session = AsyncMock(side_effect=AssertionError("empty registry must not query"))
    monkeypatch.setattr(tracker, "_get_session", session)
    assert await tracker.check_aircraft_states() == []
    session.assert_not_called()


@pytest.mark.parametrize("response", [Response(), Response([]), Response(status=503),
                                      Response(error=OSError("offline")),
                                      Response([position(icao="123456")])])
async def test_aircraft_empty_failed_or_unmatched_source_is_empty(monkeypatch, response):
    tracker = CorporateJetTracker(verified_registry=REGISTRY)
    monkeypatch.setattr(tracker, "_get_session", AsyncMock(return_value=Session(response)))
    assert await tracker.check_aircraft_states() == []


@pytest.mark.parametrize("changes", [
    {"time": None}, {"time": 0}, {"time": float("inf")}, {"lat": float("nan")},
    {"lon": 181}, {"lat": 91}, {"lat": True},
])
async def test_invalid_aircraft_position_cannot_become_current_telemetry(monkeypatch, changes):
    tracker = CorporateJetTracker(verified_registry=REGISTRY)
    monkeypatch.setattr(tracker, "_get_session", AsyncMock(return_value=Session(Response([position(**changes)]))))
    assert await tracker.check_aircraft_states() == []


async def test_real_matched_aircraft_preserves_source_position_clock(monkeypatch):
    tracker = CorporateJetTracker(verified_registry=REGISTRY)
    session = Session(Response([position(icao="123456"), position(altitude=None, velocity=float("nan"))]))
    monkeypatch.setattr(tracker, "_get_session", AsyncMock(return_value=session))
    result = await tracker.check_aircraft_states()
    assert len(result) == 1
    event = result[0]
    assert event["icao24"] == "abcdef"
    assert event["ts_ns"] == 1_700_000_000_250_000_000
    assert event["received_at_ns"] > event["ts_ns"]
    assert event["altitude_m"] is None and event["velocity_mps"] is None
    assert event["status"] == "Airborne"
    assert "hub_alert" not in event
    assert session.calls[0][1]["params"] == {"icao24": "abcdef"}


def test_transcript_words_never_manufacture_acoustic_scores_or_severity():
    result = analyze_transcript_qa_segment("CEO", "Question", "I believe, believe and HOPE, as far as I know. Mighty results.")
    assert result["hedge_phrase_count"] == 4
    assert result["hedge_phrase_counts"]["believe"] == 2
    assert result["hedge_phrase_counts"]["might"] == 0
    assert result["stress_score"] is None
    assert result["metrics"] is None
    assert result["validated"] is False
    assert result["classification"] == "ACOUSTICS_UNAVAILABLE"
    assert "transcript text only" in result["provenance"]


@pytest.mark.parametrize("key,value", [
    ("f0_mean", 0), ("f0_std", -1), ("f0_std", float("inf")),
    ("jitter_pct", float("nan")), ("jitter_pct", -1), ("shimmer_pct", 101),
    ("pause_ratio", 1.1), ("pause_ratio", -0.1), ("f0_mean", True),
])
def test_supplied_acoustic_measures_require_finite_physical_inputs(key, value):
    values = dict(f0_mean=130.0, f0_std=18.0, jitter_pct=0.8, shimmer_pct=2.1, pause_ratio=0.10)
    values[key] = value
    with pytest.raises(ValueError):
        compute_vocal_stress_score(**values)


def test_supplied_acoustics_are_uncalibrated_heuristics_without_deception_claims():
    result = compute_vocal_stress_score(150, 60, 3.0, 7.0, 0.8)
    assert result["classification"] == "HEURISTIC_HIGH"
    assert result["validated"] is False
    assert result["label"] == "Uncalibrated acoustic composite"
    assert result["metrics"]["f0_mean"] == 150
    assert "caller-supplied" in result["provenance"]
