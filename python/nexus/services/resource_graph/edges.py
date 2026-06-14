"""Validated writer for public links and owner-scoped machine edge sets.

Transaction discipline (§9.0): every mutator flushes within the caller's
transaction and never commits, so conversation create, chat-run citation
write-through, Oracle phase persistence, and the LI promote compose atomically.

Dedup is explicit SELECT-then-write (database.md: no ``ON CONFLICT``): bare
edges (``ordinal IS NULL``) are unique per viewer, origin, and directed endpoint
pair. ``origin=user`` links additionally dedup both directions (undirected, §5.4).
Ordered adjacency is owned by ``resource_graph.adjacency`` because it replaces a
source's ordered occurrence set and view state together.
"""

from __future__ import annotations

from collections.abc import Sequence
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
    snapshot_from_jsonb,
    snapshot_to_jsonb,
)
from nexus.services.resource_items.capabilities import RESOURCE_ITEM_CAPABILITIES


def create_edge(db: Session, *, viewer_id: UUID, input: EdgeCreate) -> EdgeOut:
    """Validate and insert one edge; flush-only. Duplicates are rejected."""
    _validate_edge_input(db, viewer_id=viewer_id, edge=input)
    if input.origin == "user" and input.source_order_key is not None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Ordered adjacency must be written through the resource adjacency service",
        )
    if input.ordinal is None:
        if (
            _existing_bare_pair_id(
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
            input.origin == "user"
            and input.source_order_key is None
            and _existing_bare_pair_id(
                db,
                viewer_id=viewer_id,
                source=input.target,
                target=input.source,
                origin="user",
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


def repoint_edges(
    db: Session,
    *,
    viewer_id: UUID,
    from_ref: ResourceRef,
    to_ref: ResourceRef,
) -> int:
    """Rewrite every edge endpoint from ``from_ref`` to ``to_ref`` (identity merges, §9.6).

    All kinds move; ordinals and snapshots are untouched. The moving row is
    dropped (explicit SELECT first, no ``ON CONFLICT``) when it would (a) become
    a self-edge — ``from_ref`` sits at both endpoints, or one endpoint already
    equals ``to_ref`` (§5.4 has no self-links); or (b) duplicate an existing bare
    pair. For ``origin=user`` bare rows the reverse pair is probed too, since
    user links are undirected (§5.4) — a merge must not leave a symmetric pair
    that double-renders. Returns the number of edges that touched ``from_ref``
    (moved plus dropped).
    """
    rows = (
        db.execute(
            select(ResourceEdge)
            .where(
                ResourceEdge.user_id == viewer_id,
                or_(_source_is(from_ref), _target_is(from_ref)),
            )
            .order_by(ResourceEdge.created_at.asc(), ResourceEdge.id.asc())
        )
        .scalars()
        .all()
    )
    for row in rows:
        new_source = (
            to_ref
            if _endpoint_matches(row.source_scheme, row.source_id, from_ref)
            else (ResourceRef(scheme=cast("ResourceScheme", row.source_scheme), id=row.source_id))
        )
        new_target = (
            to_ref
            if _endpoint_matches(row.target_scheme, row.target_id, from_ref)
            else (ResourceRef(scheme=cast("ResourceScheme", row.target_scheme), id=row.target_id))
        )
        if new_source == new_target:
            # A merge that collapses both endpoints onto one ref would mint a
            # self-edge (e.g. a user link A->B when merging A into B); drop it.
            db.delete(row)
            db.flush()
            continue
        if row.ordinal is None and _bare_pair_collides(
            db,
            viewer_id=viewer_id,
            source=new_source,
            target=new_target,
            origin=row.origin,
            exclude_id=row.id,
        ):
            db.delete(row)
            db.flush()
            continue
        row.source_scheme = new_source.scheme
        row.source_id = new_source.id
        row.target_scheme = new_target.scheme
        row.target_id = new_target.id
        db.flush()
    return len(rows)


# ---------- internals ---------------------------------------------------------


def _source_is(ref: ResourceRef):
    return and_(ResourceEdge.source_scheme == ref.scheme, ResourceEdge.source_id == ref.id)


def _target_is(ref: ResourceRef):
    return and_(ResourceEdge.target_scheme == ref.scheme, ResourceEdge.target_id == ref.id)


def _endpoint_matches(scheme: str, resource_id: UUID, ref: ResourceRef) -> bool:
    return scheme == ref.scheme and resource_id == ref.id


def _validate_edge_input(db: Session, *, viewer_id: UUID, edge: EdgeCreate) -> None:
    """Boundary validation plus visibility checks for edge writes."""
    validate_edge_shape(edge)
    if edge.origin == "user":
        if not RESOURCE_ITEM_CAPABILITIES[edge.source.scheme].linkable:
            raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Resource cannot be linked")
        if not RESOURCE_ITEM_CAPABILITIES[edge.target.scheme].linkable:
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


def _bare_pair_collides(
    db: Session,
    *,
    viewer_id: UUID,
    source: ResourceRef,
    target: ResourceRef,
    origin: str,
    exclude_id: UUID,
) -> bool:
    """Would a bare ``source->target`` row duplicate one already stored (≠ ``exclude_id``)?

    Directed for machine origins; undirected for ``origin=user`` (§5.4), matching
    ``create_edge``'s both-direction check so a repoint cannot leave a symmetric
    user-link duplicate.
    """
    directed = _existing_bare_pair_id(
        db, viewer_id=viewer_id, source=source, target=target, origin=origin
    )
    if directed is not None and directed != exclude_id:
        return True
    if origin != "user":
        return False
    reverse = _existing_bare_pair_id(
        db, viewer_id=viewer_id, source=target, target=source, origin=origin
    )
    return reverse is not None and reverse != exclude_id


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
