"""Resolve-or-create the canonical `podcasts` row and its show credits."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.errors import integrity_constraint_name
from nexus.logging import get_logger
from nexus.schemas.contributors import ContributorCreditIn
from nexus.schemas.podcast import PodcastSourceFacts
from nexus.services.collection_revisions import CollectionFamily, bump_all_collection_families
from nexus.services.contributor_taxonomy import RawCreditEntry, build_observation
from nexus.services.contributors import (
    PodcastTarget,
    apply_observed_role_slices_in_current_transaction,
)
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url

from .provider import PODCAST_PROVIDER

logger = get_logger(__name__)

_IDENTITY_CONSTRAINTS = {
    "uq_podcasts_provider_provider_podcast_id",
    "uq_podcasts_feed_url",
}


def upsert_podcast(db: Session, body: PodcastSourceFacts, *, now: datetime) -> UUID:
    """Resolve the show by provider id, then by feed url, else create it."""
    existing_id = select_podcast_id_by_provider_id(db, body.provider_podcast_id)
    feed_owner_id = select_podcast_id_by_feed_url(db, body.feed_url)
    if existing_id is not None:
        update_podcast_metadata(
            db,
            podcast_id=existing_id,
            body=body,
            now=now,
            set_feed_url=feed_owner_id in (None, existing_id),
        )
        return existing_id
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
            podcast_id = db.execute(
                text(
                    """
                    INSERT INTO podcasts (
                        provider, provider_podcast_id, title, feed_url,
                        website_url, image_url, description, created_at, updated_at
                    )
                    VALUES (
                        :provider, :provider_podcast_id, :title, :feed_url,
                        :website_url, :image_url, :description, :created_at, :updated_at
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
            ).scalar_one()
    except IntegrityError as exc:
        if integrity_constraint_name(exc) not in _IDENTITY_CONSTRAINTS:
            raise
        return upsert_podcast(db, body, now=now)
    _bump_podcast_identity_collections(db)
    return UUID(str(podcast_id))


def select_podcast_id_by_provider_id(db: Session, provider_podcast_id: str) -> UUID | None:
    return db.scalar(
        text(
            """
            SELECT id
            FROM podcasts
            WHERE provider = :provider AND provider_podcast_id = :provider_podcast_id
            """
        ),
        {"provider": PODCAST_PROVIDER, "provider_podcast_id": provider_podcast_id},
    )


def select_podcast_id_by_feed_url(db: Session, normalized_feed_url: str) -> UUID | None:
    return db.scalar(
        text("SELECT id FROM podcasts WHERE feed_url = :feed_url"),
        {"feed_url": normalized_feed_url},
    )


def validate_and_normalize_feed_url(feed_url: str) -> str:
    validate_requested_url(feed_url)
    split = urlsplit(normalize_url_for_display(feed_url))
    path = (split.path or "").rstrip("/") or "/"
    return urlunsplit((split.scheme, split.netloc, path, split.query, ""))


def update_podcast_metadata(
    db: Session,
    *,
    podcast_id: UUID,
    body: PodcastSourceFacts,
    now: datetime,
    set_feed_url: bool = False,
    set_provider_podcast_id: bool = False,
) -> None:
    db.execute(
        text(
            """
            UPDATE podcasts
            SET title = :title,
                website_url = COALESCE(:website_url, website_url),
                image_url = COALESCE(:image_url, image_url),
                description = COALESCE(:description, description),
                feed_url = CASE WHEN :set_feed_url THEN :feed_url ELSE feed_url END,
                provider_podcast_id = CASE
                    WHEN :set_provider_podcast_id THEN :provider_podcast_id
                    ELSE provider_podcast_id
                END,
                updated_at = :updated_at
            WHERE id = :podcast_id
            """
        ),
        {
            "podcast_id": podcast_id,
            "title": body.title,
            "website_url": body.website_url,
            "image_url": body.image_url,
            "description": body.description,
            "feed_url": body.feed_url,
            "set_feed_url": set_feed_url,
            "provider_podcast_id": body.provider_podcast_id,
            "set_provider_podcast_id": set_provider_podcast_id,
            "updated_at": now,
        },
    )
    _bump_podcast_identity_collections(db)


def apply_podcast_contributor_credits_in_current_transaction(
    db: Session,
    *,
    podcast_id: UUID,
    contributors: Sequence[ContributorCreditIn],
) -> None:
    """Apply trusted show credits inside the owning acquisition transaction."""
    role_to_entries: dict[str, list[RawCreditEntry]] = {}
    for credit in contributors:
        role_to_entries.setdefault(credit.role, []).append(
            RawCreditEntry(credited_name=credit.credited_name, raw_role=credit.raw_role)
        )
    observation, truncated = build_observation(role_to_entries)
    if truncated:
        logger.info(
            "podcast_contributor_truncated", podcast_id=str(podcast_id), truncated=truncated
        )
    apply_observed_role_slices_in_current_transaction(
        db,
        target=PodcastTarget(podcast_id),
        observation=observation,
        source=PODCAST_PROVIDER,
    )


def _bump_podcast_identity_collections(db: Session) -> None:
    bump_all_collection_families(
        db,
        families=(CollectionFamily.LibraryEntries, CollectionFamily.PodcastSubscriptions),
    )
