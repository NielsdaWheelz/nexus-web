"""Podcast discovery, subscription ingest, and quota policy services."""

from __future__ import annotations

import hashlib
import math
import time
from datetime import UTC, date, datetime, timedelta
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
    ConflictError,
    ForbiddenError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.logging import get_logger
from nexus.schemas.media import MediaOut
from nexus.schemas.podcast import (
    PodcastDetailOut,
    PodcastDiscoveryOut,
    PodcastListItemOut,
    PodcastPlanOut,
    PodcastPlanUpdateRequest,
    PodcastSubscribeOut,
    PodcastSubscribeRequest,
    PodcastSubscriptionListItemOut,
    PodcastSubscriptionStatusOut,
)
from nexus.services.search import visible_media_ids_cte_sql
from nexus.services.transcript_segments import (
    canonicalize_transcript_segment_text as _shared_canonicalize_transcript_segment_text,
)
from nexus.services.transcript_segments import (
    insert_transcript_fragments as _shared_insert_transcript_fragments,
)
from nexus.services.transcript_segments import (
    normalize_transcript_segments as _shared_normalize_transcript_segments,
)
from nexus.services.upload import _ensure_in_default_library
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url

logger = get_logger(__name__)

PODCAST_PROVIDER = "podcast_index"
PODCAST_INDEX_EPISODE_PAGE_SIZE = 100
PODCAST_FEED_PAGINATION_MAX_PAGES = 10
PODCAST_UNSUBSCRIBE_MODES = {1, 2, 3}
PODCAST_PROVIDER_RETRYABLE_STATUS_CODES = {408, 429, 500, 502, 503, 504}
PODCAST_PROVIDER_MAX_ATTEMPTS = 3
PODCAST_PROVIDER_BACKOFF_SECONDS = (0.25, 0.5, 1.0)
_ATOM_NAMESPACE = {"atom": "http://www.w3.org/2005/Atom"}
_ITUNES_DURATION_XPATH = (
    "*[local-name()='duration' and namespace-uri()='http://www.itunes.com/dtds/podcast-1.0.dtd']"
)
_DEEPGRAM_LISTEN_PATH = "/v1/listen"
_PODCAST_ACTIVE_POLL_MAX_LIMIT = 1000
_PODCAST_ACTIVE_POLL_UNEXPECTED_ERROR_CODE = ApiErrorCode.E_INTERNAL.value
PODCAST_TRANSCRIPT_REQUEST_REASONS = {
    "episode_open",
    "search",
    "highlight",
    "quote",
    "background_warming",
    "operator_requeue",
}


class PodcastIndexClient:
    """Thin HTTP client for Podcast Index discovery + episode metadata."""

    def __init__(self, *, api_key: str | None, api_secret: str | None, base_url: str):
        self.api_key = api_key
        self.api_secret = api_secret
        self.base_url = base_url.rstrip("/")

    def _auth_headers(self) -> dict[str, str]:
        if not self.api_key or not self.api_secret:
            raise ApiError(
                ApiErrorCode.E_PODCAST_PROVIDER_UNAVAILABLE,
                "Podcast provider credentials are not configured",
            )
        now_epoch = str(int(datetime.now(UTC).timestamp()))
        digest = hashlib.sha1(f"{self.api_key}{self.api_secret}{now_epoch}".encode()).hexdigest()
        return {
            "X-Auth-Date": now_epoch,
            "X-Auth-Key": self.api_key,
            "Authorization": digest,
            "User-Agent": "nexus-podcast-client/1.0",
        }

    def _retry_delay_seconds(
        self, *, attempt_index: int, response: httpx.Response | None = None
    ) -> float:
        # Respect Retry-After when provider rate-limits requests.
        if response is not None and response.status_code == 429:
            retry_after = str(response.headers.get("Retry-After") or "").strip()
            if retry_after:
                try:
                    retry_after_seconds = float(retry_after)
                    if retry_after_seconds > 0:
                        return min(retry_after_seconds, 10.0)
                except ValueError:
                    pass
        return PODCAST_PROVIDER_BACKOFF_SECONDS[
            min(attempt_index, len(PODCAST_PROVIDER_BACKOFF_SECONDS) - 1)
        ]

    def _get_json(self, path: str, *, params: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        last_exc: Exception | None = None
        for attempt_index in range(PODCAST_PROVIDER_MAX_ATTEMPTS):
            try:
                response = httpx.get(
                    url,
                    params=params,
                    headers=self._auth_headers(),
                    timeout=15.0,
                )
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, dict):
                    raise ApiError(
                        ApiErrorCode.E_PODCAST_PROVIDER_UNAVAILABLE,
                        "Podcast provider returned an invalid response",
                    )
                return payload
            except httpx.HTTPStatusError as exc:
                last_exc = exc
                status_code = exc.response.status_code
                if (
                    status_code in PODCAST_PROVIDER_RETRYABLE_STATUS_CODES
                    and attempt_index < PODCAST_PROVIDER_MAX_ATTEMPTS - 1
                ):
                    delay_seconds = self._retry_delay_seconds(
                        attempt_index=attempt_index,
                        response=exc.response,
                    )
                    logger.warning(
                        "podcast_provider_retryable_http_error",
                        provider=PODCAST_PROVIDER,
                        path=path,
                        status_code=status_code,
                        attempt=attempt_index + 1,
                        max_attempts=PODCAST_PROVIDER_MAX_ATTEMPTS,
                        retry_delay_seconds=delay_seconds,
                    )
                    time.sleep(delay_seconds)
                    continue
                break
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                last_exc = exc
                if attempt_index < PODCAST_PROVIDER_MAX_ATTEMPTS - 1:
                    delay_seconds = self._retry_delay_seconds(attempt_index=attempt_index)
                    logger.warning(
                        "podcast_provider_retryable_transport_error",
                        provider=PODCAST_PROVIDER,
                        path=path,
                        attempt=attempt_index + 1,
                        max_attempts=PODCAST_PROVIDER_MAX_ATTEMPTS,
                        retry_delay_seconds=delay_seconds,
                        error=str(exc),
                    )
                    time.sleep(delay_seconds)
                    continue
                break
            except Exception as exc:
                last_exc = exc
                break

        raise ApiError(
            ApiErrorCode.E_PODCAST_PROVIDER_UNAVAILABLE,
            "Podcast provider request failed",
        ) from last_exc

    def search_podcasts(self, query: str, limit: int) -> list[dict[str, Any]]:
        payload = self._get_json(
            "/search/byterm",
            params={"q": query, "max": max(1, min(limit, 100))},
        )
        feeds = payload.get("feeds", [])
        if not isinstance(feeds, list):
            return []

        results: list[dict[str, Any]] = []
        for feed in feeds:
            if not isinstance(feed, dict):
                continue
            provider_podcast_id = str(feed.get("id") or "").strip()
            feed_url = str(feed.get("url") or "").strip()
            if not provider_podcast_id or not feed_url:
                continue
            results.append(
                {
                    "provider_podcast_id": provider_podcast_id,
                    "title": str(feed.get("title") or "Untitled Podcast"),
                    "author": (str(feed.get("author")) if feed.get("author") is not None else None),
                    "feed_url": feed_url,
                    "website_url": (
                        str(feed.get("link")) if feed.get("link") is not None else None
                    ),
                    "image_url": (
                        str(feed.get("image")) if feed.get("image") is not None else None
                    ),
                    "description": (
                        str(feed.get("description"))
                        if feed.get("description") is not None
                        else None
                    ),
                }
            )
        return results

    def fetch_recent_episodes(self, provider_podcast_id: str, limit: int) -> list[dict[str, Any]]:
        payload = self._get_json(
            "/episodes/byfeedid",
            params={
                "id": provider_podcast_id,
                "max": max(1, min(limit, PODCAST_INDEX_EPISODE_PAGE_SIZE)),
            },
        )
        items = payload.get("items", [])
        if not isinstance(items, list):
            return []

        episodes: list[dict[str, Any]] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            provider_episode_id = str(item.get("id") or item.get("guid") or "").strip()
            if not provider_episode_id:
                provider_episode_id = f"episode-{uuid4()}"

            guid_raw = item.get("guid")
            guid = str(guid_raw).strip() if guid_raw is not None and str(guid_raw).strip() else None

            published_at = _normalize_provider_published_at(item.get("datePublished"))
            duration_seconds = _coerce_positive_int(item.get("duration"))
            audio_url = str(item.get("enclosureUrl") or item.get("enclosure_url") or "").strip()
            if not audio_url:
                audio_url = str(item.get("url") or "").strip()

            episodes.append(
                {
                    "provider_episode_id": provider_episode_id,
                    "guid": guid,
                    "title": str(item.get("title") or "Untitled Episode"),
                    "audio_url": audio_url,
                    "published_at": published_at,
                    "duration_seconds": duration_seconds,
                    # External providers usually do not supply transcript segments.
                    # Tests patch this field through the same boundary seam.
                    "transcript_segments": item.get("transcript_segments"),
                }
            )
        return episodes


