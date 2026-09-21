"""Followed-shows listing, show detail and the podcast id-set reads."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql, visible_podcast_ids_cte_sql
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.collection_page import CollectionCursor, CollectionPage, CollectionRevision
from nexus.schemas.podcast import (
    PodcastDetailOut,
    PodcastListItemOut,
    PodcastSubscriptionListItemOut,
)
from nexus.schemas.presence import Absent, Present, absent, presence_from_nullable, present
from nexus.services import library_entries
from nexus.services.collection_keyset import (
    SortKey,
    after_values,
    expected_kinds,
    keyset_clause,
    keyset_params,
    order_by_sql,
)
from nexus.services.collection_revisions import (
    CollectionFamily,
    read_collection_revision,
    require_collection_revision,
)
from nexus.services.consumption import projection
from nexus.services.contributor_credits import load_contributor_credits_for_podcasts
from nexus.services.keyset_cursor import (
    KeysetValueKind,
    decode_keyset_cursor,
    encode_keyset_cursor,
)

from .playback_preferences import pause_shortening_mode_from_nullable
from .subscriptions import SUBSCRIPTION_STATUS_COLUMNS, subscription_status_from_row

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
    """


def subscribed_podcast_ids(db: Session, *, viewer_id: UUID, podcast_ids: list[UUID]) -> set[UUID]:
    """The subset of the supplied shows the viewer actively subscribes to."""
    return _podcast_id_set(
        db,
        """
        SELECT ps.podcast_id
        FROM podcast_subscriptions ps
        WHERE ps.user_id = :viewer_id AND ps.podcast_id = ANY(:podcast_ids)
        """,
        viewer_id=viewer_id,
        podcast_ids=podcast_ids,
    )


def existing_podcast_ids(db: Session, *, podcast_ids: list[UUID]) -> set[UUID]:
    """The persisted show identities among the supplied ids, subscribed or not."""
    return _podcast_id_set(
        db,
        "SELECT id FROM podcasts WHERE id = ANY(:podcast_ids)",
        viewer_id=None,
        podcast_ids=podcast_ids,
    )


def failed_backfill_podcast_ids(
    db: Session, *, viewer_id: UUID, podcast_ids: list[UUID]
) -> set[UUID]:
    """Subscribed shows whose one current backfill is durably failed."""
    return _podcast_id_set(
        db,
        """
        SELECT ps.podcast_id
        FROM podcast_subscriptions ps
        JOIN podcast_subscription_backfills backfill ON backfill.subscription_id = ps.id
        WHERE ps.user_id = :viewer_id
          AND ps.podcast_id = ANY(:podcast_ids)
          AND backfill.failed_at IS NOT NULL
        """,
        viewer_id=viewer_id,
        podcast_ids=podcast_ids,
    )


