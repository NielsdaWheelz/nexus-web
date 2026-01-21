"""API route definitions."""

from fastapi import APIRouter

from nexus.api.routes.health import router as health_router
from nexus.api.routes.me import router as me_router

# Aggregate all routers
api_router = APIRouter()
api_router.include_router(health_router, tags=["health"])
api_router.include_router(me_router, tags=["user"])

__all__ = ["api_router"]