def get_podcast_index_client() -> PodcastIndexClient:
    settings = get_settings()
    return PodcastIndexClient(
        api_key=settings.podcast_index_api_key,
        api_secret=settings.podcast_index_api_secret,
        base_url=settings.podcast_index_base_url,
    )


def discover_podcasts(query: str, *, limit: int = 10) -> list[PodcastDiscoveryOut]:
    query = query.strip()
    if not query:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Query must not be empty")
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")

    client = get_podcast_index_client()
    rows = client.search_podcasts(query, limit)
    return [PodcastDiscoveryOut(**row) for row in rows]


def subscribe_to_podcast(
    db: Session,
    viewer_id: UUID,
    body: PodcastSubscribeRequest,
) -> PodcastSubscribeOut:
    normalized_feed_url = _validate_and_normalize_feed_url(body.feed_url)
    normalized_body = body.model_copy(update={"feed_url": normalized_feed_url})
    plan = _get_effective_plan(db, viewer_id)
    now = datetime.now(UTC)

    with transaction(db):
        podcast_id = _upsert_podcast(db, normalized_body, now=now)
        subscription_created = _upsert_subscription(db, viewer_id, podcast_id, now=now)
        sync_enqueued = _enqueue_podcast_subscription_sync(user_id=viewer_id, podcast_id=podcast_id)
        snapshot = _get_subscription_sync_snapshot(db, viewer_id, podcast_id)
        if snapshot is None:
            raise ApiError(ApiErrorCode.E_INTERNAL, "Failed to read podcast subscription state.")

    return PodcastSubscribeOut(
        podcast_id=podcast_id,
        subscription_created=subscription_created,
        sync_status=snapshot["sync_status"],
        sync_enqueued=sync_enqueued,
        sync_error_code=snapshot["sync_error_code"],
        sync_error_message=snapshot["sync_error_message"],
        sync_attempts=snapshot["sync_attempts"],
        last_synced_at=snapshot["last_synced_at"],
        window_size=plan["initial_episode_window"],
    )


def get_subscription_status(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
) -> PodcastSubscriptionStatusOut:
    row = db.execute(
        text(
            """
            SELECT
                user_id,
                podcast_id,
                status,
                unsubscribe_mode,
                sync_status,
                sync_error_code,
                sync_error_message,
                sync_attempts,
                sync_started_at,
                sync_completed_at,
                last_synced_at,
                updated_at
            FROM podcast_subscriptions
            WHERE user_id = :user_id AND podcast_id = :podcast_id
            """
        ),
        {"user_id": viewer_id, "podcast_id": podcast_id},
    ).fetchone()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast subscription not found")

    return PodcastSubscriptionStatusOut(
        user_id=row[0],
        podcast_id=row[1],
        status=row[2],
        unsubscribe_mode=row[3],
        sync_status=row[4],
        sync_error_code=row[5],
        sync_error_message=row[6],
        sync_attempts=row[7],
        sync_started_at=row[8],
        sync_completed_at=row[9],
        last_synced_at=row[10],
        updated_at=row[11],
    )


def _podcast_list_item_from_row(row: Any) -> PodcastListItemOut:
    return PodcastListItemOut(
        id=row[0],
        provider=row[1],
        provider_podcast_id=row[2],
        title=row[3],
        author=row[4],
        feed_url=row[5],
        website_url=row[6],
        image_url=row[7],
        description=row[8],
        created_at=row[9],
        updated_at=row[10],
    )


def list_subscriptions(
    db: Session,
    viewer_id: UUID,
    *,
    limit: int = 100,
) -> list[PodcastSubscriptionListItemOut]:
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")
    limit = min(limit, 200)
    rows = db.execute(
        text(
            """
            SELECT
                ps.podcast_id,
                ps.status,
                ps.unsubscribe_mode,
                ps.sync_status,
                ps.sync_error_code,
                ps.sync_error_message,
                ps.sync_attempts,
                ps.sync_started_at,
                ps.sync_completed_at,
                ps.last_synced_at,
                ps.updated_at,
                p.id,
                p.provider,
                p.provider_podcast_id,
                p.title,
                p.author,
                p.feed_url,
                p.website_url,
                p.image_url,
                p.description,
                p.created_at,
                p.updated_at
            FROM podcast_subscriptions ps
            JOIN podcasts p ON p.id = ps.podcast_id
            WHERE ps.user_id = :user_id
              AND ps.status = 'active'
            ORDER BY ps.updated_at DESC, ps.podcast_id DESC
            LIMIT :limit
            """
        ),
        {"user_id": viewer_id, "limit": limit},
    ).fetchall()
    out: list[PodcastSubscriptionListItemOut] = []
    for row in rows:
        podcast = _podcast_list_item_from_row(row[11:])
        out.append(
            PodcastSubscriptionListItemOut(
                podcast_id=row[0],
                status=row[1],
                unsubscribe_mode=row[2],
                sync_status=row[3],
                sync_error_code=row[4],
                sync_error_message=row[5],
                sync_attempts=row[6],
                sync_started_at=row[7],
                sync_completed_at=row[8],
                last_synced_at=row[9],
                updated_at=row[10],
                podcast=podcast,
            )
        )
    return out


