"""Shared transaction lock for canonical X provider identities."""

from sqlalchemy import text
from sqlalchemy.orm import Session


def lock_x_provider_identity(db: Session, provider_id: str) -> None:
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:provider_id, 0))"),
        {"provider_id": provider_id},
    )
