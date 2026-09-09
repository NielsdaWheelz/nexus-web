"""Internal-only ingest recovery operator routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from nexus.db.session import get_db
from nexus.errors import ApiErrorCode, ConflictError
from nexus.responses import ok
from nexus.schemas.ingest import (
    IngestReconcileEnqueueOut,
    IngestRecoveryHealthOut,
    IngestRecoveryJobOut,
)
from nexus.services.capabilities import OperatorRecovery
from nexus.services.content_indexing import (
    current_search_repair_offer,
    repair_dead_media_reindex,
)
from nexus.services.ingest_recovery import (
    enqueue_stale_ingest_reconcile,
    get_ingest_recovery_health,
)
from nexus.services.media_source_ingest import (
    current_source_repair_offer,
    repair_dead_source_execution,
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
def retry_dead_content_index(
    media_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Requeue the dead reindex job of the media's current index revision."""
    offer = current_search_repair_offer(db, media_id=media_id)
    if offer is None:
        raise ConflictError(
            ApiErrorCode.E_REPAIR_NOT_ALLOWED, "Media has no dead content-index job to repair."
        )
    admission = repair_dead_media_reindex(
        db,
        actor=OperatorRecovery(),
        media_id=media_id,
        expected_revision=offer.expected_revision,
        expected_job_id=offer.expected_job_id,
    )
    return ok(IngestRecoveryJobOut(media_id=media_id, job_id=admission.job_id))


@router.post("/internal/ingest/source/{media_id}/retry-dead")
def retry_dead_source(
    media_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Requeue the dead job of the media's latest source attempt."""
    offer = current_source_repair_offer(db, media_id=media_id)
    if offer is None:
        raise ConflictError(
            ApiErrorCode.E_REPAIR_NOT_ALLOWED, "Media has no dead source job to repair."
        )
    admission = repair_dead_source_execution(
        db,
        actor=OperatorRecovery(),
        media_id=media_id,
        expected_attempt_id=offer.expected_attempt_id,
        expected_job_id=offer.expected_job_id,
    )
    return ok(IngestRecoveryJobOut(media_id=media_id, job_id=admission.job_id))
