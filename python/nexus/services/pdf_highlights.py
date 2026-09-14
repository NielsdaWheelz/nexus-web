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

import json
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import delete, select, text, tuple_
from sqlalchemy.orm import Session, selectinload

from nexus.auth.permissions import highlight_visibility_filter
from nexus.config import ReaderPublicationLimits
from nexus.db.models import (
    Highlight,
    HighlightPdfAnchor,
    HighlightPdfQuad,
)
from nexus.errors import ApiError, ApiErrorCode, NotFoundError, ReaderContentTooLargeError
from nexus.schemas.highlights import (
    CreatePdfHighlightRequest,
    PdfBoundsUpdate,
    PdfHighlightPaint,
    PdfHighlightPaintPage,
    PdfQuadOut,
    TypedHighlightOut,
)
from nexus.services.highlight_access import get_highlight_for_author_write_or_404
from nexus.services.highlights import (
    project_highlight,
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
from nexus.services.reader_publication_read import get_reader_publication_pdf_source_for_viewer
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.signed_keyset_cursor import (
    KeysetValue,
    KeysetValueKind,
    decode_signed_keyset_cursor,
    encode_signed_keyset_cursor,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _validate_page_number(page_number: int, page_count: int | None) -> None:
    """Validate 1-based page number against media.page_count."""
    if page_count is None:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Media page count not available")
    if page_number < 1 or page_number > page_count:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"page_number must be 1..{page_count}, got {page_number}",
        )


_PDF_SEARCH_SOURCE = """
        FROM reader_publication_search_sources s
        WHERE s.media_id = :media AND s.generation = :generation
          AND s.source_ordinal = 0 AND s.fragment_id IS NULL
"""


def _compute_write_time_match(
    db: Session, media_id: UUID, generation: int, page_number: int, exact: str
) -> dict:
    """Match raw selected-source text in PostgreSQL; return only scalar geometry.

    Only the page slice and two 64-code-point context windows leave their SQL
    source expressions. PostgreSQL may still detoast the complete source while
    extracting a deep page; database memory and work remain qualification costs.

    A present empty page span never falls back to the whole document. The first
    two overlapping literal occurrences suffice to distinguish unique/ambiguous.
    The stored readiness flag owns pending; it is separate from match status.
    """
    row = (
        db.execute(
            text(f"""
        WITH extent AS MATERIALIZED (
            SELECT s.pdf_quote_text_ready,
                   COALESCE((s.pdf_page_spans -> (:page - 1) ->> 1)::integer, 0) AS lo,
                   COALESCE((s.pdf_page_spans -> (:page - 1) ->> 2)::integer, s.raw_codepoints)
                       AS hi
            {_PDF_SEARCH_SOURCE}
        ), page_slice AS (
            SELECT extent.lo, extent.pdf_quote_text_ready,
                   (SELECT substring(s.canonical_text FROM extent.lo + 1 FOR extent.hi - extent.lo)
                    {_PDF_SEARCH_SOURCE}) AS page_text
            FROM extent
        ), located AS MATERIALIZED (
            SELECT lo, pdf_quote_text_ready, page_text,
                   CASE WHEN pdf_quote_text_ready AND :exact <> ''
                       THEN strpos(page_text COLLATE "C", :exact COLLATE "C") ELSE 0 END AS hit
            FROM page_slice
        ), result AS (
            SELECT pdf_quote_text_ready,
                   CASE WHEN NOT pdf_quote_text_ready THEN 'pending'
                       WHEN :exact = '' THEN 'empty_exact'
                       WHEN hit = 0 THEN 'no_match'
                       WHEN strpos(substring(page_text FROM hit + 1) COLLATE "C",
                                   :exact COLLATE "C") > 0 THEN 'ambiguous'
                       ELSE 'unique' END AS status,
                   lo + hit - 1 AS start, lo + hit - 1 + char_length(:exact) AS finish
            FROM located
        )
        SELECT status AS match_status,
            CASE WHEN status = 'unique' THEN start END AS start_offset,
            CASE WHEN status = 'unique' THEN finish END AS end_offset,
            CASE WHEN status = 'unique' THEN (SELECT substring(s.canonical_text
                FROM greatest(0, start - 64) + 1 FOR least(start, 64))
                {_PDF_SEARCH_SOURCE}) ELSE '' END AS prefix,
            CASE WHEN status = 'unique' THEN (SELECT substring(s.canonical_text
                FROM finish + 1 FOR 64) {_PDF_SEARCH_SOURCE}) ELSE '' END AS suffix,
            pdf_quote_text_ready
        FROM result
    """),
            {"media": media_id, "generation": generation, "page": page_number, "exact": exact},
        )
        .mappings()
        .one()
    )
    if row["pdf_quote_text_ready"] is None:
        raise AssertionError("Ready PDF source has no frozen quote readiness")
    return {
        key: row[key] for key in ("match_status", "start_offset", "end_offset", "prefix", "suffix")
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
    source_sha256: str,
    exclude_highlight_id: UUID | None = None,
) -> UUID | None:
    """Exact ordered quantized geometry, returning only the matching identity."""
    quads = [
        {
            "quad_idx": index,
            **{
                f"{axis}{point}": str(getattr(quad, f"{axis}{point}"))
                for axis in ("x", "y")
                for point in range(1, 5)
            },
        }
        for index, quad in enumerate(canonical.quads)
    ]
    return db.scalar(
        text("""
        WITH requested AS MATERIALIZED (
            SELECT * FROM jsonb_to_recordset(CAST(:quads AS jsonb)) AS q(
                quad_idx integer, x1 numeric, y1 numeric, x2 numeric, y2 numeric,
                x3 numeric, y3 numeric, x4 numeric, y4 numeric)
        )
        SELECT hpa.highlight_id
        FROM highlight_pdf_anchors hpa JOIN highlights h ON h.id = hpa.highlight_id
        WHERE h.user_id = :viewer AND hpa.media_id = :media
          AND hpa.page_number = :page AND hpa.source_sha256 = :digest
          AND hpa.rect_count = :count
          AND (CAST(:exclude AS uuid) IS NULL OR hpa.highlight_id <> CAST(:exclude AS uuid))
          AND NOT EXISTS (
              SELECT 1 FROM requested r
              LEFT JOIN highlight_pdf_quads stored
                ON stored.highlight_id = hpa.highlight_id AND stored.quad_idx = r.quad_idx
              WHERE stored.highlight_id IS NULL OR
                ROW(stored.x1, stored.y1, stored.x2, stored.y2,
                    stored.x3, stored.y3, stored.x4, stored.y4)
                IS DISTINCT FROM ROW(r.x1, r.y1, r.x2, r.y2, r.x3, r.y3, r.x4, r.y4)
          )
        ORDER BY hpa.highlight_id LIMIT 1
    """),
        {
            "viewer": viewer_id,
            "media": media_id,
            "page": canonical.page_number,
            "digest": source_sha256,
            "count": canonical.rect_count,
            "exclude": exclude_highlight_id,
            "quads": json.dumps(quads, separators=(",", ":")),
        },
    )


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
    source_sha256: str,
) -> EffectiveStateComparison:
    """Canonical side-effect-free effective-state comparison.

    Returns is_noop=True only when all effective mutable fields are unchanged.
    Returns requires_full_path=True when safe equality cannot be proven.
    """
    pa = highlight.pdf_anchor
    if pa is None:
        return EffectiveStateComparison(is_noop=False, requires_full_path=True)

    if pa.source_sha256 != source_sha256 or pa.page_number != canonical.page_number:
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
    source = get_reader_publication_pdf_source_for_viewer(
        db, viewer_id=viewer_id, media_id=media_id, generation=req.reader_generation
    )
    _validate_page_number(req.page_number, source.page_count)

    try:
        validate_exact_length(req.exact)
    except GeometryValidationError as e:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, e.message) from e

    quads_dicts = [q.model_dump() for q in req.quads]
    try:
        canonical = canonicalize_geometry(req.page_number, quads_dicts)
    except GeometryValidationError as e:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, e.message) from e

    match_fields = _compute_write_time_match(
        db, media_id, req.reader_generation, req.page_number, req.exact
    )

    coord_key = derive_media_coordination_lock_key(media_id)
    dup_key = derive_duplicate_lock_key(
        viewer_id,
        media_id,
        canonical.page_number,
        canonical.quads,
    )
    acquire_ordered_locks(db, coord_key, dup_key)

    existing = _find_duplicate_pdf_anchor(db, viewer_id, media_id, canonical, source.sha256)
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
        source_sha256=source.sha256,
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


