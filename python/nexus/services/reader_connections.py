"""Media-reader projection for graph connections."""

from __future__ import annotations

from dataclasses import replace
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_highlight, can_read_media
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.reader import (
    ReaderConnectionAnchorOut,
    ReaderConnectionPageOut,
    ReaderConnectionRowOut,
)
from nexus.schemas.resource_graph import connection_out
from nexus.services import passage_anchors, text_quote
from nexus.services.resource_graph.connections import query_connections
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.resolve import reader_target_for_citation_target
from nexus.services.resource_graph.schemas import (
    Connection,
    ConnectionEndpoint,
    ConnectionFilters,
    ConnectionQuery,
    EdgeOrigin,
)

READER_CONNECTION_ORIGINS: tuple[EdgeOrigin, ...] = (
    "citation",
    "note_body",
    "highlight_note",
    "user",
    "synapse",
    "system",
    "document_embed",
)


def list_reader_connections(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    origins: tuple[EdgeOrigin, ...] | None,
    source_schemes: tuple[ResourceScheme, ...] | None,
    limit: int,
    cursor: str | None,
) -> ReaderConnectionPageOut:
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Media not found")
    page = query_connections(
        db,
        viewer_id=viewer_id,
        query=ConnectionQuery(
            refs=(ResourceRef(scheme="media", id=media_id),),
            direction="both",
            rollup="owner",
            filters=ConnectionFilters(origins=origins, source_schemes=source_schemes),
            limit=limit,
            cursor=cursor,
        ),
    )
    # One request-scoped memo of normalized owner sources: a page whose passage
    # anchors share the media being read then reloads+renormalizes it once, not
    # once per anchor.
    sources_cache: text_quote.MediaSourceCache = {}
    rows = [
        row
        for item in page.items
        for row in _rows(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            connection=item,
            sources_cache=sources_cache,
        )
    ]
    anchored = sorted((row for row in rows if row.anchor is not None), key=_row_order_key)
    unanchored = [row for row in rows if row.anchor is None]
    return ReaderConnectionPageOut(
        anchored=anchored,
        unanchored=unanchored,
        next_cursor=page.next_cursor,
    )


def _rows(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    connection: Connection,
    sources_cache: text_quote.MediaSourceCache,
) -> list[ReaderConnectionRowOut]:
    """One reader row per LOCAL endpoint of the edge.

    An endpoint is local when it anchors into ``media_id``. A cross-document edge
    has one local endpoint → one row; a same-media Link between two local
    passages/highlights has two → two rows, each activating the opposite endpoint
    with a distinct ``edge:{edge_id}:anchor:{local_ref}`` identity. Storage
    direction is never read here — locality alone decides the split (Invariant 2).
    When neither endpoint is local the edge still surfaces as one unanchored row.
    """
    source_anchor = _anchor_for_ref(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        ref=connection.source_ref,
        sources_cache=sources_cache,
    )
    target_anchor = _anchor_for_ref(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        ref=connection.target_ref,
        sources_cache=sources_cache,
    )
    rows: list[ReaderConnectionRowOut] = []
    if source_anchor is not None:
        rows.append(
            _build_row(
                connection,
                anchor_ref=connection.source_ref,
                anchor=source_anchor,
                other=connection.target,
            )
        )
    if target_anchor is not None:
        rows.append(
            _build_row(
                connection,
                anchor_ref=connection.target_ref,
                anchor=target_anchor,
                other=connection.source,
            )
        )
    if rows:
        return rows
    # Neither endpoint anchors locally: one unanchored row. ``connection.other``
    # already names the far endpoint by locality (matched_incoming in the read
    # model), never by canonical storage direction, so an undirected neutral Link
    # surfaces its true peer rather than self-referencing the open document
    # (Invariant 2, AC17).
    other = connection.other
    anchor_ref = (
        connection.source_ref if other.ref == connection.target_ref else connection.target_ref
    )
    return [_build_row(connection, anchor_ref=anchor_ref, anchor=None, other=other)]


