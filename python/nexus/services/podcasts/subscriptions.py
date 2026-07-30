"""Podcast subscription and OPML import/export services."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import lxml.etree as etree
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.errors import TransactionRestart
from nexus.db.retries import retry_read_committed
from nexus.db.session import transaction
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    InvalidRequestError,
    NotFoundError,
)
from nexus.ids import new_uuid7
from nexus.jobs.queue import revoke_jobs_for_payload
from nexus.logging import get_logger
from nexus.schemas.contributors import ContributorCreditIn
from nexus.schemas.podcast import (
    PodcastAlreadyUnsubscribedOut,
    PodcastBackfillOut,
    PodcastBackfillRetryOut,
    PodcastCanonicalCommitTarget,
    PodcastDiscoveryCommitTarget,
    PodcastOpmlImportErrorOut,
    PodcastOpmlImportOut,
    PodcastSourceFacts,
    PodcastSubscribeDestinationOutcomeOut,
    PodcastSubscribeOut,
    PodcastSubscribeRequest,
    PodcastSubscriptionSettingsOut,
    PodcastSubscriptionSettingsPatchRequest,
    PodcastSubscriptionStatusOut,
    PodcastUnsubscribedOut,
    PodcastUnsubscribeOut,
)
from nexus.schemas.presence import Present
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
from nexus.services.library_governance import validate_writable_library_destinations
from nexus.services.resource_mutation_replay import (
    lookup_replay,
    record_replay,
)
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url

from .backfill import seed_subscription_backfill_in_current_transaction
from .control_replay import (
    PODCAST_CONTROL_REPLAY_SCOPE,
    podcast_control_request_bytes,
)
from .identity import (
    apply_podcast_contributor_credits_in_current_transaction,
    select_podcast_id_by_feed_url,
    select_podcast_id_by_provider_id,
    upsert_podcast,
    validate_and_normalize_feed_url,
)
from .poll import enqueue_podcast_subscription_sync
from .provider import get_podcast_index_client

logger = get_logger(__name__)

PODCAST_OPML_MAX_BYTES = 1_000_000
PODCAST_OPML_MAX_OUTLINES = 200
PODCAST_OPML_MAX_TITLE_LENGTH = 512
PODCAST_OPML_MAX_URL_LENGTH = 2048
PODCAST_OPML_MAX_ERROR_LENGTH = 300


def _lookup_replay_before_resolution(
    db: Session,
    *,
    viewer_id: UUID,
    scope: str,
    idempotency_key: str,
    request_bytes: bytes,
) -> dict[str, object] | None:
    """Read the frozen command result before any provider resolution or I/O."""
    try:
        return lookup_replay(
            db,
            viewer_id=viewer_id,
            scope=scope,
            client_mutation_id=idempotency_key,
            request_bytes=request_bytes,
        )
    finally:
        db.rollback()


def _subscription_command_identity(
    db: Session,
    *,
    podcast_id: UUID | None,
    source: PodcastSourceFacts | None,
) -> str:
    """Stable per-Podcast command identity shared by Subscribe and Unsubscribe."""
    if source is not None:
        return f"podcast_index:{source.provider_podcast_id}"
    assert podcast_id is not None
    row = db.execute(
        text(
            """
            SELECT provider, provider_podcast_id
            FROM podcasts
            WHERE id = :podcast_id
            """
        ),
        {"podcast_id": podcast_id},
    ).first()
    db.rollback()
    if row is None:
        return f"canonical:{podcast_id}"
    provider = str(row[0] or "").strip()
    provider_podcast_id = str(row[1] or "").strip()
    if not provider or not provider_podcast_id:
        return f"canonical:{podcast_id}"
    return f"{provider}:{provider_podcast_id}"


def _lock_subscription_command(
    db: Session,
    *,
    viewer_id: UUID,
    podcast_identity: str,
) -> None:
    """Serialize the same viewer/Podcast relationship before any row lock."""
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))"),
        {"lock_key": f"podcast-subscription:{viewer_id}:{podcast_identity}"},
    )


def _apply_resolved_subscription_relationship_in_current_transaction(
    db: Session,
    *,
    viewer_id: UUID,
    podcast_identity: str,
    source: PodcastSourceFacts | None,
    canonical_podcast_id: UUID | None,
    library_ids: list[UUID],
    confirmation_fingerprint: str | None,
    relationship_locked: bool = False,
) -> tuple[UUID, UUID, bool, tuple[UUID, ...], tuple[UUID, ...]]:
    """Apply one resolved Subscribe/OPML relationship under the total lock order."""
    if not relationship_locked:
        _lock_subscription_command(
            db,
            viewer_id=viewer_id,
            podcast_identity=podcast_identity,
        )
    preliminary_podcast_id = canonical_podcast_id
    if source is not None:
        preliminary_podcast_id = select_podcast_id_by_provider_id(
            db,
            source.provider_podcast_id,
        )
        if preliminary_podcast_id is None:
            preliminary_podcast_id = select_podcast_id_by_feed_url(db, source.feed_url)

    subscription = None
    if preliminary_podcast_id is not None:
        subscription = (
            db.execute(
                text(
                    """
                    SELECT id, created_at
                    FROM podcast_subscriptions
                    WHERE user_id = :viewer_id
                      AND podcast_id = :podcast_id
                    FOR UPDATE
                    """
                ),
                {
                    "viewer_id": viewer_id,
                    "podcast_id": preliminary_podcast_id,
                },
            )
            .mappings()
            .first()
        )

    now = datetime.now(UTC)
    podcast_id = upsert_podcast(db, source, now=now) if source is not None else canonical_podcast_id
    assert podcast_id is not None
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
            db,
            podcast_id=podcast_id,
            contributors=source.contributors,
        )

    created = subscription is None
    if subscription is None:
        subscription_id, created_at = _insert_subscription_in_current_transaction(
            db,
            user_id=viewer_id,
            podcast_id=podcast_id,
        )
        subscription = {"id": subscription_id, "created_at": created_at}
        seed_subscription_backfill_in_current_transaction(
            db,
            subscription_id=subscription_id,
            cutoff_at=created_at,
        )
        enqueue_podcast_subscription_sync(
            db,
            user_id=viewer_id,
            podcast_id=podcast_id,
        )

    placement = place_podcast_in_named_libraries_in_current_transaction(
        db,
        viewer_id=viewer_id,
        podcast_id=podcast_id,
        library_ids=library_ids,
        confirmation_fingerprint=confirmation_fingerprint,
    )
    _bump_subscription_collections(db, viewer_id=viewer_id)
    return (
        podcast_id,
        UUID(str(subscription["id"])),
        created,
        placement.added_library_ids,
        placement.already_present_library_ids,
    )


def _bump_subscription_collections(
    db: Session,
    *,
    viewer_id: UUID,
    episodes: bool = False,
) -> None:
    families = [
        CollectionFamily.LibraryEntries,
        CollectionFamily.PodcastSubscriptions,
    ]
    if episodes:
        families.append(CollectionFamily.PodcastEpisodes)
    bump_collection_families(
        db,
        viewer_ids=(viewer_id,),
        families=families,
    )


def import_subscriptions_from_opml(
    db: Session,
    viewer_id: UUID,
    *,
    opml_xml: str,
    default_library_ids: list[UUID],
    per_feed_library_ids: dict[str, list[UUID]],
) -> PodcastOpmlImportOut:
    if not isinstance(opml_xml, str):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "OPML import requires the OPML payload as a string.",
        )
    validate_writable_library_destinations(db, viewer_id, default_library_ids)
    for feed_library_ids in per_feed_library_ids.values():
        validate_writable_library_destinations(db, viewer_id, feed_library_ids)
    payload_bytes = opml_xml.encode("utf-8")
    if not payload_bytes:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "OPML file is empty.")
    if len(payload_bytes) > PODCAST_OPML_MAX_BYTES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "OPML file exceeds the 1MB size limit.",
        )
    outline_rows = _parse_opml_rss_outlines(payload_bytes)
    if len(outline_rows) > PODCAST_OPML_MAX_OUTLINES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"OPML import supports at most {PODCAST_OPML_MAX_OUTLINES} RSS outlines per file.",
        )

    summary = PodcastOpmlImportOut(
        total=len(outline_rows),
        imported=0,
        skipped_already_subscribed=0,
        skipped_invalid=0,
        errors=[],
    )
    client = get_podcast_index_client()

    for outline in outline_rows:
        raw_feed_url = _sanitize_opml_string(
            outline.get("xmlUrl") or outline.get("xmlurl"),
            max_length=PODCAST_OPML_MAX_URL_LENGTH,
        )
        if not raw_feed_url:
            summary.skipped_invalid += 1
            continue

        try:
            normalized_feed_url = validate_and_normalize_feed_url(raw_feed_url)
        except InvalidRequestError as exc:
            summary.skipped_invalid += 1
            summary.errors.append(
                PodcastOpmlImportErrorOut(
                    feed_url=raw_feed_url,
                    error=_truncate_opml_error(exc.message),
                )
            )
            continue

        opml_title = _sanitize_opml_string(
            outline.get("text") or outline.get("title"),
            max_length=PODCAST_OPML_MAX_TITLE_LENGTH,
        )
        opml_website_url = _normalize_optional_opml_url(
            _sanitize_opml_string(
                outline.get("htmlUrl") or outline.get("htmlurl"),
                max_length=PODCAST_OPML_MAX_URL_LENGTH,
            )
        )

        library_ids = per_feed_library_ids.get(normalized_feed_url, default_library_ids)

        subscribe_body: PodcastSourceFacts | None = None
        podcast_id: UUID | None = None
        try:
            # Read the local feed owner in its own committed transaction so the
            # provider HTTP below runs with NO open DB transaction (spec 2.7/3;
            # OPML previously performed the provider lookup mid-transaction, D-3).
            with transaction(db):
                podcast_id = select_podcast_id_by_feed_url(db, normalized_feed_url)

            if podcast_id is None:
                provider_row: dict[str, Any] | None = None
                try:
                    provider_row = client.lookup_podcast_by_feed_url(normalized_feed_url)
                except ApiError as provider_exc:
                    logger.warning(
                        "podcast_opml_provider_lookup_failed",
                        feed_url=normalized_feed_url,
                        error=provider_exc.message,
                    )
                subscribe_body = _build_opml_subscribe_request(
                    normalized_feed_url=normalized_feed_url,
                    opml_title=opml_title,
                    opml_website_url=opml_website_url,
                    provider_row=provider_row,
                )

            command_identity = _subscription_command_identity(
                db,
                podcast_id=podcast_id,
                source=subscribe_body,
            )

            def apply_opml_relationship(
                *,
                command_identity: str = command_identity,
                subscribe_body: PodcastSourceFacts | None = subscribe_body,
                podcast_id: UUID | None = podcast_id,
                library_ids: list[UUID] = library_ids,
            ) -> tuple[
                UUID,
                UUID,
                bool,
                tuple[UUID, ...],
                tuple[UUID, ...],
            ]:
                with transaction(db):
                    return _apply_resolved_subscription_relationship_in_current_transaction(
                        db,
                        viewer_id=viewer_id,
                        podcast_identity=command_identity,
                        source=subscribe_body,
                        canonical_podcast_id=podcast_id,
                        library_ids=library_ids,
                        confirmation_fingerprint=None,
                    )

            (
                podcast_id,
                _subscription_id,
                created,
                _added_library_ids,
                _already_present_library_ids,
            ) = retry_read_committed(
                db,
                "apply_opml_subscription_relationship",
                apply_opml_relationship,
            )
            if created:
                summary.imported += 1
            else:
                summary.skipped_already_subscribed += 1
        except ApiError as exc:
            summary.errors.append(
                PodcastOpmlImportErrorOut(
                    feed_url=normalized_feed_url,
                    error=_truncate_opml_error(exc.message),
                )
            )
            continue
        except Exception as exc:  # justify-ignore-error: per-row OPML import boundary; one bad row must not fail the whole import
            logger.exception(
                "podcast_opml_import_unexpected_error",
                feed_url=normalized_feed_url,
                error=str(exc),
            )
            summary.errors.append(
                PodcastOpmlImportErrorOut(
                    feed_url=normalized_feed_url,
                    error=_truncate_opml_error("Unexpected OPML import error"),
                )
            )
            continue

    return summary


def export_subscriptions_as_opml(db: Session, viewer_id: UUID) -> bytes:
    rows = db.execute(
        text(
            """
            SELECT p.title, p.feed_url, p.website_url
            FROM podcast_subscriptions ps
            JOIN podcasts p ON p.id = ps.podcast_id
            WHERE ps.user_id = :user_id
            ORDER BY LOWER(p.title) ASC, p.id ASC
            """
        ),
        {"user_id": viewer_id},
    ).fetchall()

    root = etree.Element("opml", version="2.0")
    head = etree.SubElement(root, "head")
    etree.SubElement(head, "title").text = "Nexus Podcasts"
    etree.SubElement(head, "dateCreated").text = datetime.now(UTC).strftime(
        "%a, %d %b %Y %H:%M:%S GMT"
    )
    body = etree.SubElement(root, "body")
    group = etree.SubElement(body, "outline", text="Podcasts")

    for row in rows:
        title = _sanitize_opml_string(str(row[0] or ""), max_length=PODCAST_OPML_MAX_TITLE_LENGTH)
        feed_url = str(row[1] or "").strip()
        website_url = _normalize_optional_opml_url(str(row[2] or "").strip())
        if not feed_url:
            continue
        outline_attrs = {
            "type": "rss",
            "text": title or feed_url,
            "xmlUrl": feed_url,
        }
        if website_url:
            outline_attrs["htmlUrl"] = website_url
        etree.SubElement(group, "outline", **outline_attrs)

    return etree.tostring(
        root,
        encoding="UTF-8",
        xml_declaration=True,
        pretty_print=True,
    )


def subscribe_to_podcast(
    db: Session,
    viewer_id: UUID,
    body: PodcastSubscribeRequest,
    *,
    idempotency_key: str,
) -> PodcastSubscribeOut:
    if not idempotency_key.strip():
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Idempotency-Key must be nonblank",
        )
    request_bytes = podcast_control_request_bytes(
        method="POST",
        path="/podcasts/subscriptions",
        body=body.model_dump(mode="json", by_alias=True),
    )
    replay = _lookup_replay_before_resolution(
        db,
        viewer_id=viewer_id,
        scope=PODCAST_CONTROL_REPLAY_SCOPE,
        idempotency_key=idempotency_key,
        request_bytes=request_bytes,
    )
    if replay is not None:
        return PodcastSubscribeOut.model_validate(replay)

    source, canonical_podcast_id = _resolve_subscribe_target(db, viewer_id, body)
    confirmation = (
        body.replacement_confirmation.value.conflict_fingerprint
        if isinstance(body.replacement_confirmation, Present)
        else None
    )
    command_identity = _subscription_command_identity(
        db,
        podcast_id=canonical_podcast_id,
        source=source,
    )

    def attempt() -> PodcastSubscribeOut:
        with transaction(db):
            _lock_subscription_command(
                db,
                viewer_id=viewer_id,
                podcast_identity=command_identity,
            )
            replay = lookup_replay(
                db,
                viewer_id=viewer_id,
                scope=PODCAST_CONTROL_REPLAY_SCOPE,
                client_mutation_id=idempotency_key,
                request_bytes=request_bytes,
            )
            if replay is not None:
                return PodcastSubscribeOut.model_validate(replay)

            (
                podcast_id,
                subscription_id,
                created,
                added_library_ids,
                _already_present_library_ids,
            ) = _apply_resolved_subscription_relationship_in_current_transaction(
                db,
                viewer_id=viewer_id,
                podcast_identity=command_identity,
                source=source,
                canonical_podcast_id=canonical_podcast_id,
                library_ids=body.named_library_ids,
                confirmation_fingerprint=confirmation,
                relationship_locked=True,
            )
            backfill = _load_backfill_out(
                db,
                subscription_id=subscription_id,
            )
            destinations = [
                PodcastSubscribeDestinationOutcomeOut(
                    library_id=library_id,
                    outcome=("Added" if library_id in added_library_ids else "AlreadyPresent"),
                )
                for library_id in dict.fromkeys(body.named_library_ids)
            ]
            outcome = (
                "Subscribed"
                if created
                else ("DestinationsAdded" if added_library_ids else "AlreadySubscribed")
            )
            response = PodcastSubscribeOut(
                href=f"/podcasts/{podcast_id}",
                podcast_id=podcast_id,
                outcome=outcome,
                destinations=destinations,
                backfill=backfill,
                collection_revision=read_collection_revision(
                    db,
                    viewer_id=viewer_id,
                    family=CollectionFamily.PodcastSubscriptions,
                ),
                library_entries_collection_revision=read_collection_revision(
                    db,
                    viewer_id=viewer_id,
                    family=CollectionFamily.LibraryEntries,
                ),
            )
            record_replay(
                db,
                viewer_id=viewer_id,
                scope=PODCAST_CONTROL_REPLAY_SCOPE,
                client_mutation_id=idempotency_key,
                request_bytes=request_bytes,
                response_json=response.model_dump(mode="json", by_alias=True),
                changed_lanes={},
            )
            return response

    return retry_read_committed(db, "subscribe_to_podcast", attempt)


def _resolve_subscribe_target(
    db: Session,
    viewer_id: UUID,
    body: PodcastSubscribeRequest,
) -> tuple[PodcastSourceFacts | None, UUID | None]:
    if isinstance(body.target, PodcastDiscoveryCommitTarget):
        from nexus.services.browse.service import resolve_podcast_discovery_target

        resolved = resolve_podcast_discovery_target(body.target.target)
        if not isinstance(resolved, ResolvedPodcast):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_DISCOVERY_TARGET,
                "Discovery target is not a Podcast",
            )
        contributors = (
            [ContributorCreditIn(credited_name=resolved.author, role="author")]
            if resolved.author
            else []
        )
        return (
            PodcastSourceFacts(
                provider_podcast_id=resolved.podcast_ref,
                title=resolved.title,
                contributors=contributors,
                feed_url=validate_and_normalize_feed_url(resolved.feed_url),
                website_url=resolved.website_url,
                image_url=resolved.image_url,
                description=resolved.description,
            ),
            None,
        )
    if isinstance(body.target, PodcastCanonicalCommitTarget):
        row = db.execute(
            text(
                """
                SELECT 1
                FROM podcasts podcast
                WHERE podcast.id = :podcast_id
                  AND (
                    EXISTS (
                        SELECT 1
                        FROM podcast_subscriptions subscription
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
            {
                "viewer_id": viewer_id,
                "podcast_id": body.target.podcast_id,
            },
        ).fetchone()
        db.rollback()
        if row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
        return None, body.target.podcast_id
    raise InvalidRequestError(
        ApiErrorCode.E_INVALID_REQUEST,
        "Unsupported Podcast subscribe target",
    )


def _load_backfill_out(db: Session, *, subscription_id: UUID) -> PodcastBackfillOut:
    row = (
        db.execute(
            text(
                """
            SELECT
                id,
                started_at,
                completed_at,
                source_limited_at,
                failed_at,
                processed_count,
                added_count
            FROM podcast_subscription_backfills
            WHERE subscription_id = :subscription_id
            """
            ),
            {"subscription_id": subscription_id},
        )
        .mappings()
        .one()
    )
    state = (
        "Failed"
        if row["failed_at"] is not None
        else (
            "SourceLimited"
            if row["source_limited_at"] is not None
            else (
                "Complete"
                if row["completed_at"] is not None
                else ("Running" if row["started_at"] is not None else "Pending")
            )
        )
    )
    return PodcastBackfillOut(
        id=row["id"],
        state=state,
        processed_count=int(row["processed_count"]),
        added_count=int(row["added_count"]),
    )


def get_subscription_status(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
) -> PodcastSubscriptionStatusOut:
    row = db.execute(
        text(
            """
            SELECT
                ps.user_id,
                ps.id,
                ps.podcast_id,
                ps.default_playback_speed,
                ps.auto_queue,
                ps.sync_status,
                ps.sync_error_code,
                ps.sync_error_message,
                ps.sync_attempts,
                ps.sync_started_at,
                ps.sync_completed_at,
                ps.last_synced_at,
                ps.updated_at
            FROM podcast_subscriptions ps
            WHERE ps.user_id = :user_id AND ps.podcast_id = :podcast_id
            """
        ),
        {"user_id": viewer_id, "podcast_id": podcast_id},
    ).fetchone()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast subscription not found")

    return PodcastSubscriptionStatusOut(
        user_id=row[0],
        podcast_id=row[2],
        default_playback_speed=float(row[3]) if row[3] is not None else None,
        auto_queue=bool(row[4]),
        sync_status=row[5],
        sync_error_code=row[6],
        sync_error_message=row[7],
        sync_attempts=row[8],
        sync_started_at=row[9],
        sync_completed_at=row[10],
        last_synced_at=row[11],
        updated_at=row[12],
        backfill=_load_backfill_out(db, subscription_id=UUID(str(row[1]))),
    )


def retry_subscription_backfill(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
    *,
    idempotency_key: str,
) -> PodcastBackfillRetryOut:
    """Replace only a persistently failed current backfill, once per mutation key."""
    if not idempotency_key.strip():
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Idempotency-Key must be nonblank",
        )
    path = f"/podcasts/subscriptions/{podcast_id}/backfill/retry"
    request_bytes = podcast_control_request_bytes(
        method="POST",
        path=path,
    )
    replay = _lookup_replay_before_resolution(
        db,
        viewer_id=viewer_id,
        scope=PODCAST_CONTROL_REPLAY_SCOPE,
        idempotency_key=idempotency_key,
        request_bytes=request_bytes,
    )
    if replay is not None:
        return PodcastBackfillRetryOut.model_validate(replay)
    command_identity = _subscription_command_identity(
        db,
        podcast_id=podcast_id,
        source=None,
    )

    def attempt() -> PodcastBackfillRetryOut:
        with transaction(db):
            _lock_subscription_command(
                db,
                viewer_id=viewer_id,
                podcast_identity=command_identity,
            )
            replay = lookup_replay(
                db,
                viewer_id=viewer_id,
                scope=PODCAST_CONTROL_REPLAY_SCOPE,
                client_mutation_id=idempotency_key,
                request_bytes=request_bytes,
            )
            if replay is not None:
                return PodcastBackfillRetryOut.model_validate(replay)

            current = db.execute(
                text(
                    """
                    SELECT subscription.id, backfill.id
                    FROM podcast_subscriptions subscription
                    JOIN podcast_subscription_backfills backfill
                      ON backfill.subscription_id = subscription.id
                    WHERE subscription.user_id = :viewer_id
                      AND subscription.podcast_id = :podcast_id
                    """
                ),
                {"viewer_id": viewer_id, "podcast_id": podcast_id},
            ).first()
            if current is None:
                raise NotFoundError(
                    ApiErrorCode.E_NOT_FOUND,
                    "Podcast subscription not found",
                )
            subscription_id = UUID(str(current[0]))
            current_backfill_id = UUID(str(current[1]))

            backfill = db.execute(
                text(
                    """
                    SELECT cutoff_at, failed_at
                    FROM podcast_subscription_backfills
                    WHERE id = :backfill_id
                    FOR UPDATE
                    """
                ),
                {"backfill_id": current_backfill_id},
            ).first()
            if backfill is None:
                raise RuntimeError("Podcast subscription lost its current backfill")
            if (
                db.execute(
                    text(
                        """
                        SELECT 1
                        FROM podcast_subscriptions
                        WHERE id = :subscription_id
                          AND user_id = :viewer_id
                          AND podcast_id = :podcast_id
                        FOR UPDATE
                        """
                    ),
                    {
                        "subscription_id": subscription_id,
                        "viewer_id": viewer_id,
                        "podcast_id": podcast_id,
                    },
                ).first()
                is None
            ):
                raise RuntimeError("Podcast subscription disappeared while retrying backfill")
            if (
                db.execute(
                    text("SELECT 1 FROM podcasts WHERE id = :podcast_id FOR UPDATE"),
                    {"podcast_id": podcast_id},
                ).first()
                is None
            ):
                raise RuntimeError("Podcast disappeared under subscription")

            outcome = "NotEligible"
            if backfill[1] is not None:
                cutoff_at = backfill[0]
                db.execute(
                    text(
                        """
                        DELETE FROM podcast_subscription_backfills
                        WHERE id = :backfill_id
                          AND subscription_id = :subscription_id
                          AND failed_at IS NOT NULL
                        """
                    ),
                    {
                        "backfill_id": current_backfill_id,
                        "subscription_id": subscription_id,
                    },
                )
                seed_subscription_backfill_in_current_transaction(
                    db,
                    subscription_id=subscription_id,
                    cutoff_at=cutoff_at,
                )
                outcome = "Retried"

            response = PodcastBackfillRetryOut(
                podcast_id=podcast_id,
                outcome=outcome,
                backfill=_load_backfill_out(db, subscription_id=subscription_id),
            )
            record_replay(
                db,
                viewer_id=viewer_id,
                scope=PODCAST_CONTROL_REPLAY_SCOPE,
                client_mutation_id=idempotency_key,
                request_bytes=request_bytes,
                response_json=response.model_dump(mode="json", by_alias=True),
                changed_lanes={},
            )
            return response

    return retry_read_committed(db, "retry_subscription_backfill", attempt)


