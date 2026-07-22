"""Hydrated target/source connection reads over ``resource_edges``."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import Any, cast
from uuid import UUID

from sqlalchemy import and_, false, or_, select
from sqlalchemy.orm import Session

from nexus.db.models import ResourceEdge
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.services.resource_graph.citations import citation_reader_targets_for_edges
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.resolve import resolve_refs
from nexus.services.resource_graph.schemas import (
    CitationTargetProjection,
    Connection,
    ConnectionCitation,
    ConnectionEndpoint,
    ConnectionPage,
    ConnectionQuery,
    EdgeKind,
    EdgeOrigin,
    snapshot_from_jsonb,
)
from nexus.services.resource_items.capabilities import expand_owned_child_refs
from nexus.services.resource_items.routing import resource_activations_for_refs


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
    citation_projections = citation_reader_targets_for_edges(
        db,
        viewer_id=viewer_id,
        edges=page_rows,
        target_missing_ref_uris={
            endpoint.ref.uri for endpoint in endpoints.values() if endpoint.missing
        },
        target_routeable_ref_uris={
            endpoint.ref.uri
            for endpoint in endpoints.values()
            if endpoint.activation.href is not None
        },
    )
    return ConnectionPage(
        items=tuple(
            _connection_for_row(
                row=row,
                query_direction=query.direction,
                endpoints=endpoints,
                expanded_keys=expanded_keys,
                citation_projection=citation_projections.get(row.id),
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
    activations = resource_activations_for_refs(
        db,
        viewer_id=viewer_id,
        refs=list(refs.values()),
        missing_ref_uris={
            ref.uri for ref, item in zip(refs.values(), resolved, strict=True) if item.missing
        },
    )
    endpoints: dict[str, ConnectionEndpoint] = {}
    for ref, item in zip(refs.values(), resolved, strict=True):
        activation = activations[ref.uri]
        endpoints[ref.uri] = ConnectionEndpoint(
            ref=ref,
            label=item.label,
            description=item.summary or None,
            activation=activation,
            href=activation.href,
            missing=item.missing,
        )
    return endpoints


def _connection_for_row(
    *,
    row: ResourceEdge,
    query_direction: str,
    endpoints: dict[str, ConnectionEndpoint],
    expanded_keys: set[tuple[ResourceScheme, UUID]],
    citation_projection: CitationTargetProjection | None,
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
    citation = (
        ConnectionCitation(
            ordinal=citation_projection.ordinal,
            role=citation_projection.role,
            snapshot=citation_projection.snapshot,
            activation=endpoints[target_ref.uri].activation,
            target_media_id=citation_projection.media_id,
            target_locator=citation_projection.locator,
            target_status=citation_projection.target_status,
        )
        if citation_projection is not None
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
            for child in expand_owned_child_refs(db, viewer_id=viewer_id, ref=ref):
                out.setdefault(child.uri, child)
    return tuple(out.values())


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
