"""Media source transport: url accept and recovery (retry, refresh, repair).

Transport only, registered before the media router so ``/media/from-url`` is never read
as a media id. Each write's retry rule is stated on its service function."""

from typing import Annotated, assert_never
from uuid import UUID

from fastapi import APIRouter, Depends

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.logging import get_request_id
from nexus.responses import Data
from nexus.schemas.media_sources import (
    FromUrlOut,
    FromUrlRequest,
    MediaRepairAdmission,
    MediaRepairRequest,
    RefreshSourceRequest,
    RetrySourceRequest,
    SearchRepairRequest,
    SourceAdmission,
    SourceAttemptOut,
    SourceRepairRequest,
)
from nexus.services import content_indexing, media_source_ingest

router = APIRouter(tags=["media"])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]


@router.post("/media/from-url", status_code=202)
def create_from_url(body: FromUrlRequest, viewer: ViewerDep, db: DbSession) -> Data[FromUrlOut]:
    """Accept a url; resolve its attempt before opening a potentially deduplicated media."""
    return Data(
        data=media_source_ingest.accept_url_source(
            db=db,
            viewer_id=viewer.user_id,
            id=body.id,
            url=body.url,
            expected_removal_revision=int(body.expected_removal_revision),
            destinations=body.destinations,
            request_id=get_request_id(),
        )
    )


@router.get("/media/source-attempts/{source_attempt_id}")
def read_source_attempt(
    source_attempt_id: UUID, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[SourceAttemptOut]:
    return Data(
        data=media_source_ingest.read_source_attempt(
            db, viewer_id=viewer.user_id, source_attempt_id=source_attempt_id
        )
    )


@router.post("/media/{media_id}/retry", status_code=202)
def retry_source(
    media_id: UUID, body: RetrySourceRequest, viewer: ViewerDep, db: DbSession
) -> Data[SourceAdmission]:
    return Data(
        data=media_source_ingest.retry_source(
            db,
            viewer_id=viewer.user_id,
            media_id=media_id,
            expected_attempt_id=body.expected_attempt_id,
            request_id=get_request_id(),
        )
    )


@router.post("/media/{media_id}/refresh", status_code=202)
def refresh_source(
    media_id: UUID, body: RefreshSourceRequest, viewer: ViewerDep, db: DbSession
) -> Data[SourceAdmission]:
    return Data(
        data=media_source_ingest.refresh_source(
            db,
            viewer_id=viewer.user_id,
            media_id=media_id,
            expected_attempt_id=body.expected_attempt_id,
            request_id=get_request_id(),
        )
    )


@router.post("/media/{media_id}/repair", status_code=202)
def repair_media(
    media_id: UUID, body: MediaRepairRequest, viewer: ViewerDep, db: DbSession
) -> Data[MediaRepairAdmission]:
    """Requeue the exact dead job the viewer inspected: source or search."""
    admission: MediaRepairAdmission
    match body:
        case SourceRepairRequest():
            admission = media_source_ingest.repair_source(
                db,
                viewer_id=viewer.user_id,
                media_id=media_id,
                expected_attempt_id=body.expected_attempt_id,
                expected_job_id=body.expected_job_id,
            )
        case SearchRepairRequest():
            admission = content_indexing.repair_dead_media_reindex(
                db,
                viewer_id=viewer.user_id,
                media_id=media_id,
                expected_revision=body.expected_revision,
                expected_job_id=body.expected_job_id,
            )
        case _:
            assert_never(body)
    return Data(data=admission)