def _build_row(
    connection: Connection,
    *,
    anchor_ref: ResourceRef,
    anchor: ReaderConnectionAnchorOut | None,
    other: ConnectionEndpoint,
) -> ReaderConnectionRowOut:
    excerpt = other.description
    if connection.snapshot is not None and connection.snapshot.excerpt:
        excerpt = connection.snapshot.excerpt
    if connection.citation is not None and connection.citation.snapshot.excerpt:
        excerpt = connection.citation.snapshot.excerpt
    return ReaderConnectionRowOut(
        id=f"edge:{connection.edge_id}:anchor:{anchor_ref.uri}",
        connection=connection_out(replace(connection, other=other)),
        anchor=anchor,
        source_category=_source_category(connection),
        title=other.label or other.ref.uri,
        subtitle=f"{connection.origin} · {connection.kind}",
        excerpt=excerpt,
        activation=other.activation,
        href=other.href,
    )


def _anchor_for_ref(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    ref: ResourceRef,
    sources_cache: text_quote.MediaSourceCache,
) -> ReaderConnectionAnchorOut | None:
    if ref.scheme == "evidence_span":
        target_media_id, locator = reader_target_for_citation_target(
            db, viewer_id=viewer_id, target=ref
        )
        if target_media_id != media_id or locator is None:
            return None
        return ReaderConnectionAnchorOut(
            ref=ref.uri,
            media_id=media_id,
            locator=locator,
            page_number=_locator_page(locator),
            fragment_id=_locator_fragment(locator),
            evidence_span_id=ref.id,
            order_key=_locator_order_key(db, locator),
        )
    if ref.scheme == "content_chunk":
        row = db.execute(
            text(
                """
                SELECT primary_evidence_span_id, chunk_idx, summary_locator
                FROM content_chunks
                WHERE id = :id AND owner_kind = 'media' AND owner_id = :media_id
                """
            ),
            {"id": ref.id, "media_id": media_id},
        ).first()
        if row is None:
            return None
        if row[0] is None:
            locator = row[2] if isinstance(row[2], dict) else None
            if not locator:
                return None
            fragment_id = _locator_fragment(locator)
            if fragment_id is None and _locator_page(locator) is None:
                return None
            return ReaderConnectionAnchorOut(
                ref=ref.uri,
                media_id=media_id,
                locator=locator,
                page_number=_locator_page(locator),
                fragment_id=fragment_id,
                evidence_span_id=None,
                order_key=_locator_order_key(db, locator) or f"chunk:{int(row[1]):010d}",
            )
        span_ref = ResourceRef(scheme="evidence_span", id=row[0])
        target_media_id, locator = reader_target_for_citation_target(
            db, viewer_id=viewer_id, target=span_ref
        )
        if target_media_id != media_id or locator is None:
            return None
        return ReaderConnectionAnchorOut(
            ref=ref.uri,
            media_id=media_id,
            locator=locator,
            page_number=_locator_page(locator),
            fragment_id=_locator_fragment(locator),
            evidence_span_id=row[0],
            order_key=f"chunk:{int(row[1]):010d}",
        )
    if ref.scheme == "fragment":
        row = db.execute(
            text(
                "SELECT idx, canonical_text FROM fragments WHERE id = :id AND media_id = :media_id"
            ),
            {"id": ref.id, "media_id": media_id},
        ).first()
        if row is None:
            return None
        return ReaderConnectionAnchorOut(
            ref=ref.uri,
            media_id=media_id,
            locator={
                "type": "web_text_offsets",
                "media_id": str(media_id),
                "fragment_id": str(ref.id),
                "start_offset": 0,
                "end_offset": min(1, len(str(row[1] or ""))),
            },
            fragment_id=ref.id,
            order_key=f"fragment:{int(row[0]):010d}",
        )
    if ref.scheme == "highlight":
        return _highlight_anchor(
            db, viewer_id=viewer_id, media_id=media_id, highlight_id=ref.id, ref=ref.uri
        )
    if ref.scheme == "passage_anchor":
        return _passage_anchor_anchor(
            db, viewer_id=viewer_id, media_id=media_id, ref=ref, sources_cache=sources_cache
        )
    return None


