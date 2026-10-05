"""Reader routes: document, evidence, EPUB fragments, navigation, map, state, file, reading copy."""

import os
import tempfile
from pathlib import Path
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse, JSONResponse
from starlette.background import BackgroundTask

from nexus.api.deps import get_stream_viewer
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.responses import Data, ok, success_response
from nexus.schemas.media import MediaEvidenceResponse, MediaNavigationOut
from nexus.schemas.reader import CursorWrite
from nexus.schemas.reader_document import ReaderDocumentOut
from nexus.schemas.reader_document_map import ReaderDocumentMapOut
from nexus.services import (
    epub_read,
    locator_resolver,
    media_file_access,
    reader_document,
    reader_document_map,
    reader_navigation,
    reading_copy,
)
from nexus.services.consumption import service as consumption_service

router = APIRouter(tags=["media"])


@router.get("/media/{media_id}/reader")
def get_reader_document(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
) -> Data[ReaderDocumentOut]:
    """The whole publication the reader mounts, from one snapshot."""
    return Data(data=reader_document.read_reader_document(db, viewer.user_id, media_id))


@router.get("/media/{media_id}/evidence/{evidence_span_id}", response_model=MediaEvidenceResponse)
def resolve_media_evidence(
    media_id: UUID,
    evidence_span_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> dict:
    result = locator_resolver.resolve_evidence_span(
        db, viewer_id=viewer.user_id, evidence_span_id=evidence_span_id
    )
    if result["media_id"] != str(media_id) or result["resolver"]["kind"] == "note":
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Evidence not found")
    del result["resolver"]["selector"]
    return success_response(result)


@router.get("/media/{media_id}/fragments/{fragment_id}")
def get_epub_fragment(
    media_id: UUID,
    fragment_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
) -> dict:
    return ok(epub_read.get_epub_fragment_for_viewer(db, viewer.user_id, media_id, fragment_id))


@router.get("/media/{media_id}/navigation")
def get_media_navigation(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
) -> Data[MediaNavigationOut]:
    return Data(
        data=reader_navigation.get_media_navigation_for_viewer(db, viewer.user_id, media_id)
    )


@router.get("/media/{media_id}/document-map")
def get_reader_document_map(
    request: Request,
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
) -> Data[ReaderDocumentMapOut]:
    unsupported_params = sorted(request.query_params)
    if unsupported_params:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Unsupported Document Map params: {', '.join(unsupported_params)}",
        )
    return Data(
        data=reader_document_map.get_reader_document_map(
            db, viewer_id=viewer.user_id, media_id=media_id
        )
    )


@router.get("/media/{media_id}/reader-state")
def get_reader_state(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> dict:
    return ok(consumption_service.get_reader_cursor(db, viewer.user_id, media_id))


@router.put("/media/{media_id}/reader-state")
def put_reader_state(
    media_id: UUID, payload: CursorWrite, viewer: Annotated[Viewer, Depends(get_viewer)]
) -> JSONResponse:
    snapshot = consumption_service.put_reader_cursor(viewer.user_id, media_id, payload)
    return JSONResponse(content=ok(snapshot))


@router.get("/media/{media_id}/file")
def get_media_file(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> dict:
    """A short-lived signed download URL: url and expires_at."""
    return success_response(
        media_file_access.get_signed_download_url(
            db=db, viewer_id=viewer.user_id, media_id=media_id
        )
    )


@router.get("/stream/media/{media_id}/reading-copy")
def get_reading_copy(
    media_id: UUID,
    viewer_id: Annotated[UUID, Depends(get_stream_viewer)],
    db: RepeatableReadDbSession,
) -> FileResponse:
    """The offline reading copy, built synchronously into a temp file that leaves with the response."""
    descriptor, name = tempfile.mkstemp(prefix="nexus-reading-copy-", suffix=".zip")
    os.close(descriptor)
    try:
        generation = reading_copy.build_reading_copy(
            db, viewer_id=viewer_id, media_id=media_id, path=Path(name)
        )
    except BaseException:
        os.unlink(name)
        raise
    return FileResponse(
        name,
        media_type="application/zip",
        headers={"Cache-Control": "private, no-store", "Nexus-Reader-Generation": str(generation)},
        background=BackgroundTask(os.unlink, name),
    )
