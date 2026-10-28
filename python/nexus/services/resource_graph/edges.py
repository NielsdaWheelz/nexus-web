"""The only writer of machine ``resource_edges`` facts, and the chat's authored link writer.

Every mutator flushes inside the caller's transaction and never commits. A machine fact
(``create_edge``, ``replace_edges_for_origin``) obeys the shape law in ``_validate`` and
may be deleted physically. A user link is authored state: ``create_link`` adds it
through the semantic owner (``services.authored``), whose projection writes its row and
endpoint positions; nothing here writes, moves or deletes an authored link's row. By that
law ``origin = 'user'`` (with seeded attachment origins) identifies an authored link.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import NoReturn, cast
from uuid import UUID

from sqlalchemy import and_, delete, or_, select, text
from sqlalchemy.orm import Session

from nexus.db.models import Conversation, Highlight, ResourceEdge, ResourceViewState, XPostSource
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.resource_graph import EDGE_KINDS, CitationSnapshot, EdgeKind, EdgeOrigin
from nexus.services import authored
from nexus.services.resource_graph.liveness import AUTHORED_LINK_ORIGINS, edge_live_sql
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme, assert_resource_ref
from nexus.services.resource_graph.resolve import assert_ref_visible
from nexus.services.resource_items.capabilities import capability
from nexus.services.resource_items.items import resource_items_out

Pair = tuple[str, UUID]
CONNECTION_DISCOVERY_SOURCE_SCHEMES: tuple[ResourceScheme, ...] = (
    "media",
    "page",
    "note_block",
    "highlight",
)
_ASSISTANT_ENDPOINTS = ("media", "page", "note_block", "highlight")
# Every fact origin -> (source schemes, target schemes); None admits any visible resource.
# Authored origins are absent: links are written through ``create_link`` only.
_ENDPOINTS: dict[str, tuple[tuple[str, ...] | None, tuple[str, ...] | None]] = {
    "citation": (None, None),
    "system": (("conversation",), None),
    "document_embed": (("media",), ("media",)),
    "discovery": (CONNECTION_DISCOVERY_SOURCE_SCHEMES, ("media", "note_block", "evidence_span")),
    "assistant": (_ASSISTANT_ENDPOINTS, _ASSISTANT_ENDPOINTS),
}


@dataclass(frozen=True, slots=True)
class EdgeCreate:
    source: ResourceRef
    target: ResourceRef
    kind: EdgeKind
    origin: EdgeOrigin
    source_order_key: str | None = None
    ordinal: int | None = None
    snapshot: CitationSnapshot | None = None
    id: UUID | None = None


@dataclass(frozen=True, slots=True)
class EdgeOut:
    id: UUID
    source: ResourceRef
    target: ResourceRef
    kind: EdgeKind
    origin: EdgeOrigin
    source_order_key: str | None
    ordinal: int | None
    snapshot: CitationSnapshot | None
    created_at: datetime


@dataclass(frozen=True, slots=True)
class EdgeWrite:
    edge: EdgeOut
    created: bool


def _invalid(message: str) -> NoReturn:
    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, message)


def _pin_note_owners(db: Session, refs: Sequence[ResourceRef]) -> None:
    """Hold each note a fact touches, directly or through its derived span or chunk.

    The reindex job locks the note row before replacing those rows, so a key-share pin
    taken before the visibility gate keeps a fact from naming a span already replaced.
    """
    ids: set[UUID] = set()
    for ref in refs:
        if ref.scheme == "note_block":
            ids.add(ref.id)
        elif ref.scheme in ("evidence_span", "content_chunk"):
            owner = db.execute(
                text(f"SELECT owner_kind, owner_id FROM {ref.scheme}s WHERE id = :id"),
                {"id": ref.id},
            ).one_or_none()
            if owner is not None and owner.owner_kind == "note_block":
                ids.add(owner.owner_id)
    for note_id in sorted(ids):
        db.execute(text("SELECT 1 FROM note_blocks WHERE id = :id FOR KEY SHARE"), {"id": note_id})


def _validate(db: Session, viewer_id: UUID, edge: EdgeCreate) -> None:
    """The shape law of every fact, then the endpoint visibility gate."""
    if edge.origin not in _ENDPOINTS:
        _invalid(f"{edge.origin} edges must use their own command")
    if edge.kind not in EDGE_KINDS:
        _invalid(f"Invalid edge kind {edge.kind!r}")
    if edge.source == edge.target:
        _invalid("An edge cannot relate a resource to itself")
    sources, targets = _ENDPOINTS[edge.origin]
    if (sources is not None and edge.source.scheme not in sources) or (
        targets is not None and edge.target.scheme not in targets
    ):
        _invalid(f"Invalid {edge.origin} edge endpoints")
    rationale = edge.origin in ("discovery", "assistant")
    if edge.kind != "context" and not rationale and edge.ordinal is None:
        _invalid(f"{edge.origin} edges must use kind=context")
    if edge.ordinal is not None:
        if edge.origin != "citation" or edge.ordinal < 1 or edge.snapshot is None:
            _invalid("Only citation edges carry an ordinal >= 1, with a snapshot")
        if edge.snapshot.evidence is None or edge.snapshot.rationale is not None:
            _invalid("Ordinal citations require captured evidence only")
        if not capability(edge.source.scheme).citation_output_source:
            _invalid("Citation ordinals must start from a generated output resource")
    elif rationale:
        if edge.snapshot is None or not (edge.snapshot.rationale or "").strip():
            _invalid(f"{edge.origin} edges require a non-empty rationale excerpt")
    elif edge.snapshot is not None:
        _invalid("Only citation, discovery and assistant edges carry snapshots")
    elif edge.origin == "citation" and edge.source.scheme != "conversation":
        _invalid("Bare citation edges must be conversation context refs")
    if edge.source_order_key is not None and (
        edge.origin not in ("citation", "system")
        or edge.ordinal is not None
        or not 1 <= len(edge.source_order_key) <= 64
    ):
        _invalid("Only conversation context facts carry a 1-64 character order key")
    _pin_note_owners(db, [edge.source, edge.target])
    # External snapshots outlive what they captured; a citation's source is the
    # in-flight output minting it, not yet read-visible.
    if edge.ordinal is None and edge.target.scheme != "external_snapshot":
        assert_ref_visible(db, viewer_id=viewer_id, ref=edge.target)
    if edge.ordinal is None:
        assert_ref_visible(db, viewer_id=viewer_id, ref=edge.source)


def create_edge(db: Session, *, viewer_id: UUID, input: EdgeCreate) -> EdgeOut:
    """Insert one fact; a bare fact is unique per origin and directed pair (400)."""
    _lock_citation_media(db, [input])
    row = _row(viewer_id, input)
    _validate(db, viewer_id, input)
    if input.ordinal is None and db.scalar(
        select(ResourceEdge.id).where(
            ResourceEdge.user_id == viewer_id,
            source_is(input.source),
            target_is(input.target),
            ResourceEdge.origin == input.origin,
            ResourceEdge.ordinal.is_(None),
        )
    ):
        _invalid("Edge already exists")
    db.add(row)
    db.flush()
    return edge_out(row)


def replace_edges_for_origin(
    db: Session,
    *,
    viewer_id: UUID,
    source: ResourceRef,
    origin: EdgeOrigin,
    edges: Sequence[EdgeCreate],
) -> list[EdgeOut]:
    """Replace exactly the ``(source, origin)`` set; edges come back in input order. A
    self-target member is dropped (a machine-extracted set must not fail on one) and a
    repeated bare target is kept once; a repeated ordinal is invalid."""
    if origin not in _ENDPOINTS:
        _invalid(f"{origin} edges must use their own command")
    if any(edge.origin != origin or edge.source != source for edge in edges):
        _invalid("Replacement members must belong to the requested source and origin")
    members: list[EdgeCreate] = []
    targets: set[ResourceRef] = set()
    ordinals: set[int] = set()
    for edge in edges:
        if edge.target == source or (edge.ordinal is None and edge.target in targets):
            continue
        if edge.ordinal in ordinals:
            _invalid(f"Duplicate citation ordinal {edge.ordinal} in replace-set")
        if edge.ordinal is None:
            targets.add(edge.target)
        else:
            ordinals.add(edge.ordinal)
        members.append(edge)
    old = list(
        db.scalars(
            select(ResourceEdge).where(
                ResourceEdge.user_id == viewer_id, source_is(source), ResourceEdge.origin == origin
            )
        )
    )
    retained_media = _lock_citation_media(db, [*members, *(edge_out(row) for row in old)])
    for edge in members:
        _validate(db, viewer_id, edge)
    rows: list[ResourceEdge] = []
    removed = list(old)
    for member in members:
        same = next((row for row in removed if _same_fact(row, member)), None)
        if same is not None:
            removed.remove(same)
            rows.append(same)
        else:
            rows.append(_row(viewer_id, member))
    if removed:
        ids = [row.id for row in removed]
        db.execute(delete(ResourceViewState).where(ResourceViewState.edge_id.in_(ids)))
        for row in removed:
            db.delete(row)
        db.flush()
    db.add_all(rows)
    db.flush()
    if retained_media:
        from nexus.services.media_deletion import claim_document_teardown_if_unreferenced_locked

        for media_id in retained_media:
            claim_document_teardown_if_unreferenced_locked(db, media_id)
    if retained_media and (removed or any(row not in old for row in rows)):
        from nexus.services.search import projection

        projection.refresh_viewer_contributors(db, [viewer_id])
    return [edge_out(row) for row in rows]


def create_link(
    db: Session, *, viewer_id: UUID, source: ResourceRef, target: ResourceRef
) -> EdgeWrite:
    """Add the viewer's one authored link between two directly linkable visible resources
    through the semantic owner, appended last at each endpoint; a live link is reused.

    Flush-only inside the caller's transaction, which takes its conversation locks here,
    before the account head. Non-authored endpoints carry a literal label capture so
    devices can name them; the projection's conversation hook ranks a chat endpoint."""
    if source == target:
        _invalid("An edge cannot relate a resource to itself")
    if (
        capability(source.scheme).link_mode != "direct"
        or capability(target.scheme).link_mode != "direct"
    ):
        _invalid("Resource cannot be linked")
    a, b = sorted((source, target), key=lambda ref: ref.uri)
    lock_conversation_endpoints(db, [a, b])
    assert_ref_visible(db, viewer_id=viewer_id, ref=target)
    assert_ref_visible(db, viewer_id=viewer_id, ref=source)
    existing = existing_link_pair(db, viewer_id=viewer_id, a=source, b=target)
    if existing is not None:
        return EdgeWrite(edge_out(existing), created=False)
    labels = {
        item.ref: item.label
        for item in resource_items_out(db, viewer_id=viewer_id, refs=[a, b])
        if not item.missing
    }
    # Only the viewer's own notes, pages and highlights are their authored resources; a
    # library peer's highlight is a source the devices know only by its captured label.
    own = {
        ref
        for ref in (a, b)
        if ref.scheme in ("note_block", "page")
        or (
            ref.scheme == "highlight"
            and db.scalar(select(Highlight.user_id).where(Highlight.id == ref.id)) == viewer_id
        )
    }
    intents: list[dict[str, object]] = [
        {
            "kind": "capture_source",
            "source_ref": ref.uri,
            "capture": {"kind": ref.scheme, "label": labels[ref.uri], "publication": None},
        }
        for ref in (a, b)
        if ref not in own
    ]
    intents.append(
        {
            "kind": "add_link",
            "link_id": None,
            "endpoint_a": a.uri,
            "endpoint_b": b.uri,
            "position_a": None,
            "position_b": None,
        }
    )
    result = authored.server_command(
        db,
        viewer_id,
        command={"kind": "batch", "intents": intents},
        resource_refs=[ref.uri for ref in own],
        link_ids=[],
    )
    (link,) = result.links
    row = db.get(ResourceEdge, link.link_id)
    if row is None or not row.authored_visible:
        raise RuntimeError("Added authored link has no live projection")
    return EdgeWrite(edge_out(row), created=True)


