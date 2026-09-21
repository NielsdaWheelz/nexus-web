"""Podcast subscription commands, status reads and the lifecycle projection."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final
from uuid import UUID

from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from nexus.db.errors import TransactionRestart
from nexus.db.retries import retry_read_committed
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.ids import new_uuid7
from nexus.schemas.collection_page import CollectionRevision
from nexus.schemas.contributors import ContributorCreditIn
from nexus.schemas.podcast import (
    PodcastAlreadyUnsubscribedOut,
    PodcastBackfillOut,
    PodcastBackfillRetryOut,
    PodcastBackfillState,
    PodcastCanonicalCommitTarget,
    PodcastDiscoveryCommitTarget,
    PodcastSourceFacts,
    PodcastSubscribeDestinationOutcomeOut,
    PodcastSubscribeOut,
    PodcastSubscribeRequest,
    PodcastSubscriptionLifecycleBackfillOut,
    PodcastSubscriptionLifecycleSnapshotOut,
    PodcastSubscriptionSettingsOut,
    PodcastSubscriptionSettingsPatchRequest,
    PodcastSubscriptionStatusOut,
    PodcastUnsubscribedOut,
    PodcastUnsubscribeOut,
)
from nexus.schemas.presence import Present, nullable_from_presence, presence_from_nullable
from nexus.services.browse.models import ResolvedPodcast
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_collection_families,
    read_collection_revision,
)
from nexus.services.library_entries import (
    place_podcast_in_named_libraries_in_current_transaction,
    remove_unsubscribed_podcast_placements,
)
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)

from .backfill import seed_subscription_backfill_in_current_transaction
from .identity import (
    apply_podcast_contributor_credits_in_current_transaction,
    select_podcast_id_by_feed_url,
    select_podcast_id_by_provider_id,
    upsert_podcast,
    validate_and_normalize_feed_url,
)
from .playback_preferences import pause_shortening_mode_from_nullable
from .refresh import admit_subscription_generation_in_txn
from .types import PODCAST_SYNC_INTERACTIVE_PRIORITY

PODCAST_SUBSCRIPTION_NOTIFY_CHANNEL = "podcast_subscription_events"
PODCAST_CONTROL_REPLAY_SCOPE: Final = "podcast:control"
_TERMINAL_SYNC_STATUSES = frozenset({"Complete", "SourceLimited", "Failed"})

SUBSCRIPTION_STATUS_COLUMNS = """
    ps.id AS subscription_id,
    ps.user_id AS subscription_user_id,
    ps.podcast_id AS subscription_podcast_id,
    ps.default_playback_speed,
    ps.pause_shortening_mode,
    ps.auto_queue,
    ps.sync_status,
    ps.sync_error_code,
    ps.sync_error_message,
    ps.sync_attempts,
    ps.sync_started_at,
    ps.sync_completed_at,
    ps.last_checked_at,
    ps.updated_at AS subscription_updated_at,
    backfill.id AS backfill_id,
    backfill.started_at AS backfill_started_at,
    backfill.completed_at AS backfill_completed_at,
    backfill.source_limited_at AS backfill_source_limited_at,
    backfill.failed_at AS backfill_failed_at,
    backfill.processed_count AS backfill_processed_count,
    backfill.added_count AS backfill_added_count
