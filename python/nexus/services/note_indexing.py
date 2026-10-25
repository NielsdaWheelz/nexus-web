"""A visible note block's index: its body as one citable block, rebuilt by ``note_reindex_job``.

Every projected body change marks the index ``pending`` (out of search) and leaves a job
that has not started. The job reads the visible body, embeds it with no transaction open,
and publishes only if the body is still the one it embedded, under the owner's account
head (which fences the note projection's only writer); otherwise the merge that changed
it left a newer waiting job, which publishes instead. A deleted note's index is removed.
Exhausted retries mark a still ``pending`` index ``failed`` with the job's code
(``jobs/dead_letters.note_index``).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.session import get_session_factory
from nexus.jobs import queue
from nexus.services import authored
from nexus.services.content_chunking import IndexableBlock, plan_chunks
from nexus.services.content_indexing import (
    IndexOwner,
    delete_content_index,
    mark_content_index_pending,
    publish_content_index,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.suggestion_changes import record_input_change

JOB_KIND = "note_reindex_job"
_BODY = "SELECT body_text, user_id FROM note_blocks WHERE id = :id AND authored_visible"


def enqueue_note_reindex(db: Session, *, note_block_id: UUID, reason: str) -> None:
    """Gate the note out of search and make sure a job that has not started rebuilds it.

    The caller has just written the body, so it holds the note row. A running job may
    have read the body before this change, so only an unclaimed job counts. Writers
    without a common lock may both enqueue; the second job republishes the same body.
    """
    mark_content_index_pending(db, owner=IndexOwner("note_block", note_block_id), reason=reason)
    jobs = queue.jobs_for_payload(
        db, kind=JOB_KIND, match={"note_block_id": str(note_block_id)}, lock=True
    )
    if not any(job.status in ("pending", "failed") for job in jobs):
        payload = {"note_block_id": str(note_block_id), "reason": reason}
        queue.enqueue_job(db, kind=JOB_KIND, payload=payload)


def run_note_reindex_job(
    *, payload: Mapping[str, Any], context: queue.JobExecutionContext
) -> dict[str, object]:
    """Read the body, embed it with no transaction open, publish if the body is unchanged."""
    # Imported here: discovery pulls in the generation stack, which the api's import of
    # this module must not.
    from nexus.services import connection_discovery

    note_block_id, reason = UUID(payload["note_block_id"]), str(payload["reason"])
    owner = IndexOwner("note_block", note_block_id)
    result: dict[str, object] = {"owner": {"kind": owner.kind, "id": str(note_block_id)}}
    with get_session_factory()() as db:
        snapshot = db.execute(text(_BODY), {"id": note_block_id}).one_or_none()
    body = "" if snapshot is None else snapshot.body_text
    blocks = _note_blocks(note_block_id, body)
    chunks = list(plan_chunks(blocks, max_bytes=None))
    with get_session_factory()() as db:
        # Exclude merges before replacing the index; the owner never changes.
        account = db.scalar(
            text("SELECT user_id FROM note_blocks WHERE id = :id"), {"id": note_block_id}
        )
        if account is not None:
            authored.lock_account(db, account)
        current = db.execute(text(_BODY), {"id": note_block_id}).one_or_none()
        if current is None:
            delete_content_index(db, owner=owner)
            record_input_change(db)
            db.commit()
            return result | {"status": "no_text", "chunk_count": 0}
        if current.body_text != body:
            return result | {"status": "superseded"}
        published = publish_content_index(
            db, owner=owner, source_kind="note", blocks=blocks, chunks=chunks, reason=reason
        )
        connection_discovery.queue_connection_discovery_scan(
            db,
            user_id=current.user_id,
            ref=ResourceRef(scheme="note_block", id=note_block_id),
            reason="note_reindex",
        )
        record_input_change(db)
        db.commit()
    return result | {"status": published.status, "chunk_count": published.chunk_count}


def _note_blocks(note_block_id: UUID, body: str) -> list[IndexableBlock]:
    """The whole body as one block; its chunks never leave it (the anchor is the block)."""
    if not body.strip():
        return []
    locator: dict[str, object] = {
        "kind": "note_text",
        "note_block_id": str(note_block_id),
        "start_offset": 0,
        "end_offset": len(body),
    }
    return [IndexableBlock(body, 0, locator)]