def hydrate_compact_podcast_targets(
    db: Session, *, viewer_id: UUID, podcast_ids: list[UUID]
) -> dict[UUID, CompactPodcastTarget]:
    """Batch-hydrate visible podcasts into compact target facts."""
    from nexus.services.resource_graph.refs import ResourceRef
    from nexus.services.resource_items.routing import resource_activations_for_refs

    ordered_ids = list(dict.fromkeys(UUID(str(value)) for value in podcast_ids))
    if not ordered_ids:
        return {}
    by_id = {
        UUID(str(row["podcast_id"])): row
        for row in db.execute(
            text(
                f"""
                WITH visible_podcasts AS ({visible_podcast_ids_cte_sql()})
                SELECT p.id AS podcast_id, p.title, p.image_url
                FROM podcasts p
                JOIN visible_podcasts vp ON vp.podcast_id = p.id
                WHERE p.id = ANY(:podcast_ids)
                """
            ),
            {"viewer_id": viewer_id, "podcast_ids": ordered_ids},
        ).mappings()
    }
    credits = load_contributor_credits_for_podcasts(db, list(by_id))
    activations = resource_activations_for_refs(
        db,
        viewer_id=viewer_id,
        refs=[ResourceRef(scheme="podcast", id=podcast_id) for podcast_id in by_id],
    )
    hydrated: dict[UUID, CompactPodcastTarget] = {}
    for podcast_id, row in by_id.items():
        subtitle = ", ".join(
            dict.fromkeys(
                credit.contributor_display_name or credit.credited_name
                for credit in credits.get(podcast_id, [])
                if credit.role == "author"
            )
        )
        href = activations[ResourceRef(scheme="podcast", id=podcast_id).uri].href
        assert href is not None  # podcast is a statically routeable ResourceRef
        hydrated[podcast_id] = CompactPodcastTarget(
            podcast_id=podcast_id,
            title=str(row["title"]),
            subtitle=presence_from_nullable(subtitle or None),
            image_url=presence_from_nullable(
                None if row["image_url"] is None else str(row["image_url"])
            ),
            href=href,
        )
    return hydrated


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
    """Page the viewer's followed shows under one total order."""
    if sort not in PODCAST_SUBSCRIPTION_SORT_OPTIONS:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Invalid podcast subscriptions sort option"
        )
    if filter not in PODCAST_SUBSCRIPTION_FILTER_OPTIONS:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Invalid podcast subscriptions filter option"
        )
    query_identity: dict[str, object] = {
        "viewerId": str(viewer_id),
        "sort": sort,
        "filter": filter,
        "libraryId": str(library_id) if library_id is not None else None,
    }
    plan = _subscription_plan(sort)
    revision = (
        read_collection_revision(
            db, viewer_id=viewer_id, family=CollectionFamily.PodcastSubscriptions
        )
        if collection_revision is None
        else require_collection_revision(
            db,
            viewer_id=viewer_id,
            family=CollectionFamily.PodcastSubscriptions,
            expected=collection_revision,
        )
    )

    # library_entries owns the membership reads: both library-shaped predicates
    # arrive here as id sets so this query never touches those tables.
    in_library_podcast_ids: list[UUID] = []
    filter_sql = "TRUE"
    if filter == "has_new":
        filter_sql = "COALESCE(sa.unplayed_count, 0) > 0"
    elif filter == "not_in_library":
        in_library_podcast_ids = sorted(
            library_entries.podcast_ids_in_libraries_for_viewer(db, viewer_id=viewer_id)
        )
        if in_library_podcast_ids:
            filter_sql = "ps.podcast_id <> ALL(:in_library_podcast_ids)"

    scoped_podcast_ids: list[UUID] = []
    library_scope_sql = "TRUE"
    if library_id is not None:
        scoped_podcast_ids = sorted(
            library_entries.podcast_ids_in_libraries_for_viewer(
                db, viewer_id=viewer_id, library_id=library_id
            )
        )
        if not scoped_podcast_ids:
            return CollectionPage(items=[], collectionRevision=revision, nextCursor=absent())
        library_scope_sql = "ps.podcast_id = ANY(:scoped_podcast_ids)"

    params: dict[str, object] = {
        "user_id": viewer_id,
        "viewer_id": viewer_id,  # required by the embedded visible_media CTE
        "page_limit": limit + 1,
        "in_library_podcast_ids": in_library_podcast_ids,
        "scoped_podcast_ids": scoped_podcast_ids,
    }
    keyset_sql = ""
    if cursor is not None:
        keyset_sql = keyset_clause(plan, alias="os")
        params.update(
            keyset_params(
                plan,
                decode_keyset_cursor(
                    cursor,
                    family=CollectionFamily.PodcastSubscriptions.value,
                    query=query_identity,
                    expected_kinds=expected_kinds(plan),
                ),
            )
        )

    rows = (
        db.execute(
            text(
                f"""
                WITH visible_media AS ({visible_media_ids_cte_sql()}),
                episode_states AS (
                    SELECT
                        pe.podcast_id,
                        pe.published_at,
                        {
                    projection.episode_state_case_sql(
                        listening_alias="pls", override_alias="co", episode_alias="pe"
                    )
                } AS episode_state
                    FROM podcast_episodes pe
                    JOIN visible_media vm ON vm.media_id = pe.media_id
                    {
                    projection.episode_state_joins_sql(
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
                    LEFT JOIN episode_states es ON es.podcast_id = ps.podcast_id
                    WHERE ps.user_id = :user_id
                    GROUP BY ps.podcast_id
                ),
                ordered_subscriptions AS (
                    SELECT
                        ps.podcast_id,
                        ps.default_playback_speed,
                        ps.pause_shortening_mode,
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
                      AND {filter_sql}
                      AND {library_scope_sql}
                )
                SELECT os.*
                FROM ordered_subscriptions os
                WHERE TRUE
                {keyset_sql}
                ORDER BY {order_by_sql(plan, alias="os")}
                LIMIT :page_limit
                """
            ),
            params,
        )
        .mappings()
        .all()
    )
    has_next = len(rows) > limit
    page_rows = rows[:limit]
    contributors = load_contributor_credits_for_podcasts(
        db, [UUID(str(row["podcast_id"])) for row in page_rows]
    )
    return CollectionPage(
        items=[
            PodcastSubscriptionListItemOut(
                podcast_id=UUID(str(row["podcast_id"])),
                title=str(row["title"]),
                contributors=contributors.get(UUID(str(row["podcast_id"])), []),
                unplayed_count=int(row["unplayed_count"]),
                latest_episode_published_at=presence_from_nullable(row["latest_published_at"]),
                default_playback_speed=presence_from_nullable(
                    None
                    if row["default_playback_speed"] is None
                    else float(row["default_playback_speed"])
                ),
                pause_shortening_mode=pause_shortening_mode_from_nullable(
                    row["pause_shortening_mode"]
                ),
                auto_queue=bool(row["auto_queue"]),
                sync_status=row["sync_status"],
            )
            for row in page_rows
        ],
        collectionRevision=revision,
        nextCursor=(
            present(
                encode_keyset_cursor(
                    family=CollectionFamily.PodcastSubscriptions.value,
                    query=query_identity,
                    after=after_values(plan, page_rows[-1]),
                )
            )
            if has_next and page_rows
            else absent()
        ),
    )


