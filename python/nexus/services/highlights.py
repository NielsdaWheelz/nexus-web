"""Highlight and Annotation service layer.

Implements highlight + annotation CRUD for web article fragments per Slice 2 L2 spec.

All operations:
- Enforce owner-only access + can_read_media visibility
- Use E_MEDIA_NOT_FOUND consistently for all 404s (prevent probing attacks)
- Require media ready status for create/update/upsert mutations
- Allow list/get/delete operations even if media status drifts

Service functions correspond 1:1 with route handlers.
Routes are transport-only and call exactly one service function.
"""

from uuid import UUID

from sqlalchemy import delete, func, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_highlight, can_read_media, highlight_visibility_filter
from nexus.db.models import Annotation, Fragment, Highlight
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.logging import get_logger
from nexus.schemas.highlights import (
    AnnotationOut,
    CreateHighlightRequest,
    HighlightOut,
    UpdateHighlightRequest,
    UpsertAnnotationRequest,
)

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
        ):
            if name in msg:
                constraint_name = name
                break

    if constraint_name == "uix_highlights_user_fragment_offsets":
        return ApiError(ApiErrorCode.E_HIGHLIGHT_CONFLICT, "Highlight already exists at this range")
    if constraint_name in ("ck_highlights_offsets_valid", "ck_highlights_color"):
        return ApiError(ApiErrorCode.E_INVALID_REQUEST, "Invalid highlight data")

    # Unknown constraint — internal error
    logger.error("unknown_integrity_error", constraint=constraint_name, error=str(e))
    return ApiError(ApiErrorCode.E_INTERNAL, "Database constraint violation")


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

    Raises:
        NotFoundError(E_MEDIA_NOT_FOUND): If highlight doesn't exist, not authored by viewer,
            or media not readable.
    """
    highlight = db.get(Highlight, highlight_id)
    if highlight is None or highlight.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    if not can_read_media(db, viewer_id, highlight.fragment.media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    return highlight  # highlight.fragment.media and highlight.annotation available


def _highlight_to_out(highlight: Highlight, viewer_id: UUID) -> HighlightOut:
    """Convert Highlight ORM model to HighlightOut schema.

    Args:
        highlight: The ORM highlight instance.
        viewer_id: The current viewer's user ID (for is_owner computation).
    """
    annotation_out = None
    if highlight.annotation is not None:
        annotation_out = AnnotationOut(
            id=highlight.annotation.id,
            highlight_id=highlight.annotation.highlight_id,
            body=highlight.annotation.body,
            created_at=highlight.annotation.created_at,
            updated_at=highlight.annotation.updated_at,
        )

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
        annotation=annotation_out,
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

    # 5. Create highlight
    highlight = Highlight(
        user_id=viewer_id,
        fragment_id=fragment_id,
        start_offset=req.start_offset,
        end_offset=req.end_offset,
        color=req.color,
        exact=exact,
        prefix=prefix,
        suffix=suffix,
    )

    # 6. Persist with integrity error handling
    try:
        db.add(highlight)
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


def get_highlight(db: Session, viewer_id: UUID, highlight_id: UUID) -> HighlightOut:
    """Get a single highlight by ID.

    NO ready check - read-only operation.
    Visible to shared readers under s4 canonical predicate.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        highlight_id: The ID of the highlight.

    Returns:
        The highlight including annotation if present.

    Raises:
        NotFoundError(E_MEDIA_NOT_FOUND): If highlight doesn't exist or not visible.
    """
    highlight = get_highlight_for_visible_read_or_404(db, viewer_id, highlight_id)
    return _highlight_to_out(highlight, viewer_id)


def update_highlight(
    db: Session, viewer_id: UUID, highlight_id: UUID, req: UpdateHighlightRequest
) -> HighlightOut:
    """Update a highlight.

    Requires media ready if offsets are being changed.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        highlight_id: The ID of the highlight to update.
        req: The update request (all fields optional).

    Returns:
        The updated highlight.

    Raises:
        NotFoundError(E_MEDIA_NOT_FOUND): If highlight doesn't exist, not owned, or not readable.
        ApiError(E_MEDIA_NOT_READY): If media not in ready state and offsets changed.
        ApiError(E_HIGHLIGHT_INVALID_RANGE): If new offsets out of bounds.
        ApiError(E_HIGHLIGHT_CONFLICT): If new offsets conflict with existing highlight.
    """
    # 1. Get highlight with ownership and readability check
    highlight = get_highlight_for_author_write_or_404(db, viewer_id, highlight_id)

    # 2. Require media ready for any mutation
    require_media_ready_or_409(highlight.fragment.media.processing_status.value)

    # 3. Compute final offsets
    final_start = req.start_offset if req.start_offset is not None else highlight.start_offset
    final_end = req.end_offset if req.end_offset is not None else highlight.end_offset
    final_color = req.color if req.color is not None else highlight.color

    # 4. Check if anything changed
    offsets_changed = final_start != highlight.start_offset or final_end != highlight.end_offset
    color_changed = final_color != highlight.color

    if not offsets_changed and not color_changed:
        # Nothing to update, return current state
        return _highlight_to_out(highlight, viewer_id)

    # 5. Build update values
    update_values: dict = {"updated_at": func.now()}

    if offsets_changed:
        # Validate new offsets
        validate_offsets_or_400(highlight.fragment.canonical_text, final_start, final_end)

        # Re-derive exact/prefix/suffix
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

    # 6. Execute update
    try:
        stmt = update(Highlight).where(Highlight.id == highlight_id).values(**update_values)
        db.execute(stmt)
        db.flush()
        db.commit()
    except IntegrityError as e:
        db.rollback()
        raise map_integrity_error(e) from e

    # 7. Refresh and return
    db.refresh(highlight)
    return _highlight_to_out(highlight, viewer_id)


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

    # 2. Require media ready
    require_media_ready_or_409(highlight.fragment.media.processing_status.value)

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