def get_podcast_detail_for_viewer(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
) -> PodcastDetailOut:
    row = db.execute(
        text(
            """
            SELECT
                ps.user_id,
                ps.podcast_id,
                ps.status,
                ps.unsubscribe_mode,
                ps.sync_status,
                ps.sync_error_code,
                ps.sync_error_message,
                ps.sync_attempts,
                ps.sync_started_at,
                ps.sync_completed_at,
                ps.last_synced_at,
                ps.updated_at,
                p.id,
                p.provider,
                p.provider_podcast_id,
                p.title,
                p.author,
                p.feed_url,
                p.website_url,
                p.image_url,
                p.description,
                p.created_at,
                p.updated_at
            FROM podcast_subscriptions ps
            JOIN podcasts p ON p.id = ps.podcast_id
            WHERE ps.user_id = :user_id
              AND ps.podcast_id = :podcast_id
              AND ps.status = 'active'
            """
        ),
        {"user_id": viewer_id, "podcast_id": podcast_id},
    ).fetchone()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast subscription not found")

    subscription = PodcastSubscriptionStatusOut(
        user_id=row[0],
        podcast_id=row[1],
        status=row[2],
        unsubscribe_mode=row[3],
        sync_status=row[4],
        sync_error_code=row[5],
        sync_error_message=row[6],
        sync_attempts=row[7],
        sync_started_at=row[8],
        sync_completed_at=row[9],
        last_synced_at=row[10],
        updated_at=row[11],
    )
    podcast = _podcast_list_item_from_row(row[12:])
    return PodcastDetailOut(podcast=podcast, subscription=subscription)


def list_podcast_episodes_for_viewer(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
    *,
    limit: int = 50,
) -> list[MediaOut]:
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")
    limit = min(limit, 200)
    detail = get_podcast_detail_for_viewer(db, viewer_id, podcast_id)
    if detail.subscription.status != "active":
        return []

    episode_rows = db.execute(
        text(
            f"""
            WITH visible_media AS (
                {visible_media_ids_cte_sql()}
            )
            SELECT pe.media_id
            FROM podcast_episodes pe
            JOIN visible_media vm ON vm.media_id = pe.media_id
            WHERE pe.podcast_id = :podcast_id
            ORDER BY pe.published_at DESC NULLS LAST, pe.media_id DESC
            LIMIT :limit
            """
        ),
        {
            "viewer_id": viewer_id,
            "podcast_id": podcast_id,
            "limit": limit,
        },
    ).fetchall()

    from nexus.services import media as media_service

    return [
        media_service.get_media_for_viewer(db, viewer_id, row[0])
        for row in episode_rows
        if row and row[0] is not None
    ]


def request_podcast_transcript_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    reason: str,
    dry_run: bool = False,
) -> dict[str, Any]:
    from nexus.auth.permissions import can_read_media

    normalized_reason = str(reason or "").strip()
    if normalized_reason not in PODCAST_TRANSCRIPT_REQUEST_REASONS:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Invalid transcript request reason",
        )

    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    now = datetime.now(UTC)
    usage_date = now.date()
    media_row = db.execute(
        text(
            """
            SELECT
                m.kind,
                m.processing_status,
                (
                    SELECT pe.duration_seconds
                    FROM podcast_episodes pe
                    WHERE pe.media_id = m.id
                ) AS duration_seconds,
                (
                    SELECT j.status
                    FROM podcast_transcription_jobs j
                    WHERE j.media_id = m.id
                ) AS job_status
            FROM media m
            WHERE m.id = :media_id
            FOR UPDATE
            """
        ),
        {"media_id": media_id},
    ).fetchone()
    if media_row is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    media_kind = str(media_row[0] or "")
    processing_status = str(media_row[1] or "")
    duration_seconds = _coerce_positive_int(media_row[2])
    job_status = str(media_row[3] or "").strip() or None

    if media_kind != "podcast_episode":
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Transcript request is only supported for podcast episodes.",
        )

    required_minutes = _episode_minutes({"duration_seconds": duration_seconds})
    plan = _get_effective_plan(db, viewer_id)
    daily_limit_minutes = plan["daily_transcription_minutes"]
    used_minutes = _get_usage_minutes(db, viewer_id=viewer_id, usage_date=usage_date)
    remaining_minutes = (
        None
        if daily_limit_minutes is None
        else max(0, int(daily_limit_minutes) - int(used_minutes))
    )
    fits_budget = remaining_minutes is None or required_minutes <= remaining_minutes

    # Already queued/running/readable: idempotent no-op forecast.
    if processing_status in {
        "extracting",
        "ready_for_reading",
        "embedding",
        "ready",
    } or job_status in {"pending", "running"}:
        effective_status = (
            "extracting"
            if processing_status == "pending" and job_status in {"pending", "running"}
            else processing_status
        )
        return {
            "media_id": str(media_id),
            "processing_status": effective_status,
            "request_reason": normalized_reason,
            "required_minutes": required_minutes,
            "remaining_minutes": remaining_minutes,
            "fits_budget": True,
            "request_enqueued": False,
        }

    if dry_run:
        return {
            "media_id": str(media_id),
            "processing_status": processing_status,
            "request_reason": normalized_reason,
            "required_minutes": required_minutes,
            "remaining_minutes": remaining_minutes,
            "fits_budget": fits_budget,
            "request_enqueued": False,
        }

    if not fits_budget:
        raise ApiError(
            ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED,
            "Daily podcast transcription quota exceeded",
        )

    minutes_used_after = _reserve_usage_minutes_or_raise(
        db,
        user_id=viewer_id,
        usage_date=usage_date,
        required_minutes=required_minutes,
        daily_limit_minutes=daily_limit_minutes,
        now=now,
    )
    remaining_minutes_after = (
        None
        if daily_limit_minutes is None
        else max(0, int(daily_limit_minutes) - int(minutes_used_after))
    )

    db.execute(
        text(
            """
            INSERT INTO podcast_transcription_jobs (
                media_id,
                requested_by_user_id,
                request_reason,
                status,
                error_code,
                attempts,
                started_at,
                completed_at,
                created_at,
                updated_at
            )
            VALUES (
                :media_id,
                :requested_by_user_id,
                :request_reason,
                'pending',
                NULL,
                0,
                NULL,
                NULL,
                :created_at,
                :updated_at
            )
            ON CONFLICT (media_id)
            DO UPDATE SET
                requested_by_user_id = EXCLUDED.requested_by_user_id,
                request_reason = EXCLUDED.request_reason,
                status = 'pending',
                error_code = NULL,
                started_at = NULL,
                completed_at = NULL,
                updated_at = EXCLUDED.updated_at
            """
        ),
        {
            "media_id": media_id,
            "requested_by_user_id": viewer_id,
            "request_reason": normalized_reason,
            "created_at": now,
            "updated_at": now,
        },
    )

    db.execute(
        text(
            """
            UPDATE media
            SET
                processing_status = 'extracting',
                failure_stage = NULL,
                last_error_code = NULL,
                last_error_message = NULL,
                processing_started_at = :now,
                processing_completed_at = NULL,
                failed_at = NULL,
                updated_at = :now
            WHERE id = :media_id
            """
        ),
        {
            "media_id": media_id,
            "now": now,
        },
    )

    enqueued = _enqueue_podcast_transcription_job(
        media_id=media_id,
        requested_by_user_id=viewer_id,
    )
    if not enqueued:
        _refund_usage_minutes(
            db,
            user_id=viewer_id,
            usage_date=usage_date,
            refund_minutes=required_minutes,
            now=now,
        )
        _mark_podcast_transcription_failure(
            db,
            media_id=media_id,
            error_code=ApiErrorCode.E_INTERNAL.value,
            error_message="Failed to enqueue podcast transcription job",
            now=now,
        )
        db.commit()
        return {
            "media_id": str(media_id),
            "processing_status": "failed",
            "request_reason": normalized_reason,
            "required_minutes": required_minutes,
            "remaining_minutes": remaining_minutes,
            "fits_budget": True,
            "request_enqueued": False,
        }

    db.commit()
    return {
        "media_id": str(media_id),
        "processing_status": "extracting",
        "request_reason": normalized_reason,
        "required_minutes": required_minutes,
        "remaining_minutes": remaining_minutes_after,
        "fits_budget": True,
        "request_enqueued": True,
    }


