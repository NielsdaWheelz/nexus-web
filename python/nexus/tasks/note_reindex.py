"""Worker handler for ``note_reindex_job``."""

from uuid import UUID

from nexus.db.models import NoteBlock
from nexus.db.session import get_session_factory
from nexus.jobs.queue import JobExecutionContext
from nexus.logging import get_logger
from nexus.services import synapse
from nexus.services.note_indexing import rebuild_note_content_index
from nexus.services.resource_graph.refs import ResourceRef

logger = get_logger(__name__)


def note_reindex_job(note_block_id: str, reason: str, context: JobExecutionContext) -> dict:
    block_id = UUID(note_block_id)
    db = get_session_factory()()
    try:
        index_result = rebuild_note_content_index(db, note_block_id=block_id, reason=reason)
        block = db.get(NoteBlock, block_id)
        if block is not None:
            synapse.queue_synapse_scan(
                db,
                user_id=block.user_id,
                ref=ResourceRef(scheme="note_block", id=block_id),
                reason="note_reindex",
            )
        db.commit()
        return {
            "owner": {"kind": index_result.owner.kind, "id": str(index_result.owner.id)},
            "status": index_result.status,
            "chunk_count": index_result.chunk_count,
        }
    except Exception:
        db.rollback()
        logger.exception(
            "note_reindex_task_failed",
            note_block_id=note_block_id,
            reason=reason,
            job_id=str(context.job_id),
        )
        raise
    finally:
        db.close()
