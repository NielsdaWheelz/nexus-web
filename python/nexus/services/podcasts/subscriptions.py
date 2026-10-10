"""Subscriptions: follow, unfollow, settings, backlog retry, and the status they report.

A row exists iff the viewer follows the show. Every command is idempotent by
construction: a repeat converges on the same rows and reports what it found
(AlreadySubscribed, AlreadyUnsubscribed, NotEligible).
"""

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from nexus.db.retries import retry_read_committed
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.ids import new_uuid7
from nexus.schemas import podcast as wire
from nexus.schemas.presence import Present, nullable_from_presence, presence_from_nullable
from nexus.services.browse.targets import ResolvedPodcast
from nexus.services.collection_revisions import CollectionFamily, bump_collection_families
from nexus.services.library_entries import (
    place_podcast_in_named_libraries_in_current_transaction,
    remove_unsubscribed_podcast_placements,
)

from . import backfill, sync
from .shows import upsert_show

PODCAST_SUBSCRIPTION_NOTIFY_CHANNEL = "podcast_subscription_events"
_STATUS_SQL = """
    SELECT s.*, b.id AS backfill_id, b.started_at AS b_started, b.completed_at AS b_completed,
           b.source_limited_at AS b_limited, b.failed_at AS b_failed,
           b.processed_count, b.added_count
    FROM podcast_subscriptions s
    JOIN podcast_subscription_backfills b ON b.subscription_id = s.id
    WHERE s.user_id = :viewer_id AND s.podcast_id = :podcast_id
"""


@dataclass(frozen=True, slots=True)
class PodcastSubscriptionLifecycle:
    subscription_id: UUID
    snapshot: wire.PodcastSubscriptionLifecycleSnapshotOut
    terminal: bool


def _row(db: Session, viewer_id: UUID, podcast_id: UUID) -> RowMapping | None:
    params = {"viewer_id": viewer_id, "podcast_id": podcast_id}
    return db.execute(text(_STATUS_SQL), params).mappings().first()


def _require_row(db: Session, viewer_id: UUID, podcast_id: UUID) -> RowMapping:
    row = _row(db, viewer_id, podcast_id)
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast subscription not found")
    return row


def _backfill(row: RowMapping) -> wire.PodcastBackfillOut:
    """The state is the first stamp present: failed, source-limited, completed, started."""
    state: wire.PodcastSyncStatus = (
        "Failed"
        if row["b_failed"]
        else "SourceLimited"
        if row["b_limited"]
        else "Complete"
        if row["b_completed"]
        else "Running"
        if row["b_started"]
        else "Pending"
    )
    return wire.PodcastBackfillOut(
        id=row["backfill_id"],
        state=state,
        processed_count=row["processed_count"],
        added_count=row["added_count"],
    )


def _status(row: RowMapping) -> wire.PodcastSubscriptionStatusOut:
    return wire.PodcastSubscriptionStatusOut(
        user_id=row["user_id"],
        podcast_id=row["podcast_id"],
        default_playback_speed=presence_from_nullable(row["default_playback_speed"]),
        pause_shortening_mode=presence_from_nullable(row["pause_shortening_mode"]),
        auto_queue=row["auto_queue"],
        sync_status=row["sync_status"],
        sync_error_code=row["sync_error_code"],
        sync_error_message=row["sync_error_message"],
        sync_attempts=row["sync_attempts"],
        sync_started_at=row["sync_started_at"],
        sync_completed_at=row["sync_completed_at"],
        last_checked_at=row["last_checked_at"],
        updated_at=row["updated_at"],
        backfill=_backfill(row),
    )


def find_status(
    db: Session, viewer_id: UUID, podcast_id: UUID
) -> wire.PodcastSubscriptionStatusOut | None:
    row = _row(db, viewer_id, podcast_id)
    return None if row is None else _status(row)


def get_status(db: Session, viewer_id: UUID, podcast_id: UUID) -> wire.PodcastSubscriptionStatusOut:
    return _status(_require_row(db, viewer_id, podcast_id))


