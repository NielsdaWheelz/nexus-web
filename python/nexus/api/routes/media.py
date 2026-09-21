"""Media catalog routes. Transport only: validate, call one service, envelope.

``MediaOut.player_descriptor`` is the sole aliased field on this wire, so every
route that serializes one dumps ``by_alias=True``.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db, get_repeatable_read_db
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import ok, success_response
from nexus.schemas.contributors import MediaAuthorsPutRequest
from nexus.schemas.media import MediaIntelligenceOut, MediaLibrariesRequest
from nexus.schemas.resource_graph import RelatedMediaOut, endpoint_out
from nexus.services import contributors as contributors_service
from nexus.services import library_entries, media_intelligence, media_source_ingest
from nexus.services import media as media_service
from nexus.services import media_deletion as media_deletion_service
from nexus.services.resonance import service as resonance_service

router = APIRouter(tags=["media"])

ViewerDep = Annotated[Viewer, Depends(get_viewer)]
DbDep = Annotated[Session, Depends(get_db)]
RepeatableReadDbDep = Annotated[Session, Depends(get_repeatable_read_db)]


@router.get("/media")
def list_media(
    viewer: ViewerDep,
    db: DbDep,
    kind: str | None = Query(
        default=None,
        description="Comma-separated media kind filter (web_article, epub, pdf, video, podcast_episode)",
    ),
    search: str | None = Query(default=None, description="Optional title substring filter"),
    cursor: str | None = Query(default=None, description="Pagination cursor"),
    limit: int = Query(default=50, ge=1, le=200, description="Maximum results per page"),
) -> dict:
    media_list, next_cursor = media_service.list_visible_media(
        db=db, viewer_id=viewer.user_id, kind=kind, search=search, cursor=cursor, limit=limit
    )
    return {**ok(media_list, by_alias=True), "page": {"next_cursor": next_cursor}}


@router.get("/media/{media_id}")
def get_media(media_id: UUID, viewer: ViewerDep, db: DbDep) -> dict:
    """404 if the media does not exist or the viewer cannot read it."""
    return ok(media_service.get_media_for_viewer(db, viewer.user_id, media_id), by_alias=True)


@router.get("/media/{media_id}/offline-download-spec")
def get_offline_download_spec(media_id: UUID, viewer: ViewerDep, db: DbDep) -> dict:
    result = media_service.get_offline_download_spec_for_viewer(
        db, viewer_id=viewer.user_id, media_id=media_id
    )
    return ok(result, by_alias=True)


@router.put("/media/{media_id}/authors")
def put_media_authors(media_id: UUID, request: MediaAuthorsPutRequest, viewer: ViewerDep) -> dict:
    """The contributors facade owns its own session, re-check, replay and mutation."""
    result = contributors_service.put_media_authors(
        viewer=viewer, media_id=media_id, request=request
    )
    return ok(result, by_alias=True)


@router.delete("/media/{media_id}")
def remove_media(media_id: UUID, request: Request, viewer: ViewerDep, db: DbDep) -> dict:
    if request.query_params:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Whole-resource media deletion does not accept query parameters",
        )
    result = media_deletion_service.remove_media_for_viewer(db, viewer.user_id, media_id)
    return ok(result, by_alias=True)


@router.get("/media/{media_id}/libraries")
def get_media_libraries(media_id: UUID, viewer: ViewerDep, db: DbDep) -> dict:
    rows = library_entries.list_item_libraries(
        db, viewer_id=viewer.user_id, target=library_entries.media_target(media_id)
    )
    return ok(rows)


@router.get("/media/{media_id}/fragments")
def get_media_fragments(media_id: UUID, viewer: ViewerDep, db: DbDep) -> dict:
    return ok(media_service.list_fragments_for_viewer(db, viewer.user_id, media_id))


@router.get("/media/{media_id}/related")
def get_related_media(
    media_id: UUID,
    viewer: ViewerDep,
    db: RepeatableReadDbDep,
    limit: int = Query(default=8, ge=1, le=20),
) -> dict:
    peers = resonance_service.related_media(
        db, viewer_id=viewer.user_id, media_id=media_id, limit=limit
    )
    return ok(RelatedMediaOut(peers=[endpoint_out(peer) for peer in peers]))


@router.post("/media/{media_id}/libraries", status_code=204)
def add_media_libraries(
    media_id: UUID, body: MediaLibrariesRequest, viewer: ViewerDep, db: DbDep
) -> Response:
    library_entries.ensure_media_in_libraries_for_viewer(
        db, viewer.user_id, media_id, body.library_ids
    )
    return Response(status_code=204)


@router.put("/media/{media_id}/saved-in-nexus", status_code=204)
def add_media_saved_in_nexus(media_id: UUID, viewer: ViewerDep, db: DbDep) -> Response:
    library_entries.ensure_media_saved_in_nexus_for_viewer(
        db, viewer_id=viewer.user_id, media_id=media_id
    )
    return Response(status_code=204)


@router.delete("/media/{media_id}/saved-in-nexus")
def remove_media_saved_in_nexus(media_id: UUID, viewer: ViewerDep, db: DbDep) -> dict:
    result = library_entries.ensure_media_absent_from_saved_in_nexus_for_viewer(
        db, viewer_id=viewer.user_id, media_id=media_id
    )
    return ok(result, by_alias=True)


@router.delete("/media/{media_id}/libraries/{library_id}")
def remove_media_library(media_id: UUID, library_id: UUID, viewer: ViewerDep, db: DbDep) -> dict:
    result = library_entries.remove_media_from_library(db, viewer.user_id, media_id, library_id)
    return ok(result, by_alias=True)


@router.post("/media/{media_id}/refresh", status_code=202)
def refresh_media_source(media_id: UUID, viewer: ViewerDep, db: DbDep, request: Request) -> dict:
    result = media_source_ingest.refresh_source_for_viewer(
        db=db,
        viewer_id=viewer.user_id,
        media_id=media_id,
        request_id=getattr(request.state, "request_id", None),
    )
    return success_response(result)


@router.get("/media/{media_handle}/intelligence")
def get_media_intelligence(media_handle: UUID, viewer: ViewerDep, db: DbDep) -> dict:
    projection = media_intelligence.read_single(
        db, media_id=media_handle, requester_user_id=viewer.user_id
    )
    return ok(
        MediaIntelligenceOut(
            media_id=projection.media_id,
            status=projection.status,
            content_fingerprint=projection.content_fingerprint,
            summary_md=projection.summary_md,
            model_name=projection.model_name,
        )
    )
