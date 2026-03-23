"""Podcast discovery, subscription ingest, and quota policy services."""

from __future__ import annotations

import hashlib
import json
import math
import re
import threading
import time
from datetime import UTC, date, datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urljoin, urlsplit, urlunsplit
from uuid import UUID, uuid4

import httpx
from lxml import etree
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import Environment, get_settings
from nexus.db.session import create_session_factory, transaction
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
    PodcastEffectivePlanOut,
    PodcastListItemOut,
    PodcastOpmlImportErrorOut,
    PodcastOpmlImportOut,
    PodcastPlanOut,
    PodcastPlanSnapshotOut,
    PodcastPlanUpdateRequest,
    PodcastPlanUsageOut,
    PodcastSubscribeOut,
    PodcastSubscribeRequest,
    PodcastSubscriptionListItemOut,
    PodcastSubscriptionStatusOut,
    PodcastSubscriptionSyncRefreshOut,
)
from nexus.services import playback_queue as playback_queue_service
from nexus.services.sanitize_html import sanitize_html
from nexus.services.search import visible_media_ids_cte_sql
from nexus.services.semantic_chunks import (
    chunk_transcript_segments,
    current_transcript_embedding_model,
    to_pgvector_literal,
    transcript_embedding_dimensions,
)
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
PODCAST_EPISODE_STATES = {"all", "unplayed", "in_progress", "played"}
PODCAST_EPISODE_SORT_OPTIONS = {"newest", "oldest", "duration_asc", "duration_desc"}
PODCAST_SUBSCRIPTION_SORT_OPTIONS = {"recent_episode", "unplayed_count", "alpha"}
PODCAST_OPML_MAX_BYTES = 1_000_000
PODCAST_OPML_MAX_OUTLINES = 200
PODCAST_OPML_MAX_TITLE_LENGTH = 512
PODCAST_OPML_MAX_URL_LENGTH = 2048
PODCAST_OPML_MAX_ERROR_LENGTH = 300
PODCAST_EPISODE_SHOW_NOTES_HTML_MAX_BYTES = 100_000
PODCAST_EPISODE_SHOW_NOTES_TEXT_MAX_BYTES = 50_000
PODCAST_EPISODE_SHOW_NOTES_LIST_PREVIEW_MAX_CHARS = 300
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

    def lookup_podcast_by_feed_url(self, feed_url: str) -> dict[str, Any] | None:
        payload = self._get_json(
            "/podcasts/byfeedurl",
            params={"url": feed_url},
        )
        candidate: dict[str, Any] | None = None
        if isinstance(payload.get("feed"), dict):
            candidate = payload["feed"]
        elif isinstance(payload.get("feeds"), list):
            feeds = payload["feeds"]
            first = feeds[0] if feeds else None
            if isinstance(first, dict):
                candidate = first
        if candidate is None:
            return None

        provider_podcast_id = str(candidate.get("id") or "").strip()
        normalized_feed_url = str(candidate.get("url") or feed_url or "").strip()
        if not provider_podcast_id or not normalized_feed_url:
            return None

        return {
            "provider_podcast_id": provider_podcast_id,
            "title": str(candidate.get("title") or "Untitled Podcast"),
            "author": (
                str(candidate.get("author")) if candidate.get("author") is not None else None
            ),
            "feed_url": normalized_feed_url,
            "website_url": (
                str(candidate.get("link")) if candidate.get("link") is not None else None
            ),
            "image_url": (
                str(candidate.get("image")) if candidate.get("image") is not None else None
            ),
            "description": (
                str(candidate.get("description"))
                if candidate.get("description") is not None
                else None
            ),
        }

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


