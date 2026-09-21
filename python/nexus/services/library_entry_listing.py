"""Library entry listing: view lenses, the keyset page query, and hydration.

Every read path over `library_entries` lives here — strict view parsing, the
sort-key plans and their cursor binding, the single page statement, and
hydration into the wire DTOs. `library_entries` owns the writes; this module
depends on it and never the other way round.
"""

import math
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from typing import Any, Literal, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.collection_page import (
    CollectionCursor,
    CollectionPage,
    CollectionRevision,
    ParsedCollectionQuery,
    parse_collection_query,
)
from nexus.schemas.library import (
    LibraryEntryListItemOut,
    LibraryEntryMediaCapabilitiesOut,
    LibraryEntryMediaOut,
    LibraryEntryPlacementOut,
    LibraryEntryPodcastOut,
    LibraryEntryPodcastSubscriptionOut,
    LibraryMediaListItemOut,
    LibraryPodcastListItemOut,
    ReadingTimeEstimateOut,
)
from nexus.schemas.presence import Presence, absent, presence_from_nullable, present
from nexus.services import library_governance as governance
from nexus.services.collection_keyset import Direction, SortKey, plan_json
from nexus.services.collection_revisions import (
    CollectionFamily,
    read_collection_revision,
    require_collection_revision,
)
from nexus.services.consumption import projection
from nexus.services.contributor_credits import (
    load_contributor_credits_for_podcasts,
    primary_creator_rows_sql,
)
from nexus.services.keyset_cursor import KeysetValueKind
from nexus.services.library_entries import library_media_ids_cte_sql
from nexus.services.media_document_metrics import load_media_word_counts
from nexus.services.podcasts.playback_preferences import pause_shortening_mode_from_nullable

type EntrySort = Literal["canonical", "title", "creator", "published", "added"]
type EntryProjection = Literal["all-items", "unfiled", "in-progress"]
type EntryCompletion = Literal["all", "unfinished"]
type EntryType = Literal["web_article", "epub", "pdf", "video", "podcast_episode", "podcast"]

_FACTUAL_SORTS: tuple[EntrySort, ...] = ("title", "creator", "published", "added")
_ENTRY_TYPES: tuple[EntryType, ...] = (
    "web_article",
    "epub",
    "pdf",
    "video",
    "podcast_episode",
    "podcast",
)
_VIEW_QUERY_KEYS = frozenset({"sort", "direction", "completion", "projection", "entry_type"})


@dataclass(frozen=True, slots=True)
class LibraryEntryView:
    """One advertised lens over a library's entries. `direction` is meaningless
    for the canonical order, which has exactly one spelling."""

    sort: EntrySort
    direction: Direction
    projection: EntryProjection
    completion: EntryCompletion
    entry_type: EntryType | None


def _invalid(message: str) -> InvalidRequestError:
    return InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, message)


def parse_entries_query(
    items: Sequence[tuple[str, str]],
) -> tuple[LibraryEntryView, ParsedCollectionQuery]:
    """Strict entry-view parse over the request's `multi_items()`.

    Every malformed request — unknown or duplicate key, factual sort without a
    direction, direction without a factual sort, an unrepresentable combination
    — is E_INVALID_REQUEST. Cursor validity is checked separately at decode.
    """
    query = parse_collection_query(items, domain_keys=_VIEW_QUERY_KEYS)
    raw_sort = query.parameters.get("sort")
    raw_direction = query.parameters.get("direction")
    if raw_sort is None:
        if raw_direction is not None:
            raise _invalid("direction requires a factual sort")
        sort: EntrySort = "canonical"
        direction: Direction = "asc"
    else:
        if raw_sort not in _FACTUAL_SORTS:
            raise _invalid("Unsupported sort")
        if raw_direction not in ("asc", "desc"):
            raise _invalid("Factual sort requires direction asc or desc")
        sort = raw_sort
        direction = raw_direction

    raw_completion = query.parameters.get("completion")
    if raw_completion is not None and raw_completion != "unfinished":
        raise _invalid("Unsupported completion")
    completion: EntryCompletion = "all" if raw_completion is None else "unfinished"

    raw_projection = query.parameters.get("projection")
    if raw_projection is None:
        entry_projection: EntryProjection = "all-items"
    elif raw_projection in ("unfiled", "in-progress"):
        entry_projection = raw_projection
    else:
        raise _invalid("Unsupported projection")
    if entry_projection == "in-progress" and completion == "unfinished":
        raise _invalid("In Progress cannot filter completion")

    entry_type = query.parameters.get("entry_type")
    if entry_type is not None and entry_type not in _ENTRY_TYPES:
        raise _invalid("Unsupported Library entry type")
    if entry_type == "podcast" and (entry_projection != "all-items" or completion != "all"):
        raise _invalid("Podcast shows support only the complete all-items view")

    return (
        LibraryEntryView(
            sort=sort,
            direction=direction,
            projection=entry_projection,
            completion=completion,
            entry_type=entry_type,
        ),
        query,
    )


