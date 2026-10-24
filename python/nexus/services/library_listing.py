"""Physical library media, filtered and keyset-paged under one total order.

Subscriptions have a separate section owned by podcasts.subscriptions_query. They
never fold episodes, affect media counts, or participate in manual entry order.
"""

from collections.abc import Sequence
from dataclasses import asdict, dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.db.models import MediaKind
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.collection_page import CollectionQuery, parse_collection_query
from nexus.schemas.library import (
    LibraryEntriesPageOut,
    LibraryMediaEntryOut,
    LibraryMetadataOut,
    LibraryOrderOut,
)
from nexus.services import libraries
from nexus.services.collection_keyset import (
    Direction,
    KeysetValueKind,
    SortKey,
    keyset_page,
    order_by_sql,
)
from nexus.services.consumption import projection
from nexus.services.contributor_credits import primary_creator_rows_sql
from nexus.services.library_entries import library_media_rows_sql, unfiled_media_ids_sql
from nexus.services.reading_time import reading_time_rows_sql


def _nullable(column: str, direction: Direction, value: KeysetValueKind) -> tuple[SortKey, ...]:
    return (
        SortKey(f"{column}_missing", "asc", KeysetValueKind.Int),
        SortKey(column, direction, value),
        SortKey("title_key", "asc", KeysetValueKind.Text),
    )


_SORTS: dict[str, tuple[SortKey, ...]] = {
    "title_asc": (SortKey("title_key", "asc", KeysetValueKind.Text),),
    "title_desc": (SortKey("title_key", "desc", KeysetValueKind.Text),),
    "creator_asc": _nullable("creator_name", "asc", KeysetValueKind.TextOrNull),
    "creator_desc": _nullable("creator_name", "desc", KeysetValueKind.TextOrNull),
    "published_desc": _nullable("published_date", "desc", KeysetValueKind.TextOrNull),
    "published_asc": _nullable("published_date", "asc", KeysetValueKind.TextOrNull),
    "remaining_asc": _nullable("remaining_seconds", "asc", KeysetValueKind.FloatOrNull),
    "remaining_desc": _nullable("remaining_seconds", "desc", KeysetValueKind.FloatOrNull),
    "added_desc": (SortKey("added_at", "desc", KeysetValueKind.DateTime),),
    "added_asc": (SortKey("added_at", "asc", KeysetValueKind.DateTime),),
}
_ENTRY_TYPES = {kind.value for kind in MediaKind}


@dataclass(frozen=True, slots=True)
class EntryView:
    sort: str | None
    entry_type: str | None
    projection: str | None
    completion: str | None


def parse_entries_query(items: Sequence[tuple[str, str]]) -> tuple[EntryView, CollectionQuery]:
    query = parse_collection_query(
        items, domain_keys={"sort", "entry_type", "projection", "completion"}
    )
    view = EntryView(**{key: query.parameters.get(key) for key in EntryView.__slots__})
    if (
        (view.sort is not None and view.sort not in _SORTS)
        or (view.entry_type is not None and view.entry_type not in _ENTRY_TYPES)
        or view.projection not in (None, "unfiled", "in_progress")
        or view.completion not in (None, "unfinished")
    ):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported library view")
    return view, query


def entry_order_plan(view: EntryView, *, is_default: bool) -> tuple[SortKey, ...]:
    own_order = (
        SortKey("added_at", "desc", KeysetValueKind.DateTime)
        if is_default
        else SortKey("position", "asc", KeysetValueKind.Int)
    )
    return (
        *(_SORTS[view.sort] if view.sort else (own_order,)),
        SortKey("media_id", "desc", KeysetValueKind.Uuid),
    )


def get_library_order(db: Session, viewer_id: UUID, library_id: UUID) -> LibraryOrderOut:
    library = libraries.access(db, viewer_id, library_id, lock=False)
    library.require_mutable()
    ids = db.scalars(
        text(f"""
        SELECT le.id FROM library_entries le
        WHERE le.library_id=:library_id AND le.media_id IN ({visible_media_ids_cte_sql()})
        ORDER BY le.position, le.created_at DESC, le.id DESC
    """),
        {"viewer_id": viewer_id, "library_id": library_id},
    )
    return LibraryOrderOut(order_revision=str(library.order_revision), entry_ids=list(ids))


def entry_fact_rows_sql(
    membership: str, *, creator: bool, engagement: bool, remaining: bool
) -> str:
    """Canonical membership and display-order facts; the caller owns its admitted rows."""
    creator_name = "mc.primary_name" if creator else "NULL"
    joins = [
        "JOIN media md ON md.id=membership.media_id",
        "LEFT JOIN podcast_episodes pe ON pe.media_id=md.id",
    ]
    if creator:
        joins.append(f"LEFT JOIN ({primary_creator_rows_sql('media_id')}) mc ON mc.owner_id=md.id")
    if engagement:
        joins.append(
            f"LEFT JOIN ({projection.engagement_fact_rows_sql()}) eng ON eng.media_id=md.id"
        )
    if remaining:
        joins.append(f"LEFT JOIN ({reading_time_rows_sql()}) duration ON duration.media_id=md.id")
    return f"""
        WITH membership AS MATERIALIZED ({membership}), facts AS (
            SELECT membership.*, md.kind AS media_kind, lower(btrim(md.title)) AS title_key,
                   {creator_name}::text AS creator_name, ({creator_name} IS NULL)::int AS creator_name_missing,
                   COALESCE(md.original_published_date,
                       to_char(pe.published_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')) AS published_date,
                   (md.original_published_date IS NULL AND pe.published_at IS NULL)::int AS published_date_missing,
                   {"eng.read_state" if engagement else "NULL::text"} AS read_state,
                   {"duration.remaining_seconds" if remaining else "NULL::float8"} AS remaining_seconds,
                   {"(duration.remaining_seconds IS NULL)::int" if remaining else "1"} AS remaining_seconds_missing
            FROM membership {" ".join(joins)}
        ) SELECT * FROM facts
    """


