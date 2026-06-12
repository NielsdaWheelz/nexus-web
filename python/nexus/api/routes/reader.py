"""Reader routes: evidence resolution, EPUB sections/navigation, reader state, file.

Transport-only: validate input, call one reader-family service, return the
envelope. All paths are `/media/{media_id}/...`.
"""

from typing import Annotated, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import ok, success_response
from nexus.schemas.media import MediaEvidenceResponse
from nexus.services import (
    epub_read,
    locator_resolver,
    media_file_access,
    reader_apparatus,
    reader_connections,
    reader_navigation,
)
from nexus.services import reader as reader_service
from nexus.services.resource_graph.refs import RESOURCE_SCHEMES, ResourceScheme
from nexus.services.resource_graph.schemas import EDGE_ORIGINS, EdgeOrigin

router = APIRouter(tags=["media"])


@router.get(
    "/media/{media_id}/evidence/{evidence_span_id}",
    response_model=MediaEvidenceResponse,
)
def resolve_media_evidence(
    media_id: UUID,
    evidence_span_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = locator_resolver.resolve_evidence_span(
        db,
        viewer_id=viewer.user_id,
        evidence_span_id=evidence_span_id,
    )
    return success_response(result)


@router.get("/media/{media_id}/sections/{section_id:path}")
def get_epub_section(
    media_id: UUID,
    section_id: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get a canonical EPUB section by encoded section id."""
    result = epub_read.get_epub_section_for_viewer(db, viewer.user_id, media_id, section_id)
    return ok(result)


@router.get("/media/{media_id}/navigation")
def get_media_navigation(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get canonical reader navigation payload."""
    result = reader_navigation.get_media_navigation_for_viewer(db, viewer.user_id, media_id)
    return ok(result)


@router.get("/media/{media_id}/apparatus")
def get_media_apparatus(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get source-authored reader apparatus."""
    result = reader_apparatus.get_media_apparatus(db, viewer.user_id, media_id)
    return ok(result)


@router.get("/media/{media_id}/reader-connections")
def get_media_reader_connections(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    origin: Annotated[list[str] | None, Query()] = None,
    source_scheme: Annotated[list[str] | None, Query()] = None,
    limit: int = Query(default=100, ge=1, le=100),
    cursor: str | None = Query(default=None),
) -> dict:
    result = reader_connections.list_reader_connections(
        db,
        viewer_id=viewer.user_id,
        media_id=media_id,
        origins=_edge_origins(origin),
        source_schemes=_resource_schemes(source_scheme),
        limit=limit,
        cursor=cursor,
    )
    return ok(result)


@router.get("/media/{media_id}/reader-state")
def get_reader_state(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get per-media reader state."""
    result = reader_service.get_reader_media_state(db, viewer.user_id, media_id)
    return success_response(result.model_dump(mode="json") if result else None)


@router.put("/media/{media_id}/reader-state")
async def put_reader_state(
    media_id: UUID,
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Replace per-media reader state. An empty body is rejected; JSON ``null`` clears it."""
    body = reader_service.parse_reader_resume_state(await request.body())
    result = reader_service.put_reader_media_state(db, viewer.user_id, media_id, body)
    return success_response(result.model_dump(mode="json") if result else None)


@router.get("/media/{media_id}/file")
def get_media_file(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get a short-lived signed download URL for a media file (PDF/EPUB only).

    Returns url and expires_at.
    """
    result = media_file_access.get_signed_download_url(
        db=db,
        viewer_id=viewer.user_id,
        media_id=media_id,
    )
    return success_response(result)


def _edge_origins(values: list[str] | None) -> tuple[EdgeOrigin, ...] | None:
    if values is None:
        return None
    for value in values:
        if value not in EDGE_ORIGINS:
            raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, f"Invalid origin: {value!r}")
    return tuple(cast("EdgeOrigin", value) for value in values)


def _resource_schemes(values: list[str] | None) -> tuple[ResourceScheme, ...] | None:
    if values is None:
        return None
    for value in values:
        if value not in RESOURCE_SCHEMES:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, f"Invalid source_scheme: {value!r}"
            )
    return tuple(cast("ResourceScheme", value) for value in values)
