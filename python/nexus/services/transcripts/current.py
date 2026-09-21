"""The single owner of current transcript artifact publication."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, NotFoundError
from nexus.services.content_indexing import IndexOwner, deactivate_content_index
from nexus.services.media_processing_state import mark_ready_for_reading_by_id
from nexus.services.transcript_segments import (
    TranscriptSegmentInput,
    insert_transcript_fragments,
)
from nexus.services.transcripts.request_reason import TranscriptRequestReason
from nexus.services.transcripts.semantic import enqueue_transcript_semantic_job
from nexus.services.transcripts.state import TranscriptOrigin, set_media_transcript_state


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
    """Publish a non-source transcript, enqueue semantic work, make it readable."""
    result = _publish(
        db,
        media_id=media_id,
        request_reason=request_reason,
        transcript_coverage=transcript_coverage,
        transcript_segments=transcript_segments,
        transcript_origin=transcript_origin,
        now=now,
    )
    enqueue_transcript_semantic_job(db, media_id=media_id, request_reason=request_reason)
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
    return _publish(
        db,
        media_id=media_id,
        request_reason=request_reason,
        transcript_coverage=transcript_coverage,
        transcript_segments=transcript_segments,
        transcript_origin=transcript_origin,
        now=now,
    )


def _publish(
    db: Session,
    *,
    media_id: UUID,
    request_reason: TranscriptRequestReason,
    transcript_coverage: Literal["partial", "full"],
    transcript_segments: Sequence[TranscriptSegmentInput],
    transcript_origin: TranscriptOrigin,
    now: datetime,
) -> CurrentTranscriptWriteResult:
    """Replace the transcript rows in the caller's transaction.

    The media row is the publication boundary and is locked before the transcript
    advisory lock. Highlights are authored user data and are never deleted here:
    their selectors re-resolve against the new fragments.
    """
    if (
        db.scalar(
            text("SELECT id FROM media WHERE id = :media_id FOR UPDATE"), {"media_id": media_id}
        )
        is None
    ):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtext(:lock_key))"),
        {"lock_key": f"transcript-current:{media_id}"},
    )
    db.execute(
        text("DELETE FROM podcast_transcript_segments WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(text("DELETE FROM fragments WHERE media_id = :media_id"), {"media_id": media_id})
    insert_transcript_fragments(db, media_id, transcript_segments, now=now)
    if transcript_segments:
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
            [
                {
                    "media_id": media_id,
                    "segment_idx": segment_idx,
                    "canonical_text": segment.canonical_text,
                    "t_start_ms": segment.t_start_ms,
                    "t_end_ms": segment.t_end_ms,
                    "speaker_label": segment.speaker_label,
                    "created_at": now,
                }
                for segment_idx, segment in enumerate(transcript_segments)
            ],
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
    return CurrentTranscriptWriteResult(
        segment_count=len(transcript_segments), semantic_status="pending"
    )