def _page_sql(view: EntryView, *, is_default: bool, keyset: str, order: str) -> str:
    membership = (
        f"SELECT NULL::uuid AS entry_id, members.media_id, NULL::integer AS position, members.added_at "
        f"FROM ({library_media_rows_sql()}) members"
        if is_default
        else f"SELECT le.id AS entry_id, le.media_id, le.position, le.created_at AS added_at "
        f"FROM library_entries le WHERE le.library_id=:library_id "
        f"AND le.media_id IN ({visible_media_ids_cte_sql()})"
    )
    predicates = ["TRUE"]
    if view.projection == "unfiled":
        predicates.append(f"facts.media_id IN ({unfiled_media_ids_sql()})")
    if view.projection == "in_progress":
        predicates.append("facts.read_state='InProgress'")
    if view.completion == "unfinished":
        predicates.append("facts.read_state IS DISTINCT FROM 'Finished'")
    if view.entry_type is not None:
        predicates.append("facts.media_kind=:entry_type")
    facts = entry_fact_rows_sql(
        membership,
        creator=(view.sort or "").startswith("creator"),
        engagement=view.projection == "in_progress" or view.completion == "unfinished",
        remaining=(view.sort or "").startswith("remaining"),
    )
    return f"""
        SELECT * FROM ({facts}) facts WHERE {" AND ".join(predicates)} {keyset}
        ORDER BY {order} LIMIT :limit
    """


def list_library_entries(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    *,
    view: EntryView,
    cursor: str | None,
    limit: int,
) -> LibraryEntriesPageOut:
    from nexus.services import media as media_service

    library = libraries.access(db, viewer_id, library_id, lock=False)
    if view.projection == "unfiled" and not library.is_default:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unfiled is a view of All")
    order_revision = (
        str(library.order_revision)
        if library.mutable and all(value is None for value in asdict(view).values())
        else None
    )
    rows, next_cursor = keyset_page(
        db,
        binding={
            "list": "LibraryEntries",
            "viewer": viewer_id,
            "library": library_id,
            "view": asdict(view),
            "order_revision": order_revision,
        },
        plan=entry_order_plan(view, is_default=library.is_default),
        cursor=cursor,
        limit=limit,
        params={"viewer_id": viewer_id, "library_id": library_id, "entry_type": view.entry_type},
        sql=lambda keyset, order: _page_sql(
            view, is_default=library.is_default, keyset=keyset, order=order
        ),
    )
    summaries = media_service.media_summaries(
        db, viewer_id=viewer_id, media_ids=[row["media_id"] for row in rows]
    )
    return LibraryEntriesPageOut(
        items=[
            LibraryMediaEntryOut(
                kind="media",
                entry_id=row["entry_id"],
                added_at=row["added_at"],
                media_summary=summaries[row["media_id"]],
            )
            for row in rows
        ],
        next_cursor=next_cursor,
        order_revision=order_revision,
    )


def metadata(db: Session, viewer_id: UUID, library_id: UUID) -> LibraryMetadataOut:
    """Native library facts and exact canonical visible physical count in one read snapshot.

    All counts its non-system union; subscriptions never expand into media. Dates
    are the library record timestamps, not subscription, refresh or ownership facts.
    """
    library = libraries.access(db, viewer_id, library_id, lock=False)
    dates = db.execute(
        text("SELECT created_at, updated_at FROM libraries WHERE id = :id"), {"id": library_id}
    ).one()
    count = db.execute(
        text(f"SELECT count(*) FROM ({library_media_rows_sql()}) members"),
        {"viewer_id": viewer_id, "library_id": library_id},
    ).scalar_one()
    return LibraryMetadataOut(
        library=library.out(viewer_id),
        kind="personal"
        if library.is_default
        else "system"
        if library.system_key is not None
        else "named",
        created_at=dates.created_at,
        updated_at=dates.updated_at,
        media_count=count,
    )


def count_default_root_inventory(db: Session, *, viewer_id: UUID, library_id: UUID) -> int:
    if not libraries.access(db, viewer_id, library_id, lock=False).is_default:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Only All has a root inventory")
    return db.execute(
        text(f"SELECT count(*) FROM ({library_media_rows_sql()}) members"),
        {"viewer_id": viewer_id, "library_id": library_id},
    ).scalar_one()


def ordered_selection_ids(
    db: Session, viewer_id: UUID, library_id: UUID, view: EntryView
) -> tuple[str, list[UUID]]:
    """Complete logical view in listing order, under the caller's read snapshot.

    Only physical media memberships participate; subscription rules never expand.
    Consumers apply their own eligibility and text matching afterward.
    """
    library = libraries.access(db, viewer_id, library_id, lock=False)
    if view.projection == "unfiled" and not library.is_default:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unfiled is a view of All")
    plan = entry_order_plan(view, is_default=library.is_default)
    sql = _page_sql(
        view, is_default=library.is_default, keyset="", order=order_by_sql(plan, alias="facts")
    )
    rows = db.execute(
        text(sql),
        {
            "viewer_id": viewer_id,
            "library_id": library_id,
            "entry_type": view.entry_type,
            "limit": None,
        },
    )
    return "All" if library.is_default else library.name, [row.media_id for row in rows]
