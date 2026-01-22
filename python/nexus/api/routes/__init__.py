"""API route definitions.

Uses a factory pattern to avoid import-time settings loading.
This allows tests to import modules without requiring all environment
variables to be configured upfront.
"""

from fastapi import APIRouter

from nexus.api.routes.health import router as health_router
from nexus.api.routes.libraries import router as libraries_router
from nexus.api.routes.me import router as me_router
from nexus.api.routes.media import router as media_router


def create_api_router(include_test_routes: bool = False) -> APIRouter:
    """Create and configure the API router.

    Args:
        include_test_routes: If True, include test-only routes (for test environment).

    Returns:
        Configured APIRouter with all routes registered.
    """
    api_router = APIRouter()
    api_router.include_router(health_router, tags=["health"])
    api_router.include_router(me_router, tags=["user"])
    api_router.include_router(libraries_router, tags=["libraries"])
    api_router.include_router(media_router, tags=["media"])

    if include_test_routes:
        from nexus.api.routes.test import router as test_router

        api_router.include_router(test_router, tags=["test"])

    return api_router


__all__ = ["create_api_router"]
