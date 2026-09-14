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
    MediaActivityActiveStateOut,
    MediaActivityCapabilitiesOut,
    MediaActivityItemOut,
    MediaActivityNeedsAttentionStateOut,
    MediaActivityOut,
)
from nexus.schemas.presence import Absent, Present, absent, present
from nexus.services.media import list_media_for_viewer_by_ids

WORKER_INTERRUPTED_CODE = "E_WORKER_INTERRUPTED"

ActivityStage = Literal["Validate", "Extract", "Finalize", "Index"]
WaitingReason = Literal["Queue", "Capacity", "RetryBackoff"]


def _activity_rows(db: Session, *, viewer_id: UUID, limit: int) -> list[RowMapping]:
    """Return one classified, viewer-visible row per media item.

    Classification, totals, ordering, and the page limit deliberately share the
    same CTE. This prevents completed work from consuming the page that should
    contain current attention or active work.
    """
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
                        now() AS database_now
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
                ), classified AS (
                    SELECT
                        activity.*,
                        CASE
                            -- Source state owns the projection until publication.
                            WHEN source_attempt_status NOT IN ('succeeded', 'superseded')
                             AND source_job_status = 'dead'
                                THEN 'NeedsAttention'
                            WHEN source_attempt_status = 'failed'
                             AND (
                                source_job_status IS NULL
                                OR source_job_status NOT IN ('pending', 'failed', 'running')
                             )
                                THEN 'NeedsAttention'
                            WHEN source_attempt_status NOT IN ('succeeded', 'superseded')
                                THEN 'Active'
                            -- A dead source job after publication is an operator
                            -- anomaly; it must not re-alert the user.
                            WHEN source_attempt_status IN ('succeeded', 'superseded')
                             AND index_status = 'failed'
                             AND NOT (
                                COALESCE(exact_index_job_count, 0) = 1
                                AND index_job_status = 'dead'
                             )
                                THEN 'InvariantDefect'
                            WHEN source_attempt_status IN ('succeeded', 'superseded')
                             AND index_job_status = 'dead'
                                THEN 'NeedsAttention'
                            WHEN source_attempt_status IN ('succeeded', 'superseded')
                             AND (
                                index_status IN ('pending', 'indexing', 'failed')
                                OR index_job_status IN ('pending', 'failed', 'running')
                             )
                                THEN 'Active'
                            ELSE 'Complete'
                        END AS classification,
                        CASE
                            WHEN source_attempt_status NOT IN ('succeeded', 'superseded')
                                THEN GREATEST(
                                    source_updated_at,
                                    COALESCE(source_job_updated_at, source_updated_at)
                                )
                            ELSE GREATEST(
                                COALESCE(index_updated_at, source_updated_at),
                                COALESCE(index_job_updated_at, source_updated_at)
                            )
                        END AS lifecycle_updated_at
                    FROM activity
                ), totals AS (
                    SELECT
                        count(*) FILTER (WHERE classification = 'NeedsAttention')::integer
                            AS needs_attention_count,
                        count(*) FILTER (WHERE classification = 'Active')::integer
                            AS active_count,
                        count(*) FILTER (WHERE classification = 'InvariantDefect')::integer
                            AS invariant_defect_count
                    FROM classified
                ), ordered AS (
                    SELECT classified.*, totals.*,
                        (totals.needs_attention_count + totals.active_count > :limit)
                            AS has_more
                    FROM classified
                    CROSS JOIN totals
                    WHERE classification <> 'Complete'
                    ORDER BY
                        CASE
                            WHEN classification = 'InvariantDefect' THEN 0
                            WHEN classification = 'NeedsAttention' THEN 1
                            ELSE 2
                        END,
                        CASE
                            WHEN classification = 'NeedsAttention' THEN lifecycle_updated_at
                        END ASC NULLS LAST,
                        CASE
                            WHEN classification = 'Active' THEN lifecycle_updated_at
                        END DESC NULLS LAST,
                        source_attempt_id DESC
                    LIMIT :limit
                )
                SELECT * FROM ordered
                """
            ),
            {"viewer_id": viewer_id, "limit": limit},
        )
        .mappings()
        .all()
    )


def _source_stage(row: RowMapping, media: MediaOut) -> ActivityStage:
    """Return the current or persisted source stage without inventing one."""
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


def _status_code(
    row: RowMapping,
    *,
    job_prefix: Literal["source_job", "index_job"],
) -> Absent | Present[str]:
    status = row[f"{job_prefix}_status"]
    error_code = row[f"{job_prefix}_error_code"]
    if error_code is None:
        return absent()
    if status in {"failed", "dead"}:
        return present(str(error_code))
    if status == "running" and error_code == WORKER_INTERRUPTED_CODE:
        return present(str(error_code))
    return absent()


def _queue_fields(
    row: RowMapping,
    *,
    job_prefix: Literal["source_job", "index_job"],
) -> tuple[int, int]:
    return (
        int(row[f"{job_prefix}_attempts"] or 0),
        int(row[f"{job_prefix}_max_attempts"] or 0),
    )


def _activity_item(row: RowMapping, media: MediaOut) -> MediaActivityItemOut:
    if row["source_job_id"] is not None and (
        row["source_job_kind"] != "ingest_media_source" or not row["source_job_exact"]
    ):
        raise AssertionError("source attempt points at a foreign queue operation")
    if int(row["exact_index_job_count"] or 0) > 1:
        raise AssertionError("multiple exact content-index jobs match one current revision")
    if row["classification"] == "InvariantDefect":
        raise AssertionError("failed content index state has no exact current repair operation")
    if row["classification"] == "Complete":
        raise AssertionError("complete Activity row crossed the classified query boundary")

    source_published = row["source_attempt_status"] in {"succeeded", "superseded"}
    index_dead = row["index_job_status"] == "dead"
    source_dead = row["source_job_status"] == "dead"
    attention = row["classification"] == "NeedsAttention"
    if attention:
        if index_dead and source_published:
            scope: Literal["Source", "Search"] = "Search"
            stage: ActivityStage = "Index"
            failure_code = row["index_job_error_code"]
        else:
            if source_published or not (source_dead or row["source_attempt_status"] == "failed"):
                raise AssertionError("classified source attention has no terminal source evidence")
            scope = "Source"
            stage = _source_stage(row, media)
            failure_code = row["source_job_error_code"] or row["source_attempt_error_code"]
        queue_prefix: Literal["source_job", "index_job"] = (
            "index_job" if scope == "Search" else "source_job"
        )
        queue_attempts, queue_max_attempts = _queue_fields(row, job_prefix=queue_prefix)
        state = MediaActivityNeedsAttentionStateOut(
            scope=scope,
            stage=stage,
            failure_code=(absent() if failure_code is None else present(str(failure_code))),
        )
    else:
        queue_prefix = "index_job" if source_published else "source_job"
        queue_attempts, queue_max_attempts = _queue_fields(row, job_prefix=queue_prefix)
        status: Literal["Queued", "Processing"] = (
            "Processing" if row[f"{queue_prefix}_status"] == "running" else "Queued"
        )
        stage = (
            "Index"
            if source_published
            else (
                "Validate"
                if row["source_job_id"] is None
                and row["source_attempt_status"] in {"accepted", "queued"}
                else _source_stage(row, media)
            )
        )
        state = MediaActivityActiveStateOut(
            status=status,
            stage=stage,
            waiting_reason=_waiting_reason(row, job_prefix=queue_prefix),
            progress=absent() if source_published else media.source_progress,
            status_code=_status_code(row, job_prefix=queue_prefix),
        )

    return MediaActivityItemOut(
        media_id=media.id,
        title=media.title,
        media_kind=cast(
            Literal["web_article", "epub", "pdf", "podcast_episode", "video"],
            media.kind,
        ),
        source_attempt_id=row["source_attempt_id"],
        state=state,
        request_id=absent() if row["request_id"] is None else present(str(row["request_id"])),
        run_count=int(row["run_count"]),
        queue_attempts=queue_attempts,
        queue_max_attempts=queue_max_attempts,
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
        return MediaActivityOut(
            needs_attention_count=0,
            active_count=0,
            has_more=False,
            items=[],
        )
    if int(rows[0]["invariant_defect_count"] or 0) > 0:
        raise AssertionError("Activity snapshot contains an invariant defect")
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
        raise AssertionError("Activity media hydration lost viewer-visible rows")
    items = [_activity_item(row, media[UUID(str(row["media_id"]))]) for row in rows]
    first = rows[0]
    return MediaActivityOut(
        needs_attention_count=int(first["needs_attention_count"]),
        active_count=int(first["active_count"]),
        has_more=bool(first["has_more"]),
        items=items,
    )
