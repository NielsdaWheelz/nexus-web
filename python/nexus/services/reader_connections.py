"""Media-reader projection for graph connections."""

from __future__ import annotations

from decimal import Decimal
from typing import Literal
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
from nexus.schemas.resource_graph import (
    ConnectionCitationOut,
    ConnectionEndpointOut,
    ConnectionOut,
    ConnectionReaderTargetOut,
)
from nexus.services.resource_graph.connections import query_connections
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.resolve import reader_target_for_citation_target
from nexus.services.resource_graph.schemas import (
    Connection,
    ConnectionEndpoint,
    ConnectionFilters,
    ConnectionQuery,
    EdgeOrigin,
    snapshot_to_jsonb,
)

READER_CONNECTION_ORIGINS: tuple[EdgeOrigin, ...] = (
    "citation",
    "note_body",
    "highlight_note",
    "user",
    "synapse",
    "system",
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
    rows = [
        _row(db, viewer_id=viewer_id, media_id=media_id, connection=item) for item in page.items
    ]
    anchored = sorted((row for row in rows if row.anchor is not None), key=_row_order_key)
    unanchored = [row for row in rows if row.anchor is None]
    return ReaderConnectionPageOut(
        anchored=anchored,
        unanchored=unanchored,
        next_cursor=page.next_cursor,
    )


def _row(
    db: Session, *, viewer_id: UUID, media_id: UUID, connection: Connection
) -> ReaderConnectionRowOut:
    anchor_ref = (
        connection.target_ref if connection.direction == "incoming" else connection.source_ref
    )
    source = connection.source if connection.direction == "incoming" else connection.target
    anchor = _anchor_for_ref(db, viewer_id=viewer_id, media_id=media_id, ref=anchor_ref)
    excerpt = source.description
    if connection.snapshot is not None and connection.snapshot.excerpt:
        excerpt = connection.snapshot.excerpt
    if connection.citation is not None and connection.citation.snapshot.excerpt:
        excerpt = connection.citation.snapshot.excerpt
    return ReaderConnectionRowOut(
        id=f"edge:{connection.edge_id}:anchor:{anchor_ref.uri}",
        connection=_connection_out(connection),
        anchor=anchor,
        source_category=_source_category(connection),
        title=source.label or source.ref.uri,
        subtitle=f"{connection.origin} · {connection.kind}",
        excerpt=excerpt,
        activation=source.activation,
        href=source.href,
    )


def _anchor_for_ref(
    db: Session, *, viewer_id: UUID, media_id: UUID, ref: ResourceRef
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
    "library_intelligence",
    "oracle",
    "note",
    "highlight_note",
    "user_link",
    "synapse",
    "system",
    "other",
]:
    if connection.origin == "citation":
        if connection.source_ref.scheme == "message":
            return "chat"
        if connection.source_ref.scheme == "library_intelligence_revision":
            return "library_intelligence"
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


def _endpoint_out(endpoint: ConnectionEndpoint) -> ConnectionEndpointOut:
    return ConnectionEndpointOut(
        ref=endpoint.ref.uri,
        scheme=endpoint.ref.scheme,
        id=endpoint.ref.id,
        label=endpoint.label,
        description=endpoint.description,
        activation=endpoint.activation,
        href=endpoint.href,
        missing=endpoint.missing,
    )


def _connection_out(item: Connection) -> ConnectionOut:
    citation = None
    if item.citation is not None:
        target_reader = None
        if item.citation.target_media_id is not None or item.citation.target_locator is not None:
            target_reader = ConnectionReaderTargetOut(
                media_id=item.citation.target_media_id,
                locator=item.citation.target_locator,
            )
        citation = ConnectionCitationOut(
            ordinal=item.citation.ordinal,
            role=item.citation.role,
            snapshot=snapshot_to_jsonb(item.citation.snapshot),
            activation=item.citation.activation,
            target_reader=target_reader,
            target_status=item.citation.target_status,
        )
    return ConnectionOut(
        edge_id=item.edge_id,
        direction=item.direction,
        kind=item.kind,
        origin=item.origin,
        snapshot=snapshot_to_jsonb(item.snapshot) if item.snapshot is not None else None,
        source_order_key=item.source_order_key,
        target_order_key=item.target_order_key,
        ordinal=item.ordinal,
        source_ref=item.source_ref.uri,
        target_ref=item.target_ref.uri,
        source=_endpoint_out(item.source),
        target=_endpoint_out(item.target),
        other=_endpoint_out(item.other),
        citation=citation,
        created_at=item.created_at,
    )
