"""Backfill: walk a new subscription's rss history back to its cutoff, one page per step.

The backfill row is the traversal: ``step_no`` names the next step and ``cursor`` the next
page with the chain already visited. A step's job carries the step it expects; applying
it advances ``step_no`` in the same transaction that enqueues the next step, so a step
applies once however often its job runs. Lock order: the backfill row, then ingest's.
"""

import json
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.session import transaction
from nexus.ids import new_uuid7
from nexus.jobs.queue import enqueue_unique_job

from .feed import fetch_page, is_safe_url
from .ingest import ingest_episodes

JOB_KIND = "podcast_backfill_subscription"
MAX_PAGES = 10


def seed(db: Session, subscription_id: UUID, cutoff_at: datetime) -> None:
    """The subscription's one backfill, at step 0, and its first job."""
    backfill_id = new_uuid7()
    db.execute(
        text("""
            INSERT INTO podcast_subscription_backfills (
                id, subscription_id, cutoff_at, step_no, processed_count, added_count
            )
            VALUES (:id, :subscription_id, :cutoff_at, 0, 0, 0)
        """),
        {"id": backfill_id, "subscription_id": subscription_id, "cutoff_at": cutoff_at},
    )
    _enqueue_step(db, backfill_id, 0)


def _enqueue_step(db: Session, backfill_id: UUID, step_no: int) -> None:
    enqueue_unique_job(
        db,
        kind=JOB_KIND,
        payload={"backfillId": str(backfill_id), "expectedStepNo": step_no},
        dedupe_key=f"podcast-backfill:{backfill_id}:{step_no}",
    )


def run_step(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    """Fetch the step's page with no transaction open, then apply it once. A page that
    cannot be fetched or parsed raises: the job retries and, exhausted, fails the backfill
    (jobs/dead_letter_projections.py)."""
    backfill_id = UUID(str(payload["backfillId"]))
    step_no = int(payload["expectedStepNo"])
    with transaction(db):
        head = db.execute(
            text("""
                SELECT b.step_no, b.cursor, p.feed_url
                FROM podcast_subscription_backfills b
                JOIN podcast_subscriptions s ON s.id = b.subscription_id
                JOIN podcasts p ON p.id = s.podcast_id
                WHERE b.id = :id
            """),
            {"id": backfill_id},
        ).first()
    if head is None or head.step_no != step_no:
        return {"status": "Stale"}
    url = head.feed_url
    visited = []
    if head.cursor is not None:
        url = head.cursor["url"]
        visited = head.cursor["visited"]
    page = fetch_page(url)
    visited = [*visited, url]
    next_url = page.next_url
    ends = next_url is not None and (
        not is_safe_url(next_url) or next_url in visited or len(visited) >= MAX_PAGES
    )
    with transaction(db):
        row = db.execute(
            text("""
                SELECT b.cutoff_at, s.user_id, s.podcast_id, p.feed_url
                FROM podcast_subscription_backfills b
                JOIN podcast_subscriptions s ON s.id = b.subscription_id
                JOIN podcasts p ON p.id = s.podcast_id
                WHERE b.id = :id AND b.step_no = :step_no AND b.completed_at IS NULL
                  AND b.source_limited_at IS NULL AND b.failed_at IS NULL
                FOR UPDATE OF b
            """),
            {"id": backfill_id, "step_no": step_no},
        ).first()
        if row is None:
            return {"status": "Stale"}
        result = ingest_episodes(
            db,
            viewer_id=row.user_id,
            podcast_id=row.podcast_id,
            feed_url=row.feed_url,
            episodes=[
                episode
                for episode in page.episodes
                if episode.published_at is None or episode.published_at <= row.cutoff_at
            ],
        )
        limited = ends or result.skipped > 0
        cursor = None
        if next_url is not None and not limited:
            cursor = {"kind": "RssPage", "url": next_url, "visited": visited}
        db.execute(
            text("""
                UPDATE podcast_subscription_backfills
                SET step_no = step_no + 1, cursor = CAST(:cursor AS jsonb),
                    processed_count = processed_count + :processed,
                    added_count = added_count + :added,
                    started_at = COALESCE(started_at, now()),
                    completed_at = CASE WHEN :complete THEN now() END,
                    source_limited_at = CASE WHEN :limited THEN now() END,
                    updated_at = now()
                WHERE id = :id
            """),
            {
                "id": backfill_id,
                "cursor": None if cursor is None else json.dumps(cursor),
                "processed": len(page.episodes),
                "added": result.added_to_all,
                "complete": cursor is None and not limited,
                "limited": limited,
            },
        )
        if cursor is not None:
            _enqueue_step(db, backfill_id, step_no + 1)
        return {"status": "Applied", "processed": len(page.episodes), "added": result.added_to_all}
