"""The only writer of machine ``resource_edges`` facts.

Every mutator flushes inside the caller's transaction and never commits. A machine fact
(``create_edge``, ``replace_edges_for_origin``) obeys the shape law in ``_validate`` and
may be deleted physically. A citation is always an ordinal, source-owned fact: imported
and oracle sources carry captured evidence; a message's citation is a live projection of
its retrieval target and carries none. A user link is authored state owned by
``services.authored``, whose projection writes its row and endpoint positions; nothing
here writes, moves or deletes one. ``origin = 'user'`` identifies an authored link.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import NoReturn, cast
from uuid import UUID

from sqlalchemy import and_, delete, or_, select, text
from sqlalchemy.orm import Session

from nexus.db.models import Fragment, ResourceEdge, ResourceViewState, XPostMedia
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.resource_graph import EDGE_KINDS, CitationSnapshot, EdgeKind, EdgeOrigin
from nexus.services.resource_graph.liveness import AUTHORED_LINK_ORIGINS, edge_live_sql
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme, assert_resource_ref
from nexus.services.resource_graph.resolve import assert_ref_visible
from nexus.services.resource_items.capabilities import capability

Pair = tuple[str, UUID]
CONNECTION_DISCOVERY_SOURCE_SCHEMES: tuple[ResourceScheme, ...] = (
    "media",
    "page",
    "note_block",
    "highlight",
)
_ASSISTANT_ENDPOINTS = ("media", "page", "note_block", "highlight")
# Every fact origin -> (source schemes, target schemes); None admits any visible resource.
# Authored origins are absent: links belong to the semantic owner.
_ENDPOINTS: dict[str, tuple[tuple[str, ...] | None, tuple[str, ...] | None]] = {
    "citation": (None, None),
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
    ordinal: int | None
    snapshot: CitationSnapshot | None
    created_at: datetime


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


def _validate(db: Session, viewer_id: UUID | None, edge: EdgeCreate) -> None:
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
    if edge.kind != "context" and not rationale:
        _invalid(f"{edge.origin} edges must use kind=context")
    if (edge.origin == "citation") != (edge.ordinal is not None):
        _invalid("Exactly citation edges carry an ordinal")
    if edge.ordinal is not None:
        if edge.ordinal < 1 or not capability(edge.source.scheme).citation_output_source:
            _invalid("Citations require a citing source and an ordinal >= 1")
        if edge.source.scheme == "message":
            if edge.snapshot is not None:
                _invalid("A message citation is a live reference and carries no snapshot")
        elif (
            edge.snapshot is None
            or edge.snapshot.evidence is None
            or edge.snapshot.rationale is not None
        ):
            _invalid("Source citations require captured evidence only")
        if edge.source.scheme == "fragment" and not db.scalar(
            select(Fragment.x_post_capture_id).where(Fragment.id == edge.source.id)
        ):
            _invalid("A fragment citation source must be an immutable X capture")
    elif rationale:
        if edge.snapshot is None or not (edge.snapshot.rationale or "").strip():
            _invalid(f"{edge.origin} edges require a non-empty rationale excerpt")
    elif edge.snapshot is not None:
        _invalid("Only citation, discovery and assistant edges carry snapshots")
    _pin_note_owners(db, [edge.source, edge.target])
    # A citation's source is the in-flight output minting it, not yet read-visible, and
    # its target may already be gone; every bare fact names two visible resources.
    if edge.ordinal is None:
        assert viewer_id is not None  # justify-defect: bare facts are account-owned.
        assert_ref_visible(db, viewer_id=viewer_id, ref=edge.target)
        assert_ref_visible(db, viewer_id=viewer_id, ref=edge.source)


def create_edge(db: Session, *, viewer_id: UUID, input: EdgeCreate) -> EdgeOut:
    """Insert one bare fact, unique per origin and directed pair (400)."""
    if input.ordinal is not None:
        _invalid("Citations are published as their source's complete set")
    row = _row(viewer_id, input)
    _validate(db, viewer_id, input)
    if db.scalar(
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
    viewer_id: UUID | None,
    source: ResourceRef,
    origin: EdgeOrigin,
    edges: Sequence[EdgeCreate],
) -> list[EdgeOut]:
    """Replace exactly the ``(source, origin)`` set; edges come back in input order. A
    bare self-target member is dropped (a machine-extracted set must not fail on one) and a
    repeated bare target is kept once; a repeated ordinal is invalid."""
    if origin not in _ENDPOINTS:
        _invalid(f"{origin} edges must use their own command")
    if any(edge.origin != origin or edge.source != source for edge in edges):
        _invalid("Replacement members must belong to the requested source and origin")
    members: list[EdgeCreate] = []
    targets: set[ResourceRef] = set()
    ordinals: set[int] = set()
    for edge in edges:
        if edge.ordinal is None and (edge.target == source or edge.target in targets):
            continue
        if edge.ordinal in ordinals:
            _invalid(f"Duplicate citation ordinal {edge.ordinal} in replace-set")
        if edge.ordinal is None:
            targets.add(edge.target)
        else:
            ordinals.add(edge.ordinal)
        members.append(edge)
    source_owned = origin == "citation"
    if (viewer_id is None) != source_owned:
        raise RuntimeError("Exactly citations have source ownership")
    old = list(
        db.scalars(
            select(ResourceEdge).where(
                ResourceEdge.user_id.is_(None)
                if source_owned
                else ResourceEdge.user_id == viewer_id,
                source_is(source),
                ResourceEdge.origin == origin,
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
    if removed:
        from nexus.services.resource_graph.cleanup import delete_orphaned_external_snapshots

        delete_orphaned_external_snapshots(
            db,
            snapshot_ids=[
                row.target_id for row in removed if row.target_scheme == "external_snapshot"
            ],
        )
    if retained_media:
        from nexus.services.media_deletion import claim_document_teardown_if_unreferenced_locked

        for media_id in retained_media:
            claim_document_teardown_if_unreferenced_locked(db, media_id)
    if retained_media and (removed or any(row not in old for row in rows)):
        from nexus.services.search import projection

        # Only a source-owned citation retains media; an oracle reading has one reader.
        accounts = (
            []
            if source.scheme != "oracle_reading"
            else db.scalars(
                text("SELECT user_id FROM oracle_readings WHERE id=:id"),
                {"id": source.id},
            ).all()
        )
        if accounts:
            projection.refresh_viewer_contributors(db, accounts)
    return [edge_out(row) for row in rows]


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
    db.execute(delete(ResourceViewState).where(ResourceViewState.edge_id == row.id))
    db.delete(row)
    db.flush()


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
            select(XPostMedia.media_id)
            .where(XPostMedia.media_id.in_(ids))
            .order_by(XPostMedia.media_id)
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
        and row.snapshot
        == (edge.snapshot.model_dump(mode="json") if edge.snapshot is not None else None)
    )


def _row(viewer_id: UUID | None, edge: EdgeCreate) -> ResourceEdge:
    row = ResourceEdge(
        user_id=None if edge.ordinal is not None else viewer_id,
        kind=edge.kind,
        origin=edge.origin,
        source_scheme=edge.source.scheme,
        source_id=edge.source.id,
        target_scheme=edge.target.scheme,
        target_id=edge.target.id,
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
        ordinal=row.ordinal,
        snapshot=CitationSnapshot.model_validate(row.snapshot)
        if row.snapshot is not None
        else None,
        created_at=row.created_at,
    )
