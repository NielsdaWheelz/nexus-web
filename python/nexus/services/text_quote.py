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

import unicodedata
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


# ---------------------------------------------------------------------------
# Normalized-space matching for passage anchors
# (universal-link-authoring-hard-cutover.md, Passage Anchor). Quote identity is
# normalized (NFC, whitespace runs -> one space, trimmed ends); these helpers
# match that identity against current owner text and map hits back to raw
# codepoint offsets.
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class NormalizedText:
    """Whitespace-collapsed NFC text with per-char raw spans.

    ``spans[i]`` is the ``[start, end)`` codepoint span in the NFC source that
    normalized char ``i`` came from (a collapsed whitespace run maps to one
    U+0020). Owner texts (fragment canonical_text, media plain_text, note
    body_text) are produced NFC, so NFC here is a no-op and raw spans index the
    stored text directly.
    """

    text: str
    spans: tuple[tuple[int, int], ...]


def normalize_for_match(text: str) -> NormalizedText:
    nfc = unicodedata.normalize("NFC", text)
    chars: list[str] = []
    spans: list[tuple[int, int]] = []
    i = 0
    length = len(nfc)
    while i < length:
        if nfc[i].isspace():
            j = i
            while j < length and nfc[j].isspace():
                j += 1
            chars.append(" ")
            spans.append((i, j))
            i = j
        else:
            chars.append(nfc[i])
            spans.append((i, i + 1))
            i += 1
    return NormalizedText(text="".join(chars), spans=tuple(spans))


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
                raw_start=normalized.spans[start][0],
                raw_end=normalized.spans[end - 1][1],
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


def load_normalized_media_sources(db: Session, *, media_id: UUID) -> list[NormalizedOwnerSource]:
    """Fetch and normalize a media's fragments once for repeated quote matching."""
    rows = db.execute(
        select(Fragment.id, Fragment.canonical_text, Fragment.t_start_ms, Fragment.t_end_ms)
        .where(Fragment.media_id == media_id)
        .order_by(Fragment.idx)
    ).all()
    return [
        NormalizedOwnerSource(row[0], row[2], row[3], normalize_for_match(row[1])) for row in rows
    ]


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
) -> OwnerQuoteMatch:
    """Resolve a normalized quote within one owner's current text.

    Owners are ``media`` (fragment canonical_text; web/EPUB/transcript) or
    ``note_block`` (body_text). Unique hits carry raw codepoint offsets into the
    matched text plus the recomputed 64-scalar normalized context. Visibility is
    the caller's concern.
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
        sources = load_normalized_media_sources(db, media_id=owner_id)

    return match_quote_in_sources(sources, exact=exact, prefix=prefix, suffix=suffix)