"""


@dataclass(frozen=True)
class PodcastSubscriptionLifecycle:
    """Private listener identity paired with the browser-visible snapshot."""

    subscription_id: UUID
    snapshot: PodcastSubscriptionLifecycleSnapshotOut
    terminal: bool


def backfill_state_from_row(row: RowMapping) -> PodcastBackfillState:
    if row["backfill_failed_at"] is not None:
        return "Failed"
    if row["backfill_source_limited_at"] is not None:
        return "SourceLimited"
    if row["backfill_completed_at"] is not None:
        return "Complete"
    return "Running" if row["backfill_started_at"] is not None else "Pending"


def backfill_out_from_row(row: RowMapping) -> PodcastBackfillOut:
    return PodcastBackfillOut(
        id=UUID(str(row["backfill_id"])),
        state=backfill_state_from_row(row),
        processed_count=int(row["backfill_processed_count"]),
        added_count=int(row["backfill_added_count"]),
    )


def subscription_status_from_row(row: RowMapping) -> PodcastSubscriptionStatusOut:
    """Build the one snake-case status body every subscription route returns."""
    return PodcastSubscriptionStatusOut(
        user_id=UUID(str(row["subscription_user_id"])),
        podcast_id=UUID(str(row["subscription_podcast_id"])),
        default_playback_speed=presence_from_nullable(
            None if row["default_playback_speed"] is None else float(row["default_playback_speed"])
        ),
        pause_shortening_mode=pause_shortening_mode_from_nullable(row["pause_shortening_mode"]),
        auto_queue=bool(row["auto_queue"]),
        sync_status=row["sync_status"],
        sync_error_code=row["sync_error_code"],
        sync_error_message=row["sync_error_message"],
        sync_attempts=row["sync_attempts"],
        sync_started_at=row["sync_started_at"],
        sync_completed_at=row["sync_completed_at"],
        last_checked_at=row["last_checked_at"],
        updated_at=row["subscription_updated_at"],
        backfill=backfill_out_from_row(row),
    )


def read_subscription_row(db: Session, *, viewer_id: UUID, podcast_id: UUID) -> RowMapping:
    row = (
        db.execute(
            text(
                f"""
                SELECT {SUBSCRIPTION_STATUS_COLUMNS}
                FROM podcast_subscriptions ps
                JOIN podcast_subscription_backfills backfill
                  ON backfill.subscription_id = ps.id
                WHERE ps.user_id = :viewer_id AND ps.podcast_id = :podcast_id
                """
            ),
            {"viewer_id": viewer_id, "podcast_id": podcast_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast subscription not found")
    return row


def get_subscription_status(
    db: Session, viewer_id: UUID, podcast_id: UUID
) -> PodcastSubscriptionStatusOut:
    return subscription_status_from_row(
        read_subscription_row(db, viewer_id=viewer_id, podcast_id=podcast_id)
    )


def read_subscription_lifecycle(
    db: Session,
    *,
    viewer_id: UUID,
    podcast_id: UUID,
    expected_subscription_id: UUID | None = None,
) -> PodcastSubscriptionLifecycle:
    """Read one owner-checked lifecycle epoch driving a subscription stream."""
    row = read_subscription_row(db, viewer_id=viewer_id, podcast_id=podcast_id)
    subscription_id = UUID(str(row["subscription_id"]))
    if expected_subscription_id is not None and subscription_id != expected_subscription_id:
        # The listener is bound to the prior epoch and can never receive this
        # subscription's events: treat the replacement as gone.
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast subscription was replaced")
    backfill_state = backfill_state_from_row(row)
    return PodcastSubscriptionLifecycle(
        subscription_id=subscription_id,
        snapshot=PodcastSubscriptionLifecycleSnapshotOut(
            podcast_id=UUID(str(row["subscription_podcast_id"])),
            sync_status=row["sync_status"],
            backfill=PodcastSubscriptionLifecycleBackfillOut(
                id=UUID(str(row["backfill_id"])),
                state=backfill_state,
                processed_count=int(row["backfill_processed_count"]),
                added_count=int(row["backfill_added_count"]),
            ),
        ),
        terminal=(
            row["sync_status"] in _TERMINAL_SYNC_STATUSES
            and backfill_state in _TERMINAL_SYNC_STATUSES
        ),
    )


def subscribe_to_podcast(
    db: Session,
    viewer_id: UUID,
    body: PodcastSubscribeRequest,
    *,
    idempotency_key: str,
) -> PodcastSubscribeOut:
    """Resolve the target, subscribe once, and place the show in named libraries."""
    request_bytes = podcast_control_request_bytes(
        "POST", "/podcasts/subscriptions", body.model_dump(mode="json", by_alias=True)
    )
    replay = lookup_podcast_control_replay(db, viewer_id, idempotency_key, request_bytes)
    if replay is not None:
        return PodcastSubscribeOut.model_validate(replay)

    source, canonical_podcast_id = _resolve_subscribe_target(db, viewer_id, body)
    confirmation = (
        body.replacement_confirmation.value.conflict_fingerprint
        if isinstance(body.replacement_confirmation, Present)
        else None
    )

    def apply() -> PodcastSubscribeOut:
        preliminary_podcast_id = canonical_podcast_id
        if source is not None:
            preliminary_podcast_id = select_podcast_id_by_provider_id(
                db, source.provider_podcast_id
            ) or select_podcast_id_by_feed_url(db, source.feed_url)
        subscription_id = (
            _lock_subscription_id(db, viewer_id=viewer_id, podcast_id=preliminary_podcast_id)
            if preliminary_podcast_id is not None
            else None
        )

        now = datetime.now(UTC)
        podcast_id = (
            upsert_podcast(db, source, now=now) if source is not None else canonical_podcast_id
        )
        assert podcast_id is not None  # one of the two commit targets always names a show
        if preliminary_podcast_id is not None and podcast_id != preliminary_podcast_id:
            raise TransactionRestart("Podcast identity owner changed during Subscribe")
        if (
            db.execute(
                text("SELECT 1 FROM podcasts WHERE id = :podcast_id FOR UPDATE"),
                {"podcast_id": podcast_id},
            ).first()
            is None
        ):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
        if source is not None:
            apply_podcast_contributor_credits_in_current_transaction(
                db, podcast_id=podcast_id, contributors=source.contributors
            )

        created = subscription_id is None
        if subscription_id is None:
            subscription_id, created_at = _insert_subscription(
                db, user_id=viewer_id, podcast_id=podcast_id
            )
            seed_subscription_backfill_in_current_transaction(
                db, subscription_id=subscription_id, cutoff_at=created_at
            )
            admit_subscription_generation_in_txn(
                db,
                subscription_id=subscription_id,
                user_id=viewer_id,
                podcast_id=podcast_id,
                priority=PODCAST_SYNC_INTERACTIVE_PRIORITY,
            )
        placement = place_podcast_in_named_libraries_in_current_transaction(
            db,
            viewer_id=viewer_id,
            podcast_id=podcast_id,
            library_ids=body.named_library_ids,
            confirmation_fingerprint=confirmation,
        )
        _bump_subscription_collections(db, viewer_id)
        subscriptions_revision, library_entries_revision = _revisions(db, viewer_id)
        return PodcastSubscribeOut(
            href=f"/podcasts/{podcast_id}",
            podcast_id=podcast_id,
            outcome=(
                "Subscribed"
                if created
                else ("DestinationsAdded" if placement.added_library_ids else "AlreadySubscribed")
            ),
            destinations=[
                PodcastSubscribeDestinationOutcomeOut(
                    library_id=library_id,
                    outcome=(
                        "Added" if library_id in placement.added_library_ids else "AlreadyPresent"
                    ),
                )
                for library_id in dict.fromkeys(body.named_library_ids)
            ],
            backfill=backfill_out_from_row(
                read_subscription_row(db, viewer_id=viewer_id, podcast_id=podcast_id)
            ),
            collection_revision=subscriptions_revision,
            library_entries_collection_revision=library_entries_revision,
        )

    return _run_replayable_command(
        db,
        viewer_id=viewer_id,
        idempotency_key=idempotency_key,
        request_bytes=request_bytes,
        label="subscribe_to_podcast",
        podcast_identity=_command_identity(db, podcast_id=canonical_podcast_id, source=source),
        decode=PodcastSubscribeOut.model_validate,
        apply=apply,
    )


def retry_subscription_backfill(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
    *,
    idempotency_key: str,
) -> PodcastBackfillRetryOut:
    """Replace only a persistently failed current backfill, once per mutation key."""
    request_bytes = podcast_control_request_bytes(
        "POST", f"/podcasts/subscriptions/{podcast_id}/backfill/retry", None
    )

    def apply() -> PodcastBackfillRetryOut:
        subscription_id = _lock_subscription_id(db, viewer_id=viewer_id, podcast_id=podcast_id)
        if subscription_id is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast subscription not found")
        cutoff_at = db.scalar(
            text(
                """
                DELETE FROM podcast_subscription_backfills
                WHERE subscription_id = :subscription_id AND failed_at IS NOT NULL
                RETURNING cutoff_at
                """
            ),
            {"subscription_id": subscription_id},
        )
        if cutoff_at is not None:
            seed_subscription_backfill_in_current_transaction(
                db, subscription_id=subscription_id, cutoff_at=cutoff_at
            )
        return PodcastBackfillRetryOut(
            podcast_id=podcast_id,
            outcome="Retried" if cutoff_at is not None else "NotEligible",
            backfill=backfill_out_from_row(
                read_subscription_row(db, viewer_id=viewer_id, podcast_id=podcast_id)
            ),
        )

    return _run_replayable_command(
        db,
        viewer_id=viewer_id,
        idempotency_key=idempotency_key,
        request_bytes=request_bytes,
        label="retry_subscription_backfill",
        podcast_identity=_command_identity(db, podcast_id=podcast_id, source=None),
        decode=PodcastBackfillRetryOut.model_validate,
        apply=apply,
    )


def unsubscribe_from_podcast(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
    *,
    idempotency_key: str,
) -> PodcastUnsubscribeOut:
    """Drop the subscription, its backfill and the viewer's own placements."""
    request_bytes = podcast_control_request_bytes(
        "DELETE", f"/podcasts/subscriptions/{podcast_id}", None
    )

    def apply() -> PodcastUnsubscribeOut:
        subscription_id = _lock_subscription_id(db, viewer_id=viewer_id, podcast_id=podcast_id)
        if subscription_id is None:
            subscriptions_revision, library_entries_revision = _revisions(db, viewer_id)
            return PodcastAlreadyUnsubscribedOut(
                podcast_id=podcast_id,
                collectionRevision=subscriptions_revision,
                libraryEntriesCollectionRevision=library_entries_revision,
            )
        removal = remove_unsubscribed_podcast_placements(
            db, viewer_id=viewer_id, podcast_id=podcast_id
        )
        db.execute(
            text(
                "DELETE FROM podcast_subscription_backfills WHERE subscription_id = :subscription_id"
            ),
            {"subscription_id": subscription_id},
        )
        db.execute(
            text("DELETE FROM podcast_subscriptions WHERE id = :subscription_id"),
            {"subscription_id": subscription_id},
        )
        from nexus.services.artifacts.dossier_types import AudienceUser
        from nexus.services.artifacts.engine import on_audience_visibility_changed

        on_audience_visibility_changed(db, audience=AudienceUser(user_id=viewer_id))
        _bump_subscription_collections(db, viewer_id, episodes=True)
        subscriptions_revision, library_entries_revision = _revisions(db, viewer_id)
        return PodcastUnsubscribedOut(
            podcast_id=podcast_id,
            removed_placement_count=removal.removed_from_library_count,
            retained_shared_count=removal.retained_shared_library_count,
            collectionRevision=subscriptions_revision,
            libraryEntriesCollectionRevision=library_entries_revision,
        )

    return _run_replayable_command(
        db,
        viewer_id=viewer_id,
        idempotency_key=idempotency_key,
        request_bytes=request_bytes,
        label="unsubscribe_from_podcast",
        podcast_identity=_command_identity(db, podcast_id=podcast_id, source=None),
        decode=_unsubscribe_from_replay,
        apply=apply,
    )


