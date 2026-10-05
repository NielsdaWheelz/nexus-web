"""Reader routes: document, deep-link targets, map, state, file, reading copy."""

import os
import tempfile
from pathlib import Path
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from nexus.api.deps import get_stream_viewer
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import Data
from nexus.schemas.media import MediaFileOut
from nexus.schemas.reader import (
    CursorWrite,
    ReaderCursorSnapshot,
    ReaderTargetKind,
    ReaderTargetOut,
)
from nexus.schemas.reader_document import ReaderDocumentOut
from nexus.schemas.reader_document_map import ReaderDocumentMapOut
from nexus.services import (
    media_file_access,
    reader_document,
    reader_document_map,
    reading_copy,
)
from nexus.services.consumption import service as consumption_service
from nexus.services.resource_graph import reader_targets

router = APIRouter(tags=["media"])


@router.get("/media/{media_id}/reader")
def get_reader_document(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
) -> Data[ReaderDocumentOut]:
    """The whole publication the reader mounts, from one snapshot."""
    return Data(data=reader_document.read_reader_document(db, viewer.user_id, media_id))


@router.get("/media/{media_id}/reader-targets/{kind}/{target_id}")
def get_reader_target(
    media_id: UUID,
    kind: ReaderTargetKind,
    target_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> Data[ReaderTargetOut]:
    """Where a highlight, evidence span, passage or apparatus deep link lands in this media."""
    return Data(
        data=reader_targets.reader_target_for_media(
            db, viewer_id=viewer.user_id, media_id=media_id, kind=kind, target_id=target_id
        )
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
) -> Data[ReaderCursorSnapshot]:
    return Data(data=consumption_service.get_reader_cursor(db, viewer.user_id, media_id))


@router.put("/media/{media_id}/reader-state")
def put_reader_state(
    media_id: UUID, payload: CursorWrite, viewer: Annotated[Viewer, Depends(get_viewer)]
) -> Data[ReaderCursorSnapshot]:
    return Data(data=consumption_service.put_reader_cursor(viewer.user_id, media_id, payload))


@router.get("/media/{media_id}/file")
def get_media_file(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> Data[MediaFileOut]:
    """A short-lived signed download URL: url and expires_at."""
    return Data(
        data=MediaFileOut.model_validate(
            media_file_access.get_signed_download_url(
                db=db, viewer_id=viewer.user_id, media_id=media_id
            )
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