def conversation_rank(
    db: Session, *, viewer_id: UUID, conversation_id: UUID, target: ResourceRef
) -> str:
    """Lock the chat row, then its next rank for ``target``; the caller inserts it."""
    db.execute(select(Conversation.id).where(Conversation.id == conversation_id).with_for_update())
    return next_context_rank(
        db, viewer_id=viewer_id, conversation_id=conversation_id, target=target
    )


def next_context_rank(
    db: Session, *, viewer_id: UUID, conversation_id: UUID, target: ResourceRef
) -> str:
    """The target's earliest rank in the chat, else one past every rank of its links and
    automatic facts. Takes no lock: under the account head a concurrent chat edit may
    tie, and ties order by creation then edge id."""
    ranks = db.execute(
        select(
            ResourceViewState.context_order_key,
            ResourceViewState.target_scheme,
            ResourceViewState.target_id,
        )
        .where(
            ResourceViewState.user_id == viewer_id,
            ResourceViewState.surface_scheme == "conversation",
            ResourceViewState.surface_id == conversation_id,
            ResourceViewState.edge_id.is_not(None),
            ResourceViewState.context_order_key.is_not(None),
        )
        .union_all(
            select(
                ResourceEdge.source_order_key,
                ResourceEdge.target_scheme,
                ResourceEdge.target_id,
            ).where(
                ResourceEdge.user_id == viewer_id,
                source_is(ResourceRef("conversation", conversation_id)),
                ResourceEdge.source_order_key.is_not(None),
            )
        )
    ).all()
    own = [key for key, scheme, id_ in ranks if (scheme, id_) == (target.scheme, target.id)]
    if own:
        return min(own, key=int)
    return f"{max((int(key) for key, _, _ in ranks), default=0) + 1:010d}"


