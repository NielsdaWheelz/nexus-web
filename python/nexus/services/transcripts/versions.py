"""The single owner of transcript-version writes and media_transcript_states.

Podcast RSS sync, on-demand podcast transcription, and YouTube ingest all call
`write_transcript_version`; none re-implements the deactivate/allocate/insert
sequence and none reaches a private symbol of another module. The advisory lock
is kind-agnostic (`transcript-version:{media_id}`) and the two unique indexes on
`podcast_transcript_versions` (`(media_id, version_no)` and the partial
`(media_id) WHERE is_active`) are the integrity backstop under READ COMMITTED.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, assert_never
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services.content_indexing import (
    deactivate_media_content_index,
    mark_content_index_failed,
    rebuild_transcript_content_index,
)
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
class TranscriptWriteResult:
    transcript_version_id: UUID
    version_no: int
    segment_count: int
    semantic_status: Literal["ready", "failed"]


def write_transcript_version(
    db: Session,
    *,
    media_id: UUID,
    created_by_user_id: UUID | None,
    request_reason: TranscriptRequestReason,
    transcript_coverage: Literal["partial", "full"],
    transcript_segments: Sequence[TranscriptSegmentInput],
    fragment_strategy: Literal["preserve_anchors", "replace"] = "preserve_anchors",
    now: datetime,
) -> TranscriptWriteResult:
    """Create the next transcript version and make the media readable.

    Runs in the CALLER's transaction (transaction() is non-reentrant). Holds
    `pg_advisory_xact_lock('transcript-version:{media_id}')` across the whole
    sequence: deactivate prior versions, allocate `MAX(version_no)+1`, insert the
    version, dispose of prior fragments per `fragment_strategy`, insert the new
    fragments and segments, rebuild the semantic index, and record the media
    transcript state. `fragment_strategy="preserve_anchors"` bumps prior fragments
    aside so existing highlight anchors survive; `"replace"` deletes the media's
    highlights and fragments first (destructive; YouTube re-ingest only).
    """
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtext(:lock_key))"),
        {"lock_key": f"transcript-version:{media_id}"},
    )

    db.execute(
        text(
            """
            UPDATE podcast_transcript_versions
            SET is_active = false, updated_at = :now
            WHERE media_id = :media_id
            """
        ),
        {"media_id": media_id, "now": now},
    )
    next_version_no = int(
        db.execute(
            text(
                """
                SELECT COALESCE(MAX(version_no), 0) + 1
                FROM podcast_transcript_versions
                WHERE media_id = :media_id
                """
            ),
            {"media_id": media_id},
        ).scalar_one()
    )
    try:
        transcript_version_id: UUID = db.execute(
            text(
                """
                INSERT INTO podcast_transcript_versions (
                    media_id, version_no, transcript_coverage, is_active,
                    request_reason, created_by_user_id, created_at, updated_at
                )
                VALUES (
                    :media_id, :version_no, :transcript_coverage, true,
                    :request_reason, :created_by_user_id, :now, :now
                )
                RETURNING id
                """
            ),
            {
                "media_id": media_id,
                "version_no": next_version_no,
                "transcript_coverage": transcript_coverage,
                "request_reason": request_reason,
                "created_by_user_id": created_by_user_id,
                "now": now,
            },
        ).scalar_one()
    except IntegrityError as exc:
        # The unique indexes reject a duplicate version_no / second active row, so a
        # lost race is a retryable conflict, never a corrupted or lost transcript.
        raise ApiError(
            ApiErrorCode.E_RETRY_INVALID_STATE,
            "Concurrent transcript version write; retry.",
        ) from exc

    if fragment_strategy == "preserve_anchors":
        db.execute(
            text("UPDATE fragments SET idx = idx + 1000000 WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
    elif fragment_strategy == "replace":
        db.execute(
            text(
                """
                DELETE FROM highlights AS h
                USING highlight_fragment_anchors AS hfa
                JOIN fragments AS f ON f.id = hfa.fragment_id
                WHERE h.id = hfa.highlight_id
                  AND f.media_id = :media_id
                """
            ),
            {"media_id": media_id},
        )
        db.execute(
            text("DELETE FROM fragments WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
    else:
        assert_never(fragment_strategy)

    insert_transcript_fragments(
        db,
        media_id,
        transcript_segments,
        now=now,
        transcript_version_id=transcript_version_id,
    )
    for segment_idx, segment in enumerate(transcript_segments):
        db.execute(
            text(
                """
                INSERT INTO podcast_transcript_segments (
                    transcript_version_id, media_id, segment_idx, canonical_text,
                    t_start_ms, t_end_ms, speaker_label, created_at
                )
                VALUES (
                    :transcript_version_id, :media_id, :segment_idx, :canonical_text,
                    :t_start_ms, :t_end_ms, :speaker_label, :created_at
                )
                """
            ),
            {
                "transcript_version_id": transcript_version_id,
                "media_id": media_id,
                "segment_idx": segment_idx,
                "canonical_text": segment.canonical_text,
                "t_start_ms": segment.t_start_ms,
                "t_end_ms": segment.t_end_ms,
                "speaker_label": segment.speaker_label,
                "created_at": now,
            },
        )

    deactivate_media_content_index(db, media_id=media_id, reason="transcript_replacement")
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
                transcript_version_id=transcript_version_id,
                transcript_segments=transcript_segments,
                reason="transcript_version_write",
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
            transcript_version_id=str(transcript_version_id),
            error=str(exc),
        )
        mark_content_index_failed(
            db,
            media_id=media_id,
            failure_code=semantic_error_code,
            failure_message=str(exc),
        )

    db.execute(
        text(
            """
            UPDATE media
            SET processing_status = 'ready_for_reading',
                failure_stage = NULL,
                last_error_code = NULL,
                last_error_message = NULL,
                processing_completed_at = :now,
                failed_at = NULL,
                updated_at = :now
            WHERE id = :media_id
            """
        ),
        {"media_id": media_id, "now": now},
    )
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
    return TranscriptWriteResult(
        transcript_version_id=transcript_version_id,
        version_no=next_version_no,
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
    """Insert or update the media_transcript_states row on a transcript-version write.

    The active transcript version is resolved by `WHERE is_active` on
    `podcast_transcript_versions`, so this row carries no version pointer.
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
