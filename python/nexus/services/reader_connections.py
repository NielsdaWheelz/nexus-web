"""Media-reader projection for graph connections."""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_highlight, can_read_media
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.resource_graph import ConnectionOut, connection_out
from nexus.services import passage_anchors, text_quote
from nexus.services.reader_locations import (
    highlight_locator,
    locator_fragment,
    locator_page,
    order_key_from_locator,
)
from nexus.services.resource_graph.connections import query_connections
from nexus.services.resource_graph.reader_targets import reader_target_for_citation_target
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import (
    Connection,
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
    "assistant",
)


@dataclass(frozen=True, slots=True)
class ReaderConnectionAnchor:
    locator: dict[str, object]
    order_key: str | None
    passage_anchor_id: UUID | None = None


@dataclass(frozen=True, slots=True)
class ReaderConnectionRow:
    connection: ConnectionOut
    anchor: ReaderConnectionAnchor | None
    title: str
    excerpt: str | None


def list_reader_connections(
    db: Session, *, viewer_id: UUID, media_id: UUID
) -> list[ReaderConnectionRow]:
    """Every reader-projected connection for one media, in reader order."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Media not found")
    fragment_indexes = {
        str(row[0]): int(row[1])
        for row in db.execute(
            text("SELECT id, idx FROM fragments WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
    }
    sources_cache: text_quote.MediaSourceCache = {}
    anchors: dict[str, ReaderConnectionAnchor | None] = {}
    rows: list[ReaderConnectionRow] = []

    def anchor_for(connection: Connection, ref: ResourceRef) -> ReaderConnectionAnchor | None:
        if ref.uri not in anchors:
            anchors[ref.uri] = _anchor_for_ref(
                db,
                viewer_id=viewer_id,
                media_id=media_id,
                ref=ref,
                connection=connection,
                fragment_indexes=fragment_indexes,
                sources_cache=sources_cache,
            )
        return anchors[ref.uri]

    cursor: str | None = None
    while True:
        page = query_connections(
            db,
            viewer_id=viewer_id,
            query=ConnectionQuery(
                refs=(ResourceRef(scheme="media", id=media_id),),
                direction="both",
                rollup="owner",
                filters=ConnectionFilters(origins=READER_CONNECTION_ORIGINS, source_schemes=None),
                limit=100,
                cursor=cursor,
            ),
        )
        for connection in page.items:
            # A neutral Link is undirected: when BOTH endpoints anchor in this media
            # the reader emits one row per local endpoint, each activating the other.
            source_anchor = target_anchor = None
            if connection.direction == "undirected":
                source_anchor = anchor_for(connection, connection.source_ref)
                target_anchor = anchor_for(connection, connection.target_ref)
            if source_anchor is not None and target_anchor is not None:
                rows.append(_row(replace(connection, other=connection.target), source_anchor))
                rows.append(_row(replace(connection, other=connection.source), target_anchor))
                continue
            local_ref = (
                connection.source_ref
                if connection.other.ref == connection.target_ref
                else connection.target_ref
            )
            rows.append(_row(connection, anchor_for(connection, local_ref)))
        if page.next_cursor is None:
            break
        cursor = page.next_cursor
    rows.sort(key=_row_order_key)
    return rows


def _row(connection: Connection, anchor: ReaderConnectionAnchor | None) -> ReaderConnectionRow:
    far = connection.other
    excerpt = far.description
    if connection.snapshot is not None and connection.snapshot.excerpt:
        excerpt = connection.snapshot.excerpt
    if connection.citation is not None and connection.citation.snapshot.excerpt:
        excerpt = connection.citation.snapshot.excerpt
    return ReaderConnectionRow(
        connection=connection_out(connection),
        anchor=anchor,
        title=far.label or far.ref.uri,
        excerpt=excerpt,
    )


def _row_order_key(row: ReaderConnectionRow) -> tuple[int, str]:
    if row.anchor is not None and row.anchor.order_key is not None:
        return (0, row.anchor.order_key)
    return (1, row.connection.created_at.isoformat())


def _anchor_for_ref(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    ref: ResourceRef,
    connection: Connection,
    fragment_indexes: dict[str, int],
    sources_cache: text_quote.MediaSourceCache,
) -> ReaderConnectionAnchor | None:
    citation = connection.citation
    if (
        citation is not None
        and connection.target_ref == ref
        and citation.target_media_id == media_id
        and citation.target_locator is not None
    ):
        locator = citation.target_locator
        return ReaderConnectionAnchor(locator, order_key_from_locator(locator, fragment_indexes))

    if ref.scheme == "evidence_span":
        span_media_id, span_locator = reader_target_for_citation_target(
            db, viewer_id=viewer_id, target=ref
        )
        if span_media_id != media_id or span_locator is None:
            return None
        return ReaderConnectionAnchor(
            span_locator, order_key_from_locator(span_locator, fragment_indexes)
        )

    if ref.scheme == "content_chunk":
        row = db.execute(
            text(
                "SELECT primary_evidence_span_id, chunk_idx, summary_locator FROM content_chunks"
                " WHERE id = :id AND owner_kind = 'media' AND owner_id = :media_id"
            ),
            {"id": ref.id, "media_id": media_id},
        ).first()
        if row is None:
            return None
        chunk_key = f"chunk:{int(row.chunk_idx):010d}"
        if row.primary_evidence_span_id is not None:
            span_ref = ResourceRef(scheme="evidence_span", id=row.primary_evidence_span_id)
            span_media_id, span_locator = reader_target_for_citation_target(
                db, viewer_id=viewer_id, target=span_ref
            )
            if span_media_id != media_id or span_locator is None:
                return None
            return ReaderConnectionAnchor(span_locator, chunk_key)
        summary = row.summary_locator if isinstance(row.summary_locator, dict) else None
        if not summary:
            return None
        if locator_fragment(summary) is None and locator_page(summary) is None:
            return None
        return ReaderConnectionAnchor(
            summary, order_key_from_locator(summary, fragment_indexes) or chunk_key
        )

    if ref.scheme == "fragment":
        row = db.execute(
            text(
                "SELECT f.idx, f.canonical_text, m.kind AS media_kind FROM fragments f"
                " JOIN media m ON m.id = f.media_id"
                " WHERE f.id = :id AND f.media_id = :media_id"
            ),
            {"id": ref.id, "media_id": media_id},
        ).first()
        if row is None:
            return None
        return ReaderConnectionAnchor(
            locator={
                "type": "epub_fragment_offsets"
                if str(row.media_kind) == "epub"
                else "web_text_offsets",
                "media_id": str(media_id),
                "fragment_id": str(ref.id),
                "start_offset": 0,
                "end_offset": min(1, len(str(row.canonical_text or ""))),
                "media_kind": str(row.media_kind),
            },
            order_key=f"fragment:{int(row.idx):010d}",
        )

    if ref.scheme == "highlight":
        return _highlight_anchor(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            highlight_id=ref.id,
            fragment_indexes=fragment_indexes,
        )

    if ref.scheme == "reader_apparatus_item":
        row = db.execute(
            text(
                "SELECT locator, sort_key FROM reader_apparatus_items"
                " WHERE id = :id AND media_id = :media_id"
            ),
            {"id": ref.id, "media_id": media_id},
        ).first()
        if row is None or not isinstance(row.locator, dict):
            return None
        return ReaderConnectionAnchor(
            row.locator, order_key_from_locator(row.locator, fragment_indexes) or str(row.sort_key)
        )

    if ref.scheme == "passage_anchor":
        # Resolved live against current text on every read, never persisted: an
        # anchor that no longer resolves uniquely loses its jump, it never moves.
        location = passage_anchors.resolve_current_location(
            db, viewer_id=viewer_id, passage_anchor_id=ref.id, sources_cache=sources_cache
        )
        if location is None or location.owner_scheme != "media" or location.owner_id != media_id:
            return None
        if not location.resolved or location.locator is None:
            return None
        passage_locator = _passage_locator(media_id, location.locator)
        if passage_locator is None:
            return None
        return ReaderConnectionAnchor(
            passage_locator,
            order_key_from_locator(passage_locator, fragment_indexes),
            passage_anchor_id=ref.id,
        )

    return None


def _passage_locator(media_id: UUID, locator: dict[str, Any]) -> dict[str, Any] | None:
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
        return {"type": "pdf_page", "media_id": str(media_id), "page_number": int(page_number)}
    if kind == "time":
        return {
            "type": "transcript_time_range",
            "media_id": str(media_id),
            "t_start_ms": locator.get("t_start_ms"),
            "t_end_ms": locator.get("t_end_ms"),
        }
    return None


def _highlight_anchor(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    highlight_id: UUID,
    fragment_indexes: dict[str, int],
) -> ReaderConnectionAnchor | None:
    if not can_read_highlight(db, viewer_id, highlight_id):
        return None
    row = db.execute(
        text(
            "SELECT h.anchor_kind, hfa.fragment_id, hfa.start_offset, hfa.end_offset, f.idx,"
            " hpa.page_number, m.kind AS media_kind, h.exact, h.prefix, h.suffix"
            " FROM highlights h JOIN media m ON m.id = h.anchor_media_id"
            " LEFT JOIN highlight_fragment_anchors hfa ON hfa.highlight_id = h.id"
            " LEFT JOIN fragments f ON f.id = hfa.fragment_id"
            " LEFT JOIN highlight_pdf_anchors hpa ON hpa.highlight_id = h.id"
            " WHERE h.id = :highlight_id AND h.anchor_media_id = :media_id"
        ),
        {"highlight_id": highlight_id, "media_id": media_id},
    ).first()
    if row is None:
        return None
    media_kind = str(row.media_kind)
    order_key: str | None = None
    if row.anchor_kind == "pdf_page_geometry" and row.page_number is not None:
        quads = [
            {key: float(value) for key, value in quad.items()}
            for quad in db.execute(
                text(
                    "SELECT x1, y1, x2, y2, x3, y3, x4, y4 FROM highlight_pdf_quads"
                    " WHERE highlight_id = :highlight_id ORDER BY quad_idx"
                ),
                {"highlight_id": highlight_id},
            ).mappings()
        ]
        if not quads:
            return None
        raw = {
            "type": "pdf_page_geometry",
            "media_id": str(media_id),
            "page_number": int(row.page_number),
            "quads": quads,
        }
    elif row.anchor_kind == "fragment_offsets" and row.fragment_id is not None:
        raw = {
            "type": "epub_fragment_offsets" if media_kind == "epub" else "web_text_offsets",
            "media_id": str(media_id),
            "fragment_id": str(row.fragment_id),
            "start_offset": int(row.start_offset),
            "end_offset": int(row.end_offset),
        }
        order_key = f"fragment:{int(row.idx or 0):010d}:{int(row.start_offset):010d}"
    else:
        return None
    locator = highlight_locator(
        raw,
        media_kind=media_kind,
        exact=str(row.exact or ""),
        prefix=str(row.prefix or ""),
        suffix=str(row.suffix or ""),
    )
    return ReaderConnectionAnchor(
        locator, order_key or order_key_from_locator(locator, fragment_indexes)
    )
