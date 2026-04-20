"""Global acquisition browse service."""

from __future__ import annotations

import base64
import json
import time
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.logging import get_logger
from nexus.services import podcasts as podcast_service

logger = get_logger(__name__)

BrowseSectionType = Literal["documents", "videos", "podcasts", "podcast_episodes"]

BROWSE_SECTION_TYPES: tuple[BrowseSectionType, ...] = (
    "documents",
    "videos",
    "podcasts",
    "podcast_episodes",
)
MAX_BROWSE_LIMIT = 20
DEFAULT_BROWSE_LIMIT = 10
_BROWSE_PROVIDER_MAX_ATTEMPTS = 3
_BROWSE_PROVIDER_RETRYABLE_STATUS_CODES = {408, 429, 500, 502, 503, 504}
_BROWSE_PROVIDER_BACKOFF_SECONDS = (0.25, 0.75, 1.5)
_BROWSE_PROVIDER_TIMEOUT = 15.0
_BRAVE_WEB_RESULT_MAX_OFFSET = 9
_YOUTUBE_WATCH_URL = "https://www.youtube.com/watch?v={video_id}"


def browse_content(
    db: Session,
    query: str,
    *,
    limit: int = DEFAULT_BROWSE_LIMIT,
    page_type: BrowseSectionType | None = None,
    cursor: str | None = None,
) -> dict[str, object]:
    """Return browse acquisition results grouped by globally-searched type."""
    trimmed_query = query.strip()
    if not trimmed_query:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Query must not be empty")
    if limit <= 0 or limit > MAX_BROWSE_LIMIT:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid browse limit")
    if page_type is None and cursor is not None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "page_type is required when cursor is provided",
        )
    if page_type is not None and page_type not in BROWSE_SECTION_TYPES:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid browse page type")

    if page_type is not None:
        return {
            "query": trimmed_query,
            "sections": {
                page_type: _browse_section(
                    db,
                    trimmed_query,
                    page_type=page_type,
                    limit=limit,
                    cursor=cursor,
                )
            },
        }

    initial_podcast_rows = podcast_service.discover_podcasts(
        db,
        trimmed_query,
        limit=max(limit + 1, 10),
    )
    sections: dict[str, object] = {}
    for section_type in BROWSE_SECTION_TYPES:
        sections[section_type] = _browse_section(
            db,
            trimmed_query,
            page_type=section_type,
            limit=limit,
            cursor=None,
            podcast_rows=initial_podcast_rows,
        )
    return {"query": trimmed_query, "sections": sections}


def _browse_section(
    db: Session,
    query: str,
    *,
    page_type: BrowseSectionType,
    limit: int,
    cursor: str | None,
    podcast_rows: list[Any] | None = None,
) -> dict[str, object]:
    if page_type == "documents":
        return _browse_documents(query, limit=limit, cursor=cursor)
    if page_type == "videos":
        return _browse_videos(query, limit=limit, cursor=cursor)
    if page_type == "podcasts":
        return _browse_podcasts(
            db,
            query,
            limit=limit,
            cursor=cursor,
            podcast_rows=podcast_rows,
        )
    return _browse_podcast_episodes(
        db,
        query,
        limit=limit,
        cursor=cursor,
        podcast_rows=podcast_rows,
    )


def _browse_documents(query: str, *, limit: int, cursor: str | None) -> dict[str, object]:
    page_index = 0
    if cursor is not None:
        page_index = int(_decode_browse_cursor(cursor, query, "documents").get("offset", 0))

    rows = _search_document_rows(query, limit=limit, page_index=page_index)
    has_more = len(rows) == limit and page_index < _BRAVE_WEB_RESULT_MAX_OFFSET
    next_cursor = (
        _encode_browse_cursor(query, "documents", {"offset": page_index + 1}) if has_more else None
    )
    return {
        "results": rows,
        "page": {
            "has_more": has_more,
            "next_cursor": next_cursor,
        },
    }


def _browse_videos(query: str, *, limit: int, cursor: str | None) -> dict[str, object]:
    page_token = None
    if cursor is not None:
        decoded = _decode_browse_cursor(cursor, query, "videos")
        page_token = _string_or_none(decoded.get("page_token"))

    rows, next_page_token = _search_video_rows(query, limit=limit, page_token=page_token)
    next_cursor = (
        _encode_browse_cursor(query, "videos", {"page_token": next_page_token})
        if next_page_token
        else None
    )
    return {
        "results": rows,
        "page": {
            "has_more": next_page_token is not None,
            "next_cursor": next_cursor,
        },
    }


