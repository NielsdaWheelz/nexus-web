"""Client-defect ingest.

Logs one bounded browser failure report per request under the request's
``request_id`` (bound by the request-id middleware). No persistence, no service
layer.
"""

from typing import Annotated

from fastapi import APIRouter, Depends

from nexus.auth.middleware import Viewer, get_viewer
from nexus.logging import get_logger
from nexus.responses import success_response
from nexus.schemas.telemetry import ClientDefectRequest

router = APIRouter(tags=["telemetry"])

logger = get_logger(__name__)


@router.post("/telemetry/client-defects")
def post_client_defect(
    body: ClientDefectRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
) -> dict:
    """Log the first client failure with its originating command/read identity."""
    logger.error(
        "rum.client_defect",
        viewer_id=str(viewer.user_id),
        **body.model_dump(mode="json"),
    )
    return success_response({})
