"""The one bridge between note bodies and the shared content index."""

from uuid import UUID

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.errors import integrity_constraint_name
from nexus.db.models import NoteBlock
from nexus.jobs.queue import enqueue_job
from nexus.services.content_indexing import (
    ContentIndexResult,
    IndexableBlock,
    IndexOwner,
    delete_content_index,
    mark_content_index_pending,
    rebuild_content_index,
)


def build_note_indexable_blocks(block: NoteBlock) -> list[IndexableBlock]:
    body = block.body_text or ""
    if not body.strip():
        return []
    return [
        IndexableBlock(
            owner=IndexOwner("note_block", block.id),
            source_kind="note",
            block_idx=0,
            block_kind="note",
            canonical_text=body,
            source_start_offset=0,
            source_end_offset=len(body),
            locator={
                "kind": "note_text",
                "note_block_id": str(block.id),
                "start_offset": 0,
                "end_offset": len(body),
                "text_quote": {"exact": body, "prefix": "", "suffix": ""},
            },
            heading_path=(),
        )
    ]


def rebuild_note_content_index(
    db: Session, *, note_block_id: UUID, reason: str
) -> ContentIndexResult:
    owner = IndexOwner("note_block", note_block_id)
    block = db.get(NoteBlock, note_block_id)
    if block is None:
        delete_content_index(db, owner=owner)
        return ContentIndexResult(owner=owner, status="no_text", chunk_count=0)
    return rebuild_content_index(
        db,
        owner=owner,
        source_kind="note",
        blocks=build_note_indexable_blocks(block),
        reason=reason,
    )


def enqueue_note_reindex(db: Session, *, note_block_id: UUID, reason: str) -> None:
    """At most one inflight job per block: the partial unique index is the guard."""
    mark_content_index_pending(db, owner=IndexOwner("note_block", note_block_id), reason=reason)
    try:
        with db.begin_nested():
            enqueue_job(
                db,
                kind="note_reindex_job",
                payload={"note_block_id": str(note_block_id), "reason": reason},
            )
    except IntegrityError as exc:
        if integrity_constraint_name(exc) != "uq_note_reindex_job_inflight":
            raise
