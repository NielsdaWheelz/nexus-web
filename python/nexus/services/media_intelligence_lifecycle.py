"""DB-only lifecycle state for the per-media intelligence unit owner.

This narrow module is imported by bounded content-index and deletion children.
Keep generation transports, tool runtimes, and provider SDKs out of its import
graph; the generation policy is loaded only when a unit actually needs a build.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.retries import retry_serializable
from nexus.jobs.queue import enqueue_unique_job, revoke_jobs_by_dedupe_keys
from nexus.schemas.media import MediaUnitStatus

MEDIA_UNIT_OPERATION = "media_summary"
MEDIA_UNIT_JOB_KIND = "media_unit_build"
MEDIA_UNIT_BACKGROUND_PRIORITY = 200


@dataclass(frozen=True)
class MediaUnitRef:
    """The find-or-create outcome of :func:`ensure_media_unit`."""

    media_id: UUID
    summary_id: UUID
    status: MediaUnitStatus
    content_fingerprint: str
    enqueued: bool


def ensure_media_unit(db: Session, *, media_id: UUID) -> MediaUnitRef:
    """Find-or-create the current unit head and enqueue a build when needed.

    Standalone entry (the on-demand route): owns the SERIALIZABLE transaction,
    commit, and bounded serialization retry. A head already at the current
    fingerprint and in ``ready`` or ``building`` is returned untouched.
    """

    def op() -> MediaUnitRef:
        ref = _ensure_media_unit_core(db, media_id=media_id)
        db.commit()
        return ref

    return retry_serializable(db, "ensure_media_unit", op)


def ensure_media_unit_in_tx(db: Session, *, media_id: UUID) -> MediaUnitRef:
    """Find-or-create the unit head inside the caller's open transaction.

    The ingest hook flushes but does not commit or change isolation, so the
    build enqueue remains atomic with the caller's content-index writes.
    """
    return _ensure_media_unit_core(db, media_id=media_id)


def clear_media_claims_for_reindex(db: Session, *, media_id: UUID) -> None:
    """Delete unit claims before the content-index owner replaces their spans.

    The summary head remains; the re-ingest hook points it at the new content
    fingerprint and returns it to ``building``.
    """
    db.execute(
        text(
            """
            DELETE FROM media_claims
            WHERE summary_id IN (
                SELECT id FROM media_summaries WHERE media_id = :media_id
            )
            """
        ),
        {"media_id": media_id},
    )


def delete_media_unit(db: Session, *, media_id: UUID) -> None:
    """Tear down claims then their head inside the media owner's transaction.

    Both tables have non-cascading references and must be cleared before the
    media row and its evidence spans. The operation is idempotent.
    """
    db.execute(
        text("DELETE FROM media_claims WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM media_summaries WHERE media_id = :media_id"),
        {"media_id": media_id},
    )


def current_content_fingerprint(db: Session, *, media_id: UUID) -> str:
    """Return the DB-only current staleness identity for one media index.

    The SHA-256 covers the active embedding identity, index generation, and
    ordered chunk-text hashes. Freshness checks and aggregate dedupe must route
    through this sole definition rather than trusting the stored head value.
    """
    index_state = (
        db.execute(
            text(
                """
                SELECT active_embedding_provider, active_embedding_model, updated_at
                FROM content_index_states
                WHERE owner_kind = 'media' AND owner_id = :media_id
                """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .first()
    )
    provider = (index_state or {}).get("active_embedding_provider")
    model = (index_state or {}).get("active_embedding_model")
    index_generation = (index_state or {}).get("updated_at")
    chunk_rows = (
        db.execute(
            text(
                """
                SELECT chunk_idx, chunk_text
                FROM content_chunks
                WHERE owner_kind = 'media' AND owner_id = :media_id
                ORDER BY chunk_idx
                """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .all()
    )
    canonical = {
        "active_embedding_provider": provider,
        "active_embedding_model": model,
        "active_index_generation": (
            index_generation.isoformat() if index_generation is not None else None
        ),
        "chunks": [
            [
                int(row["chunk_idx"]),
                hashlib.sha256(str(row["chunk_text"]).encode("utf-8")).hexdigest(),
            ]
            for row in chunk_rows
        ],
    }
    serialized = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _ensure_media_unit_core(db: Session, *, media_id: UUID) -> MediaUnitRef:
    fingerprint = current_content_fingerprint(db, media_id=media_id)
    summary = (
        db.execute(
            text("SELECT * FROM media_summaries WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
        .mappings()
        .first()
    )
    if summary is not None:
        summary_id = UUID(str(summary["id"]))
        if summary["content_fingerprint"] == fingerprint and summary["status"] in (
            "ready",
            "building",
        ):
            return MediaUnitRef(
                media_id=media_id,
                summary_id=summary_id,
                status=cast("MediaUnitStatus", summary["status"]),
                content_fingerprint=fingerprint,
                enqueued=False,
            )
        db.execute(
            text(
                """
                UPDATE media_summaries
                SET content_fingerprint = :fingerprint,
                    summary_md = '',
                    model_name = :model_name,
                    status = 'building',
                    error_code = NULL,
                    error_detail = NULL,
                    updated_at = now()
                WHERE id = :summary_id
                """
            ),
            {
                "fingerprint": fingerprint,
                "model_name": _media_unit_model_name(),
                "summary_id": summary_id,
            },
        )
        db.execute(
            text("DELETE FROM media_claims WHERE summary_id = :summary_id"),
            {"summary_id": summary_id},
        )
    else:
        summary_id = db.execute(
            text(
                """
                INSERT INTO media_summaries (
                    media_id, content_fingerprint, summary_md, model_name, status
                )
                VALUES (:media_id, :fingerprint, '', :model_name, 'building')
                RETURNING id
                """
            ),
            {
                "media_id": media_id,
                "fingerprint": fingerprint,
                "model_name": _media_unit_model_name(),
            },
        ).scalar_one()
        summary_id = UUID(str(summary_id))

    dedupe_key = f"{MEDIA_UNIT_JOB_KIND}:{media_id}:{fingerprint}"
    # Drop a terminal/stale row holding this key so enqueue_unique_job can
    # insert a fresh runnable row. An in-flight current build short-circuits
    # above, and changed fingerprints use a different key.
    revoke_jobs_by_dedupe_keys(
        db,
        kind=MEDIA_UNIT_JOB_KIND,
        dedupe_keys=[dedupe_key],
    )
    _, inserted = enqueue_unique_job(
        db,
        kind=MEDIA_UNIT_JOB_KIND,
        dedupe_key=dedupe_key,
        priority=MEDIA_UNIT_BACKGROUND_PRIORITY,
        payload={
            "media_id": str(media_id),
            "summary_id": str(summary_id),
            "content_fingerprint": fingerprint,
            "capacity_wait_index": 0,
            "coordination": {},
        },
    )
    db.flush()
    return MediaUnitRef(
        media_id=media_id,
        summary_id=summary_id,
        status="building",
        content_fingerprint=fingerprint,
        enqueued=inserted,
    )


def _media_unit_model_name() -> str:
    # Bounded indexing children may import this owner but must not preload the
    # generation/tool/provider graph merely to publish or tear down an index.
    from nexus.services import generation_policy

    return generation_policy.operation_policy(MEDIA_UNIT_OPERATION).model


__all__ = [
    "MEDIA_UNIT_BACKGROUND_PRIORITY",
    "MEDIA_UNIT_OPERATION",
    "MEDIA_UNIT_JOB_KIND",
    "MediaUnitRef",
    "clear_media_claims_for_reindex",
    "current_content_fingerprint",
    "delete_media_unit",
    "ensure_media_unit",
    "ensure_media_unit_in_tx",
]