def _browse_podcasts(
    db: Session,
    query: str,
    *,
    limit: int,
    cursor: str | None,
    podcast_rows: list[Any] | None = None,
) -> dict[str, object]:
    offset = 0
    if cursor is not None:
        offset = int(_decode_browse_cursor(cursor, query, "podcasts").get("offset", 0))

    candidate_limit = offset + limit + 1
    candidates = podcast_rows
    if candidates is None:
        candidates = podcast_service.discover_podcasts(db, query, limit=candidate_limit)
    page_rows = [_to_podcast_result(row) for row in candidates[offset : offset + limit]]
    has_more = len(candidates) > offset + limit
    next_cursor = (
        _encode_browse_cursor(query, "podcasts", {"offset": offset + limit}) if has_more else None
    )
    return {
        "results": page_rows,
        "page": {
            "has_more": has_more,
            "next_cursor": next_cursor,
        },
    }


def _browse_podcast_episodes(
    db: Session,
    query: str,
    *,
    limit: int,
    cursor: str | None,
    podcast_rows: list[Any] | None = None,
) -> dict[str, object]:
    offset = 0
    if cursor is not None:
        offset = int(_decode_browse_cursor(cursor, query, "podcast_episodes").get("offset", 0))

    target_count = offset + limit + 1
    podcast_limit = max(target_count, 10)
    if podcast_rows is None:
        podcast_rows = podcast_service.discover_podcasts(db, query, limit=podcast_limit)
    client = podcast_service.get_podcast_index_client()
    per_podcast_limit = get_settings().podcast_initial_episode_window

    episode_rows: list[dict[str, object]] = []
    for podcast in podcast_rows:
        recent_episodes = client.fetch_recent_episodes(
            podcast.provider_podcast_id, per_podcast_limit
        )
        for episode in recent_episodes:
            episode_rows.append(_to_podcast_episode_result(podcast, episode))
            if len(episode_rows) >= target_count:
                break
        if len(episode_rows) >= target_count:
            break

    page_rows = episode_rows[offset : offset + limit]
    has_more = len(episode_rows) > offset + limit
    next_cursor = (
        _encode_browse_cursor(query, "podcast_episodes", {"offset": offset + limit})
        if has_more
        else None
    )
    return {
        "results": page_rows,
        "page": {
            "has_more": has_more,
            "next_cursor": next_cursor,
        },
    }


def _search_document_rows(query: str, *, limit: int, page_index: int) -> list[dict[str, object]]:
    settings = get_settings()
    if not settings.brave_search_api_key:
        raise ApiError(
            ApiErrorCode.E_BROWSE_PROVIDER_UNAVAILABLE,
            "Browse document provider credentials are not configured",
        )

    payload = _get_json(
        f"{settings.brave_search_base_url.rstrip('/')}/web/search",
        headers={
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": settings.brave_search_api_key,
        },
        params={
            "q": f"{query} filetype:pdf OR {query} ext:epub",
            "count": limit,
            "offset": page_index,
            "result_filter": "web",
            "operators": "true",
        },
        provider_name="brave_search_documents",
    )
    web_results = payload.get("web", {})
    candidates = web_results.get("results", []) if isinstance(web_results, dict) else []
    rows: list[dict[str, object]] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        url = str(candidate.get("url") or "").strip()
        document_kind = _document_kind_from_url(url)
        if document_kind is None:
            continue
        rows.append(
            {
                "type": "documents",
                "title": str(candidate.get("title") or "Untitled document"),
                "description": _string_or_none(candidate.get("description")),
                "url": url,
                "document_kind": document_kind,
                "site_name": _site_name_from_url(url),
            }
        )
    return rows