def import_subscriptions_from_opml(
    db: Session,
    viewer_id: UUID,
    *,
    file_name: str | None,
    content_type: str | None,
    payload: bytes,
) -> PodcastOpmlImportOut:
    _validate_opml_upload(content_type=content_type, payload=payload)
    outline_rows = _parse_opml_rss_outlines(payload)
    if len(outline_rows) > PODCAST_OPML_MAX_OUTLINES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"OPML import supports at most {PODCAST_OPML_MAX_OUTLINES} RSS outlines per file.",
        )

    summary = PodcastOpmlImportOut(
        total=len(outline_rows),
        imported=0,
        skipped_already_subscribed=0,
        skipped_invalid=0,
        errors=[],
    )
    client = get_podcast_index_client()

    for outline in outline_rows:
        raw_feed_url = _sanitize_opml_string(
            outline.get("xmlUrl") or outline.get("xmlurl"),
            max_length=PODCAST_OPML_MAX_URL_LENGTH,
        )
        if not raw_feed_url:
            summary.skipped_invalid += 1
            continue

        try:
            normalized_feed_url = _validate_and_normalize_feed_url(raw_feed_url)
        except InvalidRequestError as exc:
            summary.skipped_invalid += 1
            summary.errors.append(
                PodcastOpmlImportErrorOut(
                    feed_url=raw_feed_url,
                    error=_truncate_opml_error(exc.message),
                )
            )
            continue

        opml_title = _sanitize_opml_string(
            outline.get("text") or outline.get("title"),
            max_length=PODCAST_OPML_MAX_TITLE_LENGTH,
        )
        opml_website_url = _normalize_optional_opml_url(
            _sanitize_opml_string(
                outline.get("htmlUrl") or outline.get("htmlurl"),
                max_length=PODCAST_OPML_MAX_URL_LENGTH,
            )
        )

        try:
            with transaction(db):
                now = datetime.now(UTC)
                podcast_id = _select_podcast_id_by_feed_url(db, normalized_feed_url)
                if podcast_id is None:
                    provider_row: dict[str, Any] | None = None
                    try:
                        provider_row = client.lookup_podcast_by_feed_url(normalized_feed_url)
                    except ApiError as provider_exc:
                        logger.warning(
                            "podcast_opml_provider_lookup_failed",
                            feed_url=normalized_feed_url,
                            error=provider_exc.message,
                        )
                    except Exception as provider_exc:  # pragma: no cover - defensive
                        logger.warning(
                            "podcast_opml_provider_lookup_unexpected_error",
                            feed_url=normalized_feed_url,
                            error=str(provider_exc),
                        )

                    subscribe_body = _build_opml_subscribe_request(
                        normalized_feed_url=normalized_feed_url,
                        opml_title=opml_title,
                        opml_website_url=opml_website_url,
                        provider_row=provider_row,
                    )
                    podcast_id = _upsert_podcast_from_opml(
                        db,
                        subscribe_body,
                        now=now,
                    )

                existing_status = _get_subscription_status_value(db, viewer_id, podcast_id)
                if existing_status == "active":
                    summary.skipped_already_subscribed += 1
                    continue

                _upsert_subscription(
                    db,
                    viewer_id,
                    podcast_id,
                    now=now,
                    auto_queue=False,
                )
                _enqueue_podcast_subscription_sync(user_id=viewer_id, podcast_id=podcast_id)
                summary.imported += 1
        except ApiError as exc:
            summary.errors.append(
                PodcastOpmlImportErrorOut(
                    feed_url=normalized_feed_url,
                    error=_truncate_opml_error(exc.message),
                )
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception(
                "podcast_opml_import_unexpected_error",
                feed_url=normalized_feed_url,
                file_name=file_name,
                error=str(exc),
            )
            summary.errors.append(
                PodcastOpmlImportErrorOut(
                    feed_url=normalized_feed_url,
                    error=_truncate_opml_error("Unexpected OPML import error"),
                )
            )

    return summary


def export_subscriptions_as_opml(db: Session, viewer_id: UUID) -> bytes:
    rows = db.execute(
        text(
            """
            SELECT p.title, p.feed_url, p.website_url
            FROM podcast_subscriptions ps
            JOIN podcasts p ON p.id = ps.podcast_id
            WHERE ps.user_id = :user_id
              AND ps.status = 'active'
            ORDER BY LOWER(p.title) ASC, p.id ASC
            """
        ),
        {"user_id": viewer_id},
    ).fetchall()

    root = etree.Element("opml", version="2.0")
    head = etree.SubElement(root, "head")
    etree.SubElement(head, "title").text = "Nexus Podcasts"
    etree.SubElement(head, "dateCreated").text = datetime.now(UTC).strftime(
        "%a, %d %b %Y %H:%M:%S GMT"
    )
    body = etree.SubElement(root, "body")
    group = etree.SubElement(body, "outline", text="Podcasts")

    for row in rows:
        title = _sanitize_opml_string(str(row[0] or ""), max_length=PODCAST_OPML_MAX_TITLE_LENGTH)
        feed_url = str(row[1] or "").strip()
        website_url = _normalize_optional_opml_url(str(row[2] or "").strip())
        if not feed_url:
            continue
        outline_attrs = {
            "type": "rss",
            "text": title or feed_url,
            "xmlUrl": feed_url,
        }
        if website_url:
            outline_attrs["htmlUrl"] = website_url
        etree.SubElement(group, "outline", **outline_attrs)

    return etree.tostring(
        root,
        encoding="UTF-8",
        xml_declaration=True,
        pretty_print=True,
    )


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
        subscription_created = _upsert_subscription(
            db,
            viewer_id,
            podcast_id,
            now=now,
            auto_queue=body.auto_queue,
        )
        sync_enqueued = _enqueue_podcast_subscription_sync(user_id=viewer_id, podcast_id=podcast_id)
        snapshot = _get_subscription_sync_snapshot(db, viewer_id, podcast_id)
        if snapshot is None:
            raise ApiError(ApiErrorCode.E_INTERNAL, "Failed to read podcast subscription state.")

    return PodcastSubscribeOut(
        podcast_id=podcast_id,
        subscription_created=subscription_created,
        auto_queue=bool(snapshot["auto_queue"]),
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
                auto_queue,
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
        auto_queue=bool(row[4]),
        sync_status=row[5],
        sync_error_code=row[6],
        sync_error_message=row[7],
        sync_attempts=row[8],
        sync_started_at=row[9],
        sync_completed_at=row[10],
        last_synced_at=row[11],
        updated_at=row[12],
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
    offset: int = 0,
    sort: str = "recent_episode",
) -> list[PodcastSubscriptionListItemOut]:
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")
    if offset < 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Offset must be non-negative")
    if sort not in PODCAST_SUBSCRIPTION_SORT_OPTIONS:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Invalid podcast subscriptions sort option",
        )

    limit = min(limit, 200)

    if sort == "alpha":
        order_by_sql = "LOWER(p.title) ASC, ps.podcast_id ASC"
    elif sort == "unplayed_count":
        order_by_sql = (
            "COALESCE(sa.unplayed_count, 0) DESC, "
            "sa.latest_published_at DESC NULLS LAST, "
            "ps.updated_at DESC, "
            "ps.podcast_id DESC"
        )
    else:
        order_by_sql = (
            "sa.latest_published_at DESC NULLS LAST, ps.updated_at DESC, ps.podcast_id DESC"
        )

    rows = db.execute(
        text(
            f"""
            WITH visible_media AS (
                {visible_media_ids_cte_sql()}
            ),
            episode_states AS (
                SELECT
                    pe.podcast_id,
                    pe.media_id,
                    pe.published_at,
                    CASE
                        WHEN pls.is_completed IS TRUE THEN 'played'
                        WHEN COALESCE(pls.position_ms, 0) > 0 THEN 'in_progress'
                        ELSE 'unplayed'
                    END AS episode_state
                FROM podcast_episodes pe
                JOIN visible_media vm
                  ON vm.media_id = pe.media_id
                LEFT JOIN podcast_listening_states pls
                  ON pls.user_id = :user_id
                 AND pls.media_id = pe.media_id
            ),
            subscription_aggregates AS (
                SELECT
                    ps.podcast_id,
                    COUNT(*) FILTER (WHERE es.episode_state = 'unplayed') AS unplayed_count,
                    MAX(es.published_at) AS latest_published_at
                FROM podcast_subscriptions ps
                LEFT JOIN episode_states es
                  ON es.podcast_id = ps.podcast_id
                WHERE ps.user_id = :user_id
                  AND ps.status = 'active'
                GROUP BY ps.podcast_id
            )
            SELECT
                ps.podcast_id,
                ps.status,
                ps.unsubscribe_mode,
                ps.auto_queue,
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
                p.updated_at,
                COALESCE(sa.unplayed_count, 0) AS unplayed_count,
                sa.latest_published_at
            FROM podcast_subscriptions ps
            JOIN podcasts p ON p.id = ps.podcast_id
            LEFT JOIN subscription_aggregates sa ON sa.podcast_id = ps.podcast_id
            WHERE ps.user_id = :user_id
              AND ps.status = 'active'
            ORDER BY {order_by_sql}
            LIMIT :limit
            OFFSET :offset
            """
        ),
        {"user_id": viewer_id, "viewer_id": viewer_id, "limit": limit, "offset": offset},
    ).fetchall()
    out: list[PodcastSubscriptionListItemOut] = []
    for row in rows:
        podcast = _podcast_list_item_from_row(row[12:23])
        out.append(
            PodcastSubscriptionListItemOut(
                podcast_id=row[0],
                status=row[1],
                unsubscribe_mode=row[2],
                auto_queue=bool(row[3]),
                sync_status=row[4],
                sync_error_code=row[5],
                sync_error_message=row[6],
                sync_attempts=row[7],
                sync_started_at=row[8],
                sync_completed_at=row[9],
                last_synced_at=row[10],
                updated_at=row[11],
                unplayed_count=int(row[23] or 0),
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
                ps.auto_queue,
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
        auto_queue=bool(row[4]),
        sync_status=row[5],
        sync_error_code=row[6],
        sync_error_message=row[7],
        sync_attempts=row[8],
        sync_started_at=row[9],
        sync_completed_at=row[10],
        last_synced_at=row[11],
        updated_at=row[12],
    )
    podcast = _podcast_list_item_from_row(row[13:])
    return PodcastDetailOut(podcast=podcast, subscription=subscription)


def _escape_ilike_pattern(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def list_podcast_episodes_for_viewer(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
    *,
    limit: int = 50,
    offset: int = 0,
    state: str = "all",
    sort: str = "newest",
    q: str | None = None,
) -> list[MediaOut]:
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")
    if offset < 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Offset must be non-negative")
    if state not in PODCAST_EPISODE_STATES:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid podcast episode state")
    if sort not in PODCAST_EPISODE_SORT_OPTIONS:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Invalid podcast episode sort option"
        )

    limit = min(limit, 200)
    detail = get_podcast_detail_for_viewer(db, viewer_id, podcast_id)
    if detail.subscription.status != "active":
        return []

    normalized_query = q.strip() if q else None
    if normalized_query == "":
        normalized_query = None

    if sort == "oldest":
        order_by_sql = "published_at ASC NULLS LAST, media_id ASC"
    elif sort == "duration_asc":
        order_by_sql = (
            "duration_seconds ASC NULLS LAST, published_at DESC NULLS LAST, media_id DESC"
        )
    elif sort == "duration_desc":
        order_by_sql = (
            "duration_seconds DESC NULLS LAST, published_at DESC NULLS LAST, media_id DESC"
        )
    else:
        order_by_sql = "published_at DESC NULLS LAST, media_id DESC"

    where_clauses = ["pe.podcast_id = :podcast_id"]
    params: dict[str, object] = {
        "viewer_id": viewer_id,
        "podcast_id": podcast_id,
        "episode_state": state,
        "limit": limit,
        "offset": offset,
    }
    if normalized_query:
        where_clauses.append(r"m.title ILIKE :query_pattern ESCAPE '\'")
        params["query_pattern"] = f"%{_escape_ilike_pattern(normalized_query)}%"

    episode_rows = (
        db.execute(
            text(
                f"""
            WITH visible_media AS (
                {visible_media_ids_cte_sql()}
            ),
            episode_rows AS (
                SELECT
                    pe.media_id,
                    pe.published_at,
                    pe.duration_seconds,
                    CASE
                        WHEN pls.is_completed IS TRUE THEN 'played'
                        WHEN COALESCE(pls.position_ms, 0) > 0 THEN 'in_progress'
                        ELSE 'unplayed'
                    END AS episode_state
                FROM podcast_episodes pe
                JOIN visible_media vm
                  ON vm.media_id = pe.media_id
                JOIN media m
                  ON m.id = pe.media_id
                LEFT JOIN podcast_listening_states pls
                  ON pls.user_id = :viewer_id
                 AND pls.media_id = pe.media_id
                WHERE {" AND ".join(where_clauses)}
            )
            SELECT media_id, episode_state
            FROM episode_rows
            WHERE (:episode_state = 'all' OR episode_state = :episode_state)
            ORDER BY {order_by_sql}
            LIMIT :limit
            OFFSET :offset
            """
            ),
            params,
        )
        .mappings()
        .fetchall()
    )

    ordered_media_ids: list[UUID] = []
    episode_state_by_media_id: dict[UUID, str] = {}
    for row in episode_rows:
        media_id = row["media_id"]
        if media_id is None:
            continue
        normalized_media_id = UUID(str(media_id))
        ordered_media_ids.append(normalized_media_id)
        episode_state_by_media_id[normalized_media_id] = str(row["episode_state"])

    if not ordered_media_ids:
        return []

    from nexus.services import media as media_service

    episodes = media_service.list_media_for_viewer_by_ids(db, viewer_id, ordered_media_ids)
    for episode in episodes:
        episode_state = episode_state_by_media_id.get(episode.id)
        if episode_state is not None:
            episode.episode_state = episode_state
        if episode.description_text:
            episode.description_text = episode.description_text[
                :PODCAST_EPISODE_SHOW_NOTES_LIST_PREVIEW_MAX_CHARS
            ]
    return episodes


def _semantic_index_requires_repair(
    db: Session,
    *,
    transcript_version_id: UUID,
) -> bool:
    """Whether active transcript chunks are absent/stale for the current embedding model."""
    active_embedding_model = current_transcript_embedding_model()
    row = db.execute(
        text(
            """
            SELECT
                EXISTS (
                    SELECT 1
                    FROM podcast_transcript_chunks tc
                    WHERE tc.transcript_version_id = :transcript_version_id
                ) AS has_chunks,
                EXISTS (
                    SELECT 1
                    FROM podcast_transcript_chunks tc
                    WHERE tc.transcript_version_id = :transcript_version_id
                      AND (
                          tc.embedding_vector IS NULL
                          OR tc.embedding_model IS NULL
                          OR tc.embedding_model <> :active_embedding_model
                      )
                ) AS has_stale_chunks
            """
        ),
        {
            "transcript_version_id": transcript_version_id,
            "active_embedding_model": active_embedding_model,
        },
    ).fetchone()
    if row is None:
        return True
    has_chunks = bool(row[0])
    has_stale_chunks = bool(row[1])
    return (not has_chunks) or has_stale_chunks


def request_podcast_transcript_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    reason: str,
    dry_run: bool = False,
    _auto_commit: bool = True,
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
                m.last_error_code,
                (
                    SELECT pe.duration_seconds
                    FROM podcast_episodes pe
                    WHERE pe.media_id = m.id
                ) AS duration_seconds,
                (
                    SELECT j.status
                    FROM podcast_transcription_jobs j
                    WHERE j.media_id = m.id
                ) AS job_status,
                (
                    SELECT mts.transcript_state
                    FROM media_transcript_states mts
                    WHERE mts.media_id = m.id
                ) AS transcript_state,
                (
                    SELECT mts.transcript_coverage
                    FROM media_transcript_states mts
                    WHERE mts.media_id = m.id
                ) AS transcript_coverage,
                (
                    SELECT mts.semantic_status
                    FROM media_transcript_states mts
                    WHERE mts.media_id = m.id
                ) AS semantic_status,
                (
                    SELECT mts.active_transcript_version_id
                    FROM media_transcript_states mts
                    WHERE mts.media_id = m.id
                ) AS active_transcript_version_id
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
    last_error_code = str(media_row[2] or "").strip() or None
    duration_seconds = _coerce_positive_int(media_row[3])
    job_status = str(media_row[4] or "").strip() or None
    transcript_state = str(media_row[5] or "").strip() or None
    transcript_coverage = str(media_row[6] or "").strip() or None
    semantic_status = str(media_row[7] or "").strip() or "none"
    active_transcript_version_id = media_row[8]

    if media_kind != "podcast_episode":
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Transcript request is only supported for podcast episodes.",
        )

    if transcript_state is None:
        _ensure_media_transcript_state_row(
            db,
            media_id=media_id,
            processing_status=processing_status,
            last_error_code=last_error_code,
            now=now,
            request_reason=normalized_reason,
        )
        if processing_status in {"ready_for_reading", "embedding", "ready"}:
            transcript_state = "ready"
            transcript_coverage = "full"
        elif processing_status == "extracting":
            transcript_state = "running"
            transcript_coverage = "none"
        else:
            transcript_state = "not_requested"
            transcript_coverage = "none"

    required_minutes = _episode_minutes({"duration_seconds": duration_seconds})
    plan = _get_effective_plan(db, viewer_id)
    daily_limit_minutes = plan["daily_transcription_minutes"]
    usage_snapshot = _get_usage_snapshot(db, viewer_id=viewer_id, usage_date=usage_date)
    consumed_minutes = usage_snapshot["total"]
    remaining_minutes = (
        None
        if daily_limit_minutes is None
        else max(0, int(daily_limit_minutes) - int(consumed_minutes))
    )
    fits_budget = remaining_minutes is None or required_minutes <= remaining_minutes

    already_ready = transcript_state in {"ready", "partial"} and transcript_coverage in {
        "partial",
        "full",
    }
    semantic_needs_repair = already_ready and semantic_status in {"pending", "failed"}
    if (
        already_ready
        and not semantic_needs_repair
        and active_transcript_version_id is not None
        and _semantic_index_requires_repair(
            db,
            transcript_version_id=active_transcript_version_id,
        )
    ):
        semantic_needs_repair = True
    already_inflight = transcript_state in {"queued", "running"} or job_status in {
        "pending",
        "running",
    }
    effective_status = (
        "ready_for_reading"
        if already_ready
        else "extracting"
        if already_inflight
        else processing_status
    )

    if dry_run:
        _record_podcast_transcript_request_audit(
            db,
            media_id=media_id,
            requested_by_user_id=viewer_id,
            request_reason=normalized_reason,
            dry_run=True,
            outcome="forecast",
            required_minutes=required_minutes,
            remaining_minutes=remaining_minutes,
            fits_budget=fits_budget,
            now=now,
        )
        if _auto_commit:
            db.commit()
        return {
            "media_id": str(media_id),
            "processing_status": effective_status,
            "transcript_state": transcript_state or "not_requested",
            "transcript_coverage": transcript_coverage or "none",
            "request_reason": normalized_reason,
            "required_minutes": required_minutes,
            "remaining_minutes": remaining_minutes,
            "fits_budget": fits_budget,
            "request_enqueued": False,
        }

    if semantic_needs_repair:
        semantic_repair_enqueued = _enqueue_podcast_semantic_repair_job(
            media_id=media_id,
            requested_by_user_id=viewer_id,
            request_reason=normalized_reason,
        )
        if semantic_repair_enqueued:
            _set_media_transcript_state(
                db,
                media_id=media_id,
                transcript_state=transcript_state or "ready",
                transcript_coverage=transcript_coverage or "full",
                semantic_status="pending",
                last_request_reason=normalized_reason,
                last_error_code=None,
                now=now,
            )

        _record_podcast_transcript_request_audit(
            db,
            media_id=media_id,
            requested_by_user_id=viewer_id,
            request_reason=normalized_reason,
            dry_run=False,
            outcome="queued" if semantic_repair_enqueued else "enqueue_failed",
            required_minutes=required_minutes,
            remaining_minutes=remaining_minutes,
            fits_budget=True,
            now=now,
        )
        db.commit()
        return {
            "media_id": str(media_id),
            "processing_status": "ready_for_reading",
            "transcript_state": transcript_state or "ready",
            "transcript_coverage": transcript_coverage or "full",
            "request_reason": normalized_reason,
            "required_minutes": required_minutes,
            "remaining_minutes": remaining_minutes,
            "fits_budget": True,
            "request_enqueued": semantic_repair_enqueued,
        }

    # Already queued/running/readable without semantic backlog: idempotent no-op.
    if already_ready or already_inflight:
        _record_podcast_transcript_request_audit(
            db,
            media_id=media_id,
            requested_by_user_id=viewer_id,
            request_reason=normalized_reason,
            dry_run=False,
            outcome="idempotent",
            required_minutes=required_minutes,
            remaining_minutes=remaining_minutes,
            fits_budget=True,
            now=now,
        )
        db.commit()
        return {
            "media_id": str(media_id),
            "processing_status": effective_status,
            "transcript_state": transcript_state or ("ready" if already_ready else "queued"),
            "transcript_coverage": transcript_coverage or ("full" if already_ready else "none"),
            "request_reason": normalized_reason,
            "required_minutes": required_minutes,
            "remaining_minutes": remaining_minutes,
            "fits_budget": True,
            "request_enqueued": False,
        }

    if not fits_budget:
        _record_podcast_transcript_request_audit(
            db,
            media_id=media_id,
            requested_by_user_id=viewer_id,
            request_reason=normalized_reason,
            dry_run=False,
            outcome="rejected_quota",
            required_minutes=required_minutes,
            remaining_minutes=remaining_minutes,
            fits_budget=False,
            now=now,
        )
        db.commit()
        raise ApiError(
            ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED,
            "Daily podcast transcription quota exceeded",
        )

    usage_snapshot_after = _reserve_usage_minutes_or_raise(
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
        else max(0, int(daily_limit_minutes) - int(usage_snapshot_after["total"]))
    )

    db.execute(
        text(
            """
            INSERT INTO podcast_transcription_jobs (
                media_id,
                requested_by_user_id,
                request_reason,
                reserved_minutes,
                reservation_usage_date,
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
                :reserved_minutes,
                :reservation_usage_date,
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
                reserved_minutes = EXCLUDED.reserved_minutes,
                reservation_usage_date = EXCLUDED.reservation_usage_date,
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
            "reserved_minutes": required_minutes,
            "reservation_usage_date": usage_date,
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

    _set_media_transcript_state(
        db,
        media_id=media_id,
        transcript_state="queued",
        transcript_coverage="none",
        semantic_status="none",
        active_transcript_version_id=None,
        last_request_reason=normalized_reason,
        last_error_code=None,
        now=now,
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
        _record_podcast_transcript_request_audit(
            db,
            media_id=media_id,
            requested_by_user_id=viewer_id,
            request_reason=normalized_reason,
            dry_run=False,
            outcome="enqueue_failed",
            required_minutes=required_minutes,
            remaining_minutes=remaining_minutes,
            fits_budget=True,
            now=now,
        )
        db.commit()
        return {
            "media_id": str(media_id),
            "processing_status": "failed",
            "transcript_state": "failed_provider",
            "transcript_coverage": "none",
            "request_reason": normalized_reason,
            "required_minutes": required_minutes,
            "remaining_minutes": remaining_minutes,
            "fits_budget": True,
            "request_enqueued": False,
        }

    _record_podcast_transcript_request_audit(
        db,
        media_id=media_id,
        requested_by_user_id=viewer_id,
        request_reason=normalized_reason,
        dry_run=False,
        outcome="queued",
        required_minutes=required_minutes,
        remaining_minutes=remaining_minutes_after,
        fits_budget=True,
        now=now,
    )
    db.commit()
    return {
        "media_id": str(media_id),
        "processing_status": "extracting",
        "transcript_state": "queued",
        "transcript_coverage": "none",
        "request_reason": normalized_reason,
        "required_minutes": required_minutes,
        "remaining_minutes": remaining_minutes_after,
        "fits_budget": True,
        "request_enqueued": True,
    }


def request_podcast_transcripts_batch_for_viewer(
    db: Session,
    viewer_id: UUID,
    *,
    media_ids: list[UUID],
    reason: str,
) -> dict[str, Any]:
    normalized_media_ids: list[UUID] = []
    seen_media_ids: set[UUID] = set()
    for media_id in media_ids:
        normalized_media_id = UUID(str(media_id))
        if normalized_media_id in seen_media_ids:
            continue
        seen_media_ids.add(normalized_media_id)
        normalized_media_ids.append(normalized_media_id)

    results: list[dict[str, Any]] = []
    quota_exhausted = False
    quota_remaining_after_exhaustion: int | None = 0

    for media_id in normalized_media_ids:
        media_id_str = str(media_id)
        if quota_exhausted:
            results.append(
                {
                    "media_id": media_id_str,
                    "status": "rejected_quota",
                    "required_minutes": None,
                    "remaining_minutes": quota_remaining_after_exhaustion,
                    "error": "Daily podcast transcription quota exceeded",
                }
            )
            continue

        try:
            admission = request_podcast_transcript_for_viewer(
                db,
                viewer_id=viewer_id,
                media_id=media_id,
                reason=reason,
                dry_run=False,
            )
        except ApiError as exc:
            if exc.code == ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED:
                quota_exhausted = True
                quota_remaining_after_exhaustion = 0
                results.append(
                    {
                        "media_id": media_id_str,
                        "status": "rejected_quota",
                        "required_minutes": None,
                        "remaining_minutes": 0,
                        "error": exc.message,
                    }
                )
                continue
            if exc.code in {
                ApiErrorCode.E_MEDIA_NOT_FOUND,
                ApiErrorCode.E_INVALID_KIND,
                ApiErrorCode.E_FORBIDDEN,
            }:
                results.append(
                    {
                        "media_id": media_id_str,
                        "status": "rejected_invalid",
                        "required_minutes": None,
                        "remaining_minutes": None,
                        "error": exc.message,
                    }
                )
                continue
            raise
        except (InvalidRequestError, NotFoundError, ForbiddenError) as exc:
            results.append(
                {
                    "media_id": media_id_str,
                    "status": "rejected_invalid",
                    "required_minutes": None,
                    "remaining_minutes": None,
                    "error": exc.message,
                }
            )
            continue

        status = _batch_transcript_status_from_admission(admission)
        required_minutes = _coerce_non_negative_int(admission.get("required_minutes"))
        remaining_minutes = (
            _coerce_non_negative_int(admission.get("remaining_minutes"))
            if admission.get("remaining_minutes") is not None
            else None
        )
        error_message = None
        if status == "rejected_invalid":
            error_message = "Transcript request admission failed"

        results.append(
            {
                "media_id": media_id_str,
                "status": status,
                "required_minutes": required_minutes,
                "remaining_minutes": remaining_minutes,
                "error": error_message,
            }
        )

        if status == "queued" and remaining_minutes == 0:
            quota_exhausted = True
            quota_remaining_after_exhaustion = 0

    return {"results": results}


def _batch_transcript_status_from_admission(admission: dict[str, Any]) -> str:
    if bool(admission.get("request_enqueued")):
        return "queued"
    transcript_state = str(admission.get("transcript_state") or "").strip().lower()
    if transcript_state in {"ready", "partial"}:
        return "already_ready"
    if transcript_state in {"queued", "running"}:
        return "already_queued"
    return "rejected_invalid"


def forecast_podcast_transcripts_for_viewer(
    db: Session,
    viewer_id: UUID,
    requests: list[tuple[UUID, str]],
) -> list[dict[str, Any]]:
    """Return dry-run transcript forecasts for many podcast episodes in one commit."""

    if not requests:
        return []

    results: list[dict[str, Any]] = []
    try:
        for media_id, reason in requests:
            results.append(
                request_podcast_transcript_for_viewer(
                    db,
                    viewer_id,
                    media_id,
                    reason=reason,
                    dry_run=True,
                    _auto_commit=False,
                )
            )
        db.commit()
    except Exception:
        db.rollback()
        raise

    return results


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

    if kind == "podcast_episode":
        admission = request_podcast_transcript_for_viewer(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            reason="operator_requeue",
            dry_run=False,
        )
        return {
            "media_id": admission["media_id"],
            "processing_status": admission["processing_status"],
            "retry_enqueued": bool(admission["request_enqueued"]),
        }

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
    ingested_media_ids: list[UUID] = []
    chapter_sync_rows: list[tuple[UUID, list[dict[str, Any]] | None]] = []

    for episode in selected_episodes:
        guid = _normalize_guid(episode.get("guid"))
        fallback_identity = _compute_fallback_identity(podcast_id, episode)
        description_html = _normalize_optional_text(episode.get("description_html"))
        description_text = _normalize_optional_text(episode.get("description_text"))
        published_at = _parse_iso_datetime(episode.get("published_at"))
        duration_seconds = _coerce_positive_int(episode.get("duration_seconds"))
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
                    UPDATE podcast_episodes
                    SET
                        description_html = :description_html,
                        description_text = :description_text,
                        published_at = :published_at,
                        duration_seconds = :duration_seconds
                    WHERE media_id = :media_id
                    """
                ),
                {
                    "media_id": media_id,
                    "description_html": description_html,
                    "description_text": description_text,
                    "published_at": published_at,
                    "duration_seconds": duration_seconds,
                },
            )
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
                    "created_at": now,
                },
            )
            _ensure_in_default_library(db, viewer_id, media_id)
            ingested_episode_count += 1
            ingested_media_ids.append(media_id)

        chapter_sync_rows.append((media_id, episode.get("rss_chapters")))

    for media_id, chapter_rows in chapter_sync_rows:
        _upsert_podcast_episode_chapters(
            db,
            media_id=media_id,
            chapter_rows=chapter_rows,
            now=now,
        )

    playback_queue_service.append_subscription_media_if_enabled(
        db,
        viewer_id=viewer_id,
        podcast_id=podcast_id,
        media_ids=ingested_media_ids,
    )

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


