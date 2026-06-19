"""API route definitions.

Uses a factory pattern to avoid import-time settings loading.
This allows tests to import modules without requiring all environment
variables to be configured upfront.
"""

from fastapi import APIRouter

from nexus.api.routes.auth_handoff_codes import router as auth_handoff_codes_router
from nexus.api.routes.billing import router as billing_router
from nexus.api.routes.browse import router as browse_router
from nexus.api.routes.chat_runs import router as chat_runs_router
from nexus.api.routes.contributors import router as contributors_router
from nexus.api.routes.conversation_branches import router as conversation_branches_router
from nexus.api.routes.conversation_context import router as conversation_context_router
from nexus.api.routes.conversation_shares import router as conversation_shares_router
from nexus.api.routes.conversations import router as conversations_router
from nexus.api.routes.extension_sessions import router as extension_sessions_router
from nexus.api.routes.health import router as health_router
from nexus.api.routes.highlights import router as highlights_router
from nexus.api.routes.internal_ingest import router as internal_ingest_router
from nexus.api.routes.internal_libraries import router as internal_libraries_router
from nexus.api.routes.keys import router as keys_router
from nexus.api.routes.libraries import router as libraries_router
from nexus.api.routes.library_intelligence import router as library_intelligence_router
from nexus.api.routes.listening_state import router as listening_state_router
from nexus.api.routes.me import router as me_router
from nexus.api.routes.media import router as media_router
from nexus.api.routes.media_assets import router as media_assets_router
from nexus.api.routes.media_ingest import router as media_ingest_router
from nexus.api.routes.messages import router as messages_router
from nexus.api.routes.models import router as models_router
from nexus.api.routes.notes import router as notes_router
from nexus.api.routes.object_refs import router as object_refs_router
from nexus.api.routes.oracle import router as oracle_router
from nexus.api.routes.pinned_objects import router as pinned_objects_router
from nexus.api.routes.playback import router as playback_router
from nexus.api.routes.podcast_transcripts import router as podcast_transcripts_router
from nexus.api.routes.podcasts import router as podcasts_router
from nexus.api.routes.reader import router as reader_router
from nexus.api.routes.resource_graph import router as resource_graph_router
from nexus.api.routes.resource_items import router as resource_items_router
from nexus.api.routes.search import router as search_router
from nexus.api.routes.stream import router as stream_router
from nexus.api.routes.stream_tokens import router as stream_tokens_router
from nexus.api.routes.synapse import router as synapse_router
from nexus.api.routes.telemetry import router as telemetry_router
from nexus.api.routes.users import router as users_router
from nexus.api.routes.vault import router as vault_router
from nexus.api.routes.web_search import router as web_search_router
from nexus.config import get_settings


def create_api_router() -> APIRouter:
    """Create and configure the API router.

    Returns:
        Configured APIRouter with all routes registered.
    """
    api_router = APIRouter()
    api_router.include_router(health_router)
    api_router.include_router(me_router)
    api_router.include_router(telemetry_router)
    api_router.include_router(extension_sessions_router)
    api_router.include_router(auth_handoff_codes_router)
    api_router.include_router(libraries_router)
    api_router.include_router(library_intelligence_router)
    # Media family. Every router owning a static `/media/<literal>` path
    # (media_assets, media_ingest, listening_state, podcast_transcripts) must be
    # registered before the `media` router that owns `/media/{media_id}` —
    # Starlette matches in registration order, so a misorder would parse e.g.
    # "image" as a UUID and 422. Tags are self-declared on each router.
    api_router.include_router(media_assets_router)
    api_router.include_router(media_ingest_router)
    api_router.include_router(listening_state_router)
    api_router.include_router(podcast_transcripts_router)
    api_router.include_router(reader_router)
    api_router.include_router(media_router)
    api_router.include_router(notes_router)
    api_router.include_router(object_refs_router)
    api_router.include_router(pinned_objects_router)
    api_router.include_router(resource_items_router)
    api_router.include_router(resource_graph_router)
    api_router.include_router(synapse_router)
    api_router.include_router(highlights_router)
    api_router.include_router(billing_router)
    api_router.include_router(conversations_router)
    api_router.include_router(conversation_context_router)
    api_router.include_router(conversation_branches_router)
    api_router.include_router(conversation_shares_router)
    api_router.include_router(messages_router)
    api_router.include_router(contributors_router)
    api_router.include_router(chat_runs_router)
    api_router.include_router(oracle_router)
    api_router.include_router(models_router)
    api_router.include_router(keys_router)
    api_router.include_router(browse_router)
    api_router.include_router(search_router)
    api_router.include_router(web_search_router)
    api_router.include_router(vault_router)
    api_router.include_router(users_router)
    settings = get_settings()
    if settings.podcasts_enabled:
        api_router.include_router(playback_router)
        api_router.include_router(podcasts_router)
    api_router.include_router(internal_libraries_router)
    api_router.include_router(internal_ingest_router)

    # Browser-callable SSE event streams (all under /stream/) + the BFF
    # stream-token mint. Tags are self-declared on each router.
    api_router.include_router(stream_router)
    api_router.include_router(stream_tokens_router)

    return api_router
