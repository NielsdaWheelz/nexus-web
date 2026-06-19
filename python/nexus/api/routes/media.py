"""Media catalog routes: list, get, delete, fragments, libraries, refresh.

Transport-only: validate input, call exactly one service, return the envelope.
Asset serving, ingestion, reader, listening-state, and transcript routes live in
their own routers (media_assets, media_ingest, reader, listening_state,
podcast_transcripts). Those routers own static `/media/<literal>` paths and are
registered before this one so the literals are not parsed as `/media/{media_id}`.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok, success_response
from nexus.schemas.media import MediaLibrariesRequest
from nexus.schemas.resource_graph import ConnectionEndpointOut, RelatedMediaOut
from nexus.services import library_entries, media_intelligence, media_related, media_source_ingest
from nexus.services import media as media_service
from nexus.services import media_deletion as media_deletion_service
from nexus.services.resource_graph.schemas import ConnectionEndpoint

router = APIRouter(tags=["media"])

# Clamp for GET /media/{id}/related ``limit`` (spec S5).
_RELATED_LIMIT_MIN = 1
_RELATED_LIMIT_MAX = 20


def _endpoint_out(endpoint: ConnectionEndpoint) -> ConnectionEndpointOut:
    return ConnectionEndpointOut(
        ref=endpoint.ref.uri,
        scheme=endpoint.ref.scheme,
        id=endpoint.ref.id,
        label=endpoint.label,
        description=endpoint.description,
        activation=endpoint.activation,
        href=endpoint.href,
        missing=endpoint.missing,
    )


@router.get("/media")
def list_media(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    kind: str | None = Query(
        default=None,
        description="Comma-separated media kind filter (web_article, epub, pdf, video, podcast_episode)",
    ),
    search: str | None = Query(default=None, description="Optional title substring filter"),
    cursor: str | None = Query(default=None, description="Pagination cursor"),
    limit: int = Query(default=50, ge=1, le=200, description="Maximum results per page"),
) -> dict:
    """List media visible to the viewer across all libraries/provenance paths."""
    media_list, next_cursor = media_service.list_visible_media(
        db=db,
        viewer_id=viewer.user_id,
        kind=kind,
        search=search,
        cursor=cursor,
        limit=limit,
    )
    return {**ok(media_list), "page": {"next_cursor": next_cursor}}


@router.get("/media/{media_id}")
def get_media(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get media by ID. Returns 404 if it does not exist or the viewer cannot read it."""
    result = media_service.get_media_for_viewer(db, viewer.user_id, media_id)
    return ok(result)


@router.delete("/media/{media_id}")
def remove_media(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    library_id: Annotated[UUID | None, Query()] = None,
) -> dict:
    if library_id is None:
        result = media_deletion_service.delete_document_for_viewer(db, viewer.user_id, media_id)
    else:
        result = media_deletion_service.remove_document_from_library(
            db, viewer.user_id, media_id, library_id
        )
    return ok(result)


@router.get("/media/{media_id}/libraries")
def get_media_libraries(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    rows = library_entries.list_item_libraries(
        db, viewer_id=viewer.user_id, target=library_entries.media_target(media_id)
    )
    return ok(rows)


@router.get("/media/{media_id}/fragments")
def get_media_fragments(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get fragments ordered by idx ASC. Returns 404 if not readable (masks existence)."""
    result = media_service.list_fragments_for_viewer(db, viewer.user_id, media_id)
    return ok(result)


@router.get("/media/{media_id}/related")
def get_related_media(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    limit: int = Query(default=8, ge=_RELATED_LIMIT_MIN, le=_RELATED_LIMIT_MAX),
) -> dict:
    """Deterministic related peers for a media: embedding NN + shared-author.

    Peers are computed from precomputed ``content_embeddings`` and
    ``contributor_credits`` only — no request-time LLM. Each peer carries a live
    label + href; deleted/forbidden peers come back ``missing``. Returns 404 if
    the media does not exist or the viewer cannot read it (masks existence).
    """
    media_service.get_media_for_viewer(db, viewer.user_id, media_id)
    peers = media_related.related_media(
        db, viewer_id=viewer.user_id, media_id=media_id, limit=limit
    )
    return ok(RelatedMediaOut(peers=[_endpoint_out(peer) for peer in peers]))


@router.post("/media/{media_id}/libraries")
def add_media_libraries(
    media_id: UUID,
    body: MediaLibrariesRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Additively attach the media to one or more libraries.

    Idempotent: ids already present are not reinserted. The viewer's default
    library id is rejected because destination writes are writable non-default
    libraries only. Returns the subset of ids actually inserted.
    """
    result = library_entries.add_media_to_libraries_for_viewer(
        db, viewer.user_id, media_id, body.library_ids
    )
    return ok(result)


@router.post("/media/{media_id}/refresh", status_code=202)
def refresh_media_source(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    request: Request,
) -> dict:
    """Refresh source-backed media by requeueing source acquisition."""
    result = media_source_ingest.refresh_source_for_viewer(
        db=db,
        viewer_id=viewer.user_id,
        media_id=media_id,
        request_id=getattr(request.state, "request_id", None),
        idempotency_key=request.headers.get("Idempotency-Key"),
    )
    return success_response(result)


@router.post("/media/{media_id}/summarize", status_code=202)
def summarize_media(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Build (or reuse) the per-media intelligence unit on demand."""
    result = media_intelligence.ensure_media_unit_for_viewer(
        db, viewer_id=viewer.user_id, media_id=media_id
    )
    return ok(result)
