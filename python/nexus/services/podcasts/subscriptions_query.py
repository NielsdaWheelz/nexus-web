"""Library-owned subscriptions and imports, with physical episode membership.

Section guards, relationships and progress come from one SQL snapshot. Catalog
metadata is hydrated in batches. Reads acquire nothing and never expand show roots
into episode placements.
"""

from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql, visible_podcast_ids_cte_sql
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas import podcast as wire
from nexus.schemas.collection_page import CollectionPage
from nexus.services import libraries, library_entries
from nexus.services.collection_keyset import KeysetValueKind, SortKey, keyset_page
from nexus.services.consumption import projection
from nexus.services.contributor_credits import load_contributor_credits_for_podcasts

from . import imports, settings
from .episodes import episode_counts

SubscriptionSort = Literal["recent_episode", "unplayed_count", "alpha"]
SubscriptionFilter = Literal["all", "has_new", "not_in_library"]


@dataclass(frozen=True, slots=True)
class PodcastState:
    subscribed: bool
    has_episodes: bool


@dataclass(frozen=True, slots=True)
class CompactPodcastTarget:
    podcast_id: UUID
    title: str
    subtitle: str | None
    href: str


def active_subscription_rows_sql() -> str:
    """One active show per viewer across current non-system member libraries."""
    return """
        SELECT s.podcast_id, min(s.created_at) AS followed_at
        FROM library_podcast_subscriptions s
        JOIN libraries l ON l.id=s.library_id
        JOIN memberships lm ON lm.library_id=l.id AND lm.user_id=:viewer_id
        WHERE l.system_key IS NULL AND (NOT l.is_default OR l.owner_user_id=:viewer_id)
        GROUP BY s.podcast_id
    """


def podcast_states(
    db: Session, *, viewer_id: UUID, podcast_ids: list[UUID]
) -> dict[UUID, PodcastState]:
    rows = db.execute(
        text(f"""
        SELECT p.id, EXISTS(SELECT 1 FROM ({active_subscription_rows_sql()}) s
                             WHERE s.podcast_id=p.id) AS subscribed,
               EXISTS(SELECT 1 FROM podcast_episodes pe
                      JOIN ({library_entries.library_media_ids_cte_sql(library_param="(SELECT id FROM libraries WHERE is_default AND owner_user_id=:viewer_id)")}) vm ON vm.media_id=pe.media_id
                      WHERE pe.podcast_id=p.id) AS has_episodes
        FROM podcasts p WHERE p.id=ANY(CAST(:ids AS uuid[]))
    """),
        {"viewer_id": viewer_id, "ids": list(set(podcast_ids))},
    )
    return {row.id: PodcastState(row.subscribed, row.has_episodes) for row in rows}


def hydrate_compact_podcast_targets(
    db: Session, *, viewer_id: UUID, podcast_ids: list[UUID]
) -> dict[UUID, CompactPodcastTarget]:
    from nexus.services.resource_graph.refs import ResourceRef
    from nexus.services.resource_items.routing import resource_activations_for_refs

    rows = db.execute(
        text(f"""
        SELECT p.id,p.title FROM podcasts p WHERE p.id=ANY(CAST(:ids AS uuid[]))
        AND p.id IN ({visible_podcast_ids_cte_sql()})
    """),
        {"viewer_id": viewer_id, "ids": list(set(podcast_ids))},
    ).all()
    credits = load_contributor_credits_for_podcasts(db, [row.id for row in rows])
    refs = {row.id: ResourceRef(scheme="podcast", id=row.id) for row in rows}
    activations = resource_activations_for_refs(db, viewer_id=viewer_id, refs=list(refs.values()))
    result = {}
    for row in rows:
        names = dict.fromkeys(
            c.contributor_display_name or c.credited_name
            for c in credits.get(row.id, [])
            if c.role == "author"
        )
        href = activations[refs[row.id].uri].href
        assert href is not None
        result[row.id] = CompactPodcastTarget(row.id, row.title, ", ".join(names) or None, href)
    return result


