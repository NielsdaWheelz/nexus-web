"""Cycle-free active-subscription playback-preference query."""

from __future__ import annotations

from typing import cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.consumption import PauseShorteningMode
from nexus.schemas.presence import Absent, Present, absent, presence_from_nullable, present


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


def pause_shortening_mode_from_nullable(
    value: object,
) -> Absent | Present[PauseShorteningMode]:
    """Decode the nullable subscription value; unknown storage is corruption."""
    if value is None:
        return absent()
    stored = str(value)
    if stored not in ("Off", "Natural"):
        # justify-defect: Podcast settings is the sole writer and only accepts
        # the closed PauseShorteningMode vocabulary.
        raise AssertionError(f"unknown podcast pause_shortening_mode: {stored!r}")
    return present(cast(PauseShorteningMode, stored))


def load_subscription_pause_shortening_modes(
    db: Session,
    *,
    viewer_id: UUID,
    podcast_ids: list[UUID],
) -> dict[UUID, Absent | Present[PauseShorteningMode]]:
    """Return the owned nullable mode for each active subscription."""
    podcast_ids = list(dict.fromkeys(podcast_ids))
    if not podcast_ids:
        return {}
    rows = db.execute(
        text(
            """
            SELECT podcast_id, pause_shortening_mode
            FROM podcast_subscriptions
            WHERE user_id = :viewer_id
              AND podcast_id = ANY(:podcast_ids)
            """
        ),
        {"viewer_id": viewer_id, "podcast_ids": podcast_ids},
    ).mappings()
    return {
        UUID(str(row["podcast_id"])): pause_shortening_mode_from_nullable(
            row["pause_shortening_mode"]
        )
        for row in rows
    }
