"""The only writer of ``resource_edges``, plus the reads that guard a write.

Flush-only: every mutator flushes inside the caller's transaction and never commits, so
conversation create, citation write-through, Oracle persistence and Dossier promotion
stay atomic. Dedup is explicit SELECT-then-write: a machine bare edge is unique per
viewer, origin and directed pair; a neutral user Link is unique per viewer and
*unordered* pair and returns the existing row instead of raising, so a Link, a stance
and an ordered occurrence may coexist on one pair.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import NoReturn, cast
from uuid import UUID

from sqlalchemy import and_, delete, or_, select, tuple_
from sqlalchemy.orm import Session

from nexus.db.models import ResourceEdge
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.resolve import assert_ref_visible
from nexus.services.resource_graph.schemas import (
    ASSISTANT_EDGE_SCHEMES,
    EDGE_KINDS,
    EDGE_ORIGINS,
    SYNAPSE_SOURCE_SCHEMES,
    SYNAPSE_TARGET_SCHEMES,
    EdgeCreate,
    EdgeKind,
    EdgeOrigin,
    EdgeOut,
    is_neutral_link_shape,
    snapshot_from_jsonb,
    snapshot_to_jsonb,
)
from nexus.services.resource_items.capabilities import (
    CONVERSATION_CONTEXT_EDGE_ORIGINS,
    resource_can_be_citation_output_source,
    resource_can_link_source,
    resource_can_link_target,
)

Pair = tuple[str, UUID]

# Source/target scheme law for the origins whose shape is not checked in full above.
_ORIGIN_SHAPES: dict[EdgeOrigin, tuple[tuple[str, ...], tuple[str, ...] | None, str]] = {
    "system": (("conversation",), None, "System edges must be conversation context refs"),
    "note_body": (("note_block",), None, "Note body edges must start from note_block"),
    "highlight_note": (
        ("highlight",),
        ("note_block",),
        "Highlight note edges must connect highlight to note_block",
    ),
    "document_embed": (("media",), ("media",), "Document embed edges must connect media to media"),
    "link_note": (("note_block",), None, "Invalid edge shape"),
}


@dataclass(frozen=True, slots=True)
class EdgeWrite:
    edge: EdgeOut
    created: bool


def _invalid(message: str) -> NoReturn:
    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, message)


def validate_edge_shape(edge: EdgeCreate) -> None:
    """Reject an ill-shaped edge with a typed 400 before the table CHECKs raise a 500."""
    if edge.kind not in EDGE_KINDS:
        _invalid(f"Invalid edge kind {edge.kind!r}")
    if edge.origin not in EDGE_ORIGINS:
        _invalid(f"Invalid edge origin {edge.origin!r}")
    if edge.source == edge.target:
        _invalid("An edge cannot relate a resource to itself")
    if edge.target_order_key is not None:
        _invalid("Target order keys are reserved until multi-occurrence blocks ship")
    if edge.source_order_key is not None:
        if not 1 <= len(edge.source_order_key) <= 64:
            _invalid("source_order_key must be 1-64 characters")
        if not _allows_source_order(edge):
            _invalid("Source order key is not valid for this edge shape")

    if edge.origin == "citation":
        _validate_citation(edge)
        return
    if edge.ordinal is not None:
        _invalid("Only citation edges can carry ordinals")
    if edge.snapshot is not None and edge.origin not in ("synapse", "assistant"):
        _invalid("Only citation, synapse, and assistant edges can carry snapshots")
    if edge.origin in ("synapse", "assistant"):
        _validate_rationale_edge(edge)
        return

    if edge.origin != "user" and edge.kind != "context":
        _invalid(f"{edge.origin} edges must use kind=context")
    shape = _ORIGIN_SHAPES.get(edge.origin)
    if shape is not None:
        sources, targets, message = shape
        if edge.source.scheme not in sources or (
            targets is not None and edge.target.scheme not in targets
        ):
            _invalid(message)


def _validate_citation(edge: EdgeCreate) -> None:
    if edge.ordinal is None:
        if edge.snapshot is not None:
            _invalid("Only ordinal citation edges can carry citation snapshots")
        if edge.kind != "context" or edge.source.scheme != "conversation":
            _invalid("Bare citation edges must be conversation context refs")
        return
    if edge.snapshot is None:
        _invalid("Citation ordinal requires a snapshot")
    if not resource_can_be_citation_output_source(edge.source):
        _invalid("Citation ordinals must start from a generated output resource")
    if edge.source_order_key is not None or edge.target_order_key is not None:
        _invalid("Citation edges cannot carry order keys")
    if edge.ordinal < 1:
        _invalid("Citation ordinal must be >= 1")


def _validate_rationale_edge(edge: EdgeCreate) -> None:
    """Synapse and assistant edges: bounded schemes plus a non-empty rationale excerpt."""
    if edge.origin == "synapse":
        if edge.source.scheme not in SYNAPSE_SOURCE_SCHEMES:
            _invalid("Synapse edges must start from media, page, note_block, or highlight")
        if edge.target.scheme not in SYNAPSE_TARGET_SCHEMES:
            _invalid("Synapse edges must target media or note_block")
    else:
        if (
            edge.source.scheme not in ASSISTANT_EDGE_SCHEMES
            or edge.target.scheme not in ASSISTANT_EDGE_SCHEMES
        ):
            _invalid("Assistant edges must connect media, page, note_block, or highlight")
        if edge.source_order_key is not None or edge.target_order_key is not None:
            _invalid("Assistant edges cannot carry order keys")
    label = "Synapse" if edge.origin == "synapse" else "Assistant"
    if edge.snapshot is None:
        _invalid(f"{label} edges require a rationale snapshot")
    if not (edge.snapshot.excerpt or "").strip():
        _invalid(f"{label} snapshots require a non-empty excerpt")


def _allows_source_order(edge: EdgeCreate) -> bool:
    if edge.origin == "user":
        return edge.kind == "context" and edge.ordinal is None and edge.snapshot is None
    return (
        edge.origin in CONVERSATION_CONTEXT_EDGE_ORIGINS
        and edge.kind == "context"
        and edge.source.scheme == "conversation"
        and edge.ordinal is None
        and edge.snapshot is None
    )


def create_edge(db: Session, *, viewer_id: UUID, input: EdgeCreate) -> EdgeOut:
    """Validate and insert one edge; a duplicate neutral Link returns the existing row."""
    _validate_edge_input(db, viewer_id=viewer_id, edge=input)
    if input.origin == "user" and input.kind != "context" and input.source_order_key is not None:
        _invalid("Ordered adjacency must be written through the resource adjacency service")
    if _is_neutral_link(input):
        existing = _existing_link_pair(db, viewer_id=viewer_id, a=input.source, b=input.target)
        if existing is not None:
            return _edge_out(existing)
    elif input.ordinal is None:
        # Directed same-origin dedup for machine bare edges. User edges are not deduped
        # here: neutral Links took the idempotent path above, and stance plus ordered
        # adjacency are transaction-owned.
        if input.origin != "user" and _scalar(
            db,
            select(ResourceEdge.id).where(
                ResourceEdge.user_id == viewer_id,
                source_is(input.source),
                target_is(input.target),
                ResourceEdge.origin == input.origin,
                ResourceEdge.ordinal.is_(None),
            ),
        ):
            _invalid("Edge already exists")
        if input.source_order_key is not None and _scalar(
            db,
            select(ResourceEdge.id).where(
                ResourceEdge.user_id == viewer_id,
                source_is(input.source),
                ResourceEdge.source_order_key == input.source_order_key,
            ),
        ):
            _invalid("Source order exists")
    elif _scalar(
        db,
        select(ResourceEdge.id).where(
            ResourceEdge.user_id == viewer_id,
            source_is(input.source),
            ResourceEdge.ordinal == input.ordinal,
        ),
    ):
        _invalid(f"Citation ordinal {input.ordinal} already exists for {input.source.uri}")
    row = _row_from_input(viewer_id, input)
    db.add(row)
    db.flush()
    return _edge_out(row)


def create_link(
    db: Session, *, viewer_id: UUID, source: ResourceRef, target: ResourceRef
) -> EdgeWrite:
    """Idempotent neutral-Link create over the already-canonicalized pair."""
    existing = _existing_link_pair(db, viewer_id=viewer_id, a=source, b=target)
    if existing is not None:
        return EdgeWrite(edge=_edge_out(existing), created=False)
    edge = create_edge(
        db,
        viewer_id=viewer_id,
        input=EdgeCreate(source=source, target=target, kind="context", origin="user"),
    )
    return EdgeWrite(edge=edge, created=True)


def get_owned_edge(db: Session, *, viewer_id: UUID, edge_id: UUID) -> EdgeOut | None:
    row = db.execute(
        select(ResourceEdge).where(ResourceEdge.id == edge_id, ResourceEdge.user_id == viewer_id)
    ).scalar_one_or_none()
    return _edge_out(row) if row is not None else None


def delete_edge(db: Session, *, viewer_id: UUID, edge_id: UUID) -> None:
    row = db.execute(
        select(ResourceEdge).where(ResourceEdge.id == edge_id, ResourceEdge.user_id == viewer_id)
    ).scalar_one_or_none()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Edge not found")
    db.delete(row)
    db.flush()


def replace_edges_for_origin(
    db: Session,
    *,
    viewer_id: UUID,
    source: ResourceRef,
    origin: EdgeOrigin,
    edges: Sequence[EdgeCreate],
) -> list[EdgeOut]:
    """Replace exactly the ``(source, origin)`` edge set; other origins are untouched.

    A self-target member (a note body referencing its own block) is dropped rather than
    raising: a machine-extracted set must not fail on one.
    """
    members = [edge for edge in edges if edge.target != source]
    for edge in members:
        _validate_edge_input(db, viewer_id=viewer_id, edge=edge)

    db.execute(
        delete(ResourceEdge).where(
            ResourceEdge.user_id == viewer_id,
            source_is(source),
            ResourceEdge.origin == origin,
        )
    )
    rows: list[ResourceEdge] = []
    seen_targets: set[Pair] = set()
    seen_ordinals: set[int] = set()
    for edge in members:
        if edge.ordinal is None:
            if (edge.target.scheme, edge.target.id) in seen_targets:
                continue
            seen_targets.add((edge.target.scheme, edge.target.id))
        else:
            if edge.ordinal in seen_ordinals:
                _invalid(f"Duplicate citation ordinal {edge.ordinal} in replace-set")
            seen_ordinals.add(edge.ordinal)
        row = _row_from_input(viewer_id, edge)
        db.add(row)
        rows.append(row)
    db.flush()
    return [_edge_out(row) for row in rows]


def link_note_blocks_for_pairs(
    db: Session, *, viewer_id: UUID, pairs: Sequence[frozenset[Pair]]
) -> dict[frozenset[Pair], list[UUID]]:
    """The note blocks attached by ``origin='link_note'`` edges to BOTH endpoints of each
    pair — the Link-note motif, resolved once for the read, the write and the teardown."""
    endpoints = {endpoint for pair in pairs for endpoint in pair}
    if not endpoints:
        return {}
    targets_by_note: dict[UUID, set[Pair]] = {}
    for note_id, target_scheme, target_id in db.execute(
        select(ResourceEdge.source_id, ResourceEdge.target_scheme, ResourceEdge.target_id).where(
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.origin == "link_note",
            ResourceEdge.source_scheme == "note_block",
            tuple_(ResourceEdge.target_scheme, ResourceEdge.target_id).in_(endpoints),
        )
    ).all():
        targets_by_note.setdefault(note_id, set()).add((target_scheme, target_id))
    out: dict[frozenset[Pair], list[UUID]] = {}
    for pair in pairs:
        attached = [note_id for note_id, targets in targets_by_note.items() if pair <= targets]
        if attached:
            out[pair] = attached
    return out


def link_note_blocks_for_pair(
    db: Session, *, viewer_id: UUID, a: ResourceRef, b: ResourceRef
) -> list[UUID]:
    pair = frozenset({(a.scheme, a.id), (b.scheme, b.id)})
    return link_note_blocks_for_pairs(db, viewer_id=viewer_id, pairs=[pair]).get(pair, [])


def link_note_block_for_pair(
    db: Session, *, viewer_id: UUID, a: ResourceRef, b: ResourceRef
) -> UUID | None:
    attached = link_note_blocks_for_pair(db, viewer_id=viewer_id, a=a, b=b)
    return attached[0] if attached else None


def source_is(ref: ResourceRef):
    return and_(ResourceEdge.source_scheme == ref.scheme, ResourceEdge.source_id == ref.id)


def target_is(ref: ResourceRef):
    return and_(ResourceEdge.target_scheme == ref.scheme, ResourceEdge.target_id == ref.id)


def _scalar(db: Session, query) -> bool:
    return db.execute(query).scalar_one_or_none() is not None


def _is_neutral_link(edge: EdgeCreate) -> bool:
    return is_neutral_link_shape(
        origin=edge.origin,
        kind=edge.kind,
        ordinal=edge.ordinal,
        snapshot=edge.snapshot,
        source_order_key=edge.source_order_key,
        target_order_key=edge.target_order_key,
    )


def _validate_edge_input(db: Session, *, viewer_id: UUID, edge: EdgeCreate) -> None:
    validate_edge_shape(edge)
    # Only the neutral Link shape is subject to the user-Link verb; ordered context edges
    # and stances carry their own precise E_LINK_* gates upstream.
    if _is_neutral_link(edge) and not (
        resource_can_link_source(edge.source) and resource_can_link_target(edge.target)
    ):
        _invalid("Resource cannot be linked")
    # External snapshots exist to outlive whatever they captured, so they are never gated.
    if edge.target.scheme != "external_snapshot":
        assert_ref_visible(db, viewer_id=viewer_id, ref=edge.target)
    # A citation's source is the in-flight output minting it — a still-pending message,
    # reading or revision — trusted by construction and not yet read-visible.
    if edge.ordinal is None:
        assert_ref_visible(db, viewer_id=viewer_id, ref=edge.source)


def _existing_link_pair(
    db: Session, *, viewer_id: UUID, a: ResourceRef, b: ResourceRef
) -> ResourceEdge | None:
    return db.execute(
        select(ResourceEdge).where(
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.origin == "user",
            ResourceEdge.kind == "context",
            ResourceEdge.ordinal.is_(None),
            ResourceEdge.snapshot.is_(None),
            ResourceEdge.source_order_key.is_(None),
            ResourceEdge.target_order_key.is_(None),
            or_(
                and_(source_is(a), target_is(b)),
                and_(source_is(b), target_is(a)),
            ),
        )
    ).scalar_one_or_none()


def _row_from_input(viewer_id: UUID, edge: EdgeCreate) -> ResourceEdge:
    return ResourceEdge(
        user_id=viewer_id,
        kind=edge.kind,
        origin=edge.origin,
        source_scheme=edge.source.scheme,
        source_id=edge.source.id,
        target_scheme=edge.target.scheme,
        target_id=edge.target.id,
        source_order_key=edge.source_order_key,
        target_order_key=edge.target_order_key,
        ordinal=edge.ordinal,
        snapshot=snapshot_to_jsonb(edge.snapshot) if edge.snapshot is not None else None,
    )


def _edge_out(row: ResourceEdge) -> EdgeOut:
    return EdgeOut(
        id=row.id,
        source=ResourceRef(scheme=cast("ResourceScheme", row.source_scheme), id=row.source_id),
        target=ResourceRef(scheme=cast("ResourceScheme", row.target_scheme), id=row.target_id),
        kind=cast("EdgeKind", row.kind),
        origin=cast("EdgeOrigin", row.origin),
        source_order_key=row.source_order_key,
        target_order_key=row.target_order_key,
        ordinal=row.ordinal,
        snapshot=snapshot_from_jsonb(row.snapshot) if row.snapshot is not None else None,
        created_at=row.created_at,
    )
