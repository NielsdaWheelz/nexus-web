"""PDF highlight create/update: geometry, duplicates, and quote context."""

from uuid import UUID, uuid4

from sqlalchemy import delete, func, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import (
    Highlight,
    HighlightPdfAnchor,
    HighlightPdfQuad,
    Media,
    PdfPageTextSpan,
)
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.highlights import (
    PdfBoundsUpdate,
    PdfHighlightAnchorIn,
    TypedHighlightOut,
)
from nexus.services.capabilities import is_document_status_ready
from nexus.services.highlights import (
    project_highlight,
    require_pdf_highlight_or_404,
)
from nexus.services.pdf_highlight_geometry import (
    CanonicalGeometry,
    CanonicalQuad,
    GeometryValidationError,
    canonicalize_geometry,
    validate_exact_length,
)
from nexus.services.pdf_readiness import is_pdf_quote_text_ready
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.text_quote import PREFIX_SUFFIX_WINDOW


def create_pdf_highlight(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    anchor: PdfHighlightAnchorIn,
    color: str,
) -> TypedHighlightOut:
    highlight = create_pdf_highlight_in_txn(
        db,
        viewer_id=viewer_id,
        highlight_id=uuid4(),
        media_id=media_id,
        page_number=anchor.page_number,
        quads=[quad.model_dump() for quad in anchor.quads],
        exact=anchor.exact,
        color=color,
    )
    db.commit()
    db.refresh(highlight)
    return project_highlight(highlight, viewer_id)


def create_pdf_highlight_in_txn(
    db: Session,
    *,
    viewer_id: UUID,
    highlight_id: UUID,
    media_id: UUID,
    page_number: int,
    quads: list,
    exact: str,
    color: str,
) -> Highlight:
    """Create a PDF geometry highlight with a client-stable id; flush-only.

    Composes inside the caller's retryable transaction: it never commits, and a
    first-insert race on ``highlights_pkey`` is left to the caller's retry
    allowlist. Reusing the client-stable id for a *different* selection is
    ``E_HIGHLIGHT_CONFLICT``; reusing it for the same page and quads returns the
    existing row so an in-flight retry converges.
    """
    media = _require_readable_pdf(db, viewer_id, media_id)
    _require_ready(media)
    _validate_page_number(page_number, media.page_count)
    try:
        validate_exact_length(exact)
        canonical = canonicalize_geometry(page_number, [dict(quad) for quad in quads])
    except GeometryValidationError as exc:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, exc.message) from exc

    existing = db.get(Highlight, highlight_id)
    if existing is not None:
        anchor = existing.pdf_anchor
        if (
            existing.user_id != viewer_id
            or existing.anchor_kind != "pdf_page_geometry"
            or anchor is None
            or anchor.media_id != media_id
            or anchor.page_number != canonical.page_number
            or not _stored_quads_match(existing.pdf_quads, canonical.quads)
        ):
            raise ApiError(
                ApiErrorCode.E_HIGHLIGHT_CONFLICT, "Highlight id names a different selection"
            )
        return existing

    prefix, suffix = _quote_context(db, media, page_number, exact)
    _lock_duplicate_selection(db, viewer_id, media_id, canonical)
    if _find_duplicate_pdf_anchor(db, viewer_id, media_id, canonical) is not None:
        raise ApiError(ApiErrorCode.E_HIGHLIGHT_CONFLICT, "Duplicate PDF highlight")

    highlight = Highlight(
        id=highlight_id,
        user_id=viewer_id,
        anchor_kind="pdf_page_geometry",
        anchor_media_id=media_id,
        color=color,
        exact=exact,
        prefix=prefix,
        suffix=suffix,
    )
    db.add(highlight)
    db.flush()
    db.add(
        HighlightPdfAnchor(
            highlight_id=highlight.id,
            media_id=media_id,
            page_number=canonical.page_number,
            sort_top=canonical.sort_top,
            sort_left=canonical.sort_left,
            rect_count=canonical.rect_count,
        )
    )
    db.flush()
    _write_quads(db, highlight.id, canonical)
    db.flush()

    from nexus.services import connection_discovery

    connection_discovery.queue_connection_discovery_scan(
        db,
        user_id=viewer_id,
        ref=ResourceRef(scheme="highlight", id=highlight.id),
        reason="highlight_create",
    )
    return highlight


