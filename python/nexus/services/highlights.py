"""Highlights: access, quote derivation, projection, create/list/patch/delete."""

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError

from nexus.auth.permissions import (
    can_read_highlight,
    can_read_media,
    highlight_readability_filter,
    highlight_visibility_filter,
    visible_media_ids_cte_sql,
)
from nexus.db.errors import integrity_constraint_name
from nexus.db.models import (
    Fragment,
    Highlight,
    HighlightFragmentAnchor,
    HighlightPdfAnchor,
    HighlightPdfQuad,
    Media,
)
from nexus.db.retries import retry_read_committed
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.logging import get_logger
from nexus.schemas.highlights import (
    CreateHighlightRequest,
    FragmentAnchorOut,
    LinkedConversationRef,
    LinkedNoteBlockRef,
    PdfAnchorOut,
    PdfBoundsUpdate,
    PdfQuadOut,
    TypedHighlightOut,
    UpdateHighlightRequest,
)
from nexus.schemas.reader import ResolvedHighlightReaderTarget
from nexus.services import locator_resolver, text_quote
from nexus.services.capabilities import is_text_document_ready
from nexus.services.passage_anchors import normalize_quote_text
from nexus.services.resource_graph.cleanup import (
    delete_edges_for_deleted_resource,
    delete_resource_protocol_state,
)
from nexus.services.resource_graph.context import batch_conversations_with_any_edge_to_ref
from nexus.services.resource_graph.highlight_notes import linked_note_blocks_for_highlights
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.text_quote import QuoteStatus

logger = get_logger(__name__)

AFFIX_CODEPOINTS = 64


def require_typed_highlight_or_404(highlight: Highlight) -> None:
    """Require the typed-anchor child row and parent media the kind implies."""
    if highlight.anchor_kind == "fragment_offsets":
        child = highlight.fragment_anchor
    elif highlight.anchor_kind == "pdf_page_geometry":
        child = highlight.pdf_anchor
    else:
        child = None
    if child is None or highlight.anchor_media_id is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")


def require_pdf_highlight_or_404(highlight: Highlight) -> HighlightPdfAnchor:
    require_typed_highlight_or_404(highlight)
    if highlight.anchor_kind != "pdf_page_geometry" or highlight.pdf_anchor is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    return highlight.pdf_anchor


def _parent_media_id(highlight: Highlight) -> UUID:
    if highlight.anchor_media_id is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    return highlight.anchor_media_id