def get_user_plan_snapshot(db: Session, user_id: UUID) -> PodcastPlanSnapshotOut:
    usage_date = datetime.now(UTC).date()
    effective_plan = _get_effective_plan(db, user_id)
    usage_snapshot = _get_usage_snapshot(db, viewer_id=user_id, usage_date=usage_date)

    daily_limit_minutes = effective_plan["daily_transcription_minutes"]
    remaining_minutes = (
        None
        if daily_limit_minutes is None
        else max(0, int(daily_limit_minutes) - int(usage_snapshot["total"]))
    )

    return PodcastPlanSnapshotOut(
        plan=PodcastEffectivePlanOut(
            plan_tier=effective_plan["plan_tier"],
            daily_transcription_minutes=daily_limit_minutes,
            initial_episode_window=effective_plan["initial_episode_window"],
        ),
        usage=PodcastPlanUsageOut(
            usage_date=usage_date,
            used_minutes=usage_snapshot["used"],
            reserved_minutes=usage_snapshot["reserved"],
            total_minutes=usage_snapshot["total"],
            remaining_minutes=remaining_minutes,
        ),
    )


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
        sync_enqueued = _enqueue_podcast_subscription_sync(user_id=viewer_id, podcast_id=podcast_id)

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
        settings = get_settings()
        if settings.nexus_env == Environment.TEST:
            logger.info(
                "podcast_transcription_enqueue_deferred_in_test",
                media_id=str(media_id),
                requested_by_user_id=(str(requested_by_user_id) if requested_by_user_id else None),
            )
            return True
        return False