def get_owned_edge(db: Session, *, viewer_id: UUID, edge_id: UUID) -> EdgeOut | None:
    row = db.get(ResourceEdge, edge_id)
    return edge_out(row) if row is not None and row.user_id == viewer_id else None


def delete_edge(db: Session, *, viewer_id: UUID, edge_id: UUID) -> None:
    """Delete one owned machine fact, preserving every other edge and both endpoints.

    An authored link is refused: only an observed unlink command removes it."""
    row = db.get(ResourceEdge, edge_id)
    if row is None or row.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Edge not found")
    if row.origin in AUTHORED_LINK_ORIGINS:
        raise AssertionError("authored links are removed by the semantic owner")
    retained_media = _lock_citation_media(db, [edge_out(row)])
    if row.origin in ("citation", "system") and row.ordinal is None:
        lock_conversation_endpoints(db, [ResourceRef("conversation", row.source_id)])
    db.execute(delete(ResourceViewState).where(ResourceViewState.edge_id == row.id))
    db.delete(row)
    db.flush()
    if retained_media:
        from nexus.services.media_deletion import claim_document_teardown_if_unreferenced_locked

        for media_id in retained_media:
            claim_document_teardown_if_unreferenced_locked(db, media_id)
        from nexus.services.search import projection

        projection.refresh_viewer_contributors(db, [viewer_id])


