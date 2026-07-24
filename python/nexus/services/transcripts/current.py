"""The single owner of current transcript writes and media_transcript_states.

Podcast RSS sync, on-demand podcast transcription, and YouTube ingest all call
`write_current_transcript`; none re-implements the replace/insert/index sequence
and none reaches a private symbol of another module. The advisory lock is
kind-agnostic (`transcript-current:{media_id}`), and current rows are keyed by
`media_id` plus their local index.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.logging import get_logger
from nexus.services.content_indexing import (
    IndexOwner,
    deactivate_content_index,
    mark_content_index_failed,
    rebuild_transcript_content_index,
)
from nexus.services.media_processing_state import mark_ready_for_reading_by_id
from nexus.services.transcript_segments import (
    TranscriptSegmentInput,
    insert_transcript_fragments,
)

logger = get_logger(__name__)

TranscriptRequestReason = Literal[
    "episode_open",
    "search",
    "highlight",
    "quote",
    "background_warming",
    "operator_requeue",
    "rss_feed",
]


@dataclass(frozen=True)
class CurrentTranscriptWriteResult:
    segment_count: int
    semantic_status: Literal["ready", "failed"]


def write_current_transcript(
    db: Session,
    *,
    media_id: UUID,
    request_reason: TranscriptRequestReason,
    transcript_coverage: Literal["partial", "full"],
    transcript_segments: Sequence[TranscriptSegmentInput],
    mark_media_ready: bool = True,
    now: datetime,
) -> CurrentTranscriptWriteResult:
    """Replace the current transcript and optionally make the media readable.

    Runs in the CALLER's transaction (transaction() is non-reentrant). Holds
    A Media FOR UPDATE lock is the shared publication boundary with public
    readers; it is acquired before the transcript-specific advisory lock and
    held across the whole sequence: remove current transcript fragments/segments,
    insert the new current rows, rebuild the semantic index, and record the media
    transcript state.
    Source-attempt materializers pass `mark_media_ready=False`; the source owner
    records terminal media success after the adapter returns.
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
    semantic_status: Literal["ready", "failed"] = "ready"
    semantic_error_code: str | None = None
    try:
        # Savepoint so a DB-level failure inside the rebuild rolls back only its own
        # writes and does not poison the outer transaction (the transcript is committed
        # below regardless of semantic-index outcome).
        with db.begin_nested():
            rebuild_transcript_content_index(
                db,
                media_id=media_id,
                transcript_segments=transcript_segments,
                reason="transcript_write",
            )
    except (
        Exception
    ) as exc:  # justify-ignore-error: semantic index is non-fatal; transcript stays usable
        semantic_status = "failed"
        semantic_error_code = (
            exc.code.value if isinstance(exc, ApiError) else ApiErrorCode.E_INTERNAL.value
        )
        logger.exception(
            "transcript_semantic_index_failed",
            media_id=str(media_id),
            error=str(exc),
        )
        mark_content_index_failed(
            db,
            owner=IndexOwner("media", media_id),
            failure_code=semantic_error_code,
            failure_message=str(exc),
        )

    if mark_media_ready:
        mark_ready_for_reading_by_id(db, media_id=media_id, now=now)
    set_media_transcript_state(
        db,
        media_id=media_id,
        transcript_state="partial" if transcript_coverage == "partial" else "ready",
        transcript_coverage=transcript_coverage,
        semantic_status=semantic_status,
        last_request_reason=request_reason,
        last_error_code=semantic_error_code,
        now=now,
    )
    return CurrentTranscriptWriteResult(
        segment_count=len(transcript_segments),
        semantic_status=semantic_status,
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
    now: datetime,
) -> None:
    """Insert or update the media_transcript_states row on a transcript write.

    `None` for semantic_status / last_request_reason preserves the existing value.
    """
    existing = db.scalar(
        text("SELECT media_id FROM media_transcript_states WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    params = {
        "media_id": media_id,
        "transcript_state": transcript_state,
        "transcript_coverage": transcript_coverage,
        "semantic_status": semantic_status,
        "last_request_reason": last_request_reason,
        "last_error_code": last_error_code,
        "now": now,
    }
    if existing is None:
        db.execute(
            text(
                """
                INSERT INTO media_transcript_states (
                    media_id, transcript_state, transcript_coverage, semantic_status,
                    last_request_reason, last_error_code, created_at, updated_at
                )
                VALUES (
                    :media_id, :transcript_state, :transcript_coverage,
                    COALESCE(:semantic_status, 'none'),
                    :last_request_reason, :last_error_code, :now, :now
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
