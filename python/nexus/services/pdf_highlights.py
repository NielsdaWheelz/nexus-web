"""PDF highlight create/list/update transactional orchestration (S6 PR-04).

Owns:
- Media/kind/ready guards (reuses visibility and PR-03 readiness semantics)
- S6 payload guardrails and page_number validation
- Transactional write-time coherence across highlights + highlight_pdf_anchors + highlight_pdf_quads
- D02 advisory-lock duplicate race safety
- D06 write-time PDF match metadata + prefix/suffix storage
- D09 lock ordering (media coordination -> duplicate)
- D17/D18/D19/D20 effective-state comparison and no-op detection
"""

import base64
import json
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import and_, delete, or_, select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media, highlight_visibility_filter
from nexus.db.models import (
    Annotation,
    Conversation,
    Highlight,
    HighlightPdfAnchor,
    HighlightPdfQuad,
    Media,
    Message,
    MessageContext,
    PdfPageTextSpan,
)
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.logging import get_logger
from nexus.schemas.highlights import (
    AnnotationOut,
    CreatePdfHighlightRequest,
    LinkedConversationRef,
    MediaHighlightPageInfoOut,
    PdfAnchorOut,
    PdfBoundsUpdate,
    PdfQuadOut,
    TypedHighlightOut,
)
from nexus.services.pdf_highlight_geometry import (
    CanonicalGeometry,
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

logger = get_logger(__name__)

READY_STATUSES: set[str] = {"ready_for_reading", "embedding", "ready"}


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


def _require_pdf_ready(media: Media) -> None:
    """Require media in mutation-ready state for PDF highlight writes."""
    if media.processing_status.value not in READY_STATUSES:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media not ready")


def _validate_page_number(page_number: int, page_count: int | None) -> None:
    """Validate 1-based page number against media.page_count."""
    if page_count is None:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Media page count not available")
    if page_number < 1 or page_number > page_count:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"page_number must be 1..{page_count}, got {page_number}",
        )


def _annotation_out(ann: Annotation | None) -> AnnotationOut | None:
    if ann is None:
        return None
    return AnnotationOut(
        id=ann.id,
        highlight_id=ann.highlight_id,
        body=ann.body,
        created_at=ann.created_at,
        updated_at=ann.updated_at,
    )


def _batch_linked_conversations(
    db: Session, highlight_ids: list[UUID], viewer_id: UUID
) -> dict[UUID, list[LinkedConversationRef]]:
    if not highlight_ids:
        return {}
    rows = db.execute(
        select(
            MessageContext.highlight_id,
            Conversation.id,
            Conversation.title,
        )
        .join(Message, Message.id == MessageContext.message_id)
        .join(Conversation, Conversation.id == Message.conversation_id)
        .where(
            MessageContext.target_type == "highlight",
            MessageContext.highlight_id.in_(highlight_ids),
            Conversation.owner_user_id == viewer_id,
        )
        .group_by(MessageContext.highlight_id, Conversation.id, Conversation.title)
    ).all()
    result: dict[UUID, list[LinkedConversationRef]] = {}
    for highlight_id, conversation_id, title in rows:
        result.setdefault(highlight_id, []).append(
            LinkedConversationRef(conversation_id=conversation_id, title=title)
        )
    return result


def _highlight_to_typed_out(
    highlight: Highlight,
    viewer_id: UUID,
) -> TypedHighlightOut:
    """Convert a PDF highlight ORM to TypedHighlightOut."""
    pa = highlight.pdf_anchor
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
        media_id=pa.media_id if pa else highlight.anchor_media_id,
        page_number=pa.page_number if pa else 0,
        quads=quads_out,
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
        annotation=_annotation_out(highlight.annotation),
        author_user_id=highlight.user_id,
        is_owner=(highlight.user_id == viewer_id),
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
            "match_version": None,
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
            "match_version": outcome.match_version,
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
        "match_version": fields["plain_text_match_version"],
        "start_offset": fields["plain_text_start_offset"],
        "end_offset": fields["plain_text_end_offset"],
        "prefix": result.prefix,
        "suffix": result.suffix,
    }


def encode_pdf_highlights_index_cursor(
    page_number: int,
    sort_top: Decimal,
    sort_left: Decimal,
    created_at: datetime,
    highlight_id: UUID,
) -> str:
    """Encode keyset cursor for document-wide PDF highlight index listing."""
    payload = {
        "page_number": page_number,
        "sort_top": str(sort_top),
        "sort_left": str(sort_left),
        "created_at": created_at.isoformat(),
        "id": str(highlight_id),
    }
    json_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(json_bytes).decode("utf-8").rstrip("=")