# Every plan ends in the heterogeneous target identity; missing-rank keys are
# ALWAYS ASC so missing values sort last in both directions.
_IDENTITY = (
    SortKey("target_kind", "asc", KeysetValueKind.Text),
    SortKey("target_id", "desc", KeysetValueKind.Uuid),
)


def _plan(view: LibraryEntryView, *, is_default: bool) -> tuple[SortKey, ...]:
    """The total, stable sort-key plan driving ORDER BY, the keyset and the cursor."""
    if view.sort == "canonical":
        anchor = (
            SortKey("added_at", "desc", KeysetValueKind.DateTime)
            if is_default
            else SortKey("position", "asc", KeysetValueKind.Int)
        )
        return (anchor, *_IDENTITY)
    if view.sort == "title":
        return (SortKey("title_key", view.direction, KeysetValueKind.Text), *_IDENTITY)
    if view.sort == "added":
        return (SortKey("added_at", view.direction, KeysetValueKind.DateTime), *_IDENTITY)
    column = "creator_name" if view.sort == "creator" else "published_date"
    return (
        SortKey(f"{view.sort}_missing", "asc", KeysetValueKind.Int),
        SortKey(column, view.direction, KeysetValueKind.TextOrNull),
        SortKey("title_key", "asc", KeysetValueKind.Text),
        *_IDENTITY,
    )


_READING_WORDS_PER_MINUTE = 240


def _display_reading_minutes(word_count: int, fraction: float) -> int:
    """Half-up rounding to a 1-, 5- or 15-minute quantum as the estimate grows."""
    raw_minutes = word_count * fraction / _READING_WORDS_PER_MINUTE
    quantum = 1 if raw_minutes < 10 else (5 if raw_minutes < 60 else 15)
    return max(1, quantum * math.floor(raw_minutes / quantum + 0.5))


def _reading_time_estimates(
    db: Session, media_by_id: dict[UUID, Any]
) -> dict[UUID, ReadingTimeEstimateOut]:
    """Total (and, for in-progress web/EPUB, remaining) reading time per media."""
    eligible = [
        media.id
        for media in media_by_id.values()
        if media.kind in ("web_article", "epub", "pdf") and media.capabilities.can_quote
    ]
    word_counts = load_media_word_counts(db, eligible) if eligible else {}
    estimates: dict[UUID, ReadingTimeEstimateOut] = {}
    for media_id in eligible:
        word_count = word_counts[media_id]
        if word_count == 0:
            continue
        media = media_by_id[media_id]
        remaining: Presence[int] = absent()
        if (
            media.kind in ("web_article", "epub")
            and media.read_state == "in_progress"
            and media.progress_fraction is not None
        ):
            remaining = present(_display_reading_minutes(word_count, 1.0 - media.progress_fraction))
        estimates[media_id] = ReadingTimeEstimateOut(
            total_minutes=_display_reading_minutes(word_count, 1.0), remaining_minutes=remaining
        )
    return estimates