def update_subscription_settings_for_viewer(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
    body: PodcastSubscriptionSettingsPatchRequest,
) -> PodcastSubscriptionSettingsOut:
    """Write any subset of the viewer's playback settings and return the status."""
    assignments: list[str] = []
    params: dict[str, Any] = {
        "viewer_id": viewer_id,
        "podcast_id": podcast_id,
        "updated_at": datetime.now(UTC),
    }
    if "default_playback_speed" in body.model_fields_set:
        assignments.append("default_playback_speed = :default_playback_speed")
        params["default_playback_speed"] = nullable_from_presence(body.default_playback_speed)
    if "pause_shortening_mode" in body.model_fields_set:
        assignments.append("pause_shortening_mode = :pause_shortening_mode")
        params["pause_shortening_mode"] = nullable_from_presence(body.pause_shortening_mode)
    if "auto_queue" in body.model_fields_set:
        assignments.append("auto_queue = :auto_queue")
        params["auto_queue"] = bool(body.auto_queue)
    if not assignments:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "At least one subscription settings field must be provided",
        )

    with transaction(db):
        updated = db.execute(
            text(
                f"""
                UPDATE podcast_subscriptions
                SET {", ".join([*assignments, "updated_at = :updated_at"])}
                WHERE user_id = :viewer_id AND podcast_id = :podcast_id
                RETURNING 1
                """
            ),
            params,
        ).fetchone()
        if updated is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast subscription not found")
        _bump_subscription_collections(db, viewer_id)
        subscriptions_revision, library_entries_revision = _revisions(db, viewer_id)
        status = subscription_status_from_row(
            read_subscription_row(db, viewer_id=viewer_id, podcast_id=podcast_id)
        )
        return PodcastSubscriptionSettingsOut(
            **status.model_dump(),
            collectionRevision=subscriptions_revision,
            libraryEntriesCollectionRevision=library_entries_revision,
        )


