"""Independent head checks and archive catch-up on the existing feed worker.

Only a head attempt changes freshness/backoff. A slow or failed archive never holds
the head pointer. Archive frontiers merge into the live catch-up under the feed lock;
terminal catch-up records its coverage separately and releases its pointer.
"""

from collections.abc import Mapping, Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.session import get_session_factory, transaction
from nexus.errors import ApiErrorCode
from nexus.ids import new_uuid7
from nexus.jobs.queue import JobExecutionContext, JobResult, lock_running_job_claim
from nexus.schemas import feed as wire


def ensure_scheduled(db: Session, *, feed_id: UUID) -> None:
    db.execute(
        text("""UPDATE feeds SET next_sync_at=date_trunc('hour',now())+interval '1 hour'
        WHERE id=:id AND next_sync_at IS NULL AND head_run_id IS NULL"""),
        {"id": feed_id},
    )


def admit_head(db: Session, *, feed_id: UUID) -> None:
    from .traversal import enqueue_step

    row = db.execute(
        text("SELECT head_run_id,feed_url FROM feeds WHERE id=:id"), {"id": feed_id}
    ).one()
    if row.head_run_id is not None:
        return
    run_id = new_uuid7()
    db.execute(
        text("""INSERT INTO feed_runs(id,feed_id,purpose,pending_urls)
        VALUES (:id,:feed,'head',CAST(:urls AS text[]))"""),
        {"id": run_id, "feed": feed_id, "urls": [row.feed_url]},
    )
    db.execute(
        text("UPDATE feeds SET head_run_id=:run,next_sync_at=NULL WHERE id=:feed"),
        {"feed": feed_id, "run": run_id},
    )
    enqueue_step(db, run_id=run_id)


def admit_catchup(
    db: Session,
    *,
    feed_id: UUID,
    urls: Sequence[str],
    visited: Sequence[str],
    had_coverage_gaps: bool = False,
) -> None:
    from .traversal import enqueue_step

    run_id = db.scalar(text("SELECT catchup_run_id FROM feeds WHERE id=:id"), {"id": feed_id})
    if run_id is not None:
        run = db.execute(
            text("SELECT pending_urls,visited_urls FROM feed_runs WHERE id=:id FOR UPDATE"),
            {"id": run_id},
        ).one()
        pending = list(
            dict.fromkeys([*run.pending_urls, *[u for u in urls if u not in run.visited_urls]])
        )
        db.execute(
            text(
                "UPDATE feed_runs SET pending_urls=CAST(:urls AS text[]),had_coverage_gaps=had_coverage_gaps OR :gaps,updated_at=now() WHERE id=:id"
            ),
            {"id": run_id, "urls": pending, "gaps": had_coverage_gaps},
        )
        return
    pending = list(dict.fromkeys(u for u in urls if u not in visited))
    if not pending:
        if had_coverage_gaps:
            db.execute(
                text("""UPDATE feeds SET last_catchup_at=now(),last_catchup_had_coverage_gaps=true,
                last_catchup_error_code=:code,last_catchup_error_detail=:detail WHERE id=:id"""),
                {
                    "id": feed_id,
                    "code": ApiErrorCode.E_FEED_ITEMS_SKIPPED.value,
                    "detail": "Historical feed links could not be fetched",
                },
            )
        return
    run_id = new_uuid7()
    db.execute(
        text("""INSERT INTO feed_runs(id,feed_id,purpose,pending_urls,visited_urls,had_coverage_gaps)
        VALUES (:id,:feed,'catchup',CAST(:urls AS text[]),CAST(:visited AS text[]),:gaps)"""),
        {
            "id": run_id,
            "feed": feed_id,
            "urls": pending,
            "visited": list(dict.fromkeys(visited)),
            "gaps": had_coverage_gaps,
        },
    )
    db.execute(
        text("UPDATE feeds SET catchup_run_id=:run WHERE id=:feed"),
        {"feed": feed_id, "run": run_id},
    )
    enqueue_step(db, run_id=run_id)


