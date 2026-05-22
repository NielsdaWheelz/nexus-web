"""Internal-only library operator routes.

These routes are NOT exposed through the public BFF proxy.
They use the same internal-header auth enforced by AuthMiddleware.
"""

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.responses import success_response
from nexus.schemas.library import (
    DefaultLibraryBackfillJobOut,
    RequeueDefaultLibraryBackfillJobRequest,
)
from nexus.services.default_library_closure import requeue_backfill_job

router = APIRouter()


@router.post("/internal/libraries/backfill-jobs/requeue")
def requeue_backfill_job_endpoint(
    body: RequeueDefaultLibraryBackfillJobRequest,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Requeue a failed/completed/pending backfill job (operator recovery).

    Internal-only: no public BFF proxy route.
    Auth: existing internal-header middleware policy.
    """
    result = requeue_backfill_job(
        db,
        body.default_library_id,
        body.source_library_id,
        body.user_id,
    )
    out = DefaultLibraryBackfillJobOut.model_validate(result)
    return success_response(out.model_dump(mode="json"))
