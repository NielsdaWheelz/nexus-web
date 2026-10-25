"""Frozen collection consumption snapshots and absolute writes.

Prepare captures full readable source membership under the caller's repeatable-read
snapshot. Apply validates every frozen id against unfiltered source membership, then
preflights all differing overrides under viewer_txn. Desired explicit states are inert
retries and return no old inverse. Only an acknowledged changed set carries exact undo.
Undo depends on current readability, never survival of the original collection.
"""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.errors import ApiErrorCode, ConflictError, NotFoundError
from nexus.schemas import collection_actions as wire
from nexus.services import library_listing
from nexus.services.consumption import state, viewer_txn
from nexus.services.podcasts import episodes
from nexus.services.suggestion_changes import record_input_change


def ordered_source_ids(
    db: Session, viewer_id: UUID, target: wire.CollectionTarget
) -> tuple[str, list[UUID]]:
    """Complete physical resource contents in its canonical fixed order."""
    if isinstance(target, wire.PodcastCollectionTarget):
        return episodes.ordered_selection_ids(
            db, viewer_id, target.podcast_id, state="all", sort="oldest"
        )
    return library_listing.ordered_selection_ids(
        db, viewer_id, target.library_id, library_listing.EntryView(None, None, None, None)
    )


def require_source_members(
    db: Session, viewer_id: UUID, target: wire.CollectionTarget, media_ids: list[UUID]
) -> None:
    """Mask unreadable media; refuse readable media that left the reviewed source."""
    readable = set(
        db.scalars(
            text(
                f"SELECT media_id FROM ({visible_media_ids_cte_sql()}) visible "
                "WHERE media_id = ANY(:media_ids)"
            ),
            {"viewer_id": viewer_id, "media_ids": media_ids},
        )
    )
    if readable != set(media_ids):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    _, members = ordered_source_ids(db, viewer_id, target)
    if not set(media_ids) <= set(members):
        raise ConflictError(ApiErrorCode.E_SELECTION_CHANGED, "Items left the collection")


def prepare(
    db: Session, viewer_id: UUID, selection: wire.CollectionSelection
) -> wire.CollectionConsumptionPreparedOut:
    if isinstance(selection, wire.PodcastCollectionSelection):
        label, media_ids = episodes.ordered_selection_ids(
            db, viewer_id, selection.podcast_id, state=selection.state, sort="oldest"
        )
    else:
        label, media_ids = ordered_source_ids(db, viewer_id, selection)
    revisions = {
        row.media_id: row.revision
        for row in db.execute(
            text(
                "SELECT media_id, revision FROM consumption_overrides "
                "WHERE user_id = :viewer_id AND media_id = ANY(:media_ids)"
            ),
            {"viewer_id": viewer_id, "media_ids": media_ids},
        )
    }
    return wire.CollectionConsumptionPreparedOut(
        label=label,
        items=[
            wire.StateItem(media_id=m, expected_override_revision=revisions.get(m))
            for m in media_ids
        ],
    )


def apply(
    viewer_id: UUID, body: wire.CollectionConsumptionRequest
) -> wire.CollectionConsumptionOut:
    def run(db: Session) -> wire.CollectionConsumptionOut:
        media_ids = [item.media_id for item in body.items]
        require_source_members(db, viewer_id, body.target, media_ids)
        undo = state.set_states_in_txn(
            db, viewer_id=viewer_id, items=body.items, desired_state=body.desired_state
        )
        if undo is not None:
            record_input_change(
                db, owners=(f"consumption:{viewer_id}:{item.media_id}" for item in body.items)
            )
        return wire.CollectionConsumptionOut(
            matched_count=len(media_ids), changed_count=len(undo.items) if undo else 0, undo=undo
        )

    return viewer_txn("set_collection_consumption", viewer_id, run)


def undo(
    viewer_id: UUID, receipt: wire.CollectionConsumptionUndoReceipt
) -> wire.CollectionConsumptionUndoOut:
    def run(db: Session) -> wire.CollectionConsumptionUndoOut:
        if state.undo_states_in_txn(db, viewer_id=viewer_id, receipt=receipt):
            record_input_change(
                db, owners=(f"consumption:{viewer_id}:{item.media_id}" for item in receipt.items)
            )
        return wire.CollectionConsumptionUndoOut(restored_count=len(receipt.items))

    return viewer_txn("undo_collection_consumption", viewer_id, run)