def existing_link_pair(
    db: Session, *, viewer_id: UUID, a: ResourceRef, b: ResourceRef
) -> ResourceEdge | None:
    """The viewer's live authored link joining ``a`` and ``b`` either way round."""
    return db.scalar(
        select(ResourceEdge).where(
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.origin.in_(AUTHORED_LINK_ORIGINS),
            or_(and_(source_is(a), target_is(b)), and_(source_is(b), target_is(a))),
            text(edge_live_sql("resource_edges")),
        )
    )


def source_is(ref: ResourceRef):
    return and_(ResourceEdge.source_scheme == ref.scheme, ResourceEdge.source_id == ref.id)


def target_is(ref: ResourceRef):
    return and_(ResourceEdge.target_scheme == ref.scheme, ResourceEdge.target_id == ref.id)


def _lock_citation_media(db: Session, edges: Sequence[EdgeCreate | EdgeOut]) -> list[UUID]:
    """Captured post owners serialize with collection before a citation becomes a root."""
    from nexus.services.library_entries import lock_media_for_reference

    ids: set[UUID] = set()
    for edge in edges:
        if edge.ordinal is None or edge.snapshot is None or edge.snapshot.evidence is None:
            continue
        owner_uri = edge.snapshot.evidence.target.owner_ref
        if owner_uri is not None:
            owner = assert_resource_ref(owner_uri)
            if owner.scheme == "media":
                ids.add(owner.id)
    if not ids:
        return []
    post_ids = list(
        db.scalars(
            select(XPostSource.media_id)
            .where(XPostSource.media_id.in_(ids))
            .order_by(XPostSource.media_id)
        )
    )
    for media_id in post_ids:
        lock_media_for_reference(db, media_id)
    return post_ids