def retry_transcript_media_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    request_id: str | None = None,
) -> dict[str, Any]:
    from nexus.auth.permissions import can_read_media

    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    media_row = db.execute(
        text(
            """
            SELECT kind, created_by_user_id, processing_status, failure_stage
            FROM media
            WHERE id = :media_id
            FOR UPDATE
            """
        ),
        {"media_id": media_id},
    ).fetchone()
    if media_row is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    kind = str(media_row[0] or "")
    created_by_user_id = media_row[1]
    processing_status = str(media_row[2] or "")
    failure_stage = str(media_row[3] or "").strip() or None

    if kind not in {"podcast_episode", "video"}:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Retry is only supported for PDF/EPUB/podcast/video media.",
        )
    if created_by_user_id != viewer_id:
        raise ForbiddenError(
            ApiErrorCode.E_FORBIDDEN,
            "Only the creator can retry transcription.",
        )

    if processing_status == "extracting":
        return {
            "media_id": str(media_id),
            "processing_status": "extracting",
            "retry_enqueued": False,
        }

    if processing_status != "failed":
        raise ConflictError(
            ApiErrorCode.E_RETRY_INVALID_STATE,
            "Media must be in failed state to retry.",
        )
    if failure_stage not in {None, "transcribe"}:
        raise ConflictError(
            ApiErrorCode.E_RETRY_NOT_ALLOWED,
            "Retry not allowed for this failure stage.",
        )

    now = datetime.now(UTC)
    db.execute(
        text(
            """
            UPDATE media
            SET
                processing_status = 'extracting',
                failure_stage = NULL,
                last_error_code = NULL,
                last_error_message = NULL,
                processing_started_at = :now,
                processing_completed_at = NULL,
                failed_at = NULL,
                updated_at = :now
            WHERE id = :media_id
            """
        ),
        {
            "media_id": media_id,
            "now": now,
        },
    )

    if kind == "podcast_episode":
        db.execute(
            text(
                """
                INSERT INTO podcast_transcription_jobs (
                    media_id,
                    requested_by_user_id,
                    request_reason,
                    status,
                    error_code,
                    attempts,
                    started_at,
                    completed_at,
                    created_at,
                    updated_at
                )
                VALUES (
                    :media_id,
                    :requested_by_user_id,
                    :request_reason,
                    'pending',
                    NULL,
                    0,
                    NULL,
                    NULL,
                    :created_at,
                    :updated_at
                )
                ON CONFLICT (media_id)
                DO UPDATE SET
                    requested_by_user_id = EXCLUDED.requested_by_user_id,
                    request_reason = EXCLUDED.request_reason,
                    status = 'pending',
                    error_code = NULL,
                    started_at = NULL,
                    completed_at = NULL,
                    updated_at = EXCLUDED.updated_at
                """
            ),
            {
                "media_id": media_id,
                "requested_by_user_id": viewer_id,
                "request_reason": "operator_requeue",
                "created_at": now,
                "updated_at": now,
            },
        )
        enqueued = _enqueue_podcast_transcription_job(
            media_id=media_id,
            requested_by_user_id=viewer_id,
        )
        if not enqueued:
            _mark_podcast_transcription_failure(
                db,
                media_id=media_id,
                error_code=ApiErrorCode.E_INTERNAL.value,
                error_message="Failed to enqueue podcast transcription job",
                now=now,
            )
            db.commit()
            return {
                "media_id": str(media_id),
                "processing_status": "failed",
                "retry_enqueued": False,
            }
        db.commit()
        return {
            "media_id": str(media_id),
            "processing_status": "extracting",
            "retry_enqueued": True,
        }

    enqueued = _enqueue_video_transcription_retry(
        media_id=media_id,
        requested_by_user_id=viewer_id,
        request_id=request_id,
    )
    if not enqueued:
        db.execute(
            text(
                """
                UPDATE media
                SET
                    processing_status = 'failed',
                    failure_stage = 'transcribe',
                    last_error_code = :error_code,
                    last_error_message = :error_message,
                    failed_at = :now,
                    updated_at = :now
                WHERE id = :media_id
                """
            ),
            {
                "media_id": media_id,
                "error_code": ApiErrorCode.E_INTERNAL.value,
                "error_message": "Failed to enqueue video transcription job",
                "now": now,
            },
        )
        db.commit()
        return {
            "media_id": str(media_id),
            "processing_status": "failed",
            "retry_enqueued": False,
        }

    db.commit()
    return {
        "media_id": str(media_id),
        "processing_status": "extracting",
        "retry_enqueued": True,
    }


def unsubscribe_from_podcast(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
    *,
    mode: int = 1,
) -> PodcastSubscriptionStatusOut:
    if mode not in PODCAST_UNSUBSCRIBE_MODES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Unsubscribe mode must be one of: 1, 2, 3",
        )

    now = datetime.now(UTC)
    with transaction(db):
        subscription_exists = db.execute(
            text(
                """
                SELECT 1
                FROM podcast_subscriptions
                WHERE user_id = :user_id AND podcast_id = :podcast_id
                FOR UPDATE
                """
            ),
            {"user_id": viewer_id, "podcast_id": podcast_id},
        ).fetchone()
        if subscription_exists is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast subscription not found")

        db.execute(
            text(
                """
                UPDATE podcast_subscriptions
                SET
                    status = 'unsubscribed',
                    unsubscribe_mode = :mode,
                    updated_at = :updated_at
                WHERE user_id = :user_id AND podcast_id = :podcast_id
                """
            ),
            {
                "user_id": viewer_id,
                "podcast_id": podcast_id,
                "mode": mode,
                "updated_at": now,
            },
        )

        media_ids = [
            row[0]
            for row in db.execute(
                text(
                    """
                    SELECT media_id
                    FROM podcast_episodes
                    WHERE podcast_id = :podcast_id
                    """
                ),
                {"podcast_id": podcast_id},
            ).fetchall()
        ]

        if media_ids and mode >= 2:
            _remove_subscription_episodes_from_default_library(
                db=db,
                user_id=viewer_id,
                media_ids=media_ids,
            )
        if media_ids and mode == 3:
            _remove_subscription_episodes_from_single_member_libraries(
                db=db,
                user_id=viewer_id,
                media_ids=media_ids,
            )

    return get_subscription_status(db, viewer_id, podcast_id)


def _remove_subscription_episodes_from_default_library(
    *,
    db: Session,
    user_id: UUID,
    media_ids: list[UUID],
) -> None:
    from nexus.services.default_library_closure import remove_default_intrinsic_and_gc

    default_library_id = db.execute(
        text(
            """
            SELECT id
            FROM libraries
            WHERE owner_user_id = :user_id AND is_default = true
            """
        ),
        {"user_id": user_id},
    ).scalar()
    if default_library_id is None:
        return

    for media_id in media_ids:
        remove_default_intrinsic_and_gc(db, default_library_id, media_id)


