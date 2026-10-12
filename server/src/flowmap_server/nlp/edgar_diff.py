"""SEC EDGAR Item 1A text differences and literal keyword matches (DOCS <GO>).

Describes SEC EDGAR corporate filings without assessing materiality:
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
    header = re.search(r"\bitem\s+1a\b[.\s:-]*risk\s+factors\b", document_text, re.IGNORECASE)
    if header is None:
        return ""
    tail = document_text[header.end():]
    following_item = re.search(r"\bitem\s+\d+[a-z]?\b[.\s:-]", tail, re.IGNORECASE)
    return tail[:following_item.start()].strip() if following_item else tail.strip()


def compute_risk_delta(prev_text: str, curr_text: str) -> dict[str, Any]:
    """Compare Item 1A sections in full filing texts using a keyword heuristic.

    Neither keyword matches nor line counts establish a material change. The
    legacy ``is_material_change`` key remains false; use ``has_keyword_matches``
    for the descriptive flag. Missing either section makes comparison unavailable.
    """
    previous = extract_risk_factors(prev_text)
    current = extract_risk_factors(curr_text)
    available = bool(previous and current)
    prev_lines = [line.strip() for line in previous.splitlines() if line.strip()] if available else []
    curr_lines = [line.strip() for line in current.splitlines() if line.strip()] if available else []

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

    # Literal matches only: this does not classify risk, severity or materiality.
    critical_flags: list[str] = []
    for added in added_sentences:
        lower_sent = added.lower()
        for term in CRITICAL_TRIGGER_TERMS:
            if re.search(r"\b" + re.escape(term) + r"\b", lower_sent):
                critical_flags.append(f"Literal keyword match: '{term}' in added text: {added[:120]}")

    return {
        "added_count": len(added_sentences),
        "deleted_count": len(deleted_sentences),
        "added_samples": added_sentences[:10],
        "deleted_samples": deleted_sentences[:10],
        "critical_flags": list(dict.fromkeys(critical_flags)),
        "available": available,
        "unavailable_reason": None if available else "Item 1A Risk Factors section missing or empty",
        "method": "literal keyword heuristic on Item 1A text; not a materiality assessment",
        "has_keyword_matches": bool(critical_flags),
        "materiality_assessed": False,
        "is_material_change": False,
    }
