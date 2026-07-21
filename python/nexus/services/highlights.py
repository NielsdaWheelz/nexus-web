"""Highlight service layer."""

from uuid import UUID

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError

from nexus.auth.permissions import (
    can_read_media,
    highlight_visibility_filter,
)
from nexus.db.models import (
    Fragment,
    Highlight,
    HighlightFragmentAnchor,
    HighlightPdfAnchor,
    HighlightPdfQuad,
    Media,
)
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
from nexus.services import text_quote
from nexus.services.capabilities import is_text_document_ready
from nexus.services.highlight_access import (
    get_highlight_for_author_write_or_404,
    get_highlight_for_visible_read_or_404,
)
from nexus.services.highlight_access import (
    require_typed_highlight_or_404 as _require_typed_highlight_or_404,
)
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

# =============================================================================
# Shared Helpers
# =============================================================================


def get_fragment_for_viewer_or_404(db: Session, viewer_id: UUID, fragment_id: UUID) -> Fragment:
    """Load fragment with eager-loaded media.

    Raises:
        NotFoundError(E_MEDIA_NOT_FOUND): If fragment doesn't exist OR viewer cannot read its media.
    """
    fragment = db.get(Fragment, fragment_id)
    if fragment is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    if not can_read_media(db, viewer_id, fragment.media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    return fragment  # fragment.media available via relationship


def _lock_fragment_row_for_highlight_write_or_404(db: Session, fragment_id: UUID) -> None:
    """Serialize fragment highlight mutations on the target fragment row."""

    locked_fragment_id = db.execute(
        select(Fragment.id).where(Fragment.id == fragment_id).with_for_update()
    ).scalar_one_or_none()
    if locked_fragment_id is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")


def _require_media_readable_for_highlight(db: Session, media_id: UUID) -> None:
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
        str(row[2]) if row[2] is not None else None,
        str(row[3]) if row[3] is not None else None,
    ):
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media not ready")


def validate_offsets_or_400(canonical_text: str, start: int, end: int) -> None:
    """Validate offsets are within bounds.

    MUST be called BEFORE derive_exact_prefix_suffix.

    Raises:
        ApiError(E_HIGHLIGHT_INVALID_RANGE): If offsets invalid.
    """
    if start < 0 or end <= start or end > len(canonical_text):
        raise ApiError(ApiErrorCode.E_HIGHLIGHT_INVALID_RANGE, "Invalid highlight range")


def derive_exact_prefix_suffix(canonical_text: str, start: int, end: int) -> tuple[str, str, str]:
    """Derive exact/prefix/suffix from canonical_text using codepoint offsets.

    Offsets are half-open [start, end) over fragment.canonical_text in Unicode codepoints.
    Assumes offsets already validated.

    Returns:
        Tuple of (exact, prefix, suffix)
    """
    exact = canonical_text[start:end]
    prefix = canonical_text[max(0, start - 64) : start]
    suffix = canonical_text[end : min(len(canonical_text), end + 64)]
    return exact, prefix, suffix


def map_integrity_error(e: IntegrityError) -> ApiError:
    """Map IntegrityError to appropriate ApiError based on constraint name."""
    constraint_name = None

    # Try to get constraint name from psycopg diag
    if hasattr(e.orig, "diag") and hasattr(e.orig.diag, "constraint_name"):
        constraint_name = e.orig.diag.constraint_name
    else:
        # Fallback: search exception message
        msg = str(e.orig) if e.orig else str(e)
        for name in (
            "ck_highlights_color",
            "ck_hfa_offsets_valid",
        ):
            if name in msg:
                constraint_name = name
                break

    if constraint_name in ("ck_highlights_color", "ck_hfa_offsets_valid"):
        return ApiError(ApiErrorCode.E_INVALID_REQUEST, "Invalid highlight data")

    # Unknown constraint — internal error
    logger.error("unknown_integrity_error", constraint=constraint_name, error=str(e))
    return ApiError(ApiErrorCode.E_INTERNAL, "Database constraint violation")


