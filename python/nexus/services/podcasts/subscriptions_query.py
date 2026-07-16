"""Podcast subscription read queries: list and detail for a viewer."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.errors import (
    ApiErrorCode,
    InvalidRequestError,
    NotFoundError,
)
from nexus.schemas.contributors import ContributorCreditOut
from nexus.schemas.podcast import (
    PodcastDetailOut,
    PodcastListItemOut,
    PodcastSubscriptionListItemOut,
    PodcastSubscriptionStatusOut,
)
from nexus.services import library_entries
from nexus.services.contributor_credits import load_contributor_credits_for_podcasts

PODCAST_SUBSCRIPTION_SORT_OPTIONS = {"recent_episode", "unplayed_count", "alpha"}
PODCAST_SUBSCRIPTION_FILTER_OPTIONS = {"all", "has_new", "not_in_library"}


def _podcast_list_item_from_row(
    row: Any,
    contributors: list[ContributorCreditOut],
) -> PodcastListItemOut:
    return PodcastListItemOut(
        id=row[0],
        provider=row[1],
        provider_podcast_id=row[2],
        title=row[3],
        contributors=contributors,
        feed_url=row[4],
        website_url=row[5],
        image_url=row[6],
        description=row[7],
        created_at=row[8],
        updated_at=row[9],
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

    # library_entries.py owns the library-membership reads: derive the membership/scope sets
    # via its readers so this query never touches the tables. `not_in_library` and the
    # library_id scope both gate which rows are paginated, so they stay in WHERE as id sets.
    in_library_podcast_ids: list[UUID] = []
    if filter == "not_in_library":
        in_library_podcast_ids = sorted(
            library_entries.podcast_ids_in_libraries_for_viewer(db, viewer_id=viewer_id)
        )
        filter_sql = (
            "ps.podcast_id <> ALL(:in_library_podcast_ids)" if in_library_podcast_ids else "TRUE"
        )
    elif filter == "all":
        filter_sql = "TRUE"
    elif filter == "has_new":
        filter_sql = "COALESCE(sa.unplayed_count, 0) > 0"
    else:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Invalid podcast subscriptions filter option",
        )

    if library_id is not None:
        scoped_podcast_ids = sorted(
            library_entries.podcast_ids_in_libraries_for_viewer(
                db, viewer_id=viewer_id, library_id=library_id
            )
        )
        if not scoped_podcast_ids:
            return []
        library_scope_sql = "ps.podcast_id = ANY(:scoped_podcast_ids)"
    else:
        scoped_podcast_ids = []
        library_scope_sql = "TRUE"

    query_params: dict[str, object] = {
        "user_id": viewer_id,
        "viewer_id": viewer_id,  # required by the embedded visible_media CTE
        "limit": limit,
        "offset": offset,
        "has_query": q is not None,
        "q": q,
        "q_pattern": f"%{q}%" if q is not None else None,
        "in_library_podcast_ids": in_library_podcast_ids,
        "scoped_podcast_ids": scoped_podcast_ids,
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
              AND (
                    :has_query IS FALSE
                    OR p.title ILIKE :q_pattern
                    OR EXISTS (
                        SELECT 1
                        FROM contributor_credits cc
                        JOIN contributors c ON c.id = cc.contributor_id
                        LEFT JOIN contributor_aliases ca ON ca.contributor_id = c.id
                        WHERE cc.podcast_id = p.id
                          AND (
                                cc.credited_name ILIKE :q_pattern
                                OR c.display_name ILIKE :q_pattern
                                OR ca.alias ILIKE :q_pattern
                          )
                    )
                )
              AND {filter_sql}
              AND {library_scope_sql}
            ORDER BY {order_by_sql}
            LIMIT :limit
            OFFSET :offset
            """
        ),
        query_params,
    ).fetchall()
    page_podcast_ids = [row[12] for row in rows]
    contributors_by_podcast_id = load_contributor_credits_for_podcasts(db, page_podcast_ids)
    visible_libraries_by_podcast_id = library_entries.visible_non_default_libraries_for_viewer(
        db,
        viewer_id=viewer_id,
        podcast_ids=page_podcast_ids,
    )
    out: list[PodcastSubscriptionListItemOut] = []
    for row in rows:
        podcast = _podcast_list_item_from_row(
            row[12:22],
            contributors_by_podcast_id.get(row[12], []),
        )
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
                unplayed_count=int(row[22] or 0),
                latest_episode_published_at=row[23],
                visible_libraries=visible_libraries_by_podcast_id.get(row[12], []),
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

    contributors_by_podcast_id = load_contributor_credits_for_podcasts(db, [podcast_id])
    podcast = _podcast_list_item_from_row(
        row[0:10],
        contributors_by_podcast_id.get(podcast_id, []),
    )
    subscription: PodcastSubscriptionStatusOut | None = None
    if row[10] is not None:
        subscription = PodcastSubscriptionStatusOut(
            user_id=row[10],
            podcast_id=row[11],
            status=row[12],
            default_playback_speed=float(row[13]) if row[13] is not None else None,
            auto_queue=bool(row[14]),
            sync_status=row[15],
            sync_error_code=row[16],
            sync_error_message=row[17],
            sync_attempts=row[18],
            sync_started_at=row[19],
            sync_completed_at=row[20],
            last_synced_at=row[21],
            updated_at=row[22],
        )
    return PodcastDetailOut(podcast=podcast, subscription=subscription)
