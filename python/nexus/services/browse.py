"""Global acquisition browse service."""

from __future__ import annotations

import base64
import json
import time
from typing import Any, Literal
from urllib.parse import urlsplit
from uuid import UUID

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.logging import get_logger
from nexus.services import podcasts as podcast_service
from nexus.services.search import visible_media_ids_cte_sql

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
_PROJECT_GUTENBERG_LANDING_URL = "https://www.gutenberg.org/ebooks/{ebook_id}"
_PROJECT_GUTENBERG_EPUB_IMPORT_URL = "https://www.gutenberg.org/ebooks/{ebook_id}.epub.noimages"
_YOUTUBE_WATCH_URL = "https://www.youtube.com/watch?v={video_id}"


def browse_content(
    db: Session,
    viewer_id: UUID,
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
                    viewer_id,
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
            viewer_id,
            trimmed_query,
            page_type=section_type,
            limit=limit,
            cursor=None,
            podcast_rows=initial_podcast_rows,
        )
    return {"query": trimmed_query, "sections": sections}


def _browse_section(
    db: Session,
    viewer_id: UUID,
    query: str,
    *,
    page_type: BrowseSectionType,
    limit: int,
    cursor: str | None,
    podcast_rows: list[Any] | None = None,
) -> dict[str, object]:
    if page_type == "documents":
        return _browse_documents(db, viewer_id, query, limit=limit, cursor=cursor)
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


