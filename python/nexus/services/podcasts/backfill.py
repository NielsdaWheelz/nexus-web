"""Durable, lease-fenced Podcast subscription history traversal."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import CursorResult
from sqlalchemy.orm import Session

from nexus.db.retries import retry_read_committed
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode
from nexus.ids import new_uuid7
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    enqueue_unique_job,
    lock_and_renew_running_job_claim,
)

from ._normalize import parse_iso_datetime
from .episode_identity import aliases_from_episode
from .feed import fetch_feed_backfill_page
from .ingest import (
    lock_subscription_ingest_parent_in_current_transaction,
    sync_subscription_ingest,
)

BACKFILL_JOB_KIND = "podcast_backfill_subscription"
BACKFILL_JOB_LEASE_SECONDS = 900
_ERROR_DETAIL_MAX_LENGTH = 500


def cursor_digest(cursor: Mapping[str, object] | None) -> str:
    """Canonical replay-fence digest for a provider continuation."""
    payload = json.dumps(
        dict(cursor) if cursor is not None else None,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def seed_subscription_backfill_in_current_transaction(
    db: Session,
    *,
    subscription_id: UUID,
    cutoff_at: datetime,
) -> UUID:
    """Create the one current backfill and its first durable job."""
    backfill_id = new_uuid7()
    db.execute(
        text(
            """
            INSERT INTO podcast_subscription_backfills (
                id,
                subscription_id,
                cutoff_at,
                step_no,
                cursor,
                processed_count,
                added_count,
                created_at,
                updated_at
            )
            VALUES (
                :id,
                :subscription_id,
                :cutoff_at,
                0,
                NULL,
                0,
                0,
                now(),
                now()
            )
            """
        ),
        {
            "id": backfill_id,
            "subscription_id": subscription_id,
            "cutoff_at": cutoff_at,
        },
    )
    enqueue_backfill_step_in_current_transaction(
        db,
        backfill_id=backfill_id,
        step_no=0,
        cursor=None,
    )
    return backfill_id


def enqueue_backfill_step_in_current_transaction(
    db: Session,
    *,
    backfill_id: UUID,
    step_no: int,
    cursor: Mapping[str, object] | None,
) -> bool:
    _, inserted = enqueue_unique_job(
        db,
        kind=BACKFILL_JOB_KIND,
        payload={
            "backfillId": str(backfill_id),
            "expectedStepNo": int(step_no),
            "expectedCursorDigest": cursor_digest(cursor),
        },
        dedupe_key=f"podcast-backfill:{backfill_id}:{step_no}",
        max_attempts=3,
    )
    return inserted


def run_backfill_step(
    db: Session,
    *,
    payload: Mapping[str, Any],
    context: JobExecutionContext,
) -> dict[str, Any]:
    """Fetch outside a transaction, then apply one exactly-once fenced step."""
    backfill_id, expected_step_no, expected_digest = _decode_payload(payload)
    preflight = (
        db.execute(
            text(
                """
            SELECT
                backfill.step_no,
                backfill.cursor,
                backfill.cutoff_at,
                subscription.user_id,
                subscription.podcast_id,
                podcast.feed_url
            FROM podcast_subscription_backfills backfill
            JOIN podcast_subscriptions subscription
              ON subscription.id = backfill.subscription_id
            JOIN podcasts podcast
              ON podcast.id = subscription.podcast_id
            WHERE backfill.id = :backfill_id
            """
            ),
            {"backfill_id": backfill_id},
        )
        .mappings()
        .first()
    )
    db.rollback()
    if preflight is None:
        return {"status": "StaleOrUnsubscribed"}
    if int(preflight["step_no"]) > expected_step_no:
        return {"status": "AlreadyApplied"}
    if int(preflight["step_no"]) != expected_step_no:
        raise RuntimeError("Podcast backfill job names a future step")
    current_cursor = _coerce_cursor(preflight["cursor"])
    if cursor_digest(current_cursor) != expected_digest:
        raise RuntimeError("Podcast backfill cursor fence mismatch")

    fetched = fetch_feed_backfill_page(
        feed_url=str(preflight["feed_url"]),
        cursor=current_cursor,
    )

    def apply() -> dict[str, Any]:
        with transaction(db):
            if (
                lock_and_renew_running_job_claim(
                    db,
                    context=context,
                    lease_seconds=BACKFILL_JOB_LEASE_SECONDS,
                )
                is None
            ):
                return {"status": "StaleJobAttempt"}

            row = (
                db.execute(
                    text(
                        """
                    SELECT
                        backfill.subscription_id,
                        backfill.cutoff_at,
                        backfill.step_no,
                        backfill.cursor,
                        backfill.completed_at,
                        backfill.source_limited_at,
                        backfill.failed_at,
                        subscription.user_id,
                        subscription.podcast_id,
                        podcast.feed_url
                    FROM podcast_subscription_backfills backfill
                    JOIN podcast_subscriptions subscription
                      ON subscription.id = backfill.subscription_id
                    JOIN podcasts podcast
                      ON podcast.id = subscription.podcast_id
                    WHERE backfill.id = :backfill_id
                    FOR UPDATE OF backfill
                    """
                    ),
                    {"backfill_id": backfill_id},
                )
                .mappings()
                .first()
            )
            if row is None:
                return {"status": "StaleOrUnsubscribed"}

            actual_step_no = int(row["step_no"])
            actual_cursor = _coerce_cursor(row["cursor"])
            if actual_step_no > expected_step_no:
                return {"status": "AlreadyApplied"}
            if actual_step_no < expected_step_no:
                raise RuntimeError("Podcast backfill job names a future step")
            if cursor_digest(actual_cursor) != expected_digest:
                raise RuntimeError("Podcast backfill cursor fence mismatch")
            if any(
                row[field] is not None
                for field in ("completed_at", "source_limited_at", "failed_at")
            ):
                return {"status": "AlreadyApplied"}

            cutoff_at = row["cutoff_at"]
            selected: list[dict[str, Any]] = []
            source_limited = fetched.source_limited
            for episode in sorted(fetched.episodes, key=_newest_first_key):
                published_at = parse_iso_datetime(episode.get("published_at"))
                if published_at is not None and published_at > cutoff_at:
                    continue
                if not aliases_from_episode(episode):
                    source_limited = True
                    continue
                selected.append(episode)

            now = db.scalar(text("SELECT transaction_timestamp()"))
            if not isinstance(now, datetime):
                raise AssertionError("database transaction timestamp is unavailable")
            podcast_id = UUID(str(row["podcast_id"]))
            subscription_id = UUID(str(row["subscription_id"]))
            if (
                db.execute(
                    text(
                        """
                        SELECT 1
                        FROM podcast_subscriptions
                        WHERE id = :subscription_id
                          AND podcast_id = :podcast_id
                        FOR UPDATE
                        """
                    ),
                    {
                        "subscription_id": subscription_id,
                        "podcast_id": podcast_id,
                    },
                ).first()
                is None
            ):
                return {"status": "StaleOrUnsubscribed"}
            lock_subscription_ingest_parent_in_current_transaction(
                db,
                podcast_id=podcast_id,
                selected_episodes=selected,
            )
            result = sync_subscription_ingest(
                db=db,
                viewer_id=UUID(str(row["user_id"])),
                podcast_id=podcast_id,
                feed_url=str(row["feed_url"]),
                selected_episodes=selected,
                now=now,
            )
            next_step_no = actual_step_no + 1
            next_cursor = None if source_limited else fetched.next_cursor
            terminal_complete = next_cursor is None and not source_limited
            updated = db.execute(
                text(
                    """
                    UPDATE podcast_subscription_backfills
                    SET
                        step_no = :next_step_no,
                        cursor = CAST(:next_cursor AS jsonb),
                        processed_count = processed_count + :processed_count,
                        added_count = added_count + :added_count,
                        started_at = COALESCE(started_at, transaction_timestamp()),
                        completed_at =
                            CASE WHEN :complete THEN transaction_timestamp() ELSE NULL END,
                        source_limited_at =
                            CASE
                                WHEN :source_limited THEN transaction_timestamp()
                                ELSE NULL
                            END,
                        updated_at = transaction_timestamp()
                    WHERE id = :backfill_id
                      AND step_no = :expected_step_no
                    """
                ),
                {
                    "backfill_id": backfill_id,
                    "next_step_no": next_step_no,
                    "next_cursor": (
                        json.dumps(next_cursor, sort_keys=True) if next_cursor is not None else None
                    ),
                    "processed_count": len(fetched.episodes),
                    "added_count": result.added_to_subscriber_all_count,
                    "expected_step_no": expected_step_no,
                    "complete": terminal_complete,
                    "source_limited": source_limited,
                },
            )
            if not isinstance(updated, CursorResult) or updated.rowcount != 1:
                raise AssertionError("locked Podcast backfill fence update affected no row")
            if next_cursor is not None:
                enqueue_backfill_step_in_current_transaction(
                    db,
                    backfill_id=backfill_id,
                    step_no=next_step_no,
                    cursor=next_cursor,
                )
            return {
                "status": "Applied",
                "processedCount": len(fetched.episodes),
                "addedCount": result.added_to_subscriber_all_count,
                "terminal": terminal_complete or source_limited,
            }

    return retry_read_committed(db, "podcast_backfill_step", apply)


def dead_letter_backfill(db: Session, job: JobRow) -> None:
    """Stamp Failed only while a dead job still names the current live fence."""
    try:
        backfill_id, expected_step_no, expected_digest = _decode_payload(job.payload)
    except (KeyError, TypeError, ValueError):
        return
    row = (
        db.execute(
            text(
                """
            SELECT step_no, cursor, completed_at, source_limited_at, failed_at
            FROM podcast_subscription_backfills
            WHERE id = :backfill_id
            FOR UPDATE
            """
            ),
            {"backfill_id": backfill_id},
        )
        .mappings()
        .first()
    )
    if row is None or int(row["step_no"]) != expected_step_no:
        return
    if cursor_digest(_coerce_cursor(row["cursor"])) != expected_digest:
        return
    if any(row[field] is not None for field in ("completed_at", "source_limited_at", "failed_at")):
        return
    db.execute(
        text(
            """
            UPDATE podcast_subscription_backfills
            SET
                failed_at = now(),
                error_code = :error_code,
                error_detail = :error_detail,
                updated_at = now()
            WHERE id = :backfill_id
            """
        ),
        {
            "backfill_id": backfill_id,
            "error_code": str(job.error_code or ApiErrorCode.E_INTERNAL.value)[:100],
            "error_detail": (
                f"Podcast backfill exhausted retries; job={job.id}; "
                f"classification={str(job.error_code or ApiErrorCode.E_INTERNAL.value)[:100]}"
            )[:_ERROR_DETAIL_MAX_LENGTH],
        },
    )


def _decode_payload(payload: Mapping[str, Any]) -> tuple[UUID, int, str]:
    backfill_id = UUID(str(payload["backfillId"]))
    expected_step_no = int(payload["expectedStepNo"])
    expected_digest = str(payload["expectedCursorDigest"])
    if expected_step_no < 0 or len(expected_digest) != 64:
        raise ValueError("Invalid Podcast backfill fence")
    return backfill_id, expected_step_no, expected_digest


def _coerce_cursor(value: object) -> dict[str, object] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise RuntimeError("Podcast backfill cursor is not an object")
    return {str(key): item for key, item in value.items()}


def _newest_first_key(episode: Mapping[str, Any]) -> tuple[int, float]:
    published_at = parse_iso_datetime(episode.get("published_at"))
    if published_at is None:
        return (1, 0.0)
    return (0, -published_at.timestamp())
