"""Exact-claim, three-phase transcript semantic indexing worker."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.jobs.queue import JobExecutionContext, lock_and_renew_running_job_claim
from nexus.services.content_indexing import (
    ContentIndexPlan,
    IndexOwner,
    build_transcript_indexable_blocks,
    plan_content_index,
    publish_content_index,
)
from nexus.services.transcript_segments import TranscriptSegmentInput
from nexus.services.transcripts.current import set_media_transcript_state

_LEASE_SECONDS = 300


@dataclass(frozen=True)
class _TranscriptSnapshot:
    media_id: UUID
    request_reason: str
    transcript_state: str
    transcript_coverage: str
    segments: tuple[TranscriptSegmentInput, ...]
    fingerprint: str


def podcast_reindex_semantic_job(
    media_id: str,
    requested_by_user_id: str | None = None,
    request_reason: str = "operator_requeue",
    request_id: str | None = None,
    *,
    context: JobExecutionContext,
    session_factory: sessionmaker[Session] | None = None,
) -> dict[str, object]:
    """Prepare a DB snapshot, embed outside a transaction, then publish exactly."""
    del requested_by_user_id, request_id
    media_uuid = UUID(media_id)
    factory = session_factory or get_session_factory()

    snapshot = _prepare_snapshot(
        factory,
        media_id=media_uuid,
        request_reason=request_reason,
        context=context,
    )
    if snapshot is None:
        return {"status": "skipped", "reason": "not_repairable"}

    plan = plan_content_index(
        owner=IndexOwner("media", snapshot.media_id),
        source_kind="transcript",
        blocks=build_transcript_indexable_blocks(
            media_id=snapshot.media_id,
            transcript_segments=snapshot.segments,
        ),
    )
    published = _publish_snapshot(
        factory,
        snapshot=snapshot,
        plan=plan,
        context=context,
    )
    if not published:
        return {"status": "skipped", "reason": "obsolete"}
    return {"status": "completed", "chunk_count": len(plan.chunks)}


def _prepare_snapshot(
    session_factory: sessionmaker[Session],
    *,
    media_id: UUID,
    request_reason: str,
    context: JobExecutionContext,
) -> _TranscriptSnapshot | None:
    db = session_factory()
    try:

        def transaction() -> _TranscriptSnapshot | None:
            media_exists = db.scalar(
                text("SELECT id FROM media WHERE id = :media_id FOR UPDATE"),
                {"media_id": media_id},
            )
            if media_exists is None:
                db.commit()
                return None
            state = db.execute(
                text(
                    """
                    SELECT transcript_state, transcript_coverage
                    FROM media_transcript_states
                    WHERE media_id = :media_id
                    FOR UPDATE
                    """
                ),
                {"media_id": media_id},
            ).fetchone()
            _require_semantic_claim(db, media_id=media_id, context=context)
            segments = _load_segments(db, media_id)
            if (
                state is None
                or str(state[0]) not in {"ready", "partial"}
                or str(state[1]) not in {"partial", "full"}
                or not segments
            ):
                db.commit()
                return None
            normalized_reason = (
                request_reason
                if request_reason
                in {
                    "episode_open",
                    "search",
                    "highlight",
                    "quote",
                    "background_warming",
                    "operator_requeue",
                    "rss_feed",
                }
                else "operator_requeue"
            )
            set_media_transcript_state(
                db,
                media_id=media_id,
                transcript_state=str(state[0]),
                transcript_coverage=str(state[1]),
                semantic_status="pending",
                last_request_reason=normalized_reason,
                last_error_code=None,
                now=datetime.now(UTC),
            )
            snapshot = _TranscriptSnapshot(
                media_id=media_id,
                request_reason=normalized_reason,
                transcript_state=str(state[0]),
                transcript_coverage=str(state[1]),
                segments=tuple(segments),
                fingerprint=_fingerprint(segments),
            )
            db.commit()
            return snapshot

        return retry_serializable(db, "prepare_podcast_semantic_index", transaction)
    finally:
        db.close()


def _publish_snapshot(
    session_factory: sessionmaker[Session],
    *,
    snapshot: _TranscriptSnapshot,
    plan: ContentIndexPlan,
    context: JobExecutionContext,
) -> bool:
    db = session_factory()
    try:

        def transaction() -> bool:
            media_exists = db.scalar(
                text("SELECT id FROM media WHERE id = :media_id FOR UPDATE"),
                {"media_id": snapshot.media_id},
            )
            if media_exists is None:
                db.commit()
                return False
            state = db.execute(
                text(
                    """
                    SELECT transcript_state, transcript_coverage
                    FROM media_transcript_states
                    WHERE media_id = :media_id
                    FOR UPDATE
                    """
                ),
                {"media_id": snapshot.media_id},
            ).fetchone()
            _require_semantic_claim(
                db,
                media_id=snapshot.media_id,
                context=context,
            )
            current_segments = _load_segments(db, snapshot.media_id)
            if (
                state is None
                or str(state[0]) != snapshot.transcript_state
                or str(state[1]) != snapshot.transcript_coverage
                or _fingerprint(current_segments) != snapshot.fingerprint
            ):
                db.commit()
                return False
            publish_content_index(
                db,
                plan=plan,
                reason=snapshot.request_reason,
            )
            set_media_transcript_state(
                db,
                media_id=snapshot.media_id,
                transcript_state=snapshot.transcript_state,
                transcript_coverage=snapshot.transcript_coverage,
                semantic_status="ready",
                last_request_reason=snapshot.request_reason,
                last_error_code=None,
                now=datetime.now(UTC),
            )
            db.commit()
            return True

        return retry_serializable(db, "publish_podcast_semantic_index", transaction)
    finally:
        db.close()


def _require_semantic_claim(
    db: Session,
    *,
    media_id: UUID,
    context: JobExecutionContext,
) -> None:
    job = lock_and_renew_running_job_claim(
        db,
        context=context,
        lease_seconds=_LEASE_SECONDS,
    )
    if (
        job is None
        or job.kind != "podcast_reindex_semantic_job"
        or str(job.payload.get("media_id")) != str(media_id)
    ):
        raise RuntimeError("podcast semantic queue claim is no longer current")


def _load_segments(db: Session, media_id: UUID) -> list[TranscriptSegmentInput]:
    rows = db.execute(
        text(
            """
            SELECT segment_idx, canonical_text, t_start_ms, t_end_ms, speaker_label
            FROM podcast_transcript_segments
            WHERE media_id = :media_id
            ORDER BY segment_idx ASC
            """
        ),
        {"media_id": media_id},
    ).fetchall()
    return [
        TranscriptSegmentInput(
            segment_idx=int(row[0]),
            canonical_text=str(row[1]),
            t_start_ms=int(row[2]),
            t_end_ms=int(row[3]),
            speaker_label=row[4],
        )
        for row in rows
    ]


def _fingerprint(
    segments: list[TranscriptSegmentInput] | tuple[TranscriptSegmentInput, ...],
) -> str:
    payload = [
        {
            "segment_idx": segment.segment_idx,
            "canonical_text": segment.canonical_text,
            "t_start_ms": segment.t_start_ms,
            "t_end_ms": segment.t_end_ms,
            "speaker_label": segment.speaker_label,
        }
        for segment in segments
    ]
    return hashlib.sha256(
        json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
    ).hexdigest()
