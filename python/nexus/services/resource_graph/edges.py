"""The only writer of ``resource_edges``, and the reads that guard a write.

Every mutator flushes inside the caller's transaction and never commits. A fact
(``create_edge``, ``replace_edges_for_origin``) obeys the shape law in ``_validate``;
a user link (``create_link``) is stored in canonical order (``ref.uri``), is unique
per unordered pair, and ranks itself at each endpoint that orders its links. By that
law ``origin = 'user'`` alone identifies a link everywhere.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import NoReturn, cast
from uuid import UUID

from sqlalchemy import and_, delete, or_, select, tuple_
from sqlalchemy.orm import Session

from nexus.db.models import Conversation, ResourceEdge, ResourceViewState
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.resource_graph import EDGE_KINDS, CitationSnapshot, EdgeKind, EdgeOrigin
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme, assert_resource_ref
from nexus.services.resource_graph.resolve import assert_ref_visible
from nexus.services.resource_items import versions
from nexus.services.resource_items.capabilities import (
    resource_can_be_citation_output_source,
    resource_can_own_ordered_adjacency,
    resource_link_mode,
)

Pair = tuple[str, UUID]
CONNECTION_DISCOVERY_SOURCE_SCHEMES: tuple[ResourceScheme, ...] = (
    "media",
    "page",
    "note_block",
    "highlight",
)
_ASSISTANT_ENDPOINTS = ("media", "page", "note_block", "highlight")
# Every fact origin -> (source schemes, target schemes); None admits any visible resource.
# ``user`` is absent: links are written by ``create_link`` only.
_ENDPOINTS: dict[str, tuple[tuple[str, ...] | None, tuple[str, ...] | None]] = {
    "citation": (None, None),
    "system": (("conversation",), None),
    "note_body": (("note_block",), None),
    "highlight_note": (("highlight",), ("note_block",)),
    "document_embed": (("media",), ("media",)),
    "link_note": (("note_block",), None),
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
        if not resource_can_be_citation_output_source(edge.source):
            _invalid("Citation ordinals must start from a generated output resource")
    elif rationale:
        if edge.snapshot is None or not (edge.snapshot.excerpt or "").strip():
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
    # External snapshots outlive what they captured; a citation's source is the
    # in-flight output minting it, not yet read-visible.
    if edge.target.scheme != "external_snapshot":
        assert_ref_visible(db, viewer_id=viewer_id, ref=edge.target)
    if edge.ordinal is None:
        assert_ref_visible(db, viewer_id=viewer_id, ref=edge.source)


def create_edge(db: Session, *, viewer_id: UUID, input: EdgeCreate) -> EdgeOut:
    """Insert one fact; a bare fact is unique per origin and directed pair (400)."""
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
    row = _row(viewer_id, input)
    db.add(row)
    db.flush()
    return _edge_out(row)


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
    for edge in members:
        _validate(db, viewer_id, edge)
    db.execute(
        delete(ResourceEdge).where(
            ResourceEdge.user_id == viewer_id, source_is(source), ResourceEdge.origin == origin
        )
    )
    rows = [_row(viewer_id, edge) for edge in members]
    db.add_all(rows)
    db.flush()
    return [_edge_out(row) for row in rows]


def create_link(
    db: Session, *, viewer_id: UUID, source: ResourceRef, target: ResourceRef
) -> EdgeWrite:
    """Create or reuse the viewer's one link between two directly linkable resources."""
    return _link(db, viewer_id, source, target, None)


def restore_link(
    db: Session,
    *,
    viewer_id: UUID,
    source: ResourceRef,
    target: ResourceRef,
    link_id: UUID,
    created_at: datetime,
) -> None:
    """Re-create a receipt-owned link under its old identity; never retarget a live one."""
    if not _link(db, viewer_id, source, target, (link_id, created_at)).created:
        raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Restored link already exists")


