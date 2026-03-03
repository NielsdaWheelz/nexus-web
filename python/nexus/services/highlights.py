"""Highlight and Annotation service layer.

Read visibility: shared read allowed under canonical highlight visibility predicate
(media readable + library intersection between author and viewer per S4 spec §5.2).
Write boundary: author-only for all mutation operations.

Error masking: E_MEDIA_NOT_FOUND consistently for all 404s (prevent probing attacks).
Mutation guard: media ready status required for create/update/upsert; list/get/delete
allowed even if media status drifts.

Helper split (S4):
- get_highlight_for_visible_read_or_404: read path (visibility predicate)
- get_highlight_for_author_write_or_404: write path (author-only)

S6 PR-02 adoption:
- Fragment create/update uses transactional dual-write (canonical subtype + legacy bridge)
- Read paths use highlight_kernel for anchor-kind-aware media resolution
- Dormant-window fragment rows are repaired in explicit write-capable paths
- Mismatch handling follows D03 path-specific mapping via highlight_kernel

Service functions correspond 1:1 with route handlers.
Routes are transport-only and call exactly one service function.
"""

import base64
import json
from datetime import datetime
from uuid import UUID

from sqlalchemy import and_, delete, func, or_, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_highlight, can_read_media, highlight_visibility_filter
from nexus.db.models import Annotation, Fragment, Highlight, HighlightFragmentAnchor, Media
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.logging import get_logger
from nexus.schemas.highlights import (
    AnnotationOut,
    CreateHighlightRequest,
    FragmentAnchorOut,
    HighlightOut,
    MediaHighlightOut,
    MediaHighlightPageInfoOut,
    PdfAnchorOut,
    PdfQuadOut,
    TypedHighlightOut,
    UpdateHighlightRequest,
    UpsertAnnotationRequest,
)
from nexus.services.highlight_kernel import (
    HighlightKernelIntegrityError,
    MappingClass,
    ResolverState,
    build_internal_view,
    map_mismatch,
    repair_fragment_highlight,
    resolve_highlight,
)
from nexus.services.media import get_media_for_viewer_or_404

logger = get_logger(__name__)

# =============================================================================
# Constants
# =============================================================================

# Processing statuses where media is ready for highlight mutations
READY_STATUSES: set[str] = {"ready_for_reading", "embedding", "ready"}


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


def require_media_ready_or_409(processing_status: str) -> None:
    """Raise 409 if media is not in a ready state for highlight mutations."""
    if processing_status not in READY_STATUSES:
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
            "uix_highlights_user_fragment_offsets",
            "ck_highlights_offsets_valid",
            "ck_highlights_color",
            "ck_highlights_fragment_bridge",
            "ck_hfa_offsets_valid",
        ):
            if name in msg:
                constraint_name = name
                break

    if constraint_name == "uix_highlights_user_fragment_offsets":
        return ApiError(ApiErrorCode.E_HIGHLIGHT_CONFLICT, "Highlight already exists at this range")
    if constraint_name in (
        "ck_highlights_offsets_valid",
        "ck_highlights_color",
        "ck_highlights_fragment_bridge",
        "ck_hfa_offsets_valid",
    ):
        return ApiError(ApiErrorCode.E_INVALID_REQUEST, "Invalid highlight data")

    # Unknown constraint — internal error
    logger.error("unknown_integrity_error", constraint=constraint_name, error=str(e))
    return ApiError(ApiErrorCode.E_INTERNAL, "Database constraint violation")


def encode_media_highlights_cursor(
    fragment_idx: int,
    start_offset: int,
    end_offset: int,
    created_at: datetime,
    highlight_id: UUID,
) -> str:
    """Encode keyset cursor for media-wide highlight listing."""
    payload = {
        "fragment_idx": fragment_idx,
        "start_offset": start_offset,
        "end_offset": end_offset,
        "created_at": created_at.isoformat(),
        "id": str(highlight_id),
    }
    json_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(json_bytes).decode("utf-8").rstrip("=")


