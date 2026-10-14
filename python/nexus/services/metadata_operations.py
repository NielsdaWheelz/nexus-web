"""Metadata activity: one setwise projection of durable jobs, no shadow state."""

from __future__ import annotations

import json
from collections import defaultdict
from collections.abc import Sequence
from typing import get_args
from uuid import UUID

from pydantic import TypeAdapter
from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session, defer

from nexus.auth.permissions import can_read_media
from nexus.db.models import LLMCall, Media
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.jobs.queue import JobRow
from nexus.schemas.metadata_enrichment import (
    MetadataCompletedOperation,
    MetadataEnrichmentView,
    MetadataFailedOperation,
    MetadataFailureCode,
    MetadataJobPayload,
    MetadataNoFindingsOperation,
    MetadataOperationOut,
    MetadataOutcome,
    MetadataPurpose,
    MetadataQueuedOperation,
    MetadataRecoveringOperation,
    MetadataRetry,
    MetadataRetryAllowed,
    MetadataRetryBlocked,
    MetadataRunningOperation,
    MetadataSelection,
    MetadataUnfinishedOperation,
    MetadataWaitingOperation,
)
from nexus.schemas.presence import Presence, Present, absent, presence_from_nullable, present
from nexus.services.generation.ledger import latest_job_generations
from nexus.services.media_processing_state import is_metadata_enrichment_eligible
from nexus.services.x_source import x_source_attempt_ids

_OUTCOME = TypeAdapter(MetadataOutcome)
_JOB_PAYLOAD = TypeAdapter(MetadataJobPayload)
_FAILURE_CODE = TypeAdapter(MetadataFailureCode)
_FAILURE_CODES: dict[str, MetadataFailureCode] = {
    **{f"E_METADATA_{code.upper()}": code for code in get_args(MetadataFailureCode.__value__)},
    "E_GENERATION_AUTH": "authentication_failed",
    "E_GENERATION_QUOTA": "quota_unavailable",
    "E_GENERATION_TIMEOUT": "research_timeout",
    "E_GENERATION_OUTPUT_LIMIT": "output_limit",
    "E_GENERATION_INVALID_OUTPUT": "invalid_output",
    "E_GENERATION_POLICY_VIOLATION": "policy_violation",
    "E_GENERATION_RUNTIME_UNAVAILABLE": "model_unavailable",
    "E_GENERATION_CONTEXT_TOO_LARGE": "input_too_large",
    "E_GENERATION_CANCELLED": "cancelled",
    "E_GENERATION_SOURCE_CHANGED": "stale_input",
    "E_WORKER_INTERRUPTED": "worker_interrupted",
    "E_WORKER_LEASE_EXPIRED": "worker_interrupted",
}


def metadata_operations_sql() -> str:
    """Per-job domain facts for authorized query composition; binds ``viewer_id``.

    Imports owns population, latest selection and filtering. This owner alone
    translates queue state and settled outcomes, using the caller's snapshot time.
    ``failure_code`` is the closed metadata vocabulary, never raw exception text.
    """
    queue_reason = (
        "CASE error_code "
        + " ".join(f"WHEN '{raw}' THEN '{safe}'" for raw, safe in _FAILURE_CODES.items())
        + " ELSE 'execution_failed' END"
    )
    return f"""
        SELECT projected.*,
            status IN ('pending', 'running', 'failed') AS is_unfinished,
            effective_status = 'failed'
                OR (effective_status = 'no_findings' AND reviewed_at IS NULL)
                AS needs_attention,
            CASE WHEN effective_status = 'failed' THEN
                CASE WHEN result ? 'completed_at' THEN result->>'reason'
                     ELSE {queue_reason} END
            END AS failure_code,
            COALESCE(completed_at, created_at) AS occurred_at,
            GREATEST(updated_at, reviewed_at) AS lifecycle_updated_at
        FROM (
            SELECT job.*, job.id AS job_id, (job.payload->>'media_id')::uuid AS media_id,
                review.reviewed_at,
                CASE
                    WHEN job.status IN ('succeeded', 'dead') AND job.result ? 'completed_at'
                        THEN job.result->>'status'
                    WHEN job.status = 'running' AND job.lease_expires_at > now() THEN 'running'
                    WHEN job.status = 'dead' THEN 'failed'
                    WHEN job.status = 'failed'
                      OR (job.status = 'pending' AND job.available_at > now()) THEN 'waiting'
                    WHEN job.status = 'running' THEN 'recovering'
                    WHEN job.status = 'pending' THEN 'queued'
                END AS effective_status,
                CASE WHEN job.status IN ('succeeded', 'dead') THEN
                    COALESCE((job.result->>'completed_at')::timestamptz, job.finished_at)
                END AS completed_at
            FROM background_jobs job
            LEFT JOIN metadata_result_reviews review
              ON review.job_id = job.id AND review.viewer_id = :viewer_id
            WHERE job.kind = 'enrich_metadata'
        ) projected
    """


