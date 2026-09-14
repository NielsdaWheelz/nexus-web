"""Literal find reads one retained unit and bounded same-fragment context."""

from __future__ import annotations

from dataclasses import dataclass
from typing import cast
from uuid import UUID

import regex
from sqlalchemy import and_, func, or_, select, text
from sqlalchemy.orm import Session

from nexus.config import ReaderPublicationLimits
from nexus.db.models import Media, ReaderPublicationTarget, ReaderPublicationUnit
from nexus.errors import ApiErrorCode, InvalidRequestError, ReaderContentTooLargeError
from nexus.schemas.epub_find import EpubFindSectionScopeIn
from nexus.schemas.reader import (
    EpubReaderResumeState,
    ReaderEpubTarget,
    ReaderFragmentTarget,
    ReaderQuoteContext,
    ReaderTextLocations,
    WebReaderResumeState,
)
from nexus.schemas.reader_publication import (
    ReaderPublicationFindOccurrence,
    ReaderPublicationFindPage,
    ReaderPublicationFindRequest,
)
from nexus.services.epub_find import SNIPPET_CONTEXT_CODEPOINTS, build_reader_find_snippet
from nexus.services.reader_publication_read import get_reader_publication_member_for_viewer
from nexus.services.reader_publication_resolve import OWNING_TARGET_ORDER
from nexus.services.signed_keyset_cursor import (
    KeysetValue,
    KeysetValueKind,
    decode_signed_keyset_cursor,
    encode_signed_keyset_cursor,
)


@dataclass(frozen=True)
class CanonicalTextRange:
    text: str
    word_boundaries: frozenset[int]


def read_publication_text_range(
    db: Session,
    *,
    media_id: UUID,
    generation: int,
    fragment_id: UUID,
    start: int,
    end: int,
) -> CanonicalTextRange:
    """Read only the requested canonical overlap, skipping every zero-text unit.

    Callers bound the extent by literal/quote and snippet limits. PostgreSQL
    slices before transfer; neighboring full bodies and boundary arrays never
    enter the API process.
    """
    if end <= start:
        return CanonicalTextRange("", frozenset())
    rows = db.execute(
        text(
            """
            WITH first_unit AS (
                SELECT start_cp FROM reader_publication_units
                WHERE media_id = :media_id AND generation = :generation
                  AND fragment_id = :fragment_id AND end_cp > start_cp
                  AND start_cp <= :start
                ORDER BY start_cp DESC, ordinal DESC LIMIT 1
            )
            SELECT substring(canonical_text FROM greatest(:start - start_cp, 0) + 1
                       FOR least(end_cp, :end) - greatest(start_cp, :start)) AS text,
                   ARRAY(SELECT point FROM unnest(word_boundaries) point
                         WHERE point >= :start AND point <= :end) AS boundaries
            FROM reader_publication_units
            WHERE media_id = :media_id AND generation = :generation
              AND fragment_id = :fragment_id AND end_cp > start_cp
              AND start_cp >= coalesce((SELECT start_cp FROM first_unit), :start)
              AND start_cp < :end AND end_cp > :start
            ORDER BY start_cp, ordinal
            LIMIT :span
            """
        ),
        {
            "media_id": media_id,
            "generation": generation,
            "fragment_id": fragment_id,
            "start": start,
            "end": end,
            "span": end - start,
        },
    ).all()
    return CanonicalTextRange(
        "".join(row[0] for row in rows),
        frozenset(point for row in rows for point in row[1]),
    )


