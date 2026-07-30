"""Cycle-free active-subscription playback-preference query."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.presence import Absent, Present, presence_from_nullable


def load_subscription_playback_preferences(
    db: Session,
    *,
    viewer_id: UUID,
    podcast_ids: list[UUID],
) -> dict[UUID, Absent | Present[float]]:
    """Return the owned nullable preference for each active subscription."""
    podcast_ids = list(dict.fromkeys(podcast_ids))
    if not podcast_ids:
        return {}
    rows = db.execute(
        text(
            """
            SELECT podcast_id, default_playback_speed
            FROM podcast_subscriptions
            WHERE user_id = :viewer_id
              AND podcast_id = ANY(:podcast_ids)
            """
        ),
        {"viewer_id": viewer_id, "podcast_ids": podcast_ids},
    ).mappings()
    return {
        UUID(str(row["podcast_id"])): presence_from_nullable(
            float(row["default_playback_speed"])
            if row["default_playback_speed"] is not None
            else None
        )
        for row in rows
    }
