"""Server-side quote anchoring: {exact, prefix?, suffix?} -> (fragment, offsets).

Quote identity is normalized (NFC, whitespace runs to one space, trimmed ends) and
matching is unique-or-nothing: more than one hit is ``ambiguous``, never the first.
"""

from __future__ import annotations

import unicodedata
from array import array
from collections import Counter
from dataclasses import dataclass, replace
from enum import Enum
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import Fragment, NoteBlock
from nexus.services.pdf_quote_match import PREFIX_SUFFIX_WINDOW


class QuoteStatus(str, Enum):
    unique = "unique"
    ambiguous = "ambiguous"
    no_match = "no_match"
    empty_exact = "empty_exact"


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


@dataclass(frozen=True, slots=True)
class NormalizedOwnerSource:
    fragment_id: UUID | None
    t_start_ms: int | None
    t_end_ms: int | None
    normalized: NormalizedText


@dataclass(frozen=True, slots=True)
class OwnerQuoteMatch:
    status: QuoteStatus
    fragment_id: UUID | None
    raw_start: int | None
    raw_end: int | None
    prefix: str
    suffix: str
    t_start_ms: int | None
    t_end_ms: int | None


# Request-scoped memo of one media's normalized fragments, keyed by media_id.
MediaSourceCache = dict[UUID, list[NormalizedOwnerSource]]

_NO_MATCH = OwnerQuoteMatch(QuoteStatus.no_match, None, None, None, "", "", None, None)
_EMPTY_EXACT = OwnerQuoteMatch(QuoteStatus.empty_exact, None, None, None, "", "", None, None)


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


def context_window(normalized: NormalizedText, *, start: int, end: int) -> tuple[str, str]:
    """Nearest 64 normalized scalars each side, trimmed (shorter at boundaries)."""
    prefix = normalized.text[max(0, start - PREFIX_SUFFIX_WINDOW) : start].strip()
    suffix = normalized.text[end : end + PREFIX_SUFFIX_WINDOW].strip()
    return prefix, suffix


def load_normalized_media_sources(
    db: Session, *, media_id: UUID, cache: MediaSourceCache | None = None
) -> list[NormalizedOwnerSource]:
    """Fetch and normalize one media's fragments once, memoized by ``cache``."""
    if cache is not None and media_id in cache:
        return cache[media_id]
    rows = db.execute(
        select(Fragment.id, Fragment.canonical_text, Fragment.t_start_ms, Fragment.t_end_ms)
        .where(Fragment.media_id == media_id)
        .order_by(Fragment.idx)
    ).all()
    sources = [
        NormalizedOwnerSource(row[0], row[2], row[3], normalize_for_match(row[1])) for row in rows
    ]
    if cache is not None:
        cache[media_id] = sources
    return sources


def match_quote_in_sources(
    sources: list[NormalizedOwnerSource], *, exact: str, prefix: str = "", suffix: str = ""
) -> OwnerQuoteMatch:
    """Match one normalized quote against pre-normalized owner sources."""
    if not exact:
        return _EMPTY_EXACT
    hits = [
        (source, candidate)
        for source in sources
        for candidate in find_quote_candidates(
            source.normalized, exact=exact, prefix=prefix, suffix=suffix
        )
    ]
    if len(hits) > 1:
        return OwnerQuoteMatch(QuoteStatus.ambiguous, None, None, None, "", "", None, None)
    if not hits:
        return _NO_MATCH
    source, candidate = hits[0]
    context_prefix, context_suffix = context_window(
        source.normalized, start=candidate.normalized_start, end=candidate.normalized_end
    )
    return OwnerQuoteMatch(
        status=QuoteStatus.unique,
        fragment_id=source.fragment_id,
        raw_start=candidate.raw_start,
        raw_end=candidate.raw_end,
        prefix=context_prefix,
        suffix=context_suffix,
        t_start_ms=source.t_start_ms,
        t_end_ms=source.t_end_ms,
    )


def resolve_owner_quote(
    db: Session,
    *,
    owner_scheme: str,
    owner_id: UUID,
    exact: str,
    prefix: str = "",
    suffix: str = "",
    sources_cache: MediaSourceCache | None = None,
) -> OwnerQuoteMatch:
    """Resolve a normalized quote within one owner's current text (media or note block)."""
    if not exact:
        return _EMPTY_EXACT
    if owner_scheme == "note_block":
        body_text = db.execute(
            select(NoteBlock.body_text).where(NoteBlock.id == owner_id)
        ).scalar_one_or_none()
        if body_text is None:
            return _NO_MATCH
        sources = [NormalizedOwnerSource(None, None, None, normalize_for_match(body_text))]
        match = match_quote_in_sources(sources, exact=exact, prefix=prefix, suffix=suffix)
        return _project_note_match(body_text, match, exact=exact)
    sources = load_normalized_media_sources(db, media_id=owner_id, cache=sources_cache)
    return match_quote_in_sources(sources, exact=exact, prefix=prefix, suffix=suffix)


def _project_note_match(text: str, match: OwnerQuoteMatch, *, exact: str) -> OwnerQuoteMatch:
    """Map a normalized note hit onto the same contiguous interval of the stored text.

    Equal NFD components keep their occurrence order through NFC, so counting the
    selected interval's components and their predecessors locates it without building
    a per-character source map. An interval that cannot be represented contiguously is
    refused rather than widened or moved to another occurrence.
    """
    if match.raw_start is None or match.raw_end is None:
        return match
    nfc = unicodedata.normalize("NFC", text)
    if nfc == text:
        return match
    remaining = Counter(unicodedata.normalize("NFD", nfc[match.raw_start : match.raw_end]))
    preceding = Counter(
        component
        for component in unicodedata.normalize("NFD", nfc[: match.raw_start])
        if component in remaining
    )
    start, end = len(text), 0
    for index, char in enumerate(text):
        for component in unicodedata.normalize("NFD", char):
            if preceding[component]:
                preceding[component] -= 1
            elif remaining[component]:
                remaining[component] -= 1
                start = min(start, index)
                end = index + 1
    if normalize_for_match(text[start:end]).text.strip() != exact:
        return _NO_MATCH
    return replace(match, raw_start=start, raw_end=end)