def update_subscription_settings_for_viewer(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
    body: PodcastSubscriptionSettingsPatchRequest,
) -> PodcastSubscriptionSettingsOut:
    assignments: list[str] = []
    params: dict[str, Any] = {
        "user_id": viewer_id,
        "podcast_id": podcast_id,
        "updated_at": datetime.now(UTC),
    }
    if "default_playback_speed" in body.model_fields_set:
        assignments.append("default_playback_speed = :default_playback_speed")
        params["default_playback_speed"] = body.default_playback_speed
    if "auto_queue" in body.model_fields_set:
        assignments.append("auto_queue = :auto_queue")
        params["auto_queue"] = bool(body.auto_queue)
    if not assignments:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "At least one subscription settings field must be provided",
        )

    assignment_sql = ", ".join([*assignments, "updated_at = :updated_at"])
    with transaction(db):
        updated = db.execute(
            text(
                f"""
                UPDATE podcast_subscriptions
                SET {assignment_sql}
                WHERE user_id = :user_id
                  AND podcast_id = :podcast_id
                RETURNING 1
                """
            ),
            params,
        ).fetchone()
        if updated is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast subscription not found")
        _bump_subscription_collections(db, viewer_id=viewer_id)
        collection_revision = read_collection_revision(
            db,
            viewer_id=viewer_id,
            family=CollectionFamily.PodcastSubscriptions,
        )
        library_entries_collection_revision = read_collection_revision(
            db,
            viewer_id=viewer_id,
            family=CollectionFamily.LibraryEntries,
        )

    status = get_subscription_status(db, viewer_id, podcast_id)
    return PodcastSubscriptionSettingsOut(
        **status.model_dump(),
        collectionRevision=collection_revision,
        libraryEntriesCollectionRevision=library_entries_collection_revision,
    )