def metadata_purpose(media: Media) -> MetadataPurpose:
    return "title" if media.provider == "x" and media.kind == "web_article" else "bibliography"


def metadata_retry(
    db: Session, *, media: Media, viewer_id: UUID, jobs: Sequence[JobRow]
) -> MetadataRetry:
    """Admission and snapshots share the creator, eligibility and active-work barrier."""
    latest = max(jobs, key=lambda job: (job.created_at, job.id), default=None)
    return _retry(
        media=media,
        viewer_id=viewer_id,
        unfinished_count=sum(job.status in {"pending", "running", "failed"} for job in jobs),
        latest_job_id=present(latest.id) if latest else absent(),
        has_source_context=media.id in x_source_attempt_ids(db, media_ids=[media.id])
        if metadata_purpose(media) == "title"
        else False,
    )


def _retry(
    *,
    media: Media,
    viewer_id: UUID,
    unfinished_count: int,
    latest_job_id: Presence[UUID],
    has_source_context: bool,
) -> MetadataRetry:
    purpose = metadata_purpose(media)
    if media.created_by_user_id != viewer_id:
        return MetadataRetryBlocked(purpose=purpose, reason="not_creator")
    if not is_metadata_enrichment_eligible(
        kind=media.kind, processing_status=media.processing_status
    ):
        return MetadataRetryBlocked(purpose=purpose, reason="not_eligible")
    if unfinished_count:
        return MetadataRetryBlocked(purpose=purpose, reason="active")
    if purpose == "title" and not has_source_context:
        return MetadataRetryBlocked(purpose=purpose, reason="source_context_missing")
    return MetadataRetryAllowed(purpose=purpose, expected_job_id=latest_job_id)


def metadata_enrichment_views(
    db: Session, *, viewer_id: UUID, media: Sequence[Media]
) -> dict[UUID, MetadataEnrichmentView]:
    """Latest and oldest unfinished operations in one caller-owned read snapshot.

    Only those representatives cross the query boundary; retained history is
    counted setwise, not loaded into each media detail or collection row.
    """
    if not media:
        return {}
    source_attempts = x_source_attempt_ids(
        db, media_ids=[item.id for item in media if metadata_purpose(item) == "title"]
    )
    rows = (
        db.execute(
            text(f"""
            WITH operations AS ({metadata_operations_sql()}), ranked AS (
                SELECT operations.*,
                    row_number() OVER (
                        PARTITION BY media_id ORDER BY created_at DESC, id DESC
                    ) AS latest_position,
                    count(*) FILTER (WHERE is_unfinished) OVER (
                        PARTITION BY media_id
                    )::integer AS unfinished_count,
                    row_number() OVER (
                        PARTITION BY media_id, is_unfinished ORDER BY created_at, id
                    ) AS unfinished_position
                FROM operations WHERE media_id = ANY(:media_ids)
            )
            SELECT * FROM ranked
            WHERE latest_position = 1 OR (is_unfinished AND unfinished_position = 1)
        """),
            {"viewer_id": viewer_id, "media_ids": [item.id for item in media]},
        )
        .mappings()
        .all()
    )
    operations = _decode_operations(db, rows)
    by_media: dict[UUID, list[RowMapping]] = defaultdict(list)
    for row in rows:
        by_media[row["media_id"]].append(row)
    views: dict[UUID, MetadataEnrichmentView] = {}
    for item in media:
        operation: Presence[MetadataOperationOut] = absent()
        unfinished: Presence[MetadataUnfinishedOperation] = absent()
        unfinished_count = 0
        latest_job_id: Presence[UUID] = absent()
        for row in by_media[item.id]:
            decoded = operations[row["job_id"]]
            unfinished_count = row["unfinished_count"]
            if row["latest_position"] == 1:
                operation = Present[MetadataOperationOut](value=decoded)
                latest_job_id = present(row["job_id"])
            if row["is_unfinished"] and row["unfinished_position"] == 1:
                match decoded:
                    case (
                        MetadataQueuedOperation()
                        | MetadataRunningOperation()
                        | MetadataRecoveringOperation()
                        | MetadataWaitingOperation()
                    ):
                        unfinished = Present[MetadataUnfinishedOperation](value=decoded)
                    case _:
                        # justify-defect: queue unfinished facts and this owner's
                        # decoder must describe the same operation.
                        raise AssertionError("unfinished metadata job decoded as terminal")
        views[item.id] = MetadataEnrichmentView(
            operation=operation,
            unfinished_count=unfinished_count,
            unfinished_operation=unfinished,
            retry=_retry(
                media=item,
                viewer_id=viewer_id,
                unfinished_count=unfinished_count,
                latest_job_id=latest_job_id,
                has_source_context=item.id in source_attempts,
            ),
            last_enriched_at=presence_from_nullable(item.metadata_enriched_at),
        )
    return views


