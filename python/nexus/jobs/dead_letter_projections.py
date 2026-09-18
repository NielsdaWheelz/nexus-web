"""Closed dead-letter projections executed inside the worker's queue transition.

The background supervisor must not import parsers, providers, or storage clients
(`docs/cutovers/document-import-reliability-hard-cutover.md` §4.2.1, §7). A
dead-letter repair still has to land atomically with the terminal ``dead``
transition, so it cannot move to the child process either: the ``dead`` transition
fires exactly once and has no redrive, and splitting it from its repair would
leave a dead row with an un-applied repair.

This module is therefore the supervisor-owned executor for every dead-letter
repair. It imports only SQLAlchemy and ``nexus.errors`` at module scope. The three
background-lane projections are pure SQL here. The three interactive-lane
projections keep their existing owners and are imported inside their own branch,
so the background supervisor -- whose ``allowed_kinds`` never contain those kinds
-- can never load them.

Every projection runs inside the caller's open transaction and never commits.
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Literal
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
    if projection == "None":
        return
    if projection == "NoteContentIndex":
        _project_note_content_index(db, job)
        return
    if projection == "MediaTeardownIntent":
        _project_media_teardown_intent(db, job)
        return
    if projection == "PodcastBackfill":
        _project_podcast_backfill(db, job)
        return
    if projection == "ChatRun":
        from nexus.tasks.chat_run import record_dead_lettered_chat_run

        record_dead_lettered_chat_run(db, job)
        return
    if projection == "PodcastSubscriptionSync":
        from nexus.services.podcasts.sync import dead_letter_podcast_subscription_sync

        dead_letter_podcast_subscription_sync(db, job)
        return
    # justify-defect: DeadLetterProjection is a closed union owned by this module.
    raise AssertionError(f"dead-letter projection is not exhaustively handled: {projection!r}")


def _project_note_content_index(db: Session, job: JobRow) -> None:
    """Mark the note's content index failed once reindex retries are exhausted.

    Skips a malformed ``note_block_id`` payload (the only non-retryable failure)
    so it cannot raise inside the dead-letter transition.
    """
    note_block_id = job.payload.get("note_block_id")
    if not note_block_id:
        return
    try:
        owner_id = UUID(str(note_block_id))
    except (TypeError, ValueError):
        return
    failure_message = (job.last_error or "Note reindex exhausted retries.")[
        :_INDEX_STATUS_REASON_MAX_LENGTH
    ]
    status_reason = f"{ApiErrorCode.E_INTERNAL.value}: {failure_message}"[
        :_INDEX_STATUS_REASON_MAX_LENGTH
    ]
    now = datetime.now(UTC)
    parameters = {
        "owner_kind": "note_block",
        "owner_id": owner_id,
        "status_reason": status_reason,
        "now": now,
    }
    updated = db.execute(
        text(
            """
            UPDATE content_index_states
            SET status = 'failed',
                status_reason = :status_reason,
                active_embedding_provider = NULL,
                active_embedding_model = NULL,
                updated_at = :now
            WHERE owner_kind = :owner_kind AND owner_id = :owner_id
            RETURNING owner_id
            """
        ),
        parameters,
    ).one_or_none()
    if updated is not None:
        return
    db.execute(
        text(
            """
            INSERT INTO content_index_states (
                owner_kind,
                owner_id,
                status,
                status_reason,
                active_embedding_provider,
                active_embedding_model,
                updated_at,
                created_at
            )
            VALUES (
                :owner_kind,
                :owner_id,
                'failed',
                :status_reason,
                NULL,
                NULL,
                :now,
                :now
            )
            """
        ),
        parameters,
    )


def _project_media_teardown_intent(db: Session, job: JobRow) -> None:
    """Void only the exact matching teardown intent while the media row is live.

    A ``DeletionCommitted`` job whose media is already gone leaves the dead row
    intact for ``requeue_dead_job`` to finish the storage sweep.
    """
    media_id = UUID(str(job.payload["mediaId"]))
    intent_id = UUID(str(job.payload["intentId"]))
    media_exists = (
        db.execute(
            text("SELECT 1 FROM media WHERE id = :media_id"),
            {"media_id": media_id},
        ).first()
        is not None
    )
    if not media_exists:
        return
    # Match BOTH intentId and mediaId so an old job never voids a later intent.
    db.execute(
        text("DELETE FROM media_teardown_intents WHERE id = :intent_id AND media_id = :media_id"),
        {"intent_id": intent_id, "media_id": media_id},
    )


def _project_podcast_backfill(db: Session, job: JobRow) -> None:
    """Stamp Failed only while a dead job still names the current live fence."""
    try:
        backfill_id = UUID(str(job.payload["backfillId"]))
        expected_step_no = int(job.payload["expectedStepNo"])
        expected_digest = str(job.payload["expectedCursorDigest"])
        if expected_step_no < 0 or len(expected_digest) != 64:
            raise ValueError("Invalid Podcast backfill fence")
    except (KeyError, TypeError, ValueError):
        return
    row = (
        db.execute(
            text(
                """
                SELECT step_no, cursor, completed_at, source_limited_at, failed_at
                FROM podcast_subscription_backfills
                WHERE id = :backfill_id
                FOR UPDATE
                """
            ),
            {"backfill_id": backfill_id},
        )
        .mappings()
        .first()
    )
    if row is None or int(row["step_no"]) != expected_step_no:
        return
    if _cursor_digest(row["cursor"]) != expected_digest:
        return
    if any(row[field] is not None for field in ("completed_at", "source_limited_at", "failed_at")):
        return
    classification = str(job.error_code or ApiErrorCode.E_INTERNAL.value)[
        :_BACKFILL_ERROR_CODE_MAX_LENGTH
    ]
    db.execute(
        text(
            """
            UPDATE podcast_subscription_backfills
            SET
                failed_at = now(),
                error_code = :error_code,
                error_detail = :error_detail,
                updated_at = now()
            WHERE id = :backfill_id
            """
        ),
        {
            "backfill_id": backfill_id,
            "error_code": classification,
            "error_detail": (
                f"Podcast backfill exhausted retries; job={job.id}; classification={classification}"
            )[:_BACKFILL_ERROR_DETAIL_MAX_LENGTH],
        },
    )


def _cursor_digest(value: object) -> str:
    """Canonical replay-fence digest for a stored provider continuation."""
    if value is not None and not isinstance(value, dict):
        # justify-defect: the cursor column is a jsonb object or NULL.
        raise AssertionError("Podcast backfill cursor is not an object")
    cursor: dict[str, Any] | None = (
        None if value is None else {str(key): item for key, item in value.items()}
    )
    payload = json.dumps(
        cursor,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()
