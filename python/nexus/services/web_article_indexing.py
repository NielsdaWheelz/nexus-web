"""Web article evidence indexing ownership."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.db.models import FailureStage, Fragment, Media
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services.content_indexing import (
    mark_content_index_failed,
    rebuild_fragment_content_index,
)

logger = get_logger(__name__)


def rebuild_web_article_index_or_mark_failed(
    db: Session,
    *,
    media_id: UUID,
    fragment_id: UUID,
    fragments: list[Fragment],
    reason: str,
    language: str | None,
    log_event: str,
) -> None:
    try:
        rebuild_fragment_content_index(
            db,
            media_id=media_id,
            source_kind="web_article",
            artifact_ref=f"fragments:{fragment_id}",
            fragments=fragments,
            reason=reason,
            language=language,
        )
        db.commit()
    except (SQLAlchemyError, ApiError) as exc:
        db.rollback()
        logger.exception(log_event, media_id=str(media_id), error=str(exc))
        media = db.get(Media, media_id)
        if media is None:
            return
        error_code = (
            exc.code.value if isinstance(exc, ApiError) else ApiErrorCode.E_INGEST_FAILED.value
        )
        failed_at = datetime.now(UTC)
        failure_message = f"Web article evidence index failed: {exc}"[:1000]
        media.failure_stage = FailureStage.embed
        media.last_error_code = error_code
        media.last_error_message = failure_message
        media.failed_at = failed_at
        media.updated_at = failed_at
        mark_content_index_failed(
            db,
            media_id=media_id,
            failure_code=error_code,
            failure_message=failure_message,
        )
        db.commit()
