"""Viewer-scoped connection order, visible outline bodies and bounded rich readers.

All three use the same edge ownership and endpoint incidence. An authored link is
undirected. An ordinal citation displays its admitted frozen evidence; a message
citation has no frozen snapshot. Child existence checks never hydrate their results.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Literal, cast
from unicodedata import normalize
from uuid import UUID

from sqlalchemy import UUID as SqlUUID
from sqlalchemy import String, and_, bindparam, literal, or_, select, text, union_all
from sqlalchemy.orm import Session
from sqlalchemy.sql import Select
from sqlalchemy.sql.elements import ColumnElement

from nexus.auth.permissions import highlight_visibility_filter
from nexus.db.models import Highlight, PassageAnchor, ResourceEdge
from nexus.schemas.resource_graph import (
    CitationSnapshot,
    ConnectionDirection,
    ConnectionFiltersRequest,
    ConnectionIndexOut,
    ConnectionOut,
    ConnectionQueryRequest,
    ConnectionResolveOut,
    ConnectionResolveRequest,
    ConnectionScope,
    EdgeKind,
    EdgeOrigin,
    RelationQuery,
    RemoteChildrenItem,
    RemoteChildrenOut,
    RemoteChildrenRequest,
    RemoveFactMutation,
    ResolvedConnectionOut,
)
from nexus.schemas.resource_items import CitationSourceTargetKey, ResourceItemOut
from nexus.services.reader_excerpts import text_parts
from nexus.services.resource_graph.citations import citation_endpoint_match, edge_readable_filter
from nexus.services.resource_graph.edges import Pair
from nexus.services.resource_graph.liveness import AUTHORED_LINK_ORIGINS, edge_live_sql
from nexus.services.resource_graph.owners import owner_rows_sql
from nexus.services.resource_graph.refs import assert_resource_ref, require_ref
from nexus.services.resource_items.capabilities import (
    PAGE_NOTE_BLOCKS_SQL,
    capability,
    expand_owned_child_refs,
)
from nexus.services.resource_items.evidence import admit_citation_snapshot, evidence_items
from nexus.services.resource_items.items import resource_items_out, visible_refs
from nexus.services.tools import assistant_writes


def _connection_statement(
    db: Session,
    *,
    viewer_id: UUID,
    query: ConnectionScope,
    visible: set[str] | None = None,
) -> Select[tuple[ResourceEdge, bool, bool]] | None:
    refs = {ref.uri: ref for ref in map(require_ref, query.refs)}
    if visible is None:
        visible = visible_refs(db, viewer_id=viewer_id, refs=list(refs.values()))
    refs = {uri: ref for uri, ref in refs.items() if uri in visible}
    if not refs:
        return None
    owner_ids: dict[str, list[UUID]] = {}
    page_ids: list[UUID] = []
    if query.rollup == "owner":
        for ref in list(refs.values()):
            if ref.scheme in ("media", "note_block"):
                owner_ids.setdefault(ref.scheme, []).append(ref.id)
                continue
            if ref.scheme == "page":
                page_ids.append(ref.id)
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
        exact = or_(exact, citation_endpoint_match(list(refs.values()), side))
        if page_ids:
            page_children = []
            for page_id in page_ids:
                children = (
                    text(PAGE_NOTE_BLOCKS_SQL)
                    .bindparams(
                        bindparam("id", page_id, unique=True),
                        bindparam("viewer_id", viewer_id, unique=True),
                    )
                    .columns(id=SqlUUID)
                    .subquery()
                )
                page_children.append(id_.in_(select(children.c.id)))
            exact = or_(exact, and_(scheme == "note_block", or_(*page_children)))
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
    link = ResourceEdge.origin.in_(AUTHORED_LINK_ORIGINS)
    incident = {
        "both": or_(at_source, at_target),
        "incoming": or_(at_target, and_(link, at_source)),
        "outgoing": or_(at_source, and_(link, at_target)),
    }[query.direction]
    stmt = select(ResourceEdge, at_source, at_target).where(
        edge_readable_filter(viewer_id), incident, text(edge_live_sql("resource_edges"))
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
    return stmt


def index_connections(
    db: Session, *, viewer_id: UUID, query: ConnectionQueryRequest
) -> ConnectionIndexOut:
    stmt = _connection_statement(db, viewer_id=viewer_id, query=query)
    match_text = query.match_text
    if stmt is None:
        return ConnectionIndexOut(edge_ids=[], matching_edge_ids=None if match_text is None else [])
    ordered = stmt.order_by(ResourceEdge.created_at.desc(), ResourceEdge.id.desc())
    if match_text is None:
        return ConnectionIndexOut(
            edge_ids=list(db.scalars(ordered.with_only_columns(ResourceEdge.id))),
            matching_edge_ids=None,
        )

    # The filter searches only the words the outline can show, after the same
    # current admission and excerpt clipping as a visible occurrence.
    query_text = normalize("NFC", match_text).lower()
    edge_ids: list[UUID] = []
    matching: list[UUID] = []
    for batch in db.execute(ordered.execution_options(yield_per=100)).tuples().partitions():
        others = _outline_others(db, viewer_id, batch, query.direction)
        quotes = {
            item: other.preview.body.excerpt.body
            for item, other in enumerate(others)
            if other.preview.body.kind == "passage" and other.preview.body.excerpt.kind == "content"
        }
        exact = dict(
            zip(quotes, (parts.exact for parts in text_parts(list(quotes.values()))), strict=True)
        )
        for i, ((edge, _, _), other) in enumerate(zip(batch, others, strict=True)):
            edge_ids.append(edge.id)
            if not other.missing and any(
                query_text in normalize("NFC", value).lower()
                for value in (other.label, exact.get(i, ""))
            ):
                matching.append(edge.id)
    return ConnectionIndexOut(edge_ids=edge_ids, matching_edge_ids=matching)


def resolve_connections(
    db: Session, *, viewer_id: UUID, request: ConnectionResolveRequest
) -> ConnectionResolveOut:
    stmt = _connection_statement(db, viewer_id=viewer_id, query=request)
    if stmt is None:
        return ConnectionResolveOut(items=[])
    selected = {
        row[0].id: row
        for row in db.execute(stmt.where(ResourceEdge.id.in_(request.edge_ids))).tuples()
    }
    rows = [selected[id_] for id_ in request.edge_ids if id_ in selected]
    others = _outline_others(db, viewer_id, rows, request.direction)
    provenance = assistant_writes.edge_provenance(
        db, viewer_id, [edge.id for edge, _, _ in rows if edge.origin == "assistant"]
    )
    return ConnectionResolveOut(
        items=[
            ResolvedConnectionOut(
                edge_id=edge.id,
                origin=cast(EdgeOrigin, edge.origin),
                ordinal=edge.ordinal,
                creation=provenance.get(edge.id),
                mutation=RemoveFactMutation()
                if edge.origin in ("discovery", "assistant")
                else None,
                other=other,
                rationale=edge.snapshot.get("rationale") if edge.snapshot is not None else None,
            )
            for (edge, _, _), other in zip(rows, others, strict=True)
        ]
    )


def _outline_others(
    db: Session,
    viewer_id: UUID,
    rows: Sequence[tuple[ResourceEdge, bool, bool]],
    direction: ConnectionDirection,
) -> list[ResourceItemOut]:
    refs = {}
    sides = []
    captures = []
    captured_ids = []
    for edge, source_matches, target_matches in rows:
        incoming = (
            target_matches and not source_matches
            if direction == "both" or edge.origin in AUTHORED_LINK_ORIGINS
            else direction == "incoming"
        )
        ref = assert_resource_ref(
            f"{edge.source_scheme}:{edge.source_id}"
            if incoming
            else f"{edge.target_scheme}:{edge.target_id}"
        )
        sides.append((ref.uri, incoming))
        if not incoming and edge.origin == "citation" and edge.snapshot is not None:
            evidence = CitationSnapshot.model_validate(edge.snapshot).evidence
            assert evidence is not None
            captures.append(
                (ref, evidence, CitationSourceTargetKey(edge_id=edge.id, side="target"))
            )
            captured_ids.append(edge.id)
        else:
            refs[ref.uri] = ref
    endpoints = {
        item.ref: item
        for item in resource_items_out(db, viewer_id=viewer_id, refs=list(refs.values()))
    }
    captured = dict(
        zip(
            captured_ids, evidence_items(db, viewer_id=viewer_id, occurrences=captures), strict=True
        )
    )
    items = []
    for (edge, _, _), (ref, incoming) in zip(rows, sides, strict=True):
        if edge.id in captured:
            items.append(captured[edge.id])
        else:
            item = endpoints[ref]
            items.append(_source_occurrence(item, edge) if incoming else item)
    return items


def list_relations(db: Session, *, viewer_id: UUID, query: RelationQuery) -> list[ConnectionOut]:
    """The tools' bounded rich read, newest first."""
    stmt = _connection_statement(db, viewer_id=viewer_id, query=query)
    if stmt is None:
        return []
    rows = db.execute(
        stmt.order_by(ResourceEdge.created_at.desc(), ResourceEdge.id.desc()).limit(query.limit)
    ).all()
    matched: set[Pair] = set()
    for edge, source_matches, target_matches in rows:
        if source_matches:
            matched.add(cast(Pair, (edge.source_scheme, edge.source_id)))
        if target_matches:
            matched.add(cast(Pair, (edge.target_scheme, edge.target_id)))
    return hydrate_connections(db, viewer_id, [row[0] for row in rows], matched, query.direction)