def _require_fragment_highlight_or_404(highlight: Highlight) -> HighlightFragmentAnchor:
    """Require a highlight to be a canonical fragment highlight."""

    _require_typed_highlight_or_404(highlight)
    if highlight.anchor_kind != "fragment_offsets" or highlight.fragment_anchor is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    return highlight.fragment_anchor


def _require_pdf_highlight_or_404(highlight: Highlight):
    """Require a highlight to be a canonical PDF highlight."""

    _require_typed_highlight_or_404(highlight)
    if highlight.anchor_kind != "pdf_page_geometry" or highlight.pdf_anchor is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    return highlight.pdf_anchor


def _require_media_readable_for_existing_highlight(db: Session, highlight: Highlight) -> None:
    """Resolve media for a highlight and check document readability."""

    _require_typed_highlight_or_404(highlight)
    media_id = highlight.anchor_media_id
    if media_id is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")

    _require_media_readable_for_highlight(db, media_id)


def _batch_linked_conversations(
    db: Session, highlight_ids: list[UUID], viewer_id: UUID
) -> dict[UUID, list[LinkedConversationRef]]:
    """Conversations that reference the given highlights, projected to refs.

    The reverse-lookup predicate is owned by its §9.4 home,
    ``resource_graph.context.batch_conversations_with_any_edge_to_ref`` (the batched
    twin of ``list_conversations_with_any_edge_to_ref``); this only maps the
    conversation rows to ``LinkedConversationRef``, mirroring how
    ``_batch_linked_note_blocks`` delegates to ``notes``.
    """
    return {
        highlight_id: [
            LinkedConversationRef(conversation_id=conv.id, title=conv.title)
            for conv in conversations
        ]
        for highlight_id, conversations in batch_conversations_with_any_edge_to_ref(
            db, viewer_id=viewer_id, targets=highlight_ids, target_scheme="highlight"
        ).items()
    }


def _batch_linked_note_blocks(
    db: Session, highlight_ids: list[UUID], viewer_id: UUID
) -> dict[UUID, list[LinkedNoteBlockRef]]:
    return {
        highlight_id: [
            LinkedNoteBlockRef(
                note_block_id=block.id,
                body_pm_json=block.body_pm_json,
                body_text=block.body_text,
            )
            for block in blocks
        ]
        for highlight_id, blocks in linked_note_blocks_for_highlights(
            db, viewer_id, highlight_ids
        ).items()
    }


def project_highlight(highlight: Highlight, viewer_id: UUID) -> TypedHighlightOut:
    """Convert Highlight ORM model to anchor-discriminated TypedHighlightOut."""
    _require_typed_highlight_or_404(highlight)

    if highlight.anchor_kind == "pdf_page_geometry":
        pdf_anchor = _require_pdf_highlight_or_404(highlight)
        quads_out = []
        if highlight.pdf_quads:
            sorted_quads = sorted(highlight.pdf_quads, key=lambda q: q.quad_idx)
            quads_out = [
                PdfQuadOut(
                    x1=float(q.x1),
                    y1=float(q.y1),
                    x2=float(q.x2),
                    y2=float(q.y2),
                    x3=float(q.x3),
                    y3=float(q.y3),
                    x4=float(q.x4),
                    y4=float(q.y4),
                )
                for q in sorted_quads
            ]
        anchor = PdfAnchorOut(
            type="pdf_page_geometry",
            media_id=pdf_anchor.media_id,
            page_number=pdf_anchor.page_number,
            quads=quads_out,
        )
    elif highlight.anchor_kind == "fragment_offsets":
        fragment_anchor = _require_fragment_highlight_or_404(highlight)
        anchor = FragmentAnchorOut(
            type="fragment_offsets",
            media_id=highlight.anchor_media_id,
            fragment_id=fragment_anchor.fragment_id,
            start_offset=fragment_anchor.start_offset,
            end_offset=fragment_anchor.end_offset,
        )
    else:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")

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
        is_owner=(highlight.user_id == viewer_id),
    )


