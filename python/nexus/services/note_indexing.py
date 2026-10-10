"""A note block's index: its body as one citable block, rebuilt by ``note_reindex_job``.

Every body change marks the index ``pending`` (out of search) and leaves a job that has
not started. The job reads the body, embeds it with no transaction open, and publishes
only if the body is still the one it embedded; otherwise the edit that changed it left
a newer waiting job, which publishes instead. Exhausted retries mark a still ``pending``
index ``failed`` (``jobs/dead_letter_projections``, ``NoteContentIndex``).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.session import get_session_factory
from nexus.jobs import queue
from nexus.services.content_chunking import IndexableBlock, plan_chunks
from nexus.services.content_indexing import (
    IndexOwner,
    delete_content_index,
    mark_content_index_pending,
    publish_content_index,
)
from nexus.services.resource_graph.refs import ResourceRef

JOB_KIND = "note_reindex_job"
_BODY = "SELECT body_text, user_id FROM note_blocks WHERE id = :id"


def enqueue_note_reindex(db: Session, *, note_block_id: UUID, reason: str) -> None:
    """Gate the note out of search and make sure a job that has not started rebuilds it.

    The caller has just written the body, so it holds the note row. A running job may
    have read the body before this change, so only an unclaimed job counts. Writers
    without a common lock may both enqueue; the second job republishes the same body.
    """
    mark_content_index_pending(db, owner=IndexOwner("note_block", note_block_id), reason=reason)
    jobs = queue.lock_jobs_for_payload(
        db, kind=JOB_KIND, expected_payload_match={"note_block_id": str(note_block_id)}
    )
    if not any(job.status in ("pending", "failed") and job.claimed_by is None for job in jobs):
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
        # Edits update the row, so this share lock orders the check before or after them.
        current = db.execute(text(_BODY + " FOR SHARE"), {"id": note_block_id}).one_or_none()
        if current is None:
            delete_content_index(db, owner=owner)
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
