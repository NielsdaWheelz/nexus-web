"""Reads over shows and subscriptions: followed shows, show detail, action facts."""

from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql, visible_podcast_ids_cte_sql
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas import podcast as wire
from nexus.schemas.collection_page import CollectionCursor, CollectionPage
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
from nexus.services.keyset_cursor import KeysetValueKind, decode_keyset_cursor, encode_keyset_cursor

from .subscriptions import find_status

SubscriptionSort = Literal["recent_episode", "unplayed_count", "alpha"]
SubscriptionFilter = Literal["all", "has_new", "not_in_library"]
_FAMILY = CollectionFamily.PodcastSubscriptions


@dataclass(frozen=True, slots=True)
class PodcastState:
    subscribed: bool
    backfill_failed: bool


@dataclass(frozen=True, slots=True)
class CompactPodcastTarget:
    podcast_id: UUID
    title: str
    subtitle: Absent | Present[str]
    image_url: Absent | Present[str]
    href: str


def active_subscription_rows_sql() -> str:
    """The viewer's followed shows (``podcast_id``); binds ``:viewer_id``."""
    return "SELECT ps.podcast_id FROM podcast_subscriptions ps WHERE ps.user_id = :viewer_id"


def podcast_states(
    db: Session, *, viewer_id: UUID, podcast_ids: list[UUID]
) -> dict[UUID, PodcastState]:
    """Every persisted show among the ids, with the viewer's subscription facts."""
    rows = db.execute(
        text("""
            SELECT p.id, s.id IS NOT NULL AS subscribed, b.failed_at IS NOT NULL AS failed
            FROM podcasts p
            LEFT JOIN podcast_subscriptions s ON s.podcast_id = p.id AND s.user_id = :viewer_id
            LEFT JOIN podcast_subscription_backfills b ON b.subscription_id = s.id
            WHERE p.id = ANY(CAST(:ids AS uuid[]))
        """),
        {"viewer_id": viewer_id, "ids": list(set(podcast_ids))},
    )
    return {row.id: PodcastState(row.subscribed, row.failed) for row in rows}


def hydrate_compact_podcast_targets(
    db: Session, *, viewer_id: UUID, podcast_ids: list[UUID]
) -> dict[UUID, CompactPodcastTarget]:
    """Visible shows as compact suggestion targets: title, authors, image, href."""
    from nexus.services.resource_graph.refs import ResourceRef
    from nexus.services.resource_items.routing import resource_activations_for_refs

    rows = db.execute(
        text(f"""
            SELECT p.id, p.title, p.image_url FROM podcasts p
            WHERE p.id = ANY(CAST(:ids AS uuid[])) AND p.id IN ({visible_podcast_ids_cte_sql()})
        """),
        {"viewer_id": viewer_id, "ids": list(dict.fromkeys(podcast_ids))},
    ).all()
    credits = load_contributor_credits_for_podcasts(db, [row.id for row in rows])
    refs = {row.id: ResourceRef(scheme="podcast", id=row.id) for row in rows}
    activations = resource_activations_for_refs(db, viewer_id=viewer_id, refs=list(refs.values()))
    targets = {}
    for row in rows:
        authors = dict.fromkeys(
            credit.contributor_display_name or credit.credited_name
            for credit in credits.get(row.id, [])
            if credit.role == "author"
        )
        href = activations[refs[row.id].uri].href
        assert href is not None  # a podcast ref always routes
        targets[row.id] = CompactPodcastTarget(
            podcast_id=row.id,
            title=row.title,
            subtitle=presence_from_nullable(", ".join(authors) or None),
            image_url=presence_from_nullable(row.image_url),
            href=href,
        )
    return targets


def _plan(sort: SubscriptionSort) -> list[SortKey]:
    """The one total order behind the listing's ORDER BY, predicate and cursor."""
    if sort == "alpha":
        return [
            SortKey("title_key", "asc", KeysetValueKind.Text),
            SortKey("podcast_id", "asc", KeysetValueKind.Uuid),
        ]
    recency = [
        SortKey("latest_missing", "asc", KeysetValueKind.Int),
        SortKey("latest_published_at", "desc", KeysetValueKind.DateTimeOrNull),
        SortKey("followed_at", "desc", KeysetValueKind.DateTime),
        SortKey("podcast_id", "desc", KeysetValueKind.Uuid),
    ]
    if sort == "unplayed_count":
        return [SortKey("unplayed_count", "desc", KeysetValueKind.Int), *recency]
    return recency


