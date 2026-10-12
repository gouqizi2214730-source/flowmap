"""Only identified Item 1A text supports a descriptive risk-section diff."""

import pytest

from flowmap_server.nlp.edgar_diff import compute_risk_delta, extract_risk_factors


@pytest.mark.parametrize("text", [
    "Item 7. Management Discussion\nOrdinary litigation is discussed with operating expenses.",
    "Litigation and an investigation appear in ordinary company correspondence.",
    "Item 1A. Risk Factors\nItem 1B. Unresolved Staff Comments\nA litigation discussion.",
])
def test_missing_or_empty_item_1a_never_becomes_fabricated_risk_text(text):
    assert extract_risk_factors(text) == ""
    result = compute_risk_delta("Item 7. Prior operating results.", text)
    assert result["available"] is False
    assert result["added_count"] == 0
    assert result["deleted_count"] == 0
    assert result["critical_flags"] == []
    assert result["has_keyword_matches"] is False
    assert result["is_material_change"] is False
    assert result["materiality_assessed"] is False


def test_missing_previous_section_does_not_mark_entire_new_section_as_added_risk():
    current = "Item 1A. Risk Factors\nWe face litigation and investigations.\nItem 2. Properties"
    result = compute_risk_delta("Item 7. Management Discussion\nPrior results.", current)
    assert result["available"] is False
    assert result["added_count"] == 0
    assert result["critical_flags"] == []


def test_next_filing_item_is_excluded_from_risk_section():
    filing = "ITEM 1A: RISK FACTORS\nWe face competition.\nITEM 7. MANAGEMENT DISCUSSION\nLitigation is discussed here."
    assert extract_risk_factors(filing) == "We face competition."


def test_real_risk_diff_reports_literal_matches_without_materiality_claims():
    previous = "Item 1A. Risk Factors\nWe face competition.\nItem 1B. Staff comments"
    current = "Item 1A. Risk Factors\nWe face competition.\nWe received a litigation notice.\nItem 1B. Staff comments"
    result = compute_risk_delta(previous, current)
    assert result["available"] is True
    assert result["added_count"] == 1
    assert result["has_keyword_matches"] is True
    assert result["critical_flags"] == ["Literal keyword match: 'litigation' in added text: We received a litigation notice."]
    assert result["materiality_assessed"] is False
    assert result["is_material_change"] is False
    assert "literal keyword heuristic" in result["method"]
    assert "not a materiality assessment" in result["method"]


def test_many_added_lines_do_not_imply_materiality():
    previous = "Item 1A. Risk Factors\nCommon starting risk statement."
    current = previous + "\n" + "\n".join(f"Descriptive added sentence number {n}." for n in range(6))
    result = compute_risk_delta(previous, current)
    assert result["added_count"] == 6
    assert result["has_keyword_matches"] is False
    assert result["is_material_change"] is False
