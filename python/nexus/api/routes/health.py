"""Health check endpoints."""

from fastapi import APIRouter

from nexus.jobs.registry import get_task_contract_version
from nexus.responses import success_response

router = APIRouter()


@router.get("/health")
async def health_check() -> dict:
    """Liveness check endpoint.

    Returns 200 if the process is running.
    Does not check database or other dependencies.
    """
    return success_response(
        {
            "status": "ok",
            "task_contract_version": get_task_contract_version(),
        }
    )
