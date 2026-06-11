"""PDF highlight create/list/update transactional orchestration.

Owns:
- Media/kind/readiness guards
- PDF payload guardrails and page_number validation
- Transactional write-time coherence across highlights + highlight_pdf_anchors + highlight_pdf_quads
- Advisory-lock duplicate race safety
- Write-time PDF match metadata + prefix/suffix storage
- Lock ordering from media coordination to duplicate detection
- Effective-state comparison and no-op detection
"""

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import delete, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media, highlight_visibility_filter
from nexus.db.models import (
    Highlight,
    HighlightPdfAnchor,
    HighlightPdfQuad,
    Media,
    PdfPageTextSpan,
)
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.logging import get_logger
from nexus.schemas.highlights import (
    CreatePdfHighlightRequest,
    PdfBoundsUpdate,
    TypedHighlightOut,
)
from nexus.services.capabilities import is_document_status_ready
from nexus.services.highlights import (
    project_highlight,
    project_highlights_with_links,
)
from nexus.services.pdf_highlight_geometry import (
    CanonicalGeometry,
    CanonicalQuad,
    GeometryValidationError,
    canonicalize_geometry,
    derive_duplicate_lock_key,
    validate_exact_length,
)
from nexus.services.pdf_locking import (
    acquire_ordered_locks,
    derive_media_coordination_lock_key,
)
from nexus.services.pdf_quote_match import MatcherAnomaly, compute_match
from nexus.services.pdf_quote_match_policy import (
    handle_recoverable_anomaly,
    handle_unclassified_exception,
    match_result_to_persistence_fields,
)
from nexus.services.resource_graph.refs import ResourceRef

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_pdf_media_for_viewer_or_404(db: Session, viewer_id: UUID, media_id: UUID) -> Media:
    """Load media, enforce visibility and kind=pdf."""
    media = db.get(Media, media_id)
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    if media.kind != "pdf":
        raise ApiError(ApiErrorCode.E_INVALID_KIND, "Operation requires PDF media")
    return media


def _validate_page_number(page_number: int, page_count: int | None) -> None:
    """Validate 1-based page number against media.page_count."""
    if page_count is None:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Media page count not available")
    if page_number < 1 or page_number > page_count:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"page_number must be 1..{page_count}, got {page_number}",
        )


def _get_page_span(db: Session, media_id: UUID, page_number: int) -> PdfPageTextSpan | None:
    """Load page text span for a given page."""
    return (
        db.query(PdfPageTextSpan)
        .filter(
            PdfPageTextSpan.media_id == media_id,
            PdfPageTextSpan.page_number == page_number,
        )
        .first()
    )


def _require_pdf_media_ready_or_409(media: Media) -> None:
    if not is_document_status_ready(media.processing_status.value):
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media not ready")


def _compute_write_time_match(
    db: Session,
    media: Media,
    page_number: int,
    exact: str,
    highlight_id: UUID | None,
) -> dict:
    """Compute write-time PDF match metadata + prefix/suffix.

    Returns dict with fields for highlight + pdf_anchor persistence.
    On quote-not-ready: returns pending fields.
    On matcher anomaly: returns pending fields with logging.
    On unclassified exception: raises.
    """
    from nexus.services.pdf_readiness import is_pdf_quote_text_ready

    if not is_pdf_quote_text_ready(db, media.id):
        return {
            "match_status": "pending",
            "start_offset": None,
            "end_offset": None,
            "prefix": "",
            "suffix": "",
        }

    page_span = _get_page_span(db, media.id, page_number)
    span_start = page_span.start_offset if page_span else None
    span_end = page_span.end_offset if page_span else None

    try:
        result = compute_match(
            exact=exact,
            page_number=page_number,
            plain_text=media.plain_text,
            page_span_start=span_start,
            page_span_end=span_end,
        )
    except MatcherAnomaly as anomaly:
        outcome = handle_recoverable_anomaly(
            anomaly,
            highlight_id=highlight_id,
            media_id=media.id,
            page_number=page_number,
            path="pdf_highlight_write",
        )
        return {
            "match_status": outcome.match_status,
            "start_offset": outcome.start_offset,
            "end_offset": outcome.end_offset,
            "prefix": outcome.prefix,
            "suffix": outcome.suffix,
        }
    except Exception as exc:
        handle_unclassified_exception(
            exc,
            highlight_id=highlight_id,
            media_id=media.id,
            page_number=page_number,
            path="pdf_highlight_write",
        )
        raise  # unreachable, handle_unclassified_exception always raises

    fields = match_result_to_persistence_fields(result)
    return {
        "match_status": fields["plain_text_match_status"],
        "start_offset": fields["plain_text_start_offset"],
        "end_offset": fields["plain_text_end_offset"],
        "prefix": result.prefix,
        "suffix": result.suffix,
    }


# ---------------------------------------------------------------------------
# Canonical effective-state comparison
# ---------------------------------------------------------------------------