def _passage_anchor_anchor(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    ref: ResourceRef,
    sources_cache: text_quote.MediaSourceCache,
) -> ReaderConnectionAnchorOut | None:
    """Anchor a passage_anchor endpoint at its LIVE current locator.

    Never persisted: ``passage_anchors.resolve_current_location`` re-resolves the
    quote against current owner text on every read. Fail-closed — an anchor owned
    by another media/viewer, or one that no longer resolves uniquely, returns
    ``None`` so the row stays visible in the unanchored collection with no false
    jump.
    """
    location = passage_anchors.resolve_current_location(
        db, viewer_id=viewer_id, passage_anchor_id=ref.id, sources_cache=sources_cache
    )
    if location is None or location.owner_scheme != "media" or location.owner_id != media_id:
        return None
    if not location.resolved or location.locator is None:
        return None
    reader_locator = _reader_locator_from_passage(media_id, location.locator)
    if reader_locator is None:
        return None
    return ReaderConnectionAnchorOut(
        ref=ref.uri,
        media_id=media_id,
        locator=reader_locator,
        page_number=_locator_page(reader_locator),
        fragment_id=_locator_fragment(reader_locator),
        passage_anchor_id=ref.id,
        order_key=_locator_order_key(db, reader_locator),
    )


def _reader_locator_from_passage(media_id: UUID, locator: dict[str, Any]) -> dict[str, Any] | None:
    """Map a passage-anchor selector locator to a reader retrieval locator."""
    kind = locator.get("kind")
    if kind == "text":
        fragment_id = locator.get("fragment_id")
        if fragment_id is None:
            return None
        return {
            "type": "web_text_offsets",
            "media_id": str(media_id),
            "fragment_id": str(fragment_id),
            "start_offset": locator.get("start_offset"),
            "end_offset": locator.get("end_offset"),
        }
    if kind == "pdf":
        page_number = locator.get("page_number")
        if page_number is None:
            return None
        return {
            "type": "pdf_page_geometry",
            "media_id": str(media_id),
            "page_number": int(page_number),
            "quads": locator.get("quads", []),
        }
    if kind == "time":
        return {
            "type": "transcript_time_range",
            "media_id": str(media_id),
            "t_start_ms": locator.get("t_start_ms"),
            "t_end_ms": locator.get("t_end_ms"),
        }
    return None


