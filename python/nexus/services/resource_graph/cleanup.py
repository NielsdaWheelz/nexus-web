"""Edge cleanup when resources die; ``resource_edges`` has no cascades.

1. A cited (ordinal) edge dies only with its source: its snapshot keeps rendering and
   the jump fails closed.
2. Every other edge dies with either endpoint, and a dying endpoint takes its whole
   link-note motif (the sibling attachment targets a survivor).

View states go before their edges, surviving link ends get a ``links`` version, and
external snapshots no longer cited by anything go too. Flush-only; death is global, so
nothing here filters by viewer except the per-viewer protocol state.
"""

from __future__ import annotations

from collections.abc import Iterable
from uuid import UUID

from sqlalchemy import String, and_, cast, delete, exists, or_, select, tuple_
from sqlalchemy.orm import Session

from nexus.db.models import (
    MessageRetrieval,
    ResourceEdge,
    ResourceExternalSnapshot,
    ResourceMutation,
    ResourceVersion,
    ResourceViewState,
)
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref
from nexus.services.resource_items import versions


def delete_edges_for_deleted_resource(db: Session, *, ref: ResourceRef) -> None:
    delete_edges_for_deleted_resources(db, refs=[ref])


def delete_edges_for_deleted_resources(db: Session, *, refs: Iterable[ResourceRef]) -> None:
    dead = [(ref.scheme, ref.id) for ref in refs]
    if not dead:
        return
    at_source = tuple_(ResourceEdge.source_scheme, ResourceEdge.source_id).in_(dead)
    at_target = tuple_(ResourceEdge.target_scheme, ResourceEdge.target_id).in_(dead)
    for user_id, *ends in db.execute(
        select(
            ResourceEdge.user_id,
            ResourceEdge.source_scheme,
            ResourceEdge.source_id,
            ResourceEdge.target_scheme,
            ResourceEdge.target_id,
        ).where(ResourceEdge.origin == "user", or_(at_source, at_target))
    ):
        for scheme, id_ in (ends[:2], ends[2:]):
            if (scheme, id_) not in dead:
                ref = assert_resource_ref(f"{scheme}:{id_}")
                versions.bump_version(db, viewer_id=user_id, ref=ref, lane="links")
    motif_notes = select(ResourceEdge.source_id).where(
        ResourceEdge.origin == "link_note", at_target
    )
    dying = select(ResourceEdge.id).where(
        or_(
            at_source,
            and_(ResourceEdge.ordinal.is_(None), at_target),
            and_(
                ResourceEdge.origin == "link_note",
                ResourceEdge.source_scheme == "note_block",
                ResourceEdge.source_id.in_(motif_notes),
            ),
        )
    )
    db.execute(delete(ResourceViewState).where(ResourceViewState.edge_id.in_(dying)))
    deleted = db.execute(
        delete(ResourceEdge)
        .where(ResourceEdge.id.in_(dying))
        .returning(ResourceEdge.ordinal, ResourceEdge.target_scheme, ResourceEdge.target_id)
    ).all()
    delete_orphaned_external_snapshots(
        db,
        snapshot_ids=[
            target_id
            for ordinal, scheme, target_id in deleted
            if ordinal is not None and scheme == "external_snapshot"
        ],
    )


def delete_orphaned_external_snapshots(db: Session, *, snapshot_ids: Iterable[UUID]) -> None:
    """Delete captured web snapshots that no edge and no retrieval row references."""
    ids = list(set(snapshot_ids))
    if not ids:
        return
    db.execute(
        delete(ResourceExternalSnapshot).where(
            ResourceExternalSnapshot.id.in_(ids),
            ~exists().where(
                ResourceEdge.target_scheme == "external_snapshot",
                ResourceEdge.target_id == ResourceExternalSnapshot.id,
            ),
            ~exists().where(
                MessageRetrieval.result_type == "web_result",
                MessageRetrieval.source_id == cast(ResourceExternalSnapshot.id, String),
            ),
        )
    )


def delete_resource_protocol_state(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> None:
    """The viewer's versions, view states and mutation memos for a resource that died."""
    pair = (ref.scheme, ref.id)
    db.execute(
        delete(ResourceVersion).where(
            ResourceVersion.user_id == viewer_id,
            ResourceVersion.resource_scheme == ref.scheme,
            ResourceVersion.resource_id == ref.id,
        )
    )
    db.execute(
        delete(ResourceViewState).where(
            ResourceViewState.user_id == viewer_id,
            or_(
                tuple_(ResourceViewState.surface_scheme, ResourceViewState.surface_id) == pair,
                tuple_(ResourceViewState.target_scheme, ResourceViewState.target_id) == pair,
            ),
        )
    )
    db.execute(
        delete(ResourceMutation).where(
            ResourceMutation.user_id == viewer_id,
            ResourceMutation.mutation_scope.like(f"resource:{ref.uri}:%"),
        )
    )