def create_pdf_highlight_in_txn(
    db: Session,
    *,
    viewer_id: UUID,
    highlight_id: UUID,
    media_id: UUID,
    reader_generation: int,
    page_number: int,
    quads: list,
    exact: str,
    color: str,
) -> Highlight:
    """Create a fresh PDF geometry Highlight with a client-stable id; flush-only.

    Composes inside the Link service's caller-owned (retryable) transaction: it
    never commits, and a first-insert race on ``highlights_pkey`` is left to the
    caller's retry allowlist. Reusing the client-stable id for a *different*
    selection is ``E_HIGHLIGHT_CONFLICT`` (§ Mutation APIs); reusing it for the
    same page/quads returns the existing row so an in-flight retry converges.
    """
    source = get_reader_publication_pdf_source_for_viewer(
        db, viewer_id=viewer_id, media_id=media_id, generation=reader_generation
    )
    _validate_page_number(page_number, source.page_count)

    try:
        validate_exact_length(exact)
        canonical = canonicalize_geometry(page_number, [dict(q) for q in quads])
    except GeometryValidationError as e:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, e.message) from e

    existing = db.get(Highlight, highlight_id)
    if existing is not None:
        _assert_pdf_selection_matches(
            existing=existing,
            viewer_id=viewer_id,
            media_id=media_id,
            canonical=canonical,
            source_sha256=source.sha256,
        )
        return existing

    match_fields = _compute_write_time_match(db, media_id, reader_generation, page_number, exact)

    coord_key = derive_media_coordination_lock_key(media_id)
    dup_key = derive_duplicate_lock_key(viewer_id, media_id, canonical.page_number, canonical.quads)
    acquire_ordered_locks(db, coord_key, dup_key)

    if _find_duplicate_pdf_anchor(db, viewer_id, media_id, canonical, source.sha256) is not None:
        raise ApiError(ApiErrorCode.E_HIGHLIGHT_CONFLICT, "Duplicate PDF highlight")

    highlight = Highlight(
        id=highlight_id,
        user_id=viewer_id,
        anchor_kind="pdf_page_geometry",
        anchor_media_id=media_id,
        color=color,
        exact=exact,
        prefix=match_fields["prefix"],
        suffix=match_fields["suffix"],
    )
    db.add(highlight)
    db.flush()

    db.add(
        HighlightPdfAnchor(
            highlight_id=highlight.id,
            media_id=media_id,
            source_sha256=source.sha256,
            page_number=canonical.page_number,
            sort_top=canonical.sort_top,
            sort_left=canonical.sort_left,
            plain_text_match_status=match_fields["match_status"],
            plain_text_start_offset=match_fields["start_offset"],
            plain_text_end_offset=match_fields["end_offset"],
            rect_count=canonical.rect_count,
        )
    )
    db.flush()
    for idx, cq in enumerate(canonical.quads):
        db.add(
            HighlightPdfQuad(
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


def _assert_pdf_selection_matches(
    *,
    existing: Highlight,
    viewer_id: UUID,
    media_id: UUID,
    canonical: CanonicalGeometry,
    source_sha256: str,
) -> None:
    """Guard a client-stable Highlight id against naming a different PDF selection."""
    anchor = existing.pdf_anchor
    if (
        existing.user_id != viewer_id
        or existing.anchor_kind != "pdf_page_geometry"
        or anchor is None
        or anchor.media_id != media_id
        or anchor.source_sha256 != source_sha256
        or anchor.page_number != canonical.page_number
        or not _stored_quads_match(existing.pdf_quads, canonical.quads)
    ):
        raise ApiError(
            ApiErrorCode.E_HIGHLIGHT_CONFLICT, "Highlight id names a different selection"
        )


def list_pdf_highlights(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    page_number: int,
    *,
    reader_generation: int,
    limits: ReaderPublicationLimits,
    mine_only: bool = True,
    after: str | None = None,
    limit: int = 50,
) -> PdfHighlightPaintPage:
    """Page only attested paint; authored prose and linked bodies stay on detail reads."""
    source = get_reader_publication_pdf_source_for_viewer(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        generation=reader_generation,
    )
    _validate_page_number(page_number, source.page_count)
    binding = {
        "viewer": str(viewer_id),
        "media": str(media_id),
        "generation": reader_generation,
        "page": page_number,
        "mine_only": mine_only,
    }
    order = (
        HighlightPdfAnchor.sort_top,
        HighlightPdfAnchor.sort_left,
        Highlight.created_at,
        Highlight.id,
    )
    query = (
        select(
            Highlight.id,
            Highlight.color,
            Highlight.created_at,
            Highlight.user_id,
            HighlightPdfAnchor.sort_top,
            HighlightPdfAnchor.sort_left,
        )
        .join(HighlightPdfAnchor, HighlightPdfAnchor.highlight_id == Highlight.id)
        .where(
            HighlightPdfAnchor.media_id == media_id,
            HighlightPdfAnchor.page_number == page_number,
            HighlightPdfAnchor.source_sha256 == source.sha256,
            Highlight.anchor_kind == "pdf_page_geometry",
            Highlight.user_id == viewer_id
            if mine_only
            else highlight_visibility_filter(viewer_id, media_id),
        )
    )
    if after is not None:
        values = decode_signed_keyset_cursor(
            after,
            family="ReaderPublicationPdfHighlights",
            query=binding,
            expected_kinds=(
                KeysetValueKind.Text,
                KeysetValueKind.Text,
                KeysetValueKind.DateTime,
                KeysetValueKind.Uuid,
            ),
        )
        from decimal import Decimal

        query = query.where(
            tuple_(*order) > tuple_(Decimal(values[0]), Decimal(values[1]), values[2], values[3])
        )
    rows = db.execute(query.order_by(*order).limit(limit + 1)).all()
    items = []
    last_cursor = None
    for row in rows:
        if len(items) == limit:
            return PdfHighlightPaintPage(
                page_number=page_number,
                source_sha256=source.sha256,
                highlights=tuple(items),
                next_cursor=last_cursor,
            )
        quads = (
            db.execute(
                select(HighlightPdfQuad)
                .where(HighlightPdfQuad.highlight_id == row.id)
                .order_by(HighlightPdfQuad.quad_idx)
            )
            .scalars()
            .all()
        )
        paint = PdfHighlightPaint(
            id=row.id,
            color=row.color,
            created_at=row.created_at,
            author_user_id=row.user_id,
            is_owner=row.user_id == viewer_id,
            quads=tuple(
                PdfQuadOut(
                    **{
                        f"{axis}{index}": float(getattr(quad, f"{axis}{index}"))
                        for axis in ("x", "y")
                        for index in range(1, 5)
                    }
                )
                for quad in quads
            ),
        )
        cursor = encode_signed_keyset_cursor(
            family="ReaderPublicationPdfHighlights",
            query=binding,
            after=(
                KeysetValue(KeysetValueKind.Text, str(row.sort_top)),
                KeysetValue(KeysetValueKind.Text, str(row.sort_left)),
                KeysetValue(KeysetValueKind.DateTime, row.created_at),
                KeysetValue(KeysetValueKind.Uuid, row.id),
            ),
        )
        candidate = PdfHighlightPaintPage(
            page_number=page_number,
            source_sha256=source.sha256,
            highlights=(*items, paint),
            next_cursor=cursor,
        )
        page_bytes = len(candidate.model_dump_json().encode("utf-8")) + len(b'{"data":}')
        if page_bytes > limits.index_bytes:
            if not items:
                raise ReaderContentTooLargeError(
                    "PDF highlight exceeds response capacity",
                    limit="index_bytes",
                    limit_value=limits.index_bytes,
                    measured=page_bytes,
                )
            return PdfHighlightPaintPage(
                page_number=page_number,
                source_sha256=source.sha256,
                highlights=tuple(items),
                next_cursor=last_cursor,
            )
        items.append(paint)
        last_cursor = cursor
    return PdfHighlightPaintPage(
        page_number=page_number,
        source_sha256=source.sha256,
        highlights=tuple(items),
        next_cursor=None,
    )


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
    source = get_reader_publication_pdf_source_for_viewer(
        db,
        viewer_id=viewer_id,
        media_id=highlight.anchor_media_id,
        generation=bounds.reader_generation,
    )
    _validate_page_number(bounds.page_number, source.page_count)

    try:
        validate_exact_length(bounds.exact)
    except GeometryValidationError as e:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, e.message) from e

    quads_dicts = [q.model_dump() for q in bounds.quads]
    try:
        canonical = canonicalize_geometry(bounds.page_number, quads_dicts)
    except GeometryValidationError as e:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, e.message) from e

    coord_key = derive_media_coordination_lock_key(highlight.anchor_media_id)
    dup_key = derive_duplicate_lock_key(
        viewer_id, highlight.anchor_media_id, canonical.page_number, canonical.quads
    )
    acquire_ordered_locks(db, coord_key, dup_key)
    # Loading before the lock grants access; it does not establish mutation
    # state. Refresh the anchor and ordered quads after acquiring that lock.
    locked = db.scalar(
        select(Highlight)
        .where(Highlight.id == highlight.id)
        .with_for_update()
        .options(selectinload(Highlight.pdf_anchor), selectinload(Highlight.pdf_quads))
        .execution_options(populate_existing=True)
    )
    if locked is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    highlight = get_highlight_for_author_write_or_404(db, viewer_id, locked.id)
    comparison = compare_effective_state(
        highlight, canonical, bounds.exact, new_color, source.sha256
    )
    if comparison.is_noop:
        return project_highlight(highlight, viewer_id)
    match_fields = _compute_write_time_match(
        db, highlight.anchor_media_id, bounds.reader_generation, canonical.page_number, bounds.exact
    )

    dup = _find_duplicate_pdf_anchor(
        db,
        viewer_id,
        highlight.anchor_media_id,
        canonical,
        source.sha256,
        exclude_highlight_id=highlight.id,
    )
    if dup is not None:
        raise ApiError(ApiErrorCode.E_HIGHLIGHT_CONFLICT, "Duplicate PDF highlight")

    # Apply updates
    effective_color = new_color if new_color is not None else highlight.color
    highlight.color = effective_color
    highlight.exact = bounds.exact
    highlight.prefix = match_fields["prefix"]
    highlight.suffix = match_fields["suffix"]

    from sqlalchemy import func

    highlight.updated_at = func.now()

    pa = highlight.pdf_anchor
    pa.source_sha256 = source.sha256
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