def _resolve_subscribe_target(
    db: Session, viewer_id: UUID, body: PodcastSubscribeRequest
) -> tuple[PodcastSourceFacts | None, UUID | None]:
    if isinstance(body.target, PodcastDiscoveryCommitTarget):
        from nexus.services.browse.service import resolve_podcast_discovery_target

        resolved = resolve_podcast_discovery_target(body.target.target)
        if not isinstance(resolved, ResolvedPodcast):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_DISCOVERY_TARGET, "Discovery target is not a Podcast"
            )
        return (
            PodcastSourceFacts(
                provider_podcast_id=resolved.podcast_ref,
                title=resolved.title,
                contributors=(
                    [ContributorCreditIn(credited_name=resolved.author, role="author")]
                    if resolved.author
                    else []
                ),
                feed_url=validate_and_normalize_feed_url(resolved.feed_url),
                website_url=resolved.website_url,
                image_url=resolved.image_url,
                description=resolved.description,
            ),
            None,
        )
    if not isinstance(body.target, PodcastCanonicalCommitTarget):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Unsupported Podcast subscribe target"
        )
    visible = db.execute(
        text(
            """
            SELECT 1
            FROM podcasts podcast
            WHERE podcast.id = :podcast_id
              AND (
                EXISTS (
                    SELECT 1 FROM podcast_subscriptions subscription
                    WHERE subscription.user_id = :viewer_id
                      AND subscription.podcast_id = podcast.id
                )
                OR EXISTS (
                    SELECT 1
                    FROM library_entries entry
                    JOIN memberships membership
                      ON membership.library_id = entry.library_id
                     AND membership.user_id = :viewer_id
                    WHERE entry.podcast_id = podcast.id
                )
              )
            """
        ),
        {"viewer_id": viewer_id, "podcast_id": body.target.podcast_id},
    ).fetchone()
    db.rollback()
    if visible is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
    return None, body.target.podcast_id