def get_podcast_detail_for_viewer(
    db: Session, viewer_id: UUID, podcast_id: UUID
) -> PodcastDetailOut:
    """Show detail for any persisted podcast, with the viewer's subscription."""
    row = (
        db.execute(
            text(
                f"""
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
                    {SUBSCRIPTION_STATUS_COLUMNS}
                FROM podcasts p
                LEFT JOIN podcast_subscriptions ps
                  ON ps.podcast_id = p.id AND ps.user_id = :viewer_id
                LEFT JOIN podcast_subscription_backfills backfill
                  ON backfill.subscription_id = ps.id
                WHERE p.id = :podcast_id
                """
            ),
            {"viewer_id": viewer_id, "podcast_id": podcast_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
    credits = load_contributor_credits_for_podcasts(db, [podcast_id])
    return PodcastDetailOut(
        podcast=PodcastListItemOut(
            id=row["id"],
            provider=row["provider"],
            provider_podcast_id=row["provider_podcast_id"],
            title=row["title"],
            contributors=credits.get(podcast_id, []),
            feed_url=row["feed_url"],
            website_url=row["website_url"],
            image_url=row["image_url"],
            description=row["description"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        ),
        subscription=(
            None if row["subscription_user_id"] is None else subscription_status_from_row(row)
        ),
    )


def _podcast_id_set(
    db: Session, sql: str, *, viewer_id: UUID | None, podcast_ids: list[UUID]
) -> set[UUID]:
    ordered = list(dict.fromkeys(podcast_ids))
    if not ordered:
        return set()
    rows = db.execute(text(sql), {"viewer_id": viewer_id, "podcast_ids": ordered}).all()
    return {UUID(str(row[0])) for row in rows}


def _subscription_plan(sort: PodcastSubscriptionSort) -> list[SortKey]:
    """The one total order behind this listing's ORDER BY, predicate and cursor."""
    if sort == "alpha":
        return [
            SortKey("title_key", "asc", KeysetValueKind.Text),
            SortKey("podcast_id", "asc", KeysetValueKind.Uuid),
        ]
    recency = [
        SortKey("latest_missing", "asc", KeysetValueKind.Int),
        SortKey("latest_published_at", "desc", KeysetValueKind.DateTimeOrNull),
        SortKey("subscription_updated_at", "desc", KeysetValueKind.DateTime),
        SortKey("podcast_id", "desc", KeysetValueKind.Uuid),
    ]
    if sort == "unplayed_count":
        return [SortKey("unplayed_count", "desc", KeysetValueKind.Int), *recency]
    return recency