def refresh(db: Session, viewer_id: UUID, scope: wire.FeedRefreshManualScope) -> int:
    from nexus.services import libraries

    from .queries import require_feed_access

    params: dict[str, Any] = {"viewer_id": viewer_id}
    predicate = ""
    with transaction(db):
        if isinstance(scope, wire.FeedRefreshFeedScope):
            require_feed_access(db, viewer_id, scope.feed_id)
            db.execute(text("SELECT id FROM feeds WHERE id=:id FOR UPDATE"), {"id": scope.feed_id})
            admit_head(db, feed_id=scope.feed_id)
            return 1
        if isinstance(scope, wire.FeedRefreshLibraryScope):
            library = libraries.access(db, viewer_id, scope.library_id, lock=False)
            if not library.is_default:
                predicate = "AND s.library_id=:library_id"
                params["library_id"] = scope.library_id
        ids = list(
            db.scalars(
                text(f"""SELECT p.id FROM feeds p WHERE EXISTS (
            SELECT 1 FROM library_feed_subscriptions s JOIN libraries l ON l.id=s.library_id
            JOIN memberships m ON m.library_id=l.id AND m.user_id=:viewer_id
            WHERE s.feed_id=p.id AND l.system_key IS NULL {predicate}) ORDER BY p.id FOR UPDATE"""),
                params,
            )
        )
        for feed_id in ids:
            admit_head(db, feed_id=feed_id)
        return len(ids)


def admit_due(db: Session, *, limit: int, context: JobExecutionContext) -> int:
    with transaction(db):
        if lock_running_job_claim(db, context=context) is None:
            return 0
        ids = list(
            db.scalars(
                text("""SELECT p.id FROM feeds p WHERE p.head_run_id IS NULL AND p.next_sync_at<=now()
            AND EXISTS(SELECT 1 FROM library_feed_subscriptions s WHERE s.feed_id=p.id)
            ORDER BY p.next_sync_at,p.id LIMIT :limit FOR UPDATE SKIP LOCKED"""),
                {"limit": min(max(limit, 1), 100)},
            )
        )
        for feed_id in ids:
            admit_head(db, feed_id=feed_id)
        return len(ids)


def settle_recurring(db: Session, *, run_id: UUID) -> None:
    row = db.execute(
        text("""SELECT p.id,r.purpose FROM feeds p JOIN feed_runs r ON r.feed_id=p.id
        WHERE r.id=:id AND (r.completed_at IS NOT NULL OR r.failed_at IS NOT NULL)
        AND ((r.purpose='head' AND p.head_run_id=r.id) OR (r.purpose='catchup' AND p.catchup_run_id=r.id))"""),
        {"id": run_id},
    ).first()
    if row is None:
        return
    if row.purpose == "head":
        db.execute(
            text("""UPDATE feeds p SET head_run_id=NULL,last_checked_at=now(),
            last_check_had_coverage_gaps=r.had_coverage_gaps,last_check_error_code=r.error_code,
            last_check_error_detail=r.error_detail,
            next_sync_at=CASE WHEN NOT EXISTS(SELECT 1 FROM library_feed_subscriptions s WHERE s.feed_id=p.id)
                THEN NULL WHEN r.failed_at IS NULL THEN date_trunc('hour',now())+interval '1 hour'
                ELSE now()+CASE LEAST(p.consecutive_sync_failures,3) WHEN 0 THEN interval '15 minutes'
                    WHEN 1 THEN interval '1 hour' WHEN 2 THEN interval '6 hours' ELSE interval '24 hours' END END,
            consecutive_sync_failures=CASE WHEN r.failed_at IS NULL THEN 0 ELSE p.consecutive_sync_failures+1 END,
            updated_at=now() FROM feed_runs r WHERE p.id=:feed AND r.id=:run AND p.head_run_id=r.id"""),
            {"feed": row.id, "run": run_id},
        )
    else:
        db.execute(
            text("""UPDATE feeds p SET catchup_run_id=NULL,last_catchup_at=now(),
            last_catchup_had_coverage_gaps=r.had_coverage_gaps,last_catchup_error_code=r.error_code,
            last_catchup_error_detail=r.error_detail,updated_at=now() FROM feed_runs r
            WHERE p.id=:feed AND r.id=:run AND p.catchup_run_id=r.id"""),
            {"feed": row.id, "run": run_id},
        )
    db.execute(text("DELETE FROM feed_runs WHERE id=:id"), {"id": run_id})


def stop_if_unused(db: Session, *, feed_id: UUID) -> None:
    db.execute(
        text("""UPDATE feeds SET next_sync_at=NULL WHERE id=:id AND NOT EXISTS(
        SELECT 1 FROM library_feed_subscriptions WHERE feed_id=:id)"""),
        {"id": feed_id},
    )


def run_due_job(*, payload: Mapping[str, Any], context: JobExecutionContext) -> JobResult:
    with get_session_factory()() as db:
        return {
            "feed_count": admit_due(
                db, limit=get_settings().feed_refresh_due_limit, context=context
            )
        }
