"""Internal-only ingest recovery operator routes."""

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from nexus.db.session import get_db
from nexus.responses import ok
from nexus.schemas.ingest import IngestReconcileEnqueueOut, IngestRecoveryHealthOut
from nexus.services.ingest_recovery import (
    enqueue_stale_ingest_reconcile,
    get_stale_ingest_backlog_health,
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
    out = IngestRecoveryHealthOut(**get_stale_ingest_backlog_health(db))
    return ok(out)
