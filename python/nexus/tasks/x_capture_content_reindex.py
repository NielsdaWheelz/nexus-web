"""Index one immutable x fragment through the ordinary text and embedding pipeline.

The payload is only capture_id. Capture and index-state locks serialize duplicate
jobs; each publication also requires its live queue claim. Lexical text commits
before provider work, and retries embed its existing chunk ids. No source attempt
or import history belongs to an unsaved capture.
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
from nexus.services.library_entries import lock_media_rows_in_order
from nexus.services.media_text_scope import x_capture_scope_rows_sql
from nexus.services.parser_temp import parser_attempt_directory
from nexus.services.suggestion_changes import record_input_change


def run_job(*, payload: Mapping[str, Any], context: queue.JobExecutionContext) -> queue.JobResult:
    capture_id = UUID(payload["capture_id"])
    result: dict[str, object] = {"capture_id": str(capture_id)}

    def fence(db: Session) -> tuple[Row[Any], Row[Any]] | None:
        # Summary effects share these parent locks with publication and deletion.
        parents = list(
            db.scalars(
                text(f"""
            SELECT DISTINCT x.reading_media_id
            FROM ({x_capture_scope_rows_sql("SELECT id AS media_id FROM media")}) x
            WHERE x.capture_id=:id ORDER BY x.reading_media_id
        """),
                {"id": capture_id},
            )
        )
        lock_media_rows_in_order(db, parents, lock_mode="no_key_update")
        current = db.execute(
            text("""
            SELECT f.id AS fragment_id, f.canonical_text FROM x_post_captures c
            JOIN fragments f ON f.x_post_capture_id=c.id WHERE c.id=:id
            FOR UPDATE OF c, f
        """),
            {"id": capture_id},
        ).one_or_none()
        if current is None or queue.lock_running_job_claim(db, context=context) is None:
            return None
        owner = IndexOwner("fragment", current.fragment_id)
        state = db.execute(
            text("""
            SELECT revision,lexical_revision,status,active_embedding_provider AS provider,
                   active_embedding_model AS model FROM content_index_states
            WHERE owner_kind='fragment' AND owner_id=:id FOR UPDATE
        """),
            {"id": owner.id},
        ).one_or_none()
        if state is None:
            mark_content_index_pending(db, owner=owner, reason="capture")
            state = db.execute(
                text("""
                SELECT revision,lexical_revision,status,active_embedding_provider AS provider,
                       active_embedding_model AS model FROM content_index_states
                WHERE owner_kind='fragment' AND owner_id=:id
            """),
                {"id": owner.id},
            ).one()
        return current, state

    def prepare(db: Session) -> ContentIndexResult | tuple[UUID, str, bool] | None:
        snapshot = fence(db)
        if snapshot is None:
            return None
        current, state = snapshot
        owner = IndexOwner("fragment", current.fragment_id)
        completed = completed_content_index(db, owner, state)
        if completed is not None:
            return completed
        db.execute(
            text("""
            UPDATE content_index_states SET status='indexing',status_reason='capture',
                active_embedding_provider=NULL,active_embedding_model=NULL,updated_at=now()
            WHERE owner_kind='fragment' AND owner_id=:id
        """),
            {"id": owner.id},
        )
        return owner.id, current.canonical_text, state.lexical_revision == state.revision

    work = index_phase("prepare_x_capture_index", prepare)
    if work is None:
        return result | {"status": "superseded"}
    if isinstance(work, ContentIndexResult):
        return result | {"status": work.status, "chunk_count": work.chunk_count}
    fragment_id, body, lexical_ready = work
    owner = IndexOwner("fragment", fragment_id)
    with parser_attempt_directory(context.job_id) as directory:
        chunks_path = directory / "chunks.jsonl"
        embeddings_path = directory / "embeddings.jsonl"
        try:
            if not lexical_ready:
                blocks = (
                    [
                        IndexableBlock(
                            body,
                            0,
                            {
                                "type": "x_capture_offsets",
                                "kind": "x_capture_text",
                                "capture_id": str(capture_id),
                                "fragment_id": str(fragment_id),
                                "start_offset": 0,
                                "end_offset": len(body),
                            },
                        )
                    ]
                    if body.strip()
                    else []
                )
                spool_chunks(blocks, chunks_path)

                def publish_text(db: Session) -> ContentIndexResult | None:
                    snapshot = fence(db)
                    if snapshot is None:
                        return None
                    completed = completed_content_index(db, owner, snapshot[1])
                    if completed is not None:
                        return completed
                    if snapshot[1].lexical_revision == snapshot[1].revision:
                        return ContentIndexResult(owner, "indexing", 0)
                    published = publish_text_index(
                        db,
                        owner=owner,
                        source_kind="web_article",
                        blocks=blocks,
                        chunks=read_spool(chunks_path),
                        reason="capture",
                    )
                    record_input_change(db, owners=(f"fragment:{fragment_id}",))
                    return published

                published = index_phase("publish_x_capture_text", publish_text)
                if published is None:
                    return result | {"status": "superseded"}
                if published.status != "indexing":
                    return result | {
                        "status": published.status,
                        "chunk_count": published.chunk_count,
                    }

            def snapshot_chunks(db: Session) -> bool:
                snapshot = fence(db)
                if snapshot is None or snapshot[1].lexical_revision != snapshot[1].revision:
                    return False
                snapshot_published_chunks(db, owner, chunks_path)
                return True

            if not index_phase("snapshot_x_capture_chunks", snapshot_chunks):
                return result | {"status": "superseded"}
            spool_embeddings(chunks_path, embeddings_path)
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
            snapshot = fence(db)
            if snapshot is None or snapshot[1].lexical_revision != snapshot[1].revision:
                return None
            completed = completed_content_index(db, owner, snapshot[1])
            if completed is not None:
                return completed
            published = publish_embeddings(
                db, owner=owner, embeddings=read_embeddings(embeddings_path), reason="capture"
            )
            record_input_change(db, owners=(f"fragment:{fragment_id}",))
            return published

        published = index_phase("publish_x_capture_embeddings", publish)
    if published is None:
        return result | {"status": "superseded"}
    return result | {"status": published.status, "chunk_count": published.chunk_count}
