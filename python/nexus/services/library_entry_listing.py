"""Library entry listing: view lenses, the keyset page query, and hydration.

Every read path over `library_entries` lives here — strict view-query parsing,
the sort-key plan and signed cursor, the single page statement, and hydration
into the wire DTOs. `library_entries` stays the table's write and lifecycle
owner; this module depends on it and never the other way round.
"""

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Literal, assert_never, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.db.models import MediaKind
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
from nexus.services.collection_keyset import (
    Direction,
    SortKey,
    after_values,
    expected_kinds,
    keyset_clause,
    keyset_params,
    order_by_sql,
    plan_json,
)
from nexus.services.collection_revisions import (
    CollectionFamily,
    read_collection_revision,
    require_collection_revision,
)
from nexus.services.consumption import _projection
from nexus.services.contributor_credits import (
    load_contributor_credits_for_podcasts,
    primary_creator_rows_sql,
)
from nexus.services.keyset_cursor import (
    KeysetValueKind,
    decode_keyset_cursor,
    encode_keyset_cursor,
)
from nexus.services.library_entries import library_media_ids_cte_sql
from nexus.services.media_document_metrics import load_media_word_counts
from nexus.services.podcasts.playback_preferences import (
    pause_shortening_mode_from_nullable,
)

# ---------------------------------------------------------------------------
# Library view lenses — closed order/projection types and strict query parsing
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Canonical:
    """Durable authored order: Default's `media.created_at DESC`, else position."""


@dataclass(frozen=True, slots=True)
class Title:
    direction: Direction


@dataclass(frozen=True, slots=True)
class Creator:
    direction: Direction


@dataclass(frozen=True, slots=True)
class Published:
    direction: Direction


@dataclass(frozen=True, slots=True)
class Added:
    direction: Direction


type LibraryEntryOrder = Canonical | Title | Creator | Published | Added
type Completion = Literal["all", "unfinished"]


@dataclass(frozen=True, slots=True)
class AllItems:
    """The complete current entry set, optionally hiding finished media."""

    completion: Completion


@dataclass(frozen=True, slots=True)
class Unfiled:
    """Default-only: direct-Default media with no other non-system placement."""

    completion: Completion


@dataclass(frozen=True, slots=True)
class InProgress:
    """Media whose canonical read_state is InProgress. The absence of a
    ``completion`` field makes ``InProgress + Unfinished`` unrepresentable."""


type LibraryEntryProjection = AllItems | Unfiled | InProgress


@dataclass(frozen=True, slots=True)
class AllTypes:
    """All media kinds and Podcast shows."""


type LibraryMediaKind = Literal[
    MediaKind.web_article,
    MediaKind.epub,
    MediaKind.pdf,
    MediaKind.video,
    MediaKind.podcast_episode,
]
type LibraryExactEntryType = LibraryMediaKind | Literal["podcast"]


@dataclass(frozen=True, slots=True)
class ExactType:
    value: LibraryExactEntryType


type LibraryEntryType = AllTypes | ExactType


@dataclass(frozen=True, slots=True)
class LibraryEntryView:
    order: LibraryEntryOrder
    projection: LibraryEntryProjection
    entry_type: LibraryEntryType


_VIEW_QUERY_KEYS = frozenset({"sort", "direction", "completion", "projection", "entry_type"})
_FACTUAL_SORTS: dict[str, type[Title | Creator | Published | Added]] = {
    "title": Title,
    "creator": Creator,
    "published": Published,
    "added": Added,
}


