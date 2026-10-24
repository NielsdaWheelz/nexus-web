"""Media routes. Transport only: validate, call one service, envelope."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.logging import get_request_id
from nexus.responses import Data
from nexus.schemas.media import MediaOut
from nexus.schemas.media_summary import (
    MediaSummaryResolutionOut,
    ResolvedMediaSummariesOut,
    ResolveMediaSummariesIn,
)
from nexus.schemas.metadata_enrichment import MetadataEnrichmentAccepted, MetadataEnrichmentRequest
from nexus.services import media, media_deletion, metadata_operations

router = APIRouter(tags=["media"])

ViewerDep = Annotated[Viewer, Depends(get_viewer)]


@router.post("/media/summaries/resolve")
def resolve_media_summaries(
    body: ResolveMediaSummariesIn, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[ResolvedMediaSummariesOut]:
    """Input order; an id the viewer cannot read resolves to null."""
    found = media.media_summaries(db, viewer_id=viewer.user_id, media_ids=body.media_ids)
    items = [
        MediaSummaryResolutionOut(media_id=media_id, summary=found.get(media_id))
        for media_id in body.media_ids
    ]
    return Data(data=ResolvedMediaSummariesOut(items=items))


@router.get("/media/{media_id}")
def get_media(media_id: UUID, viewer: ViewerDep, db: RepeatableReadDbSession) -> Data[MediaOut]:
    """404 when the media does not exist or the viewer cannot read it."""
    return Data(data=media.get_media_for_viewer(db, viewer.user_id, media_id))


@router.post("/media/{media_id}/metadata-enrichment", status_code=202)
def enrich_media_metadata(
    media_id: UUID, body: MetadataEnrichmentRequest, viewer: ViewerDep, db: DbSession
) -> Data[MetadataEnrichmentAccepted]:
    """A resend after the job landed answers that job (it is newer than ``expected_job_id``)."""
    return Data(
        data=metadata_operations.admit_metadata_enrichment(
            db,
            viewer_id=viewer.user_id,
            media_id=media_id,
            expected_job_id=body.expected_job_id,
            request_id=get_request_id(),
        )
    )


@router.post("/media/{media_id}/metadata-enrichment/{job_id}/review", status_code=204)
def review_media_metadata_result(
    media_id: UUID, job_id: UUID, viewer: ViewerDep, db: DbSession
) -> Response:
    """Idempotent: an existing review stands."""
    metadata_operations.review_metadata_result(
        db, viewer_id=viewer.user_id, media_id=media_id, job_id=job_id
    )
    return Response(status_code=204)


@router.delete("/media/{media_id}", status_code=204)
def remove_media(media_id: UUID, viewer: ViewerDep, db: DbSession) -> Response:
    """Idempotent: a media the viewer cannot read is already removed (204); one reachable
    only through a system library is 403."""
    media_deletion.remove_media_for_viewer(db, viewer.user_id, media_id)
    return Response(status_code=204)
