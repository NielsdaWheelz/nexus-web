"""Library-owned subscriptions and imports, with physical episode membership.

Section guards, relationships and progress come from one SQL snapshot. Catalog
metadata is hydrated in batches. Reads acquire nothing and never expand show roots
into episode placements. Action facts resolve sealed identities locally, using the
same authenticated catalog existence rule as detail; they never contact a provider.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import requested_media_ids_cte_sql
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas import podcast as wire
from nexus.schemas.collection_index import CollectionIndex
from nexus.services import libraries, library_entries
from nexus.services.browse.targets import PodcastIndexPodcastTarget, unseal_target
from nexus.services.collection_keyset import KeysetValueKind, SortKey, order_by_sql
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
    feed_url: str
    website_url: str | None


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
        SELECT p.id, p.feed_url, p.website_url, EXISTS(SELECT 1 FROM ({active_subscription_rows_sql()}) s
                             WHERE s.podcast_id=p.id) AS subscribed,
               EXISTS(SELECT 1 FROM podcast_episodes pe
                      JOIN ({library_entries.library_media_ids_cte_sql(library_param="(SELECT id FROM libraries WHERE is_default AND owner_user_id=:viewer_id)")}) vm ON vm.media_id=pe.media_id
                      WHERE pe.podcast_id=p.id) AS has_episodes
        FROM podcasts p WHERE p.id=ANY(CAST(:ids AS uuid[]))
    """),
        {"viewer_id": viewer_id, "ids": list(set(podcast_ids))},
    )
    return {
        row.id: PodcastState(row.subscribed, row.has_episodes, row.feed_url, row.website_url)
        for row in rows
    }


def action_facts(
    db: Session, *, viewer_id: UUID, targets: list[wire.PodcastCommitTarget]
) -> wire.PodcastActionFactsOut:
    """Resolve a validated batch and aggregate subscription state in the caller's snapshot."""
    canonical_ids: list[UUID] = []
    discovery_refs: dict[str, str] = {}
    invalid_handles: set[str] = set()
    for target in targets:
        if isinstance(target, wire.PodcastCanonicalCommitTarget):
            canonical_ids.append(target.podcast_id)
            continue
        try:
            decoded = unseal_target(target.target)
        except InvalidRequestError as exc:
            if exc.code != ApiErrorCode.E_INVALID_DISCOVERY_TARGET:
                raise
            invalid_handles.add(target.target)
            continue
        if isinstance(decoded, PodcastIndexPodcastTarget):
            discovery_refs[target.target] = decoded.podcast_ref
        else:
            invalid_handles.add(target.target)

    rows = db.execute(
        text("""
        SELECT id,provider,provider_podcast_id FROM podcasts
        WHERE id=ANY(CAST(:ids AS uuid[]))
           OR (provider='podcast_index' AND provider_podcast_id=ANY(CAST(:refs AS text[])))
    """),
        {"ids": canonical_ids, "refs": list(set(discovery_refs.values()))},
    ).all()
    found_ids = {row.id for row in rows}
    by_ref = {row.provider_podcast_id: row.id for row in rows if row.provider == "podcast_index"}
    states = podcast_states(db, viewer_id=viewer_id, podcast_ids=list(found_ids))
    items: list[wire.PodcastActionResultOut] = []
    for target in targets:
        if isinstance(target, wire.PodcastCanonicalCommitTarget):
            podcast_id = target.podcast_id if target.podcast_id in found_ids else None
        else:
            if target.target in invalid_handles:
                items.append(
                    wire.PodcastActionResultOut(
                        target=target,
                        resolution=wire.PodcastActionUnavailableResolutionOut(
                            reason="InvalidDiscoveryTarget"
                        ),
                    )
                )
                continue
            podcast_id = by_ref.get(discovery_refs[target.target])
        if podcast_id is not None:
            resolution = wire.PodcastActionCanonicalResolutionOut(
                podcast_id=podcast_id, subscribed=states[podcast_id].subscribed
            )
        elif isinstance(target, wire.PodcastCanonicalCommitTarget):
            resolution = wire.PodcastActionUnavailableResolutionOut(reason="NotFound")
        else:
            resolution = wire.PodcastActionDiscoveryResolutionOut()
        items.append(wire.PodcastActionResultOut(target=target, resolution=resolution))
    return wire.PodcastActionFactsOut(items=items)