def update_pdf_highlight_bounds(
    db: Session,
    viewer_id: UUID,
    highlight: Highlight,
    bounds: PdfBoundsUpdate,
    new_color: str | None,
) -> TypedHighlightOut:
    """Replace geometry and optionally colour; the caller has verified ownership."""
    anchor = require_pdf_highlight_or_404(highlight)
    media = db.get(Media, highlight.anchor_media_id)
    if media is None or media.kind != "pdf":
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    _require_ready(media)
    _validate_page_number(bounds.page_number, media.page_count)
    try:
        validate_exact_length(bounds.exact)
        canonical = canonicalize_geometry(
            bounds.page_number, [quad.model_dump() for quad in bounds.quads]
        )
    except GeometryValidationError as exc:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, exc.message) from exc

    # Pre-lock no-op short circuit with row lock.
    db.execute(text("SELECT id FROM highlights WHERE id = :hid FOR UPDATE"), {"hid": highlight.id})
    effective_color = new_color if new_color is not None else highlight.color
    if (
        anchor.page_number == canonical.page_number
        and _stored_quads_match(highlight.pdf_quads, canonical.quads)
        and effective_color == highlight.color
        and bounds.exact == highlight.exact
    ):
        return project_highlight(highlight, viewer_id)

    prefix, suffix = _quote_context(db, media, canonical.page_number, bounds.exact)
    _lock_duplicate_selection(db, viewer_id, media.id, canonical)
    if (
        _find_duplicate_pdf_anchor(
            db, viewer_id, media.id, canonical, exclude_highlight_id=highlight.id
        )
        is not None
    ):
        raise ApiError(ApiErrorCode.E_HIGHLIGHT_CONFLICT, "Duplicate PDF highlight")

    highlight.color = effective_color
    highlight.exact = bounds.exact
    highlight.prefix, highlight.suffix = prefix, suffix
    highlight.updated_at = func.now()
    anchor.page_number = canonical.page_number
    anchor.sort_top = canonical.sort_top
    anchor.sort_left = canonical.sort_left
    anchor.rect_count = canonical.rect_count
    db.execute(delete(HighlightPdfQuad).where(HighlightPdfQuad.highlight_id == highlight.id))
    _write_quads(db, highlight.id, canonical)
    db.flush()
    db.commit()
    db.refresh(highlight)
    return project_highlight(highlight, viewer_id)


def _require_readable_pdf(db: Session, viewer_id: UUID, media_id: UUID) -> Media:
    media = db.get(Media, media_id)
    if media is None or not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    if media.kind != "pdf":
        raise ApiError(ApiErrorCode.E_INVALID_KIND, "Operation requires PDF media")
    return media


def _require_ready(media: Media) -> None:
    if not is_document_status_ready(media.processing_status.value):
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media not ready")


def _validate_page_number(page_number: int, page_count: int | None) -> None:
    if page_count is None:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Media page count not available")
    if page_number < 1 or page_number > page_count:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"page_number must be 1..{page_count}, got {page_number}",
        )


def _write_quads(db: Session, highlight_id: UUID, canonical: CanonicalGeometry) -> None:
    for index, quad in enumerate(canonical.quads):
        db.add(
            HighlightPdfQuad(
                highlight_id=highlight_id,
                quad_idx=index,
                x1=quad.x1,
                y1=quad.y1,
                x2=quad.x2,
                y2=quad.y2,
                x3=quad.x3,
                y3=quad.y3,
                x4=quad.x4,
                y4=quad.y4,
            )
        )


def _quote_context(db: Session, media: Media, page_number: int, exact: str) -> tuple[str, str]:
    """64 codepoints of `media.plain_text` either side of `exact` when it occurs once on
    its page (in the whole text when the page has no span); ("", "") otherwise."""
    plain_text = media.plain_text
    if plain_text is None or not exact or not is_pdf_quote_text_ready(db, media.id):
        return "", ""
    span = (
        db.query(PdfPageTextSpan)
        .filter(
            PdfPageTextSpan.media_id == media.id,
            PdfPageTextSpan.page_number == page_number,
        )
        .first()
    )
    base = span.start_offset if span is not None else 0
    haystack = plain_text[span.start_offset : span.end_offset] if span is not None else plain_text
    first = haystack.find(exact)
    if first == -1 or haystack.find(exact, first + 1) != -1:
        return "", ""
    start = base + first
    end = start + len(exact)
    return (
        plain_text[max(0, start - PREFIX_SUFFIX_WINDOW) : start],
        plain_text[end : end + PREFIX_SUFFIX_WINDOW],
    )


def _stored_quads_match(
    stored_quads: list[HighlightPdfQuad], canonical_quads: tuple[CanonicalQuad, ...]
) -> bool:
    ordered = sorted(stored_quads, key=lambda quad: quad.quad_idx)
    if len(ordered) != len(canonical_quads):
        return False
    return all(
        (stored.x1, stored.y1, stored.x2, stored.y2, stored.x3, stored.y3, stored.x4, stored.y4)
        == (
            canonical.x1,
            canonical.y1,
            canonical.x2,
            canonical.y2,
            canonical.x3,
            canonical.y3,
            canonical.x4,
            canonical.y4,
        )
        for stored, canonical in zip(ordered, canonical_quads, strict=True)
    )


def _lock_duplicate_selection(
    db: Session, viewer_id: UUID, media_id: UUID, canonical: CanonicalGeometry
) -> None:
    """Serialize duplicate detection for one viewer's exact selection."""
    quads = ";".join(
        f"{quad.x1},{quad.y1},{quad.x2},{quad.y2},{quad.x3},{quad.y3},{quad.x4},{quad.y4}"
        for quad in canonical.quads
    )
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"pdf_dup:{viewer_id}:{media_id}:{canonical.page_number}:{quads}"},
    )


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
