"""Source failures must not create market intelligence or invented metrics."""

from datetime import UTC, datetime, timedelta
import json
from unittest.mock import AsyncMock, Mock

import pytest

from flowmap_server.data.warehouse import DuckWarehouse
from flowmap_server.feeds.capitol import CapitolTradesWatcher
from flowmap_server.feeds.contracts import DefenseContractsListener
from flowmap_server.feeds.headcount import HeadcountVelocityTracker
from flowmap_server.feeds.macro import MacroStressPoller


class Response:
    def __init__(self, payload=None, *, status=200, error=None):
        self.payload = payload
        self.status = status
        self.error = error

    async def __aenter__(self):
        if self.error:
            raise self.error
        return self

    async def __aexit__(self, *_):
        return False

    async def json(self, **_):
        return self.payload


class Session:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        return self.response

    def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        return self.response


def use_response(monkeypatch, provider, response):
    session = Session(response)
    monkeypatch.setattr(provider, "_get_session", AsyncMock(return_value=session))
    return session


@pytest.mark.parametrize("provider_type", [CapitolTradesWatcher, DefenseContractsListener])
@pytest.mark.parametrize("failure", ["empty", "http", "exception", "malformed"])
async def test_empty_or_failed_awards_and_filings_never_persist(monkeypatch, provider_type, failure):
    warehouse = Mock(spec=DuckWarehouse)
    provider = provider_type(warehouse)
    payload = [] if provider_type is CapitolTradesWatcher else {"results": []}
    response = Response(payload)
    if failure == "http":
        response.status = 503
    elif failure == "exception":
        response.error = OSError("offline")
    elif failure == "malformed":
        response.payload = {"results": "invalid"}
    use_response(monkeypatch, provider, response)
    result = await (provider.fetch_recent_trades() if isinstance(provider, CapitolTradesWatcher)
                    else provider.fetch_recent_contracts())
    assert result == []
    warehouse.insert_intelligence.assert_not_called()


@pytest.mark.parametrize("date_format", ["%Y-%m-%d", "%m/%d/%Y"])
async def test_capitol_filters_real_filings_and_preserves_ranges(monkeypatch, date_format):
    warehouse = Mock(spec=DuckWarehouse)
    provider = CapitolTradesWatcher(warehouse)
    today = datetime.now(UTC).date()
    recent = {"ticker": "NVDA", "representative": "Source Representative", "type": "purchase",
              "transaction_date": today.strftime(date_format), "amount": "$15,001 - $50,000",
              "disclosure_date": today.isoformat()}
    records = [recent, {**recent, "ticker": "MSFT"},
               {**recent, "transaction_date": (today - timedelta(days=60)).isoformat()},
               {**recent, "transaction_date": (today + timedelta(days=1)).isoformat()},
               {**recent, "transaction_date": "unknown"}, None]
    use_response(monkeypatch, provider, Response(records))
    result = await provider.fetch_recent_trades(lookback_days=30, symbols={"nvda"})
    assert len(result) == 1
    assert result[0]["symbol"] == "NVDA"
    assert result[0]["amount_usd"] is None
    detail = json.loads(result[0]["detail"])
    assert detail["amount_range"] == recent["amount"]
    assert detail["transaction_date"] == recent["transaction_date"]
    assert detail["date"] == today.isoformat()
    assert detail["politician"] == recent["representative"]
    warehouse.insert_intelligence.assert_called_once()
    assert warehouse.insert_intelligence.call_args.args[4] is None


async def test_capitol_empty_symbol_filter_and_missing_amount_do_not_invent(monkeypatch):
    warehouse = Mock(spec=DuckWarehouse)
    provider = CapitolTradesWatcher(warehouse)
    record = {"ticker": "LMT", "transaction_date": datetime.now(UTC).date().isoformat()}
    use_response(monkeypatch, provider, Response([record]))
    assert await provider.fetch_recent_trades(symbols=set()) == []
    warehouse.insert_intelligence.assert_not_called()
    result = await provider.fetch_recent_trades(symbols={"LMT"})
    assert result[0]["amount_usd"] is None
    assert json.loads(result[0]["detail"])["amount_range"] is None
    assert json.loads(result[0]["detail"])["type"] is None


async def test_contracts_keep_source_fields_and_a_real_zero_award(monkeypatch):
    warehouse = Mock(spec=DuckWarehouse)
    provider = DefenseContractsListener(warehouse)
    record = {"Recipient Name": "Lockheed Martin Corporation", "Award Amount": 0,
              "Awarding Agency": "NASA", "Description": "Source description",
              "Action Date": "2026-10-10", "Award ID": "SOURCE-AWARD-ID"}
    session = use_response(monkeypatch, provider, Response({"results": [record, {
        "Recipient Name": "Unmapped Recipient", "Award Amount": 500,
    }]}))
    result = await provider.fetch_recent_contracts(lookback_days=3, limit=8)
    assert len(result) == 1
    assert result[0]["amount_usd"] == 0
    detail = json.loads(result[0]["detail"])
    assert detail == {"recipient": record["Recipient Name"], "award_id": record["Award ID"],
                      "agency": "NASA", "description": "Source description", "date": "2026-10-10"}
    assert session.calls[0][2]["json"]["limit"] == 8
    warehouse.insert_intelligence.assert_called_once()
    assert warehouse.insert_intelligence.call_args.args[4] == 0


