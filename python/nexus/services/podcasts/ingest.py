"""Fenced Podcast episode ingest: media, episodes, aliases, credits, chapters."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.coerce import coerce_positive_int
from nexus.ids import new_uuid7
from nexus.logging import get_logger
from nexus.schemas.presence import nullable_from_presence
from nexus.schemas.publication_dates import normalize_source_publication_date
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_all_collection_families,
    bump_collection_revisions,
)
from nexus.services.contributor_credits import load_contributor_credits_for_podcasts
from nexus.services.contributor_taxonomy import (
    NOT_OBSERVED,
    ObservedRoleSlices,
    RawCreditEntry,
    build_observation,
)
from nexus.services.contributor_writes import MediaTarget
from nexus.services.contributors import apply_observed_role_slices_in_current_transaction
from nexus.services.library_entries import (
    ensure_subscription_episode_default_in_current_transaction,
)
from nexus.services.metadata_dispatch import enqueue_metadata_enrichment
from nexus.services.transcripts.state import ensure_media_transcript_state_row

from ._normalize import (
    normalize_language_tag,
    normalize_optional_text,
    normalize_provider_published_at,
    parse_iso_datetime,
)
from .episode_identity import (
    EpisodeIdentityConflict,
    attach_episode_aliases_in_current_transaction,
    diagnostic_episode_alias,
    lock_episode_aliases,
    resolve_episode_aliases_in_current_transaction,
    validate_episode_alias_batch,
)
from .provider import PODCAST_PROVIDER

logger = get_logger(__name__)


@dataclass(frozen=True)
class SubscriptionIngestResult:
    """Result of one fenced Podcast episode batch."""

    ingested_episode_count: int
    added_to_subscriber_all_count: int
    source_limited: bool


def sync_subscription_ingest(
    *,
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
    feed_url: str,
    selected_episodes: list[dict[str, Any]],
    now: datetime,
) -> SubscriptionIngestResult:
    """Upsert one episode batch under the batch alias lock and the show lock."""
    # The candidate-alias locks, in canonical order, are this transaction's first
    # action: every other Podcast writer takes the same prefix in the same order.
    aliases_by_episode = validate_episode_alias_batch(selected_episodes)
    lock_episode_aliases(
        db,
        podcast_id,
        (alias for episode_aliases in aliases_by_episode for alias in episode_aliases),
    )
    if (
        db.execute(
            text("SELECT 1 FROM podcasts WHERE id = :podcast_id FOR UPDATE"),
            {"podcast_id": podcast_id},
        ).first()
        is None
    ):
        raise EpisodeIdentityConflict("episode Podcast identity is missing")

    podcast_author_names = [
        credit.credited_name
        for credit in load_contributor_credits_for_podcasts(db, [podcast_id]).get(podcast_id, [])
        if credit.role == "author" and credit.credited_name
    ]
    ingested_episode_count = 0
    added_to_subscriber_all_count = 0
    source_limited = False
    enrichment_media_ids: set[UUID] = set()

    for episode, aliases in zip(selected_episodes, aliases_by_episode, strict=True):
        if not aliases:
            source_limited = True
            continue
        row = _episode_row(episode, feed_url=feed_url, podcast_author_names=podcast_author_names)
        existing_media_id = resolve_episode_aliases_in_current_transaction(
            db, podcast_id=podcast_id, aliases=aliases
        )
        if existing_media_id is None:
            media_id = new_uuid7()
            _insert_episode(
                db,
                media_id=media_id,
                podcast_id=podcast_id,
                viewer_id=viewer_id,
                row=row,
                provider_id=diagnostic_episode_alias(aliases).value,
                now=now,
            )
            ingested_episode_count += 1
            enrichment_media_ids.add(media_id)
            attach_episode_aliases_in_current_transaction(
                db, podcast_id=podcast_id, media_id=media_id, aliases=aliases
            )
        else:
            media_id = existing_media_id
            alias_set = attach_episode_aliases_in_current_transaction(
                db, podcast_id=podcast_id, media_id=media_id, aliases=aliases
            )
            _update_episode(
                db,
                media_id=media_id,
                row=row,
                provider_id=diagnostic_episode_alias(alias_set).value,
                now=now,
            )

        observation = (
            build_observation(
                {"author": [RawCreditEntry(credited_name=name) for name in row["author_names"]]}
            )[0]
            if row["author_names"]
            else NOT_OBSERVED
        )
        if isinstance(observation, ObservedRoleSlices):
            apply_observed_role_slices_in_current_transaction(
                db, target=MediaTarget(media_id), observation=observation, source="rss"
            )
        if not row["author_names"]:
            enrichment_media_ids.add(media_id)
        if ensure_subscription_episode_default_in_current_transaction(
            db, viewer_id, podcast_id, media_id
        ):
            added_to_subscriber_all_count += 1
        _upsert_chapters(db, media_id=media_id, chapter_rows=episode.get("rss_chapters"), now=now)

    for media_id in enrichment_media_ids:
        # Queue enlistment belongs to this transaction: a queue write failure must
        # abort the batch rather than falsely advance the caller's fence.
        enqueue_metadata_enrichment(
            db,
            media_id=media_id,
            requester_user_id=viewer_id,
            request_id=None,
            dedupe_key=f"enrich-metadata:{media_id}",
        )

    # Co-subscribers see this show through no other collection family, so their
    # per-viewer PodcastSubscriptions revision is the only invalidation they get.
    bump_collection_revisions(
        db,
        viewer_ids=tuple(
            db.execute(
                text("SELECT user_id FROM podcast_subscriptions WHERE podcast_id = :podcast_id"),
                {"podcast_id": podcast_id},
            ).scalars()
        ),
        family=CollectionFamily.PodcastSubscriptions,
    )
    if selected_episodes:
        bump_all_collection_families(
            db,
            families=(
                CollectionFamily.AuthorWorks,
                CollectionFamily.LibraryEntries,
                CollectionFamily.PodcastEpisodes,
            ),
        )

    return SubscriptionIngestResult(
        ingested_episode_count=ingested_episode_count,
        added_to_subscriber_all_count=added_to_subscriber_all_count,
        source_limited=source_limited,
    )


def _episode_row(
    episode: dict[str, Any], *, feed_url: str, podcast_author_names: list[str]
) -> dict[str, Any]:
    description_text = normalize_optional_text(episode.get("description_text"))
    source_published_at = normalize_provider_published_at(episode.get("published_at"))
    author_names: list[str] = []
    raw_authors = episode.get("authors")
    if isinstance(raw_authors, list):
        for raw_author in raw_authors:
            name = str(raw_author or "").strip()
            if name and name not in author_names:
                author_names.append(name)
    return {
        "title": str(episode.get("title") or "Untitled Episode"),
        "canonical_source_url": feed_url,
        "external_playback_url": normalize_optional_text(episode.get("audio_url")),
        "description": description_text[:2000] if description_text else None,
        "description_html": normalize_optional_text(episode.get("description_html")),
        "description_text": description_text,
        "edition_published_date": nullable_from_presence(
            normalize_source_publication_date(source_published_at)
        ),
        "published_at": parse_iso_datetime(source_published_at),
        "duration_seconds": coerce_positive_int(episode.get("duration_seconds")),
        "language": normalize_language_tag(episode.get("language"))
        or normalize_language_tag(episode.get("feed_language")),
        "rss_transcript_url": normalize_optional_text(episode.get("rss_transcript_url")),
        "author_names": author_names or list(podcast_author_names),
    }


def _insert_episode(
    db: Session,
    *,
    media_id: UUID,
    podcast_id: UUID,
    viewer_id: UUID,
    row: dict[str, Any],
    provider_id: str,
    now: datetime,
) -> None:
    db.execute(
        text(
            """
            INSERT INTO media (
                id, kind, title, canonical_source_url, processing_status,
                external_playback_url, provider, provider_id, description,
                edition_published_date, language, created_by_user_id, created_at, updated_at
            )
            VALUES (
                :media_id, 'podcast_episode', :title, :canonical_source_url, 'pending',
                :external_playback_url, :provider, :provider_id, :description,
                :edition_published_date, :language, :created_by_user_id, :now, :now
            )
            """
        ),
        {
            **row,
            "media_id": media_id,
            "provider": PODCAST_PROVIDER,
            "provider_id": provider_id,
            "created_by_user_id": viewer_id,
            "now": now,
        },
    )
    ensure_media_transcript_state_row(db, media_id=media_id, now=now)
    db.execute(
        text(
            """
            INSERT INTO podcast_episodes (
                media_id, podcast_id, published_at, duration_seconds,
                description_html, description_text, rss_transcript_url, created_at
            )
            VALUES (
                :media_id, :podcast_id, :published_at, :duration_seconds,
                :description_html, :description_text, :rss_transcript_url, :now
            )
            """
        ),
        {**row, "media_id": media_id, "podcast_id": podcast_id, "now": now},
    )


def _update_episode(
    db: Session, *, media_id: UUID, row: dict[str, Any], provider_id: str, now: datetime
) -> None:
    db.execute(
        text(
            """
            UPDATE media
            SET title = :title,
                canonical_source_url = :canonical_source_url,
                external_playback_url = :external_playback_url,
                description = COALESCE(:description, description),
                edition_published_date =
                    COALESCE(:edition_published_date, edition_published_date),
                language = COALESCE(:language, language),
                provider = :provider,
                provider_id = :provider_id,
                updated_at = :now
            WHERE id = :media_id
            """
        ),
        {
            **row,
            "media_id": media_id,
            "provider": PODCAST_PROVIDER,
            "provider_id": provider_id,
            "now": now,
        },
    )
    db.execute(
        text(
            """
            UPDATE podcast_episodes
            SET description_html = :description_html,
                description_text = :description_text,
                published_at = COALESCE(:published_at, published_at),
                duration_seconds = :duration_seconds,
                rss_transcript_url = :rss_transcript_url
            WHERE media_id = :media_id
            """
        ),
        {**row, "media_id": media_id},
    )


def _upsert_chapters(
    db: Session, *, media_id: UUID, chapter_rows: list[dict[str, Any]] | None, now: datetime
) -> None:
    """Replace the episode's chapters; `None` means the feed said nothing."""
    if chapter_rows is None:
        return
    db.execute(
        text("DELETE FROM podcast_episode_chapters WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    deduped: dict[tuple[int, str], dict[str, Any]] = {}
    for chapter in chapter_rows:
        deduped.setdefault((chapter["t_start_ms"], chapter["title"].lower()), chapter)
    if not deduped:
        return
    db.execute(
        text(
            """
            INSERT INTO podcast_episode_chapters (
                media_id, chapter_idx, title, t_start_ms, t_end_ms,
                url, image_url, source, created_at
            )
            VALUES (
                :media_id, :chapter_idx, :title, :t_start_ms, :t_end_ms,
                :url, :image_url, :source, :now
            )
            """
        ),
        [
            {**chapter, "media_id": media_id, "chapter_idx": chapter_idx, "now": now}
            for chapter_idx, chapter in enumerate(deduped.values())
        ],
    )