def _podcast_rows(db: Session, *, viewer_id: UUID, podcast_ids: list[UUID]) -> dict[UUID, Any]:
    """Show title, latest publication, unplayed count and the viewer's subscription."""
    if not podcast_ids:
        return {}
    rows = (
        db.execute(
            text(f"""
            WITH visible_media AS (
                {visible_media_ids_cte_sql()}
            ),
            podcast_unplayed AS (
                SELECT
                    pe.podcast_id,
                    COUNT(*) FILTER (
                        WHERE {
                projection.episode_state_case_sql(
                    listening_alias="pls", override_alias="co", episode_alias="pe"
                )
            } = 'unplayed'
                    ) AS unplayed_count
                FROM podcast_episodes pe
                JOIN visible_media vm ON vm.media_id = pe.media_id
                {
                projection.episode_state_joins_sql(
                    user_param=":viewer_id",
                    media_expr="pe.media_id",
                    listening_alias="pls",
                    override_alias="co",
                )
            }
                WHERE pe.podcast_id = ANY(:podcast_ids)
                GROUP BY pe.podcast_id
            )
            SELECT
                p.id AS podcast_id,
                p.title AS title,
                latest_episode.published_at AS latest_episode_published_at,
                COALESCE(pu.unplayed_count, 0) AS unplayed_count,
                ps.id AS sub_id,
                ps.default_playback_speed AS sub_default_playback_speed,
                ps.pause_shortening_mode AS sub_pause_shortening_mode,
                ps.auto_queue AS sub_auto_queue,
                ps.sync_status AS sub_sync_status
            FROM podcasts p
            LEFT JOIN podcast_unplayed pu ON pu.podcast_id = p.id
            LEFT JOIN (
                SELECT podcast_id, max(published_at) AS published_at
                FROM podcast_episodes
                WHERE podcast_id = ANY(:podcast_ids)
                GROUP BY podcast_id
            ) latest_episode ON latest_episode.podcast_id = p.id
            LEFT JOIN podcast_subscriptions ps ON ps.podcast_id = p.id AND ps.user_id = :viewer_id
            WHERE p.id = ANY(:podcast_ids)
        """),
            {"viewer_id": viewer_id, "podcast_ids": podcast_ids},
        )
        .mappings()
        .all()
    )
    return {UUID(str(row["podcast_id"])): row for row in rows}


def _placement(row: Any) -> Presence[LibraryEntryPlacementOut]:
    if row["is_virtual"]:
        return absent()
    return present(
        LibraryEntryPlacementOut(
            library_entry_id=UUID(str(row["id"])), position=int(row["position"])
        )
    )


