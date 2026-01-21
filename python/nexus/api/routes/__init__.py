"""API route definitions."""

from fastapi import APIRouter

from nexus.api.routes.health import router as health_router

# Aggregate all routers
api_router = APIRouter()
api_router.include_router(health_router, tags=["health"])

__all__ = ["api_router"]