def unsubscribe_from_podcast(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
    *,
    idempotency_key: str,
) -> PodcastUnsubscribeOut:
    if not idempotency_key.strip():
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Idempotency-Key must be nonblank",
        )
    path = f"/podcasts/subscriptions/{podcast_id}"
    request_bytes = podcast_control_request_bytes(
        method="DELETE",
        path=path,
    )
    replay = _lookup_replay_before_resolution(
        db,
        viewer_id=viewer_id,
        scope=PODCAST_CONTROL_REPLAY_SCOPE,
        idempotency_key=idempotency_key,
        request_bytes=request_bytes,
    )
    if replay is not None:
        replay_payload = dict(replay)
        revocation = replay_payload.pop("_queueRevocation", None)
        replay_backfill_id: UUID | None = None
        replay_sync = False
        if isinstance(revocation, dict):
            raw_backfill_id = revocation.get("backfillId")
            if raw_backfill_id is not None:
                replay_backfill_id = UUID(str(raw_backfill_id))
            replay_sync = bool(revocation.get("sync"))
        if replay_backfill_id is not None or replay_sync:
            with transaction(db):
                if replay_backfill_id is not None:
                    revoke_jobs_for_payload(
                        db,
                        kind="podcast_backfill_subscription",
                        expected_payload_match={"backfillId": str(replay_backfill_id)},
                    )
                if replay_sync:
                    revoke_jobs_for_payload(
                        db,
                        kind="podcast_sync_subscription_job",
                        expected_payload_match={
                            "user_id": str(viewer_id),
                            "podcast_id": str(podcast_id),
                        },
                    )
        if replay_payload.get("outcome") == "Unsubscribed":
            return PodcastUnsubscribedOut.model_validate(replay_payload)
        return PodcastAlreadyUnsubscribedOut.model_validate(replay_payload)
    removed_backfill_id: UUID | None = None
    should_revoke_sync = False
    command_identity = _subscription_command_identity(
        db,
        podcast_id=podcast_id,
        source=None,
    )

    def attempt() -> PodcastUnsubscribeOut:
        nonlocal removed_backfill_id, should_revoke_sync
        with transaction(db):
            _lock_subscription_command(
                db,
                viewer_id=viewer_id,
                podcast_identity=command_identity,
            )
            replay = lookup_replay(
                db,
                viewer_id=viewer_id,
                scope=PODCAST_CONTROL_REPLAY_SCOPE,
                client_mutation_id=idempotency_key,
                request_bytes=request_bytes,
            )
            if replay is not None:
                replay_payload = dict(replay)
                revocation = replay_payload.pop("_queueRevocation", None)
                if isinstance(revocation, dict):
                    raw_backfill_id = revocation.get("backfillId")
                    if raw_backfill_id is not None:
                        removed_backfill_id = UUID(str(raw_backfill_id))
                    should_revoke_sync = bool(revocation.get("sync"))
                if replay_payload.get("outcome") == "Unsubscribed":
                    should_revoke_sync = True
                    return PodcastUnsubscribedOut.model_validate(replay_payload)
                return PodcastAlreadyUnsubscribedOut.model_validate(replay_payload)

            subscription_id = db.scalar(
                text(
                    """
                    SELECT id
                    FROM podcast_subscriptions
                    WHERE user_id = :viewer_id
                      AND podcast_id = :podcast_id
                    """
                ),
                {"viewer_id": viewer_id, "podcast_id": podcast_id},
            )
            response: PodcastUnsubscribeOut = PodcastAlreadyUnsubscribedOut(
                podcast_id=podcast_id,
                collectionRevision=read_collection_revision(
                    db,
                    viewer_id=viewer_id,
                    family=CollectionFamily.PodcastSubscriptions,
                ),
                libraryEntriesCollectionRevision=read_collection_revision(
                    db,
                    viewer_id=viewer_id,
                    family=CollectionFamily.LibraryEntries,
                ),
            )
            if subscription_id is not None:
                backfill = db.execute(
                    text(
                        """
                        SELECT id
                        FROM podcast_subscription_backfills
                        WHERE subscription_id = :subscription_id
                        FOR UPDATE
                        """
                    ),
                    {"subscription_id": subscription_id},
                ).fetchone()
                subscription = db.execute(
                    text(
                        """
                        SELECT id
                        FROM podcast_subscriptions
                        WHERE id = :subscription_id
                        FOR UPDATE
                        """
                    ),
                    {"subscription_id": subscription_id},
                ).fetchone()
                if subscription is not None:
                    if (
                        db.execute(
                            text("SELECT 1 FROM podcasts WHERE id = :podcast_id FOR UPDATE"),
                            {"podcast_id": podcast_id},
                        ).fetchone()
                        is None
                    ):
                        raise RuntimeError("Podcast disappeared under subscription")
                    removal = remove_unsubscribed_podcast_placements(
                        db,
                        viewer_id=viewer_id,
                        podcast_id=podcast_id,
                    )
                    if backfill is not None:
                        removed_backfill_id = UUID(str(backfill[0]))
                        db.execute(
                            text(
                                """
                                DELETE FROM podcast_subscription_backfills
                                WHERE subscription_id = :subscription_id
                                """
                            ),
                            {"subscription_id": subscription_id},
                        )
                    db.execute(
                        text("DELETE FROM podcast_subscriptions WHERE id = :subscription_id"),
                        {"subscription_id": subscription_id},
                    )
                    should_revoke_sync = True
                    from nexus.services.artifacts.dossier_types import AudienceUser
                    from nexus.services.artifacts.engine import on_audience_visibility_changed

                    on_audience_visibility_changed(
                        db,
                        audience=AudienceUser(user_id=viewer_id),
                    )
                    _bump_subscription_collections(db, viewer_id=viewer_id, episodes=True)
                    response = PodcastUnsubscribedOut(
                        podcast_id=podcast_id,
                        removed_placement_count=removal.removed_from_library_count,
                        retained_shared_count=removal.retained_shared_library_count,
                        collectionRevision=read_collection_revision(
                            db,
                            viewer_id=viewer_id,
                            family=CollectionFamily.PodcastSubscriptions,
                        ),
                        libraryEntriesCollectionRevision=read_collection_revision(
                            db,
                            viewer_id=viewer_id,
                            family=CollectionFamily.LibraryEntries,
                        ),
                    )
            record_replay(
                db,
                viewer_id=viewer_id,
                scope=PODCAST_CONTROL_REPLAY_SCOPE,
                client_mutation_id=idempotency_key,
                request_bytes=request_bytes,
                response_json={
                    **response.model_dump(mode="json", by_alias=True),
                    **(
                        {
                            "_queueRevocation": {
                                "backfillId": (
                                    str(removed_backfill_id)
                                    if removed_backfill_id is not None
                                    else None
                                ),
                                "sync": True,
                            }
                        }
                        if response.outcome == "Unsubscribed"
                        else {}
                    ),
                },
                changed_lanes={},
            )
            return response

    response = retry_read_committed(db, "unsubscribe_from_podcast", attempt)
    if removed_backfill_id is not None or should_revoke_sync:
        with transaction(db):
            if removed_backfill_id is not None:
                revoke_jobs_for_payload(
                    db,
                    kind="podcast_backfill_subscription",
                    expected_payload_match={"backfillId": str(removed_backfill_id)},
                )
            if should_revoke_sync:
                revoke_jobs_for_payload(
                    db,
                    kind="podcast_sync_subscription_job",
                    expected_payload_match={
                        "user_id": str(viewer_id),
                        "podcast_id": str(podcast_id),
                    },
                )
    return response


