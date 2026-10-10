"""Metadata activity: one batched projection of durable jobs, no shadow state."""

from __future__ import annotations

import json
from collections import defaultdict
from collections.abc import Sequence
from datetime import datetime
from typing import get_args
from uuid import UUID

from pydantic import TypeAdapter
from sqlalchemy import text
from sqlalchemy.orm import Session, defer

from nexus.auth.permissions import can_read_media
from nexus.db.models import LLMCall, Media
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.jobs.queue import JobRow, list_jobs_for_payload_values
from nexus.schemas.metadata_enrichment import (
    MetadataCompletedOperation,
    MetadataEnrichmentView,
    MetadataFailedOperation,
    MetadataFailureCode,
    MetadataNoFindingsOperation,
    MetadataOperationOut,
    MetadataOutcome,
    MetadataQueuedOperation,
    MetadataRecoveringOperation,
    MetadataRetry,
    MetadataRetryAllowed,
    MetadataRetryBlocked,
    MetadataRunningOperation,
    MetadataSelection,
    MetadataWaitingOperation,
)
from nexus.schemas.presence import Presence, Present, absent, presence_from_nullable
from nexus.services.generation.ledger import latest_generations
from nexus.services.media_processing_state import is_metadata_enrichment_eligible

_OUTCOME = TypeAdapter(MetadataOutcome)
_FAILURE_CODES: dict[str, MetadataFailureCode] = {
    f"E_METADATA_{code.upper()}": code for code in get_args(MetadataFailureCode.__value__)
}


def metadata_failure_code(error_code: str | None) -> MetadataFailureCode:
    """Map operational codes to the closed, secret-free metadata vocabulary."""
    if error_code in _FAILURE_CODES:
        return _FAILURE_CODES[error_code]
    mapping: dict[str, MetadataFailureCode] = {
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
    return mapping.get(error_code or "", "execution_failed")


def metadata_retry(*, media: Media, viewer_id: UUID, jobs: Sequence[JobRow]) -> MetadataRetry:
    if media.created_by_user_id != viewer_id:
        return MetadataRetryBlocked(reason="not_creator")
    if not is_metadata_enrichment_eligible(
        kind=media.kind, processing_status=media.processing_status
    ):
        return MetadataRetryBlocked(reason="not_eligible")
    if any(job.status in {"pending", "running", "failed"} for job in jobs):
        return MetadataRetryBlocked(reason="active")
    latest = max(jobs, key=lambda job: (job.created_at, job.id), default=None)
    return MetadataRetryAllowed(
        expected_job_id=presence_from_nullable(latest.id if latest else None)
    )


def metadata_enrichment_views(
    db: Session, *, viewer_id: UUID, media: Sequence[Media]
) -> dict[UUID, MetadataEnrichmentView]:
    """Project already-authorized media in one caller-owned read snapshot."""
    if not media:
        return {}
    jobs = list_jobs_for_payload_values(
        db, kind="enrich_metadata", payload_key="media_id", values=[str(item.id) for item in media]
    )
    jobs_by_media: dict[UUID, list[JobRow]] = defaultdict(list)
    for job in jobs:
        jobs_by_media[UUID(job.payload["media_id"])].append(job)
    newest = {
        media_id: max(media_jobs, key=lambda job: (job.created_at, job.id))
        for media_id, media_jobs in jobs_by_media.items()
    }
    # Each media's newest generation that its newest job opened.
    calls = latest_generations(
        db,
        kind="media_enrichment",
        ids=list(newest),
        job_ids=[job.id for job in newest.values()],
    )
    now = db.scalar(text("SELECT clock_timestamp()"))
    views: dict[UUID, MetadataEnrichmentView] = {}
    for item in media:
        latest = newest.get(item.id)
        operation: Presence[MetadataOperationOut] = absent()
        if latest is not None:
            operation = Present[MetadataOperationOut](
                value=_operation(latest, calls.get(item.id), now)
            )
        views[item.id] = MetadataEnrichmentView(
            operation=operation,
            retry=metadata_retry(media=item, viewer_id=viewer_id, jobs=jobs_by_media[item.id]),
            last_enriched_at=presence_from_nullable(item.metadata_enriched_at),
        )
    return views


def metadata_enrichment_for_viewer(
    db: Session, *, viewer_id: UUID, media_id: UUID
) -> MetadataEnrichmentView:
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "media not found")
    item = db.get(Media, media_id, options=(defer(Media.plain_text),))
    if item is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "media not found")
    return metadata_enrichment_views(db, viewer_id=viewer_id, media=[item])[media_id]


def _operation(job: JobRow, call: LLMCall | None, now: datetime) -> MetadataOperationOut:
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
        "job_id": job.id,
        "created_at": job.created_at,
        "started_at": presence_from_nullable(job.started_at),
        "generation_id": presence_from_nullable(call.id if call else None),
        "selection": selection,
    }
    # The queue stores the settled outcome as the job's result.
    if job.status in {"succeeded", "dead"} and job.result and "completed_at" in job.result:
        outcome = _OUTCOME.validate_json(json.dumps(job.result))
        match outcome.status:
            case "completed":
                return MetadataCompletedOperation(**common, outcome=outcome)
            case "no_findings":
                return MetadataNoFindingsOperation(**common, completed_at=outcome.completed_at)
            case "failed":
                return MetadataFailedOperation(
                    **common, completed_at=outcome.completed_at, code=outcome.reason
                )
    if job.status == "running" and job.lease_expires_at is not None and job.lease_expires_at > now:
        return MetadataRunningOperation(**common)
    if job.status == "dead":
        if job.finished_at is None:
            raise AssertionError("dead metadata job requires finished_at")
        return MetadataFailedOperation(
            **common, completed_at=job.finished_at, code=metadata_failure_code(job.error_code)
        )
    if job.status == "failed" or (job.status == "pending" and job.available_at > now):
        return MetadataWaitingOperation(
            **common, reason="retry", until=Present(value=job.available_at)
        )
    if job.status == "running":
        return MetadataRecoveringOperation(**common)
    if job.status == "succeeded":
        raise AssertionError("successful metadata job must contain a published outcome")
    return MetadataQueuedOperation(**common)
