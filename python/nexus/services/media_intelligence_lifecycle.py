"""The media unit head's lifecycle: its content identity, find-or-create, and deletion.

Content indexing and media deletion import this on the background worker, so no
generation, tool or provider module enters its import graph at module scope. A unit is
current iff its fingerprint equals its media's current one (I12). A thread's
fingerprint composes its ordered primary post indexes; foreign context is excluded.
Its claims cite those canonical spans, so child reindex clears dependent claims.
"""

from __future__ import annotations

import hashlib
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.jobs.queue import enqueue_unique_job, revoke_jobs_by_dedupe_keys

MEDIA_UNIT_JOB_KIND = "media_unit_build"


# The index identity: the active embedding and the index generation. Every publish and
# every pending mark writes the state row (a new generation) and only a publish writes
# chunks, so the generation stands for the chunk texts without reading them (D5).
def primary_index_owners_sql() -> str:
    """The ordered primary index owners of each media's synthesis."""
    return """
        SELECT m.id AS media_id, 'media'::text AS owner_kind, m.id AS owner_id, 0 AS ordinal
        FROM media m WHERE NOT EXISTS (SELECT 1 FROM x_post_media x WHERE x.media_id=m.id)
          AND NOT EXISTS (SELECT 1 FROM x_thread_sources x WHERE x.media_id=m.id)
        UNION ALL
        SELECT x.media_id, 'fragment', f.id, 0 FROM x_post_media x
        JOIN fragments f ON f.x_post_capture_id=x.capture_id
        UNION ALL
        SELECT x.thread_media_id, 'fragment', f.id, x.ordinal FROM x_thread_posts x
        JOIN fragments f ON f.x_post_capture_id=x.capture_id
    """


_FINGERPRINT_SQL = f"""
    SELECT owners.media_id, encode(sha256(convert_to(
        string_agg(concat_ws('|', owners.owner_kind,owners.owner_id::text,
            coalesce(s.active_embedding_provider,''),coalesce(s.active_embedding_model,''),
            s.status,s.revision::text,
            to_char(s.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')),
            ';' ORDER BY owners.ordinal,owners.owner_id), 'UTF8')), 'hex')
    FROM ({primary_index_owners_sql()}) owners
    JOIN content_index_states s ON s.owner_kind=owners.owner_kind AND s.owner_id=owners.owner_id
    WHERE owners.media_id=ANY(:ids) GROUP BY owners.media_id
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
    waiting, ready = db.execute(
        text(f"""
        SELECT count(*) FILTER (WHERE s.status IS NULL OR s.status NOT IN ('ready','no_text')
                   OR (s.status='ready' AND s.lexical_revision IS DISTINCT FROM s.revision)),
               count(*) FILTER (WHERE s.status='ready' AND s.lexical_revision=s.revision)
        FROM ({primary_index_owners_sql()}) owners
        LEFT JOIN content_index_states s ON s.owner_kind=owners.owner_kind AND s.owner_id=owners.owner_id
        WHERE owners.media_id=:m
    """),
        {"m": media_id},
    ).one()
    if waiting or not ready:
        return
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


def clear_media_claims_for_reindex(db: Session, *, media_id: UUID) -> None:
    """The claims go before the content index replaces the spans they cite."""
    db.execute(
        text("""
            DELETE FROM media_claims
            WHERE summary_id IN (SELECT id FROM media_summaries WHERE media_id = :m)
               OR evidence_span_id IN (
                   SELECT id FROM evidence_spans WHERE owner_kind = 'media' AND owner_id = :m)
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
