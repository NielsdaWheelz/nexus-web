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
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.resolve import reader_target_for_citation_target
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
    # One request-scoped memo of normalized owner sources: a page whose passage
    # anchors share the media being read reloads+renormalizes it once, not once
    # per anchor. Passage-anchor locators are resolved LIVE (never persisted).
    sources_cache: text_quote.MediaSourceCache = {}
    anchors: dict[str, ReaderConnectionAnchor | None] = {}
    rows: list[ReaderConnectionRow] = []

    def anchor_for(connection: Connection, ref: ResourceRef) -> ReaderConnectionAnchor | None:
        if ref.uri not in anchors:
            anchors[ref.uri] = _anchor_for_connection(
                db,
                viewer_id=viewer_id,
                media_id=media_id,
                ref=ref,
                connection=connection,
                sources_cache=sources_cache,
            )
        return anchors[ref.uri]

    for connection in page.items:
        # A neutral Link is undirected, so BOTH endpoints may anchor in this
        # media. When they do (a same-media Link between two local passages), the
        # reader emits one row per local endpoint — each activating the opposite
        # endpoint (§ Reader Projection). Every other edge keeps its single,
        # locality-chosen anchor.
        if connection.direction == "undirected":
            source_anchor = anchor_for(connection, connection.source_ref)
            target_anchor = anchor_for(connection, connection.target_ref)
            if source_anchor is not None and target_anchor is not None:
                rows.append(
                    _row(connection=replace(connection, other=connection.target), anchor=source_anchor)
                )
                rows.append(
                    _row(connection=replace(connection, other=connection.source), anchor=target_anchor)
                )
                continue
            anchor_ref = _anchor_ref(connection)
            rows.append(
                _row(
                    connection=connection,
                    anchor=source_anchor
                    if anchor_ref.uri == connection.source_ref.uri
                    else target_anchor,
                )
            )
            continue
        anchor_ref = _anchor_ref(connection)
        rows.append(_row(connection=connection, anchor=anchor_for(connection, anchor_ref)))
    rows.sort(key=_row_order_key)
    return ReaderConnectionPage(items=tuple(rows), next_cursor=page.next_cursor)


def _row(*, connection: Connection, anchor: ReaderConnectionAnchor | None) -> ReaderConnectionRow:
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


def _anchor_ref(connection: Connection) -> ResourceRef:
    # The anchored endpoint is the LOCAL one — the endpoint that is not the far
    # ``other``. ``other`` is chosen by locality (matched_incoming), so this holds
    # for neutral undirected Links too, where storage direction carries no meaning.
    return (
        connection.source_ref
        if connection.other.ref == connection.target_ref
        else connection.target_ref
    )


def _anchor_for_connection(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    ref: ResourceRef,
    connection: Connection,
    sources_cache: text_quote.MediaSourceCache,
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
    return _anchor_for_ref(
        db, viewer_id=viewer_id, media_id=media_id, ref=ref, sources_cache=sources_cache
    )


def _anchor_for_ref(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    ref: ResourceRef,
    sources_cache: text_quote.MediaSourceCache,
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
) -> ReaderConnectionAnchor | None:
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
    return ReaderConnectionAnchor(
        locator=reader_locator,
        order_key=_locator_order_key(db, reader_locator),
        passage_anchor_id=ref.id,
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