def _insert_subscription(db: Session, *, user_id: UUID, podcast_id: UUID) -> tuple[UUID, datetime]:
    subscription_id = new_uuid7()
    created_at = db.execute(
        text(
            """
            INSERT INTO podcast_subscriptions (
                id, user_id, podcast_id, auto_queue, sync_status, sync_generation,
                next_sync_at, consecutive_sync_failures, created_at, updated_at
            )
            VALUES (:id, :user_id, :podcast_id, false, 'Pending', 1, now(), 0, now(), now())
            RETURNING created_at
            """
        ),
        {"id": subscription_id, "user_id": user_id, "podcast_id": podcast_id},
    ).scalar_one()
    return subscription_id, created_at


def _lock_subscription_id(db: Session, *, viewer_id: UUID, podcast_id: UUID) -> UUID | None:
    return db.scalar(
        text(
            """
            SELECT id
            FROM podcast_subscriptions
            WHERE user_id = :viewer_id AND podcast_id = :podcast_id
            FOR UPDATE
            """
        ),
        {"viewer_id": viewer_id, "podcast_id": podcast_id},
    )


def _command_identity(
    db: Session, *, podcast_id: UUID | None, source: PodcastSourceFacts | None
) -> str:
    """Stable per-show command identity shared by Subscribe, Retry and Unsubscribe."""
    if source is not None:
        return f"podcast_index:{source.provider_podcast_id}"
    assert podcast_id is not None  # a canonical command always names its show
    row = db.execute(
        text("SELECT provider, provider_podcast_id FROM podcasts WHERE id = :podcast_id"),
        {"podcast_id": podcast_id},
    ).first()
    db.rollback()
    if row is None or not row[0] or not row[1]:
        return f"canonical:{podcast_id}"
    return f"{row[0]}:{row[1]}"


