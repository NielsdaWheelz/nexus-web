"""YouTube URL ingest ownership."""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.db.errors import integrity_constraint_name
from nexus.db.models import Media, MediaKind, ProcessingStatus
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.jobs.queue import enqueue_job
from nexus.logging import get_logger
from nexus.schemas.media import FromUrlResponse
from nexus.services import libraries as libraries_service
from nexus.services.url_normalize import validate_requested_url
from nexus.services.youtube_identity import classify_youtube_url

logger = get_logger(__name__)


def create_or_reuse_youtube_video(
    db: Session,
    viewer_id: UUID,
    url: str,
    *,
    enqueue_task: bool = False,
    request_id: str | None = None,
) -> FromUrlResponse:
    """Create or reuse a canonical YouTube video media row."""
    validate_requested_url(url)
    identity = classify_youtube_url(url)
    if identity is None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "URL is not a supported YouTube video URL",
        )

    now = datetime.now(UTC)
    created = False
    media = Media(
        kind=MediaKind.video.value,
        title=f"YouTube Video {identity.provider_video_id}",
        requested_url=url,
        canonical_url=identity.watch_url,
        canonical_source_url=identity.watch_url,
        external_playback_url=identity.watch_url,
        provider=identity.provider,
        provider_id=identity.provider_video_id,
        processing_status=ProcessingStatus.pending,
        created_by_user_id=viewer_id,
        created_at=now,
        updated_at=now,
    )

    try:
        db.add(media)
        db.flush()
        created = True
    except IntegrityError as exc:
        if not _is_media_canonical_url_conflict(exc):
            raise
        db.rollback()
        media = (
            db.query(Media)
            .filter(
                Media.kind == MediaKind.video.value,
                Media.canonical_url == identity.watch_url,
            )
            .limit(1)
            .one_or_none()
        )
        if media is None:
            raise InvalidRequestError(
                ApiErrorCode.E_INTERNAL, "Unable to resolve canonical video row"
            ) from exc
        media.provider = identity.provider
        media.provider_id = identity.provider_video_id
        if not media.external_playback_url:
            media.external_playback_url = identity.watch_url
        if not media.canonical_source_url:
            media.canonical_source_url = identity.watch_url
        media.updated_at = now

    libraries_service.ensure_media_in_default_library(db, viewer_id, media.id)

    ingest_enqueued = False
    try:
        if created and enqueue_task:
            ingest_enqueued = enqueue_youtube_ingest_task(
                db,
                media.id,
                viewer_id,
                request_id,
            )
        db.commit()
    except Exception:
        db.rollback()
        raise

    return FromUrlResponse(
        media_id=media.id,
        idempotency_outcome="created" if created else "reused",
        processing_status=_status_to_str(media.processing_status),
        ingest_enqueued=ingest_enqueued,
    )


def enqueue_youtube_ingest_task(
    db: Session,
    media_id: UUID,
    actor_user_id: UUID,
    request_id: str | None,
) -> bool:
    """Enqueue ingest_youtube_video in the Postgres queue service."""
    try:
        enqueue_job(
            db,
            kind="ingest_youtube_video",
            payload={
                "media_id": str(media_id),
                "actor_user_id": str(actor_user_id),
                "request_id": request_id,
            },
        )
        logger.info(
            "ingest_video_task_enqueued",
            media_id=str(media_id),
            actor_user_id=str(actor_user_id),
            request_id=request_id,
        )
        return True
    except SQLAlchemyError as exc:
        logger.error(
            "ingest_video_task_enqueue_failed",
            media_id=str(media_id),
            actor_user_id=str(actor_user_id),
            request_id=request_id,
            error=str(exc),
        )
        raise ApiError(
            ApiErrorCode.E_INTERNAL,
            "Failed to enqueue ingest_youtube_video job.",
        ) from exc


def _status_to_str(value: object) -> str:
    if isinstance(value, str):
        return value
    enum_value = getattr(value, "value", None)
    if isinstance(enum_value, str):
        return enum_value
    return str(value)


def _is_media_canonical_url_conflict(exc: IntegrityError) -> bool:
    constraint_name = integrity_constraint_name(exc)
    if constraint_name:
        return constraint_name == "uix_media_canonical_url"
    return "uix_media_canonical_url" in str(exc)