def metadata_operations_for_jobs(
    db: Session, *, viewer_id: UUID, job_ids: Sequence[UUID]
) -> dict[UUID, MetadataOperationOut]:
    """Batch exact operations for an already-authorized history page or command."""
    if not job_ids:
        return {}
    rows = (
        db.execute(
            text(
                f"SELECT * FROM ({metadata_operations_sql()}) operations WHERE job_id = ANY(:job_ids)"
            ),
            {"viewer_id": viewer_id, "job_ids": list(job_ids)},
        )
        .mappings()
        .all()
    )
    return _decode_operations(db, rows)


def metadata_enrichment_for_viewer(
    db: Session, *, viewer_id: UUID, media_id: UUID
) -> MetadataEnrichmentView:
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "media not found")
    item = db.get(Media, media_id, options=(defer(Media.plain_text),))
    if item is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "media not found")
    return metadata_enrichment_views(db, viewer_id=viewer_id, media=[item])[media_id]


def _decode_operations(db: Session, rows: Sequence[RowMapping]) -> dict[UUID, MetadataOperationOut]:
    calls = latest_job_generations(
        db, kind="media_enrichment", job_ids=[row["job_id"] for row in rows]
    )
    return {row["job_id"]: _operation(row, calls.get(row["job_id"])) for row in rows}


def _operation(row: RowMapping, call: LLMCall | None) -> MetadataOperationOut:
    payload = _JOB_PAYLOAD.validate_json(json.dumps(row["payload"]))
    selection: Presence[MetadataSelection] = absent()
    if call is not None:
        selected = call.generation_spec["selection"]
        assert isinstance(selected, dict)
        selection = Present[MetadataSelection](
            value=MetadataSelection(
                provider="codex", model=str(selected["model"]), reasoning=str(selected["reasoning"])
            )
        )
    common = {
        "job_id": row["job_id"],
        "created_at": row["created_at"],
        "started_at": presence_from_nullable(row["started_at"]),
        "generation_id": presence_from_nullable(call.id if call else None),
        "selection": selection,
        "purpose": payload.purpose,
    }
    # Validate the immutable durable outcome as well as projecting its state.
    if row["status"] in {"succeeded", "dead"} and row["result"] and "completed_at" in row["result"]:
        outcome = _OUTCOME.validate_json(json.dumps(row["result"]))
        # justify-defect: a retained outcome belongs to its job's frozen purpose.
        if outcome.purpose != payload.purpose:
            raise AssertionError("metadata outcome purpose differs from its job")
        match outcome.status:
            case "completed":
                return MetadataCompletedOperation(**common, outcome=outcome)
            case "no_findings":
                return MetadataNoFindingsOperation(
                    **common,
                    completed_at=outcome.completed_at,
                    reviewed_at=presence_from_nullable(row["reviewed_at"]),
                )
            case "failed":
                return MetadataFailedOperation(
                    **common, completed_at=outcome.completed_at, code=outcome.reason
                )
    match row["effective_status"]:
        case "running":
            return MetadataRunningOperation(**common)
        case "failed":
            if row["completed_at"] is None:
                # justify-defect: the queue always stamps a terminal job.
                raise AssertionError("dead metadata job requires finished_at")
            return MetadataFailedOperation(
                **common,
                completed_at=row["completed_at"],
                code=_FAILURE_CODE.validate_python(row["failure_code"]),
            )
        case "waiting":
            return MetadataWaitingOperation(
                **common, reason="retry", until=present(row["available_at"])
            )
        case "recovering":
            return MetadataRecoveringOperation(**common)
        case "queued":
            return MetadataQueuedOperation(**common)
        case _:
            # justify-defect: settled metadata must carry its published outcome;
            # other queue states are exhaustively projected above.
            raise AssertionError("metadata job has no valid operation state")
