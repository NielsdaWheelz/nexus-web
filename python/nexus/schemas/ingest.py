"""Schemas for ingest recovery operator endpoints."""

from pydantic import BaseModel


class IngestReconcileEnqueueOut(BaseModel):
    """Response payload for reconcile enqueue operation."""

    task: str
    enqueued: bool


class IngestRecoveryHealthOut(BaseModel):
    """Operator-facing stale-ingest health snapshot."""

    stale_count: int
    oldest_stale_age_seconds: int | None
    stale_threshold_seconds: int
    degraded: bool
