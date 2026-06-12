"""Hydrated target/source connection reads over ``resource_edges``."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import Any, cast
from uuid import UUID

from sqlalchemy import and_, false, or_, select, text
from sqlalchemy.orm import Session

from nexus.db.models import ResourceEdge
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.services.resource_graph.citations import citation_reader_target_for_edge
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.resolve import reader_target_for_citation_target, resolve_refs
from nexus.services.resource_graph.schemas import (
    Connection,
    ConnectionCitation,
    ConnectionEndpoint,
    ConnectionPage,
    ConnectionQuery,
    EdgeKind,
    EdgeOrigin,
    snapshot_from_jsonb,
)


def query_connections(db: Session, *, viewer_id: UUID, query: ConnectionQuery) -> ConnectionPage:
    if not query.refs:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "At least one ref is required")
    if len(query.refs) > 200:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "At most 200 refs are allowed")
    if query.limit < 1 or query.limit > 100:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "limit must be between 1 and 100")

    expanded_refs = _expand_refs(db, viewer_id=viewer_id, refs=query.refs, rollup=query.rollup)
    rows = _query_rows(db, viewer_id=viewer_id, refs=expanded_refs, query=query)
    page_rows = rows[: query.limit]
    next_cursor = _encode_cursor(page_rows[-1]) if len(rows) > query.limit else None
    endpoints = _hydrate_endpoints(db, viewer_id=viewer_id, rows=page_rows)
    expanded_keys: set[tuple[ResourceScheme, UUID]] = {
        (ref.scheme, ref.id) for ref in expanded_refs
    }
    return ConnectionPage(
        items=tuple(
            _connection_for_row(
                db,
                viewer_id=viewer_id,
                row=row,
                query_direction=query.direction,
                endpoints=endpoints,
                expanded_keys=expanded_keys,
            )
            for row in page_rows
        ),
        next_cursor=next_cursor,
    )


def _query_rows(
    db: Session, *, viewer_id: UUID, refs: tuple[ResourceRef, ...], query: ConnectionQuery
) -> list[ResourceEdge]:
    direction_clauses: list[Any] = []
    if query.direction in ("incoming", "both"):
        direction_clauses.append(
            _endpoint_clause(ResourceEdge.target_scheme, ResourceEdge.target_id, refs)
        )
    if query.direction in ("outgoing", "both"):
        direction_clauses.append(
            _endpoint_clause(ResourceEdge.source_scheme, ResourceEdge.source_id, refs)
        )

    stmt = select(ResourceEdge).where(ResourceEdge.user_id == viewer_id, or_(*direction_clauses))
    if query.filters.origins is not None:
        stmt = stmt.where(ResourceEdge.origin.in_(query.filters.origins))
    if query.filters.kinds is not None:
        stmt = stmt.where(ResourceEdge.kind.in_(query.filters.kinds))
    if query.filters.source_schemes is not None:
        stmt = stmt.where(ResourceEdge.source_scheme.in_(query.filters.source_schemes))
    if query.filters.target_schemes is not None:
        stmt = stmt.where(ResourceEdge.target_scheme.in_(query.filters.target_schemes))
    if query.cursor is not None:
        created_at, edge_id = _decode_cursor(query.cursor)
        stmt = stmt.where(
            or_(
                ResourceEdge.created_at < created_at,
                and_(ResourceEdge.created_at == created_at, ResourceEdge.id < edge_id),
            )
        )
    return list(
        db.execute(
            stmt.order_by(ResourceEdge.created_at.desc(), ResourceEdge.id.desc()).limit(
                query.limit + 1
            )
        )
        .scalars()
        .all()
    )


def _endpoint_clause(scheme_column: Any, id_column: Any, refs: tuple[ResourceRef, ...]) -> Any:
    by_scheme: dict[ResourceScheme, list[UUID]] = defaultdict(list)
    for ref in refs:
        by_scheme[ref.scheme].append(ref.id)
    if not by_scheme:
        return false()
    return or_(
        *(and_(scheme_column == scheme, id_column.in_(ids)) for scheme, ids in by_scheme.items())
    )


def _hydrate_endpoints(
    db: Session, *, viewer_id: UUID, rows: list[ResourceEdge]
) -> dict[str, ConnectionEndpoint]:
    refs: dict[str, ResourceRef] = {}
    for row in rows:
        refs.setdefault(
            f"{row.source_scheme}:{row.source_id}",
            ResourceRef(scheme=cast("ResourceScheme", row.source_scheme), id=row.source_id),
        )
        refs.setdefault(
            f"{row.target_scheme}:{row.target_id}",
            ResourceRef(scheme=cast("ResourceScheme", row.target_scheme), id=row.target_id),
        )
    resolved = resolve_refs(db, viewer_id=viewer_id, refs=list(refs.values()))
    return {
        ref.uri: ConnectionEndpoint(
            ref=ref,
            label=item.label,
            description=item.summary or None,
            href=None if item.missing else _href_for_ref(db, viewer_id=viewer_id, ref=ref),
            missing=item.missing,
        )
        for ref, item in zip(refs.values(), resolved, strict=True)
    }


def _connection_for_row(
    db: Session,
    *,
    viewer_id: UUID,
    row: ResourceEdge,
    query_direction: str,
    endpoints: dict[str, ConnectionEndpoint],
    expanded_keys: set[tuple[ResourceScheme, UUID]],
) -> Connection:
    source_ref = ResourceRef(scheme=cast("ResourceScheme", row.source_scheme), id=row.source_id)
    target_ref = ResourceRef(scheme=cast("ResourceScheme", row.target_scheme), id=row.target_id)
    source_matched = (source_ref.scheme, source_ref.id) in expanded_keys
    target_matched = (target_ref.scheme, target_ref.id) in expanded_keys
    direction = (
        "incoming"
        if query_direction == "incoming"
        or (query_direction == "both" and target_matched and not source_matched)
        else "outgoing"
    )
    projection = (
        citation_reader_target_for_edge(db, viewer_id=viewer_id, edge=row)
        if row.origin == "citation" and row.ordinal is not None
        else None
    )
    citation = (
        ConnectionCitation(
            ordinal=projection.ordinal,
            role=projection.role,
            snapshot=projection.snapshot,
            target_media_id=projection.media_id,
            target_locator=projection.locator,
            target_status=projection.target_status,
        )
        if projection is not None
        else None
    )
    source = endpoints[source_ref.uri]
    target = endpoints[target_ref.uri]
    return Connection(
        edge_id=row.id,
        direction=direction,
        kind=cast("EdgeKind", row.kind),
        origin=cast("EdgeOrigin", row.origin),
        snapshot=snapshot_from_jsonb(row.snapshot) if row.snapshot is not None else None,
        source_order_key=row.source_order_key,
        target_order_key=row.target_order_key,
        ordinal=row.ordinal,
        source_ref=source_ref,
        target_ref=target_ref,
        source=source,
        target=target,
        other=source if direction == "incoming" else target,
        citation=citation,
        created_at=row.created_at,
    )


def _expand_refs(
    db: Session, *, viewer_id: UUID, refs: tuple[ResourceRef, ...], rollup: str
) -> tuple[ResourceRef, ...]:
    out: dict[str, ResourceRef] = {}
    for ref in refs:
        out.setdefault(ref.uri, ref)
        if rollup == "owner":
            for child in _owner_children(db, viewer_id=viewer_id, ref=ref):
                out.setdefault(child.uri, child)
    return tuple(out.values())


def _owner_children(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> tuple[ResourceRef, ...]:
    if ref.scheme == "media":
        return (
            *_child_refs(
                db,
                "evidence_span",
                "SELECT id FROM evidence_spans WHERE owner_kind = 'media' AND owner_id = :id",
                ref.id,
            ),
            *_child_refs(
                db,
                "content_chunk",
                "SELECT id FROM content_chunks WHERE owner_kind = 'media' AND owner_id = :id",
                ref.id,
            ),
            *_child_refs(db, "fragment", "SELECT id FROM fragments WHERE media_id = :id", ref.id),
            *_child_refs(
                db,
                "highlight",
                "SELECT id FROM highlights WHERE user_id = :viewer_id AND anchor_media_id = :id",
                ref.id,
                viewer_id=viewer_id,
            ),
        )
    if ref.scheme == "page":
        return (
            *_child_refs(db, "note_block", _PAGE_NOTE_BLOCKS_SQL, ref.id, viewer_id=viewer_id),
            *_child_refs(
                db,
                "evidence_span",
                "SELECT id FROM evidence_spans WHERE owner_kind = 'page' AND owner_id = :id",
                ref.id,
            ),
            *_child_refs(
                db,
                "content_chunk",
                "SELECT id FROM content_chunks WHERE owner_kind = 'page' AND owner_id = :id",
                ref.id,
            ),
        )
    if ref.scheme == "note_block":
        return (
            *_child_refs(
                db,
                "evidence_span",
                """
                SELECT id
                FROM evidence_spans
                WHERE owner_kind = 'page'
                  AND selector->>'note_block_id' = :id_text
                """,
                ref.id,
            ),
            *_child_refs(
                db,
                "content_chunk",
                """
                SELECT id
                FROM content_chunks
                WHERE owner_kind = 'page'
                  AND summary_locator->>'note_block_id' = :id_text
                """,
                ref.id,
            ),
        )
    return ()


def _child_refs(
    db: Session,
    scheme: ResourceScheme,
    sql: str,
    parent_id: UUID,
    *,
    viewer_id: UUID | None = None,
) -> tuple[ResourceRef, ...]:
    params: dict[str, object] = {"id": parent_id, "id_text": str(parent_id)}
    if viewer_id is not None:
        params["viewer_id"] = viewer_id
    return tuple(ResourceRef(scheme=scheme, id=row[0]) for row in db.execute(text(sql), params))


def _href_for_ref(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> str | None:
    if ref.scheme == "media":
        return f"/media/{ref.id}"
    if ref.scheme == "library":
        return f"/libraries/{ref.id}"
    if ref.scheme == "page":
        return f"/pages/{ref.id}"
    if ref.scheme == "note_block":
        return f"/notes/{ref.id}"
    if ref.scheme == "conversation":
        return f"/conversations/{ref.id}"
    if ref.scheme == "podcast":
        return f"/podcasts/{ref.id}"
    if ref.scheme == "message":
        conversation_id = db.scalar(
            text("SELECT conversation_id FROM messages WHERE id = :id"), {"id": ref.id}
        )
        return f"/conversations/{conversation_id}" if conversation_id is not None else None
    if ref.scheme == "highlight":
        media_id = db.scalar(
            text("SELECT anchor_media_id FROM highlights WHERE id = :id"), {"id": ref.id}
        )
        return f"/media/{media_id}#highlight-{ref.id}" if media_id is not None else None
    if ref.scheme == "fragment":
        media_id = db.scalar(text("SELECT media_id FROM fragments WHERE id = :id"), {"id": ref.id})
        return f"/media/{media_id}#fragment-{ref.id}" if media_id is not None else None
    if ref.scheme in ("content_chunk", "evidence_span"):
        media_id, locator = reader_target_for_citation_target(db, viewer_id=viewer_id, target=ref)
        if media_id is not None:
            return (
                f"/media/{media_id}#evidence-{ref.id}"
                if ref.scheme == "evidence_span"
                else f"/media/{media_id}"
            )
        if isinstance(locator, dict) and isinstance(locator.get("block_id"), str):
            return f"/notes/{locator['block_id']}"
        page_id = db.scalar(
            text(
                f"""
                SELECT owner_id
                FROM {"content_chunks" if ref.scheme == "content_chunk" else "evidence_spans"}
                WHERE id = :id AND owner_kind = 'page'
                """
            ),
            {"id": ref.id},
        )
        return f"/pages/{page_id}" if page_id is not None else None
    if ref.scheme == "library_intelligence_artifact":
        library_id = db.scalar(
            text("SELECT library_id FROM library_intelligence_artifacts WHERE id = :id"),
            {"id": ref.id},
        )
        return f"/libraries/{library_id}?tab=intelligence" if library_id is not None else None
    return None


def _encode_cursor(edge: ResourceEdge) -> str:
    return f"{edge.created_at.isoformat()}|{edge.id}"


def _decode_cursor(raw: str) -> tuple[datetime, UUID]:
    created_raw, separator, edge_id_raw = raw.partition("|")
    if not separator:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid cursor")
    try:
        return datetime.fromisoformat(created_raw), UUID(edge_id_raw)
    except ValueError as exc:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid cursor") from exc


_PAGE_NOTE_BLOCKS_SQL = """
WITH RECURSIVE contained(id) AS (
    SELECT target_id
    FROM resource_edges
    WHERE user_id = :viewer_id
      AND origin = 'note_containment'
      AND source_scheme = 'page'
      AND source_id = :id
      AND target_scheme = 'note_block'
    UNION
    SELECT e.target_id
    FROM resource_edges e
    JOIN contained c ON c.id = e.source_id
    WHERE e.user_id = :viewer_id
      AND e.origin = 'note_containment'
      AND e.source_scheme = 'note_block'
      AND e.target_scheme = 'note_block'
)
SELECT id FROM contained
"""
