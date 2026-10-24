"""The connections read model: the viewer's edges around a set of refs, hydrated once
per page into ``ConnectionOut``. A user link is undirected and matches either way;
``other`` is always the far endpoint and ``mutation`` names the one command that may
remove the fact."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import UUID as SqlUUID
from sqlalchemy import String, and_, or_, select, text
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from nexus.auth.permissions import highlight_visibility_filter
from nexus.db.models import Highlight, PassageAnchor, ResourceEdge, ResourceVersion
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.resource_graph import (
    CitationSnapshot,
    ConnectionDirection,
    ConnectionOut,
    ConnectionPageOut,
    ConnectionQueryRequest,
    DetachContextMutation,
    EdgeKind,
    EdgeOrigin,
    UnlinkMutation,
)
from nexus.schemas.resource_items import CitationSourceTargetKey
from nexus.services.resource_graph.edges import Pair
from nexus.services.resource_graph.owners import owner_rows_sql
from nexus.services.resource_graph.refs import assert_resource_ref, require_ref
from nexus.services.resource_items.capabilities import expand_owned_child_refs
from nexus.services.resource_items.evidence import evidence_items
from nexus.services.resource_items.items import resource_items_out
from nexus.services.tools import assistant_writes


def query_connections(
    db: Session, *, viewer_id: UUID, query: ConnectionQueryRequest
) -> ConnectionPageOut:
    """One page, newest first; the cursor is ``"<created_at iso>|<edge id>"``. Unknown
    or invisible refs simply match nothing."""
    refs = {ref.uri: ref for ref in map(require_ref, query.refs)}
    visible = {
        item.ref
        for item in resource_items_out(db, viewer_id=viewer_id, refs=list(refs.values()))
        if not item.missing
    }
    refs = {uri: ref for uri, ref in refs.items() if uri in visible}
    if not refs:
        return ConnectionPageOut(items=[], next_cursor=None)
    owner_ids: dict[str, list[UUID]] = {}
    if query.rollup == "owner":
        for ref in list(refs.values()):
            if ref.scheme in ("media", "note_block"):
                owner_ids.setdefault(ref.scheme, []).append(ref.id)
                continue
            # Page graph closure has its own expansion semantics, distinct
            # from an endpoint-to-work mapping.
            for child in expand_owned_child_refs(db, viewer_id=viewer_id, ref=ref):
                refs.setdefault(child.uri, child)
    ids_by_scheme: dict[str, list[UUID]] = {}
    for ref in refs.values():
        ids_by_scheme.setdefault(ref.scheme, []).append(ref.id)

    def at(side: Literal["source", "target"]) -> ColumnElement[bool]:
        scheme = getattr(ResourceEdge, f"{side}_scheme")
        id_ = getattr(ResourceEdge, f"{side}_id")
        exact = or_(*(and_(scheme == s, id_.in_(ids)) for s, ids in ids_by_scheme.items()))
        if not owner_ids:
            return exact
        # Resolve only graph endpoints, never enumerate an owner's entire
        # content index into Python objects and repeated SQL bind lists.
        owner = (
            text(
                owner_rows_sql(
                    f"SELECT resource_edges.{side}_scheme AS scheme, resource_edges.{side}_id AS id"
                )
            )
            .columns(scheme=String, id=SqlUUID, owner_scheme=String, owner_id=SqlUUID)
            .subquery(f"{side}_owner")
        )
        owned = []
        if media_ids := owner_ids.get("media"):
            owned.append(and_(owner.c.owner_scheme == "media", owner.c.owner_id.in_(media_ids)))
        if note_ids := owner_ids.get("note_block"):
            owned.append(
                and_(
                    owner.c.owner_scheme == "note_block",
                    owner.c.owner_id.in_(note_ids),
                    scheme.in_(("evidence_span", "content_chunk")),
                )
            )
        visible_highlight = (
            select(Highlight.id)
            .where(
                Highlight.id == id_,
                highlight_visibility_filter(viewer_id),
            )
            .correlate(ResourceEdge)
            .exists()
        )
        owned_passage = (
            select(PassageAnchor.id)
            .where(PassageAnchor.id == id_, PassageAnchor.user_id == viewer_id)
            .correlate(ResourceEdge)
            .exists()
        )
        return or_(
            exact,
            select(1)
            .select_from(owner)
            .where(
                or_(*owned),
                or_(scheme != "highlight", visible_highlight),
                or_(scheme != "passage_anchor", owned_passage),
            )
            .correlate(ResourceEdge)
            .exists(),
        )

    at_source = at("source")
    at_target = at("target")
    link = ResourceEdge.origin == "user"
    incident = {
        "both": or_(at_source, at_target),
        "incoming": or_(at_target, and_(link, at_source)),
        "outgoing": or_(at_source, and_(link, at_target)),
    }[query.direction]
    stmt = select(ResourceEdge, at_source, at_target).where(
        ResourceEdge.user_id == viewer_id, incident
    )
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
    rows = db.execute(
        stmt.order_by(ResourceEdge.created_at.desc(), ResourceEdge.id.desc()).limit(query.limit + 1)
    ).all()
    page = [row[0] for row in rows[: query.limit]]
    next_cursor = None
    if len(rows) > query.limit:
        next_cursor = f"{page[-1].created_at.isoformat()}|{page[-1].id}"
    matched: set[Pair] = set()
    for edge, source_matches, target_matches in rows[: query.limit]:
        if source_matches:
            matched.add(cast(Pair, (edge.source_scheme, edge.source_id)))
        if target_matches:
            matched.add(cast(Pair, (edge.target_scheme, edge.target_id)))
    return ConnectionPageOut(
        items=hydrate_connections(db, viewer_id, page, matched, query.direction),
        next_cursor=next_cursor,
    )


def hydrate_connections(
    db: Session,
    viewer_id: UUID,
    rows: Sequence[ResourceEdge],
    matched: set[Pair],
    direction: ConnectionDirection,
) -> list[ConnectionOut]:
    """Endpoints, canonical live media bodies and activations, batched for the page."""
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
    endpoints = {item.ref: item for item in resource_items_out(db, viewer_id=viewer_id, refs=refs)}
    citation_rows = [row for row in rows if row.origin == "citation" and row.ordinal is not None]
    occurrences = []
    for row in citation_rows:
        snapshot = CitationSnapshot.model_validate(row.snapshot)
        assert snapshot.evidence is not None
        occurrences.append(
            (
                assert_resource_ref(f"{row.target_scheme}:{row.target_id}"),
                snapshot.evidence,
                CitationSourceTargetKey(edge_id=row.id),
            )
        )
    captured = dict(
        zip(
            [row.id for row in citation_rows],
            evidence_items(db, viewer_id=viewer_id, occurrences=occurrences),
            strict=True,
        )
    )
    chat_ids = {
        row.source_id
        for row in rows
        if row.origin in ("citation", "system")
        and row.ordinal is None
        and row.source_scheme == "conversation"
    }
    chat_versions = dict.fromkeys(chat_ids, 1)
    if chat_ids:
        chat_versions.update(
            db.execute(
                select(ResourceVersion.resource_id, ResourceVersion.version).where(
                    ResourceVersion.user_id == viewer_id,
                    ResourceVersion.resource_scheme == "conversation",
                    ResourceVersion.resource_id.in_(chat_ids),
                    ResourceVersion.lane == "context",
                )
            )
            .tuples()
            .all()
        )
    provenance = assistant_writes.edge_provenance(
        db, viewer_id, [row.id for row in rows if row.origin == "assistant"]
    )
    items = []
    for row in rows:
        source = f"{row.source_scheme}:{row.source_id}"
        target = f"{row.target_scheme}:{row.target_id}"
        incoming = direction == "incoming"
        if row.origin == "user" or direction == "both":
            far_end_is_source = (row.source_scheme, row.source_id) not in matched
            incoming = (row.target_scheme, row.target_id) in matched and far_end_is_source
        creation = provenance.get(row.id) if row.origin == "assistant" else None
        mutation = None
        if row.origin in ("user", "discovery", "assistant"):
            mutation = UnlinkMutation()
        elif row.origin in ("citation", "system") and row.ordinal is None:
            mutation = DetachContextMutation(
                conversation_id=row.source_id,
                target_ref=target,
                expected_context_version=chat_versions[row.source_id],
            )
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
                ordinal=row.ordinal,
                source=endpoints[source],
                target=captured.get(row.id, endpoints[target]),
                other=endpoints[source] if incoming else captured.get(row.id, endpoints[target]),
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
