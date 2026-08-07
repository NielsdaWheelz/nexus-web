"""Public operational liveness, readiness, and release-identity endpoints."""

from fastapi import APIRouter, Response
from fastapi.responses import JSONResponse

from nexus.config import get_settings
from nexus.jobs.registry import get_task_contract_digest
from nexus.responses import success_response
from nexus.runtime_health import get_runtime_identity, is_database_ready

router = APIRouter(tags=["operations"])
NO_STORE_HEADERS = {"Cache-Control": "no-store"}


@router.get("/livez")
async def get_liveness(response: Response) -> dict:
    """Prove only that this API process can serve a request."""
    response.headers.update(NO_STORE_HEADERS)
    return success_response({"status": "alive"})


@router.get("/readyz", response_model=None)
def get_readiness(response: Response) -> dict | JSONResponse:
    """Prove bounded database reachability and exact schema identity."""
    identity = get_runtime_identity()
    settings = get_settings()
    if not is_database_ready(
        database_url=settings.database_url,
        expected_revision=identity.expected_database_revision,
    ):
        return JSONResponse(
            status_code=503,
            content=success_response({"status": "unavailable"}),
            headers=NO_STORE_HEADERS,
        )
    response.headers.update(NO_STORE_HEADERS)
    return success_response({"status": "ready"})


@router.get("/version")
async def get_version(response: Response) -> dict:
    """Return only the immutable, image-baked release contract."""
    identity = get_runtime_identity()
    response.headers.update(NO_STORE_HEADERS)
    return success_response(
        {
            **identity.as_json(),
            "task_contract_digest": get_task_contract_digest(),
        }
    )
