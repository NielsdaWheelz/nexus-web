"""Narrow raw-SQL owner for states production APIs cannot create on demand."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session


def expire_claim_and_handoff_code(db: Session, *, job_id: UUID, user_id: UUID) -> None:
    """Model a worker crash after claim and an already-expired one-use auth code."""
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