def list_subscriptions(
    db: Session,
    viewer_id: UUID,
    *,
    limit: int,
    cursor: CollectionCursor | None,
    revision: int | None,
    sort: SubscriptionSort,
    filter: SubscriptionFilter,
    library_id: UUID | None,
) -> CollectionPage[wire.PodcastSubscriptionListItemOut]:
    """One page of followed shows under one total order; a continuation names the
    revision it was issued at and is refused once the family moved."""
    current = (
        read_collection_revision(db, viewer_id=viewer_id, family=_FAMILY)
        if revision is None
        else require_collection_revision(db, viewer_id=viewer_id, family=_FAMILY, expected=revision)
    )
    plan = _plan(sort)
    identity = {
        "viewerId": str(viewer_id),
        "sort": sort,
        "filter": filter,
        "libraryId": None if library_id is None else str(library_id),
    }
    params: dict[str, object] = {"viewer_id": viewer_id, "limit": limit + 1}
    # library_entries owns membership reads: library predicates arrive as id sets.
    where = []
    if filter == "has_new":
        where.append("AND unplayed_count > 0")
    if filter == "not_in_library":
        params["placed"] = list(
            library_entries.podcast_ids_in_libraries_for_viewer(db, viewer_id=viewer_id)
        )
        where.append("AND podcast_id <> ALL(CAST(:placed AS uuid[]))")
    if library_id is not None:
        params["scoped"] = list(
            library_entries.podcast_ids_in_libraries_for_viewer(
                db, viewer_id=viewer_id, library_id=library_id
            )
        )
        where.append("AND podcast_id = ANY(CAST(:scoped AS uuid[]))")
    if cursor is not None:
        after = decode_keyset_cursor(
            cursor, family=_FAMILY.value, query=identity, expected_kinds=expected_kinds(plan)
        )
        params.update(keyset_params(plan, after))
        where.append(keyset_clause(plan, alias="o"))
    state = projection.episode_state_case_sql(listening_alias="pls", override_alias="co")
    joins = projection.episode_state_joins_sql(
        user_param=":viewer_id",
        media_expr="pe.media_id",
        listening_alias="pls",
        override_alias="co",
    )
    rows = (
        db.execute(
            text(f"""
                WITH visible_media AS ({visible_media_ids_cte_sql()}),
                episodes AS (
                    SELECT pe.podcast_id, pe.published_at, {state} AS episode_state
                    FROM podcast_episodes pe
                    JOIN visible_media vm ON vm.media_id = pe.media_id
                    {joins}
                ),
                o AS (
                    SELECT s.podcast_id, s.default_playback_speed, s.pause_shortening_mode,
                           s.auto_queue, s.sync_status, s.created_at AS followed_at,
                           p.title, LOWER(p.title) AS title_key,
                           COUNT(e.*) FILTER (WHERE e.episode_state = 'unplayed') AS unplayed_count,
                           MAX(e.published_at) AS latest_published_at,
                           (MAX(e.published_at) IS NULL)::int AS latest_missing
                    FROM podcast_subscriptions s
                    JOIN podcasts p ON p.id = s.podcast_id
                    LEFT JOIN episodes e ON e.podcast_id = s.podcast_id
                    WHERE s.user_id = :viewer_id
                    GROUP BY s.id, p.id
                )
                SELECT * FROM o
                WHERE TRUE {" ".join(where)}
                ORDER BY {order_by_sql(plan, alias="o")}
                LIMIT :limit
            """),
            params,
        )
        .mappings()
        .all()
    )
    page = rows[:limit]
    credits = load_contributor_credits_for_podcasts(db, [row["podcast_id"] for row in page])
    return CollectionPage(
        items=[
            wire.PodcastSubscriptionListItemOut(
                podcast_id=row["podcast_id"],
                title=row["title"],
                contributors=credits.get(row["podcast_id"], []),
                unplayed_count=row["unplayed_count"],
                latest_episode_published_at=presence_from_nullable(row["latest_published_at"]),
                default_playback_speed=presence_from_nullable(row["default_playback_speed"]),
                pause_shortening_mode=presence_from_nullable(row["pause_shortening_mode"]),
                auto_queue=row["auto_queue"],
                sync_status=row["sync_status"],
            )
            for row in page
        ],
        collectionRevision=current,
        nextCursor=present(
            encode_keyset_cursor(
                family=_FAMILY.value, query=identity, after=after_values(plan, page[-1])
            )
        )
        if len(rows) > limit
        else absent(),
    )


def get_podcast_detail(db: Session, viewer_id: UUID, podcast_id: UUID) -> wire.PodcastDetailOut:
    """Catalog facts of any persisted show, with the viewer's subscription if any."""
    row = (
        db.execute(
            text("""
                SELECT id, provider, provider_podcast_id, title, feed_url, website_url,
                       image_url, description, created_at, updated_at
                FROM podcasts WHERE id = :id
            """),
            {"id": podcast_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
    contributors = load_contributor_credits_for_podcasts(db, [podcast_id]).get(podcast_id, [])
    return wire.PodcastDetailOut(
        podcast=wire.PodcastListItemOut(**row, contributors=contributors),
        subscription=find_status(db, viewer_id, podcast_id),
    )
