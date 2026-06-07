"""Note source adapter: index a page's note_blocks into the shared content/evidence
pipeline (the one mechanism that already serves media), via a debounced reindex job."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.errors import integrity_constraint_name
from nexus.db.models import NoteBlock, Page, note_block_sibling_sort_key
from nexus.jobs.queue import enqueue_job
from nexus.services.content_indexing import (
    ContentIndexResult,
    IndexableBlock,
    IndexOwner,
    delete_content_index,
    mark_content_index_pending,
    rebuild_content_index,
)


def build_page_indexable_blocks(db: Session, page: Page) -> list[IndexableBlock]:
    """One IndexableBlock per non-empty note_block, in the page's render (DFS) order."""
    owner = IndexOwner("page", page.id)
    blocks: list[IndexableBlock] = []
    source_offset = 0
    for note_block, heading_path in _blocks_in_render_order(db, page.id):
        body = note_block.body_text or ""
        if not body.strip():
            continue
        if blocks:
            source_offset += 2
        locator = {
            "kind": "note_text",
            "note_block_id": str(note_block.id),
            "page_id": str(page.id),
            "start_offset": 0,
            "end_offset": len(body),
            "text_quote": {"exact": body, "prefix": "", "suffix": ""},
        }
        blocks.append(
            IndexableBlock(
                owner=owner,
                source_kind="note",
                block_idx=len(blocks),
                block_kind="note_block",
                canonical_text=body,
                extraction_confidence=None,
                source_start_offset=source_offset,
                source_end_offset=source_offset + len(body),
                locator=locator,
                selector=locator,
                heading_path=heading_path,
                metadata={},
            )
        )
        source_offset += len(body)
    return blocks


def rebuild_page_content_index(db: Session, *, page_id: UUID, reason: str) -> ContentIndexResult:
    owner = IndexOwner("page", page_id)
    page = db.get(Page, page_id)
    if page is None:
        delete_content_index(db, owner=owner)
        return ContentIndexResult(owner=owner, status="no_text", chunk_count=0)
    return rebuild_content_index(
        db,
        owner=owner,
        source_kind="note",
        blocks=build_page_indexable_blocks(db, page),
        reason=reason,
    )


def enqueue_page_reindex(db: Session, *, page_id: UUID, reason: str) -> None:
    """Mark the page stale and ensure exactly one in-flight reindex for it.

    Rapid edits coalesce onto the queued/running job (uq_page_reindex_job_inflight);
    once that job reaches a terminal state the next edit enqueues a fresh one, so an
    edit is never silently dropped. The job rebuilds from current state, so coalesced
    edits all land. Does not commit — the caller's commit flushes the pending state +
    job row atomically.
    """
    mark_content_index_pending(db, owner=IndexOwner("page", page_id), reason=reason)
    try:
        with db.begin_nested():
            enqueue_job(
                db,
                kind="page_reindex_job",
                payload={"page_id": str(page_id), "reason": reason},
            )
    except IntegrityError as exc:
        # An in-flight reindex already covers this page; it rebuilds from current state,
        # so this edit lands without a second job.
        if integrity_constraint_name(exc) != "uq_page_reindex_job_inflight":
            raise


def _blocks_in_render_order(db: Session, page_id: UUID) -> list[tuple[NoteBlock, tuple[str, ...]]]:
    """Every note_block of the page in DFS render order, each paired with its ancestor
    heading_path. Sibling order is the canonical NOTE_BLOCK_SIBLING_ORDER (render order)."""
    by_parent: dict[UUID | None, list[NoteBlock]] = {}
    for block in db.scalars(select(NoteBlock).where(NoteBlock.page_id == page_id)):
        by_parent.setdefault(block.parent_block_id, []).append(block)
    for siblings in by_parent.values():
        siblings.sort(key=note_block_sibling_sort_key)

    ordered: list[tuple[NoteBlock, tuple[str, ...]]] = []

    def walk(parent_id: UUID | None, heading_path: tuple[str, ...]) -> None:
        for block in by_parent.get(parent_id, []):
            ordered.append((block, heading_path))
            body = block.body_text or ""
            walk(block.id, (*heading_path, body) if body.strip() else heading_path)

    walk(None, ())
    return ordered
