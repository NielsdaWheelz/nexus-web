"""The single owner of current transcript artifact publication.

Transcript publication is database-only. Semantic retrieval work is always
owned by the existing durable podcast semantic job and never runs in the source
transaction.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, NotFoundError
from nexus.jobs.queue import enqueue_job
from nexus.services.content_indexing import IndexOwner, deactivate_content_index
from nexus.services.media_processing_state import mark_ready_for_reading_by_id
from nexus.services.transcript_segments import (
    TranscriptSegmentInput,
    insert_transcript_fragments,
)

TranscriptRequestReason = Literal[
    "episode_open",
    "search",
    "highlight",
    "quote",
    "background_warming",
    "operator_requeue",
    "rss_feed",
]
TranscriptOrigin = Literal["Publisher", "Imported", "Generated"]


@dataclass(frozen=True)
class CurrentTranscriptWriteResult:
    segment_count: int
    semantic_status: Literal["pending"]


def write_current_transcript(
    db: Session,
    *,
    media_id: UUID,
    request_reason: TranscriptRequestReason,
    transcript_coverage: Literal["partial", "full"],
    transcript_segments: Sequence[TranscriptSegmentInput],
    transcript_origin: TranscriptOrigin,
    now: datetime,
) -> CurrentTranscriptWriteResult:
    """Publish a non-source transcript and make the media readable."""
    result = _publish_current_transcript_artifacts(
        db,
        media_id=media_id,
        request_reason=request_reason,
        transcript_coverage=transcript_coverage,
        transcript_segments=transcript_segments,
        transcript_origin=transcript_origin,
        now=now,
        enqueue_semantic=True,
    )
    mark_ready_for_reading_by_id(db, media_id=media_id, now=now)
    return result


def publish_source_transcript(
    db: Session,
    *,
    media_id: UUID,
    request_reason: TranscriptRequestReason,
    transcript_coverage: Literal["partial", "full"],
    transcript_segments: Sequence[TranscriptSegmentInput],
    transcript_origin: TranscriptOrigin,
    now: datetime,
) -> CurrentTranscriptWriteResult:
    """Publish source artifacts without crossing the source-success boundary."""
    return _publish_current_transcript_artifacts(
        db,
        media_id=media_id,
        request_reason=request_reason,
        transcript_coverage=transcript_coverage,
        transcript_segments=transcript_segments,
        transcript_origin=transcript_origin,
        now=now,
        enqueue_semantic=False,
    )


def _publish_current_transcript_artifacts(
    db: Session,
    *,
    media_id: UUID,
    request_reason: TranscriptRequestReason,
    transcript_coverage: Literal["partial", "full"],
    transcript_segments: Sequence[TranscriptSegmentInput],
    transcript_origin: TranscriptOrigin,
    now: datetime,
    enqueue_semantic: bool,
) -> CurrentTranscriptWriteResult:
    """Replace transcript rows and atomically dispatch semantic retrieval work.

    Runs in the caller's transaction. The media row is the public publication
    boundary and is locked before the transcript advisory lock.
    """
    locked_media_id = db.execute(
        text("SELECT id FROM media WHERE id = :media_id FOR UPDATE"),
        {"media_id": media_id},
    ).scalar()
    if locked_media_id is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtext(:lock_key))"),
        {"lock_key": f"transcript-current:{media_id}"},
    )

    # Highlights are authored user data and are NOT deleted here: refresh
    # publishes new fragments, then authored selectors (Highlights, passage
    # anchors) resolve against the new current content (spec "Highlight
    # Durability", Invariant 9). Fragment deletion below only invalidates the
    # highlight_fragment_anchors locator cache (fragment_id FK is non-cascading,
    # non-owning); the Highlight root survives and is resolved via LEFT JOIN
    # + quote re-resolution.
    db.execute(
        text("DELETE FROM podcast_transcript_segments WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(text("DELETE FROM fragments WHERE media_id = :media_id"), {"media_id": media_id})

    insert_transcript_fragments(
        db,
        media_id,
        transcript_segments,
        now=now,
    )
    for segment_idx, segment in enumerate(transcript_segments):
        db.execute(
            text(
                """
                INSERT INTO podcast_transcript_segments (
                    media_id, segment_idx, canonical_text,
                    t_start_ms, t_end_ms, speaker_label, created_at
                )
                VALUES (
                    :media_id, :segment_idx, :canonical_text,
                    :t_start_ms, :t_end_ms, :speaker_label, :created_at
                )
                """
            ),
            {
                "media_id": media_id,
                "segment_idx": segment_idx,
                "canonical_text": segment.canonical_text,
                "t_start_ms": segment.t_start_ms,
                "t_end_ms": segment.t_end_ms,
                "speaker_label": segment.speaker_label,
                "created_at": now,
            },
        )

    deactivate_content_index(
        db, owner=IndexOwner("media", media_id), reason="transcript_replacement"
    )
    set_media_transcript_state(
        db,
        media_id=media_id,
        transcript_state="partial" if transcript_coverage == "partial" else "ready",
        transcript_coverage=transcript_coverage,
        semantic_status="pending",
        last_request_reason=request_reason,
        last_error_code=None,
        transcript_origin=transcript_origin,
        now=now,
    )
    if enqueue_semantic:
        enqueue_job(
            db,
            kind="podcast_reindex_semantic_job",
            payload={
                "media_id": str(media_id),
                "requested_by_user_id": None,
                "request_reason": request_reason,
                "request_id": None,
            },
        )
    return CurrentTranscriptWriteResult(
        segment_count=len(transcript_segments),
        semantic_status="pending",
    )


def set_media_transcript_state(
    db: Session,
    *,
    media_id: UUID,
    transcript_state: str,
    transcript_coverage: str,
    semantic_status: str | None = None,
    last_request_reason: str | None = None,
    last_error_code: str | None = None,
    transcript_origin: TranscriptOrigin | None = None,
    now: datetime,
) -> None:
    """Insert or update the media_transcript_states row on a transcript write.

    `None` for semantic_status / last_request_reason preserves the existing value.
    """
    existing = (
        db.execute(
            text(
                """
                SELECT media_id, transcript_origin
                FROM media_transcript_states
                WHERE media_id = :media_id
                """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .first()
    )
    readable = transcript_state in {"ready", "partial"}
    existing_origin = existing["transcript_origin"] if existing is not None else None
    if readable and transcript_origin is None and existing_origin is None:
        raise AssertionError("readable transcript state requires an owned transcript origin")
    if not readable and transcript_origin is not None:
        raise AssertionError("non-readable transcript state cannot carry transcript origin")
    params = {
        "media_id": media_id,
        "transcript_state": transcript_state,
        "transcript_coverage": transcript_coverage,
        "semantic_status": semantic_status,
        "last_request_reason": last_request_reason,
        "last_error_code": last_error_code,
        "transcript_origin": transcript_origin,
        "now": now,
    }
    if existing is None:
        db.execute(
            text(
                """
                INSERT INTO media_transcript_states (
                    media_id, transcript_state, transcript_coverage, semantic_status,
                    last_request_reason, last_error_code, transcript_origin,
                    created_at, updated_at
                )
                VALUES (
                    :media_id, :transcript_state, :transcript_coverage,
                    COALESCE(:semantic_status, 'none'),
                    :last_request_reason, :last_error_code,
                    CASE
                        WHEN :transcript_state IN ('ready', 'partial')
                        THEN CAST(:transcript_origin AS text)
                        ELSE NULL
                    END,
                    :now, :now
                )
                """
            ),
            params,
        )
        return
    db.execute(
        text(
            """
            UPDATE media_transcript_states
            SET transcript_state = :transcript_state,
                transcript_coverage = :transcript_coverage,
                semantic_status = COALESCE(:semantic_status, semantic_status),
                last_request_reason = COALESCE(:last_request_reason, last_request_reason),
                last_error_code = :last_error_code,
                transcript_origin = CASE
                    WHEN :transcript_state NOT IN ('ready', 'partial') THEN NULL
                    WHEN CAST(:transcript_origin AS text) IS NOT NULL
                    THEN CAST(:transcript_origin AS text)
                    ELSE transcript_origin
                END,
                updated_at = :now
            WHERE media_id = :media_id
            """
        ),
        params,
    )


def ensure_media_transcript_state_row(
    db: Session,
    *,
    media_id: UUID,
    now: datetime,
    request_reason: str | None = None,
) -> None:
    """Create a placeholder 'not_requested' state row if none exists yet."""
    if (
        db.scalar(
            text("SELECT media_id FROM media_transcript_states WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
        is not None
    ):
        return
    db.execute(
        text(
            """
            INSERT INTO media_transcript_states (
                media_id, transcript_state, transcript_coverage, semantic_status,
                last_request_reason, last_error_code, created_at, updated_at
            )
            VALUES (
                :media_id, 'not_requested', 'none', 'none',
                :last_request_reason, NULL, :now, :now
            )
            """
        ),
        {"media_id": media_id, "last_request_reason": request_reason, "now": now},
    )
