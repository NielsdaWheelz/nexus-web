# Frozen for migration 0293 from d6f04890c:python/nexus/services/text_quote.py (its pure matcher).
"""Server-side quote anchoring: {exact, prefix?, suffix?} -> (fragment, offsets).

Quote identity is normalized (NFC, whitespace runs to one space, trimmed ends) and
matching is unique-or-nothing: more than one hit is ``ambiguous``, never the first.
"""

from __future__ import annotations

import unicodedata
from array import array
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class NormalizedText:
    """Normalized character ``i`` spans ``[boundaries[i], boundaries[i + 1])`` in the NFC source."""

    text: str
    boundaries: array[int]


@dataclass(frozen=True, slots=True)
class QuoteCandidate:
    raw_start: int
    raw_end: int
    normalized_start: int
    normalized_end: int


def normalize_for_match(text: str) -> NormalizedText:
    nfc = unicodedata.normalize("NFC", text)
    chars: list[str] = []
    boundaries = array("Q", [0])
    i = 0
    while i < len(nfc):
        j = i + 1
        if nfc[i].isspace():
            while j < len(nfc) and nfc[j].isspace():
                j += 1
            chars.append(" ")
        else:
            chars.append(nfc[i])
        boundaries.append(j)
        i = j
    return NormalizedText(text="".join(chars), boundaries=boundaries)


def find_quote_candidates(
    normalized: NormalizedText, *, exact: str, prefix: str, suffix: str
) -> list[QuoteCandidate]:
    """Occurrences of an already-normalized quote, narrowed by normalized context."""
    candidates: list[QuoteCandidate] = []
    start = normalized.text.find(exact)
    while start != -1:
        end = start + len(exact)
        if (not prefix or normalized.text[:start].rstrip().endswith(prefix)) and (
            not suffix or normalized.text[end:].lstrip().startswith(suffix)
        ):
            candidates.append(
                QuoteCandidate(normalized.boundaries[start], normalized.boundaries[end], start, end)
            )
        start = normalized.text.find(exact, start + 1)
    return candidates
