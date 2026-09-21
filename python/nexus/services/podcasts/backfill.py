"""Durable, step-fenced Podcast subscription history traversal."""

from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.retries import retry_read_committed
from nexus.db.session import transaction
from nexus.ids import new_uuid7
from nexus.jobs.queue import (
    JobExecutionContext,
    enqueue_unique_job,
    lock_and_renew_running_job_claim,
)

from ._normalize import parse_iso_datetime
from .episode_identity import aliases_from_episode
from .feed import fetch_feed_backfill_page
from .ingest import sync_subscription_ingest

BACKFILL_JOB_KIND = "podcast_backfill_subscription"
BACKFILL_JOB_LEASE_SECONDS = 900


def seed_subscription_backfill_in_current_transaction(
    db: Session,
    *,
    subscription_id: UUID,
    cutoff_at: datetime,
) -> UUID:
    """Create the one current backfill and its first durable step job."""
    backfill_id = new_uuid7()
    db.execute(
        text(
            """
            INSERT INTO podcast_subscription_backfills (
                id, subscription_id, cutoff_at, step_no, cursor,
                processed_count, added_count, created_at, updated_at
            )
            VALUES (:id, :subscription_id, :cutoff_at, 0, NULL, 0, 0, now(), now())
            """
        ),
        {"id": backfill_id, "subscription_id": subscription_id, "cutoff_at": cutoff_at},
    )
    enqueue_backfill_step_in_current_transaction(db, backfill_id=backfill_id, step_no=0)
    return backfill_id


def enqueue_backfill_step_in_current_transaction(
    db: Session,
    *,
    backfill_id: UUID,
    step_no: int,
) -> None:
    enqueue_unique_job(
        db,
        kind=BACKFILL_JOB_KIND,
        payload={"backfillId": str(backfill_id), "expectedStepNo": int(step_no)},
        dedupe_key=f"podcast-backfill:{backfill_id}:{step_no}",
        max_attempts=3,
    )


def run_backfill_step(
    db: Session,
    *,
    payload: Mapping[str, Any],
    context: JobExecutionContext,
) -> dict[str, Any]:
    """Fetch outside a transaction, then apply one exactly-once fenced step."""
    backfill_id = UUID(str(payload["backfillId"]))
    expected_step_no = int(payload["expectedStepNo"])
    preflight = (
        db.execute(
            text(
                """
                SELECT backfill.step_no, backfill.cursor, podcast.feed_url
                FROM podcast_subscription_backfills backfill
                JOIN podcast_subscriptions subscription
                  ON subscription.id = backfill.subscription_id
                JOIN podcasts podcast ON podcast.id = subscription.podcast_id
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
    if int(preflight["step_no"]) != expected_step_no:
        return {"status": "AlreadyApplied"}

    page_url, visited = _decode_cursor(preflight["cursor"], feed_url=str(preflight["feed_url"]))
    fetched = fetch_feed_backfill_page(page_url=page_url, visited=visited)

    def apply() -> dict[str, Any]:
        with transaction(db):
            if (
                lock_and_renew_running_job_claim(
                    db, context=context, lease_seconds=BACKFILL_JOB_LEASE_SECONDS
                )
                is None
            ):
                return {"status": "StaleJobAttempt"}
            row = (
                db.execute(
                    text(
                        """
                        SELECT
                            backfill.cutoff_at,
                            backfill.step_no,
                            backfill.completed_at,
                            backfill.source_limited_at,
                            backfill.failed_at,
                            subscription.user_id,
                            subscription.podcast_id,
                            podcast.feed_url
                        FROM podcast_subscription_backfills backfill
                        JOIN podcast_subscriptions subscription
                          ON subscription.id = backfill.subscription_id
                        JOIN podcasts podcast ON podcast.id = subscription.podcast_id
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
            if int(row["step_no"]) != expected_step_no or any(
                row[field] is not None
                for field in ("completed_at", "source_limited_at", "failed_at")
            ):
                return {"status": "AlreadyApplied"}

            cutoff_at = row["cutoff_at"]
            source_limited = fetched.source_limited
            selected: list[dict[str, Any]] = []
            for episode in sorted(fetched.episodes, key=_newest_first_key):
                published_at = parse_iso_datetime(episode.get("published_at"))
                if published_at is not None and published_at > cutoff_at:
                    continue
                if not aliases_from_episode(episode):
                    source_limited = True
                    continue
                selected.append(episode)

            # sync_subscription_ingest re-acquires the candidate-alias locks in
            # canonical order plus the parent Podcast row, so nothing is locked here.
            result = sync_subscription_ingest(
                db=db,
                viewer_id=UUID(str(row["user_id"])),
                podcast_id=UUID(str(row["podcast_id"])),
                feed_url=str(row["feed_url"]),
                selected_episodes=selected,
                now=db.execute(text("SELECT transaction_timestamp()")).scalar_one(),
            )
            next_cursor = None if source_limited else fetched.next_cursor
            terminal_complete = next_cursor is None and not source_limited
            db.execute(
                text(
                    """
                    UPDATE podcast_subscription_backfills
                    SET step_no = :next_step_no,
                        cursor = CAST(:next_cursor AS jsonb),
                        processed_count = processed_count + :processed_count,
                        added_count = added_count + :added_count,
                        started_at = COALESCE(started_at, transaction_timestamp()),
                        completed_at =
                            CASE WHEN :complete THEN transaction_timestamp() ELSE NULL END,
                        source_limited_at =
                            CASE WHEN :source_limited THEN transaction_timestamp() ELSE NULL END,
                        updated_at = transaction_timestamp()
                    WHERE id = :backfill_id AND step_no = :expected_step_no
                    """
                ),
                {
                    "backfill_id": backfill_id,
                    "next_step_no": expected_step_no + 1,
                    "next_cursor": (
                        None if next_cursor is None else json.dumps(next_cursor, sort_keys=True)
                    ),
                    "processed_count": len(fetched.episodes),
                    "added_count": result.added_to_subscriber_all_count,
                    "expected_step_no": expected_step_no,
                    "complete": terminal_complete,
                    "source_limited": source_limited,
                },
            )
            if next_cursor is not None:
                enqueue_backfill_step_in_current_transaction(
                    db, backfill_id=backfill_id, step_no=expected_step_no + 1
                )
            return {
                "status": "Applied",
                "processedCount": len(fetched.episodes),
                "addedCount": result.added_to_subscriber_all_count,
                "terminal": terminal_complete or source_limited,
            }

    return retry_read_committed(db, "podcast_backfill_step", apply)


def _decode_cursor(value: object, *, feed_url: str) -> tuple[str, tuple[str, ...]]:
    """Read the durable traversal position: the feed head, or a visited chain."""
    if value is None:
        return feed_url, ()
    cursor = dict(value) if isinstance(value, dict) else {}
    visited = cursor.get("visited")
    return (
        str(cursor.get("url") or ""),
        tuple(str(entry) for entry in visited) if isinstance(visited, list) else (),
    )


def _newest_first_key(episode: Mapping[str, Any]) -> tuple[int, float]:
    published_at = parse_iso_datetime(episode.get("published_at"))
    return (1, 0.0) if published_at is None else (0, -published_at.timestamp())
