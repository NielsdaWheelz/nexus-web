"""Podcast subscription sync and feed-ingest services."""

from __future__ import annotations

import hashlib
import math
import re
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urljoin
from uuid import UUID, uuid4

import httpx
from lxml import etree
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.session import transaction
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    InvalidRequestError,
    NotFoundError,
)
from nexus.jobs.queue import enqueue_job
from nexus.logging import get_logger
from nexus.schemas.podcast import (
    PodcastSubscriptionSyncRefreshOut,
)
from nexus.services import playback_queue as playback_queue_service
from nexus.services.rss_transcript_fetch import fetch_rss_transcript
from nexus.services.sanitize_html import sanitize_html
from nexus.services.upload import _ensure_in_default_library
from nexus.services.url_normalize import validate_requested_url

from .provider import (
    PODCAST_INDEX_EPISODE_PAGE_SIZE,
    PODCAST_PROVIDER,
    get_podcast_index_client,
)
from .transcripts import (
    _create_next_transcript_version,
    _ensure_media_transcript_state_row,
    _insert_transcript_chunks_for_version,
    _insert_transcript_fragments,
    _insert_transcript_segments_for_version,
    _normalize_transcript_segments,
    _set_media_transcript_state,
    _try_enqueue_metadata_enrichment,
)

logger = get_logger(__name__)

PODCAST_FEED_PAGINATION_MAX_PAGES = 10
_ATOM_NAMESPACE = {"atom": "http://www.w3.org/2005/Atom"}
_ITUNES_DURATION_XPATH = (
    "*[local-name()='duration' and namespace-uri()='http://www.itunes.com/dtds/podcast-1.0.dtd']"
)
_PODCAST_ACTIVE_POLL_MAX_LIMIT = 1000
_PODCAST_ACTIVE_POLL_UNEXPECTED_ERROR_CODE = ApiErrorCode.E_INTERNAL.value
PODCAST_EPISODE_SHOW_NOTES_HTML_MAX_BYTES = 100_000
PODCAST_EPISODE_SHOW_NOTES_TEXT_MAX_BYTES = 50_000
PODCAST_CHAPTER_SOURCE_PODCASTING20 = "rss_podcasting20"
PODCAST_CHAPTER_SOURCE_PODLOVE = "rss_podlove"
_PODCAST_CHAPTERS_20_CONTENT_TYPES = {
    "application/json+chapters",
    "application/json",
    "text/json",
}
_CHAPTER_TIMESTAMP_PATTERN = re.compile(
    r"^(?:(?P<hours>\d+):)?(?P<minutes>[0-5]?\d):(?P<seconds>[0-5]?\d(?:\.\d+)?)$"
)
_PODCAST_CONTENT_ENCODED_XPATH = "*[local-name()='encoded']"


def run_scheduled_active_subscription_poll(
    db: Session,
    *,
    limit: int,
    run_lease_seconds: int,
    sync_lease_seconds: int,
    scheduler_identity: str | None = None,
) -> dict[str, Any]:
    """Run scheduled active-subscription polling with singleton + durable run telemetry."""
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")
    effective_limit = min(limit, _PODCAST_ACTIVE_POLL_MAX_LIMIT)
    if effective_limit < limit:
        logger.warning(
            "podcast_active_poll_limit_clamped",
            requested_limit=limit,
            effective_limit=effective_limit,
            max_limit=_PODCAST_ACTIVE_POLL_MAX_LIMIT,
        )

    if run_lease_seconds <= 0:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Run lease seconds must be positive",
        )

    run_id = uuid4()
    now = datetime.now(UTC)
    claimed = _claim_subscription_poll_run_singleton(
        db,
        run_id=run_id,
        now=now,
        run_limit=effective_limit,
        run_lease_seconds=run_lease_seconds,
        scheduler_identity=scheduler_identity,
    )
    if not claimed:
        logger.info(
            "podcast_active_poll_run_skipped_singleton",
            scheduler_identity=scheduler_identity,
            run_limit=effective_limit,
        )
        return {
            "status": "skipped_singleton",
            "processed_count": 0,
            "failed_count": 0,
            "skipped_count": 0,
            "scanned_count": 0,
            "failure_code_breakdown": {},
        }

    logger.info(
        "podcast_active_poll_run_started",
        run_id=str(run_id),
        scheduler_identity=scheduler_identity,
        run_limit=effective_limit,
        run_lease_seconds=run_lease_seconds,
        sync_lease_seconds=sync_lease_seconds,
    )
    try:
        poll_result = poll_active_subscriptions_once(
            db,
            limit=effective_limit,
            sync_lease_seconds=sync_lease_seconds,
        )
    except Exception as exc:
        with transaction(db):
            _mark_subscription_poll_run_failed(
                db,
                run_id=run_id,
                now=datetime.now(UTC),
                error_code=_PODCAST_ACTIVE_POLL_UNEXPECTED_ERROR_CODE,
                error_message=str(exc),
            )
        raise

    with transaction(db):
        _mark_subscription_poll_run_completed(
            db,
            run_id=run_id,
            now=datetime.now(UTC),
            poll_result=poll_result,
        )

    logger.info(
        "podcast_active_poll_run_completed",
        run_id=str(run_id),
        scheduler_identity=scheduler_identity,
        run_limit=effective_limit,
        processed_count=poll_result["processed_count"],
        failed_count=poll_result["failed_count"],
        skipped_count=poll_result["skipped_count"],
        scanned_count=poll_result["scanned_count"],
        failure_code_breakdown=poll_result["failure_code_breakdown"],
    )
    return {
        "status": "completed",
        "run_id": str(run_id),
        **poll_result,
    }


