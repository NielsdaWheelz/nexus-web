"""Hydrated target/source connection reads over ``resource_edges``."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import Any, cast
from uuid import UUID

from sqlalchemy import Integer, and_, column, false, func, or_, select, true, union_all, values
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, ResourceEdge
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.services.resource_graph.citations import citation_reader_targets_for_edges
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.resolve import resolve_refs
from nexus.services.resource_graph.schemas import (
    CitationTargetProjection,
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
from nexus.services.resource_items.capabilities import owned_child_ref_queries
from nexus.services.resource_items.routing import resource_activations_for_refs


def query_connections(db: Session, *, viewer_id: UUID, query: ConnectionQuery) -> ConnectionPage:
    if not query.refs:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "At least one ref is required")
    if len(query.refs) > 200:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "At most 200 refs are allowed")
    if query.limit < 1 or query.limit > 100:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "limit must be between 1 and 100")

    matches = _query_rows(db, viewer_id=viewer_id, query=query)
    page_matches = matches[: query.limit]
    page_rows = [row for row, _source_matched, _target_matched in page_matches]
    next_cursor = _encode_cursor(page_rows[-1]) if len(matches) > query.limit else None
    endpoints = _hydrate_endpoints(db, viewer_id=viewer_id, rows=page_rows)
    link_notes = _link_notes_for_rows(db, viewer_id=viewer_id, rows=page_rows)
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
                source_matched=source_matched,
                target_matched=target_matched,
                citation_projection=citation_projections.get(row.id),
                link_note=link_notes.get(row.id),
            )
            for row, source_matched, target_matched in page_matches
        ),
        next_cursor=next_cursor,
    )


def _query_rows(
    db: Session, *, viewer_id: UUID, query: ConnectionQuery
) -> list[tuple[ResourceEdge, bool, bool]]:
    children = (
        [
            child
            for ref in query.refs
            for child in owned_child_ref_queries(viewer_id=viewer_id, ref=ref)
        ]
        if query.rollup == "owner"
        else []
    )
    child_refs = union_all(*children).subquery() if children else None

    def endpoint_matches(scheme_column: Any, id_column: Any) -> Any:
        direct = _endpoint_clause(scheme_column, id_column, query.refs)
        if child_refs is None:
            return direct
        return or_(
            direct,
            select(child_refs.c.id)
            .where(
                child_refs.c.scheme == scheme_column,
                child_refs.c.id == id_column,
            )
            .exists(),
        )

    source_matched = endpoint_matches(ResourceEdge.source_scheme, ResourceEdge.source_id)
    target_matched = endpoint_matches(ResourceEdge.target_scheme, ResourceEdge.target_id)
    direction_clauses: list[Any] = []
    if query.direction in ("incoming", "both"):
        direction_clauses.append(target_matched)
    if query.direction in ("outgoing", "both"):
        direction_clauses.append(source_matched)
    stmt = select(ResourceEdge, source_matched, target_matched).where(
        ResourceEdge.user_id == viewer_id, or_(*direction_clauses)
    )
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
        .tuples()
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
    source_matched: bool,
    target_matched: bool,
    citation_projection: CitationTargetProjection | None,
    link_note: ConnectionLinkNote | None,
) -> Connection:
    source_ref = ResourceRef(scheme=cast("ResourceScheme", row.source_scheme), id=row.source_id)
    target_ref = ResourceRef(scheme=cast("ResourceScheme", row.target_scheme), id=row.target_id)
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
        other=source if matched_incoming else target,
        citation=citation,
        link_note=link_note,
        created_at=row.created_at,
    )


def _is_neutral_link_row(row: ResourceEdge) -> bool:
    """The exact canonical neutral-Link predicate (mirrors the unique index)."""
    return is_neutral_link_shape(
        origin=row.origin,
        kind=row.kind,
        ordinal=row.ordinal,
        snapshot=row.snapshot,
        source_order_key=row.source_order_key,
        target_order_key=row.target_order_key,
    )


_PREVIEW_CHARS = 200


def link_note_ids_for_pairs(
    db: Session, *, viewer_id: UUID, pairs: tuple[tuple[ResourceRef, ResourceRef], ...]
) -> tuple[UUID | None, ...]:
    """Resolve each requested motif in SQL, without loading all attachment rows.

    The authoring owner permits one note per Link. If older data contains more,
    the earliest first-endpoint attachment (created_at, id) wins in both readers
    and mutations. The endpoint order is the Link's canonical storage order.
    """
    if not pairs:
        return ()
    edge = ResourceEdge.__table__
    wanted = values(
        column("ordinal", Integer),
        column("source_scheme", edge.c.source_scheme.type),
        column("source_id", edge.c.source_id.type),
        column("target_scheme", edge.c.target_scheme.type),
        column("target_id", edge.c.target_id.type),
        name="wanted_link_note",
    ).data([(ordinal, a.scheme, a.id, b.scheme, b.id) for ordinal, (a, b) in enumerate(pairs)])
    first = edge.alias("first_attachment")
    second = edge.alias("second_attachment")
    match = (
        select(first.c.source_id.label("note_id"))
        .where(
            first.c.user_id == viewer_id,
            first.c.origin == "link_note",
            first.c.source_scheme == "note_block",
            first.c.target_scheme == wanted.c.source_scheme,
            first.c.target_id == wanted.c.source_id,
            select(second.c.id)
            .where(
                second.c.user_id == viewer_id,
                second.c.origin == "link_note",
                second.c.source_scheme == "note_block",
                second.c.source_id == first.c.source_id,
                second.c.target_scheme == wanted.c.target_scheme,
                second.c.target_id == wanted.c.target_id,
            )
            .correlate(first, wanted)
            .exists(),
        )
        .order_by(first.c.created_at, first.c.id)
        .limit(1)
        .correlate(wanted)
        .lateral("matched_link_note")
    )
    found = {
        ordinal: note_id
        for ordinal, note_id in db.execute(
            select(wanted.c.ordinal, match.c.note_id).select_from(wanted.join(match, true()))
        )
    }
    return tuple(found.get(ordinal) for ordinal in range(len(pairs)))


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

    note_ids = link_note_ids_for_pairs(
        db,
        viewer_id=viewer_id,
        pairs=tuple(
            (
                ResourceRef(scheme=cast("ResourceScheme", row.source_scheme), id=row.source_id),
                ResourceRef(scheme=cast("ResourceScheme", row.target_scheme), id=row.target_id),
            )
            for row in link_rows
        ),
    )
    present = {note_id for note_id in note_ids if note_id is not None}
    previews = (
        {
            note_id: preview
            for note_id, preview in db.execute(
                select(NoteBlock.id, func.substr(NoteBlock.body_text, 1, _PREVIEW_CHARS)).where(
                    NoteBlock.id.in_(present)
                )
            )
        }
        if present
        else {}
    )
    return {
        row.id: ConnectionLinkNote(
            ref=ResourceRef(scheme="note_block", id=note_id),
            preview=previews.get(note_id) or None,
        )
        for row, note_id in zip(link_rows, note_ids, strict=True)
        if note_id is not None
    }


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