def decode_media_highlights_cursor(cursor: str) -> tuple[int, int, int, datetime, UUID]:
    """Decode keyset cursor for media-wide highlight listing."""
    try:
        padding = 4 - len(cursor) % 4
        if padding < 4:
            cursor += "=" * padding
        json_bytes = base64.urlsafe_b64decode(cursor)
        payload = json.loads(json_bytes.decode("utf-8"))

        fragment_idx = int(payload["fragment_idx"])
        start_offset = int(payload["start_offset"])
        end_offset = int(payload["end_offset"])
        created_at = datetime.fromisoformat(payload["created_at"])
        highlight_id = UUID(payload["id"])
    except Exception:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from None

    if fragment_idx < 0 or start_offset < 0 or end_offset < 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor")

    return fragment_idx, start_offset, end_offset, created_at, highlight_id


def get_highlight_for_visible_read_or_404(
    db: Session, viewer_id: UUID, highlight_id: UUID
) -> Highlight:
    """Load highlight with relationships, enforce s4 read visibility.

    Visible iff viewer can read anchor media AND exists a library containing
    that media where both viewer and highlight author are members.

    Raises:
        NotFoundError(E_MEDIA_NOT_FOUND): If highlight doesn't exist or not visible.
    """
    highlight = db.get(Highlight, highlight_id)
    if highlight is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    if not can_read_highlight(db, viewer_id, highlight_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    return highlight


def get_highlight_for_author_write_or_404(
    db: Session, viewer_id: UUID, highlight_id: UUID
) -> Highlight:
    """Load highlight with relationships, enforce author-only write access.

    Uses highlight_kernel for anchor-kind-aware media resolution (S6 PR-02).
    Repairs dormant-window fragment highlights transactionally before returning.

    Raises:
        NotFoundError(E_MEDIA_NOT_FOUND): If highlight doesn't exist, not authored by viewer,
            or media not readable.
    """
    highlight = db.get(Highlight, highlight_id)
    if highlight is None or highlight.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")

    resolution = resolve_highlight(highlight)

    if resolution.state == ResolverState.mismatch:
        map_mismatch(resolution, MappingClass.masked_not_found, "get_highlight_for_author_write")
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")

    if resolution.state == ResolverState.dormant_repairable:
        try:
            resolution = repair_fragment_highlight(db, highlight)
        except HighlightKernelIntegrityError:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found") from None

    media_id = resolution.anchor_media_id
    if media_id is None or not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    return highlight


def _require_media_ready_for_highlight(db: Session, highlight: Highlight) -> None:
    """Resolve media for a highlight via kernel and check processing status."""

    resolution = resolve_highlight(highlight)
    media_id = resolution.anchor_media_id

    if highlight.fragment and highlight.fragment.media:
        require_media_ready_or_409(highlight.fragment.media.processing_status.value)
    elif media_id:
        media_obj = db.get(Media, media_id)
        if media_obj:
            require_media_ready_or_409(media_obj.processing_status.value)


def _annotation_to_out(annotation: Annotation | None) -> AnnotationOut | None:
    if annotation is None:
        return None
    return AnnotationOut(
        id=annotation.id,
        highlight_id=annotation.highlight_id,
        body=annotation.body,
        created_at=annotation.created_at,
        updated_at=annotation.updated_at,
    )


def _highlight_to_out(highlight: Highlight, viewer_id: UUID) -> HighlightOut:
    """Convert Highlight ORM model to HighlightOut schema (fragment-route compat)."""
    return HighlightOut(
        id=highlight.id,
        fragment_id=highlight.fragment_id,
        start_offset=highlight.start_offset,
        end_offset=highlight.end_offset,
        color=highlight.color,
        exact=highlight.exact,
        prefix=highlight.prefix,
        suffix=highlight.suffix,
        created_at=highlight.created_at,
        updated_at=highlight.updated_at,
        annotation=_annotation_to_out(highlight.annotation),
        author_user_id=highlight.user_id,
        is_owner=(highlight.user_id == viewer_id),
    )


def _highlight_to_typed_out(highlight: Highlight, viewer_id: UUID) -> TypedHighlightOut:
    """Convert Highlight ORM model to anchor-discriminated TypedHighlightOut."""
    resolution = resolve_highlight(highlight)
    view = build_internal_view(highlight, resolution)

    if view.anchor_kind == "pdf_page_geometry" and view.pdf_anchor is not None:
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
            media_id=view.pdf_anchor.media_id,
            page_number=view.pdf_anchor.page_number,
            quads=quads_out,
        )
    elif view.fragment_anchor is not None:
        anchor = FragmentAnchorOut(
            type="fragment_offsets",
            media_id=view.fragment_anchor.media_id,
            fragment_id=view.fragment_anchor.fragment_id,
            start_offset=view.fragment_anchor.start_offset,
            end_offset=view.fragment_anchor.end_offset,
        )
    else:
        anchor = FragmentAnchorOut(
            type="fragment_offsets",
            media_id=view.anchor_media_id,
            fragment_id=highlight.fragment_id or view.anchor_media_id,
            start_offset=highlight.start_offset or 0,
            end_offset=highlight.end_offset or 0,
        )

    return TypedHighlightOut(
        id=highlight.id,
        anchor=anchor,
        color=highlight.color,
        exact=highlight.exact,
        prefix=highlight.prefix,
        suffix=highlight.suffix,
        created_at=highlight.created_at,
        updated_at=highlight.updated_at,
        annotation=_annotation_to_out(highlight.annotation),
        author_user_id=highlight.user_id,
        is_owner=(highlight.user_id == viewer_id),
    )