def _enqueue_podcast_semantic_repair_job(
    *,
    media_id: UUID,
    requested_by_user_id: UUID | None,
    request_reason: str,
) -> bool:
    try:
        from nexus.tasks.podcast_reindex_semantic import podcast_reindex_semantic_job

        podcast_reindex_semantic_job.apply_async(
            args=[str(media_id), str(requested_by_user_id) if requested_by_user_id else None],
            kwargs={"request_reason": request_reason},
            queue="ingest",
        )
        return True
    except Exception as exc:
        logger.warning(
            "podcast_semantic_repair_enqueue_failed",
            media_id=str(media_id),
            requested_by_user_id=(str(requested_by_user_id) if requested_by_user_id else None),
            request_reason=request_reason,
            error=str(exc),
        )
        settings = get_settings()
        if settings.nexus_env == Environment.TEST:
            logger.info(
                "podcast_semantic_repair_enqueue_deferred_in_test",
                media_id=str(media_id),
                requested_by_user_id=(str(requested_by_user_id) if requested_by_user_id else None),
                request_reason=request_reason,
            )
            return True
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
        settings = get_settings()
        if settings.nexus_env == Environment.TEST:
            logger.info(
                "video_transcription_retry_enqueue_deferred_in_test",
                media_id=str(media_id),
                requested_by_user_id=str(requested_by_user_id),
                request_id=request_id,
            )
            return True
        return False


