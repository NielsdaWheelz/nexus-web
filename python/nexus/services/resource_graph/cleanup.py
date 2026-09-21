"""Explicit edge cleanup for deleted resources — exactly two rules.

1. **Cited edges outlive their targets.** An ordinal-bearing edge dies only with its
   SOURCE (the domain parent); its snapshot keeps rendering and the jump fails closed.
2. **Bare edges die with either endpoint.**

There is no ``ON DELETE CASCADE`` on ``resource_edges``, and ``resource_view_states``
rows are always deleted before the edges they reference. Flush-only.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from uuid import UUID

from sqlalchemy import delete, or_, select, tuple_
from sqlalchemy.orm import Session

from nexus.db.models import (
    MessageRetrieval,
    ResourceEdge,
    ResourceExternalSnapshot,
    ResourceMutation,
    ResourceVersion,
    ResourceViewState,
)
from nexus.services.resource_graph.edges import Pair, link_note_blocks_for_pair
from nexus.services.resource_graph.refs import ResourceRef


def delete_edges_for_deleted_resource(db: Session, *, ref: ResourceRef) -> None:
    delete_edges_for_deleted_resources(db, refs=[ref])


def delete_edges_for_deleted_resources(db: Session, *, refs: Iterable[ResourceRef]) -> None:
    """Apply both rules over a set of dead refs in two statements."""
    pairs: list[Pair] = [(ref.scheme, ref.id) for ref in refs]
    if not pairs:
        return
    # A dying endpoint takes its whole Link-note motif with it: the sibling attachment
    # half targets a surviving endpoint, so rule 2 alone would leave it dangling.
    _delete_link_note_motifs_for_targets(db, target_pairs=pairs)
    source = tuple_(ResourceEdge.source_scheme, ResourceEdge.source_id).in_(pairs)
    target = tuple_(ResourceEdge.target_scheme, ResourceEdge.target_id).in_(pairs)

    bare = select(ResourceEdge.id).where(ResourceEdge.ordinal.is_(None), or_(source, target))
    db.execute(delete(ResourceViewState).where(ResourceViewState.edge_id.in_(bare)))
    db.execute(delete(ResourceEdge).where(ResourceEdge.ordinal.is_(None), or_(source, target)))

    cited = select(ResourceEdge.id).where(ResourceEdge.ordinal.is_not(None), source)
    db.execute(delete(ResourceViewState).where(ResourceViewState.edge_id.in_(cited)))
    deleted = db.execute(
        delete(ResourceEdge)
        .where(ResourceEdge.ordinal.is_not(None), source)
        .returning(ResourceEdge.target_scheme, ResourceEdge.target_id)
    ).all()
    delete_orphaned_external_snapshots(
        db, snapshot_ids=[tid for scheme, tid in deleted if scheme == "external_snapshot"]
    )


def detach_link_note_motif(db: Session, *, viewer_id: UUID, a: ResourceRef, b: ResourceRef) -> None:
    """Delete both attachment edges of the Link-note motif between ``a`` and ``b``.

    The authored prose is never touched: it survives as a standalone note.
    """
    _delete_link_note_edges(
        db, note_ids=link_note_blocks_for_pair(db, viewer_id=viewer_id, a=a, b=b)
    )


def clear_edge_view_state(db: Session, *, edge_id: UUID) -> None:
    """Drop the view states referencing one edge, before the caller deletes it."""
    db.execute(delete(ResourceViewState).where(ResourceViewState.edge_id == edge_id))


def delete_resource_protocol_state(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> None:
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
            (
                (ResourceViewState.surface_scheme == ref.scheme)
                & (ResourceViewState.surface_id == ref.id)
            )
            | (
                (ResourceViewState.target_scheme == ref.scheme)
                & (ResourceViewState.target_id == ref.id)
            ),
        )
    )
    db.execute(
        delete(ResourceMutation).where(
            ResourceMutation.user_id == viewer_id,
            ResourceMutation.mutation_scope.like(f"resource:{ref.uri}:%"),
        )
    )


def delete_orphaned_external_snapshots(db: Session, *, snapshot_ids: Iterable[UUID]) -> None:
    """Delete captured web snapshots once no edge and no retrieval row references them."""
    ids = list(dict.fromkeys(snapshot_ids))
    if not ids:
        return
    referenced = set(
        db.execute(
            select(ResourceEdge.target_id).where(
                ResourceEdge.target_scheme == "external_snapshot",
                ResourceEdge.target_id.in_(ids),
            )
        ).scalars()
    )
    referenced.update(
        UUID(source_id)
        for source_id in db.execute(
            select(MessageRetrieval.source_id).where(
                MessageRetrieval.result_type == "web_result",
                MessageRetrieval.source_id.in_([str(sid) for sid in ids]),
            )
        ).scalars()
    )
    orphaned = [sid for sid in ids if sid not in referenced]
    if orphaned:
        db.execute(
            delete(ResourceExternalSnapshot).where(ResourceExternalSnapshot.id.in_(orphaned))
        )


def _delete_link_note_motifs_for_targets(db: Session, *, target_pairs: list[Pair]) -> None:
    """Every motif attaching to any dead endpoint dies whole; resource death is global,
    so this read carries no viewer filter."""
    note_ids = list(
        db.execute(
            select(ResourceEdge.source_id)
            .where(
                ResourceEdge.origin == "link_note",
                tuple_(ResourceEdge.target_scheme, ResourceEdge.target_id).in_(target_pairs),
            )
            .distinct()
        ).scalars()
    )
    _delete_link_note_edges(db, note_ids=note_ids)


def _delete_link_note_edges(db: Session, *, note_ids: Sequence[UUID]) -> None:
    if not note_ids:
        return
    motif = select(ResourceEdge.id).where(
        ResourceEdge.origin == "link_note",
        ResourceEdge.source_scheme == "note_block",
        ResourceEdge.source_id.in_(note_ids),
    )
    db.execute(delete(ResourceViewState).where(ResourceViewState.edge_id.in_(motif)))
    db.execute(
        delete(ResourceEdge).where(
            ResourceEdge.origin == "link_note",
            ResourceEdge.source_scheme == "note_block",
            ResourceEdge.source_id.in_(note_ids),
        )
    )
