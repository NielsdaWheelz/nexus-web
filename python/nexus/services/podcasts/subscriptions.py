"""Subscriptions: follow, unfollow, settings, backlog retry, and the status they report.

A row exists iff the viewer follows the show. Follow compares frozen removal
and named-destination revisions atomically; no receipt bypasses stale guards.
Unfollow advances the viewer removal fence even when already absent. History retry captures a traversal id; playback updates capture a
subscription id/version and accept an exact desired-value retry without a write.
"""

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from nexus.db.retries import retry_read_committed, retry_serializable
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.ids import new_uuid7
from nexus.schemas import podcast as wire
from nexus.services import library_entries, users
from nexus.services.browse.targets import ResolvedPodcast
from nexus.services.library_entries import (
    place_podcast_in_named_libraries_in_current_transaction,
    remove_unsubscribed_podcast_placements,
)
from nexus.services.suggestion_changes import record_input_change

from . import backfill, sync
from .shows import upsert_show

PODCAST_SUBSCRIPTION_NOTIFY_CHANNEL = "podcast_subscription_events"
_STATUS_SQL = """
    SELECT s.*, b.id AS backfill_id, b.started_at AS b_started, b.completed_at AS b_completed,
           b.failed_at AS b_failed, b.updated_at AS b_updated,
           b.error_code AS b_error_code, b.error_detail AS b_error_detail
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
    """Derive traversal phase; coverage errors are independent of completion."""
    state: wire.PodcastSyncStatus = (
        "Failed"
        if row["b_failed"]
        else "Complete"
        if row["b_completed"]
        else "Running"
        if row["b_started"]
        else "Pending"
    )
    return wire.PodcastBackfillOut(
        id=row["backfill_id"],
        state=state,
        updated_at=row["b_updated"],
        error_code=row["b_error_code"],
        error_detail=row["b_error_detail"],
    )


def _status(row: RowMapping) -> wire.PodcastSubscriptionStatusOut:
    return wire.PodcastSubscriptionStatusOut(
        subscription_id=row["id"],
        settings_version=row["settings_version"],
        user_id=row["user_id"],
        podcast_id=row["podcast_id"],
        default_playback_speed=row["default_playback_speed"],
        pause_shortening_mode=row["pause_shortening_mode"],
        sync_had_rejected_items=row["sync_had_rejected_items"],
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
            podcast_id=podcast_id,
            subscription_id=row["id"],
            sync_status=row["sync_status"],
            sync_completed_at=row["sync_completed_at"],
            backfill=backfill_out,
        ),
        terminal=row["sync_status"] in sync.TERMINAL and backfill_out.state in sync.TERMINAL,
    )


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

    def attempt() -> wire.PodcastSubscribeOut:
        with transaction(db):
            users.lock_viewer(db, viewer_id)
            if isinstance(show, UUID):  # any persisted show is followable, as its detail is
                podcast_id = show
                if db.scalar(text("SELECT 1 FROM podcasts WHERE id = :id"), {"id": show}) is None:
                    raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
            else:
                podcast_id = upsert_show(db, show)
            db.execute(text("SELECT 1 FROM podcasts WHERE id=:id FOR UPDATE"), {"id": podcast_id})
            destination_ids = [guard.library_id for guard in body.destinations]
            displaced = db.scalars(
                text("""
                SELECT le.media_id FROM library_entries le
                JOIN podcast_episodes pe ON pe.media_id=le.media_id
                WHERE pe.podcast_id=:p AND le.library_id=ANY(:ids)
            """),
                {"p": podcast_id, "ids": destination_ids},
            ).all()
            library_entries.lock_media_rows_in_order(db, displaced)
            destination_ids = library_entries.validate_acquisition_destinations(
                db,
                viewer_id=viewer_id,
                expected_removal_revision=int(body.expected_removal_revision),
                destinations=body.destinations,
            )
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
                library_ids=destination_ids,
                replace_episodes=body.replace_episodes,
            )
            library_entries.finish_acquisition_destinations(db, destinations=body.destinations)
            outcome = "DestinationsAdded" if added else "AlreadySubscribed"
            response = wire.PodcastSubscribeOut(
                href=f"/podcasts/{podcast_id}",
                podcast_id=podcast_id,
                outcome="Subscribed" if created is not None else outcome,
                destinations=[
                    wire.PodcastDestinationOutcomeOut(
                        library_id=library_id,
                        outcome="Added" if library_id in added else "AlreadyPresent",
                    )
                    for library_id in destination_ids
                ],
                backfill=_backfill(_require_row(db, viewer_id, podcast_id)),
            )
            if created is not None or added or not isinstance(show, UUID):
                record_input_change(db)
            return response

    return retry_read_committed(db, "subscribe_to_podcast", attempt)


def unsubscribe(db: Session, viewer_id: UUID, podcast_id: UUID) -> wire.PodcastUnsubscribeOut:
    """Drop the subscription (its backfill cascades) and the placements the viewer solely
    owns; shared placements stay. Episodes stay in All with their progress."""
    from nexus.services.dossier.engine import on_visibility_lost

    def attempt() -> wire.PodcastUnsubscribeOut:
        with transaction(db):
            users.lock_viewer(db, viewer_id)
            users.advance_removal_revision(db, viewer_id)
            db.execute(text("SELECT 1 FROM podcasts WHERE id=:id FOR UPDATE"), {"id": podcast_id})
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
            record_input_change(db)
            return wire.PodcastUnsubscribeOut(
                outcome="Unsubscribed",
                podcast_id=podcast_id,
                removed_placement_count=removed,
                retained_shared_count=retained,
            )

    return retry_read_committed(db, "unsubscribe_from_podcast", attempt)


def retry_backfill(
    db: Session, viewer_id: UUID, podcast_id: UUID, expected_backfill_id: UUID
) -> wire.PodcastBackfillRetryOut:
    """Replace the observed terminal problem once, preserving cutoff and coverage error.

    The subscription lock serializes replacement with unsubscribe and other retries.
    Repeating the captured id cannot restart its replacement.
    """

    def attempt() -> wire.PodcastBackfillRetryOut:
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
            removed = db.execute(
                text("""
                    DELETE FROM podcast_subscription_backfills
                    WHERE subscription_id = :subscription_id AND id = :expected_id
                      AND (failed_at IS NOT NULL OR (completed_at IS NOT NULL AND error_code IS NOT NULL))
                    RETURNING cutoff_at, error_code, error_detail
                """),
                {"subscription_id": subscription_id, "expected_id": expected_backfill_id},
            ).first()
            if removed is not None:
                backfill.seed(
                    db,
                    subscription_id,
                    removed.cutoff_at,
                    error_code=removed.error_code,
                    error_detail=removed.error_detail,
                )
            return wire.PodcastBackfillRetryOut(
                podcast_id=podcast_id,
                outcome="Retried" if removed is not None else "NotEligible",
                backfill=_backfill(_require_row(db, viewer_id, podcast_id)),
            )

    return retry_read_committed(db, "retry_podcast_history", attempt)


def patch_settings(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
    body: wire.PodcastSubscriptionSettingsPatchRequest,
) -> wire.PodcastSubscriptionStatusOut:
    """Set the captured subscription's playback pair atomically.

    An exact desired-value retry is inert even at an older version. A replacement
    subscription or differing stale pair conflicts; no partial playback writes.
    """

    def attempt() -> wire.PodcastSubscriptionStatusOut:
        with transaction(db):
            row = (
                db.execute(
                    text(_STATUS_SQL + " FOR UPDATE OF s"),
                    {"viewer_id": viewer_id, "podcast_id": podcast_id},
                )
                .mappings()
                .first()
            )
            if row is None:
                raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast subscription not found")
            if row["id"] != body.expected_subscription_id:
                raise ConflictError(
                    ApiErrorCode.E_RESOURCE_CONFLICT, "Podcast subscription was replaced"
                )
            if (row["default_playback_speed"], row["pause_shortening_mode"]) == (
                body.default_playback_speed,
                body.pause_shortening_mode,
            ):
                return _status(row)
            if row["settings_version"] != body.expected_settings_version:
                raise ConflictError(
                    ApiErrorCode.E_RESOURCE_CONFLICT, "Podcast subscription settings changed"
                )
            db.execute(
                text("""
                UPDATE podcast_subscriptions
                SET default_playback_speed = :speed, pause_shortening_mode = :silence,
                    settings_version = settings_version + 1, updated_at = now()
                WHERE id = :id
            """),
                {
                    "id": row["id"],
                    "speed": body.default_playback_speed,
                    "silence": body.pause_shortening_mode,
                },
            )
            return _status(_require_row(db, viewer_id, podcast_id))

    return retry_serializable(db, "patch_podcast_subscription_settings", attempt)
