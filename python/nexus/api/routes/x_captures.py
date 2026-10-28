"""Private immutable-source reading and guarded quote/image retry transport."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy import select
from starlette.responses import Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.models import XPostCaptureAsset
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.responses import Data
from nexus.schemas.reader_document import ReaderCaptureDocumentOut
from nexus.schemas.reader_document_map import ReaderCaptureDocumentMapOut
from nexus.schemas.x_captures import QuoteRetrieval, RetryXCaptureRequest, XCaptureArchiveOut
from nexus.services.reader_document import read_capture_document
from nexus.services.reader_document_map import get_capture_document_map
from nexus.services.x_source import require_readable_x_capture
from nexus.storage.client import get_storage_client
from nexus.tasks.archive_x_capture_assets import archive_status, retry_images
from nexus.tasks.capture_x_quote import retry_quote

router = APIRouter(tags=["x captures"])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]


@router.get("/x/captures/{capture_id}/reader")
def read_capture(
    capture_id: UUID, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[ReaderCaptureDocumentOut]:
    require_readable_x_capture(db, viewer_id=viewer.user_id, capture_id=capture_id)
    return Data(data=read_capture_document(db, viewer.user_id, capture_id))


@router.get("/x/captures/{capture_id}/assets/{asset_key}")
def read_asset(
    capture_id: UUID, asset_key: str, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Response:
    require_readable_x_capture(db, viewer_id=viewer.user_id, capture_id=capture_id)
    asset = db.scalar(
        select(XPostCaptureAsset).where(
            XPostCaptureAsset.capture_id == capture_id, XPostCaptureAsset.asset_key == asset_key
        )
    )
    if asset is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "image unavailable in saved capture")
    return Response(
        content=get_storage_client().read_object(
            asset.storage_path, expected_size=asset.size_bytes
        ),
        media_type=asset.mime,
        headers={"Cache-Control": "private, no-store"},
    )


@router.get("/x/captures/{capture_id}/archive")
def read_archive(
    capture_id: UUID, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[XCaptureArchiveOut]:
    return Data(data=archive_status(db, viewer_id=viewer.user_id, capture_id=capture_id))


@router.post("/x/captures/{capture_id}/retry-images")
def retry_archive(
    capture_id: UUID, body: RetryXCaptureRequest, viewer: ViewerDep, db: DbSession
) -> Data[XCaptureArchiveOut]:
    return Data(
        data=retry_images(
            db,
            viewer_id=viewer.user_id,
            capture_id=capture_id,
            expected_job_id=body.expected_job_id,
        )
    )


@router.post("/media/{media_id}/embeds/{occurrence_id}/retry")
def retry_embedded_quote(
    media_id: UUID,
    occurrence_id: UUID,
    body: RetryXCaptureRequest,
    viewer: ViewerDep,
    db: DbSession,
) -> Data[QuoteRetrieval]:
    return Data(
        data=retry_quote(
            db,
            viewer_id=viewer.user_id,
            media_id=media_id,
            occurrence_id=occurrence_id,
            expected_job_id=body.expected_job_id,
        )
    )


@router.get("/x/captures/{capture_id}/document-map")
def read_capture_map(
    capture_id: UUID, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[ReaderCaptureDocumentMapOut]:
    return Data(data=get_capture_document_map(db, viewer_id=viewer.user_id, capture_id=capture_id))
