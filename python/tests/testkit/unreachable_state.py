"""Narrow raw-SQL owner for states production APIs cannot create on demand."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session


def expire_job_claim(db: Session, *, job_id: UUID) -> None:
    """Model passage of a dead worker's lease without waiting in a proof."""
    db.execute(
        text(
            """
            UPDATE background_jobs
            SET lease_expires_at = now() - interval '1 second'
            WHERE id = :job_id
            """
        ),
        {"job_id": job_id},
    )


def expire_claim_and_handoff_code(db: Session, *, job_id: UUID, user_id: UUID) -> None:
    """Model a worker crash after claim and an already-expired one-use auth code."""
    expire_job_claim(db, job_id=job_id)
    db.execute(
        text(
            """
            UPDATE auth_handoff_codes
            SET created_at = now() - interval '10 minutes',
                expires_at = now() - interval '5 minutes'
            WHERE user_id = :user_id
            """
        ),
        {"user_id": user_id},
    )


def make_failed_job_retryable(db: Session, *, job_id: UUID) -> None:
    """Advance only a known failed synthetic job past its production backoff."""
    updated = db.execute(
        text(
            """
            UPDATE background_jobs
            SET available_at = now(), updated_at = now()
            WHERE id = :job_id
              AND status = 'failed'
              AND claimed_by IS NULL
            RETURNING kind
            """
        ),
        {"job_id": job_id},
    ).scalar_one()
    db.execute(text("SELECT pg_notify('nexus_background_jobs', :kind)"), {"kind": updated})