def _hydrate_entry_rows(
    db: Session, *, viewer_id: UUID, rows: Sequence[Any]
) -> list[LibraryEntryListItemOut]:
    """Hydrate page rows into the list union, batching media and podcast lookups.

    The owning repeatable-read query already proved every target visible, so a
    missing hydrated target is a defect and hydration preserves cardinality.
    """
    if not rows:
        return []
    from nexus.services import media as media_service

    media_ids = [UUID(str(row["media_id"])) for row in rows if row["media_id"] is not None]
    podcast_ids = [UUID(str(row["podcast_id"])) for row in rows if row["podcast_id"] is not None]

    media_by_id = {
        media.id: media
        for media in media_service.list_collection_media_for_viewer_by_ids(
            db, viewer_id=viewer_id, media_ids=media_ids
        )
    }
    last_engaged_at = projection.listening_recency(
        db,
        viewer_id=viewer_id,
        media_ids=[m.id for m in media_by_id.values() if m.listening_state is not None],
    )
    last_engaged_at.update(
        projection.reader_engagement_recency(
            db,
            viewer_id=viewer_id,
            media_ids=[m.id for m in media_by_id.values() if m.listening_state is None],
        )
    )
    reading_time = _reading_time_estimates(db, media_by_id)
    podcast_rows = _podcast_rows(db, viewer_id=viewer_id, podcast_ids=podcast_ids)
    contributors = load_contributor_credits_for_podcasts(db, podcast_ids)

    hydrated: list[LibraryEntryListItemOut] = []
    for row in rows:
        if row["media_id"] is not None:
            media_id = UUID(str(row["media_id"]))
            media = media_by_id.get(media_id)
            if media is None:
                raise AssertionError(f"visible library media disappeared: {media_id}")
            hydrated.append(
                LibraryMediaListItemOut(
                    kind="media",
                    placement=_placement(row),
                    added_at=row["added_at"],
                    media=LibraryEntryMediaOut(
                        id=media.id,
                        kind=cast(
                            "Literal['web_article', 'epub', 'pdf', 'podcast_episode', 'video']",
                            media.kind,
                        ),
                        title=media.title,
                        created_at=media.created_at,
                        contributors=media.contributors,
                        author_mode=media.author_mode,
                        original_published_date=media.original_published_date,
                        canonical_source_url=media.canonical_source_url,
                        processing_status=media.processing_status,
                        read_state=media.read_state,
                        progress_fraction=media.progress_fraction,
                        progress_resettable=media.progress_resettable,
                        last_engaged_at=last_engaged_at.get(media.id),
                        capabilities=LibraryEntryMediaCapabilitiesOut(
                            can_quote=media.capabilities.can_quote,
                            can_retry=media.capabilities.can_retry,
                            can_refresh_source=media.capabilities.can_refresh_source,
                            can_retry_metadata=media.capabilities.can_retry_metadata,
                            can_edit_authors=media.capabilities.can_edit_authors,
                            can_delete=media.capabilities.can_delete,
                        ),
                    ),
                    reading_time_estimate=(
                        present(reading_time[media_id]) if media_id in reading_time else absent()
                    ),
                )
            )
            continue

        podcast_id = UUID(str(row["podcast_id"]))
        podcast_row = podcast_rows.get(podcast_id)
        if podcast_row is None:
            raise AssertionError(f"library podcast disappeared: {podcast_id}")
        subscription: Presence[LibraryEntryPodcastSubscriptionOut] = absent()
        if podcast_row["sub_id"] is not None:
            speed = podcast_row["sub_default_playback_speed"]
            subscription = present(
                LibraryEntryPodcastSubscriptionOut(
                    default_playback_speed=presence_from_nullable(
                        None if speed is None else float(speed)
                    ),
                    pause_shortening_mode=pause_shortening_mode_from_nullable(
                        podcast_row["sub_pause_shortening_mode"]
                    ),
                    auto_queue=bool(podcast_row["sub_auto_queue"]),
                    sync_status=podcast_row["sub_sync_status"],
                )
            )
        hydrated.append(
            LibraryPodcastListItemOut(
                kind="podcast",
                placement=_placement(row),
                added_at=row["added_at"],
                podcast=LibraryEntryPodcastOut(
                    id=podcast_id,
                    title=podcast_row["title"],
                    contributors=contributors.get(podcast_id, []),
                    unplayed_count=int(podcast_row["unplayed_count"] or 0),
                    published_date=presence_from_nullable(
                        podcast_row["latest_episode_published_at"]
                    ),
                ),
                subscription=subscription,
                reading_time_estimate=absent(),
            )
        )
    return hydrated