def poll_active_subscriptions_once(
    db: Session,
    *,
    limit: int = 100,
    sync_lease_seconds: int | None = None,
) -> dict[str, Any]:
    """Run one bounded polling pass over active subscriptions."""
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")
    limit = min(limit, _PODCAST_ACTIVE_POLL_MAX_LIMIT)

    if sync_lease_seconds is None:
        sync_lease_seconds = get_settings().podcast_sync_running_lease_seconds
    if sync_lease_seconds <= 0:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Sync lease seconds must be positive",
        )

    running_lease_cutoff = datetime.now(UTC) - timedelta(seconds=sync_lease_seconds)
    rows = db.execute(
        text(
            """
            SELECT user_id, podcast_id
            FROM podcast_subscriptions
            WHERE status = 'active'
              AND (
                  sync_status <> 'running'
                  OR COALESCE(sync_started_at, updated_at) < :running_lease_cutoff
              )
            ORDER BY updated_at ASC, user_id ASC, podcast_id ASC
            LIMIT :limit
            """
        ),
        {
            "limit": limit,
            "running_lease_cutoff": running_lease_cutoff,
        },
    ).fetchall()

    processed_count = 0
    failed_count = 0
    skipped_count = 0
    failure_code_breakdown: dict[str, int] = {}

    for user_id, podcast_id in rows:
        with transaction(db):
            queued = db.execute(
                text(
                    """
                    UPDATE podcast_subscriptions
                    SET
                        sync_status = 'pending',
                        sync_error_code = NULL,
                        sync_error_message = NULL,
                        sync_started_at = NULL,
                        sync_completed_at = NULL,
                        updated_at = :updated_at
                    WHERE user_id = :user_id
                      AND podcast_id = :podcast_id
                      AND status = 'active'
                      AND (
                          sync_status <> 'running'
                          OR COALESCE(sync_started_at, updated_at) < :running_lease_cutoff
                      )
                    RETURNING 1
                    """
                ),
                {
                    "user_id": user_id,
                    "podcast_id": podcast_id,
                    "updated_at": datetime.now(UTC),
                    "running_lease_cutoff": running_lease_cutoff,
                },
            ).fetchone()

        if queued is None:
            skipped_count += 1
            continue

        try:
            sync_result = run_podcast_subscription_sync_now(
                db,
                user_id=user_id,
                podcast_id=podcast_id,
            )
            if sync_result.get("reason") == "not_pending":
                skipped_count += 1
                continue
            if sync_result.get("sync_status") == "failed":
                failed_count += 1
                error_code = _normalize_poll_failure_code(sync_result.get("error_code"))
                failure_code_breakdown[error_code] = failure_code_breakdown.get(error_code, 0) + 1
            else:
                processed_count += 1
        except Exception as exc:
            logger.exception(
                "podcast_active_poll_sync_failed",
                user_id=str(user_id),
                podcast_id=str(podcast_id),
                error=str(exc),
            )
            failed_count += 1
            fallback_code = _PODCAST_ACTIVE_POLL_UNEXPECTED_ERROR_CODE
            failure_code_breakdown[fallback_code] = failure_code_breakdown.get(fallback_code, 0) + 1

    return {
        "processed_count": processed_count,
        "failed_count": failed_count,
        "skipped_count": skipped_count,
        "scanned_count": len(rows),
        "failure_code_breakdown": {
            code: failure_code_breakdown[code] for code in sorted(failure_code_breakdown)
        },
    }


def _normalize_poll_failure_code(raw_value: Any) -> str:
    value = str(raw_value or "").strip()
    if not value:
        return _PODCAST_ACTIVE_POLL_UNEXPECTED_ERROR_CODE
    return value


def _is_singleton_poll_run_integrity_error(exc: IntegrityError) -> bool:
    orig = getattr(exc, "orig", None)
    sqlstate = (
        getattr(orig, "sqlstate", None)
        or getattr(orig, "pgcode", None)
        or getattr(getattr(orig, "diag", None), "sqlstate", None)
    )
    if sqlstate != "23505":
        return False

    constraint_name = getattr(getattr(orig, "diag", None), "constraint_name", None)
    if constraint_name:
        return constraint_name == "uq_podcast_subscription_poll_runs_singleton_running"
    return "uq_podcast_subscription_poll_runs_singleton_running" in str(exc)


def _claim_subscription_poll_run_singleton(
    db: Session,
    *,
    run_id: UUID,
    now: datetime,
    run_limit: int,
    run_lease_seconds: int,
    scheduler_identity: str | None,
) -> bool:
    lease_expires_at = now + timedelta(seconds=run_lease_seconds)
    try:
        with transaction(db):
            db.execute(
                text(
                    """
                    UPDATE podcast_subscription_poll_runs
                    SET
                        status = 'expired',
                        completed_at = :now,
                        error_code = :error_code,
                        error_message = :error_message,
                        updated_at = :now
                    WHERE status = 'running'
                      AND lease_expires_at < :now
                    """
                ),
                {
                    "now": now,
                    "error_code": _PODCAST_ACTIVE_POLL_UNEXPECTED_ERROR_CODE,
                    "error_message": "Polling run lease expired before completion",
                },
            )

            db.execute(
                text(
                    """
                    INSERT INTO podcast_subscription_poll_runs (
                        id,
                        orchestration_source,
                        scheduler_identity,
                        status,
                        run_limit,
                        started_at,
                        lease_expires_at,
                        processed_count,
                        failed_count,
                        skipped_count,
                        scanned_count,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        :id,
                        'scheduled',
                        :scheduler_identity,
                        'running',
                        :run_limit,
                        :started_at,
                        :lease_expires_at,
                        0,
                        0,
                        0,
                        0,
                        :created_at,
                        :updated_at
                    )
                    """
                ),
                {
                    "id": run_id,
                    "scheduler_identity": scheduler_identity,
                    "run_limit": run_limit,
                    "started_at": now,
                    "lease_expires_at": lease_expires_at,
                    "created_at": now,
                    "updated_at": now,
                },
            )
    except IntegrityError as exc:
        if _is_singleton_poll_run_integrity_error(exc):
            return False
        raise
    return True


def _mark_subscription_poll_run_completed(
    db: Session,
    *,
    run_id: UUID,
    now: datetime,
    poll_result: dict[str, Any],
) -> None:
    db.execute(
        text(
            """
            UPDATE podcast_subscription_poll_runs
            SET
                status = 'completed',
                completed_at = :now,
                processed_count = :processed_count,
                failed_count = :failed_count,
                skipped_count = :skipped_count,
                scanned_count = :scanned_count,
                error_code = NULL,
                error_message = NULL,
                updated_at = :now
            WHERE id = :run_id
            """
        ),
        {
            "run_id": run_id,
            "now": now,
            "processed_count": int(poll_result["processed_count"]),
            "failed_count": int(poll_result["failed_count"]),
            "skipped_count": int(poll_result["skipped_count"]),
            "scanned_count": int(poll_result["scanned_count"]),
        },
    )

    db.execute(
        text(
            """
            DELETE FROM podcast_subscription_poll_run_failures
            WHERE run_id = :run_id
            """
        ),
        {"run_id": run_id},
    )

    for error_code, failure_count in sorted(poll_result["failure_code_breakdown"].items()):
        db.execute(
            text(
                """
                INSERT INTO podcast_subscription_poll_run_failures (
                    run_id,
                    error_code,
                    failure_count
                )
                VALUES (
                    :run_id,
                    :error_code,
                    :failure_count
                )
                """
            ),
            {
                "run_id": run_id,
                "error_code": error_code,
                "failure_count": int(failure_count),
            },
        )


def _mark_subscription_poll_run_failed(
    db: Session,
    *,
    run_id: UUID,
    now: datetime,
    error_code: str,
    error_message: str,
) -> None:
    db.execute(
        text(
            """
            UPDATE podcast_subscription_poll_runs
            SET
                status = 'failed',
                completed_at = :now,
                error_code = :error_code,
                error_message = :error_message,
                updated_at = :now
            WHERE id = :run_id
            """
        ),
        {
            "run_id": run_id,
            "now": now,
            "error_code": error_code,
            "error_message": error_message[:1000],
        },
    )