def project_highlights_with_links(
    db: Session, viewer_id: UUID, highlights: list[Highlight]
) -> list[TypedHighlightOut]:
    highlight_ids = [highlight.id for highlight in highlights]
    conv_map = _batch_linked_conversations(db, highlight_ids, viewer_id)
    note_map = _batch_linked_note_blocks(db, highlight_ids, viewer_id)
    return [
        project_highlight(highlight, viewer_id).model_copy(
            update={
                "linked_conversations": conv_map.get(highlight.id, []),
                "linked_note_blocks": note_map.get(highlight.id, []),
            }
        )
        for highlight in highlights
    ]


def project_highlight_with_links(
    db: Session, viewer_id: UUID, highlight: Highlight
) -> TypedHighlightOut:
    return project_highlights_with_links(db, viewer_id, [highlight])[0]


def _fragment_highlight_span_conflict_exists(
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


# =============================================================================
# Service Functions (One per Route)
# =============================================================================


def create_highlight_for_fragment(
    db: Session, viewer_id: UUID, fragment_id: UUID, req: CreateHighlightRequest
) -> TypedHighlightOut:
    """Create a highlight for a fragment.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        fragment_id: The ID of the fragment to highlight.
        req: The highlight creation request.

    Returns:
        The created highlight with a canonical fragment anchor payload.

    Raises:
        NotFoundError(E_MEDIA_NOT_FOUND): If fragment doesn't exist or not readable.
        ApiError(E_MEDIA_NOT_READY): If media not in ready state.
        ApiError(E_HIGHLIGHT_INVALID_RANGE): If offsets out of bounds.
        ApiError(E_HIGHLIGHT_CONFLICT): If highlight already exists at this range.
    """
    # 1. Get fragment with visibility check
    fragment = get_fragment_for_viewer_or_404(db, viewer_id, fragment_id)

    # 2. Require a readable document surface
    _require_media_readable_for_highlight(db, fragment.media_id)

    # Serialize duplicate-span checks on the fragment row before canonical
    # anchor writes.
    _lock_fragment_row_for_highlight_write_or_404(db, fragment_id)

    # 3. Validate offsets
    validate_offsets_or_400(fragment.canonical_text, req.start_offset, req.end_offset)

    if _fragment_highlight_span_conflict_exists(
        db,
        viewer_id=viewer_id,
        fragment_id=fragment_id,
        start_offset=req.start_offset,
        end_offset=req.end_offset,
    ):
        raise ApiError(ApiErrorCode.E_HIGHLIGHT_CONFLICT, "Highlight already exists at this range")

    # 4. Derive exact/prefix/suffix
    exact, prefix, suffix = derive_exact_prefix_suffix(
        fragment.canonical_text, req.start_offset, req.end_offset
    )

    # 5. Create highlight row plus canonical fragment anchor
    highlight = Highlight(
        user_id=viewer_id,
        anchor_kind="fragment_offsets",
        anchor_media_id=fragment.media_id,
        color=req.color,
        exact=exact,
        prefix=prefix,
        suffix=suffix,
    )

    # 6. Persist with integrity error handling
    try:
        db.add(highlight)
        db.flush()

        fragment_anchor = HighlightFragmentAnchor(
            highlight_id=highlight.id,
            fragment_id=fragment_id,
            start_offset=req.start_offset,
            end_offset=req.end_offset,
        )
        db.add(fragment_anchor)
        db.flush()

        from nexus.services import synapse

        synapse.queue_synapse_scan(
            db,
            user_id=viewer_id,
            ref=ResourceRef(scheme="highlight", id=highlight.id),
            reason="highlight_create",
        )
        db.commit()
    except IntegrityError as e:
        db.rollback()
        raise map_integrity_error(e) from e

    db.refresh(highlight)
    return project_highlight(highlight, viewer_id)


def list_highlights_for_fragment(
    db: Session, viewer_id: UUID, fragment_id: UUID, mine_only: bool = True
) -> list[TypedHighlightOut]:
    """List highlights for a fragment.

    NO ready check - read-only operation.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        fragment_id: The ID of the fragment.
        mine_only: If True (default), return only viewer-authored highlights.
            If False, return all highlights visible under the shared-reader predicate.

    Returns:
        List of canonical typed highlights ordered by start_offset ASC, created_at ASC, id ASC.

    Raises:
        NotFoundError(E_MEDIA_NOT_FOUND): If fragment doesn't exist or not readable.
    """
    fragment = get_fragment_for_viewer_or_404(db, viewer_id, fragment_id)

    query = (
        db.query(Highlight)
        .join(HighlightFragmentAnchor, Highlight.id == HighlightFragmentAnchor.highlight_id)
        .filter(
            Highlight.anchor_kind == "fragment_offsets",
            HighlightFragmentAnchor.fragment_id == fragment_id,
        )
    )

    if mine_only:
        query = query.filter(Highlight.user_id == viewer_id)
    else:
        query = query.filter(highlight_visibility_filter(viewer_id, fragment.media_id))

    highlights = query.order_by(
        HighlightFragmentAnchor.start_offset.asc(),
        Highlight.created_at.asc(),
        Highlight.id.asc(),
    ).all()

    return project_highlights_with_links(db, viewer_id, highlights)


def _repair_missing_fragment_caches(db: Session, *, media_id: UUID, stale: list[Highlight]) -> bool:
    """Re-resolve highlights whose cached fragment row vanished (reindex/refresh).

    The authored quote is identity; ``fragment_id``/offsets are a disposable
    locator cache. A quote that resolves uniquely against the media's current
    text through the shared quote matchers recreates the cache values; ambiguous
    or unmatched quotes stay unresolved — returned with no locator, never
    painted at a wrong location (invariant 9). The media's fragments are fetched
    and normalized once, then matched per quote.

    Returns True when the caller must re-read: a cache row was repaired
    (committed — read paths otherwise roll back at session close) or a
    highlight vanished under a concurrent delete.
    """
    sources = text_quote.load_normalized_media_sources(db, media_id=media_id)
    gone = False
    repaired = False
    for highlight in stale:
        anchor = highlight.fragment_anchor
        if anchor is None:
            # Concurrently deleted between the list read and this repair; the
            # caller's re-read drops the highlight instead of crashing.
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
            # An anchor row was deleted while we repaired it. Drop the batch;
            # the re-read reflects the delete and the next read repairs the
            # survivors.
            db.rollback()
    return gone or repaired


def list_highlights_for_media(
    db: Session, viewer_id: UUID, media_id: UUID, mine_only: bool = True
) -> list[TypedHighlightOut]:
    """List every highlight of a media across all fragments and PDF pages.

    NO ready check - read-only operation. A media is one kind: PDF media yield
    PDF highlights on every page; all other kinds yield fragment highlights in
    every fragment.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        media_id: The ID of the media.
        mine_only: If True (default), return only viewer-authored highlights.
            If False, return all highlights visible under the shared-reader predicate.

    Returns:
        List of canonical typed highlights ordered by anchor position then
        created_at ASC, id ASC. Fragment highlights whose cached fragment
        vanished are re-resolved by quote; those that stay unresolved are
        returned last with a locator-less anchor.

    Raises:
        NotFoundError(E_MEDIA_NOT_FOUND): If media doesn't exist or not readable.
    """
    media = db.get(Media, media_id)
    if media is None or not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")

    if media.kind == "pdf":
        query = (
            db.query(Highlight)
            .join(HighlightPdfAnchor, Highlight.id == HighlightPdfAnchor.highlight_id)
            .filter(
                HighlightPdfAnchor.media_id == media_id,
                Highlight.anchor_kind == "pdf_page_geometry",
            )
        )
        if mine_only:
            query = query.filter(Highlight.user_id == viewer_id)
        else:
            query = query.filter(highlight_visibility_filter(viewer_id, media_id))
        highlights = query.order_by(
            HighlightPdfAnchor.page_number.asc(),
            HighlightPdfAnchor.sort_top.asc(),
            HighlightPdfAnchor.sort_left.asc(),
            Highlight.created_at.asc(),
            Highlight.id.asc(),
        ).all()
        return project_highlights_with_links(db, viewer_id, highlights)

    # Fragment ids/offsets are a locator cache, not identity: start from
    # highlights (anchor_media_id) and LEFT JOIN the cached fragment so a
    # highlight whose fragment was replaced by reindex/refresh is still
    # returned, never silently dropped (invariant 9).
    def ordered_rows():  # (Highlight, live fragment id | None) rows
        query = (
            db.query(Highlight, Fragment.id)
            .join(HighlightFragmentAnchor, Highlight.id == HighlightFragmentAnchor.highlight_id)
            .outerjoin(Fragment, Fragment.id == HighlightFragmentAnchor.fragment_id)
            .filter(
                Highlight.anchor_media_id == media_id,
                Highlight.anchor_kind == "fragment_offsets",
            )
        )
        if mine_only:
            filtered = query.filter(Highlight.user_id == viewer_id)
        else:
            filtered = query.filter(highlight_visibility_filter(viewer_id, media_id))
        return filtered.order_by(
            Fragment.idx.asc(),  # NULLS LAST: unresolved highlights sort after resolved
            HighlightFragmentAnchor.start_offset.asc(),
            Highlight.created_at.asc(),
            Highlight.id.asc(),
        ).all()

    rows = ordered_rows()
    stale = [highlight for highlight, live_fragment_id in rows if live_fragment_id is None]
    if stale and _repair_missing_fragment_caches(db, media_id=media_id, stale=stale):
        # Re-read so a repaired cache sorts at its true document position (the
        # first ORDER BY saw a NULL join) and a highlight deleted mid-repair
        # drops out; still-unresolved rows re-join NULL and stay last.
        rows = ordered_rows()

    highlights = [highlight for highlight, _ in rows]
    unresolved_ids = {
        highlight.id for highlight, live_fragment_id in rows if live_fragment_id is None
    }

    outs = project_highlights_with_links(db, viewer_id, highlights)
    if unresolved_ids:
        outs = [
            out.model_copy(
                update={
                    "anchor": out.anchor.model_copy(
                        update={"fragment_id": None, "start_offset": None, "end_offset": None}
                    )
                }
            )
            if out.id in unresolved_ids
            else out
            for out in outs
        ]
    return outs


def get_highlight(db: Session, viewer_id: UUID, highlight_id: UUID) -> TypedHighlightOut:
    """Get a single highlight by ID (anchor-discriminated typed output).

    NO ready check - read-only operation.
    Visible to shared readers under the shared-reader predicate.

    Returns:
        TypedHighlightOut with anchor discriminator for both fragment and PDF highlights.
    """
    highlight = get_highlight_for_visible_read_or_404(db, viewer_id, highlight_id)
    return project_highlight_with_links(db, viewer_id, highlight)


def update_highlight(
    db: Session, viewer_id: UUID, highlight_id: UUID, req: UpdateHighlightRequest
) -> TypedHighlightOut:
    """Update a highlight (unified PATCH for fragment + PDF).

    Returns TypedHighlightOut with anchor discriminator.
    """
    highlight = get_highlight_for_author_write_or_404(db, viewer_id, highlight_id)
    anchor_kind = highlight.anchor_kind
    anchor_update = req.anchor

    if anchor_update is not None and anchor_update.type != anchor_kind:
        if anchor_update.type == "pdf_page_geometry":
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                "pdf_page_geometry anchor updates are not valid for non-PDF highlights",
            )
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "fragment_offsets anchor updates are not valid for PDF highlights",
        )

    if anchor_update is not None and anchor_kind == "pdf_page_geometry":
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

    # PDF color-only update
    if anchor_kind == "pdf_page_geometry" and anchor_update is None:
        if req.color is not None and req.color != highlight.color:
            _require_media_readable_for_existing_highlight(db, highlight)
            stmt = (
                update(Highlight)
                .where(Highlight.id == highlight_id)
                .values(color=req.color, updated_at=func.now())
            )
            db.execute(stmt)
            db.flush()
            db.commit()
            db.refresh(highlight)
        return project_highlight(highlight, viewer_id)

    fragment_anchor = _require_fragment_highlight_or_404(highlight)

    _require_media_readable_for_existing_highlight(db, highlight)

    current_start = fragment_anchor.start_offset
    current_end = fragment_anchor.end_offset
    final_start = anchor_update.start_offset if anchor_update is not None else current_start
    final_end = anchor_update.end_offset if anchor_update is not None else current_end
    final_color = req.color if req.color is not None else highlight.color

    offsets_changed = final_start != current_start or final_end != current_end
    color_changed = final_color != highlight.color

    if not offsets_changed and not color_changed:
        return project_highlight(highlight, viewer_id)

    update_values: dict = {"updated_at": func.now()}

    if offsets_changed:
        fragment = db.get(Fragment, fragment_anchor.fragment_id)
        if fragment is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
        _lock_fragment_row_for_highlight_write_or_404(db, fragment.id)
        validate_offsets_or_400(fragment.canonical_text, final_start, final_end)
        exact, prefix, suffix = derive_exact_prefix_suffix(
            fragment.canonical_text, final_start, final_end
        )
        update_values.update(
            {
                "exact": exact,
                "prefix": prefix,
                "suffix": suffix,
            }
        )

    if color_changed:
        update_values["color"] = final_color

    if offsets_changed and _fragment_highlight_span_conflict_exists(
        db,
        viewer_id=viewer_id,
        fragment_id=fragment_anchor.fragment_id,
        start_offset=final_start,
        end_offset=final_end,
        highlight_id=highlight_id,
    ):
        raise ApiError(ApiErrorCode.E_HIGHLIGHT_CONFLICT, "Highlight already exists at this range")

    try:
        stmt = update(Highlight).where(Highlight.id == highlight_id).values(**update_values)
        db.execute(stmt)

        if offsets_changed:
            fragment_anchor.start_offset = final_start
            fragment_anchor.end_offset = final_end

        db.flush()
        db.commit()
    except IntegrityError as e:
        db.rollback()
        raise map_integrity_error(e) from e

    db.refresh(highlight)
    return project_highlight(highlight, viewer_id)