def parse_entries_query(
    items: Sequence[tuple[str, str]],
) -> tuple[LibraryEntryView, ParsedCollectionQuery]:
    """Strict entry-view query parse (spec API validation). ``items`` is the
    request's ``multi_items()`` so duplicate keys are visible. Every malformed
    request — unknown/duplicate key, factual sort without direction, direction
    without a factual sort, unsupported sort/completion, bad/non-positive limit —
    is ``E_INVALID_REQUEST``. Cursor validity is checked separately at decode."""
    query = parse_collection_query(items, domain_keys=_VIEW_QUERY_KEYS)
    order = _parse_order(query.parameters.get("sort"), query.parameters.get("direction"))
    completion = _parse_completion(query.parameters.get("completion"))
    projection = _parse_projection(query.parameters.get("projection"), completion)
    entry_type = _parse_entry_type(query.parameters.get("entry_type"))
    if (
        isinstance(entry_type, ExactType)
        and entry_type.value == "podcast"
        and (not isinstance(projection, AllItems) or projection.completion != "all")
    ):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Podcast shows support only the complete all-items view",
        )
    return LibraryEntryView(order=order, projection=projection, entry_type=entry_type), query


def _parse_entry_type(value: str | None) -> LibraryEntryType:
    match value:
        case None:
            return AllTypes()
        case "web_article":
            return ExactType(MediaKind.web_article)
        case "epub":
            return ExactType(MediaKind.epub)
        case "pdf":
            return ExactType(MediaKind.pdf)
        case "video":
            return ExactType(MediaKind.video)
        case "podcast_episode":
            return ExactType(MediaKind.podcast_episode)
        case "podcast":
            return ExactType("podcast")
        case _:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Unsupported Library entry type"
            )


def _parse_projection(value: str | None, completion: Completion) -> LibraryEntryProjection:
    """Build the projection from the raw ``projection`` value and the already
    parsed completion. Omitted projection means ``AllItems``. ``in-progress``
    cannot carry completion (the union makes ``InProgress + Unfinished``
    unrepresentable). The Unfiled-only-for-Default rule needs viewer/library
    context and is enforced by the service, not here."""
    if value is None:
        return AllItems(completion)
    if value == "unfiled":
        return Unfiled(completion)
    if value == "in-progress":
        if completion == "unfinished":
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "In Progress cannot filter completion"
            )
        return InProgress()
    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported projection")


def _parse_order(sort: str | None, direction: str | None) -> LibraryEntryOrder:
    if sort is None:
        if direction is not None:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "direction requires a factual sort"
            )
        return Canonical()
    variant = _FACTUAL_SORTS.get(sort)
    if variant is None:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported sort")
    if direction != "asc" and direction != "desc":
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Factual sort requires direction asc or desc"
        )
    return variant(direction)


def _parse_completion(value: str | None) -> Completion:
    if value is None:
        return "all"
    if value == "unfinished":
        return "unfinished"
    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported completion")


_READING_WORDS_PER_MINUTE = 240
_READING_MINUTES_FINE_LIMIT = 10
_READING_MINUTES_COARSE_LIMIT = 60


def _display_reading_minutes(word_count: int, fraction: float) -> int:
    raw_minutes = word_count * fraction / _READING_WORDS_PER_MINUTE
    if raw_minutes < _READING_MINUTES_FINE_LIMIT:
        quantum = 1
    elif raw_minutes < _READING_MINUTES_COARSE_LIMIT:
        quantum = 5
    else:
        quantum = 15
    return max(1, quantum * math.floor(raw_minutes / quantum + 0.5))


# ---------------------------------------------------------------------------
# Hydration
# ---------------------------------------------------------------------------