def _same_fact(row: ResourceEdge, edge: EdgeCreate) -> bool:
    return (
        (row.source_scheme, row.source_id) == (edge.source.scheme, edge.source.id)
        and (row.target_scheme, row.target_id) == (edge.target.scheme, edge.target.id)
        and row.origin == edge.origin
        and row.kind == edge.kind
        and row.ordinal == edge.ordinal
        and row.source_order_key == edge.source_order_key
        and row.snapshot
        == (edge.snapshot.model_dump(mode="json") if edge.snapshot is not None else None)
    )


def _row(viewer_id: UUID, edge: EdgeCreate) -> ResourceEdge:
    row = ResourceEdge(
        user_id=viewer_id,
        kind=edge.kind,
        origin=edge.origin,
        source_scheme=edge.source.scheme,
        source_id=edge.source.id,
        target_scheme=edge.target.scheme,
        target_id=edge.target.id,
        source_order_key=edge.source_order_key,
        ordinal=edge.ordinal,
        snapshot=edge.snapshot.model_dump(mode="json") if edge.snapshot is not None else None,
    )
    if edge.id is not None:
        row.id = edge.id
    return row


def edge_out(row: ResourceEdge) -> EdgeOut:
    return EdgeOut(
        id=row.id,
        source=assert_resource_ref(f"{row.source_scheme}:{row.source_id}"),
        target=assert_resource_ref(f"{row.target_scheme}:{row.target_id}"),
        kind=cast(EdgeKind, row.kind),
        origin=cast(EdgeOrigin, row.origin),
        source_order_key=row.source_order_key,
        ordinal=row.ordinal,
        snapshot=CitationSnapshot.model_validate(row.snapshot)
        if row.snapshot is not None
        else None,
        created_at=row.created_at,
    )


def lock_conversation_endpoints(db: Session, refs: Sequence[ResourceRef]) -> None:
    """Every chat admission mutation uses this sorted endpoint lock before reading facts."""
    ids = sorted({ref.id for ref in refs if ref.scheme == "conversation"})
    if ids:
        db.scalars(
            select(Conversation.id)
            .where(Conversation.id.in_(ids))
            .order_by(Conversation.id)
            .with_for_update()
        ).all()
