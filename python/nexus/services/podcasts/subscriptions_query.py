"""Podcast subscription read queries: list and detail for a viewer."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql, visible_podcast_ids_cte_sql
from nexus.errors import (
    ApiErrorCode,
    InvalidRequestError,
    NotFoundError,
)
from nexus.schemas.collection_page import CollectionCursor, CollectionPage, CollectionRevision
from nexus.schemas.contributors import ContributorCreditOut
from nexus.schemas.podcast import (
    PodcastDetailOut,
    PodcastListItemOut,
    PodcastSubscriptionListItemOut,
    PodcastSubscriptionStatusOut,
)
from nexus.schemas.presence import Absent, Present, absent, presence_from_nullable, present
from nexus.services import library_entries
from nexus.services.collection_revisions import (
    CollectionFamily,
    read_collection_revision,
    require_collection_revision,
)
from nexus.services.consumption import service as consumption_service
from nexus.services.contributor_credits import load_contributor_credits_for_podcasts
from nexus.services.signed_keyset_cursor import (
    KeysetValue,
    KeysetValueKind,
    decode_signed_keyset_cursor,
    encode_signed_keyset_cursor,
)

PodcastSubscriptionSort = Literal["recent_episode", "unplayed_count", "alpha"]
PodcastSubscriptionFilter = Literal["all", "has_new", "not_in_library"]
PODCAST_SUBSCRIPTION_SORT_OPTIONS = frozenset({"recent_episode", "unplayed_count", "alpha"})
PODCAST_SUBSCRIPTION_FILTER_OPTIONS = frozenset({"all", "has_new", "not_in_library"})


@dataclass(frozen=True, slots=True)
class CompactPodcastTarget:
    """Narrow podcast display facts for a selected library target."""

    podcast_id: UUID
    title: str
    subtitle: Absent | Present[str]
    image_url: Absent | Present[str]
    href: str


def active_subscription_rows_sql() -> str:
    """The viewer's complete active-subscription relation.

    Binds ``:viewer_id`` and returns ``podcast_id``. Library membership and
    destination authorization belong to the composing query.
    """
    return """
        SELECT ps.podcast_id
        FROM podcast_subscriptions ps
        WHERE ps.user_id = :viewer_id
          AND ps.status = 'active'
    """


def hydrate_compact_podcast_targets(
    db: Session, *, viewer_id: UUID, podcast_ids: list[UUID]
) -> dict[UUID, CompactPodcastTarget]:
    """Batch-hydrate visible podcasts into compact target facts."""
    ordered_ids = list(dict.fromkeys(UUID(str(value)) for value in podcast_ids))
    if not ordered_ids:
        return {}
    rows = db.execute(
        text(
            f"""
            WITH visible_podcasts AS (
                {visible_podcast_ids_cte_sql()}
            )
            SELECT p.id AS podcast_id, p.title, p.image_url
            FROM podcasts p
            JOIN visible_podcasts vp ON vp.podcast_id = p.id
            WHERE p.id = ANY(:podcast_ids)
            """
        ),
        {"viewer_id": viewer_id, "podcast_ids": ordered_ids},
    ).mappings()
    by_id = {UUID(str(row["podcast_id"])): row for row in rows}
    credits = load_contributor_credits_for_podcasts(db, list(by_id))
    from nexus.services.resource_graph.refs import ResourceRef
    from nexus.services.resource_items.routing import resource_activations_for_refs

    refs = [
        ResourceRef(scheme="podcast", id=podcast_id)
        for podcast_id in ordered_ids
        if podcast_id in by_id
    ]
    activations = resource_activations_for_refs(db, viewer_id=viewer_id, refs=refs)
    hydrated: dict[UUID, CompactPodcastTarget] = {}
    for podcast_id in ordered_ids:
        row = by_id.get(podcast_id)
        if row is None:
            continue
        author_names = tuple(
            credit.contributor_display_name or credit.credited_name
            for credit in credits.get(podcast_id, [])
            if credit.role == "author"
        )
        subtitle = ", ".join(dict.fromkeys(author_names)) or None
        image_url = str(row["image_url"]) if row["image_url"] is not None else None
        ref = ResourceRef(scheme="podcast", id=podcast_id)
        href = activations[ref.uri].href
        if href is None:
            # justify-defect: podcast is a statically routeable ResourceRef and
            # the visibility query above proved the selected row exists.
            raise AssertionError(f"visible podcast target is not routeable: {ref.uri}")
        hydrated[podcast_id] = CompactPodcastTarget(
            podcast_id=podcast_id,
            title=str(row["title"]),
            subtitle=presence_from_nullable(subtitle),
            image_url=presence_from_nullable(image_url),
            href=href,
        )
    return hydrated


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


def _subscription_query_identity(
    *,
    viewer_id: UUID,
    sort: PodcastSubscriptionSort,
    filter: PodcastSubscriptionFilter,
    library_id: UUID | None,
) -> dict[str, object]:
    return {
        "viewerId": str(viewer_id),
        "sort": sort,
        "filter": filter,
        "libraryId": str(library_id) if library_id is not None else None,
    }


def _subscription_order(
    sort: PodcastSubscriptionSort,
) -> tuple[str, tuple[KeysetValueKind, ...]]:
    if sort == "alpha":
        return (
            "title_key ASC, podcast_id ASC",
            (KeysetValueKind.Text, KeysetValueKind.Uuid),
        )
    if sort == "unplayed_count":
        return (
            "unplayed_count DESC, latest_missing ASC, latest_published_at DESC, "
            "subscription_updated_at DESC, podcast_id DESC",
            (
                KeysetValueKind.Int,
                KeysetValueKind.Int,
                KeysetValueKind.DateTimeOrNull,
                KeysetValueKind.DateTime,
                KeysetValueKind.Uuid,
            ),
        )
    return (
        "latest_missing ASC, latest_published_at DESC, "
        "subscription_updated_at DESC, podcast_id DESC",
        (
            KeysetValueKind.Int,
            KeysetValueKind.DateTimeOrNull,
            KeysetValueKind.DateTime,
            KeysetValueKind.Uuid,
        ),
    )


def _subscription_keyset_predicate(
    sort: PodcastSubscriptionSort,
    after: tuple[object, ...] | None,
    params: dict[str, object],
) -> str:
    if after is None:
        return "TRUE"
    if sort == "alpha":
        title, podcast_id = after
        params.update(after_title=title, after_podcast_id=podcast_id)
        return """
            title_key > :after_title
            OR (title_key = :after_title AND podcast_id > :after_podcast_id)
        """

    if sort == "unplayed_count":
        unplayed, missing, published, updated, podcast_id = after
        params.update(
            after_unplayed=unplayed,
            after_latest_missing=missing,
            after_latest_published=published,
            after_subscription_updated=updated,
            after_podcast_id=podcast_id,
        )
        return """
            unplayed_count < :after_unplayed
            OR (unplayed_count = :after_unplayed
                AND latest_missing > :after_latest_missing)
            OR (unplayed_count = :after_unplayed
                AND latest_missing = :after_latest_missing
                AND :after_latest_missing = 0
                AND latest_published_at < :after_latest_published)
            OR (unplayed_count = :after_unplayed
                AND latest_missing = :after_latest_missing
                AND latest_published_at IS NOT DISTINCT FROM :after_latest_published
                AND subscription_updated_at < :after_subscription_updated)
            OR (unplayed_count = :after_unplayed
                AND latest_missing = :after_latest_missing
                AND latest_published_at IS NOT DISTINCT FROM :after_latest_published
                AND subscription_updated_at = :after_subscription_updated
                AND podcast_id < :after_podcast_id)
        """

    missing, published, updated, podcast_id = after
    params.update(
        after_latest_missing=missing,
        after_latest_published=published,
        after_subscription_updated=updated,
        after_podcast_id=podcast_id,
    )
    return """
        latest_missing > :after_latest_missing
        OR (latest_missing = :after_latest_missing
            AND :after_latest_missing = 0
            AND latest_published_at < :after_latest_published)
        OR (latest_missing = :after_latest_missing
            AND latest_published_at IS NOT DISTINCT FROM :after_latest_published
            AND subscription_updated_at < :after_subscription_updated)
        OR (latest_missing = :after_latest_missing
            AND latest_published_at IS NOT DISTINCT FROM :after_latest_published
            AND subscription_updated_at = :after_subscription_updated
            AND podcast_id < :after_podcast_id)
    """


def _subscription_after_values(
    sort: PodcastSubscriptionSort,
    row: Any,
) -> tuple[KeysetValue, ...]:
    if sort == "alpha":
        return (
            KeysetValue(KeysetValueKind.Text, str(row["title_key"])),
            KeysetValue(KeysetValueKind.Uuid, UUID(str(row["podcast_id"]))),
        )
    common = (
        KeysetValue(KeysetValueKind.Int, int(row["latest_missing"])),
        KeysetValue(KeysetValueKind.DateTimeOrNull, row["latest_published_at"]),
        KeysetValue(
            KeysetValueKind.DateTime,
            cast(datetime, row["subscription_updated_at"]),
        ),
        KeysetValue(KeysetValueKind.Uuid, UUID(str(row["podcast_id"]))),
    )
    if sort == "unplayed_count":
        return (KeysetValue(KeysetValueKind.Int, int(row["unplayed_count"])), *common)
    return common


def list_subscriptions(
    db: Session,
    viewer_id: UUID,
    *,
    limit: int,
    cursor: CollectionCursor | None,
    collection_revision: CollectionRevision | None,
    sort: PodcastSubscriptionSort,
    filter: PodcastSubscriptionFilter,
    library_id: UUID | None = None,
) -> CollectionPage[PodcastSubscriptionListItemOut]:
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
    query_identity = _subscription_query_identity(
        viewer_id=viewer_id,
        sort=sort,
        filter=filter,
        library_id=library_id,
    )
    order_by_sql, cursor_kinds = _subscription_order(sort)
    after = (
        decode_signed_keyset_cursor(
            cursor,
            family=CollectionFamily.PodcastSubscriptions.value,
            query=query_identity,
            expected_kinds=cursor_kinds,
        )
        if cursor is not None
        else None
    )
    revision = (
        read_collection_revision(
            db,
            viewer_id=viewer_id,
            family=CollectionFamily.PodcastSubscriptions,
        )
        if collection_revision is None
        else require_collection_revision(
            db,
            viewer_id=viewer_id,
            family=CollectionFamily.PodcastSubscriptions,
            expected=collection_revision,
        )
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
            return CollectionPage(
                items=[],
                collection_revision=revision,
                next_cursor=absent(),
            )
        library_scope_sql = "ps.podcast_id = ANY(:scoped_podcast_ids)"
    else:
        scoped_podcast_ids = []
        library_scope_sql = "TRUE"

    query_params: dict[str, object] = {
        "user_id": viewer_id,
        "viewer_id": viewer_id,  # required by the embedded visible_media CTE
        "page_limit": limit + 1,
        "in_library_podcast_ids": in_library_podcast_ids,
        "scoped_podcast_ids": scoped_podcast_ids,
    }
    keyset_sql = _subscription_keyset_predicate(sort, after, query_params)

    rows = (
        db.execute(
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
                    {
                    consumption_service.episode_state_case_sql(
                        listening_alias="pls", override_alias="co", episode_alias="pe"
                    )
                } AS episode_state
                FROM podcast_episodes pe
                JOIN visible_media vm
                  ON vm.media_id = pe.media_id
                {
                    consumption_service.episode_state_joins_sql(
                        user_param=":user_id",
                        media_expr="pe.media_id",
                        listening_alias="pls",
                        override_alias="co",
                    )
                }
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
            ordered_subscriptions AS (
                SELECT
                    ps.podcast_id,
                    ps.default_playback_speed,
                    ps.auto_queue,
                    ps.sync_status,
                    ps.updated_at AS subscription_updated_at,
                    p.title,
                    LOWER(p.title) AS title_key,
                    COALESCE(sa.unplayed_count, 0) AS unplayed_count,
                    CASE WHEN sa.latest_published_at IS NULL THEN 1 ELSE 0 END
                        AS latest_missing,
                    sa.latest_published_at
                FROM podcast_subscriptions ps
                JOIN podcasts p ON p.id = ps.podcast_id
                LEFT JOIN subscription_aggregates sa ON sa.podcast_id = ps.podcast_id
                WHERE ps.user_id = :user_id
                  AND ps.status = 'active'
                  AND {filter_sql}
                  AND {library_scope_sql}
            )
            SELECT *
            FROM ordered_subscriptions
            WHERE ({keyset_sql})
            ORDER BY {order_by_sql}
            LIMIT :page_limit
            """
            ),
            query_params,
        )
        .mappings()
        .all()
    )
    has_next = len(rows) > limit
    page_rows = rows[:limit]
    page_podcast_ids = [UUID(str(row["podcast_id"])) for row in page_rows]
    contributors_by_podcast_id = load_contributor_credits_for_podcasts(db, page_podcast_ids)
    out: list[PodcastSubscriptionListItemOut] = []
    for row in page_rows:
        podcast_id = UUID(str(row["podcast_id"]))
        out.append(
            PodcastSubscriptionListItemOut(
                podcast_id=podcast_id,
                title=str(row["title"]),
                contributors=contributors_by_podcast_id.get(podcast_id, []),
                unplayed_count=int(row["unplayed_count"]),
                latest_episode_published_at=presence_from_nullable(row["latest_published_at"]),
                default_playback_speed=presence_from_nullable(
                    float(row["default_playback_speed"])
                    if row["default_playback_speed"] is not None
                    else None
                ),
                auto_queue=bool(row["auto_queue"]),
                sync_status=row["sync_status"],
            )
        )
    next_cursor = (
        present(
            encode_signed_keyset_cursor(
                family=CollectionFamily.PodcastSubscriptions.value,
                query=query_identity,
                after=_subscription_after_values(sort, page_rows[-1]),
            )
        )
        if has_next and page_rows
        else absent()
    )
    return CollectionPage(
        items=out,
        collection_revision=revision,
        next_cursor=next_cursor,
    )


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