def read_subscription_lifecycle(
    db: Session, *, viewer_id: UUID, podcast_id: UUID, expected_subscription_id: UUID | None = None
) -> PodcastSubscriptionLifecycle:
    """The stream's state; a replaced subscription is gone (its listener can't hear it)."""
    row = _require_row(db, viewer_id, podcast_id)
    if expected_subscription_id not in (None, row["id"]):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast subscription was replaced")
    backfill_out = _backfill(row)
    return PodcastSubscriptionLifecycle(
        subscription_id=row["id"],
        snapshot=wire.PodcastSubscriptionLifecycleSnapshotOut(
            podcast_id=podcast_id, sync_status=row["sync_status"], backfill=backfill_out
        ),
        terminal=row["sync_status"] in sync.TERMINAL and backfill_out.state in sync.TERMINAL,
    )


def _bump(db: Session, viewer_id: UUID, *families: CollectionFamily) -> None:
    bump_collection_families(db, viewer_ids=(viewer_id,), families=families)


def subscribe(
    db: Session, viewer_id: UUID, body: wire.PodcastSubscribeRequest
) -> wire.PodcastSubscribeOut:
    """Follow a discovered or any persisted show and place it in the named libraries. The
    first follow seeds the backfill at the subscription's creation and admits a sync."""
    from nexus.services.browse.service import resolve_podcast_discovery_target  # imports us

    if isinstance(body.target, wire.PodcastCanonicalCommitTarget):
        show: ResolvedPodcast | UUID = body.target.podcast_id
    else:
        resolved = resolve_podcast_discovery_target(body.target.target)  # provider i/o, no txn
        if not isinstance(resolved, ResolvedPodcast):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_DISCOVERY_TARGET, "Discovery target is not a Podcast"
            )
        show = resolved
    confirmation = body.replacement_confirmation
    fingerprint = (
        confirmation.value.conflict_fingerprint if isinstance(confirmation, Present) else None
    )

    def attempt() -> wire.PodcastSubscribeOut:
        with transaction(db):
            if isinstance(show, UUID):  # any persisted show is followable, as its detail is
                podcast_id = show
                if db.scalar(text("SELECT 1 FROM podcasts WHERE id = :id"), {"id": show}) is None:
                    raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
            else:
                podcast_id = upsert_show(db, show)
            created = db.execute(
                text("""
                    INSERT INTO podcast_subscriptions (id, user_id, podcast_id, next_sync_at)
                    VALUES (:id, :viewer_id, :podcast_id, now())
                    ON CONFLICT (user_id, podcast_id) DO NOTHING
                    RETURNING id, created_at
                """),
                {"id": new_uuid7(), "viewer_id": viewer_id, "podcast_id": podcast_id},
            ).first()
            if created is not None:  # inserted Pending: its backfill and its one sync job
                backfill.seed(db, created.id, created.created_at)
                sync.enqueue(db, created.id, interactive=True)
            added = place_podcast_in_named_libraries_in_current_transaction(
                db,
                viewer_id=viewer_id,
                podcast_id=podcast_id,
                library_ids=body.named_library_ids,
                confirmation_fingerprint=fingerprint,
            )
            if created is not None or added:  # the followed list or a library listing moved
                families = (CollectionFamily.LibraryEntries, CollectionFamily.PodcastSubscriptions)
                _bump(db, viewer_id, *families)
            outcome = "DestinationsAdded" if added else "AlreadySubscribed"
            return wire.PodcastSubscribeOut(
                href=f"/podcasts/{podcast_id}",
                podcast_id=podcast_id,
                outcome="Subscribed" if created is not None else outcome,
                destinations=[
                    wire.PodcastDestinationOutcomeOut(
                        library_id=library_id,
                        outcome="Added" if library_id in added else "AlreadyPresent",
                    )
                    for library_id in dict.fromkeys(body.named_library_ids)
                ],
                backfill=_backfill(_require_row(db, viewer_id, podcast_id)),
            )

    return retry_read_committed(db, "subscribe_to_podcast", attempt)


