"""Revision- and claim-fenced note text publication, then semantic completion.

Edits hold note → queue → index state, raise the revision and coalesce waiting work.
Both publications recheck that revision, exact claim and source body. Text commits
before provider work and survives failures; retries embed its existing ids. Completed
outcomes replay without changing ids, timestamps or connection-discovery effects.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from provider_runtime.errors import CredentialMissing
from sqlalchemy import Row, text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode
from nexus.jobs import queue
from nexus.services.content_chunking import (
    EnvelopeExceeded,
    IndexableBlock,
    read_embeddings,
    read_spool,
    spool_chunks,
    spool_embeddings,
)
from nexus.services.content_indexing import (
    ContentIndexResult,
    IndexOwner,
    completed_content_index,
    index_phase,
    mark_content_index_pending,
    publish_embeddings,
    publish_text_index,
    snapshot_published_chunks,
)
from nexus.services.parser_temp import parser_attempt_directory
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.suggestion_changes import record_input_change

JOB_KIND = "note_reindex_job"
_BODY = "SELECT body_text, user_id FROM note_blocks WHERE id = :id"


def enqueue_note_reindex(db: Session, *, note_block_id: UUID, reason: str) -> None:
    """Raise revision and reset one unclaimed job; a running old revision is superseded.

    The body writer holds the note row. Queue rows precede state, matching the
    dead-letter owner's queue → state lock order. Retry rule: each body edit requests
    a new revision in its owner transaction; unclaimed jobs coalesce to the latest.
    """
    jobs = queue.jobs_for_payload(
        db, kind=JOB_KIND, match={"note_block_id": str(note_block_id)}, lock=True
    )
    revision = mark_content_index_pending(
        db, owner=IndexOwner("note_block", note_block_id), reason=reason
    )
    payload = {"note_block_id": str(note_block_id), "revision": revision, "reason": reason}
    waiting = [job for job in jobs if job.status in ("pending", "failed")]
    for obsolete in waiting[1:]:
        queue.supersede_unclaimed_job(db, job_id=obsolete.id, kind=JOB_KIND)
    if waiting:
        queue.reset_unclaimed_job(db, job_id=waiting[0].id, kind=JOB_KIND, payload=payload)
    else:
        queue.enqueue_job(db, kind=JOB_KIND, payload=payload)


def run_note_reindex_job(
    *, payload: Mapping[str, Any], context: queue.JobExecutionContext
) -> queue.JobResult:
    """Publish local text first; complete semantics only for its exact ids and revision."""
    from nexus.services import connection_discovery

    note_block_id, revision, reason = (
        UUID(payload["note_block_id"]),
        int(payload["revision"]),
        str(payload["reason"]),
    )
    owner = IndexOwner("note_block", note_block_id)
    result: dict[str, object] = {"owner": {"kind": owner.kind, "id": str(note_block_id)}}

    def fence(db: Session, body: str | None = None) -> tuple[Row[Any], Row[Any]] | None:
        current = db.execute(text(_BODY + " FOR UPDATE"), {"id": note_block_id}).one_or_none()
        if current is None or queue.lock_running_job_claim(db, context=context) is None:
            return None
        state = db.execute(
            text(
                "SELECT revision, lexical_revision, status, active_embedding_provider AS provider,"
                " active_embedding_model AS model FROM content_index_states"
                " WHERE owner_kind = 'note_block' AND owner_id = :id FOR UPDATE"
            ),
            {"id": note_block_id},
        ).one()
        if state.revision != revision or (body is not None and current.body_text != body):
            return None
        return current, state

    def completion_effects(db: Session, user_id: UUID) -> None:
        connection_discovery.queue_connection_discovery_scan(
            db,
            user_id=user_id,
            ref=ResourceRef(scheme="note_block", id=note_block_id),
            reason="note_reindex",
        )
        record_input_change(db)

    def prepare(db: Session) -> ContentIndexResult | tuple[str, bool] | None:
        snapshot = fence(db)
        if snapshot is None:
            return None
        current, state = snapshot
        completed = completed_content_index(db, owner, state)
        if completed is not None:
            return completed
        db.execute(
            text(
                "UPDATE content_index_states SET status = 'indexing', status_reason = :reason,"
                " active_embedding_provider = NULL, active_embedding_model = NULL, updated_at = now()"
                " WHERE owner_kind = 'note_block' AND owner_id = :id"
            ),
            {"id": note_block_id, "reason": reason},
        )
        return current.body_text, state.lexical_revision == revision

    work = index_phase("prepare_note_index", prepare)
    if work is None:
        return result | {"status": "superseded"}
    if isinstance(work, ContentIndexResult):
        return result | {"status": work.status, "chunk_count": work.chunk_count}
    body, lexical_ready = work
    with parser_attempt_directory(context.job_id) as directory:
        chunks_spool = directory / "text.jsonl"
        embedding_spool = directory / "embeddings.jsonl"
        try:
            if not lexical_ready:
                blocks = _note_blocks(note_block_id, body)
                spool_chunks(blocks, chunks_spool)

                def publish_text(db: Session) -> ContentIndexResult | None:
                    snapshot = fence(db, body)
                    if snapshot is None:
                        return None
                    published = publish_text_index(
                        db,
                        owner=owner,
                        source_kind="note",
                        blocks=blocks,
                        chunks=read_spool(chunks_spool),
                        reason=reason,
                    )
                    if published.status != "indexing":
                        completion_effects(db, snapshot[0].user_id)
                    else:
                        record_input_change(db)
                    return published

                published = index_phase("publish_note_text", publish_text)
                if published is None:
                    return result | {"status": "superseded"}
                if published.status != "indexing":
                    return result | {
                        "status": published.status,
                        "chunk_count": published.chunk_count,
                    }

            def snapshot_chunks(db: Session) -> bool:
                snapshot = fence(db, body)
                if snapshot is None or snapshot[1].lexical_revision != revision:
                    return False
                snapshot_published_chunks(db, owner, chunks_spool)
                return True

            if not index_phase("snapshot_note_chunks", snapshot_chunks):
                return result | {"status": "superseded"}
            spool_embeddings(chunks_spool, embedding_spool)
        except CredentialMissing:
            return queue.TerminalJobFailure(
                result_payload=result | {"status": "embedding_not_configured"},
                error_code=ApiErrorCode.E_EMBEDDING_NOT_CONFIGURED.value,
                error_message="No embedding provider credential is configured.",
            )
        except EnvelopeExceeded:
            return queue.TerminalJobFailure(
                result_payload=result | {"status": "too_large"},
                error_code=ApiErrorCode.E_SOURCE_TOO_LARGE.value,
                error_message="Document content exceeds the bounded indexing envelope.",
            )

        def publish(db: Session) -> ContentIndexResult | None:
            snapshot = fence(db, body)
            if snapshot is None or snapshot[1].lexical_revision != revision:
                return None
            published = publish_embeddings(
                db, owner=owner, embeddings=read_embeddings(embedding_spool), reason=reason
            )
            completion_effects(db, snapshot[0].user_id)
            return published

        published = index_phase("publish_note_embeddings", publish)
    if published is None:
        return result | {"status": "superseded"}
    return result | {"status": published.status, "chunk_count": published.chunk_count}


def _note_blocks(note_block_id: UUID, body: str) -> list[IndexableBlock]:
    """The body is one citable block; chunk windows never leave its anchor."""
    if not body.strip():
        return []
    locator: dict[str, object] = {
        "kind": "note_text",
        "note_block_id": str(note_block_id),
        "start_offset": 0,
        "end_offset": len(body),
    }
    return [IndexableBlock(body, 0, locator)]
