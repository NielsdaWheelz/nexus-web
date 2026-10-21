"""Walk the subscription's observed RSS history chain, one page per bounded queue job.

The immutable traversal id and expected step make retries inert after advancement or
replacement. Every worker effect locks its exact queue execution, then the subscription,
then the traversal before ingest's locks; network IO holds no transaction. Ingest,
rejection evidence, cursor advancement and one paced continuation commit together.
Coverage errors survive repair admission until a clean completion clears them; rejected
items never stop safe later pages. Completion describes this chain at the original cutoff.
"""

import json
from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from nexus.db.session import get_session_factory, transaction
from nexus.errors import ApiErrorCode
from nexus.ids import new_uuid7
from nexus.jobs.queue import (
    JobExecutionContext,
    JobResult,
    enqueue_unique_job,
    lock_running_job_claim,
)
from nexus.services.suggestion_changes import record_input_change

from .feed import fetch_page, is_safe_url
from .ingest import ingest_episodes

JOB_KIND = "podcast_backfill_subscription"
HISTORY_CONTINUATION_DELAY = timedelta(seconds=1)


def seed(
    db: Session,
    subscription_id: UUID,
    cutoff_at: datetime,
    *,
    error_code: str | None = None,
    error_detail: str | None = None,
) -> None:
    """Create a traversal at the original cutoff, retaining any unresolved repair warning."""
    backfill_id = new_uuid7()
    db.execute(
        text("""
            INSERT INTO podcast_subscription_backfills (
                id, subscription_id, cutoff_at, step_no, had_rejected_items,
                error_code, error_detail
            )
            VALUES (:id, :subscription_id, :cutoff_at, 0, false, :error_code, :error_detail)
        """),
        {
            "id": backfill_id,
            "subscription_id": subscription_id,
            "cutoff_at": cutoff_at,
            "error_code": error_code,
            "error_detail": error_detail,
        },
    )
    _enqueue_step(db, backfill_id, 0)


def _enqueue_step(db: Session, backfill_id: UUID, step_no: int) -> None:
    available_at = None
    if step_no > 0:
        available_at = db.scalar(
            text("SELECT now() + :delay"), {"delay": HISTORY_CONTINUATION_DELAY}
        )
    enqueue_unique_job(
        db,
        kind=JOB_KIND,
        payload={"backfill_id": str(backfill_id), "expected_step_no": step_no},
        dedupe_key=f"podcast-backfill:{backfill_id}:{step_no}",
        available_at=available_at,
    )


def _lock_step(db: Session, backfill_id: UUID, step_no: int) -> RowMapping | None:
    """Lock subscription before traversal, matching retry and unsubscribe lock order."""
    if (
        db.execute(
            text("""
            SELECT s.id FROM podcast_subscriptions s
            JOIN podcast_subscription_backfills b ON b.subscription_id = s.id
            WHERE b.id = :id FOR UPDATE OF s
        """),
            {"id": backfill_id},
        ).first()
        is None
    ):
        return None
    return (
        db.execute(
            text("""
            SELECT b.*, s.user_id, s.podcast_id, p.feed_url
            FROM podcast_subscription_backfills b
            JOIN podcast_subscriptions s ON s.id = b.subscription_id
            JOIN podcasts p ON p.id = s.podcast_id
            WHERE b.id = :id AND b.step_no = :step_no
              AND b.completed_at IS NULL AND b.failed_at IS NULL
            FOR UPDATE OF b
        """),
            {"id": backfill_id, "step_no": step_no},
        )
        .mappings()
        .first()
    )


def run_step(
    db: Session, payload: dict[str, Any], *, context: JobExecutionContext
) -> dict[str, Any]:
    """Fetch one page and apply it once; fetch/parse failures use queue retry/dead-letter."""
    backfill_id = UUID(str(payload["backfill_id"]))
    step_no = int(payload["expected_step_no"])
    with transaction(db):
        if lock_running_job_claim(db, context=context) is None:
            return {"status": "Stale"}
        head = _lock_step(db, backfill_id, step_no)
        if head is None:
            return {"status": "Stale"}
        db.execute(
            text("""
                UPDATE podcast_subscription_backfills
                SET started_at = now(), updated_at = now()
                WHERE id = :id AND step_no = :step_no AND started_at IS NULL
            """),
            {"id": backfill_id, "step_no": step_no},
        )
    url = head["feed_url"]
    visited = []
    if head["cursor"] is not None:
        url = head["cursor"]["url"]
        visited = head["cursor"]["visited"]
    page = fetch_page(url)
    visited = [*visited, url]
    next_url = page.next_url
    failure = None
    if next_url is not None:
        if not is_safe_url(next_url):
            failure = (
                ApiErrorCode.E_PODCAST_HISTORY_UNSAFE_NEXT_URL.value,
                f"Podcast history continuation URL is unsafe: {next_url}",
            )
        elif next_url in visited:
            failure = (
                ApiErrorCode.E_PODCAST_HISTORY_CYCLE.value,
                f"Podcast history continuation repeats a visited URL: {next_url}",
            )
    with transaction(db):
        if lock_running_job_claim(db, context=context) is None:
            return {"status": "Stale"}
        row = _lock_step(db, backfill_id, step_no)
        if row is None:
            return {"status": "Stale"}
        result = ingest_episodes(
            db,
            viewer_id=row["user_id"],
            podcast_id=row["podcast_id"],
            feed_url=row["feed_url"],
            episodes=[
                episode
                for episode in page.episodes
                if episode.published_at is None or episode.published_at <= row["cutoff_at"]
            ],
        )
        rejected = row["had_rejected_items"] or result.skipped > 0
        error_code, error_detail = row["error_code"], row["error_detail"]
        complete = next_url is None
        if failure is not None:
            error_code, error_detail = failure
        elif complete and not rejected:
            error_code, error_detail = None, None
        elif rejected and (complete or error_code is None):
            error_code = ApiErrorCode.E_PODCAST_ITEMS_SKIPPED.value
            error_detail = "Podcast history rejected items with ambiguous source identity"
        cursor = None
        if next_url is not None and failure is None:
            cursor = {"kind": "RssPage", "url": next_url, "visited": visited}
        db.execute(
            text("""
                UPDATE podcast_subscription_backfills
                SET step_no = step_no + 1, cursor = CAST(:cursor AS jsonb),
                    had_rejected_items = :rejected,
                    completed_at = CASE WHEN :complete THEN now() END,
                    failed_at = CASE WHEN :failed THEN now() END,
                    error_code = :error_code, error_detail = left(:error_detail, 500),
                    updated_at = now()
                WHERE id = :id AND step_no = :step_no
            """),
            {
                "id": backfill_id,
                "step_no": step_no,
                "cursor": None if cursor is None else json.dumps(cursor),
                "rejected": rejected,
                "complete": complete,
                "failed": failure is not None,
                "error_code": error_code,
                "error_detail": error_detail,
            },
        )
        if cursor is not None:
            _enqueue_step(db, backfill_id, step_no + 1)
        if result.changed:
            record_input_change(db)
        return {"status": "Applied"}


def run_job(*, payload: Mapping[str, Any], context: JobExecutionContext) -> JobResult:
    """The ``podcast_backfill_subscription`` handler, in its background child."""
    with get_session_factory()() as db:
        return run_step(db, dict(payload), context=context)