# =============================================================================
# Service Functions (One per Route)
# =============================================================================


def create_highlight_for_fragment(
    db: Session, viewer_id: UUID, fragment_id: UUID, req: CreateHighlightRequest
) -> HighlightOut:
    """Create a highlight for a fragment.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        fragment_id: The ID of the fragment to highlight.
        req: The highlight creation request.

    Returns:
        The created highlight with annotation=None.

    Raises:
        NotFoundError(E_MEDIA_NOT_FOUND): If fragment doesn't exist or not readable.
        ApiError(E_MEDIA_NOT_READY): If media not in ready state.
        ApiError(E_HIGHLIGHT_INVALID_RANGE): If offsets out of bounds.
        ApiError(E_HIGHLIGHT_CONFLICT): If highlight already exists at this range.
    """
    # 1. Get fragment with visibility check
    fragment = get_fragment_for_viewer_or_404(db, viewer_id, fragment_id)

    # 2. Require media ready
    require_media_ready_or_409(fragment.media.processing_status.value)

    # 3. Validate offsets
    validate_offsets_or_400(fragment.canonical_text, req.start_offset, req.end_offset)

    # 4. Derive exact/prefix/suffix
    exact, prefix, suffix = derive_exact_prefix_suffix(
        fragment.canonical_text, req.start_offset, req.end_offset
    )

    # 5. Create highlight with typed logical fields (S6 PR-02 dual-write)
    highlight = Highlight(
        user_id=viewer_id,
        fragment_id=fragment_id,
        start_offset=req.start_offset,
        end_offset=req.end_offset,
        anchor_kind="fragment_offsets",
        anchor_media_id=fragment.media_id,
        color=req.color,
        exact=exact,
        prefix=prefix,
        suffix=suffix,
    )

    # 6. Persist with integrity error handling + fragment anchor subtype
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
        db.commit()
    except IntegrityError as e:
        db.rollback()
        raise map_integrity_error(e) from e

    # 7. Return HighlightOut with annotation=None
    return HighlightOut(
        id=highlight.id,
        fragment_id=highlight.fragment_id,
        start_offset=highlight.start_offset,
        end_offset=highlight.end_offset,
        color=highlight.color,
        exact=highlight.exact,
        prefix=highlight.prefix,
        suffix=highlight.suffix,
        created_at=highlight.created_at,
        updated_at=highlight.updated_at,
        annotation=None,
        author_user_id=highlight.user_id,
        is_owner=True,
    )


