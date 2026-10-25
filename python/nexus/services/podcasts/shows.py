"""The canonical show: upsert from provider facts and its credit."""

from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.retries import TransactionRestart, integrity_constraint_name
from nexus.services.browse.targets import ResolvedPodcast
from nexus.services.contributor_taxonomy import RawCreditEntry, build_observation
from nexus.services.contributor_writes import PodcastTarget
from nexus.services.contributors import apply_observed_role_slices_in_current_transaction
from nexus.services.search import projection
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url

from .provider import PROVIDER

_IDENTITY = {"uq_podcasts_provider_provider_podcast_id", "uq_podcasts_feed_url"}


def validate_and_normalize_feed_url(feed_url: str) -> str:
    validate_requested_url(feed_url)
    split = urlsplit(normalize_url_for_display(feed_url))
    return urlunsplit((split.scheme, split.netloc, split.path.rstrip("/") or "/", split.query, ""))


def upsert_show(db: Session, show: ResolvedPodcast) -> UUID:
    """Resolve by provider id, then by feed url, else create; then apply the author credit."""
    params = {
        "provider": PROVIDER,
        "ref": show.podcast_ref,
        "title": show.title,
        "feed_url": show.feed_url,
        "website_url": show.website_url,
        "image_url": show.image_url,
        "description": show.description,
    }
    by_ref = db.execute(
        text("SELECT id FROM podcasts WHERE provider = :provider AND provider_podcast_id = :ref"),
        params,
    ).first()
    by_feed = db.execute(text("SELECT id FROM podcasts WHERE feed_url = :feed_url"), params).first()
    existing = by_ref or by_feed
    if existing is None:
        try:
            podcast_id = db.scalar(
                text("""
                    INSERT INTO podcasts (
                        provider, provider_podcast_id, title, feed_url,
                        website_url, image_url, description
                    )
                    VALUES (
                        :provider, :ref, :title, :feed_url,
                        :website_url, :image_url, :description
                    )
                    RETURNING id
                """),
                params,
            )
        except IntegrityError as exc:
            if integrity_constraint_name(exc) not in _IDENTITY:
                raise
            raise TransactionRestart from exc
    else:
        podcast_id = existing.id
        db.execute(
            text("""
                UPDATE podcasts
                SET title = :title,
                    provider_podcast_id = :ref,
                    feed_url = CASE WHEN :own_feed THEN :feed_url ELSE feed_url END,
                    website_url = COALESCE(:website_url, website_url),
                    image_url = COALESCE(:image_url, image_url),
                    description = COALESCE(:description, description),
                    updated_at = now()
                WHERE id = :podcast_id
            """),
            {**params, "podcast_id": podcast_id, "own_feed": by_feed in (None, existing)},
        )
    if show.author:
        observation, _ = build_observation({"author": [RawCreditEntry(credited_name=show.author)]})
        apply_observed_role_slices_in_current_transaction(
            db, target=PodcastTarget(podcast_id), observation=observation, source=PROVIDER
        )
    db.flush()
    projection.refresh(db, "podcast", [podcast_id])
    return podcast_id