def _search_video_rows(
    query: str,
    *,
    limit: int,
    page_token: str | None,
) -> tuple[list[dict[str, object]], str | None]:
    settings = get_settings()
    if not settings.youtube_data_api_key:
        raise ApiError(
            ApiErrorCode.E_BROWSE_PROVIDER_UNAVAILABLE,
            "Browse video provider credentials are not configured",
        )

    params: dict[str, object] = {
        "key": settings.youtube_data_api_key,
        "part": "snippet",
        "q": query,
        "type": "video",
        "maxResults": limit,
        "safeSearch": "moderate",
    }
    if page_token:
        params["pageToken"] = page_token

    payload = _get_json(
        f"{settings.youtube_data_base_url.rstrip('/')}/search",
        headers={"Accept": "application/json"},
        params=params,
        provider_name="youtube_data_videos",
    )

    items = payload.get("items", [])
    rows: list[dict[str, object]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        identity = item.get("id", {})
        snippet = item.get("snippet", {})
        if not isinstance(identity, dict) or not isinstance(snippet, dict):
            continue
        video_id = str(identity.get("videoId") or "").strip()
        if not video_id:
            continue
        rows.append(
            {
                "type": "videos",
                "provider_video_id": video_id,
                "title": str(snippet.get("title") or "Untitled video"),
                "description": _string_or_none(snippet.get("description")),
                "watch_url": _YOUTUBE_WATCH_URL.format(video_id=video_id),
                "channel_title": _string_or_none(snippet.get("channelTitle")),
                "published_at": _string_or_none(snippet.get("publishedAt")),
                "thumbnail_url": _youtube_thumbnail_url(snippet.get("thumbnails")),
            }
        )
    return rows, _string_or_none(payload.get("nextPageToken"))


def _to_podcast_result(row: Any) -> dict[str, object]:
    return {
        "type": "podcasts",
        "podcast_id": str(row.podcast_id) if getattr(row, "podcast_id", None) is not None else None,
        "provider_podcast_id": row.provider_podcast_id,
        "title": row.title,
        "author": row.author,
        "feed_url": row.feed_url,
        "website_url": row.website_url,
        "image_url": row.image_url,
        "description": row.description,
    }


def _to_podcast_episode_result(podcast: Any, episode: dict[str, object]) -> dict[str, object]:
    return {
        "type": "podcast_episodes",
        "podcast_id": str(podcast.podcast_id)
        if getattr(podcast, "podcast_id", None) is not None
        else None,
        "provider_podcast_id": podcast.provider_podcast_id,
        "provider_episode_id": episode["provider_episode_id"],
        "podcast_title": podcast.title,
        "podcast_author": podcast.author,
        "podcast_image_url": podcast.image_url,
        "title": episode["title"],
        "audio_url": episode["audio_url"],
        "published_at": episode.get("published_at"),
        "duration_seconds": episode.get("duration_seconds"),
        "feed_url": podcast.feed_url,
        "website_url": podcast.website_url,
        "description": podcast.description,
    }


def _encode_browse_cursor(
    query: str,
    page_type: BrowseSectionType,
    payload: dict[str, object],
) -> str:
    json_bytes = json.dumps(
        {
            "query": query,
            "page_type": page_type,
            **payload,
        }
    ).encode("utf-8")
    return base64.urlsafe_b64encode(json_bytes).decode("ascii").rstrip("=")


def _decode_browse_cursor(
    cursor: str,
    query: str,
    page_type: BrowseSectionType,
) -> dict[str, Any]:
    try:
        padding = 4 - len(cursor) % 4
        if padding != 4:
            cursor += "=" * padding
        json_bytes = base64.urlsafe_b64decode(cursor)
        payload = json.loads(json_bytes.decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("Cursor payload must be an object")
        if payload.get("query") != query:
            raise ValueError("Cursor query mismatch")
        if payload.get("page_type") != page_type:
            raise ValueError("Cursor type mismatch")
        return payload
    except Exception:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from None


def _get_json(
    url: str,
    *,
    headers: dict[str, str],
    params: dict[str, object],
    provider_name: str,
) -> dict[str, Any]:
    last_error: Exception | None = None
    with httpx.Client(timeout=_BROWSE_PROVIDER_TIMEOUT, trust_env=False) as client:
        for attempt_index in range(_BROWSE_PROVIDER_MAX_ATTEMPTS):
            try:
                response = client.get(url, headers=headers, params=params)
                if (
                    response.status_code in _BROWSE_PROVIDER_RETRYABLE_STATUS_CODES
                    and attempt_index < _BROWSE_PROVIDER_MAX_ATTEMPTS - 1
                ):
                    logger.warning(
                        "browse_provider_retryable_http_error",
                        provider=provider_name,
                        status_code=response.status_code,
                        attempt=attempt_index + 1,
                    )
                    time.sleep(_BROWSE_PROVIDER_BACKOFF_SECONDS[attempt_index])
                    continue
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, dict):
                    raise ApiError(
                        ApiErrorCode.E_BROWSE_PROVIDER_UNAVAILABLE,
                        "Browse provider returned an invalid response",
                    )
                return payload
            except httpx.HTTPStatusError as exc:
                last_error = exc
                break
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                last_error = exc
                if attempt_index < _BROWSE_PROVIDER_MAX_ATTEMPTS - 1:
                    logger.warning(
                        "browse_provider_retryable_transport_error",
                        provider=provider_name,
                        attempt=attempt_index + 1,
                        error=str(exc),
                    )
                    time.sleep(_BROWSE_PROVIDER_BACKOFF_SECONDS[attempt_index])
                    continue
                break
            except Exception as exc:
                last_error = exc
                break

    raise ApiError(
        ApiErrorCode.E_BROWSE_PROVIDER_UNAVAILABLE,
        f"{provider_name} request failed",
    ) from last_error


def _document_kind_from_url(url: str) -> str | None:
    try:
        path = urlsplit(url).path.lower()
    except Exception:
        return None
    if path.endswith(".pdf"):
        return "pdf"
    if path.endswith(".epub"):
        return "epub"
    return None


def _site_name_from_url(url: str) -> str | None:
    try:
        host = urlsplit(url).hostname
    except Exception:
        return None
    if not host:
        return None
    if host.startswith("www."):
        return host[4:]
    return host


def _string_or_none(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _youtube_thumbnail_url(value: object) -> str | None:
    if not isinstance(value, dict):
        return None
    for key in ("high", "medium", "default"):
        candidate = value.get(key)
        if not isinstance(candidate, dict):
            continue
        url = _string_or_none(candidate.get("url"))
        if url:
            return url
    return None
