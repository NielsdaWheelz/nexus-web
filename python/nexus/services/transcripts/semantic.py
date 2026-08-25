"""Canonical admission for transcript semantic-index jobs."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, NotFoundError
from nexus.jobs.queue import TERMINAL_STATUSES, enqueue_job, lock_jobs_for_payload
from nexus.services.semantic_chunks import (
    current_transcript_embedding_model,
    current_transcript_embedding_provider,
)
from nexus.services.transcripts.request_reason import TranscriptRequestReason
from nexus.services.transcripts.state import set_media_transcript_state


@dataclass(frozen=True)
class TranscriptSemanticRepairAdmission:
    outcome: Literal["queued", "idempotent"]
    transcript_state: Literal["ready", "partial"]
    transcript_coverage: Literal["partial", "full"]


def enqueue_transcript_semantic_job(
    db: Session,
    *,
    media_id: UUID,
    request_reason: TranscriptRequestReason,
) -> None:
    """Enqueue one semantic-index job with the canonical transcript payload."""
    enqueue_job(
        db,
        kind="podcast_reindex_semantic_job",
        payload={
            "media_id": str(media_id),
            "request_reason": request_reason,
        },
    )


def request_transcript_semantic_repair(
    db: Session,
    *,
    media_id: UUID,
    request_reason: TranscriptRequestReason,
    now: datetime,
) -> TranscriptSemanticRepairAdmission:
    """Admit at most one repair job for one current readable transcript."""
    locked_media_id = db.scalar(
        text("SELECT id FROM media WHERE id = :media_id FOR UPDATE"),
        {"media_id": media_id},
    )
    if locked_media_id is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    state = db.execute(
        text(
            """
            SELECT transcript_state, transcript_coverage, semantic_status
            FROM media_transcript_states
            WHERE media_id = :media_id
            FOR UPDATE
            """
        ),
        {"media_id": media_id},
    ).one_or_none()
    if (
        state is None
        or state.transcript_state not in {"ready", "partial"}
        or state.transcript_coverage not in {"partial", "full"}
        or state.semantic_status not in {"pending", "ready", "failed"}
    ):
        # justify-defect: the request dispatcher calls this operation only for a
        # readable transcript snapshot; every writer serializes on the Media row.
        raise AssertionError("semantic repair requires a current readable transcript")

    transcript_state: Literal["ready", "partial"] = state.transcript_state
    transcript_coverage: Literal["partial", "full"] = state.transcript_coverage
    jobs = lock_jobs_for_payload(
        db,
        kind="podcast_reindex_semantic_job",
        expected_payload_match={"media_id": str(media_id)},
    )
    if any(job.status not in TERMINAL_STATUSES for job in jobs):
        return TranscriptSemanticRepairAdmission(
            outcome="idempotent",
            transcript_state=transcript_state,
            transcript_coverage=transcript_coverage,
        )
    if state.semantic_status == "ready" and not _transcript_semantic_index_requires_repair(
        db,
        media_id=media_id,
    ):
        return TranscriptSemanticRepairAdmission(
            outcome="idempotent",
            transcript_state=transcript_state,
            transcript_coverage=transcript_coverage,
        )

    enqueue_transcript_semantic_job(
        db,
        media_id=media_id,
        request_reason=request_reason,
    )
    set_media_transcript_state(
        db,
        media_id=media_id,
        transcript_state=transcript_state,
        transcript_coverage=transcript_coverage,
        semantic_status="pending",
        last_request_reason=request_reason,
        last_error_code=None,
        now=now,
    )
    return TranscriptSemanticRepairAdmission(
        outcome="queued",
        transcript_state=transcript_state,
        transcript_coverage=transcript_coverage,
    )


def _transcript_semantic_index_requires_repair(
    db: Session,
    *,
    media_id: UUID,
) -> bool:
    embedding_model = current_transcript_embedding_model()
    embedding_provider = current_transcript_embedding_provider()
    row = db.execute(
        text(
            """
            SELECT status, active_embedding_provider, active_embedding_model
            FROM content_index_states
            WHERE owner_kind = 'media' AND owner_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).one_or_none()
    return (
        row is None
        or row.status != "ready"
        or row.active_embedding_provider != embedding_provider
        or row.active_embedding_model != embedding_model
    )
