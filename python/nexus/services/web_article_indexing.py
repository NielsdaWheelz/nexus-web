"""Web article evidence indexing ownership."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy.orm import Session

from nexus.db.models import Fragment, Media
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services.content_indexing import (
    mark_content_index_failed,
    rebuild_fragment_content_index,
)
from nexus.services.media_processing_state import mark_stage_warning

logger = get_logger(__name__)


def index_web_article_evidence(
    db: Session,
    *,
    media_id: UUID,
    fragment_id: UUID,
    fragments: list[Fragment],
    reason: str,
    language: str | None,
    request_id: str | None,
    log_event: str = "web_article_content_index_failed",
) -> None:
    try:
        rebuild_fragment_content_index(
            db,
            media_id=media_id,
            source_kind="web_article",
            fragments=fragments,
            reason=reason,
            language=language,
        )
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.exception(
            log_event,
            media_id=str(media_id),
            request_id=request_id,
            error=str(exc),
        )
        media = db.get(Media, media_id)
        if media is None:
            return
        error_code = (
            exc.code.value if isinstance(exc, ApiError) else ApiErrorCode.E_INGEST_FAILED.value
        )
        failure_message = f"Web article evidence index failed: {exc}"[:1000]
        mark_stage_warning(
            db,
            media,
            stage="embed",
            error_code=error_code,
            error_message=failure_message,
        )
        mark_content_index_failed(
            db,
            media_id=media_id,
            failure_code=error_code,
            failure_message=failure_message,
        )
        db.commit()
