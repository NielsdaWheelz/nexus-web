"""The connections read model: the viewer's edges around a set of refs, hydrated once
per page into ``ConnectionOut``. A user link is undirected and matches either way;
``other`` is always the far endpoint and ``mutation`` names the one command that may
remove the fact."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import Any, cast
from uuid import UUID

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, ResourceEdge
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.resource_graph import (
    CitationSnapshot,
    ConnectionDirection,
    ConnectionEndpointOut,
    ConnectionLinkNoteOut,
    ConnectionOut,
    ConnectionPageOut,
    ConnectionQueryRequest,
    DetachContextMutation,
    DismissDiscoveryMutation,
    EdgeKind,
    EdgeOrigin,
    UnlinkMutation,
)
from nexus.services.assistant_write_authorship import assistant_edge_provenance
from nexus.services.resource_graph.edges import Pair, link_note_blocks_for_pairs, link_pair
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref, require_ref
from nexus.services.resource_graph.resolve import resolve_refs
from nexus.services.resource_items.capabilities import expand_owned_child_refs
from nexus.services.resource_items.routing import resource_activations_for_refs


def query_connections(
    db: Session, *, viewer_id: UUID, query: ConnectionQueryRequest
) -> ConnectionPageOut:
    """One page, newest first; the cursor is ``"<created_at iso>|<edge id>"``. Unknown
    or invisible refs simply match nothing."""
    refs = {ref.uri: ref for ref in map(require_ref, query.refs)}
    if query.rollup == "owner":
        for ref in list(refs.values()):
            for child in expand_owned_child_refs(db, viewer_id=viewer_id, ref=ref):
                refs.setdefault(child.uri, child)
    ids_by_scheme: dict[str, list[UUID]] = {}
    for ref in refs.values():
        ids_by_scheme.setdefault(ref.scheme, []).append(ref.id)

    def at(scheme: Any, id_: Any) -> Any:  # per scheme, so an owner rollup stays indexed
        return or_(*(and_(scheme == s, id_.in_(ids)) for s, ids in ids_by_scheme.items()))

    at_source = at(ResourceEdge.source_scheme, ResourceEdge.source_id)
    at_target = at(ResourceEdge.target_scheme, ResourceEdge.target_id)
    link = ResourceEdge.origin == "user"
    incident = {
        "both": or_(at_source, at_target),
        "incoming": or_(at_target, and_(link, at_source)),
        "outgoing": or_(at_source, and_(link, at_target)),
    }[query.direction]
    stmt = select(ResourceEdge).where(ResourceEdge.user_id == viewer_id, incident)
    filters = query.filters
    if filters.origins is not None:
        stmt = stmt.where(ResourceEdge.origin.in_(filters.origins))
    if filters.kinds is not None:
        stmt = stmt.where(ResourceEdge.kind.in_(filters.kinds))
    # Scheme filters read a fact forward, and a link either way round.
    forward, reverse = [], []
    if filters.source_schemes is not None:
        forward.append(ResourceEdge.source_scheme.in_(filters.source_schemes))
        reverse.append(ResourceEdge.target_scheme.in_(filters.source_schemes))
    if filters.target_schemes is not None:
        forward.append(ResourceEdge.target_scheme.in_(filters.target_schemes))
        reverse.append(ResourceEdge.source_scheme.in_(filters.target_schemes))
    if forward:
        stmt = stmt.where(or_(and_(*forward), and_(link, *reverse)))
    if query.cursor is not None:
        created_at, edge_id = _decode_cursor(query.cursor)
        stmt = stmt.where(
            or_(
                ResourceEdge.created_at < created_at,
                and_(ResourceEdge.created_at == created_at, ResourceEdge.id < edge_id),
            )
        )
    rows = db.scalars(
        stmt.order_by(ResourceEdge.created_at.desc(), ResourceEdge.id.desc()).limit(query.limit + 1)
    ).all()
    page = rows[: query.limit]
    next_cursor = None
    if len(rows) > query.limit:
        next_cursor = f"{page[-1].created_at.isoformat()}|{page[-1].id}"
    matched = {(ref.scheme, ref.id) for ref in refs.values()}
    return ConnectionPageOut(
        items=_hydrate(db, viewer_id, page, matched, query.direction), next_cursor=next_cursor
    )


def connection_for_edge(
    db: Session, *, viewer_id: UUID, edge_id: UUID, ref: ResourceRef
) -> ConnectionOut:
    """One owned edge seen from its endpoint ``ref``; 404 unless owned and incident."""
    row = db.get(ResourceEdge, edge_id)
    if row is None or row.user_id != viewer_id or (ref.scheme, ref.id) not in link_pair(row):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Connection not found")
    return _hydrate(db, viewer_id, [row], {(ref.scheme, ref.id)}, "both")[0]


def _hydrate(
    db: Session,
    viewer_id: UUID,
    rows: Sequence[ResourceEdge],
    matched: set[Pair],
    direction: ConnectionDirection,
) -> list[ConnectionOut]:
    """Endpoints (without per-media document metrics), activations and link-note
    previews, each loaded once for the page."""
    refs = list(
        {
            uri: assert_resource_ref(uri)
            for row in rows
            for uri in (
                f"{row.source_scheme}:{row.source_id}",
                f"{row.target_scheme}:{row.target_id}",
            )
        }.values()
    )
    resolved = resolve_refs(
        db, viewer_id=viewer_id, refs=refs, include_media_document_summary=False
    )
    activations = resource_activations_for_refs(
        db,
        viewer_id=viewer_id,
        refs=refs,
        missing_ref_uris={item.uri for item in resolved if item.missing},
    )
    endpoints = {
        ref.uri: ConnectionEndpointOut(
            ref=ref.uri,
            label=item.label,
            description=item.summary or None,
            activation=activations[ref.uri],
            missing=item.missing,
        )
        for ref, item in zip(refs, resolved, strict=True)
    }
    pairs = {row.id: link_pair(row) for row in rows if row.origin == "user"}
    notes = link_note_blocks_for_pairs(db, viewer_id=viewer_id, pairs=list(pairs.values()))
    note_ids = [ids[0] for ids in notes.values()]
    previews: dict[UUID, str | None] = {}
    if note_ids:
        query = select(NoteBlock.id, NoteBlock.body_text).where(NoteBlock.id.in_(note_ids))
        previews = dict(db.execute(query).tuples().all())
    items = []
    for row in rows:
        source = f"{row.source_scheme}:{row.source_id}"
        target = f"{row.target_scheme}:{row.target_id}"
        incoming = direction == "incoming"
        if row.origin == "user" or direction == "both":
            far_end_is_source = (row.source_scheme, row.source_id) not in matched
            incoming = (row.target_scheme, row.target_id) in matched and far_end_is_source
        creation = mutation = None
        if row.origin == "assistant":
            creation, mutation = assistant_edge_provenance(db, viewer_id=viewer_id, edge_id=row.id)
        elif row.origin == "user":
            mutation = UnlinkMutation()
        elif row.origin == "discovery":
            mutation = DismissDiscoveryMutation()
        elif row.origin in ("citation", "system") and row.ordinal is None:
            mutation = DetachContextMutation(conversation_id=row.source_id)
        link_note = None
        if row.id in pairs and pairs[row.id] in notes:
            note = notes[pairs[row.id]][0]
            preview = (previews.get(note) or "")[:200] or None
            link_note = ConnectionLinkNoteOut(note_block_id=note, preview=preview)
        items.append(
            ConnectionOut(
                edge_id=row.id,
                direction="undirected"
                if row.origin == "user"
                else ("incoming" if incoming else "outgoing"),
                kind=cast(EdgeKind, row.kind),
                origin=cast(EdgeOrigin, row.origin),
                snapshot=CitationSnapshot.model_validate(row.snapshot)
                if row.snapshot is not None
                else None,
                source_order_key=row.source_order_key,
                ordinal=row.ordinal,
                source=endpoints[source],
                target=endpoints[target],
                other=endpoints[source if incoming else target],
                link_note=link_note,
                creation=creation,
                mutation=mutation,
                created_at=row.created_at,
            )
        )
    return items


def _decode_cursor(raw: str) -> tuple[datetime, UUID]:
    created_at, separator, edge_id = raw.partition("|")
    try:
        if separator:
            return datetime.fromisoformat(created_at), UUID(edge_id)
    except ValueError:
        pass
    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid cursor")