def run_podcast_subscription_sync_now(
    db: Session,
    *,
    user_id: UUID,
    podcast_id: UUID,
    request_id: str | None = None,
) -> dict[str, Any]:
    _ = request_id
    settings = get_settings()
    now = datetime.now(UTC)
    lease_expires_before = now - timedelta(seconds=settings.podcast_sync_running_lease_seconds)
    claimed = False

    with transaction(db):
        claimed = _claim_subscription_sync_pending(
            db,
            user_id=user_id,
            podcast_id=podcast_id,
            now=now,
            lease_expires_before=lease_expires_before,
        )

    if not claimed:
        snapshot = _get_subscription_sync_snapshot(db, user_id, podcast_id)
        return {
            "sync_status": snapshot["sync_status"] if snapshot is not None else "skipped",
            "reason": "not_pending",
            "ingested_episode_count": 0,
            "reused_episode_count": 0,
            "source_limited": False,
        }

    try:
        window_size = settings.podcast_initial_episode_window
        prefetch_limit = max(window_size, settings.podcast_ingest_prefetch_limit)

        podcast = _get_podcast_sync_metadata(db, podcast_id)
        client = get_podcast_index_client()
        provider_episode_candidates = client.fetch_recent_episodes(
            podcast["provider_podcast_id"], prefetch_limit
        )
        episode_candidates = _augment_provider_episodes_with_feed_pagination(
            provider_episode_candidates=provider_episode_candidates,
            feed_url=podcast["feed_url"],
            prefetch_limit=prefetch_limit,
        )
        selected_episodes = sorted(
            episode_candidates,
            key=lambda ep: _published_sort_key(ep.get("published_at")),
            reverse=True,
        )[:window_size]
        selected_episodes = _hydrate_selected_episode_chapters_from_feed(
            selected_episodes=selected_episodes,
            feed_url=podcast["feed_url"],
        )
        source_limited = (
            len(provider_episode_candidates) >= PODCAST_INDEX_EPISODE_PAGE_SIZE
            and len(episode_candidates) < prefetch_limit
        )

        logger.info(
            "podcast_sync_episode_selection",
            viewer_id=str(user_id),
            podcast_id=str(podcast_id),
            prefetch_limit=prefetch_limit,
            provider_candidate_count=len(provider_episode_candidates),
            candidate_count=len(episode_candidates),
            window_size=window_size,
            selected_count=len(selected_episodes),
            source_limited=source_limited,
        )

        sync_now = datetime.now(UTC)
        with transaction(db):
            ingested_episode_count, reused_episode_count = _sync_subscription_ingest(
                db=db,
                viewer_id=user_id,
                podcast_id=podcast_id,
                feed_url=podcast["feed_url"],
                selected_episodes=selected_episodes,
                now=sync_now,
            )
            _mark_subscription_sync_completed(
                db,
                user_id=user_id,
                podcast_id=podcast_id,
                now=sync_now,
                sync_status="source_limited" if source_limited else "complete",
            )

        return {
            "sync_status": "source_limited" if source_limited else "complete",
            "ingested_episode_count": ingested_episode_count,
            "reused_episode_count": reused_episode_count,
            "source_limited": source_limited,
        }
    except ApiError as exc:
        error_code = exc.code.value
        error_message = exc.message
    except Exception as exc:
        logger.exception(
            "podcast_sync_unexpected_error",
            user_id=str(user_id),
            podcast_id=str(podcast_id),
            error=str(exc),
        )
        error_code = ApiErrorCode.E_INTERNAL.value
        error_message = "Internal podcast sync failure"

    with transaction(db):
        _mark_subscription_sync_failed(
            db,
            user_id=user_id,
            podcast_id=podcast_id,
            now=datetime.now(UTC),
            error_code=error_code,
            error_message=error_message,
        )

    return {
        "sync_status": "failed",
        "ingested_episode_count": 0,
        "reused_episode_count": 0,
        "source_limited": False,
        "error_code": error_code,
    }