def _catalog(
    db: Session, ids: list[UUID]
) -> tuple[dict[UUID, wire.PodcastListItemOut], dict[UUID, wire.PodcastRecurringOut]]:
    rows = (
        db.execute(
            text("""
        SELECT p.*,r.started_at AS run_started_at FROM podcasts p
        LEFT JOIN podcast_feed_runs r ON r.id=p.sync_run_id
        WHERE p.id=ANY(CAST(:ids AS uuid[]))
    """),
            {"ids": ids},
        )
        .mappings()
        .all()
    )
    credits = load_contributor_credits_for_podcasts(db, ids)
    shows = {}
    recurring = {}
    for row in rows:
        shows[row["id"]] = wire.PodcastListItemOut(
            **{k: row[k] for k in wire.PodcastListItemOut.model_fields if k != "contributors"},
            contributors=credits.get(row["id"], []),
        )
        recurring[row["id"]] = wire.PodcastRecurringOut(
            state=("running" if row["run_started_at"] else "pending")
            if row["sync_run_id"]
            else "idle",
            last_checked_at=row["last_checked_at"],
            had_coverage_gaps=row["last_check_had_coverage_gaps"],
            error_code=row["last_check_error_code"],
            error_detail=row["last_check_error_detail"],
            next_sync_at=row["next_sync_at"],
        )
    return shows, recurring


