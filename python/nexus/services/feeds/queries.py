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

from nexus.auth.permissions import feed_catalog_ids_sql
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas import feed as wire
from nexus.schemas.collection_index import CollectionIndex
from nexus.services import libraries, library_entries
from nexus.services.browse.targets import PodcastIndexPodcastTarget, unseal_target
from nexus.services.collection_keyset import KeysetValueKind, SortKey, order_by_sql
from nexus.services.contributor_credits import load_contributor_credits_for_podcasts
from nexus.services.podcasts import settings

from . import imports
from .entries import entry_counts, entry_rows_sql

SubscriptionSort = Literal["recent_entry", "unfinished_count", "alpha"]
SubscriptionFilter = Literal["all", "has_new", "not_in_library"]


@dataclass(frozen=True, slots=True)
class FeedState:
    kind: wire.FeedKind
    subscribed: bool
    has_entries: bool
    feed_url: str | None
    website_url: str | None


@dataclass(frozen=True, slots=True)
class CompactFeedTarget:
    feed_id: UUID
    feed_kind: wire.FeedKind
    ref: str
    title: str
    image_url: str | None
    subtitle: str | None
    href: str


def active_subscription_rows_sql() -> str:
    """One active show per viewer across current non-system member libraries."""
    return """
        SELECT s.feed_id, f.kind AS feed_kind, min(s.created_at) AS followed_at
        FROM library_feed_subscriptions s
        JOIN feeds f ON f.id=s.feed_id
        JOIN libraries l ON l.id=s.library_id
        JOIN memberships lm ON lm.library_id=l.id AND lm.user_id=:viewer_id
        WHERE l.system_key IS NULL AND (NOT l.is_default OR l.owner_user_id=:viewer_id)
        GROUP BY s.feed_id,f.kind
    """


def feed_states(db: Session, *, viewer_id: UUID, feed_ids: list[UUID]) -> dict[UUID, FeedState]:
    rows = db.execute(
        text(f"""
        SELECT p.id,p.kind, CASE WHEN {exportable_feed_sql("p.id")} THEN p.feed_url ELSE NULL END AS feed_url,p.website_url, EXISTS(SELECT 1 FROM ({active_subscription_rows_sql()}) s
                             WHERE s.feed_id=p.id) AS subscribed,
               EXISTS(SELECT 1 FROM feed_entries pe
                      JOIN ({library_entries.library_media_ids_cte_sql(library_param="(SELECT id FROM libraries WHERE is_default AND owner_user_id=:viewer_id)")}) vm ON vm.media_id=pe.media_id
                      WHERE pe.feed_id=p.id) AS has_entries
        FROM feeds p WHERE p.id=ANY(CAST(:ids AS uuid[])) AND p.id IN ({readable_feed_ids_sql()})
    """),
        {"viewer_id": viewer_id, "ids": list(set(feed_ids))},
    )
    return {
        row.id: FeedState(row.kind, row.subscribed, row.has_entries, row.feed_url, row.website_url)
        for row in rows
    }