def list_highlights_for_fragment(
    db: Session, viewer_id: UUID, fragment_id: UUID, mine_only: bool = True
) -> list[HighlightOut]:
    """List highlights for a fragment.

    NO ready check - read-only operation.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        fragment_id: The ID of the fragment.
        mine_only: If True (default), return only viewer-authored highlights.
            If False, return all highlights visible under s4 canonical predicate.

    Returns:
        List of highlights ordered by start_offset ASC, created_at ASC, id ASC.

    Raises:
        NotFoundError(E_MEDIA_NOT_FOUND): If fragment doesn't exist or not readable.
    """
    fragment = get_fragment_for_viewer_or_404(db, viewer_id, fragment_id)

    query = db.query(Highlight).filter(Highlight.fragment_id == fragment_id)

    if mine_only:
        query = query.filter(Highlight.user_id == viewer_id)
    else:
        query = query.filter(highlight_visibility_filter(viewer_id, fragment.media_id))

    highlights = query.order_by(
        Highlight.start_offset.asc(),
        Highlight.created_at.asc(),
        Highlight.id.asc(),
    ).all()

    return [_highlight_to_out(h, viewer_id) for h in highlights]


def list_highlights_for_media(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    limit: int = 50,
    cursor: str | None = None,
    mine_only: bool = True,
) -> tuple[list[MediaHighlightOut], MediaHighlightPageInfoOut]:
    """List highlights for a media item in deterministic chapter-local reading order.

    Order key:
      1) fragments.idx ASC
      2) highlights.start_offset ASC
      3) highlights.end_offset ASC
      4) highlights.created_at ASC
      5) highlights.id ASC
    """
    # Visibility/masking guard (raises masked 404 for missing/invisible media)
    get_media_for_viewer_or_404(db, viewer_id, media_id)

    query = (
        db.query(Highlight, Fragment.idx.label("fragment_idx"))
        .join(Fragment, Highlight.fragment_id == Fragment.id)
        .filter(Fragment.media_id == media_id)
    )

    if mine_only:
        query = query.filter(Highlight.user_id == viewer_id)
    else:
        query = query.filter(highlight_visibility_filter(viewer_id, media_id))

    if cursor:
        (
            cursor_fragment_idx,
            cursor_start_offset,
            cursor_end_offset,
            cursor_created_at,
            cursor_id,
        ) = decode_media_highlights_cursor(cursor)
        query = query.filter(
            or_(
                Fragment.idx > cursor_fragment_idx,
                and_(
                    Fragment.idx == cursor_fragment_idx,
                    Highlight.start_offset > cursor_start_offset,
                ),
                and_(
                    Fragment.idx == cursor_fragment_idx,
                    Highlight.start_offset == cursor_start_offset,
                    Highlight.end_offset > cursor_end_offset,
                ),
                and_(
                    Fragment.idx == cursor_fragment_idx,
                    Highlight.start_offset == cursor_start_offset,
                    Highlight.end_offset == cursor_end_offset,
                    Highlight.created_at > cursor_created_at,
                ),
                and_(
                    Fragment.idx == cursor_fragment_idx,
                    Highlight.start_offset == cursor_start_offset,
                    Highlight.end_offset == cursor_end_offset,
                    Highlight.created_at == cursor_created_at,
                    Highlight.id > cursor_id,
                ),
            )
        )

    rows = (
        query.order_by(
            Fragment.idx.asc(),
            Highlight.start_offset.asc(),
            Highlight.end_offset.asc(),
            Highlight.created_at.asc(),
            Highlight.id.asc(),
        )
        .limit(limit + 1)
        .all()
    )

    has_more = len(rows) > limit
    if has_more:
        rows = rows[:limit]

    highlights_out: list[MediaHighlightOut] = []
    for highlight, fragment_idx in rows:
        base = _highlight_to_out(highlight, viewer_id)
        highlights_out.append(
            MediaHighlightOut(
                **base.model_dump(),
                media_id=media_id,
                fragment_idx=int(fragment_idx),
            )
        )

    next_cursor = None
    if has_more and rows:
        last_highlight, last_fragment_idx = rows[-1]
        next_cursor = encode_media_highlights_cursor(
            fragment_idx=int(last_fragment_idx),
            start_offset=int(last_highlight.start_offset or 0),
            end_offset=int(last_highlight.end_offset or 0),
            created_at=last_highlight.created_at,
            highlight_id=last_highlight.id,
        )

    return highlights_out, MediaHighlightPageInfoOut(has_more=has_more, next_cursor=next_cursor)


