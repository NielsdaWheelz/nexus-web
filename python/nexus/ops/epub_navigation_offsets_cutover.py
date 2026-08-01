"""Repair deferred EPUB navigation projections before revision 0209.

Revision 0208 deliberately leaves navigation rows nullable when legacy
sanitization removed a referenced structural anchor. This stopped-world
operator entrypoint refreshes only those EPUBs from their durable original
files through the canonical source-attempt and worker owners. Revision 0209 is
then free to enforce the non-null storage contract.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.session import get_session_factory
from nexus.jobs.worker import JobWorker
from nexus.services.media_source_ingest import (
    ensure_stale_source_attempt_job,
    refresh_source_for_viewer,
)

_CUTOVER_REVISION = "0208"
_REPAIR_JOB_KINDS = ("ingest_media_source", "media_content_reindex_job")
_IN_FLIGHT_ATTEMPT_STATUSES = frozenset({"accepted", "queued", "running"})
_ACTIVE_JOB_STATUSES = frozenset({"pending", "running", "failed"})


@dataclass(frozen=True, slots=True)
class DeferredMedia:
    media_id: UUID
    owner_user_id: UUID
    attempt_id: UUID
    processing_status: str
    attempt_status: str


@dataclass(frozen=True, slots=True)
class ActiveRepairJob:
    job_id: UUID
    kind: str
    status: str
    media_id: UUID


@dataclass(frozen=True, slots=True)
class CutoverCensus:
    revision: str
    deferred_rows: int
    media: tuple[DeferredMedia, ...]
    active_jobs: tuple[ActiveRepairJob, ...]


def classify_repair_action(media: DeferredMedia) -> Literal["enqueue", "resume"]:
    """Classify the only two resumable states in the stopped-world workflow."""
    if media.processing_status == "ready_for_reading" and media.attempt_status == "succeeded":
        return "enqueue"
    if (
        media.processing_status == "extracting"
        and media.attempt_status in _IN_FLIGHT_ATTEMPT_STATUSES
    ):
        return "resume"
    raise RuntimeError(
        "0208 EPUB navigation repair found non-resumable source state "
        f"for media {media.media_id}: "
        f"processing={media.processing_status} attempt={media.attempt_status}"
    )


def read_census(db: Session) -> CutoverCensus:
    db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
    db.execute(text("SET TRANSACTION READ ONLY"))
    revision = db.scalar(text("SELECT version_num FROM alembic_version"))
    if revision != _CUTOVER_REVISION:
        raise RuntimeError(
            "EPUB navigation offset repair requires Alembic revision 0208; "
            f"current revision is {revision}"
        )

    rows = (
        db.execute(
            text(
                """
                WITH affected AS (
                    SELECT n.media_id, count(*) AS deferred_rows
                    FROM epub_nav_locations n
                    WHERE n.start_offset IS NULL OR n.end_offset IS NULL
                    GROUP BY n.media_id
                )
                SELECT affected.media_id,
                       affected.deferred_rows,
                       m.created_by_user_id,
                       m.processing_status,
                       latest_attempt.id AS attempt_id,
                       latest_attempt.status AS attempt_status
                FROM affected
                JOIN media m ON m.id = affected.media_id
                LEFT JOIN LATERAL (
                    SELECT attempt.id, attempt.status
                    FROM media_source_attempts attempt
                    WHERE attempt.media_id = affected.media_id
                    ORDER BY attempt.attempt_no DESC
                    LIMIT 1
                ) latest_attempt ON true
                ORDER BY affected.media_id
                """
            )
        )
        .mappings()
        .all()
    )
    media: list[DeferredMedia] = []
    deferred_rows = 0
    for row in rows:
        owner_user_id = row["created_by_user_id"]
        attempt_id = row["attempt_id"]
        attempt_status = row["attempt_status"]
        if owner_user_id is None or attempt_id is None or attempt_status is None:
            raise RuntimeError(
                "0208 EPUB navigation repair requires an owner and source attempt "
                f"for media {row['media_id']}"
            )
        deferred_rows += int(row["deferred_rows"])
        media.append(
            DeferredMedia(
                media_id=UUID(str(row["media_id"])),
                owner_user_id=UUID(str(owner_user_id)),
                attempt_id=UUID(str(attempt_id)),
                processing_status=str(row["processing_status"]),
                attempt_status=str(attempt_status),
            )
        )

    active_jobs = _read_active_repair_jobs(db)
    return CutoverCensus(
        revision=str(revision),
        deferred_rows=deferred_rows,
        media=tuple(media),
        active_jobs=active_jobs,
    )


def repair_deferred_media() -> CutoverCensus:
    """Refresh deferred EPUBs, drain their durable work, and prove convergence."""
    session_factory = get_session_factory()
    with session_factory() as db:
        before = read_census(db)
    if not before.media:
        return before

    affected_media_ids = {item.media_id for item in before.media}
    foreign_jobs = [job for job in before.active_jobs if job.media_id not in affected_media_ids]
    if foreign_jobs:
        raise RuntimeError(
            "0208 EPUB navigation repair requires an isolated ingest/reindex queue; "
            f"found {len(foreign_jobs)} active foreign job(s)"
        )

    for media in before.media:
        action = classify_repair_action(media)
        if action == "resume":
            with session_factory() as db:
                outcome = ensure_stale_source_attempt_job(
                    db,
                    media_id=media.media_id,
                    attempt_id=media.attempt_id,
                    request_id="epub-navigation-offsets-0208",
                )
                db.commit()
            if outcome not in {"enqueued", "deduplicated"}:
                raise RuntimeError(
                    "0208 EPUB navigation repair could not resume canonical attempt "
                    f"{media.attempt_id}: {outcome}"
                )
            print(f"resume media={media.media_id} attempt={media.attempt_id} outcome={outcome}")
            continue
        with session_factory() as db:
            result = refresh_source_for_viewer(
                db=db,
                viewer_id=media.owner_user_id,
                media_id=media.media_id,
                request_id="epub-navigation-offsets-0208",
                idempotency_key=f"epub-navigation-offsets-0208:{media.media_id}",
            )
        if result.get("ingest_enqueued") is not True:
            raise RuntimeError(
                "0208 EPUB navigation repair failed to enqueue canonical refresh "
                f"for media {media.media_id}"
            )
        print(f"enqueue media={media.media_id} attempt={result['source_attempt_id']}")

    worker = JobWorker(
        session_factory=session_factory,
        worker_id="epub-navigation-offsets-0208",
        allowed_kinds=_REPAIR_JOB_KINDS,
    )
    while worker.run_once():
        pass

    with session_factory() as db:
        after = read_census(db)
    if after.deferred_rows != 0 or after.active_jobs:
        raise RuntimeError(
            "0208 EPUB navigation repair did not converge: "
            f"deferred_rows={after.deferred_rows} active_jobs={len(after.active_jobs)}"
        )
    return after


def _read_active_repair_jobs(db: Session) -> tuple[ActiveRepairJob, ...]:
    rows = (
        db.execute(
            text(
                """
                SELECT id, kind, status, payload->>'media_id' AS media_id
                FROM background_jobs
                WHERE kind IN ('ingest_media_source', 'media_content_reindex_job')
                  AND status IN ('pending', 'running', 'failed')
                ORDER BY id
                """
            )
        )
        .mappings()
        .all()
    )
    jobs: list[ActiveRepairJob] = []
    for row in rows:
        kind = str(row["kind"])
        status = str(row["status"])
        media_id = row["media_id"]
        if kind not in _REPAIR_JOB_KINDS or status not in _ACTIVE_JOB_STATUSES or media_id is None:
            raise RuntimeError(f"invalid active source job shape for job {row['id']}")
        jobs.append(
            ActiveRepairJob(
                job_id=UUID(str(row["id"])),
                kind=kind,
                status=status,
                media_id=UUID(str(media_id)),
            )
        )
    return tuple(jobs)


def _report(census: CutoverCensus) -> None:
    print(
        json.dumps(
            {
                "revision": census.revision,
                "deferred_rows": census.deferred_rows,
                "media": [
                    {
                        **asdict(item),
                        "media_id": str(item.media_id),
                        "owner_user_id": "present",
                        "attempt_id": str(item.attempt_id),
                        "action": classify_repair_action(item),
                    }
                    for item in census.media
                ],
                "active_jobs": [
                    {
                        **asdict(job),
                        "job_id": str(job.job_id),
                        "media_id": str(job.media_id),
                    }
                    for job in census.active_jobs
                ],
            },
            sort_keys=True,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m nexus.ops.epub_navigation_offsets_cutover")
    parser.add_argument("command", choices=("census", "repair"))
    args = parser.parse_args()
    if args.command == "repair":
        census = repair_deferred_media()
    else:
        with get_session_factory()() as db:
            census = read_census(db)
    _report(census)


if __name__ == "__main__":
    main()
