"""Media-reader projection for graph connections."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_highlight, can_read_media
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.resource_graph import (
    ConnectionCitationOut,
    ConnectionEndpointOut,
    ConnectionOut,
    ConnectionReaderTargetOut,
)
from nexus.services.reader_locations import (
    highlight_locator,
    locator_fragment,
    locator_page,
    order_key_from_locator,
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
    "document_embed",
    "assistant",
)


@dataclass(frozen=True, slots=True)
class ReaderConnectionAnchor:
    locator: dict[str, object]
    order_key: str | None


@dataclass(frozen=True, slots=True)
class ReaderConnectionRow:
    connection: ConnectionOut
    anchor: ReaderConnectionAnchor | None
    title: str
    excerpt: str | None


@dataclass(frozen=True, slots=True)
class ReaderConnectionPage:
    items: tuple[ReaderConnectionRow, ...]
    next_cursor: str | None


def list_reader_connections(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    origins: tuple[EdgeOrigin, ...] | None,
    source_schemes: tuple[ResourceScheme, ...] | None,
    limit: int,
    cursor: str | None,
) -> ReaderConnectionPage:
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
    anchors: dict[str, ReaderConnectionAnchor | None] = {}
    rows: list[ReaderConnectionRow] = []
    for connection in page.items:
        anchor_ref = _anchor_ref(connection)
        if anchor_ref.uri not in anchors:
            anchors[anchor_ref.uri] = _anchor_for_connection(
                db,
                viewer_id=viewer_id,
                media_id=media_id,
                ref=anchor_ref,
                connection=connection,
            )
        rows.append(_row(connection=connection, anchor=anchors[anchor_ref.uri]))
    rows.sort(key=_row_order_key)
    return ReaderConnectionPage(items=tuple(rows), next_cursor=page.next_cursor)


def _row(*, connection: Connection, anchor: ReaderConnectionAnchor | None) -> ReaderConnectionRow:
    source = connection.source if connection.direction == "incoming" else connection.target
    excerpt = source.description
    if connection.snapshot is not None and connection.snapshot.excerpt:
        excerpt = connection.snapshot.excerpt
    if connection.citation is not None and connection.citation.snapshot.excerpt:
        excerpt = connection.citation.snapshot.excerpt
    return ReaderConnectionRow(
        connection=_connection_out(connection),
        anchor=anchor,
        title=source.label or source.ref.uri,
        excerpt=excerpt,
    )


def _anchor_ref(connection: Connection) -> ResourceRef:
    return connection.target_ref if connection.direction == "incoming" else connection.source_ref


def _anchor_for_connection(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    ref: ResourceRef,
    connection: Connection,
) -> ReaderConnectionAnchor | None:
    citation = connection.citation
    if (
        citation is not None
        and connection.target_ref == ref
        and citation.target_media_id == media_id
        and citation.target_locator is not None
    ):
        return ReaderConnectionAnchor(
            locator=citation.target_locator,
            order_key=_locator_order_key(db, citation.target_locator),
        )
    return _anchor_for_ref(db, viewer_id=viewer_id, media_id=media_id, ref=ref)


def _anchor_for_ref(
    db: Session, *, viewer_id: UUID, media_id: UUID, ref: ResourceRef
) -> ReaderConnectionAnchor | None:
    if ref.scheme == "evidence_span":
        target_media_id, locator = reader_target_for_citation_target(
            db, viewer_id=viewer_id, target=ref
        )
        if target_media_id != media_id or locator is None:
            return None
        return ReaderConnectionAnchor(
            locator=locator,
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
            fragment_id = locator_fragment(locator)
            if fragment_id is None and locator_page(locator) is None:
                return None
            return ReaderConnectionAnchor(
                locator=locator,
                order_key=_locator_order_key(db, locator) or f"chunk:{int(row[1]):010d}",
            )
        span_ref = ResourceRef(scheme="evidence_span", id=row[0])
        target_media_id, locator = reader_target_for_citation_target(
            db, viewer_id=viewer_id, target=span_ref
        )
        if target_media_id != media_id or locator is None:
            return None
        return ReaderConnectionAnchor(
            locator=locator,
            order_key=f"chunk:{int(row[1]):010d}",
        )
    if ref.scheme == "fragment":
        row = db.execute(
            text(
                """
                SELECT f.idx,
                       f.canonical_text,
                       m.kind,
                       (
                           SELECT n.location_id
                           FROM epub_nav_locations n
                           WHERE n.media_id = f.media_id
                             AND n.fragment_idx = f.idx
                           ORDER BY n.ordinal ASC
                           LIMIT 1
                       ) AS epub_section_id
                FROM fragments f
                JOIN media m ON m.id = f.media_id
                WHERE f.id = :id AND f.media_id = :media_id
                """
            ),
            {"id": ref.id, "media_id": media_id},
        ).first()
        if row is None:
            return None
        is_epub = str(row[2]) == "epub"
        locator: dict[str, object] = {
            "type": "epub_fragment_offsets" if is_epub else "web_text_offsets",
            "media_id": str(media_id),
            "fragment_id": str(ref.id),
            "start_offset": 0,
            "end_offset": min(1, len(str(row[1] or ""))),
            "media_kind": str(row[2]),
        }
        if is_epub and row[3] is not None:
            locator["section_id"] = str(row[3])
        return ReaderConnectionAnchor(
            locator=locator,
            order_key=f"fragment:{int(row[0]):010d}",
        )
    if ref.scheme == "highlight":
        return _highlight_anchor(db, viewer_id=viewer_id, media_id=media_id, highlight_id=ref.id)
    if ref.scheme == "reader_apparatus_item":
        row = db.execute(
            text(
                """
                SELECT locator, sort_key
                FROM reader_apparatus_items
                WHERE id = :id AND media_id = :media_id
                """
            ),
            {"id": ref.id, "media_id": media_id},
        ).first()
        if row is None or not isinstance(row[0], dict):
            return None
        locator = row[0]
        return ReaderConnectionAnchor(
            locator=locator,
            order_key=_locator_order_key(db, locator) or str(row[1]),
        )
    return None


def _highlight_anchor(
    db: Session, *, viewer_id: UUID, media_id: UUID, highlight_id: UUID
) -> ReaderConnectionAnchor | None:
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
                   m.kind,
                   (
                       SELECT n.location_id
                       FROM epub_nav_locations n
                       WHERE n.media_id = h.anchor_media_id
                         AND n.fragment_idx = f.idx
                       ORDER BY n.ordinal ASC
                       LIMIT 1
                   ) AS epub_section_id,
                   h.exact,
                   h.prefix,
                   h.suffix
            FROM highlights h
            JOIN media m ON m.id = h.anchor_media_id
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
    exact = str(row[8] or "")
    prefix = str(row[9] or "")
    suffix = str(row[10] or "")
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
        locator = highlight_locator(
            {
                "type": "pdf_page_geometry",
                "media_id": str(media_id),
                "page_number": int(row[5]),
                "quads": quads,
            },
            media_kind=str(row[6]),
            exact=exact,
            prefix=prefix,
            suffix=suffix,
        )
        return ReaderConnectionAnchor(
            locator=locator,
            order_key=_locator_order_key(db, locator),
        )
    if row[0] == "fragment_offsets" and row[1] is not None:
        fragment_id = UUID(str(row[1]))
        is_epub = str(row[6]) == "epub"
        locator = {
            "type": "epub_fragment_offsets" if is_epub else "web_text_offsets",
            "media_id": str(media_id),
            "fragment_id": str(fragment_id),
            "start_offset": int(row[2]),
            "end_offset": int(row[3]),
        }
        if is_epub and row[7] is not None:
            locator["section_id"] = str(row[7])
        locator = highlight_locator(
            locator,
            media_kind=str(row[6]),
            exact=exact,
            prefix=prefix,
            suffix=suffix,
        )
        return ReaderConnectionAnchor(
            locator=locator,
            order_key=f"fragment:{int(row[4] or 0):010d}:{int(row[2]):010d}",
        )
    return None


def _row_order_key(row: ReaderConnectionRow) -> tuple[int, str]:
    if row.anchor is not None and row.anchor.order_key is not None:
        return (0, row.anchor.order_key)
    return (1, row.connection.created_at.isoformat())


def _locator_order_key(db: Session, locator: dict[str, object]) -> str | None:
    fragment_id = locator_fragment(locator)
    fragment_indexes: dict[str, int] = {}
    if fragment_id is not None:
        idx = db.scalar(text("SELECT idx FROM fragments WHERE id = :id"), {"id": fragment_id})
        fragment_indexes[str(fragment_id)] = int(idx or 0)
    return order_key_from_locator(locator, fragment_indexes)


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