def _parse_opml_rss_outlines(payload: bytes) -> list[dict[str, str]]:
    try:
        parser = etree.XMLParser(resolve_entities=False, no_network=True, recover=False)
        root = etree.fromstring(payload, parser=parser)
    except etree.XMLSyntaxError as exc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Invalid XML file. Please upload a valid OPML document.",
        ) from exc

    root_tag = str(root.tag or "")
    if "}" in root_tag:
        root_tag = root_tag.split("}", 1)[1]
    if root_tag.lower() != "opml":
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Invalid OPML document. Root element must be <opml>.",
        )

    outline_nodes = root.xpath(
        ".//*[local-name()='outline' and "
        "translate(@type, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')='rss']"
    )
    rows: list[dict[str, str]] = []
    for node in outline_nodes:
        attrib_items = getattr(node, "attrib", {})
        rows.append({str(key): str(value) for key, value in attrib_items.items()})
    return rows


def _sanitize_opml_string(value: Any, *, max_length: int) -> str | None:
    if value is None:
        return None
    cleaned = "".join(ch for ch in str(value) if ch in {"\n", "\r", "\t"} or ord(ch) >= 32).strip()
    if not cleaned:
        return None
    return cleaned[:max_length]


def _truncate_opml_error(message: str) -> str:
    return str(message or "Unknown error")[:PODCAST_OPML_MAX_ERROR_LENGTH]


