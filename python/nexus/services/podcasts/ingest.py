"""Podcast subscription feed ingest: episode/media/chapter/transcript persistence."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.coerce import coerce_non_negative_int, coerce_positive_int
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
    ContributorObservationBatch,
    ObservedRoleSlices,
    RawCreditEntry,
    build_observation,
)
from nexus.services.contributors import (
    MediaTarget,
    apply_observed_role_slices_in_current_transaction,
)
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
    diagnostic_episode_alias_for_media,
    lock_episode_aliases,
    resolve_episode_aliases_in_current_transaction,
    validate_episode_alias_batch,
)
from .feed import (
    PODCAST_CHAPTER_SOURCE_PODCASTING20,
    PODCAST_CHAPTER_SOURCE_PODLOVE,
    normalize_podcast_chapter_link,
)
from .provider import PODCAST_PROVIDER

logger = get_logger(__name__)


@dataclass(frozen=True)
class SubscriptionIngestResult:
    """Result of one fenced Podcast episode batch."""

    ingested_episode_count: int
    added_to_subscriber_all_count: int
    source_limited: bool


def _build_episode_author_observation(author_names: list[str]) -> ContributorObservationBatch:
    """Cleaned episode/inherited author names -> one ``{author}`` observation.

    RSS carries no person identity key (spec 5). An empty list is ``NOT_OBSERVED``
    (absent data preserves prior credits, never an erase — D-5/D-16). The shared
    :func:`build_observation` cleans, dedupes, and truncates to the 20-row cap.
    """
    if not author_names:
        return NOT_OBSERVED
    batch, truncated = build_observation(
        {"author": [RawCreditEntry(credited_name=name) for name in author_names]}
    )
    if truncated:
        logger.info("podcast_episode_author_truncated", truncated=truncated)
    return batch


def sync_subscription_ingest(
    *,
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
    feed_url: str,
    selected_episodes: list[dict[str, Any]],
    now: datetime,
) -> SubscriptionIngestResult:
    # Acquire the shared alias -> Podcast lock prefix before Media/Library mutation:
    # backfill.py relies on this being the first action, in canonical alias order.
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
    ingested_episode_count = 0
    added_to_subscriber_all_count = 0
    source_limited = False
    enrichment_media_ids: set[UUID] = set()
    chapter_sync_rows: list[tuple[UUID, list[dict[str, Any]] | None]] = []
    podcast_contributors = load_contributor_credits_for_podcasts(db, [podcast_id]).get(
        podcast_id,
        [],
    )
    podcast_author_names = [
        credit.credited_name
        for credit in podcast_contributors
        if credit.role == "author" and credit.credited_name
    ]

    for episode, aliases in zip(selected_episodes, aliases_by_episode, strict=True):
        if not aliases:
            source_limited = True
            continue
        description_html = normalize_optional_text(episode.get("description_html"))
        description_text = normalize_optional_text(episode.get("description_text"))
        description = description_text[:2000] if description_text else None
        source_published_at = normalize_provider_published_at(episode.get("published_at"))
        published_at = parse_iso_datetime(source_published_at)
        edition_date = normalize_source_publication_date(source_published_at)
        language = normalize_language_tag(episode.get("language")) or normalize_language_tag(
            episode.get("feed_language")
        )
        duration_seconds = coerce_positive_int(episode.get("duration_seconds"))
        author_names: list[str] = []
        raw_authors = episode.get("authors")
        if isinstance(raw_authors, list):
            for raw_author in raw_authors:
                name = str(raw_author or "").strip()
                if name and name not in author_names:
                    author_names.append(name)
        if not author_names:
            author_names.extend(podcast_author_names)
        rss_transcript_url = str(episode.get("rss_transcript_url") or "").strip() or None
        existing_media_id = resolve_episode_aliases_in_current_transaction(
            db,
            podcast_id=podcast_id,
            aliases=aliases,
        )
        media_id: UUID
        if existing_media_id is not None:
            media_id = existing_media_id
            attach_episode_aliases_in_current_transaction(
                db,
                podcast_id=podcast_id,
                media_id=media_id,
                aliases=aliases,
            )
            diagnostic_alias = diagnostic_episode_alias_for_media(
                db,
                podcast_id=podcast_id,
                media_id=media_id,
            )
            if ensure_subscription_episode_default_in_current_transaction(
                db, viewer_id, podcast_id, media_id
            ):
                added_to_subscriber_all_count += 1
            db.execute(
                text(
                    """
                    UPDATE media
                    SET
                        title = :title,
                        canonical_source_url = :canonical_source_url,
                        external_playback_url = :external_playback_url,
                        description = COALESCE(:description, description),
                        edition_published_date = COALESCE(:edition_published_date, edition_published_date),
                        language = COALESCE(:language, language),
                        provider = :provider,
                        provider_id = :provider_id,
                        updated_at = :updated_at
                    WHERE id = :media_id
                    """
                ),
                {
                    "media_id": media_id,
                    "title": str(episode.get("title") or "Untitled Episode"),
                    "canonical_source_url": feed_url,
                    "external_playback_url": str(episode.get("audio_url") or "").strip() or None,
                    "description": description,
                    "edition_published_date": nullable_from_presence(edition_date),
                    "language": language,
                    "provider": PODCAST_PROVIDER,
                    "provider_id": diagnostic_alias.value,
                    "updated_at": now,
                },
            )
            db.execute(
                text(
                    """
                    UPDATE podcast_episodes
                    SET
                        description_html = :description_html,
                        description_text = :description_text,
                        published_at = COALESCE(:published_at, published_at),
                        duration_seconds = :duration_seconds,
                        rss_transcript_url = :rss_transcript_url
                    WHERE media_id = :media_id
                    """
                ),
                {
                    "media_id": media_id,
                    "description_html": description_html,
                    "description_text": description_text,
                    "published_at": published_at,
                    "duration_seconds": duration_seconds,
                    "rss_transcript_url": rss_transcript_url,
                },
            )
            observation = _build_episode_author_observation(author_names)
            if isinstance(observation, ObservedRoleSlices):
                apply_observed_role_slices_in_current_transaction(
                    db,
                    target=MediaTarget(media_id),
                    observation=observation,
                    source="rss",
                )
            if not author_names:
                enrichment_media_ids.add(media_id)
        else:
            media_id = new_uuid7()
            audio_url = str(episode.get("audio_url") or "").strip() or None
            db.execute(
                text(
                    """
                    INSERT INTO media (
                        id,
                        kind,
                        title,
                        canonical_source_url,
                        processing_status,
                        failure_stage,
                        last_error_code,
                        last_error_message,
                        external_playback_url,
                        provider,
                        provider_id,
                        description,
                        edition_published_date,
                        language,
                        created_by_user_id,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        :id,
                        'podcast_episode',
                        :title,
                        :canonical_source_url,
                        'pending',
                        NULL,
                        NULL,
                        NULL,
                        :external_playback_url,
                        :provider,
                        :provider_id,
                        :description,
                        :edition_published_date,
                        :language,
                        :created_by_user_id,
                        :created_at,
                        :updated_at
                    )
                    """
                ),
                {
                    "id": media_id,
                    "title": str(episode.get("title") or "Untitled Episode"),
                    "canonical_source_url": feed_url,
                    "external_playback_url": audio_url,
                    "provider": PODCAST_PROVIDER,
                    "provider_id": diagnostic_episode_alias(aliases).value,
                    "description": description,
                    "edition_published_date": nullable_from_presence(edition_date),
                    "language": language,
                    "created_by_user_id": viewer_id,
                    "created_at": now,
                    "updated_at": now,
                },
            )
            ensure_media_transcript_state_row(
                db,
                media_id=media_id,
                now=now,
            )
            db.execute(
                text(
                    """
                    INSERT INTO podcast_episodes (
                        media_id,
                        podcast_id,
                        published_at,
                        duration_seconds,
                        description_html,
                        description_text,
                        rss_transcript_url,
                        created_at
                    )
                    VALUES (
                        :media_id,
                        :podcast_id,
                        :published_at,
                        :duration_seconds,
                        :description_html,
                        :description_text,
                        :rss_transcript_url,
                        :created_at
                    )
                    """
                ),
                {
                    "media_id": media_id,
                    "podcast_id": podcast_id,
                    "published_at": published_at,
                    "duration_seconds": duration_seconds,
                    "description_html": description_html,
                    "description_text": description_text,
                    "rss_transcript_url": rss_transcript_url,
                    "created_at": now,
                },
            )
            observation = _build_episode_author_observation(author_names)
            if isinstance(observation, ObservedRoleSlices):
                apply_observed_role_slices_in_current_transaction(
                    db,
                    target=MediaTarget(media_id),
                    observation=observation,
                    source="rss",
                )
            attach_episode_aliases_in_current_transaction(
                db,
                podcast_id=podcast_id,
                media_id=media_id,
                aliases=aliases,
            )
            if not author_names:
                enrichment_media_ids.add(media_id)
            if ensure_subscription_episode_default_in_current_transaction(
                db, viewer_id, podcast_id, media_id
            ):
                added_to_subscriber_all_count += 1
            ingested_episode_count += 1
            enrichment_media_ids.add(media_id)

        chapter_sync_rows.append((media_id, episode.get("rss_chapters")))

    for media_id, chapter_rows in chapter_sync_rows:
        _upsert_podcast_episode_chapters(
            db,
            media_id=media_id,
            chapter_rows=chapter_rows,
            now=now,
        )

    # Auto-subscription queueing is NOT done here anymore: the fenced watermark step
    # after ingest owns eligible-episode selection + Lectern insertion + watermark
    # advance as one database fact (spec §5.3).
    for media_id in enrichment_media_ids:
        # Queue enlistment is part of the caller's transaction. A queue write
        # failure aborts the batch; swallowing a database exception would leave
        # the Session unusable and falsely advance the backfill fence.
        enqueue_metadata_enrichment(
            db,
            media_id=media_id,
            requester_user_id=viewer_id,
            request_id=None,
            dedupe_key=f"enrich-metadata:{media_id}",
        )

    affected_viewers = tuple(
        UUID(str(value))
        for value in db.execute(
            text(
                """
                SELECT user_id
                FROM podcast_subscriptions
                WHERE podcast_id = :podcast_id
                """
            ),
            {"podcast_id": podcast_id},
        ).scalars()
    )
    bump_collection_revisions(
        db,
        viewer_ids=affected_viewers,
        family=CollectionFamily.PodcastSubscriptions,
    )
    if selected_episodes:
        # Episode Media is visible through subscriptions, shared libraries, and
        # authenticated resource grants. Broad invalidation is the deliberate
        # one-user 80/20 closure: it cannot miss a non-subscriber visibility
        # path while feed sync mutates membership and every list sort fact.
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


def _upsert_podcast_episode_chapters(
    db: Session,
    *,
    media_id: UUID,
    chapter_rows: list[dict[str, Any]] | None,
    now: datetime,
) -> None:
    normalized_rows = _normalize_chapter_rows_for_persistence(chapter_rows)
    if normalized_rows is None:
        return

    db.execute(
        text("DELETE FROM podcast_episode_chapters WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    if not normalized_rows:
        return

    db.execute(
        text(
            """
            INSERT INTO podcast_episode_chapters (
                media_id,
                chapter_idx,
                title,
                t_start_ms,
                t_end_ms,
                url,
                image_url,
                source,
                created_at
            )
            VALUES (
                :media_id,
                :chapter_idx,
                :title,
                :t_start_ms,
                :t_end_ms,
                :url,
                :image_url,
                :source,
                :created_at
            )
            """
        ),
        [
            {
                "media_id": media_id,
                "chapter_idx": chapter_idx,
                "title": chapter["title"],
                "t_start_ms": chapter["t_start_ms"],
                "t_end_ms": chapter["t_end_ms"],
                "url": chapter["url"],
                "image_url": chapter["image_url"],
                "source": chapter["source"],
                "created_at": now,
            }
            for chapter_idx, chapter in enumerate(normalized_rows)
        ],
    )


def _normalize_chapter_rows_for_persistence(
    chapter_rows: list[dict[str, Any]] | None,
) -> list[dict[str, Any]] | None:
    if chapter_rows is None:
        return None
    if not isinstance(chapter_rows, list):
        return []

    normalized: list[dict[str, Any]] = []
    for chapter in chapter_rows:
        if not isinstance(chapter, dict):
            continue
        title = str(chapter.get("title") or "").strip()
        if not title:
            continue
        t_start_ms = coerce_non_negative_int(chapter.get("t_start_ms"))
        if t_start_ms is None:
            continue
        t_end_ms = coerce_non_negative_int(chapter.get("t_end_ms"))
        if t_end_ms is not None and t_end_ms < t_start_ms:
            t_end_ms = None
        source = str(chapter.get("source") or "").strip()
        if source not in {
            PODCAST_CHAPTER_SOURCE_PODCASTING20,
            PODCAST_CHAPTER_SOURCE_PODLOVE,
        }:
            continue
        normalized.append(
            {
                "title": title,
                "t_start_ms": t_start_ms,
                "t_end_ms": t_end_ms,
                "url": normalize_podcast_chapter_link(chapter.get("url"), base_url=None),
                "image_url": normalize_podcast_chapter_link(
                    chapter.get("image_url"), base_url=None
                ),
                "source": source,
            }
        )

    normalized.sort(key=lambda row: (row["t_start_ms"], row["title"].lower()))
    deduped: list[dict[str, Any]] = []
    seen_keys: set[tuple[int, str]] = set()
    for row in normalized:
        dedupe_key = (row["t_start_ms"], row["title"].lower())
        if dedupe_key in seen_keys:
            continue
        seen_keys.add(dedupe_key)
        deduped.append(row)
    return deduped
