"""Validated writer for public links and owner-scoped machine edge sets.

Transaction discipline (§9.0): every mutator flushes within the caller's
transaction and never commits, so conversation create, chat-run citation
write-through, Oracle phase persistence, and the LI promote compose atomically.

Dedup is explicit SELECT-then-write (database.md: no ``ON CONFLICT``): machine
bare edges (``ordinal IS NULL``, non-user origin) are unique per viewer, origin,
and directed endpoint pair. A neutral user Link is unique per viewer and
*unordered* pair; a duplicate (either orientation) returns the existing row
idempotently rather than raising, and a Link, a stance, and an ordered occurrence
may coexist on one pair. Ordered adjacency is owned by ``resource_graph.adjacency``
because it replaces a source's ordered occurrence set and view state together.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import cast
from uuid import UUID

from sqlalchemy import and_, delete, or_, select
from sqlalchemy.orm import Session

from nexus.db.models import ResourceEdge
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.services.resource_graph.policy import validate_edge_shape
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.resolve import assert_ref_visible
from nexus.services.resource_graph.schemas import (
    EdgeCreate,
    EdgeKind,
    EdgeOrigin,
    EdgeOut,
    is_neutral_link_shape,
    snapshot_from_jsonb,
    snapshot_to_jsonb,
)
from nexus.services.resource_items.capabilities import (
    resource_can_link_source,
    resource_can_link_target,
)


@dataclass(frozen=True, slots=True)
class EdgeWrite:
    """A create-or-reuse outcome so the Link service can set ``created`` (§ Mutation APIs)."""

    edge: EdgeOut
    created: bool


def create_edge(db: Session, *, viewer_id: UUID, input: EdgeCreate) -> EdgeOut:
    """Validate and insert one edge; flush-only.

    Non-user duplicates and ordered/stance/citation conflicts stay typed
    rejections. A duplicate neutral Link (the exact predicate, either
    orientation) returns the existing row idempotently, never raising, so a
    race that slips past the caller's pre-check converges instead of surfacing
    a raw duplicate error (§ Graph Shapes; Mutation APIs).
    """
    _validate_edge_input(db, viewer_id=viewer_id, edge=input)
    if input.origin == "user" and input.kind != "context" and input.source_order_key is not None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Ordered adjacency must be written through the resource adjacency service",
        )
    if is_neutral_link_shape(input):
        existing = _existing_link_pair_id(db, viewer_id=viewer_id, a=input.source, b=input.target)
        if existing is not None:
            return _edge_out(db.get(ResourceEdge, existing))
    elif input.ordinal is None:
        # Directed same-origin dedup for machine bare edges
        # (uq_resource_edges_nonuser_orderless_pair). User edges are not deduped
        # here: neutral Links took the exact idempotent path above, and stance
        # (uq_resource_edges_user_stance_directed_pair) plus user ordered
        # adjacency are transaction-owned so a Link, a stance, and an ordered
        # occurrence may coexist on one pair (§ Graph Shapes).
        if (
            input.origin != "user"
            and _existing_bare_pair_id(
                db,
                viewer_id=viewer_id,
                source=input.source,
                target=input.target,
                origin=input.origin,
            )
            is not None
        ):
            raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Edge already exists")
        if (
            input.source_order_key is not None
            and _existing_source_order_id(
                db, viewer_id=viewer_id, source=input.source, order_key=input.source_order_key
            )
            is not None
        ):
            raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Source order exists")
    elif (
        _existing_ordinal_id(db, viewer_id=viewer_id, source=input.source, ordinal=input.ordinal)
        is not None
    ):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Citation ordinal {input.ordinal} already exists for {input.source.uri}",
        )
    row = _row_from_input(viewer_id, input)
    db.add(row)
    db.flush()
    return _edge_out(row)


def existing_link_edge(
    db: Session, *, viewer_id: UUID, a: ResourceRef, b: ResourceRef
) -> EdgeOut | None:
    """The viewer's neutral Link between ``a`` and ``b``, either orientation, or ``None``.

    Matches the exact neutral-Link predicate only — never a stance or ordered
    occurrence on the same pair. The Link service uses this to decide
    ``created`` before writing (§ Mutation APIs).
    """
    edge_id = _existing_link_pair_id(db, viewer_id=viewer_id, a=a, b=b)
    if edge_id is None:
        return None
    return _edge_out(db.get(ResourceEdge, edge_id))


def create_link(
    db: Session, *, viewer_id: UUID, source: ResourceRef, target: ResourceRef
) -> EdgeWrite:
    """Idempotent neutral-Link create for the Link service; flush-only.

    ``source``/``target`` are the already-canonicalized endpoints (the caller
    orders the pair by ``(scheme, id)`` per PLAN). Returns the existing canonical
    Link with ``created=False``, otherwise inserts it with ``created=True``. A
    concurrent create is caught by ``uq_resource_edges_user_context_link_pair``
    and converges on retry (both mutation IDs then read one existing row).
    """
    existing = existing_link_edge(db, viewer_id=viewer_id, a=source, b=target)
    if existing is not None:
        return EdgeWrite(edge=existing, created=False)
    edge = create_edge(
        db,
        viewer_id=viewer_id,
        input=EdgeCreate(source=source, target=target, kind="context", origin="user"),
    )
    return EdgeWrite(edge=edge, created=True)


def get_owned_edge(db: Session, *, viewer_id: UUID, edge_id: UUID) -> EdgeOut | None:
    """Read one of the viewer's edges by id, or ``None`` (the DELETE origin-gate, §10.2).

    Returning the ``EdgeOut`` (which exposes ``origin``) keeps the route off the
    ORM model (AC15); the gate 404s on ``None`` and 403s on a non-``user`` origin.
    """
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
    """Replace the ``(source, origin)`` edge set; flush-only (note_body sync, citation sets).

    The scope is exactly ``(source, origin)``: other origins' edges on the same
    source are never touched (§5.7). A self-target member (a note body that refs
    its own block) is dropped: a resource does not relate to itself (§5.4), and a
    machine-extracted set must not raise on one.
    """
    members = [edge for edge in edges if edge.target != source]
    for edge in members:
        if edge.source != source or edge.origin != origin:
            # justify-defect: the replace-set scope and its members are composed
            # by the same caller; a mismatch is a coding error, not input.
            raise AssertionError(
                f"replace-set member {edge.source.uri}/{edge.origin} does not match "
                f"scope {source.uri}/{origin}"
            )
        _validate_edge_input(db, viewer_id=viewer_id, edge=edge)

    db.execute(
        delete(ResourceEdge).where(
            ResourceEdge.user_id == viewer_id,
            _source_is(source),
            ResourceEdge.origin == origin,
        )
    )

    rows: list[ResourceEdge] = []
    seen_pairs: set[tuple[ResourceScheme, UUID]] = set()
    seen_ordinals: set[int] = set()
    for edge in members:
        if edge.ordinal is None:
            pair = (edge.target.scheme, edge.target.id)
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)
        else:
            if edge.ordinal in seen_ordinals:
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    f"Duplicate citation ordinal {edge.ordinal} in replace-set",
                )
            seen_ordinals.add(edge.ordinal)
        row = _row_from_input(viewer_id, edge)
        db.add(row)
        rows.append(row)
    db.flush()
    return [_edge_out(row) for row in rows]


# ---------- internals ---------------------------------------------------------


def _source_is(ref: ResourceRef):
    return and_(ResourceEdge.source_scheme == ref.scheme, ResourceEdge.source_id == ref.id)


def _target_is(ref: ResourceRef):
    return and_(ResourceEdge.target_scheme == ref.scheme, ResourceEdge.target_id == ref.id)


def _validate_edge_input(db: Session, *, viewer_id: UUID, edge: EdgeCreate) -> None:
    """Boundary validation plus visibility checks for edge writes."""
    validate_edge_shape(edge)
    # The user-Link verb governs endpoint linkability; only the neutral Link
    # shape is subject to it. Ordered conversation-context edges use their own
    # ``resource_can_attach`` gate (services/resource_graph/context.py), and
    # stances validate source/target in ``user_relations.put_stance`` — both
    # with the precise E_LINK_* codes, so this backstop must not reject them.
    if is_neutral_link_shape(edge):
        if not resource_can_link_source(edge.source):
            raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Resource cannot be linked")
        if not resource_can_link_target(edge.target):
            raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Resource cannot be linked")
    # Missing targets are rejected unless the target is an external snapshot,
    # which exists to outlive whatever it captured (§7.3).
    if edge.target.scheme != "external_snapshot":
        assert_ref_visible(db, viewer_id=viewer_id, ref=edge.target)
    # The source is read-gated only for bare edges (user links, context refs,
    # note edges), whose source the caller supplies. A citation edge's source is
    # the in-flight output minting it — a still-``pending`` assistant message,
    # oracle reading, or LI revision — trusted by construction and not yet
    # read-visible, so gating it here would silently drop every citation.
    if edge.ordinal is None:
        assert_ref_visible(db, viewer_id=viewer_id, ref=edge.source)


def _existing_bare_pair_id(
    db: Session,
    *,
    viewer_id: UUID | None,
    source: ResourceRef,
    target: ResourceRef,
    origin: str,
) -> UUID | None:
    query = select(ResourceEdge.id).where(
        _source_is(source),
        _target_is(target),
        ResourceEdge.origin == origin,
        ResourceEdge.ordinal.is_(None),
    )
    if viewer_id is not None:
        query = query.where(ResourceEdge.user_id == viewer_id)
    return db.execute(query).scalar_one_or_none()


def _existing_link_pair_id(
    db: Session, *, viewer_id: UUID, a: ResourceRef, b: ResourceRef
) -> UUID | None:
    """Id of the viewer's neutral Link on the unordered pair ``{a, b}``, or ``None``.

    Both orientations are checked; the predicate mirrors
    ``uq_resource_edges_user_context_link_pair`` exactly so a stance or ordered
    occupancy of the same pair never matches.
    """
    return db.execute(
        select(ResourceEdge.id).where(
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.origin == "user",
            ResourceEdge.kind == "context",
            ResourceEdge.ordinal.is_(None),
            ResourceEdge.snapshot.is_(None),
            ResourceEdge.source_order_key.is_(None),
            ResourceEdge.target_order_key.is_(None),
            or_(
                and_(_source_is(a), _target_is(b)),
                and_(_source_is(b), _target_is(a)),
            ),
        )
    ).scalar_one_or_none()


def _existing_source_order_id(
    db: Session, *, viewer_id: UUID, source: ResourceRef, order_key: str
) -> UUID | None:
    return db.execute(
        select(ResourceEdge.id).where(
            ResourceEdge.user_id == viewer_id,
            _source_is(source),
            ResourceEdge.source_order_key == order_key,
        )
    ).scalar_one_or_none()


def _existing_ordinal_id(
    db: Session, *, viewer_id: UUID, source: ResourceRef, ordinal: int
) -> UUID | None:
    return db.execute(
        select(ResourceEdge.id).where(
            ResourceEdge.user_id == viewer_id, _source_is(source), ResourceEdge.ordinal == ordinal
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