def _sync_subscription_ingest(
    *,
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
    feed_url: str,
    selected_episodes: list[dict[str, Any]],
    now: datetime,
) -> tuple[int, int]:
    ingested_episode_count = 0
    reused_episode_count = 0
    ingested_media_ids: list[UUID] = []
    enrichment_media_ids: set[UUID] = set()
    chapter_sync_rows: list[tuple[UUID, list[dict[str, Any]] | None]] = []
    transcript_sync_rows: list[dict[str, Any]] = []
    podcast = _get_podcast_sync_metadata(db, podcast_id)
    podcast_author = str(podcast["author"] or "").strip() or None

    for episode in selected_episodes:
        guid = _normalize_guid(episode.get("guid"))
        fallback_identity = _compute_fallback_identity(podcast_id, episode)
        description_html = _normalize_optional_text(episode.get("description_html"))
        description_text = _normalize_optional_text(episode.get("description_text"))
        description = description_text[:2000] if description_text else None
        published_at = _parse_iso_datetime(episode.get("published_at"))
        published_date = str(episode.get("published_at") or "").strip()[:64] or None
        language = _normalize_language_tag(episode.get("language")) or _normalize_language_tag(
            episode.get("feed_language")
        )
        duration_seconds = _coerce_positive_int(episode.get("duration_seconds"))
        author_names: list[str] = []
        raw_authors = episode.get("authors")
        if isinstance(raw_authors, list):
            for raw_author in raw_authors:
                name = str(raw_author or "").strip()
                if name and name not in author_names:
                    author_names.append(name)
        if not author_names and podcast_author:
            author_names.append(podcast_author)
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
            _ensure_in_default_library(db, viewer_id, media_id)
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
                        published_at = :published_at,
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
            if author_names:
                db.execute(
                    text("DELETE FROM media_authors WHERE media_id = :media_id"),
                    {"media_id": media_id},
                )
                for sort_order, name in enumerate(author_names):
                    db.execute(
                        text(
                            """
                            INSERT INTO media_authors (id, media_id, name, role, sort_order)
                            VALUES (:id, :media_id, :name, 'author', :sort_order)
                            """
                        ),
                        {
                            "id": uuid4(),
                            "media_id": media_id,
                            "name": name[:255],
                            "sort_order": sort_order,
                        },
                    )
            else:
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
            _ensure_media_transcript_state_row(
                db,
                media_id=media_id,
                processing_status="pending",
                last_error_code=None,
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
            if author_names:
                for sort_order, name in enumerate(author_names):
                    db.execute(
                        text(
                            """
                            INSERT INTO media_authors (id, media_id, name, role, sort_order)
                            VALUES (:id, :media_id, :name, 'author', :sort_order)
                            """
                        ),
                        {
                            "id": uuid4(),
                            "media_id": media_id,
                            "name": name[:255],
                            "sort_order": sort_order,
                        },
                    )
            else:
                enrichment_media_ids.add(media_id)
            _ensure_in_default_library(db, viewer_id, media_id)
            ingested_episode_count += 1
            ingested_media_ids.append(media_id)
            enrichment_media_ids.add(media_id)

        chapter_sync_rows.append((media_id, episode.get("rss_chapters")))
        transcript_sync_rows.append(
            {
                "media_id": media_id,
                "refs": rss_transcript_refs,
                "duration_seconds": duration_seconds,
                "episode_language": _normalize_language_tag(episode.get("language")),
                "feed_language": _normalize_language_tag(episode.get("feed_language")),
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
                t_start_ms = _coerce_non_negative_int(segment.get("t_start_ms"))
                t_end_ms = _coerce_non_negative_int(segment.get("t_end_ms"))
                if t_start_ms is None:
                    continue
                if t_end_ms is None or t_end_ms <= t_start_ms:
                    segment["t_end_ms"] = t_start_ms + 1

        transcript_segments = _normalize_transcript_segments(fetched_segments)
        if not transcript_segments:
            continue

        transcript_coverage = "partial" if source_type == "text" else "full"
        transcript_state = "partial" if transcript_coverage == "partial" else "ready"

        transcript_version_id = _create_next_transcript_version(
            db,
            media_id=media_id,
            created_by_user_id=viewer_id,
            request_reason="rss_feed",
            transcript_coverage=transcript_coverage,
            now=now,
        )
        db.execute(
            text(
                """
                UPDATE fragments
                SET idx = idx + 1000000
                WHERE media_id = :media_id
                """
            ),
            {"media_id": media_id},
        )
        _insert_transcript_fragments(
            db,
            media_id,
            transcript_segments,
            now=now,
            transcript_version_id=transcript_version_id,
        )
        _insert_transcript_segments_for_version(
            db,
            media_id=media_id,
            transcript_version_id=transcript_version_id,
            transcript_segments=transcript_segments,
            now=now,
        )

        semantic_status = "ready"
        semantic_error_code: str | None = None
        try:
            _insert_transcript_chunks_for_version(
                db,
                media_id=media_id,
                transcript_version_id=transcript_version_id,
                transcript_segments=transcript_segments,
                now=now,
            )
        except Exception as exc:
            semantic_status = "failed"
            semantic_error_code = ApiErrorCode.E_INTERNAL.value
            logger.exception(
                "podcast_transcript_semantic_index_failed",
                media_id=str(media_id),
                transcript_version_id=str(transcript_version_id),
                error=str(exc),
            )
            db.execute(
                text(
                    """
                    DELETE FROM podcast_transcript_chunks
                    WHERE transcript_version_id = :transcript_version_id
                    """
                ),
                {"transcript_version_id": transcript_version_id},
            )

        db.execute(
            text(
                """
                UPDATE media
                SET
                    processing_status = 'ready_for_reading',
                    failure_stage = NULL,
                    last_error_code = NULL,
                    last_error_message = NULL,
                    processing_completed_at = :now,
                    failed_at = NULL,
                    updated_at = :now
                WHERE id = :media_id
                """
            ),
            {"media_id": media_id, "now": now},
        )
        _set_media_transcript_state(
            db,
            media_id=media_id,
            transcript_state=transcript_state,
            transcript_coverage=transcript_coverage,
            semantic_status=semantic_status,
            active_transcript_version_id=transcript_version_id,
            last_request_reason=None,
            last_error_code=semantic_error_code,
            now=now,
        )
        logger.info(
            "rss_transcript_persisted",
            media_id=str(media_id),
            transcript_version_id=str(transcript_version_id),
            transcript_state=transcript_state,
            transcript_coverage=transcript_coverage,
            source_type=source_type,
            segment_count=len(transcript_segments),
        )
        enrichment_media_ids.add(media_id)

    playback_queue_service.append_subscription_media_if_enabled(
        db,
        viewer_id=viewer_id,
        podcast_id=podcast_id,
        media_ids=ingested_media_ids,
    )

    for media_id in enrichment_media_ids:
        _try_enqueue_metadata_enrichment(db, media_id=media_id)

    return ingested_episode_count, reused_episode_count


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
                ON CONFLICT (media_id, chapter_idx)
                DO UPDATE SET
                    title = EXCLUDED.title,
                    t_start_ms = EXCLUDED.t_start_ms,
                    t_end_ms = EXCLUDED.t_end_ms,
                    url = EXCLUDED.url,
                    image_url = EXCLUDED.image_url,
                    source = EXCLUDED.source
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
        t_start_ms = _coerce_non_negative_int(chapter.get("t_start_ms"))
        if t_start_ms is None:
            continue
        t_end_ms = _coerce_non_negative_int(chapter.get("t_end_ms"))
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
                "url": _normalize_podcast_chapter_link(chapter.get("url"), base_url=None),
                "image_url": _normalize_podcast_chapter_link(
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


def refresh_subscription_sync_for_viewer(
    db: Session,
    *,
    viewer_id: UUID,
    podcast_id: UUID,
) -> PodcastSubscriptionSyncRefreshOut:
    settings = get_settings()
    now = datetime.now(UTC)
    running_lease_cutoff = now - timedelta(seconds=settings.podcast_sync_running_lease_seconds)
    should_enqueue = False

    with transaction(db):
        row = db.execute(
            text(
                """
                SELECT
                    status,
                    sync_status,
                    COALESCE(sync_started_at, updated_at)
                FROM podcast_subscriptions
                WHERE user_id = :user_id AND podcast_id = :podcast_id
                FOR UPDATE
                """
            ),
            {
                "user_id": viewer_id,
                "podcast_id": podcast_id,
            },
        ).fetchone()
        if row is None or row[0] != "active":
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast subscription not found")

        sync_status = str(row[1] or "")
        sync_started_or_updated_at = row[2]
        running_and_healthy = sync_status == "running" and (
            sync_started_or_updated_at is not None
            and sync_started_or_updated_at >= running_lease_cutoff
        )

        if not running_and_healthy:
            db.execute(
                text(
                    """
                    UPDATE podcast_subscriptions
                    SET
                        sync_status = 'pending',
                        sync_error_code = NULL,
                        sync_error_message = NULL,
                        sync_started_at = NULL,
                        sync_completed_at = NULL,
                        updated_at = :updated_at
                    WHERE user_id = :user_id
                      AND podcast_id = :podcast_id
                      AND status = 'active'
                    """
                ),
                {
                    "user_id": viewer_id,
                    "podcast_id": podcast_id,
                    "updated_at": now,
                },
            )
            should_enqueue = True

    sync_enqueued = False
    if should_enqueue:
        sync_enqueued = _enqueue_podcast_subscription_sync(
            db,
            user_id=viewer_id,
            podcast_id=podcast_id,
        )

    snapshot = _get_subscription_sync_snapshot(db, viewer_id, podcast_id)
    if snapshot is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast subscription not found")

    return PodcastSubscriptionSyncRefreshOut(
        podcast_id=podcast_id,
        sync_status=snapshot["sync_status"],
        sync_error_code=snapshot["sync_error_code"],
        sync_error_message=snapshot["sync_error_message"],
        sync_attempts=snapshot["sync_attempts"],
        sync_enqueued=sync_enqueued,
    )


def _enqueue_podcast_subscription_sync(
    db: Session,
    *,
    user_id: UUID,
    podcast_id: UUID,
    request_id: str | None = None,
) -> bool:
    try:
        enqueue_job(
            db,
            kind="podcast_sync_subscription_job",
            payload={
                "user_id": str(user_id),
                "podcast_id": str(podcast_id),
                "request_id": request_id,
            },
        )
        return True
    except Exception as exc:
        logger.error(
            "podcast_sync_enqueue_failed",
            user_id=str(user_id),
            podcast_id=str(podcast_id),
            error=str(exc),
        )
        raise ApiError(ApiErrorCode.E_INTERNAL, "Failed to enqueue podcast sync job.") from exc


def _get_subscription_sync_snapshot(
    db: Session,
    user_id: UUID,
    podcast_id: UUID,
) -> dict[str, Any] | None:
    row = db.execute(
        text(
            """
            SELECT auto_queue, sync_status, sync_error_code, sync_error_message, sync_attempts, last_synced_at
            FROM podcast_subscriptions
            WHERE user_id = :user_id AND podcast_id = :podcast_id
            """
        ),
        {"user_id": user_id, "podcast_id": podcast_id},
    ).fetchone()
    if row is None:
        return None
    return {
        "auto_queue": bool(row[0]),
        "sync_status": row[1],
        "sync_error_code": row[2],
        "sync_error_message": row[3],
        "sync_attempts": int(row[4] or 0),
        "last_synced_at": row[5],
    }


def _claim_subscription_sync_pending(
    db: Session,
    *,
    user_id: UUID,
    podcast_id: UUID,
    now: datetime,
    lease_expires_before: datetime,
) -> bool:
    row = db.execute(
        text(
            """
            UPDATE podcast_subscriptions
            SET
                sync_status = 'running',
                sync_error_code = NULL,
                sync_error_message = NULL,
                sync_started_at = :now,
                sync_completed_at = NULL,
                sync_attempts = sync_attempts + 1,
                updated_at = :now
            WHERE user_id = :user_id
              AND podcast_id = :podcast_id
              AND status = 'active'
              AND (
                  sync_status = 'pending'
                  OR (
                      sync_status = 'running'
                      AND COALESCE(sync_started_at, updated_at) < :lease_expires_before
                  )
              )
            RETURNING 1
            """
        ),
        {
            "user_id": user_id,
            "podcast_id": podcast_id,
            "now": now,
            "lease_expires_before": lease_expires_before,
        },
    ).fetchone()
    return row is not None


def _mark_subscription_sync_completed(
    db: Session,
    *,
    user_id: UUID,
    podcast_id: UUID,
    now: datetime,
    sync_status: str,
) -> None:
    db.execute(
        text(
            """
            UPDATE podcast_subscriptions
            SET
                sync_status = :sync_status,
                sync_error_code = NULL,
                sync_error_message = NULL,
                sync_completed_at = :now,
                last_synced_at = :now,
                updated_at = :now
            WHERE user_id = :user_id AND podcast_id = :podcast_id
            """
        ),
        {
            "user_id": user_id,
            "podcast_id": podcast_id,
            "sync_status": sync_status,
            "now": now,
        },
    )


def _mark_subscription_sync_failed(
    db: Session,
    *,
    user_id: UUID,
    podcast_id: UUID,
    now: datetime,
    error_code: str,
    error_message: str,
) -> None:
    db.execute(
        text(
            """
            UPDATE podcast_subscriptions
            SET
                sync_status = 'failed',
                sync_error_code = :error_code,
                sync_error_message = :error_message,
                sync_completed_at = :now,
                updated_at = :now
            WHERE user_id = :user_id AND podcast_id = :podcast_id
            """
        ),
        {
            "user_id": user_id,
            "podcast_id": podcast_id,
            "error_code": error_code,
            "error_message": error_message[:1000],
            "now": now,
        },
    )


def _get_podcast_sync_metadata(db: Session, podcast_id: UUID) -> dict[str, Any]:
    row = db.execute(
        text(
            """
            SELECT id, provider_podcast_id, feed_url, author
            FROM podcasts
            WHERE id = :podcast_id
            """
        ),
        {"podcast_id": podcast_id},
    ).fetchone()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
    return {
        "id": row[0],
        "provider_podcast_id": row[1],
        "feed_url": row[2],
        "author": row[3],
    }


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


def _compute_fallback_identity(podcast_id: UUID, episode: dict[str, Any]) -> str:
    audio_url = str(episode.get("audio_url") or "").strip().lower()
    title = str(episode.get("title") or "").strip().lower()
    published_at = str(episode.get("published_at") or "").strip().lower()
    seed = f"{podcast_id}|{audio_url}|{title}|{published_at}"
    return hashlib.sha256(seed.encode()).hexdigest()


def _augment_provider_episodes_with_feed_pagination(
    *,
    provider_episode_candidates: list[dict[str, Any]],
    feed_url: str,
    prefetch_limit: int,
) -> list[dict[str, Any]]:
    if len(provider_episode_candidates) >= prefetch_limit:
        return provider_episode_candidates
    if len(provider_episode_candidates) < PODCAST_INDEX_EPISODE_PAGE_SIZE:
        return provider_episode_candidates

    normalized_feed_url = str(feed_url or "").strip()
    if not normalized_feed_url:
        return provider_episode_candidates

    supplemental = _fetch_feed_episodes_paginated(normalized_feed_url, prefetch_limit)
    if not supplemental:
        return provider_episode_candidates

    combined = list(provider_episode_candidates)
    episode_by_dedupe_key = {_episode_dedupe_key(episode): episode for episode in combined}
    seen = set(episode_by_dedupe_key.keys())
    for episode in supplemental:
        dedupe_key = _episode_dedupe_key(episode)
        if dedupe_key in seen:
            existing = episode_by_dedupe_key.get(dedupe_key)
            if existing is not None:
                if existing.get("rss_chapters") is None and episode.get("rss_chapters") is not None:
                    existing["rss_chapters"] = episode.get("rss_chapters")
                if (
                    existing.get("rss_transcript_refs") is None
                    and episode.get("rss_transcript_refs") is not None
                ):
                    existing["rss_transcript_refs"] = episode.get("rss_transcript_refs")
                if not existing.get("description_html") and episode.get("description_html"):
                    existing["description_html"] = episode.get("description_html")
                if not existing.get("description_text") and episode.get("description_text"):
                    existing["description_text"] = episode.get("description_text")
                if existing.get("authors") is None and episode.get("authors") is not None:
                    existing["authors"] = episode.get("authors")
                if not existing.get("language") and episode.get("language"):
                    existing["language"] = episode.get("language")
                if not existing.get("feed_language") and episode.get("feed_language"):
                    existing["feed_language"] = episode.get("feed_language")
            continue
        seen.add(dedupe_key)
        combined.append(episode)
        episode_by_dedupe_key[dedupe_key] = episode
        if len(combined) >= prefetch_limit:
            break

    logger.info(
        "podcast_feed_pagination_augmentation",
        feed_url=normalized_feed_url,
        provider_candidate_count=len(provider_episode_candidates),
        supplemental_count=len(supplemental),
        combined_count=len(combined),
        prefetch_limit=prefetch_limit,
    )
    return combined


def _hydrate_selected_episode_chapters_from_feed(
    *,
    selected_episodes: list[dict[str, Any]],
    feed_url: str,
) -> list[dict[str, Any]]:
    if not selected_episodes:
        return selected_episodes

    for episode in selected_episodes:
        episode.setdefault("rss_chapters", None)
        episode.setdefault("rss_transcript_refs", None)
        episode.setdefault("description_html", None)
        episode.setdefault("description_text", None)
        episode.setdefault("authors", None)
        episode.setdefault("language", None)
        episode.setdefault("feed_language", None)

    normalized_feed_url = str(feed_url or "").strip()
    if not normalized_feed_url:
        return selected_episodes

    feed_lookup_limit = max(PODCAST_INDEX_EPISODE_PAGE_SIZE, len(selected_episodes) * 4)
    feed_episodes = _fetch_feed_episodes_paginated(normalized_feed_url, feed_lookup_limit)
    if not feed_episodes:
        return selected_episodes

    feed_episode_by_match_key: dict[str, dict[str, Any]] = {}
    for feed_episode in feed_episodes:
        for match_key in _episode_match_keys(feed_episode):
            feed_episode_by_match_key.setdefault(match_key, feed_episode)

    for episode in selected_episodes:
        if (
            episode.get("rss_chapters") is not None
            and episode.get("rss_transcript_refs") is not None
            and episode.get("description_html")
            and episode.get("description_text")
        ):
            continue
        for match_key in _episode_match_keys(episode):
            feed_episode = feed_episode_by_match_key.get(match_key)
            if feed_episode is None:
                continue
            if episode.get("rss_chapters") is None:
                episode["rss_chapters"] = feed_episode.get("rss_chapters")
            if episode.get("rss_transcript_refs") is None:
                episode["rss_transcript_refs"] = feed_episode.get("rss_transcript_refs")
            if not episode.get("description_html"):
                episode["description_html"] = feed_episode.get("description_html")
            if not episode.get("description_text"):
                episode["description_text"] = feed_episode.get("description_text")
            if episode.get("authors") is None:
                episode["authors"] = feed_episode.get("authors")
            if not episode.get("language"):
                episode["language"] = feed_episode.get("language")
            if not episode.get("feed_language"):
                episode["feed_language"] = feed_episode.get("feed_language")
            break

    return selected_episodes


def _is_safe_feed_page_url(page_url: str) -> bool:
    try:
        validate_requested_url(page_url)
        return True
    except InvalidRequestError as exc:
        logger.warning(
            "podcast_feed_page_url_rejected",
            page_url=page_url,
            reason=exc.message,
        )
        return False


def _fetch_feed_episodes_paginated(feed_url: str, limit: int) -> list[dict[str, Any]]:
    if limit <= 0:
        return []

    episodes: list[dict[str, Any]] = []
    seen_episode_keys: set[tuple[str, str, str, str]] = set()
    seen_page_urls: set[str] = set()

    next_page_url: str | None = feed_url
    pages_fetched = 0
    while (
        next_page_url
        and len(episodes) < limit
        and pages_fetched < PODCAST_FEED_PAGINATION_MAX_PAGES
    ):
        if not _is_safe_feed_page_url(next_page_url):
            break
        if next_page_url in seen_page_urls:
            break
        seen_page_urls.add(next_page_url)
        page_episodes, upcoming_page_url = _fetch_feed_episode_page(next_page_url)
        pages_fetched += 1

        for episode in page_episodes:
            dedupe_key = _episode_dedupe_key(episode)
            if dedupe_key in seen_episode_keys:
                continue
            seen_episode_keys.add(dedupe_key)
            episodes.append(episode)
            if len(episodes) >= limit:
                break

        if upcoming_page_url and not _is_safe_feed_page_url(upcoming_page_url):
            break
        next_page_url = upcoming_page_url

    if next_page_url and pages_fetched >= PODCAST_FEED_PAGINATION_MAX_PAGES:
        logger.warning(
            "podcast_feed_pagination_page_limit_reached",
            feed_url=feed_url,
            pages_fetched=pages_fetched,
            prefetch_limit=limit,
        )

    return episodes


def _fetch_feed_episode_page(page_url: str) -> tuple[list[dict[str, Any]], str | None]:
    try:
        response = None
        current_page_url = page_url
        for _ in range(5):
            response = httpx.get(
                current_page_url,
                headers={"User-Agent": "nexus-podcast-client/1.0"},
                timeout=15.0,
                follow_redirects=False,
            )
            if response.status_code in {301, 302, 303, 307, 308}:
                location = response.headers.get("location")
                if not location:
                    logger.warning(
                        "podcast_feed_page_redirect_missing_location",
                        page_url=current_page_url,
                    )
                    return [], None
                redirected_url = urljoin(str(response.url), location)
                if not _is_safe_feed_page_url(redirected_url):
                    return [], None
                current_page_url = redirected_url
                continue
            response.raise_for_status()
            break
        else:
            logger.warning("podcast_feed_page_too_many_redirects", page_url=page_url)
            return [], None
    except Exception as exc:
        logger.warning("podcast_feed_page_fetch_failed", page_url=page_url, error=str(exc))
        return [], None

    if response is None:
        return [], None

    try:
        parser = etree.XMLParser(resolve_entities=False, no_network=True, recover=True)
        root = etree.fromstring(response.content, parser=parser)
    except Exception as exc:
        logger.warning("podcast_feed_page_parse_failed", page_url=page_url, error=str(exc))
        return [], None

    item_nodes = root.xpath("./channel/item")
    if not item_nodes:
        item_nodes = root.xpath(".//atom:entry", namespaces=_ATOM_NAMESPACE)

    feed_language = _normalize_language_tag(root.xpath("string(./channel/language)"))

    episodes: list[dict[str, Any]] = []
    for item in item_nodes:
        episode = _episode_from_feed_item(
            item,
            base_url=str(response.url),
            feed_language=feed_language,
        )
        if episode is not None:
            episodes.append(episode)

    next_page_url = _extract_feed_next_page_url(root, str(response.url))
    return episodes, next_page_url


def _episode_from_feed_item(
    item: Any,
    *,
    base_url: str | None = None,
    feed_language: str | None = None,
) -> dict[str, Any] | None:
    title = str(item.xpath("string(./title)")).strip() or "Untitled Episode"
    guid = _normalize_guid(item.xpath("string(./guid)") or item.xpath("string(./id)"))

    audio_url = str(item.xpath("string(./enclosure/@url)")).strip()
    if not audio_url:
        audio_url = str(item.xpath("string(./link[@rel='enclosure']/@href)")).strip()
    if not audio_url:
        audio_url = str(item.xpath("string(./link)")).strip()
    if not audio_url:
        audio_url = str(item.xpath("string(./link/@href)")).strip()

    published_raw = (
        item.xpath("string(./pubDate)")
        or item.xpath("string(./published)")
        or item.xpath("string(./updated)")
    )
    published_at = _normalize_feed_published_at(published_raw)

    duration_raw = item.xpath(f"string({_ITUNES_DURATION_XPATH})") or item.xpath(
        "string(./duration)"
    )
    duration_seconds = _parse_feed_duration_seconds(duration_raw)
    description_html, description_text = _extract_episode_show_notes_from_feed_item(
        item,
        base_url=base_url,
    )
    authors: list[str] = []
    person_nodes = item.xpath(
        "./*[local-name()='person' and namespace-uri()='https://podcastindex.org/namespace/1.0']"
    )
    if not person_nodes:
        person_nodes = item.xpath(
            "./*[local-name()='person' and namespace-uri()='https://podcastnamespace.org/podcast/1.0']"
        )
    for person_node in person_nodes:
        name = str(getattr(person_node, "text", "") or "").strip()
        if name and name not in authors:
            authors.append(name)
    if not authors:
        raw_author = (
            item.xpath("string(./author)")
            or item.xpath(
                "string(./*[local-name()='author' and namespace-uri()='http://www.itunes.com/dtds/podcast-1.0.dtd'])"
            )
            or item.xpath("string(./*[local-name()='creator'])")
        )
        for name in re.split(r"\s*[,;]\s*|\s+and\s+", str(raw_author or "").strip()):
            normalized_name = name.strip()
            if normalized_name and normalized_name not in authors:
                authors.append(normalized_name)

    provider_episode_id = guid or audio_url
    if not provider_episode_id:
        seed = f"{title}|{published_at or ''}"
        provider_episode_id = f"feed-{hashlib.sha1(seed.encode()).hexdigest()}"

    chapter_rows = _extract_rss_chapters_from_feed_item(item, base_url=base_url)
    transcript_refs = _extract_rss_transcript_refs_from_feed_item(item, base_url=base_url)
    episode_language = _normalize_language_tag(item.xpath("string(./language)")) or feed_language

    return {
        "provider_episode_id": provider_episode_id,
        "guid": guid,
        "title": title,
        "authors": authors or None,
        "audio_url": audio_url,
        "published_at": published_at,
        "duration_seconds": duration_seconds,
        "description_html": description_html,
        "description_text": description_text,
        "transcript_segments": None,
        "rss_chapters": chapter_rows,
        "rss_transcript_refs": transcript_refs,
        "language": episode_language,
        "feed_language": feed_language,
    }


def _extract_episode_show_notes_from_feed_item(
    item: Any,
    *,
    base_url: str | None,
) -> tuple[str | None, str | None]:
    raw_content_encoded = str(
        item.xpath(f"string(./{_PODCAST_CONTENT_ENCODED_XPATH})") or ""
    ).strip()
    raw_description = str(item.xpath("string(./description)") or "").strip()
    raw_show_notes = raw_content_encoded or raw_description
    if not raw_show_notes:
        return None, None

    sanitize_base_url = str(base_url or "https://example.invalid/")
    try:
        sanitized_html = sanitize_html(raw_show_notes, sanitize_base_url)
    except ValueError:
        sanitized_html = ""

    normalized_html = _normalize_optional_text(sanitized_html)
    if normalized_html is not None:
        normalized_html = _truncate_utf8_bytes(
            normalized_html,
            PODCAST_EPISODE_SHOW_NOTES_HTML_MAX_BYTES,
        )

    description_text_source = normalized_html or raw_show_notes
    normalized_text = _normalize_optional_text(
        _extract_plain_text_from_html_fragment(description_text_source)
    )
    if normalized_text is not None:
        normalized_text = _truncate_utf8_bytes(
            normalized_text,
            PODCAST_EPISODE_SHOW_NOTES_TEXT_MAX_BYTES,
        )

    return normalized_html, normalized_text


def _extract_plain_text_from_html_fragment(raw_value: str) -> str:
    if not raw_value:
        return ""
    try:
        parser = etree.HTMLParser(no_network=True, recover=True)
        root = etree.fromstring(f"<div>{raw_value}</div>".encode(), parser=parser)
        if root is None:
            return ""
        text_tokens = [str(token).strip() for token in root.xpath("//text()")]
        return re.sub(r"\s+", " ", " ".join(token for token in text_tokens if token)).strip()
    except Exception:
        stripped = re.sub(r"<[^>]+>", " ", raw_value)
        return re.sub(r"\s+", " ", stripped).strip()


def _truncate_utf8_bytes(value: str, max_bytes: int) -> str:
    encoded = value.encode("utf-8")
    if len(encoded) <= max_bytes:
        return value
    return encoded[:max_bytes].decode("utf-8", errors="ignore")


def _extract_rss_chapters_from_feed_item(
    item: Any,
    *,
    base_url: str | None,
) -> list[dict[str, Any]] | None:
    podcasting20_url = _extract_podcasting20_chapter_url(item, base_url=base_url)
    if podcasting20_url is not None:
        return _fetch_podcasting20_chapters(podcasting20_url)
    return _parse_podlove_chapters(item, base_url=base_url)


def _extract_rss_transcript_refs_from_feed_item(
    item: Any,
    *,
    base_url: str | None,
) -> list[dict[str, Any]] | None:
    transcript_nodes = item.xpath("./*[local-name()='transcript' and @url]")
    if not transcript_nodes:
        return None

    refs: list[dict[str, Any]] = []
    for transcript_node in transcript_nodes:
        resolved_url = _normalize_podcast_chapter_link(
            transcript_node.attrib.get("url"),
            base_url=base_url,
        )
        if resolved_url is None:
            continue
        if not _is_safe_feed_page_url(resolved_url):
            continue
        transcript_type = str(transcript_node.attrib.get("type") or "").strip().lower() or None
        transcript_language = _normalize_language_tag(transcript_node.attrib.get("language"))
        refs.append(
            {
                "url": resolved_url,
                "type": transcript_type,
                "language": transcript_language,
            }
        )

    if not refs:
        return None

    logger.info(
        "rss_transcript_extracted",
        transcript_ref_count=len(refs),
        base_url=base_url,
    )
    return refs


def _extract_podcasting20_chapter_url(item: Any, *, base_url: str | None) -> str | None:
    chapter_tag_nodes = item.xpath("./*[local-name()='chapters' and @url]")
    if not chapter_tag_nodes:
        return None
    chapter_tag = chapter_tag_nodes[0]
    chapter_type = str(chapter_tag.attrib.get("type") or "").strip().lower()
    if chapter_type and chapter_type not in _PODCAST_CHAPTERS_20_CONTENT_TYPES:
        return None
    raw_url = chapter_tag.attrib.get("url")
    resolved_url = _normalize_podcast_chapter_link(raw_url, base_url=base_url)
    if resolved_url is None:
        return None
    if not _is_safe_feed_page_url(resolved_url):
        return None
    return resolved_url


def _fetch_podcasting20_chapters(chapters_url: str) -> list[dict[str, Any]] | None:
    try:
        response = httpx.get(
            chapters_url,
            headers={"User-Agent": "nexus-podcast-client/1.0"},
            timeout=15.0,
        )
        response.raise_for_status()
    except Exception as exc:
        logger.warning(
            "podcast_chapters_json_fetch_failed",
            chapters_url=chapters_url,
            error=str(exc),
        )
        return None

    try:
        payload = response.json()
    except ValueError as exc:
        logger.warning(
            "podcast_chapters_json_invalid",
            chapters_url=chapters_url,
            error=str(exc),
        )
        return None
    return _parse_podcasting20_chapter_payload(payload, base_url=chapters_url)


def _parse_podcasting20_chapter_payload(
    payload: Any, *, base_url: str | None
) -> list[dict[str, Any]]:
    chapter_entries: list[Any]
    if isinstance(payload, dict):
        raw_chapters = payload.get("chapters")
        chapter_entries = raw_chapters if isinstance(raw_chapters, list) else []
    elif isinstance(payload, list):
        chapter_entries = payload
    else:
        chapter_entries = []

    parsed_rows: list[dict[str, Any]] = []
    for entry in chapter_entries:
        if not isinstance(entry, dict):
            continue
        title = str(entry.get("title") or "").strip()
        if not title:
            continue
        t_start_ms = _parse_chapter_timestamp_ms(
            entry.get("startTime") or entry.get("start_time") or entry.get("start")
        )
        if t_start_ms is None:
            continue
        t_end_ms = _parse_chapter_timestamp_ms(
            entry.get("endTime") or entry.get("end_time") or entry.get("end")
        )
        if t_end_ms is not None and t_end_ms < t_start_ms:
            t_end_ms = None
        parsed_rows.append(
            {
                "title": title,
                "t_start_ms": t_start_ms,
                "t_end_ms": t_end_ms,
                "url": _normalize_podcast_chapter_link(
                    entry.get("url") or entry.get("href"),
                    base_url=base_url,
                ),
                "image_url": _normalize_podcast_chapter_link(
                    entry.get("img") or entry.get("image") or entry.get("image_url"),
                    base_url=base_url,
                ),
                "source": PODCAST_CHAPTER_SOURCE_PODCASTING20,
            }
        )
    parsed_rows.sort(key=lambda row: row["t_start_ms"])
    return parsed_rows


def _parse_podlove_chapters(item: Any, *, base_url: str | None) -> list[dict[str, Any]]:
    chapter_nodes = item.xpath(".//*[local-name()='chapters']/*[local-name()='chapter']")
    if not chapter_nodes:
        return []

    parsed_rows: list[dict[str, Any]] = []
    for chapter_node in chapter_nodes:
        title = str(chapter_node.attrib.get("title") or "").strip()
        if not title:
            continue
        t_start_ms = _parse_chapter_timestamp_ms(chapter_node.attrib.get("start"))
        if t_start_ms is None:
            continue
        t_end_ms = _parse_chapter_timestamp_ms(chapter_node.attrib.get("end"))
        if t_end_ms is not None and t_end_ms < t_start_ms:
            t_end_ms = None
        parsed_rows.append(
            {
                "title": title,
                "t_start_ms": t_start_ms,
                "t_end_ms": t_end_ms,
                "url": _normalize_podcast_chapter_link(
                    chapter_node.attrib.get("href") or chapter_node.attrib.get("url"),
                    base_url=base_url,
                ),
                "image_url": _normalize_podcast_chapter_link(
                    chapter_node.attrib.get("image") or chapter_node.attrib.get("img"),
                    base_url=base_url,
                ),
                "source": PODCAST_CHAPTER_SOURCE_PODLOVE,
            }
        )
    parsed_rows.sort(key=lambda row: row["t_start_ms"])
    return parsed_rows


def _normalize_podcast_chapter_link(raw_url: Any, *, base_url: str | None) -> str | None:
    if raw_url is None:
        return None
    normalized_raw = str(raw_url).strip()
    if not normalized_raw:
        return None
    resolved_url = urljoin(base_url, normalized_raw) if base_url else normalized_raw
    try:
        validate_requested_url(resolved_url)
    except InvalidRequestError:
        return None
    return resolved_url


def _parse_chapter_timestamp_ms(raw_value: Any) -> int | None:
    if raw_value is None:
        return None
    if isinstance(raw_value, (int, float)):
        if raw_value < 0:
            return None
        return int(math.floor(float(raw_value) * 1000.0))

    raw_text = str(raw_value).strip()
    if not raw_text:
        return None

    try:
        numeric_seconds = float(raw_text)
    except ValueError:
        numeric_seconds = None
    if numeric_seconds is not None:
        if numeric_seconds < 0:
            return None
        return int(math.floor(numeric_seconds * 1000.0))

    match = _CHAPTER_TIMESTAMP_PATTERN.match(raw_text)
    if match is None:
        return None
    hours = int(match.group("hours") or "0")
    minutes = int(match.group("minutes"))
    seconds = float(match.group("seconds"))
    total_seconds = (hours * 3600.0) + (minutes * 60.0) + seconds
    return int(math.floor(total_seconds * 1000.0))


def _extract_feed_next_page_url(root: Any, base_url: str) -> str | None:
    href = str(
        root.xpath("string(./channel/atom:link[@rel='next'][1]/@href)", namespaces=_ATOM_NAMESPACE)
    ).strip()
    if not href:
        href = str(
            root.xpath("string(./atom:link[@rel='next'][1]/@href)", namespaces=_ATOM_NAMESPACE)
        ).strip()
    if not href:
        href = str(root.xpath("string(.//*[local-name()='link' and @rel='next'][1]/@href)")).strip()
    if not href:
        return None
    return urljoin(base_url, href)


def _normalize_feed_published_at(raw_value: Any) -> str | None:
    if raw_value is None:
        return None

    raw_text = str(raw_value).strip()
    if not raw_text:
        return None

    try:
        parsed = parsedate_to_datetime(raw_text)
    except (TypeError, ValueError):
        parsed = _parse_iso_datetime(raw_text)

    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)

    return parsed.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _parse_feed_duration_seconds(raw_value: Any) -> int | None:
    if raw_value is None:
        return None

    raw_text = str(raw_value).strip()
    if not raw_text:
        return None

    if ":" not in raw_text:
        return _coerce_positive_int(raw_text)

    parts = raw_text.split(":")
    if len(parts) not in (2, 3):
        return None
    try:
        values = [int(part) for part in parts]
    except ValueError:
        return None
    if any(value < 0 for value in values):
        return None

    if len(values) == 2:
        minutes, seconds = values
        return (minutes * 60) + seconds

    hours, minutes, seconds = values
    return (hours * 3600) + (minutes * 60) + seconds


def _episode_dedupe_key(episode: dict[str, Any]) -> tuple[str, str, str, str]:
    guid = _normalize_guid(episode.get("guid")) or ""
    audio_url = str(episode.get("audio_url") or "").strip().lower()
    title = str(episode.get("title") or "").strip().lower()
    published_at = str(episode.get("published_at") or "").strip().lower()
    return (guid, audio_url, title, published_at)


def _episode_match_keys(episode: dict[str, Any]) -> list[str]:
    keys: list[str] = []
    guid = _normalize_guid(episode.get("guid"))
    if guid:
        keys.append(f"guid:{guid.lower()}")

    audio_url = str(episode.get("audio_url") or "").strip().lower()
    if audio_url:
        keys.append(f"audio:{audio_url}")

    provider_episode_id = str(episode.get("provider_episode_id") or "").strip().lower()
    if provider_episode_id:
        keys.append(f"provider:{provider_episode_id}")

    title = str(episode.get("title") or "").strip().lower()
    normalized_published_at = _normalize_provider_published_at(episode.get("published_at")) or ""
    if title and normalized_published_at:
        keys.append(f"title_published:{title}|{normalized_published_at.lower()}")

    return keys


def _normalize_guid(value: Any) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _normalize_optional_text(value: Any) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _normalize_language_tag(value: Any) -> str | None:
    normalized = _normalize_optional_text(value)
    if normalized is None:
        return None
    return normalized.lower().replace("_", "-")


def _normalize_provider_published_at(raw_value: Any) -> str | None:
    if raw_value is None:
        return None
    if isinstance(raw_value, (int, float)):
        if raw_value <= 0:
            return None
        return datetime.fromtimestamp(raw_value, UTC).isoformat().replace("+00:00", "Z")
    raw_text = str(raw_value).strip()
    if not raw_text:
        return None
    parsed = _parse_iso_datetime(raw_text)
    if parsed is None:
        return None
    return parsed.isoformat().replace("+00:00", "Z")


def _parse_iso_datetime(raw_value: Any) -> datetime | None:
    if raw_value is None:
        return None
    value = str(raw_value).strip()
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _published_sort_key(raw_value: Any) -> datetime:
    parsed = _parse_iso_datetime(raw_value)
    if parsed is None:
        return datetime.min.replace(tzinfo=UTC)
    return parsed


def _coerce_positive_int(raw_value: Any) -> int | None:
    if raw_value is None:
        return None
    try:
        value = int(raw_value)
    except (TypeError, ValueError):
        return None
    if value <= 0:
        return None
    return value


def _coerce_non_negative_int(raw_value: Any) -> int | None:
    if raw_value is None:
        return None
    try:
        value = int(raw_value)
    except (TypeError, ValueError):
        return None
    if value < 0:
        return None
    return value
