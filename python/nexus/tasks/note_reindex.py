"""Worker job handler for note body content indexing."""

from dataclasses import asdict
from uuid import UUID

from nexus.db.models import NoteBlock
from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode
from nexus.logging import get_logger
from nexus.services import synapse
from nexus.services.note_indexing import rebuild_note_content_index
from nexus.services.resource_graph.refs import ResourceRef

logger = get_logger(__name__)


def note_reindex_job(
    note_block_id: str,
    reason: str = "note_edit",
    request_id: str | None = None,
    task_id: str | None = None,
) -> dict:
    resolved_task_id = task_id or f"direct:{note_block_id}"
    try:
        block_id = UUID(note_block_id)
    except (TypeError, ValueError):
        logger.error(
            "note_reindex_invalid_note_block_id",
            note_block_id=note_block_id,
            reason=reason,
            request_id=request_id,
            task_id=resolved_task_id,
        )
        return {"status": "failed", "error_code": ApiErrorCode.E_INVALID_REQUEST.value}

    db = get_session_factory()()
    try:
        result = asdict(rebuild_note_content_index(db, note_block_id=block_id, reason=reason))
        block = db.get(NoteBlock, block_id)
        if block is not None:
            synapse.queue_synapse_scan(
                db,
                user_id=block.user_id,
                ref=ResourceRef(scheme="note_block", id=block_id),
                reason="note_reindex",
            )
        db.commit()
        logger.info(
            "note_reindex_task_completed",
            note_block_id=note_block_id,
            reason=reason,
            request_id=request_id,
            result=result,
            task_id=resolved_task_id,
        )
        return result
    except Exception as exc:
        db.rollback()
        logger.exception(
            "note_reindex_task_failed",
            note_block_id=note_block_id,
            reason=reason,
            request_id=request_id,
            task_id=resolved_task_id,
            error=str(exc),
        )
        raise
    finally:
        db.close()
