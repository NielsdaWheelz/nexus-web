"""URL ingest dispatch."""

from uuid import UUID

from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.media import FromUrlResponse
from nexus.services import (
    library_governance,
    remote_file_ingest,
    x_ingest,
    youtube_ingest,
)
from nexus.services import media as media_service
from nexus.services.url_normalize import validate_requested_url
from nexus.services.x_identity import classify_x_url, is_x_url
from nexus.services.youtube_identity import classify_youtube_url, is_youtube_url


def enqueue_media_from_url(
    db: Session,
    viewer_id: UUID,
    url: str,
    library_ids: list[UUID],
    request_id: str | None = None,
) -> FromUrlResponse:
    """Create media from URL with source-owner dispatch."""
    library_governance.validate_writable_library_destinations(db, viewer_id, library_ids)
    validate_requested_url(url)

    youtube_identity = classify_youtube_url(url)
    if youtube_identity is not None:
        result = youtube_ingest.create_or_reuse_youtube_video(
            db=db,
            viewer_id=viewer_id,
            url=url,
            library_ids=library_ids,
            enqueue_task=True,
            request_id=request_id,
        )
        return result

    if is_youtube_url(url):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "YouTube URL must include a valid video ID",
        )

    x_identity = classify_x_url(url)
    if x_identity is not None:
        return x_ingest.create_or_reuse_x_author_thread_article(
            db=db,
            viewer_id=viewer_id,
            url=url,
            library_ids=library_ids,
        )
    if is_x_url(url):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "X URL must include a valid post ID",
        )

    remote_file_kind = remote_file_ingest.remote_file_kind_from_url(url)
    if remote_file_kind is not None:
        result = remote_file_ingest.create_file_media_from_remote_url(
            db=db,
            viewer_id=viewer_id,
            url=url,
            kind=remote_file_kind,
            library_ids=library_ids,
            request_id=request_id,
        )
        return result

    result = media_service.create_provisional_web_article(
        db,
        viewer_id,
        url,
        library_ids=library_ids,
        enqueue_task=True,
        request_id=request_id,
    )
    return result