def find_reader_publication_for_viewer(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    generation: int,
    request: ReaderPublicationFindRequest,
    limits: ReaderPublicationLimits,
) -> ReaderPublicationFindPage:
    get_reader_publication_member_for_viewer(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        generation=generation,
        key="descriptor.json",
        role="descriptor",
    )
    media_kind = db.scalar(select(Media.kind).where(Media.id == media_id))
    scope_fragment: UUID | None = None
    scope_start = 0
    scope_end: int | None = None
    if isinstance(request.scope, EpubFindSectionScopeIn):
        section = db.execute(
            select(ReaderPublicationTarget, ReaderPublicationUnit.fragment_id)
            .join(
                ReaderPublicationUnit,
                and_(
                    ReaderPublicationUnit.media_id == ReaderPublicationTarget.media_id,
                    ReaderPublicationUnit.generation == ReaderPublicationTarget.generation,
                    ReaderPublicationUnit.unit_key == ReaderPublicationTarget.unit_key,
                ),
            )
            .where(
                ReaderPublicationTarget.media_id == media_id,
                ReaderPublicationTarget.generation == generation,
                ReaderPublicationTarget.target_id == request.scope.section_id,
            )
        ).one_or_none()
        if section is None or section[0].end_cp is None:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Find scope must name a retained section extent"
            )
        scope_fragment, scope_start, scope_end = section[1], section[0].offset_cp, section[0].end_cp

    query_binding = {
        "viewer_id": str(viewer_id),
        "media_id": str(media_id),
        "generation": generation,
        **request.model_dump(mode="json", exclude={"after"}),
    }

    def cursor(ordinal: int, offset: int) -> str:
        return encode_signed_keyset_cursor(
            family="ReaderPublicationFind",
            query=query_binding,
            after=(
                KeysetValue(KeysetValueKind.Int, ordinal),
                KeysetValue(KeysetValueKind.Int, offset),
            ),
        )

    searched_units = [
        ReaderPublicationUnit.media_id == media_id,
        ReaderPublicationUnit.generation == generation,
        ReaderPublicationUnit.end_cp > ReaderPublicationUnit.start_cp,
    ]
    if scope_fragment is not None:
        searched_units += [
            ReaderPublicationUnit.fragment_id == scope_fragment,
            ReaderPublicationUnit.end_cp > scope_start,
            ReaderPublicationUnit.start_cp < scope_end,
        ]
    base = select(ReaderPublicationUnit).where(*searched_units)
    offset = scope_start
    if request.after is not None:
        ordinal_value, offset_value = decode_signed_keyset_cursor(
            request.after,
            family="ReaderPublicationFind",
            query=query_binding,
            expected_kinds=(KeysetValueKind.Int, KeysetValueKind.Int),
        )
        ordinal, offset = cast(int, ordinal_value), cast(int, offset_value)
        previous = db.scalar(base.where(ReaderPublicationUnit.ordinal == ordinal))
        if previous is None or offset < previous.start_cp:
            raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid find continuation")
        if offset < previous.end_cp:
            unit = previous
        else:
            unit = db.scalar(
                base.where(
                    ReaderPublicationUnit.ordinal > previous.ordinal,
                    or_(
                        ReaderPublicationUnit.fragment_id != previous.fragment_id,
                        ReaderPublicationUnit.end_cp > offset,
                    ),
                )
                .order_by(ReaderPublicationUnit.ordinal)
                .limit(1)
            )
            if unit is not None and unit.fragment_id != previous.fragment_id:
                offset = unit.start_cp
    else:
        unit = db.scalar(base.order_by(ReaderPublicationUnit.ordinal).limit(1))
    if unit is None:
        return ReaderPublicationFindPage(occurrences=(), next_cursor=None)

    start = max(unit.start_cp, offset)
    searchable_end = min(unit.end_cp, scope_end) if scope_end is not None else unit.end_cp
    context_start = max(0, unit.start_cp - SNIPPET_CONTEXT_CODEPOINTS)
    context_end = unit.end_cp + len(request.query) - 1 + SNIPPET_CONTEXT_CODEPOINTS
    prefix = read_publication_text_range(
        db,
        media_id=media_id,
        generation=generation,
        fragment_id=unit.fragment_id,
        start=context_start,
        end=unit.start_cp,
    )
    suffix = read_publication_text_range(
        db,
        media_id=media_id,
        generation=generation,
        fragment_id=unit.fragment_id,
        start=unit.end_cp,
        end=context_end,
    )
    context = prefix.text + unit.canonical_text + suffix.text
    boundaries = prefix.word_boundaries | frozenset(unit.word_boundaries) | suffix.word_boundaries
    flags = regex.V0 | regex.WORD
    if not request.match_case:
        flags |= regex.IGNORECASE
    expression = regex.compile(regex.escape(request.query), flags)
    position = start - context_start
    next_offset = searchable_end
    occurrences: list[ReaderPublicationFindOccurrence] = []

    def next_cursor(offset: int) -> str | None:
        if offset < searchable_end:
            return cursor(unit.ordinal, offset)
        following = db.scalar(
            base.where(
                ReaderPublicationUnit.ordinal > unit.ordinal,
                or_(
                    ReaderPublicationUnit.fragment_id != unit.fragment_id,
                    ReaderPublicationUnit.end_cp > offset,
                ),
            )
            .order_by(ReaderPublicationUnit.ordinal)
            .limit(1)
        )
        if following is None:
            return None
        return cursor(
            following.ordinal,
            max(following.start_cp, offset)
            if following.fragment_id == unit.fragment_id
            else following.start_cp,
        )

    # A cursor carries a fixed query digest and two bounded coordinates whose
    # encoded length grows with their decimal width, so the largest searched
    # ordinal and offset dominate every cursor this page can emit. Reserve that
    # encoding before adding any occurrence.
    largest_ordinal, largest_end = db.execute(
        select(
            func.max(ReaderPublicationUnit.ordinal), func.max(ReaderPublicationUnit.end_cp)
        ).where(*searched_units)
    ).one()
    reserve_cursor = cursor(largest_ordinal, max(largest_end, unit.end_cp + len(request.query)))
    encoded_bytes = len(
        ReaderPublicationFindPage(
            occurrences=(),
            next_cursor=reserve_cursor,
        )
        .model_dump_json()
        .encode("utf-8")
    ) + len(b'{"data":}')

    while match := expression.search(context, position):
        match_start, match_end = (value + context_start for value in match.span())
        if match_start >= searchable_end:
            break
        if scope_end is not None and match_end > scope_end:
            break
        if request.whole_word and (match_start not in boundaries or match_end not in boundaries):
            position = match.start() + 1
            continue
        target = db.scalar(
            select(ReaderPublicationTarget)
            .join(
                ReaderPublicationUnit,
                and_(
                    ReaderPublicationUnit.media_id == ReaderPublicationTarget.media_id,
                    ReaderPublicationUnit.generation == ReaderPublicationTarget.generation,
                    ReaderPublicationUnit.unit_key == ReaderPublicationTarget.unit_key,
                ),
            )
            .where(
                ReaderPublicationTarget.media_id == media_id,
                ReaderPublicationTarget.generation == generation,
                ReaderPublicationUnit.fragment_id == unit.fragment_id,
                ReaderPublicationTarget.offset_cp <= match_start,
            )
            .order_by(*OWNING_TARGET_ORDER)
            .limit(1)
        )
        locations = ReaderTextLocations(
            text_offset=match_start, progression=None, total_progression=None, position=None
        )
        quote_context = ReaderQuoteContext(quote=None, quote_prefix=None, quote_suffix=None)
        if media_kind == "web_article":
            locator = WebReaderResumeState(
                kind="web",
                target=ReaderFragmentTarget(fragment_id=str(unit.fragment_id)),
                locations=locations,
                text=quote_context,
            )
        elif media_kind == "epub" and target is not None and target.href_path is not None:
            locator = EpubReaderResumeState(
                kind="epub",
                target=ReaderEpubTarget(
                    section_id=target.target_id,
                    href_path=target.href_path,
                    anchor_id=target.anchor_id,
                ),
                locations=locations,
                text=quote_context,
            )
        else:
            raise AssertionError("Retained text publication has no compatible navigation target")
        occurrence = ReaderPublicationFindOccurrence(
            locator=locator,
            section_id=target.target_id if target is not None else None,
            section_label=target.label if target is not None else None,
            fragment_id=str(unit.fragment_id),
            fragment_idx=unit.fragment_idx,
            start_offset=match_start,
            end_offset=match_end,
            snippet=build_reader_find_snippet(context, match.start(), match.end()),
        )
        additional_bytes = len(occurrence.model_dump_json().encode("utf-8")) + bool(occurrences)
        if encoded_bytes + additional_bytes > limits.index_bytes:
            if not occurrences:
                raise ReaderContentTooLargeError(
                    "Find occurrence exceeds response capacity",
                    limit="index_bytes",
                    limit_value=limits.index_bytes,
                    measured=encoded_bytes + additional_bytes,
                )
            next_offset = match_start
            break
        occurrences.append(occurrence)
        encoded_bytes += additional_bytes
        next_offset = max(searchable_end, match_end)
        position = match.end()

    return ReaderPublicationFindPage(
        occurrences=tuple(occurrences),
        next_cursor=next_cursor(next_offset),
    )