def get_highlight(db: Session, viewer_id: UUID, highlight_id: UUID) -> TypedHighlightOut:
    """Get a single highlight by ID (anchor-discriminated typed output).

    NO ready check - read-only operation.
    Visible to shared readers under s4 canonical predicate.

    Returns:
        TypedHighlightOut with anchor discriminator for both fragment and PDF highlights.
    """
    highlight = get_highlight_for_visible_read_or_404(db, viewer_id, highlight_id)
    return _highlight_to_typed_out(highlight, viewer_id)


def update_highlight(
    db: Session, viewer_id: UUID, highlight_id: UUID, req: UpdateHighlightRequest
) -> TypedHighlightOut:
    """Update a highlight (unified PATCH for fragment + PDF).

    Returns TypedHighlightOut with anchor discriminator.
    """
    highlight = get_highlight_for_author_write_or_404(db, viewer_id, highlight_id)

    # D16: anchor-kind mismatch rejection
    resolution = resolve_highlight(highlight)
    anchor_kind = resolution.anchor_kind or "fragment_offsets"

    has_fragment_offsets = req.start_offset is not None or req.end_offset is not None
    has_pdf_bounds = req.pdf_bounds is not None

    if has_pdf_bounds and anchor_kind != "pdf_page_geometry":
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "pdf_bounds is not valid for non-PDF highlights",
        )
    if has_fragment_offsets and anchor_kind == "pdf_page_geometry":
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Fragment offset fields are not valid for PDF highlights",
        )

    # PDF bounds update: delegate to pdf_highlights
    if has_pdf_bounds and anchor_kind == "pdf_page_geometry":
        from nexus.services.pdf_highlights import update_pdf_highlight_bounds

        return update_pdf_highlight_bounds(
            db,
            viewer_id,
            highlight,
            req.pdf_bounds,
            req.color,
        )

    # PDF color-only update
    if anchor_kind == "pdf_page_geometry" and not has_pdf_bounds and not has_fragment_offsets:
        if req.color is not None and req.color != highlight.color:
            _require_media_ready_for_highlight(db, highlight)
            stmt = (
                update(Highlight)
                .where(Highlight.id == highlight_id)
                .values(color=req.color, updated_at=func.now())
            )
            db.execute(stmt)
            db.flush()
            db.commit()
            db.refresh(highlight)
        return _highlight_to_typed_out(highlight, viewer_id)

    # Fragment update path (unchanged logic)
    _require_media_ready_for_highlight(db, highlight)

    final_start = req.start_offset if req.start_offset is not None else highlight.start_offset
    final_end = req.end_offset if req.end_offset is not None else highlight.end_offset
    final_color = req.color if req.color is not None else highlight.color

    offsets_changed = final_start != highlight.start_offset or final_end != highlight.end_offset
    color_changed = final_color != highlight.color

    if not offsets_changed and not color_changed:
        return _highlight_to_typed_out(highlight, viewer_id)

    update_values: dict = {"updated_at": func.now()}

    if offsets_changed:
        validate_offsets_or_400(highlight.fragment.canonical_text, final_start, final_end)
        exact, prefix, suffix = derive_exact_prefix_suffix(
            highlight.fragment.canonical_text, final_start, final_end
        )
        update_values.update(
            {
                "start_offset": final_start,
                "end_offset": final_end,
                "exact": exact,
                "prefix": prefix,
                "suffix": suffix,
            }
        )

    if color_changed:
        update_values["color"] = final_color

    try:
        stmt = update(Highlight).where(Highlight.id == highlight_id).values(**update_values)
        db.execute(stmt)

        if offsets_changed and highlight.fragment_id is not None:
            fa = highlight.fragment_anchor
            if fa is not None:
                fa.start_offset = final_start
                fa.end_offset = final_end
            else:
                new_fa = HighlightFragmentAnchor(
                    highlight_id=highlight_id,
                    fragment_id=highlight.fragment_id,
                    start_offset=final_start,
                    end_offset=final_end,
                )
                db.add(new_fa)

        db.flush()
        db.commit()
    except IntegrityError as e:
        db.rollback()
        raise map_integrity_error(e) from e

    db.refresh(highlight)
    return _highlight_to_typed_out(highlight, viewer_id)


