"""Worker job handler for debounced note-page content reindex."""

from dataclasses import asdict
from uuid import UUID

from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode
from nexus.logging import get_logger
from nexus.services.note_indexing import rebuild_page_content_index

logger = get_logger(__name__)


def page_reindex_job(
    page_id: str,
    reason: str = "note_edit",
    request_id: str | None = None,
    task_id: str | None = None,
) -> dict:
    resolved_task_id = task_id or f"direct:{page_id}"
    try:
        page_uuid = UUID(page_id)
    except (TypeError, ValueError):
        logger.error(
            "page_reindex_invalid_page_id",
            page_id=page_id,
            reason=reason,
            request_id=request_id,
            task_id=resolved_task_id,
        )
        return {"status": "failed", "error_code": ApiErrorCode.E_INVALID_REQUEST.value}

    logger.info(
        "page_reindex_task_started",
        page_id=page_id,
        reason=reason,
        request_id=request_id,
        task_id=resolved_task_id,
    )
    db = get_session_factory()()
    try:
        result = asdict(rebuild_page_content_index(db, page_id=page_uuid, reason=reason))
        db.commit()
        logger.info(
            "page_reindex_task_completed",
            page_id=page_id,
            reason=reason,
            request_id=request_id,
            result=result,
            task_id=resolved_task_id,
        )
        return result
    # justify-ignore-error: log + roll back, then re-raise so the worker applies the
    # configured retry budget (registry: 60/300/900s). The page index stays 'pending'
    # across retries and is marked 'failed' only once attempts are exhausted
    # (registry._dead_letter_page_reindex), so a transient embedder/DB blip recovers
    # on its own instead of stranding the page after one failure.
    except Exception as exc:
        db.rollback()
        logger.exception(
            "page_reindex_task_failed",
            page_id=page_id,
            reason=reason,
            request_id=request_id,
            task_id=resolved_task_id,
            error=str(exc),
        )
        raise
    finally:
        db.close()
