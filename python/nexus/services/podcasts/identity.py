"""Podcast identity ownership: podcast-row upsert, identity lookups, and the
post-commit contributor observation for the subscribe/OPML boundary.

The podcast row's own identity recovery still uses ``begin_nested`` (podcast-row
identity against ``uq_podcasts_*``, explicitly not the author path). Contributor
credits are no longer written inside the upsert transaction: the typed payload is
turned into one observation and applied through the author facade in a fresh
session *after* the caller's transaction commits (spec 2.1/2.4, D-3/D-4/D-5).
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.errors import integrity_constraint_name
from nexus.logging import get_logger
from nexus.schemas.contributors import ContributorCreditIn
from nexus.schemas.podcast import PodcastSubscribeRequest
from nexus.services.contributor_taxonomy import RawCreditEntry, build_observation
from nexus.services.contributors import PodcastTarget, replace_observed_role_slices
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url

from .provider import PODCAST_PROVIDER

logger = get_logger(__name__)


def upsert_podcast(
    db: Session,
    body: PodcastSubscribeRequest,
    *,
    now: datetime,
) -> UUID:
    existing_id = select_podcast_id_by_provider_id(db, body.provider_podcast_id)
    if existing_id is not None:
        feed_owner_id = select_podcast_id_by_feed_url(db, body.feed_url)
        if feed_owner_id is not None and feed_owner_id != existing_id:
            update_podcast_metadata(db, podcast_id=existing_id, body=body, now=now)
            return existing_id

        update_podcast_metadata(db, podcast_id=existing_id, body=body, now=now, set_feed_url=True)
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
        return feed_owner_id

    assert row is not None  # the INSERT ... RETURNING id always yields one row on success
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


def observe_podcast_contributor_credits(
    podcast_id: UUID,
    contributors: Sequence[ContributorCreditIn],
) -> None:
    """Post-commit author step for the subscribe/OPML boundary (spec 2.1, D-3/D-4/D-5).

    Turns the typed payload into one observation — ``managedRoles`` = the roles
    present in the payload (§2.1) — and applies it through the author facade in a
    fresh session. Callers MUST invoke this only after their podcast-upsert
    transaction commits (the facade opens its own fresh serializable session and
    asserts no open transaction, D-22).

    An empty or fully-cleaned-away payload yields ``NOT_OBSERVED``, so prior
    provider credits are preserved rather than erased (D-5). This boundary carries
    no identity key (spec 5): the typed payload structurally has none, so future
    same-name observations resolve by name, and an observed spelling is stored
    only as a searchable non-resolving alias.
    """
    role_to_entries: dict[str, list[RawCreditEntry]] = {}
    for credit in contributors:
        role_to_entries.setdefault(credit.role, []).append(
            RawCreditEntry(credited_name=credit.credited_name, raw_role=credit.raw_role)
        )
    observation, truncated = build_observation(role_to_entries)
    if truncated:
        logger.info(
            "podcast_contributor_truncated",
            podcast_id=str(podcast_id),
            truncated=truncated,
        )
    replace_observed_role_slices(
        target=PodcastTarget(podcast_id),
        observation=observation,
        source=PODCAST_PROVIDER,
    )


def update_podcast_metadata(
    db: Session,
    *,
    podcast_id: UUID,
    body: PodcastSubscribeRequest,
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