def _normalize_optional_opml_url(url: str | None) -> str | None:
    if not url:
        return None
    try:
        validate_requested_url(url)
    except InvalidRequestError:
        return None
    return normalize_url_for_display(url)


def _opml_provider_podcast_id(normalized_feed_url: str) -> str:
    return f"opml-feed-url={normalized_feed_url}"


def _build_opml_subscribe_request(
    *,
    normalized_feed_url: str,
    opml_title: str | None,
    opml_website_url: str | None,
    provider_row: dict[str, Any] | None,
) -> PodcastSourceFacts:
    provider_podcast_id = _sanitize_opml_string(
        provider_row.get("provider_podcast_id") if provider_row else None,
        max_length=PODCAST_OPML_MAX_TITLE_LENGTH,
    )
    provider_title = _sanitize_opml_string(
        provider_row.get("title") if provider_row else None,
        max_length=PODCAST_OPML_MAX_TITLE_LENGTH,
    )
    provider_author = _sanitize_opml_string(
        provider_row.get("author") if provider_row else None,
        max_length=PODCAST_OPML_MAX_TITLE_LENGTH,
    )
    provider_website = _normalize_optional_opml_url(
        _sanitize_opml_string(
            provider_row.get("website_url") if provider_row else None,
            max_length=PODCAST_OPML_MAX_URL_LENGTH,
        )
    )
    provider_image = _normalize_optional_opml_url(
        _sanitize_opml_string(
            provider_row.get("image_url") if provider_row else None,
            max_length=PODCAST_OPML_MAX_URL_LENGTH,
        )
    )
    provider_description = _sanitize_opml_string(
        provider_row.get("description") if provider_row else None,
        max_length=4000,
    )

    return PodcastSourceFacts(
        provider_podcast_id=provider_podcast_id or _opml_provider_podcast_id(normalized_feed_url),
        title=provider_title or opml_title or normalized_feed_url,
        contributors=[ContributorCreditIn(credited_name=provider_author, role="author")]
        if provider_author
        else [],
        feed_url=normalized_feed_url,
        website_url=provider_website or opml_website_url,
        image_url=provider_image,
        description=provider_description,
    )


def _insert_subscription_in_current_transaction(
    db: Session,
    *,
    user_id: UUID,
    podcast_id: UUID,
) -> tuple[UUID, datetime]:
    subscription_id = new_uuid7()
    row = db.execute(
        text(
            """
            INSERT INTO podcast_subscriptions (
                id,
                user_id,
                podcast_id,
                auto_queue,
                sync_status,
                created_at,
                updated_at
            )
            VALUES (
                :id,
                :user_id,
                :podcast_id,
                false,
                'pending',
                now(),
                now()
            )
            RETURNING created_at
            """
        ),
        {
            "id": subscription_id,
            "user_id": user_id,
            "podcast_id": podcast_id,
        },
    ).one()
    return subscription_id, row[0]
