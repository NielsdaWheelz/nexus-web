"""Every api route, in one router: the app mounts it and ``nexus.wire_schema`` describes it."""

from fastapi import APIRouter

from nexus.api.routes.assistant_writes import router as assistant_writes_router
from nexus.api.routes.atlas import router as atlas_router
from nexus.api.routes.auth_handoff_codes import router as auth_handoff_codes_router
from nexus.api.routes.browse import router as browse_router
from nexus.api.routes.chat import router as chat_router
from nexus.api.routes.connection_discovery import router as connection_discovery_router
from nexus.api.routes.consumption import router as consumption_router
from nexus.api.routes.consumption_activity import router as consumption_activity_router
from nexus.api.routes.contributors import router as contributors_router
from nexus.api.routes.dossiers import router as dossiers_router
from nexus.api.routes.email_ingest import router as email_ingest_router
from nexus.api.routes.extension_captures import router as extension_captures_router
from nexus.api.routes.extension_sessions import router as extension_sessions_router
from nexus.api.routes.highlights import router as highlights_router
from nexus.api.routes.imports import router as imports_router
from nexus.api.routes.libraries import router as libraries_router
from nexus.api.routes.library_members import router as library_members_router
from nexus.api.routes.llm import router as llm_router
from nexus.api.routes.me import router as me_router
from nexus.api.routes.media import router as media_router
from nexus.api.routes.media_assets import router as media_assets_router
from nexus.api.routes.media_ingest import router as media_ingest_router
from nexus.api.routes.media_sources import router as media_sources_router
from nexus.api.routes.notes import router as notes_router
from nexus.api.routes.operational import router as operational_router
from nexus.api.routes.oracle import router as oracle_router
from nexus.api.routes.passage_anchors import router as passage_anchors_router
from nexus.api.routes.playback import router as playback_router
from nexus.api.routes.podcast_transcripts import router as podcast_transcripts_router
from nexus.api.routes.podcasts import router as podcasts_router
from nexus.api.routes.public_resource_shares import router as public_resource_shares_router
from nexus.api.routes.reader import router as reader_router
from nexus.api.routes.resource_graph import router as resource_graph_router
from nexus.api.routes.resource_items import router as resource_items_router
from nexus.api.routes.resource_shares import router as resource_shares_router
from nexus.api.routes.search import router as search_router
from nexus.api.routes.stream import router as stream_router
from nexus.api.routes.telemetry import router as telemetry_router
from nexus.api.routes.users import router as users_router


def create_api_router() -> APIRouter:
    api_router = APIRouter()
    api_router.include_router(assistant_writes_router)
    api_router.include_router(operational_router)
    api_router.include_router(me_router)
    api_router.include_router(telemetry_router)
    api_router.include_router(extension_sessions_router)
    api_router.include_router(extension_captures_router)
    api_router.include_router(auth_handoff_codes_router)
    api_router.include_router(library_members_router)
    api_router.include_router(libraries_router)
    api_router.include_router(dossiers_router)
    # Media family. Every router owning a static `/media/<literal>` path
    # (media_assets, media_ingest, media_sources, playback, consumption,
    # podcast_transcripts) must be registered before the `media` router that owns
    # `/media/{media_id}` —
    # Starlette matches in registration order, so a misorder would parse e.g.
    # "image" as a UUID and 422. Tags are self-declared on each router.
    api_router.include_router(media_assets_router)
    api_router.include_router(media_ingest_router)
    api_router.include_router(media_sources_router)
    api_router.include_router(playback_router)
    api_router.include_router(consumption_router)
    api_router.include_router(podcast_transcripts_router)
    api_router.include_router(imports_router)
    api_router.include_router(public_resource_shares_router)
    api_router.include_router(reader_router)
    api_router.include_router(media_router)
    api_router.include_router(notes_router)
    api_router.include_router(passage_anchors_router)
    api_router.include_router(resource_items_router)
    api_router.include_router(resource_shares_router)
    api_router.include_router(resource_graph_router)
    api_router.include_router(connection_discovery_router)
    api_router.include_router(highlights_router)
    api_router.include_router(chat_router)
    api_router.include_router(contributors_router)
    api_router.include_router(oracle_router)
    api_router.include_router(llm_router)
    api_router.include_router(browse_router)
    api_router.include_router(search_router)
    api_router.include_router(users_router)
    api_router.include_router(atlas_router)
    api_router.include_router(consumption_activity_router)
    api_router.include_router(podcasts_router)
    api_router.include_router(email_ingest_router)
    api_router.include_router(stream_router)
    return api_router