def hydrate_compact_podcast_targets(
    db: Session, *, viewer_id: UUID, podcast_ids: list[UUID]
) -> dict[UUID, CompactPodcastTarget]:
    from nexus.services.resource_graph.refs import ResourceRef
    from nexus.services.resource_items.routing import resource_activations_for_refs

    rows = db.execute(
        text("""
        SELECT p.id,p.title FROM podcasts p WHERE p.id=ANY(CAST(:ids AS uuid[]))
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


def _catalog[T: (wire.PodcastListItemOut, wire.PodcastIndexItemOut)](
    db: Session, ids: list[UUID], model: type[T]
) -> tuple[dict[UUID, T], dict[UUID, wire.PodcastRecurringOut]]:
    columns = {f"p.{key}" for key in model.model_fields if key != "contributors"}
    columns.update(
        f"p.{key}"
        for key in (
            "sync_run_id",
            "last_checked_at",
            "last_check_had_coverage_gaps",
            "last_check_error_code",
            "last_check_error_detail",
            "next_sync_at",
        )
    )
    rows = (
        db.execute(
            text(f"""
        SELECT {", ".join(sorted(columns))},r.started_at AS run_started_at FROM podcasts p
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
        shows[row["id"]] = model(
            **{k: row[k] for k in model.model_fields if k != "contributors"},
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
                'can_manage',d.can_manage,'subscription_id',(SELECT bound.id FROM library_podcast_subscriptions bound WHERE bound.initial_import_id=i.id)))
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
    shows, recurring = _catalog(
        db, [UUID(rule["podcast_id"]) for rule in snapshot["rules"]], wire.PodcastListItemOut
    )
    return _library_podcasts(dict(snapshot), shows, recurring, wire.LibraryPodcastsOut)


def read_library_podcast_index(
    db: Session, viewer_id: UUID, library_id: UUID
) -> wire.LibraryPodcastIndexOut:
    snapshot = _snapshot(db, viewer_id, library_id)
    shows, recurring = _catalog(
        db, [UUID(rule["podcast_id"]) for rule in snapshot["rules"]], wire.PodcastIndexItemOut
    )
    return _library_podcasts(dict(snapshot), shows, recurring, wire.LibraryPodcastIndexOut)


def _library_podcasts[T: (wire.LibraryPodcastsOut, wire.LibraryPodcastIndexOut)](
    snapshot: Mapping[str, Any],
    shows: Mapping[UUID, wire.PodcastListItemOut | wire.PodcastIndexItemOut],
    recurring: dict[UUID, wire.PodcastRecurringOut],
    model: type[T],
) -> T:
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
    followed_imports: dict[UUID, list[wire.PodcastImportOut]] = {}
    standalone_imports = []
    for operation in operations:
        if operation.id in history_ids:
            followed_imports.setdefault(operation.podcast_id, []).append(operation)
        else:
            standalone_imports.append(operation)
    return model.model_validate(
        {
            "order_revision": str(snapshot["order_revision"]),
            "removal_revision": str(snapshot["removal_revision"]),
            "can_add_content": snapshot["can_manage"],
            "subscriptions": [
                {
                    "podcast": shows[p],
                    "destinations": destinations[p],
                    "recurring": recurring[p],
                    "imports": followed_imports.get(p, []),
                }
                for p in sorted(destinations, key=lambda p: (shows[p].title.casefold(), p))
            ],
            "imports": standalone_imports,
        }
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
            (SELECT to_jsonb(r)||to_jsonb(i)||jsonb_build_object('podcast_id',r.podcast_id,'podcast_title',p.title,'library_name',l.name,'library_is_default',l.is_default,'updated_at',r.updated_at,'subscription_id',(SELECT bound.id FROM library_podcast_subscriptions bound WHERE bound.initial_import_id=i.id))
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


def podcast_order_plan(sort: SubscriptionSort) -> list[SortKey]:
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


def podcast_index_rows_sql() -> str:
    """Active personal shows and all canonical index ordering/filter facts."""
    state = projection.episode_state_case_sql(listening_alias="pls", override_alias="co")
    joins = projection.episode_state_joins_sql(
        user_param=":viewer_id",
        media_expr="pe.media_id",
        listening_alias="pls",
        override_alias="co",
    )
    return f"""
        WITH episodes AS (SELECT pe.podcast_id,pe.published_at,{state} AS episode_state
            FROM podcast_episodes pe JOIN ({requested_media_ids_cte_sql()}) vm ON vm.media_id=pe.media_id {joins}),
        o AS (SELECT s.podcast_id,s.followed_at,lower(p.title) AS title_key,
            count(e.*) FILTER(WHERE e.episode_state='unplayed') AS unplayed_count,
            max(e.published_at) AS latest_published_at,(max(e.published_at) IS NULL)::int AS latest_missing
            FROM ({active_subscription_rows_sql()}) s JOIN podcasts p ON p.id=s.podcast_id
            LEFT JOIN episodes e ON e.podcast_id=s.podcast_id GROUP BY s.podcast_id,s.followed_at,p.id)
        SELECT o.*, NOT EXISTS (
            SELECT 1 FROM library_podcast_subscriptions s
            JOIN libraries l ON l.id=s.library_id AND NOT l.is_default AND l.system_key IS NULL
            JOIN memberships lm ON lm.library_id=l.id AND lm.user_id=:viewer_id
            WHERE s.podcast_id=o.podcast_id) AS not_in_library
        FROM o
    """


def list_podcasts(
    db: Session,
    viewer_id: UUID,
    *,
    sort: SubscriptionSort,
    filter: SubscriptionFilter,
    library_id: UUID | None,
) -> CollectionIndex[wire.PodcastIndexItemOut]:
    params: dict[str, object] = {"viewer_id": viewer_id}
    where = []
    if filter == "has_new":
        where.append("AND unplayed_count>0")
    if filter == "not_in_library":
        where.append("AND not_in_library")
    if library_id is not None:
        libraries.access(db, viewer_id, library_id, lock=False)
        params["library_id"] = library_id
        where.append(
            f"AND podcast_id IN (SELECT podcast_id FROM ({library_entries.library_podcast_rows_sql()}) scoped)"
        )
    order = order_by_sql(podcast_order_plan(sort), alias="o")
    rows = (
        db.execute(
            text(f"""
            WITH o AS ({podcast_index_rows_sql()})
            SELECT * FROM o WHERE TRUE {" ".join(where)} ORDER BY {order}
        """),
            params,
        )
        .mappings()
        .all()
    )
    shows, _ = _catalog(db, [row["podcast_id"] for row in rows], wire.PodcastIndexItemOut)
    return CollectionIndex(items=[shows[row["podcast_id"]] for row in rows])


def get_podcast_detail(db: Session, viewer_id: UUID, podcast_id: UUID) -> wire.PodcastDetailOut:
    _, details = read_catalog(
        db, viewer_id, [], {podcast_id: episode_counts(db, viewer_id, podcast_id)}
    )
    return details[podcast_id]


def catalog_show_ids_sql() -> str:
    """Personal active subscriptions and unfinished member-library imports."""
    return f"""
        SELECT podcast_id FROM ({active_subscription_rows_sql()}) subscriptions
        UNION
        SELECT r.podcast_id FROM podcast_library_imports i
        JOIN podcast_feed_runs r ON r.id=i.run_id
        JOIN libraries l ON l.id=i.library_id AND l.system_key IS NULL
        JOIN memberships m ON m.library_id=l.id AND m.user_id=:viewer_id
        WHERE r.completed_at IS NULL AND r.cancelled_at IS NULL
          AND (NOT l.is_default OR l.owner_user_id=:viewer_id)
    """


def read_catalog(
    db: Session,
    viewer_id: UUID,
    member_libraries: Sequence[libraries.LibraryAccess],
    counts: dict[UUID, wire.PodcastEpisodeCountsOut],
) -> tuple[dict[UUID, wire.LibraryPodcastsOut], dict[UUID, wire.PodcastDetailOut]]:
    """Complete included sections and show details; one account relationship snapshot.

    The caller admits shows and captures their exact visible episode counts in its
    repeatable-read transaction. Metadata/settings hydrate in batches, never per show.
    """
    default_id = libraries.default_library_id(db, viewer_id)
    snapshot = _snapshot(db, viewer_id, default_id)
    shows, recurring = _catalog(db, list(counts), wire.PodcastListItemOut)
    if set(shows) != set(counts):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
    playback_settings = settings.get_settings_many(db, viewer_id, list(counts))
    sections = {}
    for library in member_libraries:
        scoped = dict(snapshot)
        if not library.is_default:
            scoped["rules"] = [
                row for row in snapshot["rules"] if UUID(row["library_id"]) == library.id
            ]
            scoped["imports"] = [
                row for row in snapshot["imports"] if UUID(row["library_id"]) == library.id
            ]
        scoped["order_revision"] = library.order_revision
        scoped["can_manage"] = library.out(viewer_id).can_add_content
        sections[library.id] = _library_podcasts(scoped, shows, recurring, wire.LibraryPodcastsOut)
    destinations: dict[UUID, list[wire.PodcastDestinationOut]] = {}
    for rule in snapshot["rules"]:
        destinations.setdefault(UUID(rule["podcast_id"]), []).append(
            wire.PodcastDestinationOut(
                library_id=rule["library_id"],
                name=rule["name"],
                is_default=rule["is_default"],
                subscription_id=rule["id"],
                can_add_content=rule["can_manage"],
            )
        )
    operations: dict[UUID, list[wire.PodcastImportOut]] = {}
    for row in snapshot["imports"]:
        operation = imports.import_from_row(
            row, can_manage=row["can_manage"], order_revision=row["order_revision"]
        )
        operations.setdefault(operation.podcast_id, []).append(operation)
    details = {
        podcast_id: wire.PodcastDetailOut(
            podcast=shows[podcast_id],
            destinations=destinations.get(podcast_id, []),
            recurring=recurring[podcast_id],
            imports=operations.get(podcast_id, []),
            playback_settings=playback_settings[podcast_id],
            episode_counts=count,
        )
        for podcast_id, count in counts.items()
    }
    return sections, details
