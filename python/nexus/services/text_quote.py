"""Server-side quote anchoring: {exact, prefix?, suffix?} -> (fragment, offsets).

Quote identity is normalized (NFC, whitespace runs to one space, trimmed ends) and
matching is unique-or-nothing: more than one hit is ``ambiguous``, never the first.
A source may be a bounded slice of its fragment: matching and context stay inside it,
and match offsets are canonical (the slice's ``base`` plus the local offset). At a cut
edge the stored context beyond the slice belongs to no reader of its owner, so only its
part inside the slice must agree; the quote itself never leaves the slice.
"""

from __future__ import annotations

import unicodedata
from array import array
from collections import Counter
from dataclasses import dataclass, replace
from enum import Enum
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock
from nexus.services.media_text_scope import text_scope_rows_sql

# The codepoint window of context stored either side of a matched quote.
PREFIX_SUFFIX_WINDOW = 64


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
    """``normalized`` text whose first codepoint sits at canonical offset ``base``;
    ``start_cut``/``end_cut``: the slice begins/ends inside its fragment's text."""

    fragment_id: UUID | None
    t_start_ms: int | None
    t_end_ms: int | None
    normalized: NormalizedText
    base: int = 0
    start_cut: bool = False
    end_cut: bool = False


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
    normalized: NormalizedText,
    *,
    exact: str,
    prefix: str,
    suffix: str,
    start_cut: bool = False,
    end_cut: bool = False,
) -> list[QuoteCandidate]:
    """Occurrences of an already-normalized quote, narrowed by normalized context; at a
    cut edge, context running past the text compares only its part inside it."""
    candidates: list[QuoteCandidate] = []
    start = normalized.text.find(exact)
    while start != -1:
        end = start + len(exact)
        before = normalized.text[:start].rstrip()
        after = normalized.text[end:].lstrip()
        if (
            not prefix
            or before.endswith(prefix)
            or (start_cut and len(before) < len(prefix) and prefix.endswith(before.lstrip()))
        ) and (
            not suffix
            or after.startswith(suffix)
            or (end_cut and len(after) < len(suffix) and suffix.startswith(after.rstrip()))
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
    """Fetch and normalize one reading owner's text scope once, memoized by ``cache``: a
    source's fragments whole, a piece's bounded slices (``text_scope_rows_sql``)."""
    if cache is not None and media_id in cache:
        return cache[media_id]
    rows = db.execute(
        text(f"""
            SELECT f.id, f.canonical_text, f.t_start_ms, f.t_end_ms, scope.start_offset,
                   scope.end_offset
            FROM ({text_scope_rows_sql("SELECT CAST(:id AS uuid) AS media_id")}) scope
            JOIN fragments f ON f.id = scope.fragment_id
            ORDER BY scope.fragment_idx
        """),
        {"id": media_id},
    ).all()
    sources = [
        NormalizedOwnerSource(
            fragment_id,
            t_start,
            t_end,
            normalize_for_match(words[start:end]),
            start,
            start > 0,
            end < len(words),
        )
        for fragment_id, words, t_start, t_end, start, end in rows
    ]
    if cache is not None:
        cache[media_id] = sources
    return sources


def match_quote_in_sources(
    sources: list[NormalizedOwnerSource], *, exact: str, prefix: str = "", suffix: str = ""
) -> OwnerQuoteMatch:
    """Match one normalized quote against pre-normalized owner sources.

    Overlapping slices can hold one canonical occurrence twice: it counts once, with the
    context of the first slice holding it.
    """
    if not exact:
        return _EMPTY_EXACT
    hits: dict[tuple[UUID | None, int, int], tuple[NormalizedOwnerSource, QuoteCandidate]] = {}
    for source in sources:
        for candidate in find_quote_candidates(
            source.normalized,
            exact=exact,
            prefix=prefix,
            suffix=suffix,
            start_cut=source.start_cut,
            end_cut=source.end_cut,
        ):
            occurrence = (
                source.fragment_id,
                source.base + candidate.raw_start,
                source.base + candidate.raw_end,
            )
            hits.setdefault(occurrence, (source, candidate))
    if len(hits) > 1:
        return OwnerQuoteMatch(QuoteStatus.ambiguous, None, None, None, "", "", None, None)
    if not hits:
        return _NO_MATCH
    source, candidate = next(iter(hits.values()))
    context_prefix, context_suffix = context_window(
        source.normalized, start=candidate.normalized_start, end=candidate.normalized_end
    )
    return OwnerQuoteMatch(
        status=QuoteStatus.unique,
        fragment_id=source.fragment_id,
        raw_start=source.base + candidate.raw_start,
        raw_end=source.base + candidate.raw_end,
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
        return project_note_match(body_text, match, exact=exact)
    sources = load_normalized_media_sources(db, media_id=owner_id, cache=sources_cache)
    return match_quote_in_sources(sources, exact=exact, prefix=prefix, suffix=suffix)


def project_note_match(text: str, match: OwnerQuoteMatch, *, exact: str) -> OwnerQuoteMatch:
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