def _mark_podcast_transcription_failure(
    db: Session,
    *,
    media_id: UUID,
    error_code: str,
    error_message: str,
    now: datetime,
) -> None:
    if error_code == ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value:
        transcript_state = "unavailable"
    elif error_code == ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED.value:
        transcript_state = "failed_quota"
    else:
        transcript_state = "failed_provider"

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
    _release_reserved_usage_for_media(db, media_id=media_id, now=now)
    _set_media_transcript_state(
        db,
        media_id=media_id,
        transcript_state=transcript_state,
        transcript_coverage="none",
        semantic_status="none",
        active_transcript_version_id=None,
        last_error_code=error_code,
        now=now,
    )


def mark_podcast_transcription_failure_for_recovery(
    db: Session,
    *,
    media_id: UUID,
    error_code: str,
    error_message: str,
    now: datetime,
) -> None:
    """Fail-close podcast transcription with full job/quota/transcript-state repair.

    Used by operational recovery paths (for example stale-ingest reconciler) that
    must not leave orphaned running jobs or reserved quota.
    """
    _mark_podcast_transcription_failure(
        db,
        media_id=media_id,
        error_code=error_code,
        error_message=error_message,
        now=now,
    )


def _transcription_heartbeat_interval_seconds(*, stale_extracting_seconds: int) -> float:
    # Keep lease heartbeats comfortably below stale reclaim cutoff.
    return max(1.0, min(30.0, float(stale_extracting_seconds) / 2.0))


def _run_transcription_job_heartbeat(
    session_factory: sessionmaker[Session],
    *,
    stop_event: threading.Event,
    media_id: UUID,
    interval_seconds: float,
) -> None:
    while not stop_event.wait(interval_seconds):
        heartbeat_now = datetime.now(UTC)
        try:
            with session_factory() as heartbeat_db:
                heartbeat_db.execute(
                    text(
                        """
                        UPDATE podcast_transcription_jobs
                        SET updated_at = :now
                        WHERE media_id = :media_id
                          AND status = 'running'
                        """
                    ),
                    {"media_id": media_id, "now": heartbeat_now},
                )
                heartbeat_db.execute(
                    text(
                        """
                        UPDATE media
                        SET updated_at = :now
                        WHERE id = :media_id
                          AND processing_status = 'extracting'
                        """
                    ),
                    {"media_id": media_id, "now": heartbeat_now},
                )
                heartbeat_db.commit()
        except Exception:
            logger.warning(
                "podcast_transcription_heartbeat_failed",
                media_id=str(media_id),
            )


def _start_transcription_job_heartbeat(
    db: Session,
    *,
    media_id: UUID,
    stale_extracting_seconds: int,
) -> tuple[threading.Event, threading.Thread]:
    bind = db.get_bind()
    engine = getattr(bind, "engine", bind)
    session_factory = create_session_factory(engine)
    stop_event = threading.Event()
    interval_seconds = _transcription_heartbeat_interval_seconds(
        stale_extracting_seconds=stale_extracting_seconds
    )
    heartbeat_thread = threading.Thread(
        target=_run_transcription_job_heartbeat,
        kwargs={
            "session_factory": session_factory,
            "stop_event": stop_event,
            "media_id": media_id,
            "interval_seconds": interval_seconds,
        },
        daemon=True,
        name=f"podcast-transcription-heartbeat-{media_id}",
    )
    heartbeat_thread.start()
    return stop_event, heartbeat_thread


def _stop_transcription_job_heartbeat(
    heartbeat: tuple[threading.Event, threading.Thread] | None,
) -> None:
    if heartbeat is None:
        return
    stop_event, heartbeat_thread = heartbeat
    stop_event.set()
    heartbeat_thread.join(timeout=2.0)


