"""SEC EDGAR 10-K / 10-Q Item 1A Risk Factors Semantic Diff Engine (DOCS <GO>).

Analyzes SEC EDGAR corporate filings for silent, critical risk disclosures:
- Extracts Item 1A. Risk Factors sections using HTML/text parsing.
- Computes sentence-level insertions and deletions using difflib.unified_diff.
- Flags critical institutional trigger keywords:
  "DOJ", "investigation", "subpoena", "material weakness", "restatement",
  "sanctions", "default", "whistleblower", "litigation".
"""

from __future__ import annotations

import difflib
import logging
import re
from typing import Any

log = logging.getLogger(__name__)

CRITICAL_TRIGGER_TERMS = [
    "doj",
    "department of justice",
    "investigation",
    "subpoena",
    "sec probe",
    "material weakness",
    "restatement",
    "whistleblower",
    "sanctions",
    "default",
    "going concern",
    "litigation",
]


def extract_risk_factors(document_text: str) -> str:
    """Extract Item 1A. Risk Factors text from a 10-K or 10-Q filing text."""
    # Look for Item 1A / Item 1A. Risk Factors headers
    pattern = re.compile(
        r"(?:item\s+1a[\.\s]+risk\s+factors)(.*?)(?:item\s+(?:1b|2)[\.\s]+)",
        re.IGNORECASE | re.DOTALL,
    )
    match = pattern.search(document_text)
    if match:
        return match.group(1).strip()

    # Fallback: simple keyword slice
    lower = document_text.lower()
    start = lower.find("item 1a. risk factors")
    if start != -1:
        end = lower.find("item 1b.", start)
        if end != -1:
            return document_text[start:end].strip()
        return document_text[start : start + 50000].strip()

    return document_text[:20000]


def compute_risk_delta(prev_text: str, curr_text: str) -> dict[str, Any]:
    """Compute line/sentence-level delta between previous and current risk factors."""
    prev_lines = [line.strip() for line in prev_text.splitlines() if line.strip()]
    curr_lines = [line.strip() for line in curr_text.splitlines() if line.strip()]

    differ = difflib.unified_diff(
        prev_lines, curr_lines, lineterm="", fromfile="Previous", tofile="Current"
    )

    added_sentences: list[str] = []
    deleted_sentences: list[str] = []

    for line in differ:
        if line.startswith("+") and not line.startswith("+++"):
            cleaned = line[1:].strip()
            if len(cleaned) > 15:
                added_sentences.append(cleaned)
        elif line.startswith("-") and not line.startswith("---"):
            cleaned = line[1:].strip()
            if len(cleaned) > 15:
                deleted_sentences.append(cleaned)

    # Detect high-severity triggers in newly added sentences
    critical_flags: list[str] = []
    for added in added_sentences:
        lower_sent = added.lower()
        for term in CRITICAL_TRIGGER_TERMS:
            if term in lower_sent:
                critical_flags.append(f"Added Risk Warning: '{term.upper()}' mentioned in: {added[:120]}...")

    return {
        "added_count": len(added_sentences),
        "deleted_count": len(deleted_sentences),
        "added_samples": added_sentences[:10],
        "deleted_samples": deleted_sentences[:10],
        "critical_flags": list(set(critical_flags)),
        "is_material_change": len(critical_flags) > 0 or len(added_sentences) >= 5,
    }
