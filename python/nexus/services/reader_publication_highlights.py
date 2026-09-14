"""Bounded paint facts on a selected publication; no quote/cache repair or linked bodies.

Fragment IDs name immutable canonical text: content publishers allocate new IDs;
title-only publications reuse that same text. A cached anchor is safe to paint
only when its exact fragment occurs in the selected publication. A cache repaired
to another source never paints here; its authored highlight remains in the sidebar.
"""

from uuid import UUID

from sqlalchemy import case, func, select, true, tuple_
from sqlalchemy.orm import Session

from nexus.auth.permissions import highlight_visibility_filter
from nexus.config import ReaderPublicationLimits
from nexus.db.models import Highlight, HighlightFragmentAnchor, ReaderPublicationUnit
from nexus.errors import ApiErrorCode, NotFoundError, ReaderContentTooLargeError
from nexus.schemas.reader_publication import (
    ReaderPublicationHighlightPaint,
    ReaderPublicationHighlightsPage,
    ReaderPublicationHighlightsRequest,
    ReaderPublicationHighlightSummariesPage,
    ReaderPublicationHighlightSummariesRequest,
    ReaderPublicationHighlightSummary,
    ReaderPublicationSourceRange,
)
from nexus.services.reader_publication_read import get_reader_publication_member_for_viewer
from nexus.services.search.constants import MAX_SNIPPET_LENGTH
from nexus.services.signed_keyset_cursor import (
    KeysetValue,
    KeysetValueKind,
    decode_signed_keyset_cursor,
    encode_signed_keyset_cursor,
)


def list_reader_publication_highlights(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    generation: int,
    request: ReaderPublicationHighlightsRequest,
    limits: ReaderPublicationLimits,
) -> ReaderPublicationHighlightsPage:
    get_reader_publication_member_for_viewer(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        generation=generation,
        key=request.unit_key,
        role="unit",
    )
    unit = db.get(ReaderPublicationUnit, (media_id, generation, request.unit_key))
    if unit is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Reader publication unit not found")
    if unit.start_cp == unit.end_cp:
        return ReaderPublicationHighlightsPage(items=(), next_cursor=None)
    query_binding = {
        "viewer": str(viewer_id),
        "media": str(media_id),
        "generation": generation,
        "unit": request.unit_key,
        "mine_only": request.mine_only,
    }
    order = (HighlightFragmentAnchor.start_offset, Highlight.created_at, Highlight.id)
    query = (
        select(
            Highlight.id,
            Highlight.color,
            HighlightFragmentAnchor.start_offset,
            HighlightFragmentAnchor.end_offset,
            Highlight.created_at,
            Highlight.user_id,
        )
        .join(HighlightFragmentAnchor, HighlightFragmentAnchor.highlight_id == Highlight.id)
        .where(
            Highlight.anchor_media_id == media_id,
            Highlight.anchor_kind == "fragment_offsets",
            HighlightFragmentAnchor.fragment_id == unit.fragment_id,
            HighlightFragmentAnchor.start_offset < unit.end_cp,
            HighlightFragmentAnchor.end_offset > unit.start_cp,
            Highlight.user_id == viewer_id
            if request.mine_only
            else highlight_visibility_filter(viewer_id, media_id),
        )
    )
    if request.after is not None:
        values = decode_signed_keyset_cursor(
            request.after,
            family="ReaderPublicationHighlights",
            query=query_binding,
            expected_kinds=(KeysetValueKind.Int, KeysetValueKind.DateTime, KeysetValueKind.Uuid),
        )
        query = query.where(tuple_(*order) > tuple_(*values))
    rows = db.execute(query.order_by(*order).limit(request.limit + 1)).all()
    items = []
    last_cursor = None
    for row in rows:
        paint = ReaderPublicationHighlightPaint(
            id=row.id,
            color=row.color,
            start_offset=row.start_offset,
            end_offset=row.end_offset,
            created_at=row.created_at,
            author_user_id=row.user_id,
            is_owner=row.user_id == viewer_id,
        )
        cursor = encode_signed_keyset_cursor(
            family="ReaderPublicationHighlights",
            query=query_binding,
            after=(
                KeysetValue(KeysetValueKind.Int, row.start_offset),
                KeysetValue(KeysetValueKind.DateTime, row.created_at),
                KeysetValue(KeysetValueKind.Uuid, row.id),
            ),
        )
        candidate = ReaderPublicationHighlightsPage(items=(*items, paint), next_cursor=cursor)
        page_bytes = len(candidate.model_dump_json().encode("utf-8")) + len(b'{"data":}')
        if len(items) == request.limit or page_bytes > limits.index_bytes:
            if not items:
                raise ReaderContentTooLargeError(
                    "Reader highlight exceeds response capacity",
                    limit="index_bytes",
                    limit_value=limits.index_bytes,
                    measured=page_bytes,
                )
            return ReaderPublicationHighlightsPage(items=tuple(items), next_cursor=last_cursor)
        items.append(paint)
        last_cursor = cursor
    return ReaderPublicationHighlightsPage(items=tuple(items), next_cursor=None)


