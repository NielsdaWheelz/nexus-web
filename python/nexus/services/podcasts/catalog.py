"""Podcast discovery and catalog read/write services."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.db.session import transaction
from nexus.errors import (
    ApiErrorCode,
    InvalidRequestError,
    NotFoundError,
)
from nexus.logging import get_logger
from nexus.schemas.media import MediaOut
from nexus.schemas.podcast import (
    PodcastDetailOut,
    PodcastDiscoveryOut,
    PodcastEnsureOut,
    PodcastEnsureRequest,
    PodcastListItemOut,
    PodcastSubscribeRequest,
    PodcastSubscriptionListItemOut,
    PodcastSubscriptionStatusOut,
    PodcastSubscriptionVisibleLibraryOut,
)
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url

from .provider import PODCAST_PROVIDER, get_podcast_index_client

logger = get_logger(__name__)

PODCAST_EPISODE_STATES = {"all", "unplayed", "in_progress", "played"}
PODCAST_EPISODE_SORT_OPTIONS = {"newest", "oldest", "duration_asc", "duration_desc"}
PODCAST_SUBSCRIPTION_SORT_OPTIONS = {"recent_episode", "unplayed_count", "alpha"}
PODCAST_SUBSCRIPTION_FILTER_OPTIONS = {"all", "has_new", "not_in_library"}
PODCAST_EPISODE_SHOW_NOTES_LIST_PREVIEW_MAX_CHARS = 300


def discover_podcasts(
    db: Session,
    query: str,
    *,
    limit: int = 10,
) -> list[PodcastDiscoveryOut]:
    query = query.strip()
    if not query:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Query must not be empty")
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")

    client = get_podcast_index_client()
    rows = client.search_podcasts(query, limit)
    results: list[PodcastDiscoveryOut] = []
    for row in rows:
        feed_url = row["feed_url"]
        try:
            feed_url = _validate_and_normalize_feed_url(feed_url)
        except InvalidRequestError:
            pass

        podcast_id = _select_podcast_id_by_provider_id(db, row["provider_podcast_id"])
        if podcast_id is None:
            podcast_id = _select_podcast_id_by_feed_url(db, feed_url)

        results.append(
            PodcastDiscoveryOut(
                podcast_id=podcast_id,
                provider_podcast_id=row["provider_podcast_id"],
                title=row["title"],
                author=row["author"],
                feed_url=feed_url,
                website_url=row["website_url"],
                image_url=row["image_url"],
                description=row["description"],
            )
        )
    return results


def ensure_podcast(
    db: Session,
    body: PodcastEnsureRequest,
) -> PodcastEnsureOut:
    normalized_feed_url = _validate_and_normalize_feed_url(body.feed_url)
    normalized_body = body.model_copy(update={"feed_url": normalized_feed_url})
    now = datetime.now(UTC)

    with transaction(db):
        podcast_id = _select_podcast_id_by_provider_id(db, normalized_body.provider_podcast_id)
        if podcast_id is not None:
            feed_url_owner_id = _select_podcast_id_by_feed_url(db, normalized_body.feed_url)
            if feed_url_owner_id is not None and feed_url_owner_id != podcast_id:
                row = db.execute(
                    text(
                        """
                        UPDATE podcasts
                        SET
                            title = :title,
                            author = COALESCE(:author, author),
                            website_url = COALESCE(:website_url, website_url),
                            image_url = COALESCE(:image_url, image_url),
                            description = COALESCE(:description, description),
                            updated_at = :updated_at
                        WHERE id = :podcast_id
                        RETURNING id
                        """
                    ),
                    {
                        "title": normalized_body.title,
                        "author": normalized_body.author,
                        "website_url": normalized_body.website_url,
                        "image_url": normalized_body.image_url,
                        "description": normalized_body.description,
                        "updated_at": now,
                        "podcast_id": podcast_id,
                    },
                ).fetchone()
                return PodcastEnsureOut(podcast_id=row[0])

            podcast_id = _upsert_podcast(db, normalized_body, now=now)
            return PodcastEnsureOut(podcast_id=podcast_id)

        podcast_id = _select_podcast_id_by_feed_url(db, normalized_body.feed_url)
        if podcast_id is not None:
            row = db.execute(
                text(
                    """
                    UPDATE podcasts
                    SET
                        provider_podcast_id = :provider_podcast_id,
                        title = :title,
                        author = COALESCE(:author, author),
                        feed_url = :feed_url,
                        website_url = COALESCE(:website_url, website_url),
                        image_url = COALESCE(:image_url, image_url),
                        description = COALESCE(:description, description),
                        updated_at = :updated_at
                    WHERE id = :podcast_id
                    RETURNING id
                    """
                ),
                {
                    "provider_podcast_id": normalized_body.provider_podcast_id,
                    "title": normalized_body.title,
                    "author": normalized_body.author,
                    "feed_url": normalized_body.feed_url,
                    "website_url": normalized_body.website_url,
                    "image_url": normalized_body.image_url,
                    "description": normalized_body.description,
                    "updated_at": now,
                    "podcast_id": podcast_id,
                },
            ).fetchone()
            return PodcastEnsureOut(podcast_id=row[0])

        podcast_id = _upsert_podcast(db, normalized_body, now=now)

    return PodcastEnsureOut(podcast_id=podcast_id)


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
    q: str | None = None,
    filter: str = "all",
    library_id: UUID | None = None,
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
    if filter not in PODCAST_SUBSCRIPTION_FILTER_OPTIONS:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Invalid podcast subscriptions filter option",
        )
    limit = min(limit, 200)
    q = q.strip() if q is not None else None
    if q == "":
        q = None

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

    if filter == "all":
        filter_sql = "TRUE"
    elif filter == "has_new":
        filter_sql = "COALESCE(sa.unplayed_count, 0) > 0"
    elif filter == "not_in_library":
        filter_sql = "COALESCE(vl.visible_library_count, 0) = 0"
    else:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Invalid podcast subscriptions filter option",
        )

    query_params: dict[str, object] = {
        "user_id": viewer_id,
        "viewer_id": viewer_id,
        "limit": limit,
        "offset": offset,
        "has_query": q is not None,
        "q": q,
        "q_pattern": f"%{q}%" if q is not None else None,
        "has_library_scope": library_id is not None,
        "library_id": library_id,
    }

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
            ),
            visible_non_default_libraries AS (
                SELECT
                    le.podcast_id,
                    COUNT(*) AS visible_library_count,
                    json_agg(
                        json_build_object(
                            'id', l.id,
                            'name', l.name,
                            'color', l.color
                        )
                        ORDER BY l.created_at ASC, l.id ASC
                    ) AS visible_libraries
                FROM library_entries le
                JOIN libraries l
                  ON l.id = le.library_id
                 AND l.is_default = false
                JOIN memberships m
                  ON m.library_id = l.id
                 AND m.user_id = :viewer_id
                WHERE le.podcast_id IS NOT NULL
                GROUP BY le.podcast_id
            )
            SELECT
                ps.podcast_id,
                ps.status,
                ps.default_playback_speed,
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
                sa.latest_published_at,
                COALESCE(vl.visible_libraries, '[]'::json) AS visible_libraries
            FROM podcast_subscriptions ps
            JOIN podcasts p ON p.id = ps.podcast_id
            LEFT JOIN subscription_aggregates sa ON sa.podcast_id = ps.podcast_id
            LEFT JOIN visible_non_default_libraries vl ON vl.podcast_id = ps.podcast_id
            WHERE ps.user_id = :user_id
              AND ps.status = 'active'
              AND (
                    :has_query IS FALSE
                    OR p.title ILIKE :q_pattern
                    OR COALESCE(p.author, '') ILIKE :q_pattern
                )
              AND {filter_sql}
              AND (
                    :has_library_scope IS FALSE
                    OR EXISTS(
                        SELECT 1
                        FROM library_entries le
                        JOIN libraries l
                          ON l.id = le.library_id
                         AND l.is_default = false
                        JOIN memberships m
                          ON m.library_id = l.id
                         AND m.user_id = :viewer_id
                        WHERE le.library_id = :library_id
                          AND le.podcast_id = ps.podcast_id
                    )
                )
            ORDER BY {order_by_sql}
            LIMIT :limit
            OFFSET :offset
            """
        ),
        query_params,
    ).fetchall()
    out: list[PodcastSubscriptionListItemOut] = []
    for row in rows:
        podcast = _podcast_list_item_from_row(row[12:23])
        visible_libraries_payload = row[25]
        if isinstance(visible_libraries_payload, str):
            visible_libraries_payload = json.loads(visible_libraries_payload)
        out.append(
            PodcastSubscriptionListItemOut(
                podcast_id=row[0],
                status=row[1],
                default_playback_speed=float(row[2]) if row[2] is not None else None,
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
                latest_episode_published_at=row[24],
                visible_libraries=[
                    PodcastSubscriptionVisibleLibraryOut(
                        id=item["id"],
                        name=item["name"],
                        color=item.get("color"),
                    )
                    for item in (visible_libraries_payload or [])
                ],
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
                ps.user_id,
                ps.podcast_id,
                ps.status,
                ps.default_playback_speed,
                ps.auto_queue,
                ps.sync_status,
                ps.sync_error_code,
                ps.sync_error_message,
                ps.sync_attempts,
                ps.sync_started_at,
                ps.sync_completed_at,
                ps.last_synced_at,
                ps.updated_at
            FROM podcasts p
            LEFT JOIN podcast_subscriptions ps
              ON ps.podcast_id = p.id
             AND ps.user_id = :user_id
            WHERE p.id = :podcast_id
            """
        ),
        {"user_id": viewer_id, "podcast_id": podcast_id},
    ).fetchone()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")

    podcast = _podcast_list_item_from_row(row[0:11])
    subscription: PodcastSubscriptionStatusOut | None = None
    if row[11] is not None:
        subscription = PodcastSubscriptionStatusOut(
            user_id=row[11],
            podcast_id=row[12],
            status=row[13],
            default_playback_speed=float(row[14]) if row[14] is not None else None,
            auto_queue=bool(row[15]),
            sync_status=row[16],
            sync_error_code=row[17],
            sync_error_message=row[18],
            sync_attempts=row[19],
            sync_started_at=row[20],
            sync_completed_at=row[21],
            last_synced_at=row[22],
            updated_at=row[23],
        )
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
    podcast_exists = db.execute(
        text(
            """
            SELECT 1
            FROM podcasts
            WHERE id = :podcast_id
            """
        ),
        {"podcast_id": podcast_id},
    ).fetchone()
    if podcast_exists is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")

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


def _upsert_podcast(
    db: Session,
    body: PodcastSubscribeRequest | PodcastEnsureRequest,
    *,
    now: datetime,
) -> UUID:
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
                author = COALESCE(EXCLUDED.author, podcasts.author),
                feed_url = EXCLUDED.feed_url,
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
    return row[0]


def _select_podcast_id_by_provider_id(db: Session, provider_podcast_id: str) -> UUID | None:
    row = db.execute(
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
            "provider_podcast_id": provider_podcast_id,
        },
    ).fetchone()
    if row is None:
        return None
    return row[0]


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
