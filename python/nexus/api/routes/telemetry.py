"""Telemetry ingest endpoints.

Receives browser-emitted observability samples and logs them via structlog.
This is pure telemetry ingest: no persistence, no service layer. Each sample is
logged under the request's ``request_id`` (bound by the request-id middleware),
so front-paint vitals can be joined to the backend fetch latencies that drive them.
"""

from typing import Annotated

from fastapi import APIRouter, Depends

from nexus.auth.middleware import Viewer, get_viewer
from nexus.logging import get_logger
from nexus.responses import success_response
from nexus.schemas.telemetry import WebVitalRequest

router = APIRouter(tags=["telemetry"])

logger = get_logger(__name__)


@router.post("/telemetry/web-vitals")
def post_web_vital(
    body: WebVitalRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
) -> dict:
    """Record one Core Web Vital sample as a ``rum.web_vital`` structlog line."""
    logger.info(
        "rum.web_vital",
        name=body.name,
        value=body.value,
        rating=body.rating,
        metric_id=body.id,
        href=body.href,
        nav_id=body.nav_id,
    )
    return success_response({})