def run_podcast_transcription_now(
    db: Session,
    *,
    media_id: UUID,
    requested_by_user_id: UUID | None,
    request_id: str | None = None,
) -> dict[str, Any]:
    _ = request_id
    claim_now = datetime.now(UTC)
    stale_extracting_seconds = get_settings().ingest_stale_extracting_seconds
    # Allow recovery workers to reclaim stale running jobs. We intentionally
    # reuse the ingest stale threshold so media/job stale detection is aligned.
    running_lease_cutoff = claim_now - timedelta(seconds=stale_extracting_seconds)
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
              AND (
                    status IN ('pending', 'failed')
                    OR (
                        status = 'running'
                        AND COALESCE(updated_at, started_at) < :running_lease_cutoff
                    )
              )
            RETURNING request_reason
            """
        ),
        {
            "media_id": media_id,
            "now": claim_now,
            "running_lease_cutoff": running_lease_cutoff,
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

    request_reason = str(claimed[0] or "episode_open")
    _set_media_transcript_state(
        db,
        media_id=media_id,
        transcript_state="running",
        transcript_coverage="none",
        semantic_status="none",
        last_request_reason=request_reason,
        last_error_code=None,
        now=claim_now,
    )
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
        _mark_podcast_transcription_failure(
            db,
            media_id=media_id,
            error_code=ApiErrorCode.E_INVALID_KIND.value,
            error_message="Invalid media kind for podcast transcription",
            now=claim_now,
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
    _set_media_transcript_state(
        db,
        media_id=media_id,
        transcript_state="running",
        transcript_coverage="none",
        semantic_status="none",
        last_request_reason=request_reason,
        last_error_code=None,
        now=claim_now,
    )
    db.commit()

    audio_url = str(media_row[1] or "").strip() or None
    heartbeat: tuple[threading.Event, threading.Thread] | None = None
    try:
        heartbeat = _start_transcription_job_heartbeat(
            db,
            media_id=media_id,
            stale_extracting_seconds=stale_extracting_seconds,
        )
    except Exception:
        logger.warning(
            "podcast_transcription_heartbeat_start_failed",
            media_id=str(media_id),
        )
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
    finally:
        _stop_transcription_job_heartbeat(heartbeat)
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
        transcript_version_id = _create_next_transcript_version(
            db,
            media_id=media_id,
            created_by_user_id=requested_by_user_id,
            request_reason=request_reason,
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
            # Transcript text remains usable even when semantic indexing fails.
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
        _set_media_transcript_state(
            db,
            media_id=media_id,
            transcript_state="ready",
            transcript_coverage="full",
            semantic_status=semantic_status,
            active_transcript_version_id=transcript_version_id,
            last_request_reason=request_reason,
            last_error_code=semantic_error_code,
            now=now,
        )
        _commit_reserved_usage_for_media(db, media_id=media_id, now=now)
        db.commit()
        return {
            "status": "completed",
            "segment_count": len(transcript_segments),
            "transcript_version_id": str(transcript_version_id),
        }

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


def repair_podcast_transcript_semantic_index_now(
    db: Session,
    *,
    media_id: UUID,
    request_reason: str = "operator_requeue",
    request_id: str | None = None,
) -> dict[str, Any]:
    _ = request_id
    now = datetime.now(UTC)
    active_embedding_model = current_transcript_embedding_model()
    normalized_reason = (
        request_reason
        if request_reason in PODCAST_TRANSCRIPT_REQUEST_REASONS
        else "operator_requeue"
    )

    lock_acquired = db.execute(
        text("SELECT pg_try_advisory_xact_lock(hashtext(:lock_key))"),
        {"lock_key": f"podcast-semantic-repair:{media_id}"},
    ).scalar()
    if not bool(lock_acquired):
        return {"status": "skipped", "reason": "locked"}

    claim_row = db.execute(
        text(
            """
            UPDATE media_transcript_states AS mts
            SET
                semantic_status = 'pending',
                last_request_reason = :request_reason,
                last_error_code = NULL,
                updated_at = :now
            WHERE mts.media_id = :media_id
              AND mts.transcript_state IN ('ready', 'partial')
              AND mts.transcript_coverage IN ('partial', 'full')
              AND mts.active_transcript_version_id IS NOT NULL
              AND (
                  mts.semantic_status IN ('pending', 'failed')
                  OR (
                      mts.semantic_status = 'ready'
                      AND (
                          NOT EXISTS (
                              SELECT 1
                              FROM podcast_transcript_chunks tc
                              WHERE tc.transcript_version_id = mts.active_transcript_version_id
                          )
                          OR EXISTS (
                              SELECT 1
                              FROM podcast_transcript_chunks tc
                              WHERE tc.transcript_version_id = mts.active_transcript_version_id
                                AND (
                                    tc.embedding_vector IS NULL
                                    OR tc.embedding_model IS NULL
                                    OR tc.embedding_model <> :active_embedding_model
                                )
                          )
                      )
                  )
              )
            RETURNING mts.active_transcript_version_id, mts.transcript_state, mts.transcript_coverage
            """
        ),
        {
            "media_id": media_id,
            "request_reason": normalized_reason,
            "now": now,
            "active_embedding_model": active_embedding_model,
        },
    ).fetchone()
    if claim_row is None:
        return {"status": "skipped", "reason": "not_repairable"}

    transcript_version_id = claim_row[0]
    transcript_state = str(claim_row[1] or "ready")
    transcript_coverage = str(claim_row[2] or "full")
    segment_rows = db.execute(
        text(
            """
            SELECT canonical_text, t_start_ms, t_end_ms, speaker_label
            FROM podcast_transcript_segments
            WHERE transcript_version_id = :transcript_version_id
            ORDER BY segment_idx ASC
            """
        ),
        {"transcript_version_id": transcript_version_id},
    ).fetchall()

    transcript_segments: list[dict[str, Any]] = []
    for row in segment_rows:
        canonical_text = str(row[0] or "").strip()
        t_start_ms = row[1]
        t_end_ms = row[2]
        if not canonical_text or t_start_ms is None or t_end_ms is None:
            continue
        transcript_segments.append(
            {
                "text": canonical_text,
                "t_start_ms": int(t_start_ms),
                "t_end_ms": int(t_end_ms),
                "speaker_label": row[3],
            }
        )

    if not transcript_segments:
        _set_media_transcript_state(
            db,
            media_id=media_id,
            transcript_state=transcript_state,
            transcript_coverage=transcript_coverage,
            semantic_status="failed",
            active_transcript_version_id=transcript_version_id,
            last_request_reason=normalized_reason,
            last_error_code=ApiErrorCode.E_INTERNAL.value,
            now=now,
        )
        return {
            "status": "failed",
            "error_code": ApiErrorCode.E_INTERNAL.value,
            "reason": "segments_missing",
        }

    try:
        db.execute(
            text(
                """
                DELETE FROM podcast_transcript_chunks
                WHERE transcript_version_id = :transcript_version_id
                """
            ),
            {"transcript_version_id": transcript_version_id},
        )
        _insert_transcript_chunks_for_version(
            db,
            media_id=media_id,
            transcript_version_id=transcript_version_id,
            transcript_segments=transcript_segments,
            now=now,
        )
        _set_media_transcript_state(
            db,
            media_id=media_id,
            transcript_state=transcript_state,
            transcript_coverage=transcript_coverage,
            semantic_status="ready",
            active_transcript_version_id=transcript_version_id,
            last_request_reason=normalized_reason,
            last_error_code=None,
            now=now,
        )
        return {
            "status": "completed",
            "transcript_version_id": str(transcript_version_id),
            "chunk_count": len(transcript_segments),
        }
    except Exception as exc:
        logger.exception(
            "podcast_semantic_repair_failed",
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
        _set_media_transcript_state(
            db,
            media_id=media_id,
            transcript_state=transcript_state,
            transcript_coverage=transcript_coverage,
            semantic_status="failed",
            active_transcript_version_id=transcript_version_id,
            last_request_reason=normalized_reason,
            last_error_code=ApiErrorCode.E_INTERNAL.value,
            now=now,
        )
        return {"status": "failed", "error_code": ApiErrorCode.E_INTERNAL.value}


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


def _upsert_subscription(
    db: Session,
    user_id: UUID,
    podcast_id: UUID,
    *,
    now: datetime,
    auto_queue: bool,
) -> bool:
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
                auto_queue,
                sync_status,
                created_at,
                updated_at
            )
            VALUES (
                :user_id,
                :podcast_id,
                'active',
                1,
                :auto_queue,
                'pending',
                :created_at,
                :updated_at
            )
            ON CONFLICT (user_id, podcast_id)
            DO UPDATE SET
                status = 'active',
                unsubscribe_mode = 1,
                auto_queue = EXCLUDED.auto_queue,
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
            "auto_queue": auto_queue,
            "created_at": now,
            "updated_at": now,
        },
    )
    return existing is None


def _validate_opml_upload(*, content_type: str | None, payload: bytes) -> None:
    normalized_content_type = str(content_type or "").split(";")[0].strip().lower()
    if (
        normalized_content_type
        and normalized_content_type not in {"application/octet-stream", "binary/octet-stream"}
        and "xml" not in normalized_content_type
        and "opml" not in normalized_content_type
    ):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "OPML import requires an XML file upload.",
        )
    if not payload:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "OPML file is empty.")
    if len(payload) > PODCAST_OPML_MAX_BYTES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "OPML file exceeds the 1MB size limit.",
        )


def _parse_opml_rss_outlines(payload: bytes) -> list[dict[str, str]]:
    try:
        parser = etree.XMLParser(resolve_entities=False, no_network=True, recover=False)
        root = etree.fromstring(payload, parser=parser)
    except Exception as exc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Invalid XML file. Please upload a valid OPML document.",
        ) from exc

    root_tag = str(root.tag or "")
    if "}" in root_tag:
        root_tag = root_tag.split("}", 1)[1]
    if root_tag.lower() != "opml":
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Invalid OPML document. Root element must be <opml>.",
        )

    outline_nodes = root.xpath(
        ".//*[local-name()='outline' and "
        "translate(@type, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')='rss']"
    )
    rows: list[dict[str, str]] = []
    for node in outline_nodes:
        attrib_items = getattr(node, "attrib", {})
        rows.append({str(key): str(value) for key, value in attrib_items.items()})
    return rows


def _sanitize_opml_string(value: Any, *, max_length: int) -> str | None:
    if value is None:
        return None
    cleaned = "".join(ch for ch in str(value) if ch in {"\n", "\r", "\t"} or ord(ch) >= 32).strip()
    if not cleaned:
        return None
    return cleaned[:max_length]


def _truncate_opml_error(message: str) -> str:
    return str(message or "Unknown error")[:PODCAST_OPML_MAX_ERROR_LENGTH]


def _normalize_optional_opml_url(url: str | None) -> str | None:
    if not url:
        return None
    try:
        validate_requested_url(url)
    except InvalidRequestError:
        return None
    return normalize_url_for_display(url)


def _stable_opml_provider_podcast_id(normalized_feed_url: str) -> str:
    digest = hashlib.sha1(normalized_feed_url.encode("utf-8")).hexdigest()
    return f"opml-{digest}"


def _build_opml_subscribe_request(
    *,
    normalized_feed_url: str,
    opml_title: str | None,
    opml_website_url: str | None,
    provider_row: dict[str, Any] | None,
) -> PodcastSubscribeRequest:
    provider_podcast_id = _sanitize_opml_string(
        provider_row.get("provider_podcast_id") if provider_row else None,
        max_length=PODCAST_OPML_MAX_TITLE_LENGTH,
    )
    provider_title = _sanitize_opml_string(
        provider_row.get("title") if provider_row else None,
        max_length=PODCAST_OPML_MAX_TITLE_LENGTH,
    )
    provider_author = _sanitize_opml_string(
        provider_row.get("author") if provider_row else None,
        max_length=PODCAST_OPML_MAX_TITLE_LENGTH,
    )
    provider_website = _normalize_optional_opml_url(
        _sanitize_opml_string(
            provider_row.get("website_url") if provider_row else None,
            max_length=PODCAST_OPML_MAX_URL_LENGTH,
        )
    )
    provider_image = _normalize_optional_opml_url(
        _sanitize_opml_string(
            provider_row.get("image_url") if provider_row else None,
            max_length=PODCAST_OPML_MAX_URL_LENGTH,
        )
    )
    provider_description = _sanitize_opml_string(
        provider_row.get("description") if provider_row else None,
        max_length=4000,
    )

    return PodcastSubscribeRequest(
        provider_podcast_id=provider_podcast_id
        or _stable_opml_provider_podcast_id(normalized_feed_url),
        title=provider_title or opml_title or normalized_feed_url,
        author=provider_author,
        feed_url=normalized_feed_url,
        website_url=provider_website or opml_website_url,
        image_url=provider_image,
        description=provider_description,
        auto_queue=False,
    )


def _select_podcast_id_by_feed_url(db: Session, normalized_feed_url: str) -> UUID | None:
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


def _upsert_podcast_from_opml(
    db: Session,
    body: PodcastSubscribeRequest,
    *,
    now: datetime,
) -> UUID:
    try:
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
                ON CONFLICT (feed_url)
                DO UPDATE SET
                    title = EXCLUDED.title,
                    author = COALESCE(EXCLUDED.author, podcasts.author),
                    website_url = COALESCE(EXCLUDED.website_url, podcasts.website_url),
                    image_url = COALESCE(EXCLUDED.image_url, podcasts.image_url),
                    description = COALESCE(EXCLUDED.description, podcasts.description),
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
    except IntegrityError:
        # Provider identity may already exist with a different feed URL.
        # In that case, reuse the existing podcast row and keep import idempotent.
        fallback_row = db.execute(
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
                "provider_podcast_id": body.provider_podcast_id,
            },
        ).fetchone()
        if fallback_row is None:
            raise
        return fallback_row[0]
    return row[0]


def _get_subscription_status_value(db: Session, viewer_id: UUID, podcast_id: UUID) -> str | None:
    row = db.execute(
        text(
            """
            SELECT status
            FROM podcast_subscriptions
            WHERE user_id = :user_id
              AND podcast_id = :podcast_id
            """
        ),
        {"user_id": viewer_id, "podcast_id": podcast_id},
    ).fetchone()
    if row is None:
        return None
    return str(row[0] or "")


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
    transcript_version_id: UUID | None = None,
) -> None:
    _shared_insert_transcript_fragments(
        db,
        media_id,
        transcript_segments,
        now=now,
        transcript_version_id=transcript_version_id,
    )


def _ensure_media_transcript_state_row(
    db: Session,
    *,
    media_id: UUID,
    processing_status: str,
    last_error_code: str | None,
    now: datetime,
    request_reason: str | None = None,
) -> None:
    if processing_status in {"ready_for_reading", "embedding", "ready"}:
        transcript_state = "ready"
    elif processing_status == "extracting":
        transcript_state = "running"
    elif (
        processing_status == "failed"
        and last_error_code == ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value
    ):
        transcript_state = "unavailable"
    elif (
        processing_status == "failed"
        and last_error_code == ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED.value
    ):
        transcript_state = "failed_quota"
    elif processing_status == "failed":
        transcript_state = "failed_provider"
    else:
        transcript_state = "not_requested"

    transcript_coverage = "full" if transcript_state == "ready" else "none"
    db.execute(
        text(
            """
            INSERT INTO media_transcript_states (
                media_id,
                transcript_state,
                transcript_coverage,
                semantic_status,
                active_transcript_version_id,
                last_request_reason,
                last_error_code,
                created_at,
                updated_at
            )
            VALUES (
                :media_id,
                :transcript_state,
                :transcript_coverage,
                'none',
                NULL,
                :last_request_reason,
                :last_error_code,
                :created_at,
                :updated_at
            )
            ON CONFLICT (media_id) DO NOTHING
            """
        ),
        {
            "media_id": media_id,
            "transcript_state": transcript_state,
            "transcript_coverage": transcript_coverage,
            "last_request_reason": request_reason,
            "last_error_code": last_error_code,
            "created_at": now,
            "updated_at": now,
        },
    )


def _set_media_transcript_state(
    db: Session,
    *,
    media_id: UUID,
    transcript_state: str,
    transcript_coverage: str,
    semantic_status: str | None = None,
    active_transcript_version_id: UUID | None = None,
    last_request_reason: str | None = None,
    last_error_code: str | None = None,
    now: datetime,
) -> None:
    db.execute(
        text(
            """
            INSERT INTO media_transcript_states (
                media_id,
                transcript_state,
                transcript_coverage,
                semantic_status,
                active_transcript_version_id,
                last_request_reason,
                last_error_code,
                created_at,
                updated_at
            )
            VALUES (
                :media_id,
                :transcript_state,
                :transcript_coverage,
                COALESCE(:semantic_status, 'none'),
                :active_transcript_version_id,
                :last_request_reason,
                :last_error_code,
                :updated_at,
                :updated_at
            )
            ON CONFLICT (media_id)
            DO UPDATE SET
                transcript_state = EXCLUDED.transcript_state,
                transcript_coverage = EXCLUDED.transcript_coverage,
                semantic_status = COALESCE(:semantic_status, media_transcript_states.semantic_status),
                active_transcript_version_id = COALESCE(
                    EXCLUDED.active_transcript_version_id,
                    media_transcript_states.active_transcript_version_id
                ),
                last_request_reason = COALESCE(
                    EXCLUDED.last_request_reason,
                    media_transcript_states.last_request_reason
                ),
                last_error_code = EXCLUDED.last_error_code,
                updated_at = EXCLUDED.updated_at
            """
        ),
        {
            "media_id": media_id,
            "transcript_state": transcript_state,
            "transcript_coverage": transcript_coverage,
            "semantic_status": semantic_status,
            "active_transcript_version_id": active_transcript_version_id,
            "last_request_reason": last_request_reason,
            "last_error_code": last_error_code,
            "updated_at": now,
        },
    )


def _record_podcast_transcript_request_audit(
    db: Session,
    *,
    media_id: UUID,
    requested_by_user_id: UUID,
    request_reason: str,
    dry_run: bool,
    outcome: str,
    required_minutes: int | None,
    remaining_minutes: int | None,
    fits_budget: bool | None,
    now: datetime,
) -> None:
    db.execute(
        text(
            """
            INSERT INTO podcast_transcript_request_audits (
                media_id,
                requested_by_user_id,
                request_reason,
                dry_run,
                outcome,
                required_minutes,
                remaining_minutes,
                fits_budget,
                created_at
            )
            VALUES (
                :media_id,
                :requested_by_user_id,
                :request_reason,
                :dry_run,
                :outcome,
                :required_minutes,
                :remaining_minutes,
                :fits_budget,
                :created_at
            )
            """
        ),
        {
            "media_id": media_id,
            "requested_by_user_id": requested_by_user_id,
            "request_reason": request_reason,
            "dry_run": dry_run,
            "outcome": outcome,
            "required_minutes": required_minutes,
            "remaining_minutes": remaining_minutes,
            "fits_budget": fits_budget,
            "created_at": now,
        },
    )


def _create_next_transcript_version(
    db: Session,
    *,
    media_id: UUID,
    created_by_user_id: UUID | None,
    request_reason: str,
    now: datetime,
) -> UUID:
    # Serialize version allocation per media to avoid MAX(version_no)+1 races.
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtext(:lock_key))"),
        {"lock_key": f"podcast-transcript-version:{media_id}"},
    )
    db.execute(
        text(
            """
            UPDATE podcast_transcript_versions
            SET is_active = false, updated_at = :updated_at
            WHERE media_id = :media_id
            """
        ),
        {"media_id": media_id, "updated_at": now},
    )
    next_version_no = db.execute(
        text(
            """
            SELECT COALESCE(MAX(version_no), 0) + 1
            FROM podcast_transcript_versions
            WHERE media_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).scalar()
    version_row = db.execute(
        text(
            """
            INSERT INTO podcast_transcript_versions (
                media_id,
                version_no,
                transcript_coverage,
                is_active,
                request_reason,
                created_by_user_id,
                created_at,
                updated_at
            )
            VALUES (
                :media_id,
                :version_no,
                'full',
                true,
                :request_reason,
                :created_by_user_id,
                :created_at,
                :updated_at
            )
            RETURNING id
            """
        ),
        {
            "media_id": media_id,
            "version_no": int(next_version_no or 1),
            "request_reason": request_reason,
            "created_by_user_id": created_by_user_id,
            "created_at": now,
            "updated_at": now,
        },
    ).fetchone()
    assert version_row is not None
    return version_row[0]