def _link(
    db: Session,
    viewer_id: UUID,
    source: ResourceRef,
    target: ResourceRef,
    identity: tuple[UUID, datetime] | None,
) -> EdgeWrite:
    if source == target:
        _invalid("An edge cannot relate a resource to itself")
    if resource_link_mode(source) != "direct" or resource_link_mode(target) != "direct":
        _invalid("Resource cannot be linked")
    assert_ref_visible(db, viewer_id=viewer_id, ref=target)
    assert_ref_visible(db, viewer_id=viewer_id, ref=source)
    existing = existing_link_pair(db, viewer_id=viewer_id, a=source, b=target)
    if existing is not None:
        return EdgeWrite(_edge_out(existing), created=False)
    a, b = sorted((source, target), key=lambda ref: ref.uri)
    # A chat-chat link ranks at both chats: lock both in id order before either rank.
    chats = sorted(ref.id for ref in (a, b) if ref.scheme == "conversation")
    if chats:
        db.scalars(
            select(Conversation.id)
            .where(Conversation.id.in_(chats))
            .order_by(Conversation.id)
            .with_for_update()
        ).all()
    row = ResourceEdge(
        user_id=viewer_id,
        kind="context",
        origin="user",
        source_scheme=a.scheme,
        source_id=a.id,
        target_scheme=b.scheme,
        target_id=b.id,
    )
    if identity is not None:
        row.id, row.created_at = identity
    db.add(row)
    db.flush()
    for endpoint, other in ((a, b), (b, a)):
        versions.bump_version(db, viewer_id=viewer_id, ref=endpoint, lane="links")
        if endpoint.scheme == "conversation":
            key = conversation_rank(
                db, viewer_id=viewer_id, conversation_id=endpoint.id, target=other
            )
        elif resource_can_own_ordered_adjacency(endpoint):
            keys = db.scalars(
                select(ResourceViewState.order_key).where(
                    ResourceViewState.user_id == viewer_id,
                    ResourceViewState.surface_scheme == endpoint.scheme,
                    ResourceViewState.surface_id == endpoint.id,
                    ResourceViewState.order_key.is_not(None),
                )
            )
            key = f"{max((int(k) for k in keys if k is not None), default=0) + 1:010d}"
        else:
            continue
        db.add(
            ResourceViewState(
                user_id=viewer_id,
                surface_scheme=endpoint.scheme,
                surface_id=endpoint.id,
                edge_id=row.id,
                target_scheme=other.scheme,
                target_id=other.id,
                order_key=key,
                state={},
            )
        )
        db.flush()
    return EdgeWrite(_edge_out(row), created=True)


