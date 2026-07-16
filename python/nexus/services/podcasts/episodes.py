"""Podcast episode listing for a viewer."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.db.sql_patterns import escape_ilike_pattern
from nexus.errors import (
    ApiErrorCode,
    InvalidRequestError,
    NotFoundError,
)
from nexus.schemas.media import MediaOut
from nexus.services import media as media_service
from nexus.services.consumption import service as consumption_service

PODCAST_EPISODE_STATES = {"all", "unplayed", "in_progress", "played"}
PODCAST_EPISODE_SORT_OPTIONS = {"newest", "oldest", "duration_asc", "duration_desc"}
PODCAST_EPISODE_SHOW_NOTES_LIST_PREVIEW_MAX_CHARS = 300


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
        params["query_pattern"] = f"%{escape_ilike_pattern(normalized_query)}%"

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
                    {
                    consumption_service.episode_state_case_sql(
                        listening_alias="pls", override_alias="co", episode_alias="pe"
                    )
                } AS episode_state
                FROM podcast_episodes pe
                JOIN visible_media vm
                  ON vm.media_id = pe.media_id
                JOIN media m
                  ON m.id = pe.media_id
                {
                    consumption_service.episode_state_joins_sql(
                        user_param=":viewer_id",
                        media_expr="pe.media_id",
                        listening_alias="pls",
                        override_alias="co",
                    )
                }
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
