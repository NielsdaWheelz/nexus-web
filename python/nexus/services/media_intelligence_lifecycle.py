"""The media unit head's lifecycle: its content identity, find-or-create, and deletion.

Content indexing and media deletion import this on the background worker, so no
generation, tool or provider module enters its import graph at module scope. A unit is
current iff its fingerprint equals its media's current one (I12).
"""

from __future__ import annotations

import hashlib
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.retries import retry_serializable
from nexus.jobs.queue import enqueue_unique_job, revoke_jobs_by_dedupe_keys

MEDIA_UNIT_JOB_KIND = "media_unit_build"

# The index identity: the active embedding and the index generation. Every publish and
# every pending mark writes the state row (a new generation) and only a publish writes
# chunks, so the generation stands for the chunk texts without reading them (D5).
_FINGERPRINT_SQL = """
    SELECT owner_id, encode(sha256(convert_to(concat_ws('|',
        coalesce(active_embedding_provider, ''), coalesce(active_embedding_model, ''),
        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')), 'UTF8')), 'hex')
    FROM content_index_states WHERE owner_kind = 'media' AND owner_id = ANY(:ids)
"""
_NO_INDEX = hashlib.sha256(b"").hexdigest()


def media_unit_dedupe_key(media_id: UUID, content_fingerprint: str) -> str:
    """One build per media content version."""
    return f"{MEDIA_UNIT_JOB_KIND}:{media_id}:{content_fingerprint}"


def current_content_fingerprints(db: Session, media_ids: list[UUID]) -> dict[UUID, str]:
    """Each media's current fingerprint, in one query."""
    found = {row[0]: row[1] for row in db.execute(text(_FINGERPRINT_SQL), {"ids": media_ids})}
    return {media_id: found.get(media_id, _NO_INDEX) for media_id in media_ids}


def current_content_fingerprint(db: Session, *, media_id: UUID) -> str:
    return current_content_fingerprints(db, [media_id])[media_id]


def ensure_media_unit_in_tx(db: Session, *, media_id: UUID) -> None:
    """Find-or-create the head at the current fingerprint and enqueue its build.

    Flushes, never commits: the enqueue stays atomic with the index publish that calls it.
    A head ready or building at the current fingerprint is left alone.
    """
    fingerprint = current_content_fingerprint(db, media_id=media_id)
    live = db.scalar(
        text("""
            SELECT 1 FROM media_summaries WHERE media_id = :m AND content_fingerprint = :fp
              AND status IN ('ready', 'building')
        """),
        {"m": media_id, "fp": fingerprint},
    )
    if live is not None:
        return
    summary_id = db.scalar(
        text("""
            INSERT INTO media_summaries (media_id, content_fingerprint, summary_md, model_name, status)
            VALUES (:m, :fp, '', :model, 'building')
            ON CONFLICT ON CONSTRAINT uq_media_summaries_media DO UPDATE
            SET content_fingerprint = EXCLUDED.content_fingerprint, summary_md = '',
                model_name = EXCLUDED.model_name, status = 'building', error_code = NULL,
                error_detail = NULL, updated_at = now()
            RETURNING id
        """),
        {"m": media_id, "fp": fingerprint, "model": _model_name()},
    )
    db.execute(text("DELETE FROM media_claims WHERE summary_id = :s"), {"s": summary_id})
    # A terminal row holding this key would block the unique insert.
    key = media_unit_dedupe_key(media_id, fingerprint)
    revoke_jobs_by_dedupe_keys(db, kind=MEDIA_UNIT_JOB_KIND, dedupe_keys=[key])
    enqueue_unique_job(
        db,
        kind=MEDIA_UNIT_JOB_KIND,
        dedupe_key=key,
        priority=200,
        payload={
            "media_id": str(media_id),
            "summary_id": str(summary_id),
            "content_fingerprint": fingerprint,
        },
    )
    db.flush()


def ensure_media_unit(db: Session, *, media_id: UUID) -> None:
    """Standalone find-or-create: its own serializable retry and commit."""

    def op() -> None:
        ensure_media_unit_in_tx(db, media_id=media_id)
        db.commit()

    retry_serializable(db, "ensure_media_unit", op)


def clear_media_claims_for_reindex(db: Session, *, media_id: UUID) -> None:
    """The claims go before the content index replaces the spans they cite."""
    db.execute(
        text("""
            DELETE FROM media_claims
            WHERE summary_id IN (SELECT id FROM media_summaries WHERE media_id = :m)
        """),
        {"m": media_id},
    )


def delete_media_unit(db: Session, *, media_id: UUID) -> None:
    """Claims, then the head, inside the media owner's transaction."""
    db.execute(text("DELETE FROM media_claims WHERE media_id = :m"), {"m": media_id})
    db.execute(text("DELETE FROM media_summaries WHERE media_id = :m"), {"m": media_id})


def _model_name() -> str:
    from nexus.schemas.llm import CodexPersonalSelection
    from nexus.services.generation.policy import policy

    selection = policy("media_summary").selection
    if not isinstance(selection, CodexPersonalSelection):
        raise AssertionError("media summary must ship through Codex Personal")
    return selection.model