def _remove_subscription_episodes_from_single_member_libraries(
    *,
    db: Session,
    user_id: UUID,
    media_ids: list[UUID],
) -> None:
    from nexus.services.default_library_closure import remove_media_from_non_default_closure

    library_rows = db.execute(
        text(
            """
            SELECT l.id
            FROM libraries l
            WHERE l.owner_user_id = :user_id
              AND l.is_default = false
              AND (
                  SELECT COUNT(*)
                  FROM memberships m
                  WHERE m.library_id = l.id
              ) = 1
            """
        ),
        {"user_id": user_id},
    ).fetchall()

    single_member_library_ids = [row[0] for row in library_rows]
    if not single_member_library_ids:
        return

    for library_id in single_member_library_ids:
        for media_id in media_ids:
            membership_row = db.execute(
                text(
                    """
                    SELECT 1
                    FROM library_media
                    WHERE library_id = :library_id AND media_id = :media_id
                    """
                ),
                {"library_id": library_id, "media_id": media_id},
            ).fetchone()
            if membership_row is None:
                continue

            db.execute(
                text(
                    """
                    DELETE FROM library_media
                    WHERE library_id = :library_id AND media_id = :media_id
                    """
                ),
                {"library_id": library_id, "media_id": media_id},
            )
            remove_media_from_non_default_closure(db, library_id, media_id)


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
        plan = _get_effective_plan(db, user_id)
        window_size = plan["initial_episode_window"]
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
                plan=plan,
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
    plan: dict[str, Any],
    now: datetime,
) -> tuple[int, int]:
    ingested_episode_count = 0
    reused_episode_count = 0

    new_episodes: list[dict[str, Any]] = []
    for episode in selected_episodes:
        guid = _normalize_guid(episode.get("guid"))
        fallback_identity = _compute_fallback_identity(podcast_id, episode)
        existing_media_id = _find_existing_episode_media_id(
            db,
            podcast_id=podcast_id,
            guid=guid,
            fallback_identity=fallback_identity,
        )
        if existing_media_id is not None:
            _ensure_in_default_library(db, viewer_id, existing_media_id)
            reused_episode_count += 1
            continue
        new_episodes.append(
            {
                "episode": episode,
                "guid": guid,
                "fallback_identity": fallback_identity,
            }
        )

    for row in new_episodes:
        episode = row["episode"]
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
                "created_by_user_id": viewer_id,
                "created_at": now,
                "updated_at": now,
            },
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
                    :created_at
                )
                """
            ),
            {
                "media_id": media_id,
                "podcast_id": podcast_id,
                "provider_episode_id": str(episode.get("provider_episode_id") or ""),
                "guid": row["guid"],
                "fallback_identity": row["fallback_identity"],
                "published_at": _parse_iso_datetime(episode.get("published_at")),
                "duration_seconds": _coerce_positive_int(episode.get("duration_seconds")),
                "created_at": now,
            },
        )

        _ensure_in_default_library(db, viewer_id, media_id)
        ingested_episode_count += 1

    return ingested_episode_count, reused_episode_count


def update_user_plan(
    db: Session,
    target_user_id: UUID,
    body: PodcastPlanUpdateRequest,
) -> PodcastPlanOut:
    settings = get_settings()
    defaults = _plan_defaults(settings, body.plan_tier)
    now = datetime.now(UTC)

    daily_minutes = (
        body.daily_transcription_minutes
        if body.daily_transcription_minutes is not None
        else defaults["daily_transcription_minutes"]
    )

    row = db.execute(
        text(
            """
            INSERT INTO podcast_user_plans (
                user_id,
                plan_tier,
                daily_transcription_minutes,
                initial_episode_window,
                updated_at
            )
            VALUES (
                :user_id,
                :plan_tier,
                :daily_transcription_minutes,
                :initial_episode_window,
                :updated_at
            )
            ON CONFLICT (user_id)
            DO UPDATE SET
                plan_tier = EXCLUDED.plan_tier,
                daily_transcription_minutes = EXCLUDED.daily_transcription_minutes,
                initial_episode_window = EXCLUDED.initial_episode_window,
                updated_at = EXCLUDED.updated_at
            RETURNING user_id, plan_tier, daily_transcription_minutes, initial_episode_window, updated_at
            """
        ),
        {
            "user_id": target_user_id,
            "plan_tier": body.plan_tier,
            "daily_transcription_minutes": daily_minutes,
            "initial_episode_window": body.initial_episode_window,
            "updated_at": now,
        },
    ).fetchone()
    db.commit()

    return PodcastPlanOut(
        user_id=row[0],
        plan_tier=row[1],
        daily_transcription_minutes=row[2],
        initial_episode_window=row[3],
        updated_at=row[4],
    )


def _enqueue_podcast_subscription_sync(*, user_id: UUID, podcast_id: UUID) -> bool:
    try:
        from nexus.tasks.podcast_sync_subscription import podcast_sync_subscription_job

        podcast_sync_subscription_job.apply_async(
            args=[str(user_id), str(podcast_id)],
            kwargs={},
            queue="ingest",
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


def _enqueue_podcast_transcription_job(
    *, media_id: UUID, requested_by_user_id: UUID | None
) -> bool:
    try:
        from nexus.tasks.podcast_transcribe_episode import podcast_transcribe_episode_job

        podcast_transcribe_episode_job.apply_async(
            args=[str(media_id), str(requested_by_user_id) if requested_by_user_id else None],
            kwargs={},
            queue="ingest",
        )
        return True
    except Exception as exc:
        logger.warning(
            "podcast_transcription_enqueue_failed",
            media_id=str(media_id),
            requested_by_user_id=(str(requested_by_user_id) if requested_by_user_id else None),
            error=str(exc),
        )
        return False


def _enqueue_video_transcription_retry(
    *,
    media_id: UUID,
    requested_by_user_id: UUID,
    request_id: str | None,
) -> bool:
    try:
        from nexus.tasks.ingest_youtube_video import ingest_youtube_video

        ingest_youtube_video.apply_async(
            args=[str(media_id), str(requested_by_user_id)],
            kwargs={"request_id": request_id},
            queue="ingest",
        )
        return True
    except Exception as exc:
        logger.warning(
            "video_transcription_retry_enqueue_failed",
            media_id=str(media_id),
            requested_by_user_id=str(requested_by_user_id),
            request_id=request_id,
            error=str(exc),
        )
        return False


def _mark_podcast_transcription_failure(
    db: Session,
    *,
    media_id: UUID,
    error_code: str,
    error_message: str,
    now: datetime,
) -> None:
    db.execute(
        text(
            """
            UPDATE media
            SET
                processing_status = 'failed',
                failure_stage = 'transcribe',
                last_error_code = :error_code,
                last_error_message = :error_message,
                processing_completed_at = NULL,
                failed_at = :now,
                updated_at = :now
            WHERE id = :media_id
            """
        ),
        {
            "media_id": media_id,
            "error_code": error_code,
            "error_message": error_message[:1000],
            "now": now,
        },
    )
    db.execute(
        text(
            """
            UPDATE podcast_transcription_jobs
            SET
                status = 'failed',
                error_code = :error_code,
                completed_at = :now,
                updated_at = :now
            WHERE media_id = :media_id
            """
        ),
        {
            "media_id": media_id,
            "error_code": error_code,
            "now": now,
        },
    )


def run_podcast_transcription_now(
    db: Session,
    *,
    media_id: UUID,
    requested_by_user_id: UUID | None,
    request_id: str | None = None,
) -> dict[str, Any]:
    _ = request_id
    claim_now = datetime.now(UTC)
    claimed = db.execute(
        text(
            """
            UPDATE podcast_transcription_jobs
            SET
                status = 'running',
                error_code = NULL,
                attempts = attempts + 1,
                started_at = :now,
                completed_at = NULL,
                updated_at = :now
            WHERE media_id = :media_id
              AND status IN ('pending', 'failed')
            RETURNING 1
            """
        ),
        {
            "media_id": media_id,
            "now": claim_now,
        },
    ).fetchone()

    if claimed is None:
        snapshot = db.execute(
            text(
                """
                SELECT status, error_code
                FROM podcast_transcription_jobs
                WHERE media_id = :media_id
                """
            ),
            {"media_id": media_id},
        ).fetchone()
        if snapshot is None:
            return {"status": "skipped", "reason": "job_not_found"}
        return {
            "status": "skipped",
            "reason": "not_pending",
            "job_status": str(snapshot[0]),
            "error_code": snapshot[1],
        }

    db.commit()

    media_row = db.execute(
        text(
            """
            SELECT kind, external_playback_url
            FROM media
            WHERE id = :media_id
            """
        ),
        {"media_id": media_id},
    ).fetchone()
    if media_row is None:
        db.execute(
            text(
                """
                UPDATE podcast_transcription_jobs
                SET status = 'failed', error_code = :error_code, completed_at = :now, updated_at = :now
                WHERE media_id = :media_id
                """
            ),
            {
                "media_id": media_id,
                "error_code": ApiErrorCode.E_MEDIA_NOT_FOUND.value,
                "now": claim_now,
            },
        )
        db.commit()
        return {"status": "failed", "error_code": ApiErrorCode.E_MEDIA_NOT_FOUND.value}

    if str(media_row[0]) != "podcast_episode":
        db.execute(
            text(
                """
                UPDATE podcast_transcription_jobs
                SET status = 'failed', error_code = :error_code, completed_at = :now, updated_at = :now
                WHERE media_id = :media_id
                """
            ),
            {
                "media_id": media_id,
                "error_code": ApiErrorCode.E_INVALID_KIND.value,
                "now": claim_now,
            },
        )
        db.commit()
        return {"status": "failed", "error_code": ApiErrorCode.E_INVALID_KIND.value}

    db.execute(
        text(
            """
            UPDATE media
            SET
                processing_status = 'extracting',
                failure_stage = NULL,
                last_error_code = NULL,
                last_error_message = NULL,
                processing_started_at = :now,
                processing_completed_at = NULL,
                failed_at = NULL,
                updated_at = :now
            WHERE id = :media_id
            """
        ),
        {
            "media_id": media_id,
            "now": claim_now,
        },
    )
    db.commit()

    audio_url = str(media_row[1] or "").strip() or None
    try:
        transcription_result = _transcribe_podcast_audio(audio_url)
    except Exception as exc:
        now = datetime.now(UTC)
        logger.exception(
            "podcast_transcription_unhandled_error",
            media_id=str(media_id),
            error=str(exc),
        )
        _mark_podcast_transcription_failure(
            db,
            media_id=media_id,
            error_code=ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
            error_message="Transcription failed",
            now=now,
        )
        db.commit()
        return {"status": "failed", "error_code": ApiErrorCode.E_TRANSCRIPTION_FAILED.value}
    transcription_status = str(transcription_result.get("status") or "failed")
    transcript_segments = _normalize_transcript_segments(transcription_result.get("segments"))
    transcription_error_code = _normalize_terminal_transcription_error_code(
        transcription_result.get("error_code")
    )
    transcription_error_message = str(transcription_result.get("error_message") or "").strip()
    diagnostic_error_code = _normalize_diagnostic_transcription_error_code(
        transcription_result.get("diagnostic_error_code")
    )
    now = datetime.now(UTC)

    if transcription_status == "completed" and not transcript_segments:
        transcription_status = "failed"
        transcription_error_code = ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value
        transcription_error_message = "Transcript unavailable"
        diagnostic_error_code = None

    if transcription_status == "completed" and transcript_segments:
        db.execute(text("DELETE FROM fragments WHERE media_id = :media_id"), {"media_id": media_id})
        _insert_transcript_fragments(db, media_id, transcript_segments, now=now)
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
            {
                "media_id": media_id,
                "now": now,
            },
        )
        db.execute(
            text(
                """
                UPDATE podcast_transcription_jobs
                SET
                    status = 'completed',
                    error_code = :error_code,
                    completed_at = :now,
                    updated_at = :now
                WHERE media_id = :media_id
                """
            ),
            {
                "media_id": media_id,
                "error_code": diagnostic_error_code,
                "now": now,
            },
        )
        db.commit()
        return {"status": "completed", "segment_count": len(transcript_segments)}

    terminal_error_code = transcription_error_code or ApiErrorCode.E_TRANSCRIPTION_FAILED.value
    terminal_error_message = transcription_error_message or "Transcription failed"
    _mark_podcast_transcription_failure(
        db,
        media_id=media_id,
        error_code=terminal_error_code,
        error_message=terminal_error_message,
        now=now,
    )
    db.commit()
    return {"status": "failed", "error_code": terminal_error_code}


def _get_subscription_sync_snapshot(
    db: Session,
    user_id: UUID,
    podcast_id: UUID,
) -> dict[str, Any] | None:
    row = db.execute(
        text(
            """
            SELECT sync_status, sync_error_code, sync_error_message, sync_attempts, last_synced_at
            FROM podcast_subscriptions
            WHERE user_id = :user_id AND podcast_id = :podcast_id
            """
        ),
        {"user_id": user_id, "podcast_id": podcast_id},
    ).fetchone()
    if row is None:
        return None
    return {
        "sync_status": row[0],
        "sync_error_code": row[1],
        "sync_error_message": row[2],
        "sync_attempts": int(row[3] or 0),
        "last_synced_at": row[4],
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
            SELECT id, provider_podcast_id, feed_url
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
    }


def _upsert_podcast(db: Session, body: PodcastSubscribeRequest, *, now: datetime) -> UUID:
    row = db.execute(
        text(
            """
            INSERT INTO podcasts (
                provider,
                provider_podcast_id,
                title,
                author,
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
                :author,
                :feed_url,
                :website_url,
                :image_url,
                :description,
                :created_at,
                :updated_at
            )
            ON CONFLICT (provider, provider_podcast_id)
            DO UPDATE SET
                title = EXCLUDED.title,
                author = EXCLUDED.author,
                feed_url = EXCLUDED.feed_url,
                website_url = EXCLUDED.website_url,
                image_url = EXCLUDED.image_url,
                description = EXCLUDED.description,
                updated_at = EXCLUDED.updated_at
            RETURNING id
            """
        ),
        {
            "provider": PODCAST_PROVIDER,
            "provider_podcast_id": body.provider_podcast_id,
            "title": body.title,
            "author": body.author,
            "feed_url": body.feed_url,
            "website_url": body.website_url,
            "image_url": body.image_url,
            "description": body.description,
            "created_at": now,
            "updated_at": now,
        },
    ).fetchone()
    return row[0]


def _upsert_subscription(db: Session, user_id: UUID, podcast_id: UUID, *, now: datetime) -> bool:
    existing = db.execute(
        text(
            """
            SELECT 1 FROM podcast_subscriptions
            WHERE user_id = :user_id AND podcast_id = :podcast_id
            """
        ),
        {"user_id": user_id, "podcast_id": podcast_id},
    ).fetchone()

    db.execute(
        text(
            """
            INSERT INTO podcast_subscriptions (
                user_id,
                podcast_id,
                status,
                unsubscribe_mode,
                sync_status,
                created_at,
                updated_at
            )
            VALUES (
                :user_id,
                :podcast_id,
                'active',
                1,
                'pending',
                :created_at,
                :updated_at
            )
            ON CONFLICT (user_id, podcast_id)
            DO UPDATE SET
                status = 'active',
                unsubscribe_mode = 1,
                sync_status = 'pending',
                sync_error_code = NULL,
                sync_error_message = NULL,
                sync_started_at = NULL,
                sync_completed_at = NULL,
                updated_at = EXCLUDED.updated_at
            """
        ),
        {
            "user_id": user_id,
            "podcast_id": podcast_id,
            "created_at": now,
            "updated_at": now,
        },
    )
    return existing is None


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


def _insert_transcript_fragments(
    db: Session,
    media_id: UUID,
    transcript_segments: list[dict[str, Any]],
    *,
    now: datetime,
) -> None:
    _shared_insert_transcript_fragments(db, media_id, transcript_segments, now=now)


def _get_effective_plan(db: Session, user_id: UUID) -> dict[str, Any]:
    row = db.execute(
        text(
            """
            SELECT plan_tier, daily_transcription_minutes, initial_episode_window
            FROM podcast_user_plans
            WHERE user_id = :user_id
            """
        ),
        {"user_id": user_id},
    ).fetchone()
    if row is not None:
        return {
            "plan_tier": row[0],
            "daily_transcription_minutes": row[1],
            "initial_episode_window": row[2],
        }

    settings = get_settings()
    defaults = _plan_defaults(settings, "free")
    return {
        "plan_tier": "free",
        "daily_transcription_minutes": defaults["daily_transcription_minutes"],
        "initial_episode_window": defaults["initial_episode_window"],
    }


def _plan_defaults(settings, plan_tier: str) -> dict[str, Any]:
    if plan_tier == "paid":
        return {
            "daily_transcription_minutes": settings.podcast_paid_daily_transcription_minutes,
            "initial_episode_window": settings.podcast_paid_initial_episode_window,
        }
    return {
        "daily_transcription_minutes": settings.podcast_free_daily_transcription_minutes,
        "initial_episode_window": settings.podcast_free_initial_episode_window,
    }


def _get_usage_minutes(
    db: Session,
    *,
    viewer_id: UUID,
    usage_date: date,
) -> int:
    used_minutes = db.execute(
        text(
            """
            SELECT minutes_used
            FROM podcast_transcription_usage_daily
            WHERE user_id = :user_id AND usage_date = :usage_date
            """
        ),
        {"user_id": viewer_id, "usage_date": usage_date},
    ).scalar()
    return int(used_minutes or 0)


def _reserve_usage_minutes_or_raise(
    db: Session,
    *,
    user_id: UUID,
    usage_date: date,
    required_minutes: int,
    daily_limit_minutes: int | None,
    now: datetime,
) -> int:
    if required_minutes <= 0:
        return _get_usage_minutes(db, viewer_id=user_id, usage_date=usage_date)

    if daily_limit_minutes is None:
        row = db.execute(
            text(
                """
                INSERT INTO podcast_transcription_usage_daily (
                    user_id,
                    usage_date,
                    minutes_used,
                    updated_at
                )
                VALUES (
                    :user_id,
                    :usage_date,
                    :minutes_used,
                    :updated_at
                )
                ON CONFLICT (user_id, usage_date)
                DO UPDATE SET
                    minutes_used = podcast_transcription_usage_daily.minutes_used + EXCLUDED.minutes_used,
                    updated_at = EXCLUDED.updated_at
                RETURNING minutes_used
                """
            ),
            {
                "user_id": user_id,
                "usage_date": usage_date,
                "minutes_used": required_minutes,
                "updated_at": now,
            },
        ).fetchone()
    else:
        row = db.execute(
            text(
                """
                INSERT INTO podcast_transcription_usage_daily (
                    user_id,
                    usage_date,
                    minutes_used,
                    updated_at
                )
                SELECT
                    :user_id,
                    :usage_date,
                    :minutes_used,
                    :updated_at
                WHERE :minutes_used <= :daily_limit_minutes
                ON CONFLICT (user_id, usage_date)
                DO UPDATE SET
                    minutes_used = podcast_transcription_usage_daily.minutes_used + EXCLUDED.minutes_used,
                    updated_at = EXCLUDED.updated_at
                WHERE (
                    podcast_transcription_usage_daily.minutes_used + EXCLUDED.minutes_used
                    <= :daily_limit_minutes
                )
                RETURNING minutes_used
                """
            ),
            {
                "user_id": user_id,
                "usage_date": usage_date,
                "minutes_used": required_minutes,
                "daily_limit_minutes": daily_limit_minutes,
                "updated_at": now,
            },
        ).fetchone()

    if row is None:
        used_minutes = _get_usage_minutes(db, viewer_id=user_id, usage_date=usage_date)
        logger.warning(
            "podcast_quota_exceeded",
            viewer_id=str(user_id),
            usage_date=usage_date.isoformat(),
            used_minutes=used_minutes,
            required_minutes=required_minutes,
            daily_limit_minutes=daily_limit_minutes,
        )
        raise ApiError(
            ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED,
            "Daily podcast transcription quota exceeded",
        )
    return int(row[0] or 0)


def _refund_usage_minutes(
    db: Session,
    *,
    user_id: UUID,
    usage_date: date,
    refund_minutes: int,
    now: datetime,
) -> None:
    if refund_minutes <= 0:
        return
    db.execute(
        text(
            """
            UPDATE podcast_transcription_usage_daily
            SET
                minutes_used = GREATEST(minutes_used - :refund_minutes, 0),
                updated_at = :updated_at
            WHERE user_id = :user_id
              AND usage_date = :usage_date
            """
        ),
        {
            "user_id": user_id,
            "usage_date": usage_date,
            "refund_minutes": refund_minutes,
            "updated_at": now,
        },
    )


def _episode_minutes(episode: dict[str, Any]) -> int:
    seconds = _coerce_positive_int(episode.get("duration_seconds"))
    if seconds is None:
        return 1
    return max(1, (seconds + 59) // 60)


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
    seen = {_episode_dedupe_key(episode) for episode in combined}
    for episode in supplemental:
        dedupe_key = _episode_dedupe_key(episode)
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        combined.append(episode)
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


def _validate_and_normalize_feed_url(feed_url: str) -> str:
    validate_requested_url(feed_url)
    return normalize_url_for_display(feed_url)


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

    episodes: list[dict[str, Any]] = []
    for item in item_nodes:
        episode = _episode_from_feed_item(item)
        if episode is not None:
            episodes.append(episode)

    next_page_url = _extract_feed_next_page_url(root, str(response.url))
    return episodes, next_page_url


def _episode_from_feed_item(item: Any) -> dict[str, Any] | None:
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

    provider_episode_id = guid or audio_url
    if not provider_episode_id:
        seed = f"{title}|{published_at or ''}"
        provider_episode_id = f"feed-{hashlib.sha1(seed.encode()).hexdigest()}"

    return {
        "provider_episode_id": provider_episode_id,
        "guid": guid,
        "title": title,
        "audio_url": audio_url,
        "published_at": published_at,
        "duration_seconds": duration_seconds,
        "transcript_segments": None,
    }


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


def _normalize_guid(value: Any) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


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


def _normalize_terminal_transcription_error_code(raw_value: Any) -> str | None:
    if raw_value is None:
        return None
    value = str(raw_value).strip()
    if not value:
        return None
    allowed = {
        ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
        ApiErrorCode.E_TRANSCRIPTION_TIMEOUT.value,
        ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value,
    }
    if value in allowed:
        return value
    return ApiErrorCode.E_TRANSCRIPTION_FAILED.value


def _normalize_diagnostic_transcription_error_code(raw_value: Any) -> str | None:
    if raw_value is None:
        return None
    value = str(raw_value).strip()
    if not value:
        return None
    if value == ApiErrorCode.E_DIARIZATION_FAILED.value:
        return value
    return None


def _transcription_failure_result(error_code: str, error_message: str) -> dict[str, Any]:
    return {
        "status": "failed",
        "error_code": error_code,
        "error_message": error_message,
    }


def _transcribe_podcast_audio(audio_url: str | None) -> dict[str, Any]:
    normalized_audio_url = str(audio_url or "").strip()
    if not normalized_audio_url:
        return _transcription_failure_result(
            ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value,
            "Transcript unavailable",
        )

    try:
        validate_requested_url(normalized_audio_url)
    except InvalidRequestError:
        return _transcription_failure_result(
            ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value,
            "Transcript unavailable",
        )

    settings = get_settings()
    if not settings.deepgram_api_key:
        return _transcription_failure_result(
            ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
            "Transcription provider credentials are not configured",
        )

    diarized_result = _transcribe_with_deepgram(normalized_audio_url, diarize=True)
    if diarized_result.get("status") == "completed":
        diarized_result["diagnostic_error_code"] = None
        return diarized_result

    fallback_result = _transcribe_with_deepgram(normalized_audio_url, diarize=False)
    if fallback_result.get("status") == "completed":
        fallback_result["diagnostic_error_code"] = ApiErrorCode.E_DIARIZATION_FAILED.value
        return fallback_result

    return fallback_result


def _transcribe_with_deepgram(audio_url: str, *, diarize: bool) -> dict[str, Any]:
    settings = get_settings()
    request_url = f"{settings.deepgram_base_url.rstrip('/')}{_DEEPGRAM_LISTEN_PATH}"
    diarize_str = "true" if diarize else "false"
    try:
        response = httpx.post(
            request_url,
            headers={
                "Authorization": f"Token {settings.deepgram_api_key}",
                "Content-Type": "application/json",
            },
            params={
                "model": settings.deepgram_model,
                "diarize": diarize_str,
                "utterances": "true",
                "smart_format": "true",
                "punctuate": "true",
                "language": "en",
            },
            json={"url": audio_url},
            timeout=settings.podcast_transcription_timeout_seconds,
        )
        response.raise_for_status()
        payload = response.json()
    except httpx.TimeoutException:
        return _transcription_failure_result(
            ApiErrorCode.E_TRANSCRIPTION_TIMEOUT.value,
            "Transcription timed out",
        )
    except httpx.HTTPStatusError as exc:
        code = (
            ApiErrorCode.E_TRANSCRIPTION_TIMEOUT.value
            if exc.response.status_code in {408, 504}
            else ApiErrorCode.E_TRANSCRIPTION_FAILED.value
        )
        logger.warning(
            "podcast_transcription_provider_http_error",
            audio_url=audio_url,
            diarize=diarize,
            status_code=exc.response.status_code,
        )
        return _transcription_failure_result(code, "Transcription failed")
    except Exception as exc:
        logger.warning(
            "podcast_transcription_provider_request_failed",
            audio_url=audio_url,
            diarize=diarize,
            error=str(exc),
        )
        return _transcription_failure_result(
            ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
            "Transcription failed",
        )

    segments = _extract_deepgram_segments(payload)
    if not segments:
        return _transcription_failure_result(
            ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value,
            "Transcript unavailable",
        )

    return {
        "status": "completed",
        "segments": segments,
    }


def _extract_deepgram_segments(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    results = payload.get("results")
    if not isinstance(results, dict):
        return []

    utterances = results.get("utterances")
    if isinstance(utterances, list):
        segments: list[dict[str, Any]] = []
        for utterance in utterances:
            if not isinstance(utterance, dict):
                continue
            transcript = str(utterance.get("transcript") or "").strip()
            if not transcript:
                continue
            t_start_ms = _seconds_to_ms(utterance.get("start"))
            t_end_ms = _seconds_to_ms(utterance.get("end"))
            if t_start_ms is None or t_end_ms is None:
                continue
            speaker_value = utterance.get("speaker")
            speaker_label = str(speaker_value).strip() if speaker_value is not None else None
            if speaker_label == "":
                speaker_label = None
            segments.append(
                {
                    "text": transcript,
                    "t_start_ms": t_start_ms,
                    "t_end_ms": t_end_ms,
                    "speaker_label": speaker_label,
                }
            )
        if segments:
            return segments

    channels = results.get("channels")
    if not isinstance(channels, list) or not channels:
        return []
    first_channel = channels[0]
    if not isinstance(first_channel, dict):
        return []
    alternatives = first_channel.get("alternatives")
    if not isinstance(alternatives, list) or not alternatives:
        return []
    first_alt = alternatives[0]
    if not isinstance(first_alt, dict):
        return []

    transcript = str(first_alt.get("transcript") or "").strip()
    duration_seconds = None
    metadata = payload.get("metadata")
    if isinstance(metadata, dict):
        duration_seconds = metadata.get("duration")
    duration_ms = _seconds_to_ms(duration_seconds)
    if duration_ms is None:
        words = first_alt.get("words")
        duration_ms = _word_range_end_ms(words)
    if not transcript or duration_ms is None:
        return []

    return [
        {
            "text": transcript,
            "t_start_ms": 0,
            "t_end_ms": duration_ms,
            "speaker_label": None,
        }
    ]


def _seconds_to_ms(raw_value: Any) -> int | None:
    if raw_value is None:
        return None
    try:
        seconds = float(raw_value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(seconds):
        return None
    if seconds < 0:
        return None
    return int(round(seconds * 1000))


def _word_range_end_ms(raw_words: Any) -> int | None:
    if not isinstance(raw_words, list) or not raw_words:
        return None
    max_end_ms: int | None = None
    for word in raw_words:
        if not isinstance(word, dict):
            continue
        end_ms = _seconds_to_ms(word.get("end"))
        if end_ms is None:
            continue
        if max_end_ms is None or end_ms > max_end_ms:
            max_end_ms = end_ms
    return max_end_ms


def _normalize_transcript_segments(raw_segments: Any) -> list[dict[str, Any]]:
    return _shared_normalize_transcript_segments(raw_segments)


def _canonicalize_transcript_segment_text(raw_value: Any) -> str:
    return _shared_canonicalize_transcript_segment_text(raw_value)
