"""Viewer-scoped Activity projection over canonical media, source, and queue state."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.schemas.media import MediaOut
from nexus.schemas.media_activity import (
    MediaActivityCapabilitiesOut,
    MediaActivityItemOut,
    MediaActivityOut,
)
from nexus.schemas.presence import Absent, Present, absent, present
from nexus.services.media import list_media_for_viewer_by_ids

WORKER_INTERRUPTED_CODE = "E_WORKER_INTERRUPTED"

ActivityStatus = Literal["Queued", "Processing", "Ready", "NeedsAttention"]
ActivityStage = Literal["Validate", "Extract", "Finalize", "Index"]
WaitingReason = Literal["Queue", "Capacity", "RetryBackoff"]


def _activity_rows(db: Session, *, viewer_id: UUID, limit: int) -> list[RowMapping]:
    return list(
        db.execute(
            text(
                f"""
                WITH visible_media AS (
                    {visible_media_ids_cte_sql()}
                ), activity AS (
                    SELECT
                        m.id AS media_id,
                        msa.id AS source_attempt_id,
                        msa.status AS source_attempt_status,
                        msa.processing_stage AS source_attempt_stage,
                        msa.error_code AS source_attempt_error_code,
                        msa.request_id,
                        msa.run_count,
                        msa.created_at,
                        msa.updated_at AS source_updated_at,
                        source_job.id AS source_job_id,
                        source_job.kind AS source_job_kind,
                        source_job.payload @> jsonb_build_object(
                            'media_id', m.id::text,
                            'attempt_id', msa.id::text
                        ) AS source_job_exact,
                        source_job.status AS source_job_status,
                        source_job.attempts AS source_job_attempts,
                        source_job.max_attempts AS source_job_max_attempts,
                        source_job.available_at AS source_job_available_at,
                        source_job.updated_at AS source_job_updated_at,
                        source_job.error_code AS source_job_error_code,
                        cis.status AS index_status,
                        cis.updated_at AS index_updated_at,
                        index_job.id AS index_job_id,
                        index_job.status AS index_job_status,
                        index_job.attempts AS index_job_attempts,
                        index_job.max_attempts AS index_job_max_attempts,
                        index_job.available_at AS index_job_available_at,
                        index_job.updated_at AS index_job_updated_at,
                        index_job.error_code AS index_job_error_code,
                        index_job.exact_count AS exact_index_job_count,
                        CASE
                            WHEN capacity.lease_expires_at > now()
                              OR capacity_holder.lease_expires_at > now()
                            THEN capacity.job_id
                            ELSE NULL
                        END AS capacity_job_id,
                        now() AS database_now,
                        count(*) FILTER (
                            WHERE msa.status NOT IN ('succeeded', 'superseded')
                               OR source_job.status = 'dead'
                               OR cis.status IN ('pending', 'indexing', 'failed')
                               OR index_job.status IN ('pending', 'failed', 'running', 'dead')
                        ) OVER () AS nonterminal_count
                    FROM media m
                    JOIN visible_media vm ON vm.media_id = m.id
                    JOIN LATERAL (
                        SELECT latest.*
                        FROM media_source_attempts latest
                        WHERE latest.media_id = m.id
                        ORDER BY latest.attempt_no DESC, latest.created_at DESC, latest.id DESC
                        LIMIT 1
                    ) msa ON TRUE
                    LEFT JOIN background_jobs source_job ON source_job.id = msa.job_id
                    LEFT JOIN content_index_states cis
                      ON cis.owner_kind = 'media'
                     AND cis.owner_id = m.id
                    LEFT JOIN LATERAL (
                        SELECT exact.*, count(*) OVER () AS exact_count
                        FROM background_jobs exact
                        WHERE exact.kind = 'media_content_reindex_job'
                          AND exact.status <> 'succeeded'
                          AND exact.payload @> jsonb_build_object(
                              'media_id', m.id::text,
                              'revision', cis.revision
                          )
                        ORDER BY exact.created_at DESC, exact.id DESC
                        LIMIT 1
                    ) index_job ON TRUE
                    LEFT JOIN background_job_capacity_leases capacity
                      ON capacity.resource_class = 'Heavy'
                    LEFT JOIN background_jobs capacity_holder
                      ON capacity_holder.id = capacity.job_id
                    WHERE NOT (
                        msa.status = 'accepted'
                        AND msa.job_id IS NULL
                    )
                )
                SELECT *
                FROM activity
                ORDER BY created_at DESC, source_attempt_id DESC
                LIMIT :limit
                """
            ),
            {"viewer_id": viewer_id, "limit": limit},
        )
        .mappings()
        .all()
    )


def _source_stage(row: RowMapping, media: MediaOut) -> ActivityStage:
    """Where the source run stands, independent of in-flight progress.

    `source_progress` is Present only while a run is in flight, so a terminal
    attempt reports its persisted stage from the attempt row rather than
    collapsing back to `Validate`.
    """
    if isinstance(media.source_progress, Present):
        return cast(ActivityStage, media.source_progress.value.stage)
    persisted = row["source_attempt_stage"]
    if persisted in {"Validate", "Extract", "Finalize"}:
        return cast(ActivityStage, persisted)
    return "Validate"


def _waiting_reason(
    row: RowMapping,
    *,
    job_prefix: Literal["source_job", "index_job"],
) -> Absent | Present[WaitingReason]:
    job_id = row[f"{job_prefix}_id"]
    status = row[f"{job_prefix}_status"]
    if job_id is None or status not in {"pending", "failed"}:
        return absent()
    if row[f"{job_prefix}_available_at"] > row["database_now"]:
        return present("RetryBackoff")
    if row["capacity_job_id"] is not None and row["capacity_job_id"] != job_id:
        return present("Capacity")
    return present("Queue")


def _latest_updated_at(row: RowMapping, media: MediaOut) -> datetime:
    return max(
        value
        for value in (
            media.updated_at,
            row["source_updated_at"],
            row["source_job_updated_at"],
            row["index_updated_at"],
            row["index_job_updated_at"],
        )
        if value is not None
    )


def _activity_item(row: RowMapping, media: MediaOut) -> MediaActivityItemOut:
    if row["source_job_id"] is not None and (
        row["source_job_kind"] != "ingest_media_source" or not row["source_job_exact"]
    ):
        # justify-defect: one source attempt owns one exact ingest operation.
        raise AssertionError("source attempt points at a foreign queue operation")
    if int(row["exact_index_job_count"] or 0) > 1:
        # justify-defect: one current content revision owns at most one live/dead operation.
        raise AssertionError("multiple exact content-index jobs match one current revision")

    source_dead = row["source_job_status"] == "dead"
    index_dead = row["index_job_status"] == "dead"
    source_finished = row["source_attempt_status"] in {"succeeded", "superseded"}
    index_active = row["index_status"] in {"pending", "indexing", "failed"} or row[
        "index_job_status"
    ] in {"pending", "failed", "running"}

    if source_dead or index_dead or row["source_attempt_status"] == "failed":
        status: ActivityStatus = "NeedsAttention"
        stage: ActivityStage | None = "Index" if index_dead else _source_stage(row, media)
        waiting = absent()
        queue_prefix = "index_job" if index_dead else "source_job"
    elif not source_finished:
        status = "Processing" if row["source_job_status"] == "running" else "Queued"
        stage = _source_stage(row, media)
        waiting = _waiting_reason(row, job_prefix="source_job")
        queue_prefix = "source_job"
    elif index_active:
        status = "Ready"
        stage = "Index"
        waiting = _waiting_reason(row, job_prefix="index_job")
        queue_prefix = "index_job"
    else:
        status = "Ready"
        stage = None
        waiting = absent()
        queue_prefix = "index_job"

    queue_attempts = row[f"{queue_prefix}_attempts"]
    queue_max_attempts = row[f"{queue_prefix}_max_attempts"]
    queue_status = row[f"{queue_prefix}_status"]
    queue_error_code = row[f"{queue_prefix}_error_code"]
    # A reclaimed attempt runs again carrying E_WORKER_INTERRUPTED, so the code is
    # surfaced while running as well. That is the exact queue evidence the
    # interruption rule requires; nothing here ever infers OOM.
    failure_code = (
        queue_error_code
        if queue_status in {"failed", "dead"}
        or (queue_status == "running" and queue_error_code == WORKER_INTERRUPTED_CODE)
        else (
            row["source_attempt_error_code"] if row["source_attempt_status"] == "failed" else None
        )
    )
    return MediaActivityItemOut(
        media_id=media.id,
        title=media.title,
        media_kind=cast(
            Literal["web_article", "epub", "pdf", "podcast_episode", "video"],
            media.kind,
        ),
        source_attempt_id=row["source_attempt_id"],
        status=status,
        stage=absent() if stage is None else present(stage),
        waiting_reason=waiting,
        progress=media.source_progress,
        failure_code=absent() if failure_code is None else present(str(failure_code)),
        request_id=absent() if row["request_id"] is None else present(str(row["request_id"])),
        run_count=int(row["run_count"]),
        queue_attempts=int(queue_attempts or 0),
        queue_max_attempts=int(queue_max_attempts or 0),
        created_at=row["created_at"],
        updated_at=_latest_updated_at(row, media),
        capabilities=MediaActivityCapabilitiesOut(
            can_open=media.capabilities.can_read,
            can_repair_source=media.capabilities.can_repair_source,
            can_repair_search=media.capabilities.can_repair_search,
            can_remove=media.capabilities.can_delete,
        ),
    )


def read_media_activity(
    db: Session,
    *,
    viewer_id: UUID,
    limit: int,
    is_admin: bool = False,
) -> MediaActivityOut:
    rows = _activity_rows(db, viewer_id=viewer_id, limit=limit)
    if not rows:
        return MediaActivityOut(nonterminal_count=0, items=[])
    media = {
        item.id: item
        for item in list_media_for_viewer_by_ids(
            db,
            viewer_id,
            [UUID(str(row["media_id"])) for row in rows],
            is_admin=is_admin,
        )
    }
    expected_media_ids = [UUID(str(row["media_id"])) for row in rows]
    missing_media_ids = [media_id for media_id in expected_media_ids if media_id not in media]
    if missing_media_ids:
        # justify-defect: Activity and media hydration share the same viewer predicate.
        raise AssertionError("Activity media hydration lost viewer-visible rows")
    items = [_activity_item(row, media[UUID(str(row["media_id"]))]) for row in rows]
    return MediaActivityOut(nonterminal_count=int(rows[0]["nonterminal_count"]), items=items)
