"""Reader routes: document, deep-link targets, map, state, file, reading copy."""

import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Request

from nexus.auth.middleware import Viewer, get_viewer
from nexus.config import get_settings
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import Data
from nexus.schemas.reader import (
    CursorWrite,
    MediaFileOut,
    ReaderCursorSnapshot,
    ReaderTargetKind,
    ReaderTargetOut,
    ReadingCopyOut,
)
from nexus.schemas.reader_document import ReaderDocumentOut
from nexus.schemas.reader_document_map import ReaderDocumentMapOut
from nexus.services import (
    media_file_access,
    reader_document,
    reader_document_map,
    reading_copy,
)
from nexus.services.consumption import state
from nexus.services.resource_graph import reader_targets
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_reading_copy_storage_path

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
    return Data(data=state.get_reader_cursor(db, viewer.user_id, media_id))


@router.put("/media/{media_id}/reader-state")
def put_reader_state(
    media_id: UUID, payload: CursorWrite, viewer: Annotated[Viewer, Depends(get_viewer)]
) -> Data[ReaderCursorSnapshot]:
    return Data(data=state.put_reader_cursor(viewer.user_id, media_id, payload))


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


@router.post("/media/{media_id}/reading-copy")
def create_reading_copy(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
) -> Data[ReadingCopyOut]:
    """Build the offline reading copy, store it and hand back a signed url.

    Each call stores a fresh object under the media's prefix that no row owns, so the
    storage orphan sweep reclaims it after its minimum age; a retry builds another.
    """
    key = build_reading_copy_storage_path(media_id, uuid4())
    storage = get_storage_client()
    with tempfile.TemporaryDirectory(prefix="nexus-reading-copy-") as directory:
        path = Path(directory) / "copy.zip"
        generation = reading_copy.build_reading_copy(
            db, viewer_id=viewer.user_id, media_id=media_id, path=path
        )
        with path.open("rb") as file:
            storage.put_object(key, file, content_type="application/zip")
    expiry = get_settings().signed_url_expiry_s
    return Data(
        data=ReadingCopyOut(
            url=storage.sign_download(key, expires_in=expiry),
            expires_at=datetime.now(UTC) + timedelta(seconds=expiry),
            generation=generation,
        )
    )
