"""Health check endpoints."""

from fastapi import APIRouter

from nexus.responses import success_response

router = APIRouter()


@router.get("/health")
async def health_check() -> dict:
    """Liveness check endpoint.

    Returns 200 if the process is running.
    Does not check database or other dependencies.
    """
    return success_response({"status": "ok"})
