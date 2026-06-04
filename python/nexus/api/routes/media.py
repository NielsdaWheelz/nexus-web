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
from nexus.services import library_entries
from nexus.services import media as media_service
from nexus.services import media_deletion as media_deletion_service

router = APIRouter(tags=["media"])


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


@router.post("/media/{media_id}/libraries")
def add_media_libraries(
    media_id: UUID,
    body: MediaLibrariesRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Additively attach the media to one or more libraries.

    Idempotent: ids already present and the viewer's default library id are
    deduped. Returns the subset of ids actually inserted.
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
    result = media_service.refresh_source_for_viewer(
        db=db,
        viewer_id=viewer.user_id,
        media_id=media_id,
        request_id=getattr(request.state, "request_id", None),
    )
    return success_response(result)
