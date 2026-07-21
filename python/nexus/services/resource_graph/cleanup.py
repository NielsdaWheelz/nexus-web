"""Explicit edge cleanup for deleted resources — exactly two rules (§9.6, D9).

1. **Cited edges outlive their targets.** An ordinal-bearing edge is never
   deleted by target cleanup — its snapshot renders and the jump fails closed
   (N4). It dies only with its domain parent, i.e. when the deleted resource
   is its SOURCE.
2. **Bare edges die with either endpoint.** Context refs, user links, and
   note-derived edges touching the deleted resource are removed.

No ``ON DELETE CASCADE`` exists on ``resource_edges`` (database.md); media
deletion calls the single-ref form once per deleted resource. Content reindex
destroys every span/chunk at once and uses the batched form to apply the same
two rules in two statements instead of N+1.
Flush-only: deletes run inside the caller's transaction.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from uuid import UUID

from sqlalchemy import and_, delete, or_, select, tuple_
from sqlalchemy.orm import Session

from nexus.db.models import (
    MessageRetrieval,
    ResourceEdge,
    ResourceExternalSnapshot,
    ResourceMutation,
    ResourceVersion,
    ResourceViewState,
)
from nexus.services.resource_graph.refs import ResourceRef

_Pair = tuple[str, UUID]


def delete_edges_for_deleted_resource(db: Session, *, ref: ResourceRef) -> None:
    # A dying endpoint takes its whole Link-note motif with it (both attachment
    # halves, view states first); the sibling half targets a surviving endpoint,
    # so Rule 2's touch-either-endpoint delete would otherwise leave it dangling.
    _delete_link_note_motifs_for_targets(db, target_pairs=[(ref.scheme, ref.id)])
    bare_edge_ids = select(ResourceEdge.id).where(
        ResourceEdge.ordinal.is_(None),
        or_(_source_is(ref), _target_is(ref)),
    )
    db.execute(delete(ResourceViewState).where(ResourceViewState.edge_id.in_(bare_edge_ids)))
    # Rule 2: bare edges die with either endpoint.
    db.execute(
        delete(ResourceEdge).where(
            ResourceEdge.ordinal.is_(None),
            or_(_source_is(ref), _target_is(ref)),
        )
    )
    # Rule 1: cited edges survive target deletion but die with their source
    # (the domain parent: message/conversation delete, reading delete).
    cited_edge_ids = select(ResourceEdge.id).where(
        ResourceEdge.ordinal.is_not(None), _source_is(ref)
    )
    db.execute(delete(ResourceViewState).where(ResourceViewState.edge_id.in_(cited_edge_ids)))
    deleted = db.execute(
        delete(ResourceEdge)
        .where(ResourceEdge.ordinal.is_not(None), _source_is(ref))
        .returning(ResourceEdge.target_scheme, ResourceEdge.target_id)
    ).all()
    delete_orphaned_external_snapshots(
        db, snapshot_ids=[tid for scheme, tid in deleted if scheme == "external_snapshot"]
    )


def delete_edges_for_deleted_resources(db: Session, *, refs: Iterable[ResourceRef]) -> None:
    """Set-batched ``delete_edges_for_deleted_resource`` for a hot bulk path.

    Same two rules — bare edges die with either endpoint, cited edges die only
    with their source — but in two statements over the whole ref set instead of
    one pair per ref. Used by content reindex, which destroys every span/chunk
    of an owner at once; a per-ref loop is an N+1 on that hot path.
    """
    pairs = [(ref.scheme, ref.id) for ref in refs]
    if not pairs:
        return
    _delete_link_note_motifs_for_targets(db, target_pairs=pairs)
    source = tuple_(ResourceEdge.source_scheme, ResourceEdge.source_id).in_(pairs)
    target = tuple_(ResourceEdge.target_scheme, ResourceEdge.target_id).in_(pairs)
    bare_edge_ids = select(ResourceEdge.id).where(
        ResourceEdge.ordinal.is_(None), or_(source, target)
    )
    db.execute(delete(ResourceViewState).where(ResourceViewState.edge_id.in_(bare_edge_ids)))
    # Rule 2: bare edges die with either endpoint.
    db.execute(delete(ResourceEdge).where(ResourceEdge.ordinal.is_(None), or_(source, target)))
    # Rule 1: cited edges survive target deletion but die with their source.
    cited_edge_ids = select(ResourceEdge.id).where(ResourceEdge.ordinal.is_not(None), source)
    db.execute(delete(ResourceViewState).where(ResourceViewState.edge_id.in_(cited_edge_ids)))
    deleted = db.execute(
        delete(ResourceEdge)
        .where(ResourceEdge.ordinal.is_not(None), source)
        .returning(ResourceEdge.target_scheme, ResourceEdge.target_id)
    ).all()
    delete_orphaned_external_snapshots(
        db, snapshot_ids=[tid for scheme, tid in deleted if scheme == "external_snapshot"]
    )


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
    """Delete ``external_snapshot`` rows no longer referenced by any edge.

    ``external_snapshot`` rows are resource identities for persisted web
    retrievals. They die only after both citation edges and retrieval telemetry
    stop referencing them.
    """
    ids = list(dict.fromkeys(snapshot_ids))
    if not ids:
        return
    still_referenced = set(
        db.execute(
            select(ResourceEdge.target_id).where(
                ResourceEdge.target_scheme == "external_snapshot",
                ResourceEdge.target_id.in_(ids),
            )
        ).scalars()
    )
    still_referenced.update(
        UUID(source_id)
        for source_id in db.execute(
            select(MessageRetrieval.source_id).where(
                MessageRetrieval.result_type == "web_result",
                MessageRetrieval.source_id.in_([str(sid) for sid in ids]),
            )
        ).scalars()
    )
    orphaned = [sid for sid in ids if sid not in still_referenced]
    if orphaned:
        db.execute(
            delete(ResourceExternalSnapshot).where(ResourceExternalSnapshot.id.in_(orphaned))
        )


def assert_no_dangling_bare_edges(db: Session, *, ref: ResourceRef) -> None:
    """Invariant check after cleanup: no bare edge may still touch ``ref``."""
    dangling = db.execute(
        select(ResourceEdge.id)
        .where(
            ResourceEdge.ordinal.is_(None),
            or_(_source_is(ref), _target_is(ref)),
        )
        .limit(1)
    ).scalar_one_or_none()
    if dangling is not None:
        # justify-defect: a bare edge to a deleted resource means a deletion
        # path skipped graph cleanup — a code defect, not an input failure.
        raise AssertionError(f"dangling bare edge {dangling} still touches {ref.uri}")


def clear_edge_view_state(db: Session, *, edge_id: UUID) -> None:
    """Delete the ``resource_view_states`` referencing one edge before it is removed.

    The single-edge form of the "view states before the edge" ordering used when
    Remove Link / Delete stance drops a specific relation (§ Graph Shapes).
    Flush-only: the caller deletes the edge through ``edges.delete_edge``.
    """
    db.execute(delete(ResourceViewState).where(ResourceViewState.edge_id == edge_id))


def detach_link_note_motif(db: Session, *, viewer_id: UUID, a: ResourceRef, b: ResourceRef) -> None:
    """Delete both attachment edges of the Link-note motif between ``a`` and ``b``.

    The motif is the ``note_block`` carrying an ``origin='link_note'`` edge to
    BOTH endpoints; its view states go before its edges. The authored note prose
    is never touched — it survives as detached standalone prose. Remove Link and
    Delete Link note (which additionally deletes the note) both call this
    (§ Graph Shapes).
    """
    a_key = (a.scheme, a.id)
    b_key = (b.scheme, b.id)
    targets_by_note: dict[_Pair, set[_Pair]] = defaultdict(set)
    for ss, si, ts, ti in db.execute(
        select(
            ResourceEdge.source_scheme,
            ResourceEdge.source_id,
            ResourceEdge.target_scheme,
            ResourceEdge.target_id,
        ).where(
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.origin == "link_note",
            or_(_target_is(a), _target_is(b)),
        )
    ).all():
        targets_by_note[(ss, si)].add((ts, ti))
    note_pairs = [
        note_key
        for note_key, targets in targets_by_note.items()
        if a_key in targets and b_key in targets
    ]
    _delete_link_note_edges_from_notes(db, note_pairs=note_pairs)


def _delete_link_note_motifs_for_targets(db: Session, *, target_pairs: list[_Pair]) -> None:
    """Delete every Link-note motif that attaches to any of ``target_pairs``.

    Resource-death is global (no viewer filter): the whole motif dies when any
    one endpoint does, so both attachment halves are removed together.
    """
    if not target_pairs:
        return
    note_pairs = [
        (scheme, note_id)
        for scheme, note_id in db.execute(
            select(ResourceEdge.source_scheme, ResourceEdge.source_id)
            .where(
                ResourceEdge.origin == "link_note",
                tuple_(ResourceEdge.target_scheme, ResourceEdge.target_id).in_(target_pairs),
            )
            .distinct()
        ).all()
    ]
    _delete_link_note_edges_from_notes(db, note_pairs=note_pairs)


def _delete_link_note_edges_from_notes(db: Session, *, note_pairs: list[_Pair]) -> None:
    if not note_pairs:
        return
    motif_edge_ids = select(ResourceEdge.id).where(
        ResourceEdge.origin == "link_note",
        tuple_(ResourceEdge.source_scheme, ResourceEdge.source_id).in_(note_pairs),
    )
    db.execute(delete(ResourceViewState).where(ResourceViewState.edge_id.in_(motif_edge_ids)))
    db.execute(
        delete(ResourceEdge).where(
            ResourceEdge.origin == "link_note",
            tuple_(ResourceEdge.source_scheme, ResourceEdge.source_id).in_(note_pairs),
        )
    )


def _source_is(ref: ResourceRef):
    return and_(ResourceEdge.source_scheme == ref.scheme, ResourceEdge.source_id == ref.id)


def _target_is(ref: ResourceRef):
    return and_(ResourceEdge.target_scheme == ref.scheme, ResourceEdge.target_id == ref.id)
