"""Hydrated connection reads over ``resource_edges``, scoped to one viewer."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import Any, cast
from uuid import UUID

from sqlalchemy import and_, false, or_, select
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, ResourceEdge
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.services.assistant_write_authorship import assistant_edge_provenance
from nexus.services.resource_graph.citations import citation_reader_targets_for_edges
from nexus.services.resource_graph.edges import Pair, link_note_blocks_for_pairs
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.resolve import resolve_refs
from nexus.services.resource_graph.schemas import (
    Connection,
    ConnectionCitation,
    ConnectionDirection,
    ConnectionEndpoint,
    ConnectionLinkNote,
    ConnectionMutation,
    ConnectionPage,
    ConnectionQuery,
    DetachContextMutation,
    DismissDiscoveryMutation,
    EdgeKind,
    EdgeOrigin,
    UnlinkMutation,
    is_neutral_link,
    snapshot_from_jsonb,
)
from nexus.services.resource_items.capabilities import expand_owned_child_refs
from nexus.services.resource_items.routing import resource_activations_for_refs

_PREVIEW_CHARS = 200


def query_connections(db: Session, *, viewer_id: UUID, query: ConnectionQuery) -> ConnectionPage:
    if not query.refs:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "At least one ref is required")
    if len(query.refs) > 200:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "At most 200 refs are allowed")
    if query.limit < 1 or query.limit > 100:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "limit must be between 1 and 100")

    expanded: dict[str, ResourceRef] = {}
    for ref in query.refs:
        expanded.setdefault(ref.uri, ref)
        if query.rollup == "owner":
            for child in expand_owned_child_refs(db, viewer_id=viewer_id, ref=ref):
                expanded.setdefault(child.uri, child)
    rows = _query_rows(db, viewer_id=viewer_id, refs=tuple(expanded.values()), query=query)
    page_rows = rows[: query.limit]
    next_cursor = (
        f"{page_rows[-1].created_at.isoformat()}|{page_rows[-1].id}"
        if len(rows) > query.limit
        else None
    )
    return ConnectionPage(
        items=tuple(
            _hydrate_connections(
                db,
                viewer_id=viewer_id,
                rows=page_rows,
                refs=tuple(expanded.values()),
                direction=query.direction,
            )
        ),
        next_cursor=next_cursor,
    )


def connection_for_edge(
    db: Session, *, viewer_id: UUID, edge_id: UUID, ref: ResourceRef
) -> Connection:
    """Hydrate an exact owned edge from an incident endpoint's perspective."""
    row = db.scalar(
        select(ResourceEdge).where(
            ResourceEdge.id == edge_id,
            ResourceEdge.user_id == viewer_id,
            or_(
                and_(ResourceEdge.source_scheme == ref.scheme, ResourceEdge.source_id == ref.id),
                and_(ResourceEdge.target_scheme == ref.scheme, ResourceEdge.target_id == ref.id),
            ),
        )
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Connection not found")
    return _hydrate_connections(db, viewer_id=viewer_id, rows=[row], refs=(ref,), direction="both")[
        0
    ]


def _hydrate_connections(
    db: Session,
    *,
    viewer_id: UUID,
    rows: list[ResourceEdge],
    refs: tuple[ResourceRef, ...],
    direction: ConnectionDirection,
) -> list[Connection]:
    matched: set[Pair] = {(ref.scheme, ref.id) for ref in refs}
    endpoints = _hydrate_endpoints(db, viewer_id=viewer_id, rows=rows)
    link_notes = _link_notes_for_rows(db, viewer_id=viewer_id, rows=rows)
    citations = citation_reader_targets_for_edges(
        db,
        viewer_id=viewer_id,
        edges=rows,
        target_missing_ref_uris={
            endpoint.ref.uri for endpoint in endpoints.values() if endpoint.missing
        },
        target_routeable_ref_uris={
            endpoint.ref.uri
            for endpoint in endpoints.values()
            if endpoint.activation.href is not None
        },
    )

    items: list[Connection] = []
    for row in rows:
        source_ref = ResourceRef(scheme=cast("ResourceScheme", row.source_scheme), id=row.source_id)
        target_ref = ResourceRef(scheme=cast("ResourceScheme", row.target_scheme), id=row.target_id)
        neutral = is_neutral_link(row)
        incoming = (
            (target_ref.scheme, target_ref.id) in matched
            and (source_ref.scheme, source_ref.id) not in matched
            if neutral or direction == "both"
            else direction == "incoming"
        )
        projection = citations.get(row.id)
        creation = None
        if row.origin == "assistant":
            creation, mutation = assistant_edge_provenance(db, viewer_id=viewer_id, edge_id=row.id)
        else:
            mutation = _connection_mutation(row)
        items.append(
            Connection(
                edge_id=row.id,
                # A neutral Link is undirected: no presenter may read meaning from its
                # canonical storage direction. ``other`` still points at the far endpoint.
                direction=("undirected" if neutral else ("incoming" if incoming else "outgoing")),
                kind=cast("EdgeKind", row.kind),
                origin=cast("EdgeOrigin", row.origin),
                snapshot=snapshot_from_jsonb(row.snapshot) if row.snapshot is not None else None,
                source_order_key=row.source_order_key,
                ordinal=row.ordinal,
                source=endpoints[source_ref.uri],
                target=endpoints[target_ref.uri],
                other=endpoints[source_ref.uri if incoming else target_ref.uri],
                citation=(
                    ConnectionCitation(
                        ordinal=projection.ordinal,
                        role=projection.role,
                        snapshot=projection.snapshot,
                        activation=endpoints[target_ref.uri].activation,
                        target_media_id=projection.media_id,
                        target_locator=projection.locator,
                        target_status=projection.target_status,
                    )
                    if projection is not None
                    else None
                ),
                link_note=link_notes.get(row.id),
                creation=creation,
                mutation=mutation,
                created_at=row.created_at,
            )
        )
    return items


def _connection_mutation(row: ResourceEdge) -> ConnectionMutation | None:
    if is_neutral_link(row):
        return UnlinkMutation()
    if row.origin == "discovery":
        return DismissDiscoveryMutation()
    if (
        row.origin in ("citation", "system")
        and row.source_scheme == "conversation"
        and row.kind == "context"
        and row.ordinal is None
        and row.snapshot is None
    ):
        return DetachContextMutation(conversation_id=row.source_id)
    return None


def _query_rows(
    db: Session, *, viewer_id: UUID, refs: tuple[ResourceRef, ...], query: ConnectionQuery
) -> list[ResourceEdge]:
    neutral = and_(
        ResourceEdge.origin == "user",
        ResourceEdge.kind == "context",
        ResourceEdge.ordinal.is_(None),
        ResourceEdge.snapshot.is_(None),
        ResourceEdge.source_order_key.is_(None),
    )
    directions: list[Any] = []
    if query.direction in ("incoming", "both"):
        directions.append(
            _endpoint_clause(ResourceEdge.target_scheme, ResourceEdge.target_id, refs)
        )
    if query.direction in ("outgoing", "both"):
        directions.append(
            _endpoint_clause(ResourceEdge.source_scheme, ResourceEdge.source_id, refs)
        )
    if query.direction != "both":
        directions.append(
            and_(
                neutral,
                or_(
                    _endpoint_clause(ResourceEdge.source_scheme, ResourceEdge.source_id, refs),
                    _endpoint_clause(ResourceEdge.target_scheme, ResourceEdge.target_id, refs),
                ),
            )
        )
    stmt = select(ResourceEdge).where(
        ResourceEdge.user_id == viewer_id,
        or_(*directions),
    )
    if query.filters.origins is not None:
        stmt = stmt.where(ResourceEdge.origin.in_(query.filters.origins))
    if query.filters.kinds is not None:
        stmt = stmt.where(ResourceEdge.kind.in_(query.filters.kinds))
    forward, reverse = [], []
    if query.filters.source_schemes is not None:
        forward.append(ResourceEdge.source_scheme.in_(query.filters.source_schemes))
        reverse.append(ResourceEdge.target_scheme.in_(query.filters.source_schemes))
    if query.filters.target_schemes is not None:
        forward.append(ResourceEdge.target_scheme.in_(query.filters.target_schemes))
        reverse.append(ResourceEdge.source_scheme.in_(query.filters.target_schemes))
    if forward:
        stmt = stmt.where(or_(and_(*forward), and_(neutral, *reverse)))
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
        for scheme, resource_id in (
            (row.source_scheme, row.source_id),
            (row.target_scheme, row.target_id),
        ):
            refs.setdefault(
                f"{scheme}:{resource_id}",
                ResourceRef(scheme=cast("ResourceScheme", scheme), id=resource_id),
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
    return {
        ref.uri: ConnectionEndpoint(
            ref=ref,
            label=item.label,
            description=item.summary or None,
            activation=activations[ref.uri],
            href=activations[ref.uri].href,
            missing=item.missing,
        )
        for ref, item in zip(refs.values(), resolved, strict=True)
    }


def _link_notes_for_rows(
    db: Session, *, viewer_id: UUID, rows: list[ResourceEdge]
) -> dict[UUID, ConnectionLinkNote]:
    """Keep the neutral pair's note preview alongside its independent attachment facts."""
    pairs = {
        row.id: frozenset({(row.source_scheme, row.source_id), (row.target_scheme, row.target_id)})
        for row in rows
        if is_neutral_link(row)
    }
    if not pairs:
        return {}
    notes = link_note_blocks_for_pairs(db, viewer_id=viewer_id, pairs=list(pairs.values()))
    if not notes:
        return {}
    previews = {
        block_id: (body_text[:_PREVIEW_CHARS] if body_text else None)
        for block_id, body_text in db.execute(
            select(NoteBlock.id, NoteBlock.body_text).where(
                NoteBlock.id.in_({note_id for ids in notes.values() for note_id in ids})
            )
        ).all()
    }
    return {
        edge_id: ConnectionLinkNote(
            ref=ResourceRef(scheme="note_block", id=notes[pair][0]),
            preview=previews.get(notes[pair][0]),
        )
        for edge_id, pair in pairs.items()
        if pair in notes
    }


def _decode_cursor(raw: str) -> tuple[datetime, UUID]:
    created_raw, separator, edge_id_raw = raw.partition("|")
    if not separator:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid cursor")
    try:
        return datetime.fromisoformat(created_raw), UUID(edge_id_raw)
    except ValueError as exc:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid cursor") from exc