@pytest.mark.parametrize("amount", [None, "invalid", "NaN", "Infinity", float("nan"), True])
async def test_contract_missing_or_invalid_fields_remain_unknown(monkeypatch, amount):
    warehouse = Mock(spec=DuckWarehouse)
    provider = DefenseContractsListener(warehouse)
    use_response(monkeypatch, provider, Response({"results": [{
        "Recipient Name": "Palantir", "Award Amount": amount,
    }]}))
    result = await provider.fetch_recent_contracts()
    assert len(result) == 1
    assert result[0]["amount_usd"] is None
    detail = json.loads(result[0]["detail"])
    assert detail["agency"] is None
    assert detail["description"] is None
    assert detail["date"] is None
    assert "Department of Defense" not in result[0]["headline"]
    assert "$" not in result[0]["headline"]
    assert warehouse.insert_intelligence.call_args.args[4] is None


@pytest.mark.parametrize("response", [Response(status=404), Response(error=OSError("offline")),
                                      Response({}), Response({"jobs": "invalid"})])
async def test_unavailable_job_board_has_unknown_counts(monkeypatch, response):
    provider = HeadcountVelocityTracker()
    use_response(monkeypatch, provider, response)
    result = await provider.fetch_company_headcount("PLTR")
    assert result["available"] is False
    assert result["total_openings"] is None
    assert result["rd_engineering_openings"] is None
    assert result["sales_openings"] is None
    assert result["ga_openings"] is None
    assert result["talent_index_delta_pct"] is None
    assert result["signal"] == "UNAVAILABLE"


async def test_valid_empty_job_board_is_zero_without_invented_velocity(monkeypatch):
    provider = HeadcountVelocityTracker()
    use_response(monkeypatch, provider, Response({"jobs": []}))
    result = await provider.fetch_company_headcount("PLTR")
    assert result["available"] is True
    assert result["total_openings"] == 0
    assert result["rd_engineering_openings"] == 0
    assert result["talent_index_delta_pct"] is None
    assert result["signal"] == "CURRENT_OPENINGS"


async def test_job_counts_are_an_explicit_current_department_heuristic(monkeypatch):
    provider = HeadcountVelocityTracker()
    use_response(monkeypatch, provider, Response({"jobs": [
        {"title": "Software Engineer"}, {"title": "Account Executive", "departments": [{"name": "Sales"}]},
        {"title": "Payroll Specialist"},
    ]}))
    result = await provider.fetch_company_headcount("PLTR")
    assert result["total_openings"] == 3
    assert result["rd_engineering_openings"] == 1
    assert result["sales_openings"] == 1
    assert result["ga_openings"] == 1
    assert result["department_classification"] == "title_and_department_keyword_heuristic"
    assert result["talent_index_delta_pct"] is None


@pytest.mark.parametrize("key", [None, "", "   "])
async def test_macro_missing_api_key_never_queries_demo_or_persists(monkeypatch, key):
    warehouse = Mock(spec=DuckWarehouse)
    provider = MacroStressPoller(api_key=key, warehouse=warehouse)
    get_session = AsyncMock(side_effect=AssertionError("missing key must not query FRED"))
    monkeypatch.setattr(provider, "_get_session", get_session)
    result = await provider.compute_current_stress()
    assert result["status"] == "UNAVAILABLE"
    assert result["missing_series"] == ["SOFR", "BAMLH0A0HYM2", "T10Y2Y"]
    assert result["stress_score"] is None
    get_session.assert_not_called()
    warehouse.insert_macro_stress.assert_not_called()


@pytest.mark.parametrize("missing", [None, float("nan"), float("inf"), OSError("offline")])
async def test_macro_requires_all_finite_series_before_persisting(monkeypatch, missing):
    warehouse = Mock(spec=DuckWarehouse)
    provider = MacroStressPoller(api_key="test-key", warehouse=warehouse)
    monkeypatch.setattr(provider, "fetch_series_observation", AsyncMock(side_effect=[0.0, missing, 0.0]))
    result = await provider.compute_current_stress()
    assert result["available"] is False
    assert result["missing_series"] == ["BAMLH0A0HYM2"]
    assert result["stress_score"] is None
    assert result["inversion_alert"] is None
    warehouse.insert_macro_stress.assert_not_called()


@pytest.mark.parametrize("response", [Response({"observations": []}), Response(status=503),
                                      Response(error=OSError("offline")),
                                      Response({"observations": [{"value": "NaN"}]})])
async def test_macro_empty_failed_or_nonfinite_http_observation_is_missing(monkeypatch, response):
    provider = MacroStressPoller(api_key="test-key", warehouse=Mock(spec=DuckWarehouse))
    use_response(monkeypatch, provider, response)
    assert await provider.fetch_series_observation("SOFR") is None


@pytest.mark.parametrize("value", [0, "0.0"])
async def test_macro_real_zero_observations_compute_and_persist(monkeypatch, value):
    warehouse = Mock(spec=DuckWarehouse)
    provider = MacroStressPoller(api_key="test-key", warehouse=warehouse)
    session = use_response(monkeypatch, provider, Response({"observations": [{"value": value}]}))
    result = await provider.compute_current_stress()
    assert result["available"] is True
    assert result["missing_series"] == []
    assert result["sofr"] == 0
    assert result["hy_spread_pct"] == 0
    assert result["yield_curve_10y2y"] == 0
    assert result["stress_score"] == 0
    assert result["inversion_alert"] is False
    assert len(session.calls) == 3
    assert {call[2]["params"]["series_id"] for call in session.calls} == {"SOFR", "BAMLH0A0HYM2", "T10Y2Y"}
    assert all(call[2]["params"]["api_key"] == "test-key" for call in session.calls)
    warehouse.insert_macro_stress.assert_called_once()
    assert warehouse.insert_macro_stress.call_args.args[1:5] == (0.0, 0.0, 0.0, 0.0)