def _insert_transcript_segments_for_version(
    db: Session,
    *,
    media_id: UUID,
    transcript_version_id: UUID,
    transcript_segments: list[dict[str, Any]],
    now: datetime,
) -> None:
    for segment_idx, segment in enumerate(transcript_segments):
        db.execute(
            text(
                """
                INSERT INTO podcast_transcript_segments (
                    transcript_version_id,
                    media_id,
                    segment_idx,
                    canonical_text,
                    t_start_ms,
                    t_end_ms,
                    speaker_label,
                    created_at
                )
                VALUES (
                    :transcript_version_id,
                    :media_id,
                    :segment_idx,
                    :canonical_text,
                    :t_start_ms,
                    :t_end_ms,
                    :speaker_label,
                    :created_at
                )
                """
            ),
            {
                "transcript_version_id": transcript_version_id,
                "media_id": media_id,
                "segment_idx": segment_idx,
                "canonical_text": segment["text"],
                "t_start_ms": segment["t_start_ms"],
                "t_end_ms": segment["t_end_ms"],
                "speaker_label": segment.get("speaker_label"),
                "created_at": now,
            },
        )


def _insert_transcript_chunks_for_version(
    db: Session,
    *,
    media_id: UUID,
    transcript_version_id: UUID,
    transcript_segments: list[dict[str, Any]],
    now: datetime,
) -> None:
    chunks = chunk_transcript_segments(transcript_segments)
    embedding_dims = transcript_embedding_dimensions()
    for chunk in chunks:
        db.execute(
            text(
                f"""
                INSERT INTO podcast_transcript_chunks (
                    transcript_version_id,
                    media_id,
                    chunk_idx,
                    chunk_text,
                    t_start_ms,
                    t_end_ms,
                    embedding,
                    embedding_vector,
                    embedding_model,
                    created_at
                )
                VALUES (
                    :transcript_version_id,
                    :media_id,
                    :chunk_idx,
                    :chunk_text,
                    :t_start_ms,
                    :t_end_ms,
                    CAST(:embedding AS jsonb),
                    CAST(:embedding_vector AS vector({embedding_dims})),
                    :embedding_model,
                    :created_at
                )
                """
            ),
            {
                "transcript_version_id": transcript_version_id,
                "media_id": media_id,
                "chunk_idx": chunk["chunk_idx"],
                "chunk_text": chunk["chunk_text"],
                "t_start_ms": chunk["t_start_ms"],
                "t_end_ms": chunk["t_end_ms"],
                "embedding": json.dumps(chunk["embedding"]),
                "embedding_vector": to_pgvector_literal(chunk["embedding"]),
                "embedding_model": chunk["embedding_model"],
                "created_at": now,
            },
        )


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


def _get_usage_snapshot(
    db: Session,
    *,
    viewer_id: UUID,
    usage_date: date,
) -> dict[str, int]:
    row = db.execute(
        text(
            """
            SELECT minutes_used, minutes_reserved
            FROM podcast_transcription_usage_daily
            WHERE user_id = :user_id AND usage_date = :usage_date
            """
        ),
        {"user_id": viewer_id, "usage_date": usage_date},
    ).fetchone()
    used_minutes = int((row[0] if row is not None else 0) or 0)
    reserved_minutes = int((row[1] if row is not None else 0) or 0)
    return {
        "used": used_minutes,
        "reserved": reserved_minutes,
        "total": used_minutes + reserved_minutes,
    }


