"""The single owner of a media's current transcript artifacts.

Replacing a transcript replaces its segments and fragments, sets the transcript state,
and retracts the media's content index at once (its passages cite the old text). The
transaction that makes the new transcript readable requests the next index revision:
``write_current_transcript`` here, or the source attempt's success for
``publish_source_transcript``.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, NotFoundError
from nexus.services.content_indexing import (
    request_media_content_reindex,
    retract_media_content_index,
)
from nexus.services.media_processing_state import mark_ready_for_reading_by_id
from nexus.services.transcript_segments import TranscriptSegmentInput, insert_transcript_fragments
from nexus.services.transcripts.request_reason import TranscriptRequestReason
from nexus.services.transcripts.state import TranscriptOrigin, set_media_transcript_state


def write_current_transcript(
    db: Session,
    *,
    media_id: UUID,
    request_reason: TranscriptRequestReason,
    transcript_coverage: Literal["partial", "full"],
    transcript_segments: Sequence[TranscriptSegmentInput],
    transcript_origin: TranscriptOrigin,
    now: datetime,
) -> None:
    """Publish a transcript outside a source attempt, make the media readable, index it."""
    publish_source_transcript(
        db,
        media_id=media_id,
        request_reason=request_reason,
        transcript_coverage=transcript_coverage,
        transcript_segments=transcript_segments,
        transcript_origin=transcript_origin,
        now=now,
    )
    mark_ready_for_reading_by_id(db, media_id=media_id, now=now)
    request_media_content_reindex(db, media_id=media_id, reason="source_success")


def publish_source_transcript(
    db: Session,
    *,
    media_id: UUID,
    request_reason: TranscriptRequestReason,
    transcript_coverage: Literal["partial", "full"],
    transcript_segments: Sequence[TranscriptSegmentInput],
    transcript_origin: TranscriptOrigin,
    now: datetime,
) -> None:
    """Replace the transcript rows in the caller's transaction.

    The media row is the publication boundary (``FOR NO KEY UPDATE``, the media lock mode
    every index and source writer takes). Highlights are authored user data and are
    never deleted here: their selectors re-resolve against the new fragments.
    """
    params = {"media_id": media_id}
    if (
        db.scalar(text("SELECT id FROM media WHERE id = :media_id FOR NO KEY UPDATE"), params)
        is None
    ):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    db.execute(text("DELETE FROM podcast_transcript_segments WHERE media_id = :media_id"), params)
    db.execute(text("DELETE FROM fragments WHERE media_id = :media_id"), params)
    insert_transcript_fragments(db, media_id, transcript_segments, now=now)
    if transcript_segments:
        db.execute(
            text(
                """
                INSERT INTO podcast_transcript_segments (media_id, segment_idx, canonical_text,
                    t_start_ms, t_end_ms, speaker_label, created_at)
                VALUES (:media_id, :segment_idx, :canonical_text, :t_start_ms, :t_end_ms,
                    :speaker_label, :created_at)
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
    retract_media_content_index(db, media_id=media_id)
    set_media_transcript_state(
        db,
        media_id=media_id,
        transcript_state="partial" if transcript_coverage == "partial" else "ready",
        transcript_coverage=transcript_coverage,
        last_request_reason=request_reason,
        last_error_code=None,
        transcript_origin=transcript_origin,
        now=now,
    )
