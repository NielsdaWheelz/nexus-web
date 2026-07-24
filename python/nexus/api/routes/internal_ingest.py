"""Internal-only ingest recovery operator routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from nexus.db.session import get_db
from nexus.responses import ok
from nexus.schemas.ingest import (
    IngestReconcileEnqueueOut,
    IngestRecoveryHealthOut,
    IngestRecoveryJobOut,
)
from nexus.services.ingest_recovery import (
    enqueue_stale_ingest_reconcile,
    get_ingest_recovery_health,
    repair_legacy_failed_content_index,
    retry_dead_content_index_job,
    retry_dead_source_job,
)

router = APIRouter(tags=["internal"])


@router.post("/internal/ingest/reconcile")
def enqueue_reconcile_stale_ingest(
    request: Request,
) -> dict:
    """Enqueue stale-ingest reconciliation job (operator recovery endpoint)."""
    request_id = getattr(request.state, "request_id", None)
    enqueue_stale_ingest_reconcile(request_id=request_id)
    out = IngestReconcileEnqueueOut(
        task="reconcile_stale_ingest_media_job",
        enqueued=True,
    )
    return ok(out)


@router.get("/internal/ingest/reconcile/health")
def get_reconcile_stale_ingest_health(
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Return stale-ingest backlog health for operator monitoring."""
    out = IngestRecoveryHealthOut(**get_ingest_recovery_health(db))
    return ok(out)


@router.post("/internal/ingest/content-index/{media_id}/retry-dead")
def retry_dead_content_index(media_id: UUID) -> dict:
    job_id = retry_dead_content_index_job(media_id=media_id)
    return ok(IngestRecoveryJobOut(media_id=media_id, job_id=job_id))


@router.post("/internal/ingest/source/{media_id}/retry-dead")
def retry_dead_source(media_id: UUID) -> dict:
    job_id = retry_dead_source_job(media_id=media_id)
    return ok(IngestRecoveryJobOut(media_id=media_id, job_id=job_id))


@router.post("/internal/ingest/content-index/{media_id}/repair")
def repair_failed_content_index(media_id: UUID, request: Request) -> dict:
    job_id = repair_legacy_failed_content_index(
        media_id=media_id,
        request_id=getattr(request.state, "request_id", None),
    )
    return ok(IngestRecoveryJobOut(media_id=media_id, job_id=job_id))
