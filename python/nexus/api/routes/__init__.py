"""API route definitions.

Uses a factory pattern to avoid import-time settings loading.
This allows tests to import modules without requiring all environment
variables to be configured upfront.
"""

from fastapi import APIRouter

from nexus.api.routes.billing import router as billing_router
from nexus.api.routes.browse import router as browse_router
from nexus.api.routes.chat_runs import router as chat_runs_router
from nexus.api.routes.contributors import router as contributors_router
from nexus.api.routes.conversations import router as conversations_router
from nexus.api.routes.extension_sessions import router as extension_sessions_router
from nexus.api.routes.health import router as health_router
from nexus.api.routes.highlights import router as highlights_router
from nexus.api.routes.internal_ingest import router as internal_ingest_router
from nexus.api.routes.internal_libraries import router as internal_libraries_router
from nexus.api.routes.keys import router as keys_router
from nexus.api.routes.libraries import router as libraries_router
from nexus.api.routes.library_intelligence import router as library_intelligence_router
from nexus.api.routes.me import router as me_router
from nexus.api.routes.media import router as media_router
from nexus.api.routes.message_context_items import router as message_context_items_router
from nexus.api.routes.models import router as models_router
from nexus.api.routes.notes import router as notes_router
from nexus.api.routes.object_links import router as object_links_router
from nexus.api.routes.object_refs import router as object_refs_router
from nexus.api.routes.oracle import router as oracle_router
from nexus.api.routes.playback import router as playback_router
from nexus.api.routes.podcasts import router as podcasts_router
from nexus.api.routes.search import router as search_router
from nexus.api.routes.users import router as users_router
from nexus.api.routes.vault import router as vault_router
from nexus.config import get_settings


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
    api_router.include_router(extension_sessions_router, tags=["auth"])
    api_router.include_router(libraries_router, tags=["libraries"])
    api_router.include_router(library_intelligence_router, tags=["library-intelligence"])
    api_router.include_router(media_router, tags=["media"])
    api_router.include_router(notes_router, tags=["notes"])
    api_router.include_router(object_refs_router, tags=["object-refs"])
    api_router.include_router(object_links_router, tags=["object-links"])
    api_router.include_router(message_context_items_router, tags=["message-context-items"])
    api_router.include_router(highlights_router, tags=["highlights"])
    api_router.include_router(billing_router, tags=["billing"])
    api_router.include_router(conversations_router, tags=["conversations"])
    api_router.include_router(contributors_router, tags=["contributors"])
    api_router.include_router(chat_runs_router, tags=["chat-runs"])
    api_router.include_router(oracle_router, tags=["oracle"])
    api_router.include_router(models_router, tags=["models"])
    api_router.include_router(keys_router, tags=["keys"])
    api_router.include_router(browse_router, tags=["browse"])
    api_router.include_router(search_router, tags=["search"])
    api_router.include_router(vault_router, tags=["vault"])
    api_router.include_router(users_router, tags=["users"])
    settings = get_settings()
    if settings.podcasts_enabled:
        api_router.include_router(playback_router, tags=["playback"])
        api_router.include_router(podcasts_router, tags=["podcasts"])
    api_router.include_router(internal_libraries_router, tags=["internal"])
    api_router.include_router(internal_ingest_router, tags=["internal"])

    if include_test_routes:
        from nexus.api.routes.test import router as test_router

        api_router.include_router(test_router, tags=["test"])

    return api_router


__all__ = ["create_api_router"]