def unsubscribe(db: Session, viewer_id: UUID, podcast_id: UUID) -> wire.PodcastUnsubscribeOut:
    """Drop the subscription (its backfill cascades) and the placements the viewer solely
    owns; shared placements stay. Episodes stay in All with their progress."""
    from nexus.services.dossier.engine import on_visibility_lost

    def attempt() -> wire.PodcastUnsubscribeOut:
        with transaction(db):
            subscription_id = db.scalar(
                text("""
                    DELETE FROM podcast_subscriptions
                    WHERE user_id = :viewer_id AND podcast_id = :podcast_id
                    RETURNING id
                """),
                {"viewer_id": viewer_id, "podcast_id": podcast_id},
            )
            if subscription_id is None:
                return wire.PodcastUnsubscribeOut(
                    outcome="AlreadyUnsubscribed", podcast_id=podcast_id
                )
            removed, retained = remove_unsubscribed_podcast_placements(
                db, viewer_id=viewer_id, podcast_id=podcast_id
            )
            on_visibility_lost(db, user_id=viewer_id)
            _bump(
                db,
                viewer_id,
                CollectionFamily.LibraryEntries,
                CollectionFamily.PodcastSubscriptions,
                CollectionFamily.PodcastEpisodes,
            )
            return wire.PodcastUnsubscribeOut(
                outcome="Unsubscribed",
                podcast_id=podcast_id,
                removed_placement_count=removed,
                retained_shared_count=retained,
            )

    return retry_read_committed(db, "unsubscribe_from_podcast", attempt)


def retry_backfill(db: Session, viewer_id: UUID, podcast_id: UUID) -> wire.PodcastBackfillRetryOut:
    """Replace a failed backfill with a fresh one at the same cutoff; otherwise NotEligible.
    A concurrent repeat finds the failed row already gone. Locks the subscription row
    first, as unsubscribe does, so the two never wait on each other's backfill row."""
    with transaction(db):
        subscription_id = db.scalar(
            text("""
                SELECT id FROM podcast_subscriptions
                WHERE user_id = :viewer_id AND podcast_id = :podcast_id FOR UPDATE
            """),
            {"viewer_id": viewer_id, "podcast_id": podcast_id},
        )
        if subscription_id is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast subscription not found")
        cutoff = db.scalar(
            text("""
                DELETE FROM podcast_subscription_backfills
                WHERE subscription_id = :id AND failed_at IS NOT NULL
                RETURNING cutoff_at
            """),
            {"id": subscription_id},
        )
        if cutoff is not None:
            backfill.seed(db, subscription_id, cutoff)
        return wire.PodcastBackfillRetryOut(
            podcast_id=podcast_id,
            outcome="Retried" if cutoff is not None else "NotEligible",
            backfill=_backfill(_require_row(db, viewer_id, podcast_id)),
        )


def patch_settings(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
    body: wire.PodcastSubscriptionSettingsPatchRequest,
) -> wire.PodcastSubscriptionStatusOut:
    """Set the given fields. Turning auto-queue on starts its watermark now, so only
    episodes published from here on are queued."""
    values = {
        name: nullable_from_presence(getattr(body, name))
        for name in ("default_playback_speed", "pause_shortening_mode")
        if name in body.model_fields_set
    }
    if "auto_queue" in body.model_fields_set:
        values["auto_queue"] = body.auto_queue
    assignments = [f"{name} = :{name}" for name in values]
    if body.auto_queue:  # SET reads the old auto_queue
        assignments.append(
            "auto_queue_watermark_at = CASE WHEN auto_queue THEN auto_queue_watermark_at"
            " ELSE now() END"
        )
    with transaction(db):
        updated = db.scalar(
            text(f"""
                UPDATE podcast_subscriptions SET {", ".join(assignments)}, updated_at = now()
                WHERE user_id = :viewer_id AND podcast_id = :podcast_id
                RETURNING id
            """),
            {**values, "viewer_id": viewer_id, "podcast_id": podcast_id},
        )
        if updated is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast subscription not found")
        return _status(_require_row(db, viewer_id, podcast_id))