def delete_highlight_rows(db: Session, highlight: Highlight) -> None:
    """Explicit child-first deletion of one Highlight (no DB cascades remain).

    Order: graph edges with their view states plus the author's protocol state,
    then PDF quads, then PDF/fragment anchor rows, then the Highlight root —
    the single-highlight form of media_deletion.py's owner-wide block.
    Flush-only: runs inside the caller's transaction.
    """
    ref = ResourceRef(scheme="highlight", id=highlight.id)
    delete_edges_for_deleted_resource(db, ref=ref)
    delete_resource_protocol_state(db, viewer_id=highlight.user_id, ref=ref)
    db.execute(delete(HighlightPdfQuad).where(HighlightPdfQuad.highlight_id == highlight.id))
    db.execute(delete(HighlightPdfAnchor).where(HighlightPdfAnchor.highlight_id == highlight.id))
    db.execute(
        delete(HighlightFragmentAnchor).where(HighlightFragmentAnchor.highlight_id == highlight.id)
    )
    db.execute(delete(Highlight).where(Highlight.id == highlight.id))


def delete_highlight(db: Session, viewer_id: UUID, highlight_id: UUID) -> None:
    """Delete a highlight (fragment or PDF) with explicit child-first cleanup.

    NO ready check - allows cleanup even if media status drifts.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        highlight_id: The ID of the highlight to delete.

    Raises:
        NotFoundError(E_MEDIA_NOT_FOUND): If highlight doesn't exist, not owned, or not readable.
    """
    # Verify highlight exists and is owned by viewer
    highlight = get_highlight_for_author_write_or_404(db, viewer_id, highlight_id)

    delete_highlight_rows(db, highlight)
    db.flush()
    db.commit()
