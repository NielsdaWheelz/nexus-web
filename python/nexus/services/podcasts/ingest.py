"""Podcast subscription feed ingest: episode/media/chapter/transcript persistence."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.coerce import coerce_non_negative_int, coerce_positive_int
from nexus.jobs.queue import enqueue_unique_job
from nexus.logging import get_logger
from nexus.services.contributor_credits import load_contributor_credits_for_podcasts
from nexus.services.contributor_taxonomy import (
    NOT_OBSERVED,
    ContributorObservationBatch,
    ObservedRoleSlices,
    RawCreditEntry,
    build_observation,
)
from nexus.services.library_entries import assign_libraries_for_media_in_current_transaction
from nexus.services.rss_transcript_fetch import fetch_rss_transcript
from nexus.services.transcript_segments import normalize_transcript_segments
from nexus.services.transcripts.current import (
    ensure_media_transcript_state_row,
    write_current_transcript,
)

from ._normalize import (
    normalize_language_tag,
    normalize_optional_text,
    parse_iso_datetime,
)
from .feed import (
    PODCAST_CHAPTER_SOURCE_PODCASTING20,
    PODCAST_CHAPTER_SOURCE_PODLOVE,
    normalize_podcast_chapter_link,
)
from .provider import (
    PODCAST_PROVIDER,
)

logger = get_logger(__name__)


@dataclass(frozen=True)
class SubscriptionIngestResult:
    """Result of ingesting a subscription's selected episodes.

    ``author_observations`` carries one ``(media_id, observation)`` per touched
    episode whose RSS/inherited author text produced a real slice. The caller
    applies each through the author facade in a fresh session *after* the ingest
    transaction commits (spec 2.4); episodes that observed nothing are absent, so
    their prior credits are preserved (D-5/D-16).
    """

    ingested_episode_count: int
    reused_episode_count: int
    author_observations: tuple[tuple[UUID, ObservedRoleSlices], ...]


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
    ingested_episode_count = 0
    reused_episode_count = 0
    enrichment_media_ids: set[UUID] = set()
    author_observations: list[tuple[UUID, ObservedRoleSlices]] = []
    chapter_sync_rows: list[tuple[UUID, list[dict[str, Any]] | None]] = []
    transcript_sync_rows: list[dict[str, Any]] = []
    subscription_library_rows = db.execute(
        text(
            """
            SELECT library_id
            FROM podcast_subscription_libraries
            WHERE subscription_user_id = :user_id
              AND subscription_podcast_id = :podcast_id
            """
        ),
        {"user_id": viewer_id, "podcast_id": podcast_id},
    ).fetchall()
    subscription_library_ids: list[UUID] = [row[0] for row in subscription_library_rows]
    podcast_contributors = load_contributor_credits_for_podcasts(db, [podcast_id]).get(
        podcast_id,
        [],
    )
    podcast_author_names = [
        credit.credited_name
        for credit in podcast_contributors
        if credit.role == "author" and credit.credited_name
    ]

    for episode in selected_episodes:
        guid = normalize_optional_text(episode.get("guid"))
        fallback_identity = _compute_fallback_identity(episode)
        description_html = normalize_optional_text(episode.get("description_html"))
        description_text = normalize_optional_text(episode.get("description_text"))
        description = description_text[:2000] if description_text else None
        published_at = parse_iso_datetime(episode.get("published_at"))
        published_date = str(episode.get("published_at") or "").strip()[:64] or None
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
        rss_transcript_refs = episode.get("rss_transcript_refs")
        rss_transcript_url = None
        if isinstance(rss_transcript_refs, list):
            for ref in rss_transcript_refs:
                if not isinstance(ref, dict):
                    continue
                candidate_url = str(ref.get("url") or "").strip()
                if not candidate_url:
                    continue
                rss_transcript_url = candidate_url
                break
        existing_media_id = _find_existing_episode_media_id(
            db,
            podcast_id=podcast_id,
            guid=guid,
            fallback_identity=fallback_identity,
        )
        media_id: UUID
        if existing_media_id is not None:
            media_id = existing_media_id
            assign_libraries_for_media_in_current_transaction(
                db, viewer_id, media_id, subscription_library_ids
            )
            db.execute(
                text(
                    """
                    UPDATE media
                    SET
                        title = :title,
                        canonical_source_url = :canonical_source_url,
                        external_playback_url = :external_playback_url,
                        description = COALESCE(:description, description),
                        published_date = COALESCE(:published_date, published_date),
                        language = COALESCE(:language, language),
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
                    "published_date": published_date,
                    "language": language,
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
                author_observations.append((media_id, observation))
            if not author_names:
                enrichment_media_ids.add(media_id)
            reused_episode_count += 1
        else:
            media_id = uuid4()
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
                        published_date,
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
                        :published_date,
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
                    "provider_id": str(episode.get("provider_episode_id") or ""),
                    "description": description,
                    "published_date": published_date,
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
                        provider_episode_id,
                        guid,
                        fallback_identity,
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
                        :provider_episode_id,
                        :guid,
                        :fallback_identity,
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
                    "provider_episode_id": str(episode.get("provider_episode_id") or ""),
                    "guid": guid,
                    "fallback_identity": fallback_identity,
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
                author_observations.append((media_id, observation))
            if not author_names:
                enrichment_media_ids.add(media_id)
            assign_libraries_for_media_in_current_transaction(
                db, viewer_id, media_id, subscription_library_ids
            )
            ingested_episode_count += 1
            enrichment_media_ids.add(media_id)

        chapter_sync_rows.append((media_id, episode.get("rss_chapters")))
        transcript_sync_rows.append(
            {
                "media_id": media_id,
                "refs": rss_transcript_refs,
                "duration_seconds": duration_seconds,
                "episode_language": normalize_language_tag(episode.get("language")),
                "feed_language": normalize_language_tag(episode.get("feed_language")),
            }
        )

    for media_id, chapter_rows in chapter_sync_rows:
        _upsert_podcast_episode_chapters(
            db,
            media_id=media_id,
            chapter_rows=chapter_rows,
            now=now,
        )

    for transcript_row in transcript_sync_rows:
        media_id = transcript_row["media_id"]
        refs = transcript_row["refs"]
        if not isinstance(refs, list) or not refs:
            continue

        state_row = db.execute(
            text(
                """
                SELECT transcript_state
                FROM media_transcript_states
                WHERE media_id = :media_id
                """
            ),
            {"media_id": media_id},
        ).fetchone()
        current_transcript_state = (
            str(state_row[0] or "not_requested") if state_row is not None else "not_requested"
        )
        if current_transcript_state in {"ready", "partial"}:
            continue
        if current_transcript_state not in {
            "not_requested",
            "failed_quota",
            "failed_provider",
            "unavailable",
        }:
            continue

        duration_seconds = transcript_row.get("duration_seconds")
        episode_duration_ms = (
            int(duration_seconds) * 1000 if isinstance(duration_seconds, int) else None
        )
        fetch_result = fetch_rss_transcript(
            refs,
            episode_duration_ms=episode_duration_ms,
            episode_language=transcript_row.get("episode_language"),
            feed_language=transcript_row.get("feed_language"),
        )
        if fetch_result.get("status") != "completed":
            continue

        fetched_segments = fetch_result.get("segments")
        if not isinstance(fetched_segments, list) or not fetched_segments:
            continue
        source_type = str(fetch_result.get("source_type") or "")

        if source_type == "text" and episode_duration_ms is None:
            for segment in fetched_segments:
                if not isinstance(segment, dict):
                    continue
                t_start_ms = coerce_non_negative_int(segment.get("t_start_ms"))
                t_end_ms = coerce_non_negative_int(segment.get("t_end_ms"))
                if t_start_ms is None:
                    continue
                if t_end_ms is None or t_end_ms <= t_start_ms:
                    segment["t_end_ms"] = t_start_ms + 1

        transcript_segments = normalize_transcript_segments(fetched_segments)
        if not transcript_segments:
            continue

        transcript_coverage: Literal["partial", "full"] = (
            "partial" if source_type == "text" else "full"
        )
        transcript_state = "partial" if transcript_coverage == "partial" else "ready"

        write_current_transcript(
            db,
            media_id=media_id,
            request_reason="rss_feed",
            transcript_coverage=transcript_coverage,
            transcript_segments=transcript_segments,
            now=now,
        )
        logger.info(
            "rss_transcript_persisted",
            media_id=str(media_id),
            transcript_state=transcript_state,
            transcript_coverage=transcript_coverage,
            source_type=source_type,
            segment_count=len(transcript_segments),
        )
        enrichment_media_ids.add(media_id)

    # Auto-subscription queueing is NOT done here anymore: the fenced watermark step
    # after ingest owns eligible-episode selection + Lectern insertion + watermark
    # advance as one database fact (spec §5.3).
    for media_id in enrichment_media_ids:
        try:
            # Deduped by media_id: episode media is shared across a podcast's
            # subscribers, so concurrent per-subscription syncs must not each enqueue a
            # redundant enrichment for the same media (Key Decision 8).
            enqueue_unique_job(
                db,
                kind="enrich_metadata",
                payload={"media_id": str(media_id), "request_id": None},
                dedupe_key=f"enrich-metadata:{media_id}",
                max_attempts=1,
            )
        except SQLAlchemyError as exc:
            logger.warning(
                "metadata_enrichment_enqueue_failed",
                media_id=str(media_id),
                error=str(exc),
            )

    return SubscriptionIngestResult(
        ingested_episode_count=ingested_episode_count,
        reused_episode_count=reused_episode_count,
        author_observations=tuple(author_observations),
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

    for chapter_idx, chapter in enumerate(normalized_rows):
        existing_chapter_id = db.scalar(
            text(
                """
                SELECT id
                FROM podcast_episode_chapters
                WHERE media_id = :media_id
                  AND chapter_idx = :chapter_idx
                """
            ),
            {"media_id": media_id, "chapter_idx": chapter_idx},
        )
        if existing_chapter_id is None:
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
                },
            )
        else:
            db.execute(
                text(
                    """
                    UPDATE podcast_episode_chapters
                    SET
                        title = :title,
                        t_start_ms = :t_start_ms,
                        t_end_ms = :t_end_ms,
                        url = :url,
                        image_url = :image_url,
                        source = :source
                    WHERE id = :id
                    """
                ),
                {
                    "id": existing_chapter_id,
                    "title": chapter["title"],
                    "t_start_ms": chapter["t_start_ms"],
                    "t_end_ms": chapter["t_end_ms"],
                    "url": chapter["url"],
                    "image_url": chapter["image_url"],
                    "source": chapter["source"],
                },
            )

    if normalized_rows:
        keep_indices = list(range(len(normalized_rows)))
        db.execute(
            text(
                """
                DELETE FROM podcast_episode_chapters
                WHERE media_id = :media_id
                  AND NOT (chapter_idx = ANY(:keep_indices))
                """
            ),
            {
                "media_id": media_id,
                "keep_indices": keep_indices,
            },
        )
    else:
        db.execute(
            text("DELETE FROM podcast_episode_chapters WHERE media_id = :media_id"),
            {"media_id": media_id},
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
            "embedded_mp4",
            "embedded_id3",
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


def _find_existing_episode_media_id(
    db: Session,
    *,
    podcast_id: UUID,
    guid: str | None,
    fallback_identity: str,
) -> UUID | None:
    if guid:
        row = db.execute(
            text(
                """
                SELECT media_id
                FROM podcast_episodes
                WHERE podcast_id = :podcast_id AND guid = :guid
                LIMIT 1
                """
            ),
            {"podcast_id": podcast_id, "guid": guid},
        ).fetchone()
        if row is not None:
            return row[0]

    row = db.execute(
        text(
            """
            SELECT media_id
            FROM podcast_episodes
            WHERE podcast_id = :podcast_id AND fallback_identity = :fallback_identity
            LIMIT 1
            """
        ),
        {"podcast_id": podcast_id, "fallback_identity": fallback_identity},
    ).fetchone()
    if row is None:
        return None
    return row[0]


def _compute_fallback_identity(episode: dict[str, Any]) -> str:
    audio_url = _fallback_identity_part(episode.get("audio_url"))
    title = _fallback_identity_part(episode.get("title"))
    published_at = _fallback_identity_part(episode.get("published_at"))
    return f"audio_url={audio_url}\ntitle={title}\npublished_at={published_at}"


def _fallback_identity_part(value: object) -> str:
    return " ".join(str(value or "").strip().casefold().split())
