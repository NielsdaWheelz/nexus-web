"""Web article retry lifecycle orchestration.

Routes own HTTP concerns; this module owns retry guards, artifact cleanup, and
dispatch for failed URL-backed web articles.
"""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import delete, select, text
from sqlalchemy.orm import Session

from nexus.db.models import (
    Fragment,
    FragmentBlock,
    Highlight,
    HighlightFragmentAnchor,
    Media,
    MediaAuthor,
    MediaKind,
    ProcessingStatus,
)
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    ConflictError,
    ForbiddenError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.jobs.queue import enqueue_job
from nexus.logging import get_logger

logger = get_logger(__name__)


def retry_web_article_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    request_id: str | None = None,
) -> dict:
    """Retry failed URL-backed web article ingestion from the original URL."""
    from nexus.auth.permissions import can_read_media

    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    if media.kind != MediaKind.web_article.value:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Retry is only supported for web article media.",
        )

    if media.created_by_user_id != viewer_id:
        raise ForbiddenError(
            ApiErrorCode.E_FORBIDDEN,
            "Only the creator can retry extraction.",
        )

    if media.processing_status != ProcessingStatus.failed:
        raise ConflictError(
            ApiErrorCode.E_RETRY_INVALID_STATE,
            "Media must be in failed state to retry.",
        )

    if not media.requested_url:
        raise ConflictError(
            ApiErrorCode.E_RETRY_NOT_ALLOWED,
            "Retry not allowed because the original URL is missing.",
        )

    _delete_web_article_artifacts(db, media_id)

    now = datetime.now(UTC)
    media.processing_status = ProcessingStatus.extracting
    media.processing_attempts = (media.processing_attempts or 0) + 1
    media.processing_started_at = now
    media.failure_stage = None
    media.last_error_code = None
    media.last_error_message = None
    media.failed_at = None
    media.updated_at = now
    db.flush()

    try:
        enqueue_job(
            db,
            kind="ingest_web_article",
            payload={
                "media_id": str(media.id),
                "actor_user_id": str(viewer_id),
                "request_id": request_id,
            },
        )
    except Exception as exc:
        db.rollback()
        logger.error(
            "web_article_retry_dispatch_failed",
            media_id=str(media.id),
            error=str(exc),
        )
        raise ApiError(
            ApiErrorCode.E_INTERNAL,
            "Failed to enqueue retry job.",
        ) from exc

    db.commit()

    return {
        "media_id": str(media.id),
        "processing_status": "extracting",
        "retry_enqueued": True,
    }


def _delete_web_article_artifacts(db: Session, media_id: UUID) -> None:
    """Delete retry-rebuildable artifacts for a web article media row."""
    fragment_ids = (
        db.execute(select(Fragment.id).where(Fragment.media_id == media_id)).scalars().all()
    )

    db.execute(
        text(
            """
            DELETE FROM content_chunks
            WHERE media_id = :media_id
               OR fragment_id IN (
                    SELECT id FROM fragments WHERE media_id = :media_id
               )
            """
        ),
        {"media_id": media_id},
    )

    if fragment_ids:
        db.execute(
            delete(Highlight).where(
                Highlight.id.in_(
                    select(HighlightFragmentAnchor.highlight_id).where(
                        HighlightFragmentAnchor.fragment_id.in_(fragment_ids)
                    )
                )
            )
        )
        db.execute(delete(FragmentBlock).where(FragmentBlock.fragment_id.in_(fragment_ids)))

    db.execute(delete(Fragment).where(Fragment.media_id == media_id))
    db.execute(delete(MediaAuthor).where(MediaAuthor.media_id == media_id))
    db.flush()