def _hydrate_entry_rows(
    db: Session, *, viewer_id: UUID, rows: Sequence[Any]
) -> list[LibraryEntryListItemOut]:
    """Hydrate name-keyed entry rows into the compact Library list union, batching
    the media and podcast lookups. The owning repeatable-read query already proved
    every target visible, so hydration preserves exact cardinality and order."""
    if not rows:
        return []

    for row in rows:
        if (row["media_id"] is None) == (row["podcast_id"] is None):
            # justify-defect: physical rows have an exactly-one-target database
            # check and the Default virtual relation emits one typed target.
            raise AssertionError("library entry hydration row must carry exactly one target")

    media_ids = [UUID(str(row["media_id"])) for row in rows if row["media_id"] is not None]
    podcast_ids = [UUID(str(row["podcast_id"])) for row in rows if row["podcast_id"] is not None]

    media_by_id = {}
    if media_ids:
        from nexus.services import media as media_service

        media_by_id = {
            media.id: media
            for media in media_service.list_collection_media_for_viewer_by_ids(
                db,
                viewer_id=viewer_id,
                media_ids=media_ids,
            )
        }

    audio_media_ids = [
        media.id for media in media_by_id.values() if media.listening_state is not None
    ]
    document_media_ids = [
        media.id for media in media_by_id.values() if media.listening_state is None
    ]
    last_engaged_at_by_media_id = _projection.listening_recency(
        db,
        viewer_id=viewer_id,
        media_ids=audio_media_ids,
    )
    last_engaged_at_by_media_id.update(
        _projection.reader_engagement_recency(
            db,
            viewer_id=viewer_id,
            media_ids=document_media_ids,
        )
    )

    eligible_media_ids = [
        media.id
        for media in media_by_id.values()
        if media.kind in ("web_article", "epub", "pdf") and media.capabilities.can_quote
    ]
    word_counts = load_media_word_counts(db, eligible_media_ids) if eligible_media_ids else {}
    reading_time_by_media_id: dict[UUID, ReadingTimeEstimateOut] = {}
    for media_id in eligible_media_ids:
        word_count = word_counts[media_id]
        if word_count == 0:
            continue
        media = media_by_id[media_id]
        total_minutes = _display_reading_minutes(word_count, 1.0)
        remaining_minutes: Presence[int] = absent()
        if (
            media.kind in ("web_article", "epub")
            and media.read_state == "in_progress"
            and media.progress_fraction is not None
        ):
            remaining = _display_reading_minutes(word_count, 1.0 - media.progress_fraction)
            if remaining > total_minutes:
                # justify-service-invariant-check: the relationship between two
                # derived rounded values is not expressible in their integer types.
                # justify-defect: bounded progression and monotonic rounding guarantee it.
                raise AssertionError(f"remaining reading time exceeds total for media {media_id}")
            remaining_minutes = present(remaining)
        reading_time_by_media_id[media_id] = ReadingTimeEstimateOut(
            total_minutes=total_minutes,
            remaining_minutes=remaining_minutes,
        )

    podcast_rows_by_id = {}
    if podcast_ids:
        podcast_rows = (
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
                    _projection.episode_state_case_sql(
                        listening_alias="pls", override_alias="co", episode_alias="pe"
                    )
                } = 'unplayed'
                        ) AS unplayed_count
                    FROM podcast_episodes pe
                    JOIN visible_media vm ON vm.media_id = pe.media_id
                    {
                    _projection.episode_state_joins_sql(
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
                LEFT JOIN podcast_subscriptions ps
                  ON ps.podcast_id = p.id AND ps.user_id = :viewer_id
                WHERE p.id = ANY(:podcast_ids)
            """),
                {"viewer_id": viewer_id, "podcast_ids": podcast_ids},
            )
            .mappings()
            .all()
        )
        podcast_rows_by_id = {UUID(str(row["podcast_id"])): row for row in podcast_rows}
    contributors_by_podcast_id = load_contributor_credits_for_podcasts(db, podcast_ids)

    hydrated: list[LibraryEntryListItemOut] = []
    for row in rows:
        media_id = UUID(str(row["media_id"])) if row["media_id"] is not None else None
        podcast_id = UUID(str(row["podcast_id"])) if row["podcast_id"] is not None else None
        if media_id is not None:
            media = media_by_id.get(media_id)
            if media is None:
                # justify-defect: the owning repeatable-read membership query
                # already admitted this media through the visibility relation.
                raise AssertionError(
                    f"visible library media disappeared during hydration: {media_id}"
                )
            hydrated.append(
                LibraryMediaListItemOut(
                    kind="media",
                    placement=(
                        absent()
                        if bool(row["is_virtual"])
                        else present(
                            LibraryEntryPlacementOut(
                                library_entry_id=UUID(str(row["id"])),
                                position=int(row["position"]),
                            )
                        )
                    ),
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
                        last_engaged_at=last_engaged_at_by_media_id.get(media.id),
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
                        present(reading_time_by_media_id[media_id])
                        if media_id in reading_time_by_media_id
                        else absent()
                    ),
                )
            )
            continue

        if podcast_id is None:
            # justify-defect: the exact-one-target check above excludes this branch.
            raise AssertionError("library entry hydration lost its typed target")
        podcast_row = podcast_rows_by_id.get(podcast_id)
        if podcast_row is None:
            # justify-defect: physical Podcast entries retain a restrictive FK and
            # Default virtual rows originate from the same podcasts relation.
            raise AssertionError(f"library podcast disappeared during hydration: {podcast_id}")

        subscription: Presence[LibraryEntryPodcastSubscriptionOut] = absent()
        if podcast_row["sub_id"] is not None:
            subscription = present(
                LibraryEntryPodcastSubscriptionOut(
                    default_playback_speed=presence_from_nullable(
                        float(podcast_row["sub_default_playback_speed"])
                        if podcast_row["sub_default_playback_speed"] is not None
                        else None
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
                placement=(
                    absent()
                    if bool(row["is_virtual"])
                    else present(
                        LibraryEntryPlacementOut(
                            library_entry_id=UUID(str(row["id"])),
                            position=int(row["position"]),
                        )
                    )
                ),
                added_at=row["added_at"],
                podcast=LibraryEntryPodcastOut(
                    id=podcast_id,
                    title=podcast_row["title"],
                    contributors=contributors_by_podcast_id.get(podcast_id, []),
                    unplayed_count=int(podcast_row["unplayed_count"] or 0),
                    published_date=(
                        present(podcast_row["latest_episode_published_at"])
                        if podcast_row["latest_episode_published_at"] is not None
                        else absent()
                    ),
                ),
                subscription=subscription,
                reading_time_estimate=absent(),
            )
        )

    return hydrated


def _plan(order: LibraryEntryOrder, *, is_default: bool) -> list[SortKey]:
    """The total, stable sort-key plan that drives ORDER BY, the keyset, and the
    cursor `after`. Every plan ends in the heterogeneous target identity
    ``target_kind ASC, target_id DESC``; missing-rank keys are ALWAYS ASC so
    missing sorts last in both directions (0=present, 1=missing)."""
    identity = [
        SortKey("target_kind", "asc", KeysetValueKind.Text),
        SortKey("target_id", "desc", KeysetValueKind.Uuid),
    ]
    match order:
        case Canonical():
            if is_default:
                return [
                    SortKey("added_at", "desc", KeysetValueKind.DateTime),
                    *identity,
                ]
            return [
                SortKey("position", "asc", KeysetValueKind.Int),
                *identity,
            ]
        case Title(direction):
            return [SortKey("title_key", direction, KeysetValueKind.Text), *identity]
        case Creator(direction):
            return [
                SortKey("creator_missing", "asc", KeysetValueKind.Int),
                SortKey("creator_name", direction, KeysetValueKind.TextOrNull),
                SortKey("title_key", "asc", KeysetValueKind.Text),
                *identity,
            ]
        case Published(direction):
            return [
                SortKey("published_missing", "asc", KeysetValueKind.Int),
                SortKey("published_date", direction, KeysetValueKind.TextOrNull),
                SortKey("title_key", "asc", KeysetValueKind.Text),
                *identity,
            ]
        case Added(direction):
            return [SortKey("added_at", direction, KeysetValueKind.DateTime), *identity]
        case _:
            assert_never(order)


def _order_json(order: LibraryEntryOrder) -> dict[str, str]:
    match order:
        case Canonical():
            return {"sort": "canonical"}
        case Title(direction):
            return {"sort": "title", "direction": direction}
        case Creator(direction):
            return {"sort": "creator", "direction": direction}
        case Published(direction):
            return {"sort": "published", "direction": direction}
        case Added(direction):
            return {"sort": "added", "direction": direction}
        case _:
            assert_never(order)


def _projection_json(projection: LibraryEntryProjection) -> dict[str, str]:
    match projection:
        case AllItems(completion):
            return {"completion": completion, "kind": "all-items"}
        case Unfiled(completion):
            return {"completion": completion, "kind": "unfiled"}
        case InProgress():
            return {"kind": "in-progress"}
        case _:
            assert_never(projection)


def _entry_type_json(entry_type: LibraryEntryType) -> dict[str, str]:
    match entry_type:
        case AllTypes():
            return {"kind": "all-types"}
        case ExactType(value):
            return {
                "kind": "exact-type",
                "value": value if value == "podcast" else value.value,
            }
        case _:
            assert_never(entry_type)


def _view_json(view: LibraryEntryView) -> dict[str, Any]:
    return {
        "entryType": _entry_type_json(view.entry_type),
        "order": _order_json(view.order),
        "projection": _projection_json(view.projection),
    }


def _cursor_query(
    *,
    viewer_id: UUID,
    library_id: UUID,
    view: LibraryEntryView,
    plan: Sequence[SortKey],
    is_default: bool,
) -> dict[str, object]:
    query: dict[str, object] = {
        "libraryId": str(library_id),
        "plan": plan_json(plan),
        "view": _view_json(view),
        "viewerId": str(viewer_id),
    }
    if is_default:
        query["inventory"] = "RootSubsumed"
    return query


def _encode_view_cursor(
    *,
    viewer_id: UUID,
    library_id: UUID,
    view: LibraryEntryView,
    plan: Sequence[SortKey],
    is_default: bool,
    row: Any,
) -> str:
    return encode_keyset_cursor(
        family=CollectionFamily.LibraryEntries.value,
        query=_cursor_query(
            viewer_id=viewer_id,
            library_id=library_id,
            view=view,
            plan=plan,
            is_default=is_default,
        ),
        after=after_values(plan, row),
    )


def _decode_view_cursor(
    cursor: str,
    *,
    viewer_id: UUID,
    library_id: UUID,
    view: LibraryEntryView,
    plan: Sequence[SortKey],
    is_default: bool,
) -> dict[str, object]:
    values = decode_keyset_cursor(
        cursor,
        family=CollectionFamily.LibraryEntries.value,
        query=_cursor_query(
            viewer_id=viewer_id,
            library_id=library_id,
            view=view,
            plan=plan,
            is_default=is_default,
        ),
        expected_kinds=expected_kinds(plan),
    )
    return keyset_params(plan, values)


def _finish_entry_page(
    db: Session,
    *,
    viewer_id: UUID,
    rows: Sequence[Any],
    limit: int,
    build_cursor: Callable[[Any], CollectionCursor],
) -> tuple[list[LibraryEntryListItemOut], CollectionCursor | None]:
    """Shared tail for every keyset family (spec S4.2/AC6): the caller already
    fetched ``limit + 1`` rows in the family's own order with no write anywhere
    on this path. Slice to `limit`, hydrate, and — only when there is a next
    page — build its cursor from the last raw row (the hydrated output omits
    cursor-only columns such as entry `created_at`)."""
    page_rows = list(rows[:limit])
    has_more = len(rows) > limit
    page_entries = _hydrate_entry_rows(db, viewer_id=viewer_id, rows=page_rows)
    next_cursor = build_cursor(page_rows[-1]) if has_more and page_rows else None
    return page_entries, next_cursor


def _default_root_inventory_cte_sql(*, unfiled: bool) -> str:
    """Canonical viewer-scoped Default root inventory.

    ``unfiled`` restricts the Default set to media whose only viewer non-system
    membership entry is the direct-Default one: ``bool_and(is_direct_default)``
    over each media's
    candidate group is true exactly when it has a direct-Default entry AND no
    other non-system membership entry. Shared-only media never enter the group
    with ``is_direct_default`` true, so they are excluded; system and
    inaccessible-foreign libraries are already outside ``candidate_entries``.
    The final relation is materialized once so consumers cannot inline and
    re-run membership work per candidate. An active parent Podcast subsumes its
    normalized episode Media before any view projection or pagination."""
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
    """Complete viewer-visible membership relation for one library listing."""
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


def count_default_root_inventory(
    db: Session,
    *,
    viewer_id: UUID,
    library_id: UUID,
) -> int:
    """Count the canonical complete root inventory for the viewer's Default."""
    ctx = governance.lock_library_for_member(db, viewer_id, library_id, lock=False)
    if not ctx.is_default:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Root inventory count is only available for the default library",
        )
    count = db.execute(
        text(f"""
            WITH {_default_root_inventory_cte_sql(unfiled=False)}
            SELECT count(*) FROM membership
        """),
        {"viewer_id": viewer_id, "library_id": library_id},
    ).scalar_one()
    return int(count)


def _query_view_page(
    db: Session,
    *,
    viewer_id: UUID,
    library_id: UUID,
    is_default: bool,
    view: LibraryEntryView,
    limit: int,
    after: dict[str, object] | None,
) -> tuple[list[LibraryEntryListItemOut], CollectionCursor | None]:
    """The single view query (spec backend architecture): one statement with a
    single top-level ``WITH`` — membership (branched default vs non-default,
    Unfiled-restricted when requested), a uniform ``facts`` CTE, the projection
    predicate, generic keyset, plan-driven ORDER BY, LIMIT+1 — then the shared
    hydration tail. The projection is applied before completion, ordering,
    keyset, and limit+1 (spec AC8)."""
    plan = _plan(view.order, is_default=is_default)
    needs_creator = isinstance(view.order, Creator)
    match view.projection:
        case AllItems(completion):
            unfinished = completion == "unfinished"
            in_progress = False
            unfiled = False
        case Unfiled(completion):
            unfinished = completion == "unfinished"
            in_progress = False
            unfiled = True
        case InProgress():
            unfinished = False
            in_progress = True
            unfiled = False
        case _:
            assert_never(view.projection)
    needs_eng = unfinished or in_progress

    creator_name_expr = (
        "COALESCE(mc.primary_name, pc.primary_name)" if needs_creator else "NULL::text"
    )
    added_at_expr = "membership.added_at"
    read_state_expr = "eng.read_state" if needs_eng else "NULL::text"

    facts_joins = [
        "LEFT JOIN media md ON md.id = membership.media_id",
        "LEFT JOIN podcasts pod ON pod.id = membership.podcast_id",
        """
        LEFT JOIN (
            SELECT podcast_id, max(published_at) AS published_at
            FROM podcast_episodes
            GROUP BY podcast_id
        ) latest_episode ON latest_episode.podcast_id = membership.podcast_id
        """,
    ]
    if needs_creator:
        facts_joins.append(
            f"LEFT JOIN ({primary_creator_rows_sql('media_id')}) mc"
            " ON mc.owner_id = membership.media_id"
        )
        facts_joins.append(
            f"LEFT JOIN ({primary_creator_rows_sql('podcast_id')}) pc"
            " ON pc.owner_id = membership.podcast_id"
        )
    if needs_eng:
        facts_joins.append(
            f"LEFT JOIN ({_projection.engagement_fact_rows_sql()}) eng"
            " ON eng.media_id = membership.media_id"
        )

    # In Progress matches the canonical 'InProgress' read_state; a NULL read_state
    # (podcasts, shows, and media with no engagement fact) never matches, so
    # podcast-show rows are excluded (spec AC7).
    if unfinished:
        projection_clause = (
            "AND facts.media_id IS NOT NULL AND facts.read_state IS DISTINCT FROM 'Finished'"
        )
    elif in_progress:
        projection_clause = "AND facts.read_state = 'InProgress'"
    else:
        projection_clause = ""
    match view.entry_type:
        case AllTypes():
            entry_type_clause = ""
            entry_type_param = None
        case ExactType(value):
            if value == "podcast":
                entry_type_clause = "AND facts.target_kind = 'podcast'"
                entry_type_param = None
            else:
                entry_type_clause = (
                    "AND facts.target_kind = 'media' AND facts.media_kind = :entry_type"
                )
                entry_type_param = value.value
        case _:
            assert_never(view.entry_type)
    keyset_sql = keyset_clause(plan, alias="facts") if after is not None else ""
    order_by = order_by_sql(plan, alias="facts")

    params: dict[str, object] = {
        "viewer_id": viewer_id,
        "library_id": library_id,
        "limit": limit + 1,
    }
    if entry_type_param is not None:
        params["entry_type"] = entry_type_param
    if after is not None:
        params.update(after)

    rows = (
        db.execute(
            text(f"""
                WITH {_membership_cte_sql(is_default=is_default, unfiled=unfiled)},
                facts AS (
                    SELECT
                        membership.id,
                        membership.library_id,
                        membership.media_id,
                        membership.podcast_id,
                        membership.created_at,
                        membership.position,
                        membership.is_virtual,
                        md.created_at AS media_created_at,
                        md.kind AS media_kind,
                        {added_at_expr} AS added_at,
                        CASE
                            WHEN membership.media_id IS NOT NULL THEN 'media'
                            ELSE 'podcast'
                        END AS target_kind,
                        COALESCE(membership.media_id, membership.podcast_id) AS target_id,
                        lower(btrim(COALESCE(md.title, pod.title))) AS title_key,
                        {creator_name_expr} AS creator_name,
                        ({creator_name_expr} IS NULL)::int AS creator_missing,
                        COALESCE(
                            md.original_published_date,
                            to_char(
                                latest_episode.published_at AT TIME ZONE 'UTC',
                                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                            )
                        ) AS published_date,
                        (
                            md.original_published_date IS NULL
                            AND latest_episode.published_at IS NULL
                        )::int AS published_missing,
                        {read_state_expr} AS read_state
                    FROM membership
                    {" ".join(facts_joins)}
                )
                SELECT
                    id, library_id, media_id, podcast_id, created_at, position,
                    is_virtual, target_kind, target_id,
                    media_created_at, added_at, title_key, creator_name, creator_missing,
                    published_date, published_missing
                FROM facts
                WHERE 1 = 1
                  {entry_type_clause}
                  {projection_clause}
                  {keyset_sql}
                ORDER BY {order_by}
                LIMIT :limit
            """),
            params,
        )
        .mappings()
        .all()
    )

    return _finish_entry_page(
        db,
        viewer_id=viewer_id,
        rows=rows,
        limit=limit,
        build_cursor=lambda row: _encode_view_cursor(
            viewer_id=viewer_id,
            library_id=library_id,
            view=view,
            plan=plan,
            is_default=is_default,
            row=row,
        ),
    )


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
    """List a library's hydrated entries under a view lens. Member-only.

    The view's ``order`` selects Canonical (Default's `media.created_at DESC`,
    else the physical position order) or one of the factual sorts; the
    ``projection`` (AllItems/Unfiled/In Progress, with completion where it carries
    one) and ``entry_type`` compose as set predicates before ordering. Unfiled is
    valid only for the viewer's own Default. Every page is a true keyset over the
    view's total order; the returned cursor is bound to this exact
    viewer/library/view.
    """
    ctx = governance.lock_library_for_member(db, viewer_id, library_id, lock=False)
    current_revision = (
        read_collection_revision(
            db,
            viewer_id=viewer_id,
            family=CollectionFamily.LibraryEntries,
        )
        if collection_revision is None
        else require_collection_revision(
            db,
            viewer_id=viewer_id,
            family=CollectionFamily.LibraryEntries,
            expected=collection_revision,
        )
    )

    if isinstance(view.projection, Unfiled) and not ctx.is_default:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Unfiled is only available for the default library"
        )

    after: dict[str, object] | None = None
    if cursor is not None:
        after = _decode_view_cursor(
            cursor,
            viewer_id=viewer_id,
            library_id=library_id,
            view=view,
            plan=_plan(view.order, is_default=ctx.is_default),
            is_default=ctx.is_default,
        )

    items, next_cursor = _query_view_page(
        db,
        viewer_id=viewer_id,
        library_id=library_id,
        is_default=ctx.is_default,
        view=view,
        limit=limit,
        after=after,
    )
    return CollectionPage[LibraryEntryListItemOut](
        items=items,
        collectionRevision=current_revision,
        nextCursor=present(next_cursor) if next_cursor is not None else absent(),
    )