def decode_pdf_highlights_index_cursor(cursor: str) -> tuple[int, Decimal, Decimal, datetime, UUID]:
    """Decode keyset cursor for document-wide PDF highlight index listing."""
    try:
        padding = 4 - len(cursor) % 4
        if padding < 4:
            cursor += "=" * padding
        json_bytes = base64.urlsafe_b64decode(cursor)
        payload = json.loads(json_bytes.decode("utf-8"))

        page_number = int(payload["page_number"])
        sort_top = Decimal(payload["sort_top"])
        sort_left = Decimal(payload["sort_left"])
        created_at = datetime.fromisoformat(payload["created_at"])
        highlight_id = UUID(payload["id"])
    except Exception:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from None

    if page_number < 1:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor")

    return page_number, sort_top, sort_left, created_at, highlight_id


# ---------------------------------------------------------------------------
# D20: Canonical effective-state comparison
# ---------------------------------------------------------------------------


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
    """D20: Canonical side-effect-free effective-state comparison.

    Returns is_noop=True only when all effective mutable fields are unchanged.
    Returns requires_full_path=True when safe equality cannot be proven.
    """
    pa = highlight.pdf_anchor
    if pa is None:
        return EffectiveStateComparison(is_noop=False, requires_full_path=True)

    if pa.geometry_fingerprint != canonical.fingerprint:
        return EffectiveStateComparison(is_noop=False, requires_full_path=False)

    effective_color = new_color if new_color is not None else highlight.color
    if effective_color != highlight.color:
        return EffectiveStateComparison(is_noop=False, requires_full_path=False)

    if new_exact != highlight.exact:
        return EffectiveStateComparison(is_noop=False, requires_full_path=False)

    if pa.page_number != canonical.page_number:
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
    _require_pdf_ready(media)
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
        canonical.geometry_version,
        canonical.fingerprint,
    )
    acquire_ordered_locks(db, coord_key, dup_key)

    existing = (
        db.query(HighlightPdfAnchor)
        .join(Highlight, Highlight.id == HighlightPdfAnchor.highlight_id)
        .filter(
            Highlight.user_id == viewer_id,
            HighlightPdfAnchor.media_id == media_id,
            HighlightPdfAnchor.page_number == canonical.page_number,
            HighlightPdfAnchor.geometry_version == canonical.geometry_version,
            HighlightPdfAnchor.geometry_fingerprint == canonical.fingerprint,
        )
        .first()
    )
    if existing is not None:
        raise ApiError(ApiErrorCode.E_HIGHLIGHT_CONFLICT, "Duplicate PDF highlight")

    highlight = Highlight(
        user_id=viewer_id,
        fragment_id=None,
        start_offset=None,
        end_offset=None,
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
        geometry_version=canonical.geometry_version,
        geometry_fingerprint=canonical.fingerprint,
        sort_top=canonical.sort_top,
        sort_left=canonical.sort_left,
        plain_text_match_version=match_fields["match_version"],
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
    db.commit()

    db.refresh(highlight)
    return _highlight_to_typed_out(highlight, viewer_id)


def list_pdf_highlights(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    page_number: int,
    mine_only: bool = True,
) -> list[TypedHighlightOut]:
    """List PDF highlights for a single page."""
    media = _get_pdf_media_for_viewer_or_404(db, viewer_id, media_id)

    if media.processing_status.value not in READY_STATUSES:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media not ready")

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

    linked_conversations_by_highlight = _batch_linked_conversations(
        db, [highlight.id for highlight in highlights], viewer_id
    )
    results = []
    for highlight in highlights:
        out = _highlight_to_typed_out(highlight, viewer_id)
        out.linked_conversations = linked_conversations_by_highlight.get(highlight.id, [])
        results.append(out)
    return results


def list_pdf_highlights_index(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    limit: int = 50,
    cursor: str | None = None,
    mine_only: bool = True,
) -> tuple[list[TypedHighlightOut], MediaHighlightPageInfoOut]:
    """List PDF highlights across the full document with keyset pagination."""
    media = _get_pdf_media_for_viewer_or_404(db, viewer_id, media_id)

    if media.processing_status.value not in READY_STATUSES:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media not ready")

    query = (
        db.query(Highlight, HighlightPdfAnchor)
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

    if cursor:
        (
            cursor_page_number,
            cursor_sort_top,
            cursor_sort_left,
            cursor_created_at,
            cursor_highlight_id,
        ) = decode_pdf_highlights_index_cursor(cursor)
        query = query.filter(
            or_(
                HighlightPdfAnchor.page_number > cursor_page_number,
                and_(
                    HighlightPdfAnchor.page_number == cursor_page_number,
                    HighlightPdfAnchor.sort_top > cursor_sort_top,
                ),
                and_(
                    HighlightPdfAnchor.page_number == cursor_page_number,
                    HighlightPdfAnchor.sort_top == cursor_sort_top,
                    HighlightPdfAnchor.sort_left > cursor_sort_left,
                ),
                and_(
                    HighlightPdfAnchor.page_number == cursor_page_number,
                    HighlightPdfAnchor.sort_top == cursor_sort_top,
                    HighlightPdfAnchor.sort_left == cursor_sort_left,
                    Highlight.created_at > cursor_created_at,
                ),
                and_(
                    HighlightPdfAnchor.page_number == cursor_page_number,
                    HighlightPdfAnchor.sort_top == cursor_sort_top,
                    HighlightPdfAnchor.sort_left == cursor_sort_left,
                    Highlight.created_at == cursor_created_at,
                    Highlight.id > cursor_highlight_id,
                ),
            )
        )

    rows = (
        query.order_by(
            HighlightPdfAnchor.page_number.asc(),
            HighlightPdfAnchor.sort_top.asc(),
            HighlightPdfAnchor.sort_left.asc(),
            Highlight.created_at.asc(),
            Highlight.id.asc(),
        )
        .limit(limit + 1)
        .all()
    )

    has_more = len(rows) > limit
    if has_more:
        rows = rows[:limit]

    linked_conversations_by_highlight = _batch_linked_conversations(
        db, [highlight.id for highlight, _anchor in rows], viewer_id
    )
    highlights_out = []
    for highlight, _anchor in rows:
        out = _highlight_to_typed_out(highlight, viewer_id)
        out.linked_conversations = linked_conversations_by_highlight.get(highlight.id, [])
        highlights_out.append(out)

    next_cursor = None
    if has_more and rows:
        last_highlight, last_anchor = rows[-1]
        next_cursor = encode_pdf_highlights_index_cursor(
            page_number=int(last_anchor.page_number),
            sort_top=last_anchor.sort_top,
            sort_left=last_anchor.sort_left,
            created_at=last_highlight.created_at,
            highlight_id=last_highlight.id,
        )

    return highlights_out, MediaHighlightPageInfoOut(has_more=has_more, next_cursor=next_cursor)


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

    _require_pdf_ready(media)
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

    # D19/D20: pre-lock no-op short circuit with row lock
    db.execute(
        text("SELECT id FROM highlights WHERE id = :hid FOR UPDATE"),
        {"hid": highlight.id},
    )
    comparison = compare_effective_state(highlight, canonical, bounds.exact, new_color)

    if comparison.is_noop:
        return _highlight_to_typed_out(highlight, viewer_id)

    if comparison.requires_full_path:
        pass  # fall through to normal D09 path

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
        canonical.geometry_version,
        canonical.fingerprint,
    )
    acquire_ordered_locks(db, coord_key, dup_key)

    # D17: duplicate check excludes self
    dup = (
        db.query(HighlightPdfAnchor)
        .join(Highlight, Highlight.id == HighlightPdfAnchor.highlight_id)
        .filter(
            Highlight.user_id == viewer_id,
            HighlightPdfAnchor.media_id == highlight.anchor_media_id,
            HighlightPdfAnchor.page_number == canonical.page_number,
            HighlightPdfAnchor.geometry_version == canonical.geometry_version,
            HighlightPdfAnchor.geometry_fingerprint == canonical.fingerprint,
            Highlight.id != highlight.id,
        )
        .first()
    )
    if dup is not None:
        raise ApiError(ApiErrorCode.E_HIGHLIGHT_CONFLICT, "Duplicate PDF highlight")

    # Post-lock D18 no-op recheck using same comparison helper
    post_comparison = compare_effective_state(highlight, canonical, bounds.exact, new_color)
    if post_comparison.is_noop:
        return _highlight_to_typed_out(highlight, viewer_id)

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
    pa.geometry_version = canonical.geometry_version
    pa.geometry_fingerprint = canonical.fingerprint
    pa.sort_top = canonical.sort_top
    pa.sort_left = canonical.sort_left
    pa.rect_count = canonical.rect_count
    pa.plain_text_match_status = match_fields["match_status"]
    pa.plain_text_match_version = match_fields["match_version"]
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
    return _highlight_to_typed_out(highlight, viewer_id)
