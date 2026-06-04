"""Podcast identity ownership: upsert/ensure and identity lookups."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.errors import integrity_constraint_name
from nexus.db.session import transaction
from nexus.schemas.podcast import (
    PodcastEnsureOut,
    PodcastEnsureRequest,
    PodcastSubscribeRequest,
)
from nexus.services.contributor_credits import replace_podcast_contributor_credits
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url

from .provider import PODCAST_PROVIDER


def ensure_podcast(
    db: Session,
    body: PodcastEnsureRequest,
) -> PodcastEnsureOut:
    normalized_feed_url = validate_and_normalize_feed_url(body.feed_url)
    normalized_body = body.model_copy(update={"feed_url": normalized_feed_url})
    now = datetime.now(UTC)

    with transaction(db):
        podcast_id = upsert_podcast(db, normalized_body, now=now)

    return PodcastEnsureOut(podcast_id=podcast_id)


def upsert_podcast(
    db: Session,
    body: PodcastSubscribeRequest | PodcastEnsureRequest,
    *,
    now: datetime,
) -> UUID:
    existing_id = select_podcast_id_by_provider_id(db, body.provider_podcast_id)
    if existing_id is not None:
        feed_owner_id = select_podcast_id_by_feed_url(db, body.feed_url)
        if feed_owner_id is not None and feed_owner_id != existing_id:
            update_podcast_metadata(db, podcast_id=existing_id, body=body, now=now)
            replace_podcast_contributors_from_body(db, existing_id, body)
            return existing_id

        update_podcast_metadata(db, podcast_id=existing_id, body=body, now=now, set_feed_url=True)
        replace_podcast_contributors_from_body(db, existing_id, body)
        return existing_id

    feed_owner_id = select_podcast_id_by_feed_url(db, body.feed_url)
    if feed_owner_id is not None:
        update_podcast_metadata(
            db,
            podcast_id=feed_owner_id,
            body=body,
            now=now,
            set_feed_url=True,
            set_provider_podcast_id=True,
        )
        replace_podcast_contributors_from_body(db, feed_owner_id, body)
        return feed_owner_id

    try:
        with db.begin_nested():
            row = db.execute(
                text(
                    """
                    INSERT INTO podcasts (
                        provider,
                        provider_podcast_id,
                        title,
                        feed_url,
                        website_url,
                        image_url,
                        description,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        :provider,
                        :provider_podcast_id,
                        :title,
                        :feed_url,
                        :website_url,
                        :image_url,
                        :description,
                        :created_at,
                        :updated_at
                    )
                    RETURNING id
                    """
                ),
                {
                    "provider": PODCAST_PROVIDER,
                    "provider_podcast_id": body.provider_podcast_id,
                    "title": body.title,
                    "feed_url": body.feed_url,
                    "website_url": body.website_url,
                    "image_url": body.image_url,
                    "description": body.description,
                    "created_at": now,
                    "updated_at": now,
                },
            ).fetchone()
    except IntegrityError as exc:
        if not is_podcast_identity_conflict(exc):
            raise
        existing_id = select_podcast_id_by_provider_id(db, body.provider_podcast_id)
        if existing_id is not None:
            feed_owner_id = select_podcast_id_by_feed_url(db, body.feed_url)
            set_feed_url = not (feed_owner_id is not None and feed_owner_id != existing_id)
            update_podcast_metadata(
                db, podcast_id=existing_id, body=body, now=now, set_feed_url=set_feed_url
            )
            replace_podcast_contributors_from_body(db, existing_id, body)
            return existing_id

        feed_owner_id = select_podcast_id_by_feed_url(db, body.feed_url)
        if feed_owner_id is None:
            raise
        update_podcast_metadata(
            db,
            podcast_id=feed_owner_id,
            body=body,
            now=now,
            set_feed_url=True,
            set_provider_podcast_id=True,
        )
        replace_podcast_contributors_from_body(db, feed_owner_id, body)
        return feed_owner_id

    replace_podcast_contributors_from_body(db, row[0], body)
    return row[0]


def select_podcast_id_by_provider_id(db: Session, provider_podcast_id: str) -> UUID | None:
    row = db.execute(
        text(
            """
            SELECT id
            FROM podcasts
            WHERE provider = :provider
              AND provider_podcast_id = :provider_podcast_id
            """
        ),
        {
            "provider": PODCAST_PROVIDER,
            "provider_podcast_id": provider_podcast_id,
        },
    ).fetchone()
    if row is None:
        return None
    return row[0]


def select_podcast_id_by_feed_url(db: Session, normalized_feed_url: str) -> UUID | None:
    row = db.execute(
        text(
            """
            SELECT id
            FROM podcasts
            WHERE feed_url = :feed_url
            """
        ),
        {"feed_url": normalized_feed_url},
    ).fetchone()
    if row is None:
        return None
    return row[0]


def is_podcast_identity_conflict(exc: IntegrityError) -> bool:
    constraint_name = integrity_constraint_name(exc)
    if constraint_name:
        return constraint_name in {
            "uq_podcasts_provider_provider_podcast_id",
            "uq_podcasts_feed_url",
        }
    message = str(getattr(exc, "orig", None) or exc)
    return (
        "uq_podcasts_provider_provider_podcast_id" in message or "uq_podcasts_feed_url" in message
    )


def validate_and_normalize_feed_url(feed_url: str) -> str:
    validate_requested_url(feed_url)
    normalized = normalize_url_for_display(feed_url)
    split = urlsplit(normalized)
    normalized_path = split.path or ""
    if normalized_path and normalized_path != "/":
        normalized_path = normalized_path.rstrip("/")
    if not normalized_path:
        normalized_path = "/"
    return urlunsplit((split.scheme, split.netloc, normalized_path, split.query, ""))


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
