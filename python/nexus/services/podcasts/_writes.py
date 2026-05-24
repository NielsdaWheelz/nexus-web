"""Shared podcast row-write helpers used by catalog and subscription flows."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.podcast import PodcastEnsureRequest, PodcastSubscribeRequest
from nexus.services.contributor_credits import replace_podcast_contributor_credits

from .provider import PODCAST_PROVIDER


def replace_podcast_contributors_from_body(
    db: Session,
    podcast_id: UUID,
    body: PodcastSubscribeRequest | PodcastEnsureRequest,
) -> None:
    replace_podcast_contributor_credits(
        db,
        podcast_id=podcast_id,
        credits=[credit.model_dump(mode="json") for credit in body.contributors],
        source=PODCAST_PROVIDER,
    )


def update_podcast_metadata(
    db: Session,
    *,
    podcast_id: UUID,
    body: PodcastSubscribeRequest | PodcastEnsureRequest,
    now: datetime,
    set_feed_url: bool = False,
    set_provider_podcast_id: bool = False,
) -> None:
    set_clauses = [
        "title = :title",
        "website_url = COALESCE(:website_url, website_url)",
        "image_url = COALESCE(:image_url, image_url)",
        "description = COALESCE(:description, description)",
        "updated_at = :updated_at",
    ]
    params: dict[str, Any] = {
        "podcast_id": podcast_id,
        "title": body.title,
        "website_url": body.website_url,
        "image_url": body.image_url,
        "description": body.description,
        "updated_at": now,
    }
    if set_feed_url:
        set_clauses.append("feed_url = :feed_url")
        params["feed_url"] = body.feed_url
    if set_provider_podcast_id:
        set_clauses.append("provider_podcast_id = :provider_podcast_id")
        params["provider_podcast_id"] = body.provider_podcast_id
    db.execute(
        text("UPDATE podcasts SET " + ", ".join(set_clauses) + " WHERE id = :podcast_id"),
        params,
    )