def _stored_quads_match(
    stored_quads: list[HighlightPdfQuad],
    canonical_quads: tuple[CanonicalQuad, ...],
) -> bool:
    ordered_quads = sorted(stored_quads, key=lambda q: q.quad_idx)
    if len(ordered_quads) != len(canonical_quads):
        return False

    for stored, canonical in zip(ordered_quads, canonical_quads, strict=True):
        if (
            stored.x1 != canonical.x1
            or stored.y1 != canonical.y1
            or stored.x2 != canonical.x2
            or stored.y2 != canonical.y2
            or stored.x3 != canonical.x3
            or stored.y3 != canonical.y3
            or stored.x4 != canonical.x4
            or stored.y4 != canonical.y4
        ):
            return False
    return True


def _find_duplicate_pdf_anchor(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    canonical: CanonicalGeometry,
    exclude_highlight_id: UUID | None = None,
) -> HighlightPdfAnchor | None:
    query = (
        db.query(Highlight)
        .join(HighlightPdfAnchor, Highlight.id == HighlightPdfAnchor.highlight_id)
        .filter(
            Highlight.user_id == viewer_id,
            HighlightPdfAnchor.media_id == media_id,
            HighlightPdfAnchor.page_number == canonical.page_number,
            HighlightPdfAnchor.rect_count == canonical.rect_count,
        )
    )
    if exclude_highlight_id is not None:
        query = query.filter(Highlight.id != exclude_highlight_id)

    for candidate in query.all():
        if _stored_quads_match(candidate.pdf_quads, canonical.quads):
            return candidate.pdf_anchor
    return None


@dataclass(frozen=True, slots=True)
class EffectiveStateComparison:
    """Structured result of PDF PATCH effective-state comparison."""

    is_noop: bool
    requires_full_path: bool


def compare_effective_state(
    highlight: Highlight,
    canonical: CanonicalGeometry,
    new_exact: str,
    new_color: str | None,
) -> EffectiveStateComparison:
    """Canonical side-effect-free effective-state comparison.

    Returns is_noop=True only when all effective mutable fields are unchanged.
    Returns requires_full_path=True when safe equality cannot be proven.
    """
    pa = highlight.pdf_anchor
    if pa is None:
        return EffectiveStateComparison(is_noop=False, requires_full_path=True)

    if pa.page_number != canonical.page_number:
        return EffectiveStateComparison(is_noop=False, requires_full_path=False)

    if not _stored_quads_match(highlight.pdf_quads, canonical.quads):
        return EffectiveStateComparison(is_noop=False, requires_full_path=False)

    effective_color = new_color if new_color is not None else highlight.color
    if effective_color != highlight.color:
        return EffectiveStateComparison(is_noop=False, requires_full_path=False)

    if new_exact != highlight.exact:
        return EffectiveStateComparison(is_noop=False, requires_full_path=False)

    return EffectiveStateComparison(is_noop=True, requires_full_path=False)


# ---------------------------------------------------------------------------
# Service Functions
# ---------------------------------------------------------------------------


def create_pdf_highlight(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    req: CreatePdfHighlightRequest,
) -> TypedHighlightOut:
    """Create a PDF geometry highlight."""
    media = _get_pdf_media_for_viewer_or_404(db, viewer_id, media_id)
    _require_pdf_media_ready_or_409(media)
    _validate_page_number(req.page_number, media.page_count)

    try:
        validate_exact_length(req.exact)
    except GeometryValidationError as e:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, e.message) from e

    quads_dicts = [q.model_dump() for q in req.quads]
    try:
        canonical = canonicalize_geometry(req.page_number, quads_dicts)
    except GeometryValidationError as e:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, e.message) from e

    match_fields = _compute_write_time_match(db, media, req.page_number, req.exact, None)

    coord_key = derive_media_coordination_lock_key(media_id)
    dup_key = derive_duplicate_lock_key(
        viewer_id,
        media_id,
        canonical.page_number,
        canonical.quads,
    )
    acquire_ordered_locks(db, coord_key, dup_key)

    existing = _find_duplicate_pdf_anchor(db, viewer_id, media_id, canonical)
    if existing is not None:
        raise ApiError(ApiErrorCode.E_HIGHLIGHT_CONFLICT, "Duplicate PDF highlight")

    highlight = Highlight(
        user_id=viewer_id,
        anchor_kind="pdf_page_geometry",
        anchor_media_id=media_id,
        color=req.color,
        exact=req.exact,
        prefix=match_fields["prefix"],
        suffix=match_fields["suffix"],
    )
    db.add(highlight)
    db.flush()

    pdf_anchor = HighlightPdfAnchor(
        highlight_id=highlight.id,
        media_id=media_id,
        page_number=canonical.page_number,
        sort_top=canonical.sort_top,
        sort_left=canonical.sort_left,
        plain_text_match_status=match_fields["match_status"],
        plain_text_start_offset=match_fields["start_offset"],
        plain_text_end_offset=match_fields["end_offset"],
        rect_count=canonical.rect_count,
    )
    db.add(pdf_anchor)
    db.flush()

    for idx, cq in enumerate(canonical.quads):
        quad = HighlightPdfQuad(
            highlight_id=highlight.id,
            quad_idx=idx,
            x1=cq.x1,
            y1=cq.y1,
            x2=cq.x2,
            y2=cq.y2,
            x3=cq.x3,
            y3=cq.y3,
            x4=cq.x4,
            y4=cq.y4,
        )
        db.add(quad)

    db.flush()

    from nexus.services import synapse

    synapse.queue_synapse_scan(
        db,
        user_id=viewer_id,
        ref=ResourceRef(scheme="highlight", id=highlight.id),
        reason="highlight_create",
    )
    db.commit()

    db.refresh(highlight)
    return project_highlight(highlight, viewer_id)


