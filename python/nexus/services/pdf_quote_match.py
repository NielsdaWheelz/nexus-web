"""Pure deterministic PDF quote-match helper.

Shared by PDF highlight write paths and quote/enrichment paths.
No DB I/O, logging, or route/service error mapping.

Algorithm:
1. empty exact -> empty_exact
2. literal codepoint substring match against page-local span
3. exactly one match -> unique with offsets
4. multiple matches -> ambiguous, null offsets
5. zero page-local matches -> no_match unless no page span is available
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


@dataclass(frozen=True, slots=True)
class MatchResult:
    """Structured result of PDF quote-match computation."""

    status: MatchStatus
    start_offset: int | None
    end_offset: int | None
    prefix: str
    suffix: str


def compute_match(
    exact: str,
    plain_text: str,
    page_span_start: int | None,
    page_span_end: int | None,
) -> MatchResult:
    """Compute deterministic PDF quote-match result.

    Args:
        exact: Highlight exact text (may be empty).
        plain_text: Full normalized media.plain_text.
        page_span_start: Start offset of this page in plain_text (None if unavailable).
        page_span_end: End offset of this page in plain_text (None if unavailable).

    Returns:
        MatchResult with status, offsets, prefix, suffix.
    """
    if not exact:
        return MatchResult(
            status=MatchStatus.empty_exact,
            start_offset=None,
            end_offset=None,
            prefix="",
            suffix="",
        )

    if page_span_start is not None and page_span_end is not None:
        page_text = plain_text[page_span_start:page_span_end]
        matches = _find_all_occurrences(page_text, exact)

        return _result_for_matches(
            matches, exact=exact, plain_text=plain_text, base_offset=page_span_start
        )
    else:
        # No page-local boundary is available, so search the full normalized text.
        matches = _find_all_occurrences(plain_text, exact)

        return _result_for_matches(matches, exact=exact, plain_text=plain_text, base_offset=0)


def _result_for_matches(
    matches: list[int],
    *,
    exact: str,
    plain_text: str,
    base_offset: int,
) -> MatchResult:
    """Build the MatchResult for a set of occurrences within `plain_text`.

    `base_offset` shifts match positions to absolute offsets (the page-span start,
    or 0 for a full-text search).
    """
    if len(matches) == 1:
        abs_start = base_offset + matches[0]
        abs_end = abs_start + len(exact)
        return MatchResult(
            status=MatchStatus.unique,
            start_offset=abs_start,
            end_offset=abs_end,
            prefix=_derive_prefix(plain_text, abs_start),
            suffix=_derive_suffix(plain_text, abs_end),
        )
    return MatchResult(
        status=MatchStatus.ambiguous if len(matches) > 1 else MatchStatus.no_match,
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
