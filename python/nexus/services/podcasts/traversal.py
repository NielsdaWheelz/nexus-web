"""One safe page per durable feed step, shared by finite imports and recurring scans.

Retry rule: exact queue execution, owning run, attempt and step fence publication.
A page commits catalog identities, import processing, insertion-only delivery, cursor
and continuation together. Requested/final URLs retain case and query. Duplicates
and cycles are harmless; rejected links/items permanently mark this attempt's gaps.
Fetch exhaustion pauses finite imports at their current URL. Terminal clean/cancel
clears processed identities; a failed import retains them for explicit retry.
"""

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory, transaction
from nexus.errors import ApiErrorCode
from nexus.jobs.queue import (
    JobExecutionContext,
    JobResult,
    enqueue_unique_job,
    lock_running_job_claim,
)
from nexus.services.suggestion_changes import record_input_change
from nexus.services.url_normalize import normalize_url_for_display

from . import imports, sync
from .feed import BlockedFeedPage, fetch_page, is_safe_url
from .ingest import aliases_of, ingest_episodes, lock_aliases

JOB_KIND = "podcast_feed_page"


def enqueue_step(db: Session, *, run_id: UUID) -> None:
    """Admit the current step of a locked live run; duplicate admission joins it."""
    row = db.execute(
        text("""
        SELECT attempt_version,step_no,pending_urls,completed_at,failed_at,cancelled_at
        FROM podcast_feed_runs WHERE id=:id
    """),
        {"id": run_id},
    ).one()
    assert row.pending_urls and not any((row.completed_at, row.failed_at, row.cancelled_at))
    job, _ = enqueue_unique_job(
        db,
        kind=JOB_KIND,
        payload={
            "run_id": str(run_id),
            "expected_attempt_version": row.attempt_version,
            "expected_step_no": row.step_no,
        },
        dedupe_key=f"podcast-feed:{run_id}:{row.attempt_version}:{row.step_no}",
    )
    db.execute(
        text("UPDATE podcast_feed_runs SET job_id=:job_id,updated_at=now() WHERE id=:id"),
        {"id": run_id, "job_id": job.id},
    )


def _lock_run(
    db: Session, *, run_id: UUID, attempt: int, step: int, job_id: UUID
) -> RowMapping | None:
    podcast_id = db.scalar(
        text("SELECT podcast_id FROM podcast_feed_runs WHERE id=:id"), {"id": run_id}
    )
    if podcast_id is None:
        return None
    show = db.execute(
        text("SELECT id FROM podcasts WHERE id=:id FOR UPDATE"), {"id": podcast_id}
    ).first()
    if show is None:
        return None
    row = (
        db.execute(
            text("""
        SELECT r.*, i.id AS import_id,p.feed_url,p.provider,p.provider_podcast_id,
            p.sync_run_id=r.id AS recurring
        FROM podcast_feed_runs r JOIN podcasts p ON p.id=r.podcast_id
        LEFT JOIN podcast_library_imports i ON i.run_id=r.id
        WHERE r.id=:id AND r.job_id=:job_id AND r.attempt_version=:attempt AND r.step_no=:step
            AND r.completed_at IS NULL AND r.cancelled_at IS NULL AND r.failed_at IS NULL
            AND (i.id IS NOT NULL OR p.sync_run_id=r.id)
        FOR UPDATE OF r
    """),
            {"id": run_id, "job_id": job_id, "attempt": attempt, "step": step},
        )
        .mappings()
        .first()
    )
    if row is not None:
        assert (row["import_id"] is not None) != bool(row["recurring"])
    return row


