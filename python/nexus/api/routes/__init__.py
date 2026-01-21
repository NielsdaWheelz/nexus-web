"""API route definitions."""

from fastapi import APIRouter

from nexus.api.routes.health import router as health_router
from nexus.api.routes.libraries import router as libraries_router
from nexus.api.routes.me import router as me_router
from nexus.api.routes.media import router as media_router
from nexus.config import Environment, get_settings

# Aggregate all routers
api_router = APIRouter()
api_router.include_router(health_router, tags=["health"])
api_router.include_router(me_router, tags=["user"])
api_router.include_router(libraries_router, tags=["libraries"])
api_router.include_router(media_router, tags=["media"])

# Include test routes only in test environment
settings = get_settings()
if settings.nexus_env == Environment.TEST:
    from nexus.api.routes.test import router as test_router

    api_router.include_router(test_router, tags=["test"])

__all__ = ["api_router"]
