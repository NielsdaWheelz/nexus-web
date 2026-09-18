"""Server-side quote resolution: {exact, prefix?, suffix?} -> (fragment, offsets).

The read-only sibling of ``chat_quote`` (which only renders). The house agent,
holding a passage's *text*, has no browser DOM to compute offsets from; this
module anchors that text against ``fragments.canonical_text`` — the same source
of truth ``highlights.create_highlight_for_fragment`` derives its
exact/prefix/suffix from.
"""

from __future__ import annotations

import unicodedata
from array import array
from dataclasses import dataclass
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


# ---------------------------------------------------------------------------
# Normalized-space matching for passage anchors
# (universal-link-authoring-hard-cutover.md, Passage Anchor). Quote identity is
# normalized (NFC, whitespace runs -> one space, trimmed ends); these helpers
# match that identity against current owner text and map hits back to raw
# codepoint offsets.
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class NormalizedText:
    """Whitespace-collapsed NFC text with compact source boundaries.

    Normalized character ``i`` spans ``[boundaries[i], boundaries[i + 1])``
    in the NFC source. A collapsed whitespace run maps to one U+0020.
    These codepoint offsets address stored text directly when it is NFC.
    """

    text: str
    boundaries: array[int]


def normalize_for_match(text: str) -> NormalizedText:
    nfc = unicodedata.normalize("NFC", text)
    chars: list[str] = []
    boundaries = array("Q", [0])
    i = 0
    length = len(nfc)
    while i < length:
        if nfc[i].isspace():
            j = i
            while j < length and nfc[j].isspace():
                j += 1
            chars.append(" ")
            boundaries.append(j)
            i = j
        else:
            chars.append(nfc[i])
            boundaries.append(i + 1)
            i += 1
    return NormalizedText(text="".join(chars), boundaries=boundaries)


@dataclass(frozen=True, slots=True)
class QuoteCandidate:
    raw_start: int
    raw_end: int
    normalized_start: int
    normalized_end: int


def find_quote_candidates(
    normalized: NormalizedText,
    *,
    exact: str,
    prefix: str,
    suffix: str,
) -> list[QuoteCandidate]:
    """Occurrences of a normalized quote, narrowed by normalized context.

    ``exact``/``prefix``/``suffix`` must already be normalized (trimmed), so the
    context comparison tolerates the single collapsed space at each seam.
    """
    candidates: list[QuoteCandidate] = []
    for start in _find_all_occurrences(normalized.text, exact):
        end = start + len(exact)
        if prefix and not normalized.text[:start].rstrip().endswith(prefix):
            continue
        if suffix and not normalized.text[end:].lstrip().startswith(suffix):
            continue
        candidates.append(
            QuoteCandidate(
                raw_start=normalized.boundaries[start],
                raw_end=normalized.boundaries[end],
                normalized_start=start,
                normalized_end=end,
            )
        )
    return candidates


def context_window(normalized: NormalizedText, *, start: int, end: int) -> tuple[str, str]:
    """Nearest 64 normalized scalars each side, trimmed (shorter at boundaries)."""
    prefix = normalized.text[max(0, start - PREFIX_SUFFIX_WINDOW) : start].strip()
    suffix = normalized.text[end : end + PREFIX_SUFFIX_WINDOW].strip()
    return prefix, suffix


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


_NO_OWNER_MATCH = OwnerQuoteMatch(QuoteStatus.no_match, None, None, None, "", "", None, None)


@dataclass(frozen=True, slots=True)
class NormalizedOwnerSource:
    """One owner text unit, fetched and normalized once, matchable many times."""

    fragment_id: UUID | None
    t_start_ms: int | None
    t_end_ms: int | None
    normalized: NormalizedText


# Request-scoped memo of one media's normalized fragment sources, keyed by
# media_id. A read that resolves many quotes against the same owner threads one
# of these so the O(fragments) fetch+normalize happens once, not per quote.
MediaSourceCache = dict[UUID, list["NormalizedOwnerSource"]]


def load_normalized_media_sources(
    db: Session, *, media_id: UUID, cache: MediaSourceCache | None = None
) -> list[NormalizedOwnerSource]:
    """Fetch and normalize a media's fragments once for repeated quote matching.

    When ``cache`` is supplied the fetch+normalize is memoized by ``media_id``,
    so a caller resolving many quotes against the same owner (e.g. a reader
    connections page of same-media passage anchors) reloads the document once.
    """
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
    sources: list[NormalizedOwnerSource],
    *,
    exact: str,
    prefix: str = "",
    suffix: str = "",
) -> OwnerQuoteMatch:
    """Match one normalized quote against pre-normalized owner sources.

    The pure-matching half of ``resolve_owner_quote``: callers resolving many
    quotes against the same owner (highlight cache repair) load the sources once
    and call this per quote instead of re-fetching the whole document each time.
    """
    if not exact:
        return OwnerQuoteMatch(QuoteStatus.empty_exact, None, None, None, "", "", None, None)

    hits: list[tuple[NormalizedOwnerSource, QuoteCandidate]] = []
    for source in sources:
        for candidate in find_quote_candidates(
            source.normalized, exact=exact, prefix=prefix, suffix=suffix
        ):
            hits.append((source, candidate))

    if len(hits) > 1:
        return OwnerQuoteMatch(QuoteStatus.ambiguous, None, None, None, "", "", None, None)
    if not hits:
        return _NO_OWNER_MATCH

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
    """Resolve a normalized quote within one owner's current text.

    Owners are ``media`` (fragment canonical_text; web/EPUB/transcript) or
    ``note_block`` (body_text). Unique hits carry raw codepoint offsets into the
    matched text plus the recomputed 64-scalar normalized context. Visibility is
    the caller's concern. ``sources_cache`` memoizes the media fetch+normalize
    across quotes that share one owner.
    """
    if not exact:
        return OwnerQuoteMatch(QuoteStatus.empty_exact, None, None, None, "", "", None, None)

    if owner_scheme == "note_block":
        body_text = db.execute(
            select(NoteBlock.body_text).where(NoteBlock.id == owner_id)
        ).scalar_one_or_none()
        if body_text is None:
            return _NO_OWNER_MATCH
        sources = [NormalizedOwnerSource(None, None, None, normalize_for_match(body_text))]
    else:
        sources = load_normalized_media_sources(db, media_id=owner_id, cache=sources_cache)

    return match_quote_in_sources(sources, exact=exact, prefix=prefix, suffix=suffix)
