"""Descriptive transcript phrases and an uncalibrated acoustic composite.

Transcript text contains no measured pitch, jitter, shimmer or pause duration.
Caller-supplied acoustic measures can produce a heuristic descriptor, never a
validated stress, confidence, evasion or deception assessment.
"""

from __future__ import annotations

import math
import re
from typing import Any


def compute_vocal_stress_score(f0_mean: float, f0_std: float, jitter_pct: float,
                               shimmer_pct: float, pause_ratio: float) -> dict[str, Any]:
    """Return an explicitly uncalibrated heuristic from measured inputs."""
    inputs = (f0_mean, f0_std, jitter_pct, shimmer_pct, pause_ratio)
    if (not all(isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value) for value in inputs)
            or f0_mean <= 0 or f0_std < 0 or not 0 <= jitter_pct <= 100
            or not 0 <= shimmer_pct <= 100 or not 0 <= pause_ratio <= 1):
        raise ValueError('acoustic measures require finite values in their physical domains')
    jitter = min(max((jitter_pct - 1.0) / 2.0, 0.0), 1.0)
    shimmer = min(max((shimmer_pct - 3.0) / 4.0, 0.0), 1.0)
    pause = min(max((pause_ratio - 0.15) / 0.35, 0.0), 1.0)
    pitch = min(max((f0_std - 25.0) / 40.0, 0.0), 1.0)
    score = round(0.30 * jitter + 0.25 * shimmer + 0.25 * pause + 0.20 * pitch, 3)
    level = 'HEURISTIC_HIGH' if score >= 0.70 else 'HEURISTIC_MEDIUM' if score >= 0.40 else 'HEURISTIC_LOW'
    return {
        'stress_score': score,
        'classification': level,
        'label': 'Uncalibrated acoustic composite',
        'validated': False,
        'provenance': 'caller-supplied acoustic measures; fixed heuristic weights',
        'metrics': {'f0_mean': float(f0_mean), 'f0_std': float(f0_std),
                    'jitter_pct': float(jitter_pct), 'shimmer_pct': float(shimmer_pct),
                    'pause_ratio': float(pause_ratio)},
    }


def analyze_transcript_qa_segment(speaker: str, question: str, answer: str) -> dict[str, Any]:
    """Count literal hedging phrases without manufacturing acoustic measures."""
    phrases = ('believe', 'hope', 'might', 'potentially', 'at this time', 'as far as I know')
    counts = {phrase: len(re.findall(r'\b' + re.escape(phrase) + r'\b', answer, flags=re.IGNORECASE))
              for phrase in phrases}
    return {
        'speaker': speaker, 'question_preview': question[:100], 'answer_preview': answer[:150],
        'hedge_phrase_count': sum(counts.values()), 'hedge_phrase_counts': counts,
        'stress_score': None, 'metrics': None, 'classification': 'ACOUSTICS_UNAVAILABLE',
        'label': 'Transcript phrase counts; acoustic measures unavailable',
        'validated': False, 'provenance': 'transcript text only; literal phrase matches',
    }