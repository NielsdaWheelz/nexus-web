"""Note source adapter: index a page's note_blocks into the shared content/evidence
pipeline (the one mechanism that already serves media), via a debounced reindex job."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.errors import integrity_constraint_name
from nexus.db.models import Page
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
    for node, heading_path in _blocks_in_render_order(db, page):
        note_block = node.block
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


def enqueue_page_reindex(db: Session, *, page_id: UUID, reason: str) -> UUID:
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
            job = enqueue_job(
                db,
                kind="page_reindex_job",
                payload={"page_id": str(page_id), "reason": reason},
            )
            return job.id
    except IntegrityError as exc:
        # An in-flight reindex already covers this page; it rebuilds from current state,
        # so this edit lands without a second job.
        if integrity_constraint_name(exc) != "uq_page_reindex_job_inflight":
            raise
        job_id = _inflight_page_reindex_job_id(db, page_id=page_id)
        if job_id is None:
            raise
        return job_id


def _inflight_page_reindex_job_id(db: Session, *, page_id: UUID) -> UUID | None:
    return db.scalar(
        text(
            """
            SELECT id
            FROM background_jobs
            WHERE kind = 'page_reindex_job'
              AND payload->>'page_id' = :page_id
              AND status NOT IN ('succeeded', 'dead')
            ORDER BY created_at ASC, id ASC
            LIMIT 1
            """
        ),
        {"page_id": str(page_id)},
    )


def _blocks_in_render_order(db: Session, page: Page) -> list[tuple[object, tuple[str, ...]]]:
    """Every note_block of the page in graph DFS order with ancestor heading_path."""
    from nexus.services.resource_graph import documents as graph_documents

    document = graph_documents.load_page_document(db, user_id=page.user_id, page_id=page.id)
    ordered: list[tuple[object, tuple[str, ...]]] = []

    def walk(nodes: list[object], heading_path: tuple[str, ...]) -> None:
        for node in nodes:
            ordered.append((node, heading_path))
            body = node.block.body_text or ""
            walk(node.children, (*heading_path, body) if body.strip() else heading_path)

    walk(document.roots, ())
    return ordered
