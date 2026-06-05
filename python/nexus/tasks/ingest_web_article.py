"""Thin worker wrapper for web article ingestion."""

from uuid import UUID

from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode
from nexus.logging import get_logger
from nexus.services.web_article_ingest import (
    mark_web_article_failed,
    run_ingest_sync,
)

logger = get_logger(__name__)


def ingest_web_article(
    media_id: str,
    actor_user_id: str,
    request_id: str | None = None,
) -> dict[str, object]:
    """Execute web article ingestion using the service owner."""
    media_uuid = UUID(media_id)
    actor_uuid = UUID(actor_user_id)

    logger.info(
        "ingest_web_article_started",
        media_id=media_id,
        actor_user_id=actor_user_id,
        request_id=request_id,
    )

    session_factory = get_session_factory()
    db = session_factory()
    try:
        result = run_ingest_sync(db, media_uuid, actor_uuid, request_id)
        logger.info(
            "ingest_web_article_completed",
            media_id=media_id,
            result=result,
            request_id=request_id,
        )
        return result
    except Exception as exc:
        logger.error(
            "ingest_web_article_failed",
            media_id=media_id,
            error=str(exc),
            request_id=request_id,
        )
        try:
            mark_web_article_failed(
                db,
                media_uuid,
                ApiErrorCode.E_INGEST_FAILED,
                f"Unexpected error: {exc}",
            )
        except Exception:
            logger.exception("ingest_web_article_failed_to_mark_failed", media_id=media_id)
        raise
    finally:
        db.close()