def _browse_documents(
    db: Session,
    viewer_id: UUID,
    query: str,
    *,
    limit: int,
    cursor: str | None,
) -> dict[str, object]:
    phase = "nexus"
    nexus_offset = 0
    gutenberg_offset = 0
    if cursor is not None:
        decoded = _decode_browse_cursor(cursor, query, "documents")
        try:
            phase = str(decoded.get("phase") or "nexus")
            if phase not in {"nexus", "gutenberg"}:
                raise ValueError("Invalid document browse phase")
            nexus_offset = int(decoded.get("nexus_offset", 0))
            gutenberg_offset = int(decoded.get("gutenberg_offset", 0))
            if nexus_offset < 0 or gutenberg_offset < 0:
                raise ValueError("Negative document browse offsets are invalid")
        except Exception:
            raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from None

    if phase == "gutenberg":
        gutenberg_rows = _search_project_gutenberg_rows(
            db,
            query,
            limit=limit + 1,
            offset=gutenberg_offset,
        )
        page_rows = gutenberg_rows[:limit]
        has_more = len(gutenberg_rows) > limit
        next_cursor = (
            _encode_browse_cursor(
                query,
                "documents",
                {
                    "phase": "gutenberg",
                    "gutenberg_offset": gutenberg_offset + limit,
                },
            )
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

    nexus_rows = _search_nexus_document_rows(
        db,
        viewer_id,
        query,
        limit=limit + 1,
        offset=nexus_offset,
    )
    if len(nexus_rows) > limit:
        page_rows = nexus_rows[:limit]
        next_cursor = _encode_browse_cursor(
            query,
            "documents",
            {
                "phase": "nexus",
                "nexus_offset": nexus_offset + limit,
            },
        )
        return {
            "results": page_rows,
            "page": {
                "has_more": True,
                "next_cursor": next_cursor,
            },
        }

    page_rows = list(nexus_rows)
    remaining = limit - len(page_rows)
    gutenberg_rows = _search_project_gutenberg_rows(
        db,
        query,
        limit=remaining + 1,
        offset=0,
    )
    page_rows.extend(gutenberg_rows[:remaining])
    has_more = len(gutenberg_rows) > remaining
    next_cursor = (
        _encode_browse_cursor(
            query,
            "documents",
            {
                "phase": "gutenberg",
                "gutenberg_offset": remaining,
            },
        )
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


def _search_nexus_document_rows(
    db: Session,
    viewer_id: UUID,
    query: str,
    *,
    limit: int,
    offset: int,
) -> list[dict[str, object]]:
    raw_rows = db.execute(
        text(
            f"""
            WITH
                visible_media AS ({visible_media_ids_cte_sql()}),
                title_hits AS (
                    SELECT
                        m.id AS media_id,
                        ts_rank_cd(m.title_tsv, websearch_to_tsquery('english', :query)) * 1.2 AS score,
                        NULL::text AS snippet
                    FROM media m
                    JOIN visible_media vm ON vm.media_id = m.id
                    WHERE m.kind IN ('web_article', 'epub', 'pdf')
                      AND m.title_tsv @@ websearch_to_tsquery('english', :query)
                ),
                fragment_hits AS (
                    SELECT
                        m.id AS media_id,
                        ts_rank_cd(f.canonical_text_tsv, websearch_to_tsquery('english', :query)) AS score,
                        ts_headline(
                            'english',
                            f.canonical_text,
                            websearch_to_tsquery('english', :query),
                            'StartSel=, StopSel=, MaxWords=24, MinWords=8, MaxFragments=1'
                        ) AS snippet
                    FROM fragments f
                    JOIN media m ON m.id = f.media_id
                    JOIN visible_media vm ON vm.media_id = m.id
                    WHERE m.kind IN ('web_article', 'epub', 'pdf')
                      AND f.canonical_text_tsv @@ websearch_to_tsquery('english', :query)
                ),
                candidate_hits AS (
                    SELECT * FROM title_hits
                    UNION ALL
                    SELECT * FROM fragment_hits
                ),
                best_hits AS (
                    SELECT DISTINCT ON (media_id)
                        media_id,
                        score,
                        snippet
                    FROM candidate_hits
                    ORDER BY media_id, score DESC
                )
            SELECT
                m.id,
                m.kind,
                m.title,
                m.description,
                m.requested_url,
                m.canonical_source_url,
                best_hits.snippet
            FROM best_hits
            JOIN media m ON m.id = best_hits.media_id
            ORDER BY best_hits.score DESC, m.updated_at DESC, m.id DESC
            OFFSET :offset
            LIMIT :limit
            """
        ),
        {
            "viewer_id": viewer_id,
            "query": query,
            "offset": offset,
            "limit": limit,
        },
    ).mappings()
    results: list[dict[str, object]] = []
    for row in raw_rows:
        source_url = _string_or_none(row["requested_url"]) or _string_or_none(
            row["canonical_source_url"]
        )
        media_id = str(row["id"])
        document_kind = str(row["kind"])
        results.append(
            {
                "type": "documents",
                "title": str(row["title"] or "Untitled document"),
                "description": _string_or_none(row["snippet"])
                or _string_or_none(row["description"]),
                "url": source_url or f"nexus://media/{media_id}",
                "document_kind": document_kind,
                "site_name": _site_name_from_url(source_url) if source_url else None,
                "source_label": "Nexus",
                "source_type": "nexus",
                "media_id": media_id,
            }
        )
    return results


def _search_project_gutenberg_rows(
    db: Session,
    query: str,
    *,
    limit: int,
    offset: int,
) -> list[dict[str, object]]:
    raw_rows = db.execute(
        text(
            """
            WITH search_hits AS (
                SELECT
                    ebook_id,
                    title,
                    authors,
                    subjects,
                    bookshelves,
                    download_count,
                    ts_rank_cd(
                        to_tsvector(
                            'english',
                            concat_ws(
                                ' ',
                                coalesce(title, ''),
                                coalesce(authors, ''),
                                coalesce(subjects, ''),
                                coalesce(bookshelves, '')
                            )
                        ),
                        websearch_to_tsquery('english', :query)
                    ) AS score
                FROM project_gutenberg_catalog
                WHERE to_tsvector(
                        'english',
                        concat_ws(
                            ' ',
                            coalesce(title, ''),
                            coalesce(authors, ''),
                            coalesce(subjects, ''),
                            coalesce(bookshelves, '')
                        )
                    ) @@ websearch_to_tsquery('english', :query)
            )
            SELECT
                ebook_id,
                title,
                authors,
                subjects,
                bookshelves,
                download_count
            FROM search_hits
            ORDER BY score DESC, download_count DESC NULLS LAST, ebook_id ASC
            OFFSET :offset
            LIMIT :limit
            """
        ),
        {
            "query": query,
            "offset": offset,
            "limit": limit,
        },
    ).mappings()
    results: list[dict[str, object]] = []
    for row in raw_rows:
        ebook_id = int(row["ebook_id"])
        landing_url = _PROJECT_GUTENBERG_LANDING_URL.format(ebook_id=ebook_id)
        import_url = _PROJECT_GUTENBERG_EPUB_IMPORT_URL.format(ebook_id=ebook_id)
        description = (
            _string_or_none(row["authors"])
            or _string_or_none(row["bookshelves"])
            or _string_or_none(row["subjects"])
        )
        results.append(
            {
                "type": "documents",
                "title": str(row["title"] or "Untitled document"),
                "description": description,
                "url": import_url,
                "document_kind": "epub",
                "site_name": "gutenberg.org",
                "source_label": "Project Gutenberg",
                "source_type": "project_gutenberg",
                "landing_url": landing_url,
                "author": _string_or_none(row["authors"]),
                "media_id": None,
            }
        )
    return results


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
