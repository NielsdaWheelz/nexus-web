"""Hydrated target/source connection reads over ``resource_edges``."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import Any, cast
from uuid import UUID

from sqlalchemy import and_, false, or_, select, tuple_
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, ResourceEdge
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.services.resource_graph.citations import citation_reader_target_for_edge
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.resolve import resolve_refs
from nexus.services.resource_graph.schemas import (
    Connection,
    ConnectionCitation,
    ConnectionEndpoint,
    ConnectionLinkNote,
    ConnectionPage,
    ConnectionQuery,
    EdgeKind,
    EdgeOrigin,
    is_neutral_link_shape,
    snapshot_from_jsonb,
)
from nexus.services.resource_items.capabilities import expand_owned_child_refs
from nexus.services.resource_items.routing import resource_activation_for_ref


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
    link_notes = _link_notes_for_rows(db, viewer_id=viewer_id, rows=page_rows)
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
                link_note=link_notes.get(row.id),
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
    # Structural Link-note attachment edges never render as their own connection
    # (Invariant 12); they are folded onto their Link by _link_notes_for_rows.
    stmt = stmt.where(ResourceEdge.origin != "link_note")
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
    endpoints: dict[str, ConnectionEndpoint] = {}
    for ref, item in zip(refs.values(), resolved, strict=True):
        activation = resource_activation_for_ref(
            db,
            viewer_id=viewer_id,
            ref=ref,
            missing=item.missing,
        )
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
    db: Session,
    *,
    viewer_id: UUID,
    row: ResourceEdge,
    query_direction: str,
    endpoints: dict[str, ConnectionEndpoint],
    expanded_keys: set[tuple[ResourceScheme, UUID]],
    link_note: ConnectionLinkNote | None,
) -> Connection:
    source_ref = ResourceRef(scheme=cast("ResourceScheme", row.source_scheme), id=row.source_id)
    target_ref = ResourceRef(scheme=cast("ResourceScheme", row.target_scheme), id=row.target_id)
    source_matched = (source_ref.scheme, source_ref.id) in expanded_keys
    target_matched = (target_ref.scheme, target_ref.id) in expanded_keys
    matched_incoming = query_direction == "incoming" or (
        query_direction == "both" and target_matched and not source_matched
    )
    # A neutral Link is undirected: presenters never infer meaning from its
    # canonical storage direction (§ Reader Projection). ``other`` still points at
    # the far endpoint so activation/backlink rendering is unchanged.
    direction = (
        "undirected"
        if _is_neutral_link_row(row)
        else ("incoming" if matched_incoming else "outgoing")
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
            activation=endpoints[target_ref.uri].activation,
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
        other=source if matched_incoming else target,
        citation=citation,
        link_note=link_note,
        created_at=row.created_at,
    )


def _is_neutral_link_row(row: ResourceEdge) -> bool:
    """The exact canonical neutral-Link predicate (mirrors the unique index)."""
    return is_neutral_link_shape(row)


_Pair = tuple[str, UUID]
_PREVIEW_CHARS = 200


def _link_notes_for_rows(
    db: Session, *, viewer_id: UUID, rows: list[ResourceEdge]
) -> dict[UUID, ConnectionLinkNote]:
    """Fold each neutral Link's link-note motif into a per-edge payload (Invariant 12).

    A Link's note is the ``note_block`` that carries an ``origin='link_note'``
    attachment edge to BOTH of the Link's endpoints. The structural rows are
    never surfaced on their own; this returns ``edge_id -> ConnectionLinkNote``
    only for the neutral Links present in ``rows``.
    """
    link_rows = [row for row in rows if _is_neutral_link_row(row)]
    if not link_rows:
        return {}

    endpoints: set[_Pair] = set()
    for row in link_rows:
        endpoints.add((row.source_scheme, row.source_id))
        endpoints.add((row.target_scheme, row.target_id))

    targets_by_note: dict[_Pair, set[_Pair]] = defaultdict(set)
    for ss, si, ts, ti in db.execute(
        select(
            ResourceEdge.source_scheme,
            ResourceEdge.source_id,
            ResourceEdge.target_scheme,
            ResourceEdge.target_id,
        ).where(
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.origin == "link_note",
            tuple_(ResourceEdge.target_scheme, ResourceEdge.target_id).in_(endpoints),
        )
    ).all():
        targets_by_note[(ss, si)].add((ts, ti))

    note_for_edge: dict[UUID, _Pair] = {}
    for row in link_rows:
        pair = {(row.source_scheme, row.source_id), (row.target_scheme, row.target_id)}
        for note_key, note_targets in targets_by_note.items():
            if pair <= note_targets:
                note_for_edge[row.id] = note_key
                break

    previews = _note_previews(db, note_keys=set(note_for_edge.values()))
    return {
        edge_id: ConnectionLinkNote(
            ref=ResourceRef(scheme=cast("ResourceScheme", note_key[0]), id=note_key[1]),
            preview=previews.get(note_key[1]),
        )
        for edge_id, note_key in note_for_edge.items()
    }


def _note_previews(db: Session, *, note_keys: set[_Pair]) -> dict[UUID, str | None]:
    ids = [key[1] for key in note_keys if key[0] == "note_block"]
    if not ids:
        return {}
    return {
        block_id: (body_text[:_PREVIEW_CHARS] if body_text else None)
        for block_id, body_text in db.execute(
            select(NoteBlock.id, NoteBlock.body_text).where(NoteBlock.id.in_(ids))
        ).all()
    }


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
