"""Server-side quote resolution: {exact, prefix?, suffix?} -> (fragment, offsets).

The read-only sibling of ``chat_quote`` (which only renders). The house agent,
holding a passage's *text*, has no browser DOM to compute offsets from; this
module anchors that text against ``fragments.canonical_text`` — the same source
of truth ``highlights.create_highlight_for_fragment`` derives its
exact/prefix/suffix from.

Mirrors ``pdf_quote_match.compute_match``: a quote resolves to offsets only when
it is *unique*. Multiple occurrences are ``ambiguous`` and a miss is
``no_match`` — both return null offsets. The caller (a write tool) turns either
into a refusal that asks the model to quote more surrounding text; it never
guesses a wrong anchor (amanuensis D-4).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import Fragment


class QuoteStatus(str, Enum):
    unique = "unique"
    ambiguous = "ambiguous"
    no_match = "no_match"
    empty_exact = "empty_exact"


@dataclass(frozen=True, slots=True)
class QuoteResolution:
    status: QuoteStatus
    fragment_id: UUID | None
    start_offset: int | None
    end_offset: int | None


@dataclass(frozen=True, slots=True)
class _Candidate:
    fragment_id: UUID
    start: int
    end: int


def resolve(
    db: Session,
    *,
    media_id: UUID,
    exact: str,
    prefix: str | None = None,
    suffix: str | None = None,
) -> QuoteResolution:
    """Resolve a quote to a single fragment anchor across a media's fragments.

    Visibility is the caller's concern — the write tool asserts the media is
    readable before calling. This scans every fragment's canonical text; a quote
    that occurs exactly once (after any prefix/suffix narrowing) is ``unique``.
    """
    if not exact:
        return QuoteResolution(QuoteStatus.empty_exact, None, None, None)

    prefix = prefix or ""
    suffix = suffix or ""

    fragments = db.execute(
        select(Fragment.id, Fragment.canonical_text)
        .where(Fragment.media_id == media_id)
        .order_by(Fragment.idx)
    ).all()

    candidates: list[_Candidate] = []
    for fragment_id, canonical_text in fragments:
        for start in _find_all_occurrences(canonical_text, exact):
            end = start + len(exact)
            if prefix and not canonical_text[:start].endswith(prefix):
                continue
            if suffix and not canonical_text[end:].startswith(suffix):
                continue
            candidates.append(_Candidate(fragment_id=fragment_id, start=start, end=end))

    if len(candidates) == 1:
        hit = candidates[0]
        return QuoteResolution(QuoteStatus.unique, hit.fragment_id, hit.start, hit.end)
    if len(candidates) > 1:
        return QuoteResolution(QuoteStatus.ambiguous, None, None, None)
    return QuoteResolution(QuoteStatus.no_match, None, None, None)


def _find_all_occurrences(text: str, needle: str) -> list[int]:
    """All codepoint-offset occurrences of ``needle`` in ``text`` (literal)."""
    positions: list[int] = []
    start = 0
    while True:
        idx = text.find(needle, start)
        if idx == -1:
            break
        positions.append(idx)
        start = idx + 1
    return positions