def _highlight_anchor(
    db: Session, *, viewer_id: UUID, media_id: UUID, highlight_id: UUID, ref: str
) -> ReaderConnectionAnchorOut | None:
    if not can_read_highlight(db, viewer_id, highlight_id):
        return None
    row = db.execute(
        text(
            """
            SELECT h.anchor_kind,
                   hfa.fragment_id,
                   hfa.start_offset,
                   hfa.end_offset,
                   f.idx,
                   hpa.page_number,
                   hpa.sort_top,
                   hpa.sort_left
            FROM highlights h
            LEFT JOIN highlight_fragment_anchors hfa ON hfa.highlight_id = h.id
            LEFT JOIN fragments f ON f.id = hfa.fragment_id
            LEFT JOIN highlight_pdf_anchors hpa ON hpa.highlight_id = h.id
            WHERE h.id = :highlight_id
              AND h.anchor_media_id = :media_id
            """
        ),
        {"highlight_id": highlight_id, "media_id": media_id},
    ).first()
    if row is None:
        return None
    if row[0] == "pdf_page_geometry" and row[5] is not None:
        quads = [
            {
                "x1": float(quad[0]),
                "y1": float(quad[1]),
                "x2": float(quad[2]),
                "y2": float(quad[3]),
                "x3": float(quad[4]),
                "y3": float(quad[5]),
                "x4": float(quad[6]),
                "y4": float(quad[7]),
            }
            for quad in db.execute(
                text(
                    """
                    SELECT x1, y1, x2, y2, x3, y3, x4, y4
                    FROM highlight_pdf_quads
                    WHERE highlight_id = :highlight_id
                    ORDER BY quad_idx
                    """
                ),
                {"highlight_id": highlight_id},
            )
        ]
        if not quads:
            return None
        return ReaderConnectionAnchorOut(
            ref=ref,
            media_id=media_id,
            locator={
                "type": "pdf_page_geometry",
                "media_id": str(media_id),
                "page_number": int(row[5]),
                "quads": quads,
            },
            page_number=int(row[5]),
            highlight_id=highlight_id,
            order_key=f"pdf:{int(row[5]):08d}:{_decimal_key(row[6])}:{_decimal_key(row[7])}",
        )
    if row[0] == "fragment_offsets" and row[1] is not None:
        fragment_id = UUID(str(row[1]))
        return ReaderConnectionAnchorOut(
            ref=ref,
            media_id=media_id,
            locator={
                "type": "web_text_offsets",
                "media_id": str(media_id),
                "fragment_id": str(fragment_id),
                "start_offset": int(row[2]),
                "end_offset": int(row[3]),
            },
            fragment_id=fragment_id,
            highlight_id=highlight_id,
            order_key=f"fragment:{int(row[4] or 0):010d}:{int(row[2]):010d}",
        )
    return None


def _source_category(
    connection: Connection,
) -> Literal[
    "chat",
    "dossier",
    "oracle",
    "note",
    "highlight_note",
    "user_link",
    "synapse",
    "system",
    "document_embed",
    "other",
]:
    if connection.origin == "citation":
        if connection.source_ref.scheme == "message":
            return "chat"
        if connection.source_ref.scheme == "artifact_revision":
            return "dossier"
        if connection.source_ref.scheme == "oracle_reading":
            return "oracle"
        return "other"
    if connection.origin == "note_body":
        return "note"
    if connection.origin == "highlight_note":
        return "highlight_note"
    if connection.origin == "user":
        return "user_link"
    if connection.origin == "synapse":
        return "synapse"
    if connection.origin == "system":
        return "system"
    if connection.origin == "document_embed":
        return "document_embed"
    return "other"


def _row_order_key(row: ReaderConnectionRowOut) -> str:
    return (
        row.anchor.order_key
        if row.anchor and row.anchor.order_key
        else row.connection.created_at.isoformat()
    )


def _locator_page(locator: dict[str, object]) -> int | None:
    value = locator.get("page_number")
    return value if isinstance(value, int) else None


def _locator_fragment(locator: dict[str, object]) -> UUID | None:
    value = locator.get("fragment_id")
    if isinstance(value, UUID):
        return value
    if isinstance(value, str):
        try:
            return UUID(value)
        except ValueError:
            return None
    return None


def _locator_order_key(db: Session, locator: dict[str, object]) -> str | None:
    page = _locator_page(locator)
    if page is not None:
        return f"pdf:{page:08d}"
    fragment_id = _locator_fragment(locator)
    if fragment_id is not None:
        idx = db.scalar(text("SELECT idx FROM fragments WHERE id = :id"), {"id": fragment_id})
        start = locator.get("start_offset")
        return f"fragment:{int(idx or 0):010d}:{int(start) if isinstance(start, int) else 0:010d}"
    start_ms = locator.get("t_start_ms")
    if isinstance(start_ms, int):
        return f"time:{start_ms:012d}"
    return None


def _decimal_key(value: object) -> str:
    numeric = value if isinstance(value, Decimal) else Decimal(0)
    return f"{numeric:012.4f}"