def query_remote_children(
    db: Session, *, viewer_id: UUID, request: RemoteChildrenRequest
) -> RemoteChildrenOut:
    """Complete server-fact existence, sharing connection admission and owner rollup.

    Canonical authored links are excluded. One repeatable snapshot pairs batched
    endpoint visibility with EXISTS probes; no child bodies or prefixes are read.
    """
    from nexus.services.search.pickers import source_identities

    refs = list({require_ref(item.resource_ref) for item in request.occurrences})
    visible = visible_refs(db, viewer_id=viewer_id, refs=refs)

    candidates = [
        ref
        for ref in refs
        if ref.uri in visible and capability(ref.scheme).link_mode == "materialize_passage"
    ]
    identities = source_identities(db, viewer_id=viewer_id, refs=candidates)
    items = []
    for item in request.occurrences:
        identity = identities.get(item.resource_ref)
        local_ref = None
        if isinstance(identity, tuple):
            _, anchor = identity
            if anchor is not None and anchor.uri != item.resource_ref:
                local_ref = anchor.uri
        items.append(RemoteChildrenItem(has_children=None, local_ref=local_ref))
    probes = []
    for index, item in enumerate(request.occurrences):
        query = ConnectionScope(
            refs=[item.resource_ref],
            direction="both",
            rollup="owner",
            filters=ConnectionFiltersRequest(
                origins=["citation", "discovery", "assistant", "document_embed"]
            ),
        )
        stmt = _connection_statement(db, viewer_id=viewer_id, query=query, visible=visible)
        if stmt is None:
            continue
        if item.excluded_edge_ids:
            stmt = stmt.where(ResourceEdge.id.not_in(item.excluded_edge_ids))
        probes.append(select(literal(index).label("index"), stmt.exists().label("present")))
    if probes:
        for index, present in db.execute(union_all(*probes)):
            items[index].has_children = present
    return RemoteChildrenOut(items=items)


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
    citation_rows = [row for row in rows if row.origin == "citation"]
    # Reader inventory supplies its presentation refs. Resolve additional primary
    # membership here too, so its direction agrees with paginated connection reads.
    membership: dict[UUID, tuple[bool, bool]] = {}
    if citation_rows:
        queried = [assert_resource_ref(f"{scheme}:{id_}") for scheme, id_ in matched]
        for edge_id, source_matches, target_matches in db.execute(
            select(
                ResourceEdge.id,
                citation_endpoint_match(queried, "source"),
                citation_endpoint_match(queried, "target"),
            ).where(ResourceEdge.id.in_([row.id for row in citation_rows]))
        ):
            membership[edge_id] = (source_matches, target_matches)
    occurrences = []
    admitted_snapshots = {}
    captured_rows = [row for row in citation_rows if row.snapshot is not None]
    for row in captured_rows:
        snapshot = CitationSnapshot.model_validate(row.snapshot)
        admitted_snapshots[row.id] = admit_citation_snapshot(
            db, viewer_id=viewer_id, snapshot=snapshot
        )
        assert snapshot.evidence is not None
        occurrences.append(
            (
                assert_resource_ref(f"{row.target_scheme}:{row.target_id}"),
                snapshot.evidence,
                CitationSourceTargetKey(edge_id=row.id, side="target"),
            )
        )
    captured = dict(
        zip(
            [row.id for row in captured_rows],
            evidence_items(db, viewer_id=viewer_id, occurrences=occurrences),
            strict=True,
        )
    )
    provenance = assistant_writes.edge_provenance(
        db, viewer_id, [row.id for row in rows if row.origin == "assistant"]
    )
    items = []
    for row in rows:
        source = f"{row.source_scheme}:{row.source_id}"
        target = f"{row.target_scheme}:{row.target_id}"
        incoming = direction == "incoming"
        authored = row.origin in AUTHORED_LINK_ORIGINS
        if authored or direction == "both":
            extra_source, extra_target = membership.get(row.id, (False, False))
            source_matches = (row.source_scheme, row.source_id) in matched or extra_source
            target_matches = (row.target_scheme, row.target_id) in matched or extra_target
            incoming = target_matches and not source_matches
        source_item = _source_occurrence(endpoints[source], row)
        creation = provenance.get(row.id) if row.origin == "assistant" else None
        mutation = RemoveFactMutation() if row.origin in ("discovery", "assistant") else None
        items.append(
            ConnectionOut(
                edge_id=row.id,
                direction="undirected" if authored else ("incoming" if incoming else "outgoing"),
                kind=cast(EdgeKind, row.kind),
                origin=cast(EdgeOrigin, row.origin),
                snapshot=admitted_snapshots.get(
                    row.id, CitationSnapshot.model_validate(row.snapshot)
                )
                if row.snapshot is not None
                else None,
                ordinal=row.ordinal,
                source=source_item,
                target=captured.get(row.id, endpoints[target]),
                other=source_item if incoming else captured.get(row.id, endpoints[target]),
                creation=creation,
                mutation=mutation,
                created_at=row.created_at,
            )
        )
    return items


def _source_occurrence(item: ResourceItemOut, edge: ResourceEdge) -> ResourceItemOut:
    activation = item.activation
    if edge.ordinal is None or activation.kind != "route":
        return item
    assert activation.href is not None
    return item.model_copy(
        update={
            "activation": activation.model_copy(
                update={"href": activation.href.split("#", 1)[0] + f"#citation-source-{edge.id}"}
            )
        }
    )
