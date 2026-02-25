"""Pure deterministic PDF quote-match helper (S6 plain_text_match_version=1).

Shared by pr-04 write paths and pr-05 quote/enrichment paths.
No DB I/O, logging, or route/service error mapping.

Algorithm (s6_spec Section 2.4):
1. empty exact -> empty_exact
2. literal codepoint substring match against page-local span
3. exactly one match -> unique with offsets
4. multiple matches -> ambiguous, null offsets
5. zero matches -> no_match (with optional global fallback when page span unavailable)
"""

from dataclasses import dataclass
from enum import Enum as PyEnum

PREFIX_SUFFIX_WINDOW = 64


class MatchStatus(str, PyEnum):
    pending = "pending"
    unique = "unique"
    ambiguous = "ambiguous"
    no_match = "no_match"
    empty_exact = "empty_exact"


class MatcherAnomalyKind(str, PyEnum):
    """Typed recoverable anomaly classifications from the pure matcher."""

    page_span_offset_out_of_range = "page_span_offset_out_of_range"
    page_span_inconsistent = "page_span_inconsistent"


class MatcherAnomaly(Exception):
    """Recoverable classified anomaly from the pure matcher.

    Callers should handle via pdf_quote_match_policy, not catch-and-ignore.
    """

    def __init__(self, kind: MatcherAnomalyKind, detail: str):
        self.kind = kind
        self.detail = detail
        super().__init__(f"{kind.value}: {detail}")


@dataclass(frozen=True, slots=True)
class MatchResult:
    """Structured result of PDF quote-match computation."""

    status: MatchStatus
    match_version: int | None
    start_offset: int | None
    end_offset: int | None
    prefix: str
    suffix: str


def compute_match(
    exact: str,
    page_number: int,
    plain_text: str,
    page_span_start: int | None,
    page_span_end: int | None,
) -> MatchResult:
    """Compute deterministic PDF quote-match result.

    Args:
        exact: Highlight exact text (may be empty).
        page_number: 1-based page number of the highlight.
        plain_text: Full normalized media.plain_text.
        page_span_start: Start offset of this page in plain_text (None if unavailable).
        page_span_end: End offset of this page in plain_text (None if unavailable).

    Returns:
        MatchResult with status, offsets, prefix, suffix.

    Raises:
        MatcherAnomaly: On recoverable classified inconsistency.
    """
    if not exact:
        return MatchResult(
            status=MatchStatus.empty_exact,
            match_version=1,
            start_offset=None,
            end_offset=None,
            prefix="",
            suffix="",
        )

    text_len = len(plain_text)

    if page_span_start is not None and page_span_end is not None:
        if page_span_start < 0 or page_span_end < 0:
            raise MatcherAnomaly(
                MatcherAnomalyKind.page_span_offset_out_of_range,
                f"negative offsets: start={page_span_start}, end={page_span_end}",
            )
        if page_span_start > text_len or page_span_end > text_len:
            raise MatcherAnomaly(
                MatcherAnomalyKind.page_span_offset_out_of_range,
                f"offsets exceed text length {text_len}: "
                f"start={page_span_start}, end={page_span_end}",
            )
        if page_span_start > page_span_end:
            raise MatcherAnomaly(
                MatcherAnomalyKind.page_span_inconsistent,
                f"start > end: {page_span_start} > {page_span_end}",
            )

        page_text = plain_text[page_span_start:page_span_end]
        matches = _find_all_occurrences(page_text, exact)

        if len(matches) == 1:
            abs_start = page_span_start + matches[0]
            abs_end = abs_start + len(exact)
            prefix = _derive_prefix(plain_text, abs_start)
            suffix = _derive_suffix(plain_text, abs_end)
            return MatchResult(
                status=MatchStatus.unique,
                match_version=1,
                start_offset=abs_start,
                end_offset=abs_end,
                prefix=prefix,
                suffix=suffix,
            )
        elif len(matches) > 1:
            return MatchResult(
                status=MatchStatus.ambiguous,
                match_version=1,
                start_offset=None,
                end_offset=None,
                prefix="",
                suffix="",
            )
        else:
            return MatchResult(
                status=MatchStatus.no_match,
                match_version=1,
                start_offset=None,
                end_offset=None,
                prefix="",
                suffix="",
            )
    else:
        # Page span unavailable: global fallback per S6 rules
        matches = _find_all_occurrences(plain_text, exact)

        if len(matches) == 1:
            abs_start = matches[0]
            abs_end = abs_start + len(exact)
            prefix = _derive_prefix(plain_text, abs_start)
            suffix = _derive_suffix(plain_text, abs_end)
            return MatchResult(
                status=MatchStatus.unique,
                match_version=1,
                start_offset=abs_start,
                end_offset=abs_end,
                prefix=prefix,
                suffix=suffix,
            )
        elif len(matches) > 1:
            return MatchResult(
                status=MatchStatus.ambiguous,
                match_version=1,
                start_offset=None,
                end_offset=None,
                prefix="",
                suffix="",
            )
        else:
            return MatchResult(
                status=MatchStatus.no_match,
                match_version=1,
                start_offset=None,
                end_offset=None,
                prefix="",
                suffix="",
            )


def _find_all_occurrences(text: str, needle: str) -> list[int]:
    """Find all codepoint-offset occurrences of needle in text (literal match)."""
    positions = []
    start = 0
    while True:
        idx = text.find(needle, start)
        if idx == -1:
            break
        positions.append(idx)
        start = idx + 1
    return positions


def _derive_prefix(plain_text: str, start: int) -> str:
    return plain_text[max(0, start - PREFIX_SUFFIX_WINDOW) : start]


def _derive_suffix(plain_text: str, end: int) -> str:
    return plain_text[end : min(len(plain_text), end + PREFIX_SUFFIX_WINDOW)]