def _reserve_usage_minutes_or_raise(
    db: Session,
    *,
    user_id: UUID,
    usage_date: date,
    required_minutes: int,
    daily_limit_minutes: int | None,
    now: datetime,
) -> dict[str, int]:
    if required_minutes <= 0:
        return _get_usage_snapshot(db, viewer_id=user_id, usage_date=usage_date)

    if daily_limit_minutes is None:
        row = db.execute(
            text(
                """
                INSERT INTO podcast_transcription_usage_daily (
                    user_id,
                    usage_date,
                    minutes_used,
                    minutes_reserved,
                    updated_at
                )
                VALUES (
                    :user_id,
                    :usage_date,
                    0,
                    :minutes_reserved,
                    :updated_at
                )
                ON CONFLICT (user_id, usage_date)
                DO UPDATE SET
                    minutes_reserved = (
                        podcast_transcription_usage_daily.minutes_reserved
                        + EXCLUDED.minutes_reserved
                    ),
                    updated_at = EXCLUDED.updated_at
                RETURNING minutes_used, minutes_reserved
                """
            ),
            {
                "user_id": user_id,
                "usage_date": usage_date,
                "minutes_reserved": required_minutes,
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
                    minutes_reserved,
                    updated_at
                )
                SELECT
                    :user_id,
                    :usage_date,
                    0,
                    :minutes_reserved,
                    :updated_at
                WHERE :minutes_reserved <= :daily_limit_minutes
                ON CONFLICT (user_id, usage_date)
                DO UPDATE SET
                    minutes_reserved = (
                        podcast_transcription_usage_daily.minutes_reserved
                        + EXCLUDED.minutes_reserved
                    ),
                    updated_at = EXCLUDED.updated_at
                WHERE (
                    podcast_transcription_usage_daily.minutes_used
                    + podcast_transcription_usage_daily.minutes_reserved
                    + EXCLUDED.minutes_reserved
                    <= :daily_limit_minutes
                )
                RETURNING minutes_used, minutes_reserved
                """
            ),
            {
                "user_id": user_id,
                "usage_date": usage_date,
                "minutes_reserved": required_minutes,
                "daily_limit_minutes": daily_limit_minutes,
                "updated_at": now,
            },
        ).fetchone()

    if row is None:
        usage_snapshot = _get_usage_snapshot(db, viewer_id=user_id, usage_date=usage_date)
        logger.warning(
            "podcast_quota_exceeded",
            viewer_id=str(user_id),
            usage_date=usage_date.isoformat(),
            used_minutes=usage_snapshot["used"],
            reserved_minutes=usage_snapshot["reserved"],
            required_minutes=required_minutes,
            daily_limit_minutes=daily_limit_minutes,
        )
        raise ApiError(
            ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED,
            "Daily podcast transcription quota exceeded",
        )
    used_after = int(row[0] or 0)
    reserved_after = int(row[1] or 0)
    return {
        "used": used_after,
        "reserved": reserved_after,
        "total": used_after + reserved_after,
    }


def _clear_job_reservation(
    db: Session,
    *,
    media_id: UUID,
    now: datetime,
) -> None:
    db.execute(
        text(
            """
            UPDATE podcast_transcription_jobs
            SET
                reserved_minutes = 0,
                reservation_usage_date = NULL,
                updated_at = :now
            WHERE media_id = :media_id
            """
        ),
        {"media_id": media_id, "now": now},
    )


def _release_reserved_usage_for_media(
    db: Session,
    *,
    media_id: UUID,
    now: datetime,
) -> None:
    reservation_row = db.execute(
        text(
            """
            SELECT requested_by_user_id, reservation_usage_date, reserved_minutes
            FROM podcast_transcription_jobs
            WHERE media_id = :media_id
            FOR UPDATE
            """
        ),
        {"media_id": media_id},
    ).fetchone()
    if reservation_row is None:
        return

    user_id = reservation_row[0]
    usage_date = reservation_row[1]
    reserved_minutes = int(reservation_row[2] or 0)
    if user_id is not None and usage_date is not None and reserved_minutes > 0:
        db.execute(
            text(
                """
                UPDATE podcast_transcription_usage_daily
                SET
                    minutes_reserved = GREATEST(minutes_reserved - :reserved_minutes, 0),
                    updated_at = :updated_at
                WHERE user_id = :user_id
                  AND usage_date = :usage_date
                """
            ),
            {
                "user_id": user_id,
                "usage_date": usage_date,
                "reserved_minutes": reserved_minutes,
                "updated_at": now,
            },
        )
    _clear_job_reservation(db, media_id=media_id, now=now)


def _commit_reserved_usage_for_media(
    db: Session,
    *,
    media_id: UUID,
    now: datetime,
) -> None:
    reservation_row = db.execute(
        text(
            """
            SELECT requested_by_user_id, reservation_usage_date, reserved_minutes
            FROM podcast_transcription_jobs
            WHERE media_id = :media_id
            FOR UPDATE
            """
        ),
        {"media_id": media_id},
    ).fetchone()
    if reservation_row is None:
        return

    user_id = reservation_row[0]
    usage_date = reservation_row[1]
    reserved_minutes = int(reservation_row[2] or 0)
    if user_id is None or usage_date is None or reserved_minutes <= 0:
        _clear_job_reservation(db, media_id=media_id, now=now)
        return

    db.execute(
        text(
            """
            INSERT INTO podcast_transcription_usage_daily (
                user_id,
                usage_date,
                minutes_used,
                minutes_reserved,
                updated_at
            )
            VALUES (
                :user_id,
                :usage_date,
                :minutes_used,
                0,
                :updated_at
            )
            ON CONFLICT (user_id, usage_date)
            DO UPDATE SET
                minutes_used = (
                    podcast_transcription_usage_daily.minutes_used + EXCLUDED.minutes_used
                ),
                minutes_reserved = GREATEST(
                    podcast_transcription_usage_daily.minutes_reserved - EXCLUDED.minutes_used,
                    0
                ),
                updated_at = EXCLUDED.updated_at
            """
        ),
        {
            "user_id": user_id,
            "usage_date": usage_date,
            "minutes_used": reserved_minutes,
            "updated_at": now,
        },
    )
    _clear_job_reservation(db, media_id=media_id, now=now)


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
    episode_by_dedupe_key = {_episode_dedupe_key(episode): episode for episode in combined}
    seen = set(episode_by_dedupe_key.keys())
    for episode in supplemental:
        dedupe_key = _episode_dedupe_key(episode)
        if dedupe_key in seen:
            existing = episode_by_dedupe_key.get(dedupe_key)
            if existing is not None:
                if existing.get("rss_chapters") is None and episode.get("rss_chapters") is not None:
                    existing["rss_chapters"] = episode.get("rss_chapters")
                if not existing.get("description_html") and episode.get("description_html"):
                    existing["description_html"] = episode.get("description_html")
                if not existing.get("description_text") and episode.get("description_text"):
                    existing["description_text"] = episode.get("description_text")
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
        episode.setdefault("description_html", None)
        episode.setdefault("description_text", None)

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
            if not episode.get("description_html"):
                episode["description_html"] = feed_episode.get("description_html")
            if not episode.get("description_text"):
                episode["description_text"] = feed_episode.get("description_text")
            break

    return selected_episodes


def _validate_and_normalize_feed_url(feed_url: str) -> str:
    validate_requested_url(feed_url)
    normalized = normalize_url_for_display(feed_url)
    split = urlsplit(normalized)
    normalized_path = split.path or ""
    if normalized_path and normalized_path != "/":
        normalized_path = normalized_path.rstrip("/")
    if not normalized_path:
        normalized_path = "/"
    return urlunsplit((split.scheme, split.netloc, normalized_path, split.query, ""))


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
        episode = _episode_from_feed_item(item, base_url=str(response.url))
        if episode is not None:
            episodes.append(episode)

    next_page_url = _extract_feed_next_page_url(root, str(response.url))
    return episodes, next_page_url


def _episode_from_feed_item(item: Any, *, base_url: str | None = None) -> dict[str, Any] | None:
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

    provider_episode_id = guid or audio_url
    if not provider_episode_id:
        seed = f"{title}|{published_at or ''}"
        provider_episode_id = f"feed-{hashlib.sha1(seed.encode()).hexdigest()}"

    chapter_rows = _extract_rss_chapters_from_feed_item(item, base_url=base_url)

    return {
        "provider_episode_id": provider_episode_id,
        "guid": guid,
        "title": title,
        "audio_url": audio_url,
        "published_at": published_at,
        "duration_seconds": duration_seconds,
        "description_html": description_html,
        "description_text": description_text,
        "transcript_segments": None,
        "rss_chapters": chapter_rows,
    }


def _extract_episode_show_notes_from_feed_item(
    item: Any,
    *,
    base_url: str | None,
) -> tuple[str | None, str | None]:
    raw_content_encoded = str(item.xpath(f"string(./{_PODCAST_CONTENT_ENCODED_XPATH})") or "").strip()
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
    normalized_text = _normalize_optional_text(_extract_plain_text_from_html_fragment(description_text_source))
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