def _default_root_inventory_cte_sql(*, unfiled: bool) -> str:
    """The viewer's Default root inventory: a live union, not stored rows.

    Media dedupes by media_id with a direct-Default entry winning over a shared
    one and ties broken by the earliest entry; an active parent podcast
    subsumes its episode media and contributes one virtual show row. `unfiled`
    keeps only media whose every non-system membership entry is the direct
    Default one (`bool_and`), which excludes shared-only media.
    """
    unfiled_cte = (
        """unfiled_media AS (
            SELECT media_id FROM candidate_entries
            GROUP BY media_id HAVING bool_and(is_direct_default)
        ),"""
        if unfiled
        else ""
    )
    unfiled_restrict = "WHERE media_id IN (SELECT media_id FROM unfiled_media)" if unfiled else ""
    subscription_union = (
        ""
        if unfiled
        else """
            UNION ALL
            SELECT
                subscription.id,
                :library_id AS library_id,
                NULL::uuid AS media_id,
                subscription.podcast_id,
                subscription.created_at,
                NULL::integer AS position,
                subscription.created_at AS added_at,
                true AS is_virtual
            FROM podcast_subscriptions subscription
            WHERE subscription.user_id = :viewer_id
        """
    )
    return f"""
        default_media AS (
            {library_media_ids_cte_sql()}
        ),
        candidate_entries AS (
            SELECT
                le.id AS entry_id,
                le.media_id,
                (le.library_id = :library_id) AS is_direct_default,
                le.created_at AS entry_created_at
            FROM library_entries le
            JOIN libraries l ON l.id = le.library_id AND l.system_key IS NULL
            JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
            WHERE le.media_id IN (SELECT media_id FROM default_media)
              AND NOT EXISTS (
                  SELECT 1
                  FROM podcast_episodes episode
                  JOIN podcast_subscriptions subscription
                    ON subscription.podcast_id = episode.podcast_id
                   AND subscription.user_id = :viewer_id
                  WHERE episode.media_id = le.media_id
              )
        ),
        {unfiled_cte}
        ranked AS (
            SELECT DISTINCT ON (media_id) entry_id
            FROM candidate_entries
            {unfiled_restrict}
            ORDER BY media_id, is_direct_default DESC, entry_created_at ASC, entry_id ASC
        ),
        membership AS MATERIALIZED (
            SELECT
                le.id,
                le.library_id,
                le.media_id,
                le.podcast_id,
                le.created_at,
                le.position,
                md.created_at AS added_at,
                true AS is_virtual
            FROM ranked r
            JOIN library_entries le ON le.id = r.entry_id
            JOIN media md ON md.id = le.media_id
            {subscription_union}
        )
    """


def _membership_cte_sql(*, is_default: bool, unfiled: bool) -> str:
    """The complete viewer-visible membership relation for one library listing."""
    if is_default:
        return _default_root_inventory_cte_sql(unfiled=unfiled)
    return f"""
        membership AS MATERIALIZED (
            SELECT
                le.id,
                le.library_id,
                le.media_id,
                le.podcast_id,
                le.created_at,
                le.position,
                le.created_at AS added_at,
                false AS is_virtual
            FROM library_entries le
            WHERE le.library_id = :library_id
              AND (le.podcast_id IS NOT NULL
                   OR le.media_id IN ({visible_media_ids_cte_sql()}))
        )
    """


def count_default_root_inventory(db: Session, *, viewer_id: UUID, library_id: UUID) -> int:
    """Count the canonical complete root inventory for the viewer's Default."""
    ctx = governance.lock_library_for_member(db, viewer_id, library_id, lock=False)
    if not ctx.is_default:
        raise _invalid("Root inventory count is only available for the default library")
    count = db.execute(
        text(f"""
            WITH {_default_root_inventory_cte_sql(unfiled=False)}
            SELECT count(*) FROM membership
        """),
        {"viewer_id": viewer_id, "library_id": library_id},
    ).scalar_one()
    return int(count)


