"""Internal-only ingest recovery operator routes."""

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.errors import ApiError, ApiErrorCode
from nexus.responses import success_response
from nexus.schemas.ingest import IngestReconcileEnqueueOut, IngestRecoveryHealthOut
from nexus.services.ingest_recovery import (
    enqueue_stale_ingest_reconcile,
    get_stale_ingest_backlog_health,
)

router = APIRouter()


@router.post("/internal/ingest/reconcile")
def enqueue_reconcile_stale_ingest(
    request: Request,
) -> dict:
    """Enqueue stale-ingest reconciliation job (operator recovery endpoint)."""
    request_id = getattr(request.state, "request_id", None)
    enqueued = enqueue_stale_ingest_reconcile(request_id=request_id)
    if not enqueued:
        raise ApiError(
            ApiErrorCode.E_INTERNAL,
            "Failed to enqueue stale ingest reconciler.",
        )

    out = IngestReconcileEnqueueOut(
        task="reconcile_stale_ingest_media_job",
        enqueued=True,
    )
    return success_response(out.model_dump(mode="json"))


@router.get("/internal/ingest/reconcile/health")
def get_reconcile_stale_ingest_health(
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Return stale-ingest backlog health for operator monitoring."""
    out = IngestRecoveryHealthOut(**get_stale_ingest_backlog_health(db))
    return success_response(out.model_dump(mode="json"))
