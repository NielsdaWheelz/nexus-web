"""Bounded literal Find over current EPUB canonical fragments."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

import regex
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError
from nexus.schemas.epub_find import (
    EpubFindNoMatchesOut,
    EpubFindOccurrenceOut,
    EpubFindReadyOut,
    EpubFindRequest,
    EpubFindResultOut,
    EpubFindSectionScopeIn,
    EpubFindSnippetSegmentOut,
    EpubFindTooManyMatchesOut,
)
from nexus.services.epub_read import require_readable_epub

MATCH_THRESHOLD = 2_000
SNIPPET_CONTEXT_CODEPOINTS = 64


@dataclass(frozen=True, slots=True)
class _EpubFindFragment:
    fragment_id: UUID
    fragment_idx: int
    canonical_text: str
    section_id: str
    section_label: str


def _current_first_fragment_id(db: Session, media_id: UUID) -> UUID:
    row = db.execute(
        text(
            """
            SELECT id, idx
            FROM fragments
            WHERE media_id = :media_id
            ORDER BY idx ASC
            LIMIT 1
            """
        ),
        {"media_id": media_id},
    ).one_or_none()
    if row is None or int(row[1]) < 0:
        # justify-service-invariant-check: a readable EPUB must own a non-empty,
        # non-negative-indexed current fragment sequence.
        raise AssertionError("Readable EPUB has no valid first fragment")
    return UUID(str(row[0]))


def _scope_fragment_idx(
    db: Session,
    media_id: UUID,
    scope: EpubFindSectionScopeIn,
) -> int:
    row = db.execute(
        text(
            """
            SELECT n.fragment_idx,
                   (
                       SELECT count(*)
                       FROM epub_nav_locations sibling
                       WHERE sibling.media_id = n.media_id
                         AND sibling.fragment_idx = n.fragment_idx
                   ) AS navigation_location_count
            FROM epub_nav_locations n
            WHERE n.media_id = :media_id
              AND n.location_id = :section_id
            """
        ),
        {"media_id": media_id, "section_id": scope.section_id},
    ).one_or_none()
    if row is None or int(row[1]) != 1:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Section scope must identify one uniquely owned EPUB section",
        )
    return int(row[0])


def _load_next_fragment(
    db: Session,
    *,
    media_id: UUID,
    after_idx: int | None,
    scope_fragment_idx: int | None,
) -> _EpubFindFragment | None:
    row = (
        db.execute(
            text(
                """
                SELECT f.id AS fragment_id,
                       f.idx AS fragment_idx,
                       f.canonical_text,
                       first_navigation.location_id AS section_id,
                       first_navigation.label AS section_label,
                       (
                           SELECT count(*)
                           FROM epub_nav_locations navigation_count
                           WHERE navigation_count.media_id = f.media_id
                             AND navigation_count.fragment_idx = f.idx
                       ) AS navigation_location_count
                FROM fragments f
                LEFT JOIN LATERAL (
                    SELECT navigation.location_id, navigation.label
                    FROM epub_nav_locations navigation
                    WHERE navigation.media_id = f.media_id
                      AND navigation.fragment_idx = f.idx
                    ORDER BY navigation.ordinal ASC
                    LIMIT 1
                ) first_navigation ON TRUE
                WHERE f.media_id = :media_id
                  AND (
                      CAST(:after_idx AS INTEGER) IS NULL
                      OR f.idx > CAST(:after_idx AS INTEGER)
                  )
                  AND (
                      CAST(:scope_fragment_idx AS INTEGER) IS NULL
                      OR f.idx = CAST(:scope_fragment_idx AS INTEGER)
                  )
                ORDER BY f.idx ASC
                LIMIT 1
                """
            ),
            {
                "media_id": media_id,
                "after_idx": after_idx,
                "scope_fragment_idx": scope_fragment_idx,
            },
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        return None
    if (
        int(row["fragment_idx"]) < 0
        or row["section_id"] is None
        or row["section_label"] is None
        or int(row["navigation_location_count"]) < 1
    ):
        # justify-service-invariant-check: current EPUB fragments and canonical
        # navigation are published atomically, so every fragment has a target.
        raise AssertionError("Current EPUB fragment has no canonical navigation target")
    return _EpubFindFragment(
        fragment_id=UUID(str(row["fragment_id"])),
        fragment_idx=int(row["fragment_idx"]),
        canonical_text=str(row["canonical_text"]),
        section_id=str(row["section_id"]),
        section_label=str(row["section_label"]),
    )


def _snippet(
    canonical_text: str,
    start_offset: int,
    end_offset: int,
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


def find_epub_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    request: EpubFindRequest,
) -> EpubFindResultOut:
    """Return complete exact literal occurrences from one current EPUB snapshot."""
    require_readable_epub(db, viewer_id, media_id)

    source_witness_fragment_id = _current_first_fragment_id(db, media_id)
    if request.source_witness_fragment_id != source_witness_fragment_id:
        raise ConflictError(
            ApiErrorCode.E_EPUB_FIND_SOURCE_CHANGED,
            "EPUB source changed",
        )

    scope_fragment_idx = (
        _scope_fragment_idx(db, media_id, request.scope)
        if isinstance(request.scope, EpubFindSectionScopeIn)
        else None
    )
    flags = regex.V0 | regex.WORD
    if not request.match_case:
        flags |= regex.IGNORECASE
    expression = regex.compile(regex.escape(request.query), flags)
    boundary = regex.compile(r"\b", regex.V0 | regex.WORD) if request.whole_word else None

    occurrences: list[EpubFindOccurrenceOut] = []
    after_idx: int | None = None
    while True:
        fragment = _load_next_fragment(
            db,
            media_id=media_id,
            after_idx=after_idx,
            scope_fragment_idx=scope_fragment_idx,
        )
        if fragment is None:
            break

        position = 0
        while match := expression.search(fragment.canonical_text, position):
            start_offset, end_offset = match.span()
            if boundary is not None and (
                boundary.match(fragment.canonical_text, start_offset) is None
                or boundary.match(fragment.canonical_text, end_offset) is None
            ):
                position = start_offset + 1
                continue

            occurrences.append(
                EpubFindOccurrenceOut(
                    section_id=fragment.section_id,
                    section_label=fragment.section_label,
                    fragment_id=fragment.fragment_id,
                    fragment_idx=fragment.fragment_idx,
                    start_offset=start_offset,
                    end_offset=end_offset,
                    snippet=_snippet(fragment.canonical_text, start_offset, end_offset),
                )
            )
            if len(occurrences) > MATCH_THRESHOLD:
                return EpubFindTooManyMatchesOut(
                    source_witness_fragment_id=source_witness_fragment_id,
                )
            position = end_offset

        after_idx = fragment.fragment_idx

    if not occurrences:
        return EpubFindNoMatchesOut(
            source_witness_fragment_id=source_witness_fragment_id,
        )
    return EpubFindReadyOut(
        source_witness_fragment_id=source_witness_fragment_id,
        occurrences=occurrences,
    )
