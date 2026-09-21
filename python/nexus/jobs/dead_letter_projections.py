"""Closed dead-letter repairs, applied inside the worker's own dead transition.

The ``dead`` transition fires exactly once and has no redrive, so a repair must
land in the same transaction; it therefore cannot move to the child process.
The background supervisor must never import a parser, provider or storage
client, so module scope here stays SQLAlchemy + ``nexus.errors`` and the two
interactive-lane repairs are imported inside their own branch. No projection
ever commits.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING, Literal
from uuid import UUID

from sqlalchemy import text

from nexus.errors import ApiErrorCode

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from nexus.jobs.queue import JobRow

type DeadLetterProjection = Literal[
    "None",
    "NoteContentIndex",
    "MediaTeardownIntent",
    "PodcastBackfill",
    "ChatRun",
    "PodcastSubscriptionSync",
]
"""Closed set of repairs a dead-lettered job kind may declare."""

_INDEX_STATUS_REASON_MAX_LENGTH = 1000
_BACKFILL_ERROR_DETAIL_MAX_LENGTH = 500
_BACKFILL_ERROR_CODE_MAX_LENGTH = 100


def apply_dead_letter_projection(
    db: Session, *, projection: DeadLetterProjection, job: JobRow
) -> None:
    """Apply one closed repair inside the caller's dead-letter transaction."""
    if projection == "NoteContentIndex":
        _project_note_content_index(db, job)
    elif projection == "MediaTeardownIntent":
        _project_media_teardown_intent(db, job)
    elif projection == "PodcastBackfill":
        _project_podcast_backfill(db, job)
    elif projection == "ChatRun":
        from nexus.tasks.chat_run import record_dead_lettered_chat_run

        record_dead_lettered_chat_run(db, job)
    elif projection == "PodcastSubscriptionSync":
        from nexus.services.podcasts.sync import dead_letter_podcast_subscription_sync

        dead_letter_podcast_subscription_sync(db, job)


def _project_note_content_index(db: Session, job: JobRow) -> None:
    """Mark the note's content index failed once reindex retries are exhausted."""
    reason = (
        f"{ApiErrorCode.E_INTERNAL.value}: {job.last_error or 'Note reindex exhausted retries.'}"
    )
    db.execute(
        text(
            """
            INSERT INTO content_index_states (
                owner_kind, owner_id, status, status_reason, updated_at, created_at
            )
            VALUES ('note_block', :owner_id, 'failed', :status_reason, :now, :now)
            ON CONFLICT (owner_kind, owner_id) DO UPDATE
            SET status = 'failed',
                status_reason = EXCLUDED.status_reason,
                active_embedding_provider = NULL,
                active_embedding_model = NULL,
                updated_at = EXCLUDED.updated_at
            """
        ),
        {
            "owner_id": UUID(str(job.payload["note_block_id"])),
            "status_reason": reason[:_INDEX_STATUS_REASON_MAX_LENGTH],
            "now": datetime.now(UTC),
        },
    )


def _project_media_teardown_intent(db: Session, job: JobRow) -> None:
    """Void only the exact matching teardown intent while the media row is live.

    A job whose media is already gone leaves the dead row intact so
    ``requeue_dead_job`` can finish the storage sweep.
    """
    db.execute(
        text(
            """
            DELETE FROM media_teardown_intents
            WHERE id = :intent_id
              AND media_id = :media_id
              AND EXISTS (SELECT 1 FROM media WHERE id = :media_id)
            """
        ),
        {
            "intent_id": UUID(str(job.payload["intentId"])),
            "media_id": UUID(str(job.payload["mediaId"])),
        },
    )


def _project_podcast_backfill(db: Session, job: JobRow) -> None:
    """Stamp Failed only while the dead job still names the current live fence."""
    classification = str(job.error_code or ApiErrorCode.E_INTERNAL.value)[
        :_BACKFILL_ERROR_CODE_MAX_LENGTH
    ]
    detail = f"Podcast backfill exhausted retries; job={job.id}; classification={classification}"
    db.execute(
        text(
            """
            UPDATE podcast_subscription_backfills
            SET failed_at = now(),
                error_code = :error_code,
                error_detail = :error_detail,
                updated_at = now()
            WHERE id = :backfill_id
              AND step_no = :expected_step_no
              AND completed_at IS NULL
              AND source_limited_at IS NULL
              AND failed_at IS NULL
            """
        ),
        {
            "backfill_id": UUID(str(job.payload["backfillId"])),
            "expected_step_no": int(job.payload["expectedStepNo"]),
            "error_code": classification,
            "error_detail": detail[:_BACKFILL_ERROR_DETAIL_MAX_LENGTH],
        },
    )