def run_step(db: Session, payload: Mapping[str, Any], *, context: JobExecutionContext) -> JobResult:
    """Fetch without locks, then validate all fences again before any publication."""
    run_id = UUID(str(payload["run_id"]))
    attempt, step = int(payload["expected_attempt_version"]), int(payload["expected_step_no"])
    with transaction(db):
        if lock_running_job_claim(db, context=context) is None:
            return {"status": "Stale"}
        head = _lock_run(db, run_id=run_id, attempt=attempt, step=step, job_id=context.job_id)
        if head is None:
            return {"status": "Stale"}
        assert head["pending_urls"]
        started = db.scalar(
            text("""
            UPDATE podcast_feed_runs SET started_at=now(),updated_at=now()
            WHERE id=:id AND started_at IS NULL RETURNING id
        """),
            {"id": run_id},
        )
        if started is not None:
            imports.finish_run(db, run_id=run_id)
    page = fetch_page(head["pending_urls"][0])
    aliases = (
        []
        if isinstance(page, BlockedFeedPage)
        else [alias for item in page.episodes for alias in aliases_of(item)]
    )

    def publish() -> JobResult:
        if lock_running_job_claim(db, context=context) is None:
            return {"status": "Stale"}
        lock_aliases(db, f"{head['provider']}:{head['provider_podcast_id']}", aliases)
        row = _lock_run(db, run_id=run_id, attempt=attempt, step=step, job_id=context.job_id)
        if row is None:
            return {"status": "Stale"}
        visited = [*row["visited_urls"], normalize_url_for_display(page.requested_url)]
        pending = list(row["pending_urls"][1:])
        gaps = row["had_coverage_gaps"]
        if isinstance(page, BlockedFeedPage):
            # A DNS/redirect rejection skips this branch without concealing the gap.
            gaps = True
        else:
            result = ingest_episodes(
                db, podcast_id=row["podcast_id"], feed_url=row["feed_url"], episodes=page.episodes
            )
            imports.publish_episodes(
                db,
                podcast_id=row["podcast_id"],
                media_ids=[media_id for media_id in result.media_ids if media_id is not None],
                new_media_ids=result.inserted_media_ids,
                import_id=row["import_id"],
            )
            visited.append(normalize_url_for_display(page.final_url))
            gaps = (
                gaps
                or result.skipped > 0
                or any(
                    episode.audio_url is not None and not is_safe_url(episode.audio_url)
                    for episode in page.episodes
                )
            )
            for url in page.linked_urls:
                if not is_safe_url(url):
                    gaps = True
                    continue
                url = normalize_url_for_display(url)
                if url not in visited and url not in pending:
                    pending.append(url)
        visited = list(dict.fromkeys(visited))
        pending = [url for url in pending if url not in visited]
        drained = not pending
        code = ApiErrorCode.E_PODCAST_ITEMS_SKIPPED.value if gaps else None
        detail = (
            "Available podcast history has unsafe links or rejected episode identities"
            if gaps
            else None
        )
        db.execute(
            text("""
            UPDATE podcast_feed_runs SET step_no=step_no+1,job_id=NULL,
                pending_urls=CAST(:pending AS text[]),visited_urls=CAST(:visited AS text[]),
                had_coverage_gaps=:gaps,updated_at=now(),
                completed_at=CASE WHEN :drained AND NOT :gaps THEN now() END,
                failed_at=CASE WHEN :drained AND :gaps THEN now() END,
                error_code=:code,error_detail=:detail WHERE id=:id
        """),
            {
                "id": run_id,
                "pending": pending,
                "visited": visited,
                "gaps": gaps,
                "drained": drained,
                "code": code,
                "detail": detail,
            },
        )
        if pending:
            enqueue_step(db, run_id=run_id)
        else:
            imports.finish_run(db, run_id=run_id)
            sync.settle_recurring(db, run_id=run_id)
        record_input_change(db, owners=(f"podcast:{row['podcast_id']}",))
        return {"status": "Applied", "has_more": bool(pending)}

    return retry_serializable(db, "podcast.feed_page", publish)


def run_job(*, payload: Mapping[str, Any], context: JobExecutionContext) -> JobResult:
    with get_session_factory()() as db:
        return run_step(db, payload, context=context)
