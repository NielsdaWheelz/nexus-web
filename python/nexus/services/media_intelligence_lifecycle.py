"""DB-only lifecycle of the per-media intelligence unit head.

Imported by content indexing and media deletion on the background worker, so no
generation, tool or provider module may enter this import graph at module scope.
"""

from __future__ import annotations

import hashlib
import json
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.retries import retry_serializable
from nexus.jobs.queue import enqueue_unique_job, revoke_jobs_by_dedupe_keys

MEDIA_UNIT_OPERATION = "media_summary"
MEDIA_UNIT_JOB_KIND = "media_unit_build"


def media_unit_dedupe_key(media_id: UUID, content_fingerprint: str) -> str:
    """One build job per media content version."""
    return f"{MEDIA_UNIT_JOB_KIND}:{media_id}:{content_fingerprint}"


def current_content_fingerprint(db: Session, *, media_id: UUID) -> str:
    """The DB-only staleness identity of one media's content index: the active
    embedding identity, the index generation and the ordered chunk-text hashes."""
    state = db.execute(
        text(
            """
            SELECT active_embedding_provider, active_embedding_model, updated_at
            FROM content_index_states
            WHERE owner_kind = 'media' AND owner_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).first()
    chunks = db.execute(
        text(
            """
            SELECT chunk_idx, chunk_text
            FROM content_chunks
            WHERE owner_kind = 'media' AND owner_id = :media_id
            ORDER BY chunk_idx
            """
        ),
        {"media_id": media_id},
    ).all()
    canonical = {
        "active_embedding_provider": None if state is None else state[0],
        "active_embedding_model": None if state is None else state[1],
        "active_index_generation": None if state is None else state[2].isoformat(),
        "chunks": [
            [int(idx), hashlib.sha256(str(chunk_text).encode("utf-8")).hexdigest()]
            for idx, chunk_text in chunks
        ],
    }
    serialized = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def ensure_media_unit(db: Session, *, media_id: UUID) -> None:
    """Standalone find-or-create: owns the serializable retry and the commit."""

    def op() -> None:
        ensure_media_unit_in_tx(db, media_id=media_id)
        db.commit()

    retry_serializable(db, "ensure_media_unit", op)


def ensure_media_unit_in_tx(db: Session, *, media_id: UUID) -> None:
    """Find-or-create the head and enqueue its build in the caller's transaction.

    Flushes but never commits, so the enqueue stays atomic with the content-index
    writes that trigger it. A head already ready or building at the current
    fingerprint is left untouched and enqueues nothing.
    """
    fingerprint = current_content_fingerprint(db, media_id=media_id)
    live = db.execute(
        text(
            """
            SELECT 1 FROM media_summaries
            WHERE media_id = :media_id
              AND content_fingerprint = :fingerprint
              AND status IN ('ready', 'building')
            """
        ),
        {"media_id": media_id, "fingerprint": fingerprint},
    ).first()
    if live is not None:
        return

    summary_id = db.execute(
        text(
            """
            INSERT INTO media_summaries (
                media_id, content_fingerprint, summary_md, model_name, status
            )
            VALUES (:media_id, :fingerprint, '', :model_name, 'building')
            ON CONFLICT ON CONSTRAINT uq_media_summaries_media DO UPDATE
            SET content_fingerprint = EXCLUDED.content_fingerprint,
                summary_md = '',
                model_name = EXCLUDED.model_name,
                status = 'building',
                error_code = NULL,
                error_detail = NULL,
                updated_at = now()
            RETURNING id
            """
        ),
        {
            "media_id": media_id,
            "fingerprint": fingerprint,
            "model_name": _media_unit_model_name(),
        },
    ).scalar_one()
    db.execute(
        text("DELETE FROM media_claims WHERE summary_id = :summary_id"),
        {"summary_id": summary_id},
    )

    # A terminal row holding this key blocks the unique insert; the live build
    # returned above, and other fingerprints use other keys.
    dedupe_key = media_unit_dedupe_key(media_id, fingerprint)
    revoke_jobs_by_dedupe_keys(db, kind=MEDIA_UNIT_JOB_KIND, dedupe_keys=[dedupe_key])
    enqueue_unique_job(
        db,
        kind=MEDIA_UNIT_JOB_KIND,
        dedupe_key=dedupe_key,
        priority=200,
        payload={
            "media_id": str(media_id),
            "summary_id": str(summary_id),
            "content_fingerprint": fingerprint,
            "coordination": {},
        },
    )
    db.flush()


def clear_media_claims_for_reindex(db: Session, *, media_id: UUID) -> None:
    """Drop the claims before the content index replaces their evidence spans."""
    db.execute(
        text(
            """
            DELETE FROM media_claims
            WHERE summary_id IN (SELECT id FROM media_summaries WHERE media_id = :media_id)
            """
        ),
        {"media_id": media_id},
    )


def delete_media_unit(db: Session, *, media_id: UUID) -> None:
    """Tear down claims then head inside the media owner's transaction."""
    db.execute(text("DELETE FROM media_claims WHERE media_id = :media_id"), {"media_id": media_id})
    db.execute(
        text("DELETE FROM media_summaries WHERE media_id = :media_id"), {"media_id": media_id}
    )


def _media_unit_model_name() -> str:
    from nexus.services import generation_policy
    from nexus.services.generation_spec import CodexPersonalSelection

    selection = generation_policy.background_operation_policy(MEDIA_UNIT_OPERATION).selection
    if not isinstance(selection, CodexPersonalSelection):
        raise AssertionError("media summary must ship through Codex Personal")
    return selection.model