def conversation_rank(
    db: Session, *, viewer_id: UUID, conversation_id: UUID, target: ResourceRef
) -> str:
    """The target's earliest rank in the chat, else one past every rank of its links and
    automatic facts. Locks the chat row; the caller inserts in this transaction."""
    db.execute(select(Conversation.id).where(Conversation.id == conversation_id).with_for_update())
    ranks = db.execute(
        select(
            ResourceViewState.order_key,
            ResourceViewState.target_scheme,
            ResourceViewState.target_id,
        )
        .where(
            ResourceViewState.user_id == viewer_id,
            ResourceViewState.surface_scheme == "conversation",
            ResourceViewState.surface_id == conversation_id,
            ResourceViewState.edge_id.is_not(None),
            ResourceViewState.order_key.is_not(None),
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
    return _edge_out(row) if row is not None and row.user_id == viewer_id else None


def delete_edge(db: Session, *, viewer_id: UUID, edge_id: UUID) -> None:
    """Delete one owned edge after its view states; a link must carry no note (409)."""
    row = db.get(ResourceEdge, edge_id)
    if row is None or row.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Edge not found")
    if row.origin == "user":
        require_unannotated_link(db, viewer_id=viewer_id, edge=row)
        for scheme, id_ in ((row.source_scheme, row.source_id), (row.target_scheme, row.target_id)):
            ref = assert_resource_ref(f"{scheme}:{id_}")
            versions.bump_version(db, viewer_id=viewer_id, ref=ref, lane="links")
    db.execute(delete(ResourceViewState).where(ResourceViewState.edge_id == row.id))
    db.delete(row)
    db.flush()


def detach_link_notes(
    db: Session, *, viewer_id: UUID, link: EdgeOut, note_block_id: UUID | None = None
) -> None:
    """Delete the chosen (else every) note's two attachment edges; notes and link stay.
    A note attached anywhere but exactly the link's two ends is ambiguous (409)."""
    pair = link_pair(link)
    found = link_note_blocks_for_pairs(db, viewer_id=viewer_id, pairs=[pair]).get(pair, [])
    for note in [note_block_id] if note_block_id is not None else found:
        rows = db.execute(
            select(ResourceEdge.id, ResourceEdge.target_scheme, ResourceEdge.target_id).where(
                ResourceEdge.user_id == viewer_id,
                ResourceEdge.origin == "link_note",
                ResourceEdge.source_scheme == "note_block",
                ResourceEdge.source_id == note,
            )
        ).all()
        if {(scheme, id_) for _, scheme, id_ in rows} != pair:
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT, "Link note has ambiguous attachments"
            )
        ids = [row.id for row in rows]
        db.execute(delete(ResourceViewState).where(ResourceViewState.edge_id.in_(ids)))
        db.execute(delete(ResourceEdge).where(ResourceEdge.id.in_(ids)))


def existing_link_pair(
    db: Session, *, viewer_id: UUID, a: ResourceRef, b: ResourceRef
) -> ResourceEdge | None:
    return db.scalar(
        select(ResourceEdge).where(
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.origin == "user",
            or_(and_(source_is(a), target_is(b)), and_(source_is(b), target_is(a))),
        )
    )


def link_note_blocks_for_pairs(
    db: Session, *, viewer_id: UUID, pairs: Sequence[frozenset[Pair]]
) -> dict[frozenset[Pair], list[UUID]]:
    """The note blocks whose ``link_note`` edges attach to BOTH ends of each pair: the
    link-note motif, resolved once for the read, the write and the teardown."""
    endpoints = list({endpoint for pair in pairs for endpoint in pair})
    if not endpoints:
        return {}
    targets_by_note: dict[UUID, set[Pair]] = {}
    for note_id, scheme, target_id in db.execute(
        select(ResourceEdge.source_id, ResourceEdge.target_scheme, ResourceEdge.target_id).where(
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.origin == "link_note",
            ResourceEdge.source_scheme == "note_block",
            tuple_(ResourceEdge.target_scheme, ResourceEdge.target_id).in_(endpoints),
        )
    ):
        targets_by_note.setdefault(note_id, set()).add((scheme, target_id))
    found = {
        pair: [note for note, targets in targets_by_note.items() if pair <= targets]
        for pair in pairs
    }
    return {pair: notes for pair, notes in found.items() if notes}


def link_pair(edge: ResourceEdge | EdgeOut) -> frozenset[Pair]:
    if isinstance(edge, EdgeOut):
        return frozenset(
            {(edge.source.scheme, edge.source.id), (edge.target.scheme, edge.target.id)}
        )
    return frozenset({(edge.source_scheme, edge.source_id), (edge.target_scheme, edge.target_id)})


def require_unannotated_link(db: Session, *, viewer_id: UUID, edge: ResourceEdge) -> None:
    if link_note_blocks_for_pairs(db, viewer_id=viewer_id, pairs=[link_pair(edge)]):
        raise ConflictError(
            ApiErrorCode.E_RESOURCE_CONFLICT, "This link has a note; use link actions"
        )


def source_is(ref: ResourceRef):
    return and_(ResourceEdge.source_scheme == ref.scheme, ResourceEdge.source_id == ref.id)


def target_is(ref: ResourceRef):
    return and_(ResourceEdge.target_scheme == ref.scheme, ResourceEdge.target_id == ref.id)


def _row(viewer_id: UUID, edge: EdgeCreate) -> ResourceEdge:
    return ResourceEdge(
        user_id=viewer_id,
        kind=edge.kind,
        origin=edge.origin,
        source_scheme=edge.source.scheme,
        source_id=edge.source.id,
        target_scheme=edge.target.scheme,
        target_id=edge.target.id,
        source_order_key=edge.source_order_key,
        ordinal=edge.ordinal,
        snapshot=edge.snapshot.model_dump(exclude_none=True) if edge.snapshot is not None else None,
    )


def _edge_out(row: ResourceEdge) -> EdgeOut:
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
