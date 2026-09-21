"""Bounded literal Find over the current EPUB canonical fragments."""

from __future__ import annotations

from uuid import UUID

import regex
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.epub_find import (
    EpubFindNoMatchesOut,
    EpubFindOccurrenceOut,
    EpubFindReadyOut,
    EpubFindRequest,
    EpubFindResultOut,
    EpubFindSectionOut,
    EpubFindSectionScopeIn,
    EpubFindSnippetSegmentOut,
    EpubFindTooManyMatchesOut,
)
from nexus.schemas.presence import absent, present
from nexus.services.epub_read import get_epub_navigation_for_viewer

MATCH_THRESHOLD = 2_000
SNIPPET_CONTEXT_CODEPOINTS = 64


def find_epub_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    request: EpubFindRequest,
) -> EpubFindResultOut:
    """Return complete exact literal occurrences from one current EPUB snapshot."""
    navigation = get_epub_navigation_for_viewer(db, viewer_id, media_id)
    if not navigation.fragments:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "EPUB has no source fragment")
    witness = navigation.fragments[0].fragment_id
    if (
        request.source_witness_fragment_id != witness
        or request.source_generation != navigation.generation
    ):
        raise ConflictError(ApiErrorCode.E_EPUB_FIND_SOURCE_CHANGED, "EPUB source changed")

    # Document offsets: one flat coordinate space over the fragments in spine order.
    starts: dict[UUID, int] = {}
    document_end = 0
    for fragment in navigation.fragments:
        starts[fragment.fragment_id] = document_end
        document_end += fragment.char_count

    by_id = {section.section_id: section for section in navigation.sections}
    extents: list[tuple[int, int, int, str, str]] = []
    for section in navigation.sections:
        if section.extent.kind == "Absent":
            continue
        extent = section.extent.value
        depth = 0
        parent = section.parent_section_id
        while parent.kind == "Present":
            depth += 1
            parent = by_id[parent.value].parent_section_id
        extents.append(
            (
                starts[extent.start.fragment_id] + extent.start.offset,
                starts[extent.end.fragment_id] + extent.end.offset,
                depth,
                section.section_id,
                section.label,
            )
        )

    scope_start, scope_end = 0, document_end
    if isinstance(request.scope, EpubFindSectionScopeIn):
        scoped = next((entry for entry in extents if entry[3] == request.scope.section_id), None)
        if scoped is None:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Section scope has no exact semantic extent"
            )
        scope_start, scope_end = scoped[:2]

    flags = regex.V0 | regex.WORD
    if not request.match_case:
        flags |= regex.IGNORECASE
    expression = regex.compile(regex.escape(request.query), flags)
    boundary = regex.compile(r"\b", regex.V0 | regex.WORD) if request.whole_word else None

    occurrences: list[EpubFindOccurrenceOut] = []
    after_idx: int | None = None
    while True:
        # One fragment at a time, inside the caller's repeatable-read snapshot.
        row = db.execute(
            text("""
                SELECT id, idx, canonical_text FROM fragments
                WHERE media_id = :media_id
                  AND (CAST(:after_idx AS INTEGER) IS NULL OR idx > :after_idx)
                ORDER BY idx LIMIT 1
            """),
            {"media_id": media_id, "after_idx": after_idx},
        ).one_or_none()
        if row is None:
            break
        canonical_text: str = row.canonical_text
        fragment_start = starts[row.id]
        position = max(0, scope_start - fragment_start)
        stop = min(len(canonical_text), scope_end - fragment_start)
        while position < stop and (match := expression.search(canonical_text, position, stop)):
            start_offset, end_offset = match.span()
            if boundary is not None and (
                boundary.match(canonical_text, start_offset) is None
                or boundary.match(canonical_text, end_offset) is None
            ):
                position = start_offset + 1
                continue
            absolute_start = fragment_start + start_offset
            containing = [entry for entry in extents if entry[0] <= absolute_start < entry[1]]
            section = absent()
            if containing:
                # Deepest, then shortest, then lowest id.
                selected = min(
                    containing, key=lambda entry: (-entry[2], entry[1] - entry[0], entry[3])
                )
                section = present(EpubFindSectionOut(section_id=selected[3], label=selected[4]))
            occurrences.append(
                EpubFindOccurrenceOut(
                    section=section,
                    fragment_id=row.id,
                    fragment_idx=row.idx,
                    start_offset=start_offset,
                    end_offset=end_offset,
                    snippet=_snippet(canonical_text, start_offset, end_offset),
                )
            )
            if len(occurrences) > MATCH_THRESHOLD:
                return EpubFindTooManyMatchesOut(
                    source_witness_fragment_id=witness,
                    source_generation=navigation.generation,
                )
            position = end_offset
        after_idx = row.idx

    if not occurrences:
        return EpubFindNoMatchesOut(
            source_witness_fragment_id=witness, source_generation=navigation.generation
        )
    return EpubFindReadyOut(
        source_witness_fragment_id=witness,
        source_generation=navigation.generation,
        occurrences=occurrences,
    )


def _snippet(
    canonical_text: str, start_offset: int, end_offset: int
) -> list[EpubFindSnippetSegmentOut]:
    snippet_start = max(0, start_offset - SNIPPET_CONTEXT_CODEPOINTS)
    snippet_end = min(len(canonical_text), end_offset + SNIPPET_CONTEXT_CODEPOINTS)
    parts = (
        (canonical_text[snippet_start:start_offset], False),
        (canonical_text[start_offset:end_offset], True),
        (canonical_text[end_offset:snippet_end], False),
    )
    return [
        EpubFindSnippetSegmentOut(text=value, emphasized=emphasized)
        for value, emphasized in parts
        if value
    ]