def _lock_subscription_command(db: Session, *, viewer_id: UUID, podcast_identity: str) -> None:
    """Serialize the same viewer/Podcast relationship before any row lock."""
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))"),
        {"lock_key": f"podcast-subscription:{viewer_id}:{podcast_identity}"},
    )


def podcast_control_request_bytes(method: str, path: str, body: Mapping[str, Any] | None) -> bytes:
    return canonical_json_bytes(
        {"method": method, "path": path, "body": dict(body) if body is not None else {}}
    )


def lookup_podcast_control_replay(
    db: Session, viewer_id: UUID, idempotency_key: str, request_bytes: bytes
) -> dict[str, object] | None:
    """Read the frozen command result before any provider resolution or I/O."""
    if not idempotency_key.strip():
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Idempotency-Key must be nonblank"
        )
    try:
        return lookup_replay(
            db,
            viewer_id=viewer_id,
            scope=PODCAST_CONTROL_REPLAY_SCOPE,
            client_mutation_id=idempotency_key,
            request_bytes=request_bytes,
        )
    finally:
        db.rollback()


def _run_replayable_command[T: BaseModel](
    db: Session,
    *,
    viewer_id: UUID,
    idempotency_key: str,
    request_bytes: bytes,
    label: str,
    podcast_identity: str,
    decode: Callable[[dict[str, object]], T],
    apply: Callable[[], T],
) -> T:
    """Run one command under its per-show lock, answering a replay from the ledger."""
    replay = lookup_podcast_control_replay(db, viewer_id, idempotency_key, request_bytes)
    if replay is not None:
        return decode(replay)

    def attempt() -> T:
        with transaction(db):
            _lock_subscription_command(db, viewer_id=viewer_id, podcast_identity=podcast_identity)
            replay = lookup_replay(
                db,
                viewer_id=viewer_id,
                scope=PODCAST_CONTROL_REPLAY_SCOPE,
                client_mutation_id=idempotency_key,
                request_bytes=request_bytes,
            )
            if replay is not None:
                return decode(replay)
            response = apply()
            record_replay(
                db,
                viewer_id=viewer_id,
                scope=PODCAST_CONTROL_REPLAY_SCOPE,
                client_mutation_id=idempotency_key,
                request_bytes=request_bytes,
                response_json=response.model_dump(mode="json", by_alias=True),
            )
            return response

    return retry_read_committed(db, label, attempt)


def _unsubscribe_from_replay(replay: dict[str, object]) -> PodcastUnsubscribeOut:
    if replay.get("outcome") == "Unsubscribed":
        return PodcastUnsubscribedOut.model_validate(replay)
    return PodcastAlreadyUnsubscribedOut.model_validate(replay)


def _revisions(db: Session, viewer_id: UUID) -> tuple[CollectionRevision, CollectionRevision]:
    """The (subscriptions, library entries) revision pair every command returns."""
    return (
        read_collection_revision(
            db, viewer_id=viewer_id, family=CollectionFamily.PodcastSubscriptions
        ),
        read_collection_revision(db, viewer_id=viewer_id, family=CollectionFamily.LibraryEntries),
    )


def _bump_subscription_collections(db: Session, viewer_id: UUID, *, episodes: bool = False) -> None:
    families = [CollectionFamily.LibraryEntries, CollectionFamily.PodcastSubscriptions]
    if episodes:
        families.append(CollectionFamily.PodcastEpisodes)
    bump_collection_families(db, viewer_ids=(viewer_id,), families=families)