def _snapshot(db: Session, viewer_id: UUID, library_id: UUID):
    row = (
        db.execute(
            text("""
        WITH root AS (
            SELECT l.*,lm.role,u.removal_revision FROM libraries l
            JOIN memberships lm ON lm.library_id=l.id AND lm.user_id=:viewer_id
            JOIN users u ON u.id=:viewer_id WHERE l.id=:library_id
        ), destinations AS (
            SELECT l.id,l.name,l.is_default,l.order_revision,
                   l.system_key IS NULL AND ((l.is_default AND l.owner_user_id=:viewer_id)
                       OR (NOT l.is_default AND lm.role='admin')) AS can_manage
            FROM libraries l JOIN memberships lm ON lm.library_id=l.id AND lm.user_id=:viewer_id
            CROSS JOIN root WHERE l.system_key IS NULL
              AND (NOT l.is_default OR l.owner_user_id=:viewer_id)
              AND (root.is_default OR l.id=root.id)
        ) SELECT root.order_revision,root.removal_revision,
            root.system_key IS NULL AND ((root.is_default AND root.owner_user_id=:viewer_id)
                       OR (NOT root.is_default AND root.role='admin')) AS can_manage,
            COALESCE((SELECT jsonb_agg(to_jsonb(s)||jsonb_build_object(
                'name',d.name,'is_default',d.is_default,'can_manage',d.can_manage))
                FROM library_podcast_subscriptions s JOIN destinations d ON d.id=s.library_id),'[]') AS rules,
            COALESCE((SELECT jsonb_agg(to_jsonb(r)||to_jsonb(i)||jsonb_build_object(
                'podcast_id',r.podcast_id,'podcast_title',p.title,'library_name',d.name,'library_is_default',d.is_default,'updated_at',r.updated_at,'order_revision',d.order_revision,
                'can_manage',d.can_manage))
                FROM podcast_library_imports i JOIN podcast_feed_runs r ON r.id=i.run_id
                JOIN podcasts p ON p.id=r.podcast_id JOIN destinations d ON d.id=i.library_id
                WHERE r.completed_at IS NULL AND r.cancelled_at IS NULL),'[]') AS imports
        FROM root
    """),
            {"viewer_id": viewer_id, "library_id": library_id},
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")
    return row


def read_library_podcasts(
    db: Session, viewer_id: UUID, library_id: UUID
) -> wire.LibraryPodcastsOut:
    snapshot = _snapshot(db, viewer_id, library_id)
    destinations: dict[UUID, list[wire.PodcastDestinationOut]] = {}
    history_ids = {UUID(rule["initial_import_id"]) for rule in snapshot["rules"]}
    for rule in snapshot["rules"]:
        p = UUID(rule["podcast_id"])
        destinations.setdefault(p, []).append(
            wire.PodcastDestinationOut(
                library_id=rule["library_id"],
                name=rule["name"],
                is_default=rule["is_default"],
                subscription_id=rule["id"],
                can_add_content=rule["can_manage"],
            )
        )
    operations = [
        imports.import_from_row(
            row, can_manage=row["can_manage"], order_revision=row["order_revision"]
        )
        for row in snapshot["imports"]
    ]
    shows, recurring = _catalog(db, list(destinations))
    return wire.LibraryPodcastsOut(
        order_revision=str(snapshot["order_revision"]),
        removal_revision=str(snapshot["removal_revision"]),
        can_add_content=snapshot["can_manage"],
        subscriptions=[
            wire.PodcastLibraryShowOut(
                podcast=shows[p],
                destinations=destinations[p],
                recurring=recurring[p],
                imports=[op for op in operations if op.podcast_id == p and op.id in history_ids],
            )
            for p in sorted(destinations, key=lambda p: (shows[p].title.casefold(), p))
        ],
        imports=[op for op in operations if op.id not in history_ids],
    )


def read_library_podcast(
    db: Session, viewer_id: UUID, library_id: UUID, podcast_id: UUID
) -> wire.LibraryPodcastOut:
    row = (
        db.execute(
            text("""
        SELECT l.order_revision,u.removal_revision,
            l.system_key IS NULL AND ((l.is_default AND l.owner_user_id=:viewer_id)
                OR (NOT l.is_default AND lm.role='admin')) AS can_manage,
            (SELECT to_jsonb(s) FROM library_podcast_subscriptions s
                WHERE s.library_id=l.id AND s.podcast_id=:podcast_id) AS subscription,
            (SELECT to_jsonb(r)||to_jsonb(i)||jsonb_build_object('podcast_id',r.podcast_id,'podcast_title',p.title,'library_name',l.name,'library_is_default',l.is_default,'updated_at',r.updated_at)
                FROM podcast_library_imports i JOIN podcast_feed_runs r ON r.id=i.run_id
                WHERE i.library_id=l.id AND r.podcast_id=:podcast_id
                AND r.completed_at IS NULL AND r.cancelled_at IS NULL) AS import,
            (SELECT count(*) FROM library_entries e JOIN podcast_episodes pe ON pe.media_id=e.media_id
                WHERE e.library_id=l.id AND pe.podcast_id=:podcast_id) AS episode_count
        FROM libraries l JOIN memberships lm ON lm.library_id=l.id AND lm.user_id=:viewer_id
        JOIN users u ON u.id=:viewer_id JOIN podcasts p ON p.id=:podcast_id WHERE l.id=:library_id
    """),
            {"viewer_id": viewer_id, "library_id": library_id, "podcast_id": podcast_id},
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Library or podcast not found")
    return wire.LibraryPodcastOut.model_validate(
        {
            "library_id": library_id,
            "podcast_id": podcast_id,
            "subscription": row["subscription"],
            "import": None
            if row["import"] is None
            else imports.import_from_row(
                row["import"], can_manage=row["can_manage"], order_revision=row["order_revision"]
            ),
            "episode_count": row["episode_count"],
            "order_revision": str(row["order_revision"]),
            "removal_revision": str(row["removal_revision"]),
            "can_add_content": row["can_manage"],
        }
    )


def _plan(sort: SubscriptionSort) -> list[SortKey]:
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
    return (
        [SortKey("unplayed_count", "desc", KeysetValueKind.Int), *recency]
        if sort == "unplayed_count"
        else recency
    )


def list_podcasts(
    db: Session,
    viewer_id: UUID,
    *,
    limit: int,
    cursor: str | None,
    sort: SubscriptionSort,
    filter: SubscriptionFilter,
    library_id: UUID | None,
) -> CollectionPage[wire.PodcastListItemOut]:
    params: dict[str, object] = {"viewer_id": viewer_id}
    where = []
    if filter == "has_new":
        where.append("AND unplayed_count>0")
    if filter == "not_in_library":
        where.append(
            "AND NOT EXISTS (SELECT 1 FROM library_podcast_subscriptions s JOIN libraries l ON l.id=s.library_id JOIN memberships lm ON lm.library_id=l.id AND lm.user_id=:viewer_id WHERE s.podcast_id=o.podcast_id AND NOT l.is_default AND l.system_key IS NULL)"
        )
    if library_id is not None:
        libraries.access(db, viewer_id, library_id, lock=False)
        params["library_id"] = library_id
        where.append(
            f"AND podcast_id IN (SELECT podcast_id FROM ({library_entries.library_podcast_rows_sql()}) scoped)"
        )
    state = projection.episode_state_case_sql(listening_alias="pls", override_alias="co")
    joins = projection.episode_state_joins_sql(
        user_param=":viewer_id",
        media_expr="pe.media_id",
        listening_alias="pls",
        override_alias="co",
    )
    rows, next_cursor = keyset_page(
        db,
        binding={
            "list": "Podcasts",
            "viewer": viewer_id,
            "sort": sort,
            "filter": filter,
            "library": library_id,
        },
        plan=_plan(sort),
        cursor=cursor,
        limit=limit,
        params=params,
        alias="o",
        sql=lambda keyset, order: f"""
        WITH episodes AS (SELECT pe.podcast_id,pe.published_at,{state} AS episode_state
            FROM podcast_episodes pe JOIN ({visible_media_ids_cte_sql()}) vm ON vm.media_id=pe.media_id {joins}),
        o AS (SELECT s.podcast_id,s.followed_at,lower(p.title) AS title_key,
            count(e.*) FILTER(WHERE e.episode_state='unplayed') AS unplayed_count,
            max(e.published_at) AS latest_published_at,(max(e.published_at) IS NULL)::int AS latest_missing
            FROM ({active_subscription_rows_sql()}) s JOIN podcasts p ON p.id=s.podcast_id
            LEFT JOIN episodes e ON e.podcast_id=s.podcast_id GROUP BY s.podcast_id,s.followed_at,p.id)
        SELECT * FROM o WHERE TRUE {" ".join(where)} {keyset} ORDER BY {order} LIMIT :limit
    """,
    )
    shows, _ = _catalog(db, [row["podcast_id"] for row in rows])
    return CollectionPage(items=[shows[row["podcast_id"]] for row in rows], next_cursor=next_cursor)


def get_podcast_detail(db: Session, viewer_id: UUID, podcast_id: UUID) -> wire.PodcastDetailOut:
    shows, recurring = _catalog(db, [podcast_id])
    if podcast_id not in shows:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
    default_id = libraries.default_library_id(db, viewer_id)
    snapshot = _snapshot(db, viewer_id, default_id)
    destinations = [
        wire.PodcastDestinationOut(
            library_id=r["library_id"],
            name=r["name"],
            is_default=r["is_default"],
            subscription_id=r["id"],
            can_add_content=r["can_manage"],
        )
        for r in snapshot["rules"]
        if UUID(r["podcast_id"]) == podcast_id
    ]
    operations = [
        imports.import_from_row(r, can_manage=r["can_manage"], order_revision=r["order_revision"])
        for r in snapshot["imports"]
        if UUID(r["podcast_id"]) == podcast_id
    ]
    return wire.PodcastDetailOut(
        podcast=shows[podcast_id],
        destinations=destinations,
        recurring=recurring[podcast_id],
        imports=operations,
        playback_settings=settings.get_settings(db, viewer_id, podcast_id),
        episode_counts=episode_counts(db, viewer_id, podcast_id),
    )