def action_facts(
    db: Session, *, viewer_id: UUID, targets: list[wire.FeedCommitTarget]
) -> wire.FeedActionFactsOut:
    """Resolve a validated batch and aggregate subscription state in the caller's snapshot."""
    canonical_ids: list[UUID] = []
    discovery_refs: dict[str, str] = {}
    invalid_handles: set[str] = set()
    for target in targets:
        if isinstance(target, wire.FeedCanonicalCommitTarget):
            canonical_ids.append(target.feed_id)
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
        SELECT id,provider,provider_podcast_id FROM feeds
        WHERE id=ANY(CAST(:ids AS uuid[]))
           OR (provider='podcast_index' AND provider_podcast_id=ANY(CAST(:refs AS text[])))
    """),
        {"ids": canonical_ids, "refs": list(set(discovery_refs.values()))},
    ).all()
    candidates = {row.id for row in rows}
    states = feed_states(db, viewer_id=viewer_id, feed_ids=list(candidates))
    found_ids = set(states)
    by_ref = {row.provider_podcast_id: row.id for row in rows if row.provider == "podcast_index"}
    items: list[wire.FeedActionResultOut] = []
    for target in targets:
        if isinstance(target, wire.FeedCanonicalCommitTarget):
            feed_id = target.feed_id if target.feed_id in found_ids else None
        else:
            if target.target in invalid_handles:
                items.append(
                    wire.FeedActionResultOut(
                        target=target,
                        resolution=wire.FeedActionUnavailableResolutionOut(
                            reason="InvalidDiscoveryTarget"
                        ),
                    )
                )
                continue
            feed_id = by_ref.get(discovery_refs[target.target])
        if feed_id is not None:
            resolution = wire.FeedActionCanonicalResolutionOut(
                feed_id=feed_id,
                feed_kind=states[feed_id].kind,
                subscribed=states[feed_id].subscribed,
            )
        elif isinstance(target, wire.FeedCanonicalCommitTarget):
            resolution = wire.FeedActionUnavailableResolutionOut(reason="NotFound")
        else:
            resolution = wire.FeedActionDiscoveryResolutionOut()
        items.append(wire.FeedActionResultOut(target=target, resolution=resolution))
    return wire.FeedActionFactsOut(items=items)


def hydrate_compact_feed_targets(
    db: Session, *, viewer_id: UUID, feed_ids: list[UUID]
) -> dict[UUID, CompactFeedTarget]:
    rows = db.execute(
        text(
            f"SELECT id,kind,title,image_url FROM feeds WHERE id=ANY(:ids) AND id IN ({readable_feed_ids_sql()})"
        ),
        {"viewer_id": viewer_id, "ids": list(set(feed_ids))},
    ).all()
    credits = load_contributor_credits_for_podcasts(
        db, [row.id for row in rows if row.kind == "podcast"]
    )
    return {
        row.id: CompactFeedTarget(
            row.id,
            row.kind,
            f"{'podcast' if row.kind == 'podcast' else 'feed'}:{row.id}",
            row.title,
            row.image_url,
            ", ".join(
                dict.fromkeys(
                    c.contributor_display_name or c.credited_name
                    for c in credits.get(row.id, [])
                    if c.role == "author"
                )
            )
            or None,
            f"/{'podcasts' if row.kind == 'podcast' else 'feeds'}/{row.id}",
        )
        for row in rows
    }


def _catalog[T: (wire.FeedListItemOut, wire.FeedIndexItemOut)](
    db: Session, viewer_id: UUID, ids: list[UUID], model: type[T]
) -> tuple[dict[UUID, T], dict[UUID, wire.FeedRecurringOut]]:
    columns = {
        f"p.{key}"
        if key != "feed_url"
        else f"CASE WHEN {exportable_feed_sql('p.id')} THEN p.feed_url ELSE NULL END AS feed_url"
        for key in model.model_fields
        if key != "contributors"
    }
    columns.update(
        f"p.{key}"
        for key in (
            "head_run_id",
            "last_checked_at",
            "last_check_had_coverage_gaps",
            "last_check_error_code",
            "last_check_error_detail",
            "next_sync_at",
            "last_catchup_at",
            "last_catchup_had_coverage_gaps",
            "last_catchup_error_code",
            "last_catchup_error_detail",
        )
    )
    rows = (
        db.execute(
            text(f"""
        SELECT {", ".join(sorted(columns))},r.started_at AS run_started_at,
            (r.completed_at IS NULL AND r.failed_at IS NULL AND r.cancelled_at IS NULL
                AND COALESCE(j.status IN ('pending', 'failed', 'running'), FALSE)) AS work_in_flight,
            COALESCE(hj.status IN ('pending','failed','running'),false) AS history_work_in_flight
        FROM feeds p
        LEFT JOIN feed_runs r ON r.id=p.head_run_id
        LEFT JOIN background_jobs j ON j.id=r.job_id
        LEFT JOIN feed_runs hr ON hr.id=p.catchup_run_id
        LEFT JOIN background_jobs hj ON hj.id=hr.job_id
        WHERE p.id=ANY(CAST(:ids AS uuid[])) AND p.id IN ({readable_feed_ids_sql()})
    """),
            {"ids": ids, "viewer_id": viewer_id},
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
        recurring[row["id"]] = wire.FeedRecurringOut(
            state=("running" if row["run_started_at"] else "pending")
            if row["head_run_id"]
            else "idle",
            work_in_flight=row["work_in_flight"],
            last_checked_at=row["last_checked_at"],
            had_coverage_gaps=row["last_check_had_coverage_gaps"],
            error_code=row["last_check_error_code"],
            error_detail=row["last_check_error_detail"],
            next_sync_at=row["next_sync_at"],
            history=wire.FeedHistoryOut(
                work_in_flight=row["history_work_in_flight"],
                last_checked_at=row["last_catchup_at"],
                had_coverage_gaps=row["last_catchup_had_coverage_gaps"],
                error_code=row["last_catchup_error_code"],
                error_detail=row["last_catchup_error_detail"],
            ),
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
            SELECT l.id,l.name,l.is_default,
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
                FROM library_feed_subscriptions s JOIN destinations d ON d.id=s.library_id),'[]') AS rules,
            COALESCE((SELECT jsonb_agg(to_jsonb(r)||to_jsonb(i)||jsonb_build_object(
                'feed_id',r.feed_id,'feed_title',p.title,'feed_kind',p.kind,'library_name',d.name,'library_is_default',d.is_default,'updated_at',r.updated_at,
                'can_manage',d.can_manage,'job_status',j.status,'subscription_id',(SELECT bound.id FROM library_feed_subscriptions bound WHERE bound.initial_import_id=i.id)))
                FROM library_feed_imports i JOIN feed_runs r ON r.id=i.run_id
                LEFT JOIN background_jobs j ON j.id=r.job_id
                JOIN feeds p ON p.id=r.feed_id JOIN destinations d ON d.id=i.library_id
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


def read_library_feeds(db: Session, viewer_id: UUID, library_id: UUID) -> wire.LibraryFeedsOut:
    snapshot = _snapshot(db, viewer_id, library_id)
    shows, recurring = _catalog(
        db, viewer_id, [UUID(rule["feed_id"]) for rule in snapshot["rules"]], wire.FeedListItemOut
    )
    return _library_feeds(dict(snapshot), shows, recurring, wire.LibraryFeedsOut)


def read_library_feed_index(
    db: Session, viewer_id: UUID, library_id: UUID
) -> wire.LibraryFeedIndexOut:
    snapshot = _snapshot(db, viewer_id, library_id)
    shows, recurring = _catalog(
        db, viewer_id, [UUID(rule["feed_id"]) for rule in snapshot["rules"]], wire.FeedIndexItemOut
    )
    return _library_feeds(dict(snapshot), shows, recurring, wire.LibraryFeedIndexOut)


def _library_feeds[T: (wire.LibraryFeedsOut, wire.LibraryFeedIndexOut)](
    snapshot: Mapping[str, Any],
    shows: Mapping[UUID, wire.FeedListItemOut | wire.FeedIndexItemOut],
    recurring: dict[UUID, wire.FeedRecurringOut],
    model: type[T],
) -> T:
    destinations: dict[UUID, list[wire.FeedDestinationOut]] = {}
    history_ids = {UUID(rule["initial_import_id"]) for rule in snapshot["rules"]}
    for rule in snapshot["rules"]:
        p = UUID(rule["feed_id"])
        destinations.setdefault(p, []).append(
            wire.FeedDestinationOut(
                library_id=rule["library_id"],
                name=rule["name"],
                is_default=rule["is_default"],
                subscription_id=rule["id"],
                can_add_content=rule["can_manage"],
            )
        )
    operations = [
        imports.import_from_row(row, can_manage=row["can_manage"]) for row in snapshot["imports"]
    ]
    followed_imports: dict[UUID, list[wire.FeedImportOut]] = {}
    standalone_imports = []
    for operation in operations:
        if operation.id in history_ids:
            followed_imports.setdefault(operation.feed_id, []).append(operation)
        else:
            standalone_imports.append(operation)
    return model.model_validate(
        {
            "order_revision": str(snapshot["order_revision"]),
            "removal_revision": str(snapshot["removal_revision"]),
            "can_add_content": snapshot["can_manage"],
            "subscriptions": [
                {
                    "feed": shows[p],
                    "destinations": destinations[p],
                    "recurring": recurring[p],
                    "imports": followed_imports.get(p, []),
                }
                for p in sorted(destinations, key=lambda p: (shows[p].title.casefold(), p))
            ],
            "imports": standalone_imports,
        }
    )


def read_library_feed(
    db: Session, viewer_id: UUID, library_id: UUID, feed_id: UUID
) -> wire.LibraryFeedOut:
    require_feed_access(db, viewer_id, feed_id)
    row = (
        db.execute(
            text("""
        SELECT u.removal_revision,
            l.system_key IS NULL AND ((l.is_default AND l.owner_user_id=:viewer_id)
                OR (NOT l.is_default AND lm.role='admin')) AS can_manage,
            (SELECT to_jsonb(s) FROM library_feed_subscriptions s
                WHERE s.library_id=l.id AND s.feed_id=:feed_id) AS subscription,
            (SELECT to_jsonb(r)||to_jsonb(i)||jsonb_build_object('feed_id',r.feed_id,'feed_title',p.title,'feed_kind',p.kind,'library_name',l.name,'library_is_default',l.is_default,'updated_at',r.updated_at,'job_status',j.status,'subscription_id',(SELECT bound.id FROM library_feed_subscriptions bound WHERE bound.initial_import_id=i.id))
                FROM library_feed_imports i JOIN feed_runs r ON r.id=i.run_id
                LEFT JOIN background_jobs j ON j.id=r.job_id
                WHERE i.library_id=l.id AND r.feed_id=:feed_id
                AND r.completed_at IS NULL AND r.cancelled_at IS NULL) AS operation,
            (SELECT count(DISTINCT e.media_id) FROM library_entries e JOIN feed_entries pe ON pe.media_id=e.media_id
                WHERE e.library_id=l.id AND pe.feed_id=:feed_id) AS entry_count
        FROM libraries l JOIN memberships lm ON lm.library_id=l.id AND lm.user_id=:viewer_id
        JOIN users u ON u.id=:viewer_id JOIN feeds p ON p.id=:feed_id WHERE l.id=:library_id
    """),
            {"viewer_id": viewer_id, "library_id": library_id, "feed_id": feed_id},
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Library or feed not found")
    return wire.LibraryFeedOut.model_validate(
        {
            "library_id": library_id,
            "feed_id": feed_id,
            "subscription": row["subscription"],
            "operation": None
            if row["operation"] is None
            else imports.import_from_row(row["operation"], can_manage=row["can_manage"]),
            "entry_count": row["entry_count"],
            "removal_revision": str(row["removal_revision"]),
            "can_add_content": row["can_manage"],
        }
    )


def feed_order_plan(sort: SubscriptionSort) -> list[SortKey]:
    if sort == "alpha":
        return [
            SortKey("title_key", "asc", KeysetValueKind.Text),
            SortKey("feed_id", "asc", KeysetValueKind.Uuid),
        ]
    recency = [
        SortKey("latest_missing", "asc", KeysetValueKind.Int),
        SortKey("latest_published_at", "desc", KeysetValueKind.DateTimeOrNull),
        SortKey("followed_at", "desc", KeysetValueKind.DateTime),
        SortKey("feed_id", "desc", KeysetValueKind.Uuid),
    ]
    return (
        [SortKey("unfinished_count", "desc", KeysetValueKind.Int), *recency]
        if sort == "unfinished_count"
        else recency
    )


def feed_index_rows_sql() -> str:
    """Active personal shows and all canonical index ordering/filter facts."""
    return f"""
        WITH entries AS (SELECT e.feed_id,e.media_id,e.publication_order AS published_at,e.entry_state
            FROM ({entry_rows_sql()}) e),
        o AS (SELECT s.feed_id,s.feed_kind,s.followed_at,lower(p.title) AS title_key,
            count(DISTINCT e.media_id) FILTER(WHERE e.entry_state<>'finished') AS unfinished_count,
            count(DISTINCT e.media_id) FILTER(WHERE e.entry_state='unread') AS unread_count,
            max(e.published_at) AS latest_published_at,(max(e.published_at) IS NULL)::int AS latest_missing
            FROM ({active_subscription_rows_sql()}) s JOIN feeds p ON p.id=s.feed_id
            LEFT JOIN entries e ON e.feed_id=s.feed_id GROUP BY s.feed_id,s.feed_kind,s.followed_at,p.id)
        SELECT o.*, NOT EXISTS (
            SELECT 1 FROM library_feed_subscriptions s
            JOIN libraries l ON l.id=s.library_id AND NOT l.is_default AND l.system_key IS NULL
            JOIN memberships lm ON lm.library_id=l.id AND lm.user_id=:viewer_id
            WHERE s.feed_id=o.feed_id) AS not_in_library FROM o
    """


def list_feeds(
    db: Session,
    viewer_id: UUID,
    *,
    sort: SubscriptionSort,
    filter: SubscriptionFilter,
    library_id: UUID | None,
    kind: wire.FeedKind | None = None,
) -> CollectionIndex[wire.FeedIndexItemOut]:
    params: dict[str, object] = {"viewer_id": viewer_id}
    where = []
    if kind is not None:
        params["kind"] = kind
        where.append("AND feed_kind=:kind")
    if filter == "has_new":
        where.append("AND unread_count>0")
    if filter == "not_in_library":
        where.append("AND not_in_library")
    if library_id is not None:
        libraries.access(db, viewer_id, library_id, lock=False)
        params["library_id"] = library_id
        where.append(
            f"AND feed_id IN (SELECT feed_id FROM ({library_entries.library_feed_rows_sql()}) scoped)"
        )
    order = order_by_sql(feed_order_plan(sort), alias="o")
    rows = (
        db.execute(
            text(f"""
            WITH o AS ({feed_index_rows_sql()})
            SELECT * FROM o WHERE TRUE {" ".join(where)} ORDER BY {order}
        """),
            params,
        )
        .mappings()
        .all()
    )
    shows, _ = _catalog(db, viewer_id, [row["feed_id"] for row in rows], wire.FeedIndexItemOut)
    return CollectionIndex(items=[shows[row["feed_id"]] for row in rows])


def get_feed_detail(db: Session, viewer_id: UUID, feed_id: UUID) -> wire.FeedDetailOut:
    require_feed_access(db, viewer_id, feed_id)
    _, details = read_catalog(db, viewer_id, [], {feed_id: entry_counts(db, viewer_id, feed_id)})
    return details[feed_id]


def catalog_feed_ids_sql() -> str:
    """The permission owner's one source-catalogue authority relation."""
    return feed_catalog_ids_sql()