def delete_highlight(db: Session, viewer_id: UUID, highlight_id: UUID) -> None:
    """Delete a highlight.

    NO ready check - allows cleanup even if media status drifts.
    Annotation is cascaded via FK ON DELETE CASCADE.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        highlight_id: The ID of the highlight to delete.

    Raises:
        NotFoundError(E_MEDIA_NOT_FOUND): If highlight doesn't exist, not owned, or not readable.
    """
    # Verify highlight exists and is owned by viewer
    get_highlight_for_author_write_or_404(db, viewer_id, highlight_id)

    # Use raw DELETE to let the database handle ON DELETE CASCADE properly
    # This avoids SQLAlchemy ORM trying to manage the annotation relationship
    db.execute(delete(Highlight).where(Highlight.id == highlight_id))
    db.flush()
    db.commit()


def upsert_annotation_for_highlight(
    db: Session, viewer_id: UUID, highlight_id: UUID, req: UpsertAnnotationRequest
) -> tuple[AnnotationOut, bool]:
    """Create or update the annotation for a highlight.

    Requires media ready.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        highlight_id: The ID of the highlight.
        req: The annotation upsert request.

    Returns:
        Tuple of (annotation, created) where created=True if inserted, False if updated.

    Raises:
        NotFoundError(E_MEDIA_NOT_FOUND): If highlight doesn't exist, not owned, or not readable.
        ApiError(E_MEDIA_NOT_READY): If media not in ready state.
    """
    # 1. Get highlight with ownership and readability check
    highlight = get_highlight_for_author_write_or_404(db, viewer_id, highlight_id)

    # 2. Require media ready via kernel-resolved media
    _require_media_ready_for_highlight(db, highlight)

    # 3. Check for existing annotation
    existing = db.query(Annotation).filter(Annotation.highlight_id == highlight_id).first()

    if existing:
        # Update existing
        stmt = (
            update(Annotation)
            .where(Annotation.highlight_id == highlight_id)
            .values(body=req.body, updated_at=func.now())
        )
        db.execute(stmt)
        db.flush()
        db.commit()
        db.refresh(existing)

        return (
            AnnotationOut(
                id=existing.id,
                highlight_id=existing.highlight_id,
                body=existing.body,
                created_at=existing.created_at,
                updated_at=existing.updated_at,
            ),
            False,
        )
    else:
        # Create new
        annotation = Annotation(
            highlight_id=highlight_id,
            body=req.body,
        )
        db.add(annotation)
        db.flush()
        db.commit()

        return (
            AnnotationOut(
                id=annotation.id,
                highlight_id=annotation.highlight_id,
                body=annotation.body,
                created_at=annotation.created_at,
                updated_at=annotation.updated_at,
            ),
            True,
        )


def delete_annotation_for_highlight(db: Session, viewer_id: UUID, highlight_id: UUID) -> None:
    """Delete the annotation for a highlight.

    NO ready check - allows cleanup even if media status drifts.
    Idempotent: returns 204 even if annotation doesn't exist.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        highlight_id: The ID of the highlight.

    Raises:
        NotFoundError(E_MEDIA_NOT_FOUND): If highlight doesn't exist, not owned, or not readable.
    """
    # Verify highlight ownership and readability (no ready check)
    get_highlight_for_author_write_or_404(db, viewer_id, highlight_id)

    # Delete annotation if exists (idempotent)
    db.execute(delete(Annotation).where(Annotation.highlight_id == highlight_id))
    db.flush()
    db.commit()
