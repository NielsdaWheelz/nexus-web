"""Schemas for ingest recovery operator endpoints."""

from uuid import UUID

from pydantic import BaseModel

from nexus.schemas.presence import Presence


class IngestReconcileEnqueueOut(BaseModel):
    """Response payload for reconcile enqueue operation."""

    task: str
    enqueued: bool


class IngestRecoveryHealthOut(BaseModel):
    """Operator-facing stale-ingest health snapshot."""

    stale_source_attempt_count: int
    oldest_stale_source_attempt_age_seconds: Presence[int]
    fresh_pending_content_index_count: int
    stale_content_index_count: int
    suspended_source_job_count: int
    suspended_content_index_job_count: int
    oldest_due_interactive_job_age_seconds: Presence[int]
    oldest_due_background_job_age_seconds: Presence[int]
    latest_reconciler_age_seconds: Presence[int]
    latest_reconciler_succeeded: bool
    stale_threshold_seconds: int
    degraded: bool


class IngestRecoveryJobOut(BaseModel):
    media_id: UUID
    job_id: UUID