def get_highlight_for_visible_read_or_404(
    db: Session, viewer_id: UUID, highlight_id: UUID
) -> Highlight:
    highlight = db.get(Highlight, highlight_id)
    if highlight is None or not can_read_highlight(db, viewer_id, highlight_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    return highlight


def get_highlight_for_author_write_or_404(
    db: Session, viewer_id: UUID, highlight_id: UUID
) -> Highlight:
    highlight = db.get(Highlight, highlight_id)
    if highlight is None or highlight.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    require_typed_highlight_or_404(highlight)
    if not can_read_media(db, viewer_id, _parent_media_id(highlight)):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    return highlight


def _require_media_text_ready(db: Session, media_id: UUID) -> None:
    row = db.execute(
        text("""
            SELECT m.kind, m.processing_status, mts.transcript_state, mts.transcript_coverage
            FROM media m
            LEFT JOIN media_transcript_states mts ON mts.media_id = m.id
            WHERE m.id = :media_id
        """),
        {"media_id": media_id},
    ).fetchone()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    if not is_text_document_ready(
        str(row[0]),
        str(row[1]),
        None if row[2] is None else str(row[2]),
        None if row[3] is None else str(row[3]),
    ):
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media not ready")


def lock_fragment_row_for_highlight_write_or_404(db: Session, fragment_id: UUID) -> None:
    """Serialize same-span highlight writes; the DB has no unique index for them."""
    locked = db.execute(
        select(Fragment.id).where(Fragment.id == fragment_id).with_for_update()
    ).scalar_one_or_none()
    if locked is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")


def validate_offsets_or_400(canonical_text: str, start: int, end: int) -> None:
    if start < 0 or end <= start or end > len(canonical_text):
        raise ApiError(ApiErrorCode.E_HIGHLIGHT_INVALID_RANGE, "Invalid highlight range")


def derive_exact_prefix_suffix(canonical_text: str, start: int, end: int) -> tuple[str, str, str]:
    """Half-open codepoint slice plus bounded affixes; validate the offsets first."""
    return (
        canonical_text[start:end],
        canonical_text[max(0, start - AFFIX_CODEPOINTS) : start],
        canonical_text[end : min(len(canonical_text), end + AFFIX_CODEPOINTS)],
    )


def map_integrity_error(e: IntegrityError) -> ApiError:
    name = integrity_constraint_name(e)
    if name in {"ck_highlights_color", "ck_hfa_offsets_valid"}:
        return ApiError(ApiErrorCode.E_INVALID_REQUEST, "Invalid highlight data")
    logger.error("unknown_integrity_error", constraint=name, error=str(e))
    return ApiError(ApiErrorCode.E_INTERNAL, "Database constraint violation")


def fragment_highlight_span_conflict_exists(
    db: Session,
    *,
    viewer_id: UUID,
    fragment_id: UUID,
    start_offset: int,
    end_offset: int,
    highlight_id: UUID | None = None,
) -> bool:
    statement = (
        select(Highlight.id)
        .join(HighlightFragmentAnchor, Highlight.id == HighlightFragmentAnchor.highlight_id)
        .where(
            Highlight.user_id == viewer_id,
            Highlight.anchor_kind == "fragment_offsets",
            HighlightFragmentAnchor.fragment_id == fragment_id,
            HighlightFragmentAnchor.start_offset == start_offset,
            HighlightFragmentAnchor.end_offset == end_offset,
        )
        .limit(1)
    )
    if highlight_id is not None:
        statement = statement.where(Highlight.id != highlight_id)
    return db.execute(statement).scalar_one_or_none() is not None


@dataclass(frozen=True, slots=True)
class HighlightActionFacts:
    is_owner: bool
    edit_bounds_applicable: bool
    learn_applicable: bool
    note_block_id: UUID | None


def highlight_action_facts(
    db: Session, *, viewer_id: UUID, highlight_ids: list[UUID]
) -> dict[UUID, HighlightActionFacts]:
    """Action facts for readable highlights; note presence is viewer-scoped."""
    ordered = list(dict.fromkeys(highlight_ids))
    if not ordered:
        return {}
    rows = db.execute(
        select(Highlight.id, Highlight.user_id, Highlight.anchor_kind, Highlight.exact).where(
            Highlight.id.in_(ordered), highlight_readability_filter(viewer_id)
        )
    ).all()
    notes = linked_note_blocks_for_highlights(db, viewer_id, [row[0] for row in rows])
    return {
        highlight_id: HighlightActionFacts(
            is_owner=user_id == viewer_id,
            edit_bounds_applicable=anchor_kind == "fragment_offsets",
            learn_applicable=bool((exact or "").strip()),
            note_block_id=notes[highlight_id][0].id if notes.get(highlight_id) else None,
        )
        for highlight_id, user_id, anchor_kind, exact in rows
    }


@dataclass(frozen=True, slots=True)
class RecentHighlightAnchorFact:
    media_id: UUID
    activity_at: datetime


def count_retained_highlights(
    db: Session, *, viewer_id: UUID, start: datetime | None, end: datetime
) -> int:
    """Surviving viewer-authored highlights over currently visible media."""
    return int(
        db.scalar(
            text(
                f"""
                WITH visible_media AS (
                    {visible_media_ids_cte_sql()}
                )
                SELECT count(*)
                FROM highlights h
                JOIN visible_media vm ON vm.media_id = h.anchor_media_id
                WHERE h.user_id = :viewer_id
                  AND (
                    CAST(:start AS timestamptz) IS NULL
                    OR h.created_at >= CAST(:start AS timestamptz)
                  )
                  AND h.created_at < :end
                """
            ),
            {"viewer_id": viewer_id, "start": start, "end": end},
        )
        or 0
    )


def recent_highlight_anchor_facts(
    db: Session, *, viewer_id: UUID, limit: int
) -> tuple[RecentHighlightAnchorFact, ...]:
    """Newest distinct readable media the viewer's highlights touched."""
    if limit < 1:
        return ()
    rows = db.execute(
        text(
            f"""
            WITH visible_media AS (
                {visible_media_ids_cte_sql()}
            ),
            newest_per_media AS (
                SELECT DISTINCT ON (h.anchor_media_id)
                    h.anchor_media_id AS media_id,
                    h.updated_at AS activity_at
                FROM highlights h
                JOIN visible_media vm ON vm.media_id = h.anchor_media_id
                WHERE h.user_id = :viewer_id
                  AND h.anchor_media_id IS NOT NULL
                  AND h.anchor_kind IN ('fragment_offsets', 'pdf_page_geometry')
                ORDER BY h.anchor_media_id ASC, h.updated_at DESC, h.id ASC
            )
            SELECT media_id, activity_at
            FROM newest_per_media
            ORDER BY activity_at DESC, media_id ASC
            LIMIT :limit
            """
        ),
        {"viewer_id": viewer_id, "limit": limit},
    ).mappings()
    return tuple(
        RecentHighlightAnchorFact(
            media_id=UUID(str(row["media_id"])), activity_at=row["activity_at"]
        )
        for row in rows
    )


def _anchor_out(highlight: Highlight) -> FragmentAnchorOut | PdfAnchorOut:
    pdf_anchor = highlight.pdf_anchor
    if highlight.anchor_kind == "pdf_page_geometry" and pdf_anchor is not None:
        return PdfAnchorOut(
            media_id=pdf_anchor.media_id,
            page_number=pdf_anchor.page_number,
            quads=[
                PdfQuadOut.model_validate(quad, from_attributes=True)
                for quad in sorted(highlight.pdf_quads, key=lambda quad: quad.quad_idx)
            ],
        )
    fragment_anchor = highlight.fragment_anchor
    if highlight.anchor_kind == "fragment_offsets" and fragment_anchor is not None:
        return FragmentAnchorOut(
            media_id=_parent_media_id(highlight),
            fragment_id=fragment_anchor.fragment_id,
            start_offset=fragment_anchor.start_offset,
            end_offset=fragment_anchor.end_offset,
        )
    raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")


def _highlight_out(
    highlight: Highlight,
    viewer_id: UUID,
    anchor: FragmentAnchorOut | PdfAnchorOut,
    conversations: list[LinkedConversationRef],
    note_blocks: list[LinkedNoteBlockRef],
) -> TypedHighlightOut:
    return TypedHighlightOut(
        id=highlight.id,
        anchor=anchor,
        color=highlight.color,
        exact=highlight.exact,
        prefix=highlight.prefix,
        suffix=highlight.suffix,
        created_at=highlight.created_at,
        updated_at=highlight.updated_at,
        author_user_id=highlight.user_id,
        is_owner=highlight.user_id == viewer_id,
        linked_conversations=conversations,
        linked_note_blocks=note_blocks,
    )


def _project_anchored(
    db: Session, viewer_id: UUID, anchored: list[tuple[Highlight, FragmentAnchorOut | PdfAnchorOut]]
) -> list[TypedHighlightOut]:
    ids = [highlight.id for highlight, _ in anchored]
    conversations = {
        highlight_id: [LinkedConversationRef(conversation_id=r.id, title=r.title) for r in rows]
        for highlight_id, rows in batch_conversations_with_any_edge_to_ref(
            db, viewer_id=viewer_id, targets=ids, target_scheme="highlight"
        ).items()
    }
    notes = {
        highlight_id: [
            LinkedNoteBlockRef(
                note_block_id=r.id, body_pm_json=r.body_pm_json, body_text=r.body_text
            )
            for r in rows
        ]
        for highlight_id, rows in linked_note_blocks_for_highlights(db, viewer_id, ids).items()
    }
    return [
        _highlight_out(
            highlight,
            viewer_id,
            anchor,
            conversations.get(highlight.id, []),
            notes.get(highlight.id, []),
        )
        for highlight, anchor in anchored
    ]


def project_highlight(highlight: Highlight, viewer_id: UUID) -> TypedHighlightOut:
    return _highlight_out(highlight, viewer_id, _anchor_out(highlight), [], [])


def project_highlights_with_links(
    db: Session, viewer_id: UUID, highlights: list[Highlight]
) -> list[TypedHighlightOut]:
    return _project_anchored(db, viewer_id, [(item, _anchor_out(item)) for item in highlights])


def _build_fragment_highlight(
    db: Session,
    *,
    viewer_id: UUID,
    fragment_id: UUID,
    start_offset: int,
    end_offset: int,
    color: str,
    highlight_id: UUID | None = None,
) -> Highlight:
    """Flush-only create behind both the route and the caller-owned transaction."""
    fragment = db.get(Fragment, fragment_id)
    if fragment is None or not can_read_media(db, viewer_id, fragment.media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    _require_media_text_ready(db, fragment.media_id)
    lock_fragment_row_for_highlight_write_or_404(db, fragment_id)
    validate_offsets_or_400(fragment.canonical_text, start_offset, end_offset)
    if fragment_highlight_span_conflict_exists(
        db,
        viewer_id=viewer_id,
        fragment_id=fragment_id,
        start_offset=start_offset,
        end_offset=end_offset,
    ):
        raise ApiError(ApiErrorCode.E_HIGHLIGHT_CONFLICT, "Highlight already exists at this range")

    exact, prefix, suffix = derive_exact_prefix_suffix(
        fragment.canonical_text, start_offset, end_offset
    )
    highlight = Highlight(
        user_id=viewer_id,
        anchor_kind="fragment_offsets",
        anchor_media_id=fragment.media_id,
        color=color,
        exact=exact,
        prefix=prefix,
        suffix=suffix,
    )
    if highlight_id is not None:
        highlight.id = highlight_id
    db.add(highlight)
    db.flush()
    db.add(
        HighlightFragmentAnchor(
            highlight_id=highlight.id,
            fragment_id=fragment_id,
            start_offset=start_offset,
            end_offset=end_offset,
        )
    )
    db.flush()

    from nexus.services import synapse

    synapse.queue_synapse_scan(
        db,
        user_id=viewer_id,
        ref=ResourceRef(scheme="highlight", id=highlight.id),
        reason="highlight_create",
    )
    return highlight


def create_highlight_for_fragment(
    db: Session, viewer_id: UUID, fragment_id: UUID, req: CreateHighlightRequest
) -> TypedHighlightOut:
    try:
        highlight = _build_fragment_highlight(
            db,
            viewer_id=viewer_id,
            fragment_id=fragment_id,
            start_offset=req.start_offset,
            end_offset=req.end_offset,
            color=req.color,
        )
        db.commit()
    except IntegrityError as e:
        db.rollback()
        raise map_integrity_error(e) from e
    db.refresh(highlight)
    return project_highlight(highlight, viewer_id)


def create_fragment_highlight_in_txn(
    db: Session,
    *,
    viewer_id: UUID,
    highlight_id: UUID,
    fragment_id: UUID,
    start_offset: int,
    end_offset: int,
    color: str,
) -> Highlight:
    """Flush-only create with a client-stable id; the same selection converges."""
    existing = db.get(Highlight, highlight_id)
    if existing is None:
        return _build_fragment_highlight(
            db,
            viewer_id=viewer_id,
            fragment_id=fragment_id,
            start_offset=start_offset,
            end_offset=end_offset,
            color=color,
            highlight_id=highlight_id,
        )
    anchor = db.get(HighlightFragmentAnchor, existing.id)
    if (
        existing.user_id != viewer_id
        or existing.anchor_kind != "fragment_offsets"
        or anchor is None
        or anchor.fragment_id != fragment_id
        or anchor.start_offset != start_offset
        or anchor.end_offset != end_offset
    ):
        raise ApiError(
            ApiErrorCode.E_HIGHLIGHT_CONFLICT, "Highlight id names a different selection"
        )
    return existing


def list_highlights_for_fragment(
    db: Session, viewer_id: UUID, fragment_id: UUID, mine_only: bool = True
) -> list[TypedHighlightOut]:
    fragment = db.get(Fragment, fragment_id)
    if fragment is None or not can_read_media(db, viewer_id, fragment.media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    highlights = list(
        db.scalars(
            select(Highlight)
            .join(HighlightFragmentAnchor, Highlight.id == HighlightFragmentAnchor.highlight_id)
            .where(
                Highlight.anchor_kind == "fragment_offsets",
                HighlightFragmentAnchor.fragment_id == fragment_id,
                Highlight.user_id == viewer_id
                if mine_only
                else highlight_visibility_filter(viewer_id, fragment.media_id),
            )
            .order_by(HighlightFragmentAnchor.start_offset, Highlight.created_at, Highlight.id)
        ).all()
    )
    return project_highlights_with_links(db, viewer_id, highlights)


def _repair_missing_fragment_caches(db: Session, *, media_id: UUID, stale: list[Highlight]) -> bool:
    """Re-resolve vanished locator caches by quote; True when the caller must re-read."""
    sources = text_quote.load_normalized_media_sources(db, media_id=media_id)
    gone = False
    repaired = False
    for highlight in stale:
        anchor = highlight.fragment_anchor
        if anchor is None:
            gone = True
            continue
        match = text_quote.match_quote_in_sources(
            sources,
            exact=normalize_quote_text(highlight.exact),
            prefix=normalize_quote_text(highlight.prefix),
            suffix=normalize_quote_text(highlight.suffix),
        )
        if (
            match.status is not QuoteStatus.unique
            or match.fragment_id is None
            or match.raw_start is None
            or match.raw_end is None
        ):
            continue
        anchor.fragment_id = match.fragment_id
        anchor.start_offset = match.raw_start
        anchor.end_offset = match.raw_end
        repaired = True
    if repaired:
        try:
            db.commit()
        except StaleDataError:
            db.rollback()
    return gone or repaired


def list_highlights_for_media(
    db: Session, viewer_id: UUID, media_id: UUID, mine_only: bool = True
) -> list[TypedHighlightOut]:
    """PDF media yield geometry anchors; every other kind yields fragment anchors.

    A fragment highlight whose cached fragment vanished is re-resolved by quote,
    and stays in the list with a locator-less anchor when it cannot be resolved.
    """
    media = db.get(Media, media_id)
    if media is None or not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    visible = (
        Highlight.user_id == viewer_id
        if mine_only
        else highlight_visibility_filter(viewer_id, media_id)
    )

    if media.kind == "pdf":
        pdf_rows = db.scalars(
            select(Highlight)
            .join(HighlightPdfAnchor, Highlight.id == HighlightPdfAnchor.highlight_id)
            .where(
                HighlightPdfAnchor.media_id == media_id,
                Highlight.anchor_kind == "pdf_page_geometry",
                visible,
            )
            .order_by(
                HighlightPdfAnchor.page_number,
                HighlightPdfAnchor.sort_top,
                HighlightPdfAnchor.sort_left,
                Highlight.created_at,
                Highlight.id,
            )
        ).all()
        return project_highlights_with_links(db, viewer_id, list(pdf_rows))

    def ordered_rows():
        return db.execute(
            select(Highlight, Fragment.id)
            .join(HighlightFragmentAnchor, Highlight.id == HighlightFragmentAnchor.highlight_id)
            .outerjoin(Fragment, Fragment.id == HighlightFragmentAnchor.fragment_id)
            .where(
                Highlight.anchor_media_id == media_id,
                Highlight.anchor_kind == "fragment_offsets",
                visible,
            )
            .order_by(
                Fragment.idx,  # NULLS LAST: unresolved highlights sort after resolved
                HighlightFragmentAnchor.start_offset,
                Highlight.created_at,
                Highlight.id,
            )
        ).all()

    rows = ordered_rows()
    stale = [highlight for highlight, live_fragment_id in rows if live_fragment_id is None]
    if stale and _repair_missing_fragment_caches(db, media_id=media_id, stale=stale):
        rows = ordered_rows()
    unresolved = FragmentAnchorOut(
        media_id=media_id, fragment_id=None, start_offset=None, end_offset=None
    )
    return _project_anchored(
        db,
        viewer_id,
        [(item, unresolved if live is None else _anchor_out(item)) for item, live in rows],
    )


def get_highlight(db: Session, viewer_id: UUID, highlight_id: UUID) -> TypedHighlightOut:
    highlight = get_highlight_for_visible_read_or_404(db, viewer_id, highlight_id)
    return project_highlights_with_links(db, viewer_id, [highlight])[0]


def get_highlight_reader_target(
    db: Session, *, viewer_id: UUID, highlight_id: UUID
) -> ResolvedHighlightReaderTarget:
    if not can_read_highlight(db, viewer_id, highlight_id):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Highlight unavailable")
    target = locator_resolver.resolve_highlight_reader_target(db, highlight_id=highlight_id)
    if target is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Highlight unavailable")
    return target


def update_highlight(
    db: Session, viewer_id: UUID, highlight_id: UUID, req: UpdateHighlightRequest
) -> TypedHighlightOut:
    highlight = get_highlight_for_author_write_or_404(db, viewer_id, highlight_id)
    anchor_update = req.anchor
    if anchor_update is not None and anchor_update.type != highlight.anchor_kind:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"{anchor_update.type} anchor updates are not valid for this highlight",
        )

    if highlight.anchor_kind == "pdf_page_geometry":
        if anchor_update is not None and anchor_update.type == "pdf_page_geometry":
            from nexus.services.pdf_highlights import update_pdf_highlight_bounds

            return update_pdf_highlight_bounds(
                db,
                viewer_id,
                highlight,
                PdfBoundsUpdate(
                    page_number=anchor_update.page_number,
                    quads=anchor_update.quads,
                    exact=req.exact or "",
                ),
                req.color,
            )
        if req.color is not None and req.color != highlight.color:
            _require_media_text_ready(db, _parent_media_id(highlight))
            db.execute(
                update(Highlight)
                .where(Highlight.id == highlight_id)
                .values(color=req.color, updated_at=func.now())
            )
            db.commit()
            db.refresh(highlight)
        return project_highlight(highlight, viewer_id)

    moved_to = (
        anchor_update
        if anchor_update is not None and anchor_update.type == "fragment_offsets"
        else None
    )
    fragment_anchor = highlight.fragment_anchor
    if fragment_anchor is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    _require_media_text_ready(db, _parent_media_id(highlight))

    start = fragment_anchor.start_offset if moved_to is None else moved_to.start_offset
    end = fragment_anchor.end_offset if moved_to is None else moved_to.end_offset
    color = highlight.color if req.color is None else req.color
    moved = (start, end) != (fragment_anchor.start_offset, fragment_anchor.end_offset)
    if not moved and color == highlight.color:
        return project_highlight(highlight, viewer_id)

    values: dict[str, object] = {"updated_at": func.now(), "color": color}
    if moved:
        fragment = db.get(Fragment, fragment_anchor.fragment_id)
        if fragment is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
        lock_fragment_row_for_highlight_write_or_404(db, fragment.id)
        validate_offsets_or_400(fragment.canonical_text, start, end)
        exact, prefix, suffix = derive_exact_prefix_suffix(fragment.canonical_text, start, end)
        values |= {"exact": exact, "prefix": prefix, "suffix": suffix}
        if fragment_highlight_span_conflict_exists(
            db,
            viewer_id=viewer_id,
            fragment_id=fragment_anchor.fragment_id,
            start_offset=start,
            end_offset=end,
            highlight_id=highlight_id,
        ):
            raise ApiError(
                ApiErrorCode.E_HIGHLIGHT_CONFLICT, "Highlight already exists at this range"
            )

    try:
        db.execute(update(Highlight).where(Highlight.id == highlight_id).values(**values))
        if moved:
            fragment_anchor.start_offset = start
            fragment_anchor.end_offset = end
        db.flush()
        db.commit()
    except IntegrityError as e:
        db.rollback()
        raise map_integrity_error(e) from e
    db.refresh(highlight)
    return project_highlight(highlight, viewer_id)


def delete_highlight_rows(db: Session, highlight: Highlight) -> None:
    """Child-first deletion under the parent media lock; never a DB cascade."""
    media_id = _parent_media_id(highlight)
    db.execute(select(Media.id).where(Media.id == media_id).with_for_update())
    locked = db.scalar(
        select(Highlight)
        .where(Highlight.id == highlight.id, Highlight.anchor_media_id == media_id)
        .with_for_update()
    )
    if locked is None:
        return

    from nexus.services import resource_grants
    from nexus.services.artifacts.idea_seeds import delete_highlight_idea_rows
    from nexus.services.media_deletion import claim_document_teardown_if_unreferenced_locked

    ref = ResourceRef(scheme="highlight", id=locked.id)
    delete_highlight_idea_rows(db, highlight_id=locked.id)
    resource_grants.delete_exact_subject(db, ref)
    delete_edges_for_deleted_resource(db, ref=ref)
    delete_resource_protocol_state(db, viewer_id=locked.user_id, ref=ref)
    db.execute(delete(HighlightPdfQuad).where(HighlightPdfQuad.highlight_id == locked.id))
    db.execute(delete(HighlightPdfAnchor).where(HighlightPdfAnchor.highlight_id == locked.id))
    db.execute(
        delete(HighlightFragmentAnchor).where(HighlightFragmentAnchor.highlight_id == locked.id)
    )
    db.execute(delete(Highlight).where(Highlight.id == locked.id))
    claim_document_teardown_if_unreferenced_locked(db, media_id)


def delete_highlight(db: Session, viewer_id: UUID, highlight_id: UUID) -> None:
    def attempt() -> None:
        delete_highlight_rows(
            db, get_highlight_for_author_write_or_404(db, viewer_id, highlight_id)
        )
        db.flush()
        db.commit()

    retry_read_committed(db, "delete_highlight", attempt)