def list_reader_publication_highlight_summaries(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    generation: int,
    request: ReaderPublicationHighlightSummariesRequest,
    limits: ReaderPublicationLimits,
) -> ReaderPublicationHighlightSummariesPage:
    """List every visible authored highlight, including unavailable old locators.

    Source range resolution reads only scalar retained coordinates. Excerpts are
    explicitly presentation data; the existing highlight detail owner alone loads
    the exact quote, context, and linked note/conversation bodies on request.
    """
    get_reader_publication_member_for_viewer(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        generation=generation,
        key="descriptor.json",
        role="descriptor",
    )
    addressed = (
        select(ReaderPublicationUnit.unit_key, ReaderPublicationUnit.fragment_idx)
        .where(
            ReaderPublicationUnit.media_id == media_id,
            ReaderPublicationUnit.generation == generation,
            ReaderPublicationUnit.fragment_id == HighlightFragmentAnchor.fragment_id,
            ReaderPublicationUnit.start_cp <= HighlightFragmentAnchor.start_offset,
            ReaderPublicationUnit.end_cp > HighlightFragmentAnchor.start_offset,
        )
        .order_by(ReaderPublicationUnit.start_cp.desc(), ReaderPublicationUnit.ordinal)
        .limit(1)
        .correlate(HighlightFragmentAnchor)
        .lateral("addressed")
    )
    unavailable = case((addressed.c.unit_key.is_(None), 1), else_=0)
    fragment_order = func.coalesce(addressed.c.fragment_idx, 0)
    offset_order = func.coalesce(HighlightFragmentAnchor.start_offset, 0)
    order = (unavailable, fragment_order, offset_order, Highlight.created_at, Highlight.id)
    query_binding = {
        "viewer": str(viewer_id),
        "media": str(media_id),
        "generation": generation,
        "mine_only": request.mine_only,
    }
    query = (
        select(
            Highlight.id,
            Highlight.color,
            func.substr(Highlight.exact, 1, MAX_SNIPPET_LENGTH).label("quote_excerpt"),
            func.char_length(Highlight.exact).label("quote_codepoints"),
            Highlight.created_at,
            Highlight.updated_at,
            Highlight.user_id,
            HighlightFragmentAnchor.fragment_id,
            HighlightFragmentAnchor.start_offset,
            HighlightFragmentAnchor.end_offset,
            addressed.c.unit_key,
            unavailable.label("unavailable"),
            fragment_order.label("fragment_order"),
            offset_order.label("offset_order"),
        )
        .outerjoin(HighlightFragmentAnchor, HighlightFragmentAnchor.highlight_id == Highlight.id)
        .outerjoin(addressed, true())
        .where(
            Highlight.anchor_media_id == media_id,
            Highlight.anchor_kind == "fragment_offsets",
            Highlight.user_id == viewer_id
            if request.mine_only
            else highlight_visibility_filter(viewer_id, media_id),
        )
    )
    if request.after is not None:
        values = decode_signed_keyset_cursor(
            request.after,
            family="ReaderPublicationHighlightSummaries",
            query=query_binding,
            expected_kinds=(
                KeysetValueKind.Int,
                KeysetValueKind.Int,
                KeysetValueKind.Int,
                KeysetValueKind.DateTime,
                KeysetValueKind.Uuid,
            ),
        )
        query = query.where(tuple_(*order) > tuple_(*values))
    rows = db.execute(query.order_by(*order).limit(request.limit + 1)).all()
    items = []
    last_cursor = None
    for row in rows:
        item = ReaderPublicationHighlightSummary(
            id=row.id,
            color=row.color,
            quote_excerpt=row.quote_excerpt,
            quote_codepoints=row.quote_codepoints,
            created_at=row.created_at,
            updated_at=row.updated_at,
            author_user_id=row.user_id,
            is_owner=row.user_id == viewer_id,
            range=ReaderPublicationSourceRange(
                unit_key=row.unit_key,
                fragment_id=str(row.fragment_id),
                start_cp=row.start_offset,
                end_cp=row.end_offset,
            )
            if row.unit_key is not None
            else None,
        )
        cursor = encode_signed_keyset_cursor(
            family="ReaderPublicationHighlightSummaries",
            query=query_binding,
            after=(
                KeysetValue(KeysetValueKind.Int, row.unavailable),
                KeysetValue(KeysetValueKind.Int, row.fragment_order),
                KeysetValue(KeysetValueKind.Int, row.offset_order),
                KeysetValue(KeysetValueKind.DateTime, row.created_at),
                KeysetValue(KeysetValueKind.Uuid, row.id),
            ),
        )
        candidate = ReaderPublicationHighlightSummariesPage(
            items=(*items, item), next_cursor=cursor
        )
        page_bytes = len(candidate.model_dump_json().encode("utf-8")) + len(b'{"data":}')
        if len(items) == request.limit or page_bytes > limits.index_bytes:
            if not items:
                raise ReaderContentTooLargeError(
                    "Reader highlight summary exceeds response capacity",
                    limit="index_bytes",
                    limit_value=limits.index_bytes,
                    measured=page_bytes,
                )
            return ReaderPublicationHighlightSummariesPage(
                items=tuple(items), next_cursor=last_cursor
            )
        items.append(item)
        last_cursor = cursor
    return ReaderPublicationHighlightSummariesPage(items=tuple(items), next_cursor=None)
