"""Per-subscription playback settings the Android player reads."""

from __future__ import annotations

from dataclasses import dataclass
from typing import cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.consumption import PauseShorteningMode
from nexus.schemas.presence import Absent, Present, absent, presence_from_nullable, present


@dataclass(frozen=True, slots=True)
class SubscriptionPlaybackSettings:
    playback_rate: Absent | Present[float]
    pause_shortening_mode: Absent | Present[PauseShorteningMode]


def pause_shortening_mode_from_nullable(value: object) -> Absent | Present[PauseShorteningMode]:
    """Decode the nullable subscription override; NULL means the device default."""
    if value is None:
        return absent()
    return present(cast(PauseShorteningMode, str(value)))


def load_subscription_playback_settings(
    db: Session,
    *,
    viewer_id: UUID,
    podcast_ids: list[UUID],
) -> dict[UUID, SubscriptionPlaybackSettings]:
    """Return the owned nullable playback settings for each active subscription."""
    ordered = list(dict.fromkeys(podcast_ids))
    if not ordered:
        return {}
    rows = db.execute(
        text(
            """
            SELECT podcast_id, default_playback_speed, pause_shortening_mode
            FROM podcast_subscriptions
            WHERE user_id = :viewer_id AND podcast_id = ANY(:podcast_ids)
            """
        ),
        {"viewer_id": viewer_id, "podcast_ids": ordered},
    ).mappings()
    return {
        UUID(str(row["podcast_id"])): SubscriptionPlaybackSettings(
            playback_rate=presence_from_nullable(
                None
                if row["default_playback_speed"] is None
                else float(row["default_playback_speed"])
            ),
            pause_shortening_mode=pause_shortening_mode_from_nullable(row["pause_shortening_mode"]),
        )
        for row in rows
    }