def read_catalog(
    db: Session,
    viewer_id: UUID,
    member_libraries: Sequence[libraries.LibraryAccess],
    counts: dict[UUID, wire.FeedEntryCountsOut],
) -> tuple[dict[UUID, wire.LibraryFeedsOut], dict[UUID, wire.FeedDetailOut]]:
    """Complete included sections and show details; one account relationship snapshot.

    The caller admits shows and captures their exact visible episode counts in its
    repeatable-read transaction. Metadata/settings hydrate in batches, never per show.
    """
    default_id = libraries.default_library_id(db, viewer_id)
    snapshot = _snapshot(db, viewer_id, default_id)
    shows, recurring = _catalog(db, viewer_id, list(counts), wire.FeedListItemOut)
    if set(shows) != set(counts):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Feed not found")
    playback_settings = settings.get_settings_many(
        db, viewer_id, [id for id, source in shows.items() if source.kind == "podcast"]
    )
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
        sections[library.id] = _library_feeds(scoped, shows, recurring, wire.LibraryFeedsOut)
    destinations: dict[UUID, list[wire.FeedDestinationOut]] = {}
    for rule in snapshot["rules"]:
        destinations.setdefault(UUID(rule["feed_id"]), []).append(
            wire.FeedDestinationOut(
                library_id=rule["library_id"],
                name=rule["name"],
                is_default=rule["is_default"],
                subscription_id=rule["id"],
                can_add_content=rule["can_manage"],
            )
        )
    operations: dict[UUID, list[wire.FeedImportOut]] = {}
    for row in snapshot["imports"]:
        operation = imports.import_from_row(row, can_manage=row["can_manage"])
        operations.setdefault(operation.feed_id, []).append(operation)
    details = {
        feed_id: wire.FeedDetailOut(
            feed=shows[feed_id],
            destinations=destinations.get(feed_id, []),
            recurring=recurring[feed_id],
            imports=operations.get(feed_id, []),
            playback_settings=playback_settings.get(feed_id),
            entry_counts=count,
        )
        for feed_id, count in counts.items()
    }
    return sections, details


def readable_feed_ids_sql() -> str:
    return f"SELECT id AS feed_id FROM feeds WHERE kind='podcast' UNION SELECT feed_id FROM ({catalog_feed_ids_sql()}) owned"


def exportable_feed_sql(feed_expr: str) -> str:
    return f"""(EXISTS(SELECT 1 FROM feed_catalog_access access WHERE access.feed_id={feed_expr} AND access.user_id=:viewer_id)
        OR EXISTS(SELECT 1 FROM library_feed_subscriptions s JOIN libraries l ON l.id=s.library_id
            JOIN memberships m ON m.library_id=l.id AND m.user_id=:viewer_id
            WHERE s.feed_id={feed_expr} AND l.system_key IS NULL
              AND ((l.is_default AND l.owner_user_id=:viewer_id) OR (NOT l.is_default AND m.role='admin'))))"""


def require_feed_access(db: Session, viewer_id: UUID, feed_id: UUID) -> None:
    if not db.scalar(
        text(f"SELECT EXISTS(SELECT 1 FROM ({readable_feed_ids_sql()}) source WHERE feed_id=:id)"),
        {"viewer_id": viewer_id, "id": feed_id},
    ):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Feed not found")