def list_pdf_highlights(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    page_number: int,
    mine_only: bool = True,
) -> list[TypedHighlightOut]:
    """List PDF highlights for a single page."""
    media = _get_pdf_media_for_viewer_or_404(db, viewer_id, media_id)
    _validate_page_number(page_number, media.page_count)

    query = (
        db.query(Highlight)
        .join(HighlightPdfAnchor, Highlight.id == HighlightPdfAnchor.highlight_id)
        .filter(
            HighlightPdfAnchor.media_id == media_id,
            HighlightPdfAnchor.page_number == page_number,
            Highlight.anchor_kind == "pdf_page_geometry",
        )
    )

    if mine_only:
        query = query.filter(Highlight.user_id == viewer_id)
    else:
        query = query.filter(highlight_visibility_filter(viewer_id, media_id))

    highlights = query.order_by(
        HighlightPdfAnchor.sort_top.asc(),
        HighlightPdfAnchor.sort_left.asc(),
        Highlight.created_at.asc(),
        Highlight.id.asc(),
    ).all()

    return project_highlights_with_links(db, viewer_id, highlights)


def update_pdf_highlight_bounds(
    db: Session,
    viewer_id: UUID,
    highlight: Highlight,
    bounds: PdfBoundsUpdate,
    new_color: str | None,
) -> TypedHighlightOut:
    """Replace PDF highlight geometry and optionally update color.

    Caller must have already verified ownership + media readability.
    """
    media = db.get(Media, highlight.anchor_media_id)
    if media is None or media.kind != "pdf":
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")

    _require_pdf_media_ready_or_409(media)
    _validate_page_number(bounds.page_number, media.page_count)

    try:
        validate_exact_length(bounds.exact)
    except GeometryValidationError as e:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, e.message) from e

    quads_dicts = [q.model_dump() for q in bounds.quads]
    try:
        canonical = canonicalize_geometry(bounds.page_number, quads_dicts)
    except GeometryValidationError as e:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, e.message) from e

    # Pre-lock no-op short circuit with row lock.
    db.execute(
        text("SELECT id FROM highlights WHERE id = :hid FOR UPDATE"),
        {"hid": highlight.id},
    )
    comparison = compare_effective_state(highlight, canonical, bounds.exact, new_color)

    if comparison.is_noop:
        return project_highlight(highlight, viewer_id)

    match_fields = _compute_write_time_match(
        db,
        media,
        canonical.page_number,
        bounds.exact,
        highlight.id,
    )

    coord_key = derive_media_coordination_lock_key(highlight.anchor_media_id)
    dup_key = derive_duplicate_lock_key(
        viewer_id,
        highlight.anchor_media_id,
        canonical.page_number,
        canonical.quads,
    )
    acquire_ordered_locks(db, coord_key, dup_key)

    dup = _find_duplicate_pdf_anchor(
        db,
        viewer_id,
        highlight.anchor_media_id,
        canonical,
        exclude_highlight_id=highlight.id,
    )
    if dup is not None:
        raise ApiError(ApiErrorCode.E_HIGHLIGHT_CONFLICT, "Duplicate PDF highlight")

    # Post-lock no-op recheck using the same comparison helper.
    post_comparison = compare_effective_state(highlight, canonical, bounds.exact, new_color)
    if post_comparison.is_noop:
        return project_highlight(highlight, viewer_id)

    # Apply updates
    effective_color = new_color if new_color is not None else highlight.color
    highlight.color = effective_color
    highlight.exact = bounds.exact
    highlight.prefix = match_fields["prefix"]
    highlight.suffix = match_fields["suffix"]

    from sqlalchemy import func

    highlight.updated_at = func.now()

    pa = highlight.pdf_anchor
    pa.page_number = canonical.page_number
    pa.sort_top = canonical.sort_top
    pa.sort_left = canonical.sort_left
    pa.rect_count = canonical.rect_count
    pa.plain_text_match_status = match_fields["match_status"]
    pa.plain_text_start_offset = match_fields["start_offset"]
    pa.plain_text_end_offset = match_fields["end_offset"]

    db.execute(delete(HighlightPdfQuad).where(HighlightPdfQuad.highlight_id == highlight.id))

    for idx, cq in enumerate(canonical.quads):
        quad = HighlightPdfQuad(
            highlight_id=highlight.id,
            quad_idx=idx,
            x1=cq.x1,
            y1=cq.y1,
            x2=cq.x2,
            y2=cq.y2,
            x3=cq.x3,
            y3=cq.y3,
            x4=cq.x4,
            y4=cq.y4,
        )
        db.add(quad)

    db.flush()
    db.commit()

    db.refresh(highlight)
    return project_highlight(highlight, viewer_id)