def _page_sql(view: LibraryEntryView, *, is_default: bool, keyset: str, order: str) -> str:
    """The one page statement: membership, a uniform `facts` projection, then the
    entry-type and projection predicates. The projection applies before
    completion, ordering, the keyset and limit+1."""
    needs_creator = view.sort == "creator"
    needs_engagement = view.projection == "in-progress" or view.completion == "unfinished"
    creator_name = "COALESCE(mc.primary_name, pc.primary_name)" if needs_creator else "NULL::text"

    joins = [
        "LEFT JOIN media md ON md.id = membership.media_id",
        "LEFT JOIN podcasts pod ON pod.id = membership.podcast_id",
        """LEFT JOIN (
            SELECT podcast_id, max(published_at) AS published_at
            FROM podcast_episodes GROUP BY podcast_id
        ) latest_episode ON latest_episode.podcast_id = membership.podcast_id""",
    ]
    if needs_creator:
        joins.append(
            f"LEFT JOIN ({primary_creator_rows_sql('media_id')}) mc"
            " ON mc.owner_id = membership.media_id"
        )
        joins.append(
            f"LEFT JOIN ({primary_creator_rows_sql('podcast_id')}) pc"
            " ON pc.owner_id = membership.podcast_id"
        )
    if needs_engagement:
        joins.append(
            f"LEFT JOIN ({projection.engagement_fact_rows_sql()}) eng"
            " ON eng.media_id = membership.media_id"
        )

    # In Progress matches the canonical 'InProgress' read_state; a NULL
    # read_state (shows, and media with no engagement fact) never matches, so
    # podcast-show rows are excluded from both engagement projections.
    if view.projection == "in-progress":
        predicate = "AND facts.read_state = 'InProgress'"
    elif view.completion == "unfinished":
        predicate = (
            "AND facts.media_id IS NOT NULL AND facts.read_state IS DISTINCT FROM 'Finished'"
        )
    else:
        predicate = ""
    if view.entry_type == "podcast":
        predicate += " AND facts.target_kind = 'podcast'"
    elif view.entry_type is not None:
        predicate += " AND facts.target_kind = 'media' AND facts.media_kind = :entry_type"

    return f"""
        WITH {_membership_cte_sql(is_default=is_default, unfiled=view.projection == "unfiled")},
        facts AS (
            SELECT
                membership.id,
                membership.media_id,
                membership.podcast_id,
                membership.position,
                membership.is_virtual,
                membership.added_at,
                md.kind AS media_kind,
                CASE
                    WHEN membership.media_id IS NOT NULL THEN 'media' ELSE 'podcast'
                END AS target_kind,
                COALESCE(membership.media_id, membership.podcast_id) AS target_id,
                lower(btrim(COALESCE(md.title, pod.title))) AS title_key,
                {creator_name} AS creator_name,
                ({creator_name} IS NULL)::int AS creator_missing,
                COALESCE(
                    md.original_published_date,
                    to_char(
                        latest_episode.published_at AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                    )
                ) AS published_date,
                (
                    md.original_published_date IS NULL AND latest_episode.published_at IS NULL
                )::int AS published_missing,
                {"eng.read_state" if needs_engagement else "NULL::text"} AS read_state
            FROM membership
            {" ".join(joins)}
        )
        SELECT * FROM facts
        WHERE 1 = 1 {predicate} {keyset}
        ORDER BY {order}
        LIMIT :limit
    """


def list_library_entries(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    *,
    view: LibraryEntryView,
    limit: int = 100,
    cursor: CollectionCursor | None = None,
    collection_revision: CollectionRevision | None = None,
) -> CollectionPage[LibraryEntryListItemOut]:
    """One keyset page of a library's hydrated entries under a view lens.

    Member-only. Unfiled is valid only for the viewer's own Default. The
    returned cursor is bound to this exact viewer, library, view and plan.
    """
    ctx = governance.lock_library_for_member(db, viewer_id, library_id, lock=False)
    revision = (
        read_collection_revision(db, viewer_id=viewer_id, family=CollectionFamily.LibraryEntries)
        if collection_revision is None
        else require_collection_revision(
            db,
            viewer_id=viewer_id,
            family=CollectionFamily.LibraryEntries,
            expected=collection_revision,
        )
    )
    if view.projection == "unfiled" and not ctx.is_default:
        raise _invalid("Unfiled is only available for the default library")

    plan = _plan(view, is_default=ctx.is_default)
    cursor_query: dict[str, object] = {
        "libraryId": str(library_id),
        "plan": plan_json(plan),
        "view": asdict(view),
        "viewerId": str(viewer_id),
    }
    if ctx.is_default:
        cursor_query["inventory"] = "RootSubsumed"
    params: dict[str, object] = {"viewer_id": viewer_id, "library_id": library_id}
    if view.entry_type is not None and view.entry_type != "podcast":
        params["entry_type"] = view.entry_type
    page_rows, next_cursor = governance.keyset_page(
        db,
        family=CollectionFamily.LibraryEntries.value,
        query=cursor_query,
        plan=plan,
        alias="facts",
        cursor=cursor,
        limit=limit,
        params=params,
        sql=lambda keyset, order: _page_sql(
            view, is_default=ctx.is_default, keyset=keyset, order=order
        ),
    )
    return CollectionPage[LibraryEntryListItemOut](
        items=_hydrate_entry_rows(db, viewer_id=viewer_id, rows=page_rows),
        collectionRevision=revision,
        nextCursor=present(next_cursor) if next_cursor is not None else absent(),
    )
