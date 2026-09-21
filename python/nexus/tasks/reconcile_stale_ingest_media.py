"""Bounded enqueue-only reconciliation for ingest-owned durable work."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from functools import partial
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import NotFoundError
from nexus.services.content_indexing import ensure_media_content_reindex_job
from nexus.services.media_source_ingest import ensure_stale_source_attempt_job
from nexus.services.transcripts.semantic import request_transcript_semantic_repair

_BATCH_LIMIT = 25

_STALE_SOURCE_ATTEMPTS = """
    SELECT msa.id AS attempt_id, msa.media_id
    FROM media_source_attempts msa
    JOIN media m ON m.id = msa.media_id
    WHERE msa.status IN ('accepted', 'queued', 'running')
      AND m.processing_status = 'extracting'
      AND m.processing_started_at IS NOT NULL
      AND m.processing_started_at
          < now() - (CAST(:stale_seconds AS integer) * interval '1 second')
      AND NOT EXISTS (
          SELECT 1
          FROM media_source_attempts newer
          WHERE newer.media_id = msa.media_id
            AND (newer.attempt_no, newer.created_at, newer.id)
              > (msa.attempt_no, msa.created_at, msa.id)
      )
    ORDER BY m.processing_started_at ASC, msa.id ASC
    LIMIT :limit
"""

_STALE_CONTENT_INDEX_STATES = """
    SELECT cis.owner_id AS media_id
    FROM content_index_states cis
    JOIN media m ON cis.owner_kind = 'media' AND m.id = cis.owner_id
    WHERE m.kind IN ('web_article', 'epub', 'pdf')
      AND m.processing_status = 'ready_for_reading'
      AND (
          cis.status = 'pending'
          OR (
              cis.status = 'indexing'
              AND cis.updated_at
                  < now() - (CAST(:stale_seconds AS integer) * interval '1 second')
          )
      )
    ORDER BY cis.updated_at ASC, cis.owner_id ASC
    LIMIT :limit
"""

_PENDING_TRANSCRIPT_SEMANTICS = """
    SELECT mts.media_id
    FROM media_transcript_states mts
    JOIN media m ON m.id = mts.media_id
    WHERE m.kind IN ('podcast_episode', 'video')
      AND mts.transcript_state IN ('ready', 'partial')
      AND mts.transcript_coverage IN ('partial', 'full')
      AND mts.semantic_status IN ('pending', 'failed')
      AND EXISTS (
          SELECT 1 FROM podcast_transcript_segments pts WHERE pts.media_id = mts.media_id
      )
    ORDER BY mts.updated_at ASC, mts.media_id ASC
    LIMIT :limit
"""


def reconcile_stale_ingest_media_job(request_id: str | None) -> dict[str, int]:
    """Ensure the canonical job for every stuck source, index and semantic row."""
    stale_seconds = int(get_settings().ingest_stale_extracting_seconds)
    source_rows = _discover(_STALE_SOURCE_ATTEMPTS, stale_seconds=stale_seconds)
    index_rows = _discover(_STALE_CONTENT_INDEX_STATES, stale_seconds=stale_seconds)
    semantic_rows = _discover(_PENDING_TRANSCRIPT_SEMANTICS)

    source_outcomes = [
        _each(
            "reconcile_stale_source_attempt",
            partial(
                _ensure_source,
                media_id=UUID(str(row["media_id"])),
                attempt_id=UUID(str(row["attempt_id"])),
                request_id=request_id,
            ),
        )
        for row in source_rows
    ]
    index_outcomes = [
        _each(
            "reconcile_media_content_index",
            partial(_ensure_index, media_id=UUID(str(row["media_id"])), request_id=request_id),
        )
        for row in index_rows
    ]
    semantic_outcomes = [
        _each(
            "reconcile_podcast_semantic_index",
            partial(_ensure_semantic, media_id=UUID(str(row["media_id"]))),
        )
        for row in semantic_rows
    ]
    return {
        "source_scanned": len(source_rows),
        "source_enqueued": source_outcomes.count("enqueued"),
        "source_deduplicated": source_outcomes.count("deduplicated"),
        "source_suspended": source_outcomes.count("suspended"),
        "source_skipped": source_outcomes.count("skipped"),
        "content_index_scanned": len(index_rows),
        "content_index_enqueued": index_outcomes.count("enqueued"),
        "content_index_deduplicated": index_outcomes.count("deduplicated"),
        "content_index_suspended": index_outcomes.count("suspended"),
        "semantic_scanned": len(semantic_rows),
        "semantic_enqueued": semantic_outcomes.count("enqueued"),
        "semantic_deduplicated": semantic_outcomes.count("deduplicated"),
    }


def _discover(statement: str, **params: Any) -> Sequence[Any]:
    db = get_session_factory()()
    try:
        rows = db.execute(text(statement), {"limit": _BATCH_LIMIT, **params}).mappings().all()
        db.rollback()
    finally:
        db.close()
    return rows


def _each(label: str, operation: Callable[[Session], str]) -> str:
    db = get_session_factory()()
    try:
        return retry_serializable(db, label, partial(operation, db))
    finally:
        db.close()


def _ensure_source(db: Session, *, media_id: UUID, attempt_id: UUID, request_id: str | None) -> str:
    outcome = ensure_stale_source_attempt_job(
        db, media_id=media_id, attempt_id=attempt_id, request_id=request_id
    )
    db.commit()
    return outcome


def _ensure_index(db: Session, *, media_id: UUID, request_id: str | None) -> str:
    intent = ensure_media_content_reindex_job(
        db, media_id=media_id, reason="reconciliation", request_id=request_id
    )
    db.commit()
    if intent.suspended:
        return "suspended"
    return "enqueued" if intent.enqueued else "deduplicated"


def _ensure_semantic(db: Session, *, media_id: UUID) -> str:
    try:
        admission = request_transcript_semantic_repair(
            db, media_id=media_id, request_reason="operator_requeue", now=datetime.now(UTC)
        )
    except NotFoundError:
        db.commit()
        return "deduplicated"
    db.commit()
    return "enqueued" if admission.outcome == "queued" else "deduplicated"
