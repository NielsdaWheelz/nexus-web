"""Library listing: the entry view lenses, the one keyset page statement, hydration.

A view is four independent query parameters whose predicates AND together: `sort`
(absent: the library's own order), `entry_type`, `projection` (`unfiled`, only on
the viewer's All, or `in_progress`) and `completion=unfinished`. Every combination
is valid. A show has no read state, so the engagement lenses never list shows.
"""

from collections.abc import Sequence
from dataclasses import asdict, dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.db.models import MediaKind
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.collection_page import (
    CollectionQuery,
    parse_collection_query,
)
from nexus.schemas.library import (
    LibraryEntriesPageOut,
    LibraryEntryOut,
    LibraryMediaEntryOut,
    LibraryOrderOut,
    LibraryPodcastEntryOut,
)
from nexus.services import libraries
from nexus.services.collection_keyset import Direction, KeysetValueKind, SortKey, keyset_page
from nexus.services.consumption import projection
from nexus.services.contributor_credits import (
    load_contributor_credits_for_podcasts,
    primary_creator_rows_sql,
)
from nexus.services.library_entries import (
    library_media_rows_sql,
    library_podcast_rows_sql,
    unfiled_media_ids_sql,
)
from nexus.services.reading_time import reading_time_rows_sql


def _nullable(column: str, direction: Direction, value: KeysetValueKind) -> tuple[SortKey, ...]:
    """A fact a row may lack: rows lacking it last in both directions, then title."""
    return (
        SortKey(f"{column}_missing", "asc", KeysetValueKind.Int),
        SortKey(column, direction, value),
        SortKey("title_key", "asc", KeysetValueKind.Text),
    )


# sort -> plan prefix; the target identity ends every plan, so every order is total.
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
_IDENTITY = (
    SortKey("target_kind", "asc", KeysetValueKind.Text),
    SortKey("target_id", "desc", KeysetValueKind.Uuid),
)
_ENTRY_TYPES = {*(kind.value for kind in MediaKind), "podcast"}


@dataclass(frozen=True, slots=True)
class EntryView:
    sort: str | None
    entry_type: str | None
    projection: str | None
    completion: str | None


def parse_entries_query(items: Sequence[tuple[str, str]]) -> tuple[EntryView, CollectionQuery]:
    """An unknown key or value is E_INVALID_REQUEST; cursors are checked at decode."""
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


def _all_membership_sql(view: EntryView) -> str:
    """Choose final all rows before ordering, counting and pagination.

    only overview folds followed episodes into their roots. media lenses expose
    every qualifying physical member, including followed episodes.
    """
    media_lens = (
        view.projection is not None
        or view.completion is not None
        or view.entry_type not in (None, "podcast")
    )
    media_predicates = ["true"]
    if view.entry_type == "podcast":
        media_predicates.append("false")
    if view.projection == "unfiled":
        media_predicates.append(f"members.media_id IN ({unfiled_media_ids_sql()})")
    if not media_lens:
        media_predicates.append("""NOT EXISTS (
            SELECT 1 FROM podcast_episodes e
            JOIN all_shows s ON s.podcast_id = e.podcast_id
            WHERE e.media_id = members.media_id)""")
    return f"""
        all_shows AS ({library_podcast_rows_sql()}),
        membership AS MATERIALIZED (
            SELECT NULL::uuid AS entry_id, members.media_id, NULL::uuid AS podcast_id,
                   NULL::integer AS position, members.added_at
            FROM ({library_media_rows_sql()}) members
            WHERE {" AND ".join(media_predicates)}
            UNION ALL
            SELECT NULL::uuid, NULL::uuid, s.podcast_id, NULL::integer, s.added_at
            FROM all_shows s WHERE {"false" if media_lens else "true"}
        )
    """


_NAMED_MEMBERSHIP_SQL = f"""
    membership AS MATERIALIZED (
        SELECT le.id AS entry_id, le.media_id, le.podcast_id, le.position,
               le.created_at AS added_at
        FROM library_entries le
        WHERE le.library_id = :library_id
          AND (le.podcast_id IS NOT NULL OR le.media_id IN ({visible_media_ids_cte_sql()}))
    )
"""


def get_library_order(db: Session, viewer_id: UUID, library_id: UUID) -> LibraryOrderOut:
    """A member's complete visible order; caller owns a read snapshot or library lock."""
    library = libraries.access(db, viewer_id, library_id, lock=False)
    library.require_mutable()
    ids = db.scalars(
        text(f"""
            WITH {_NAMED_MEMBERSHIP_SQL}
            SELECT entry_id FROM membership
            ORDER BY position ASC, added_at DESC, entry_id DESC
        """),
        {"viewer_id": viewer_id, "library_id": library_id},
    )
    return LibraryOrderOut(order_revision=str(library.order_revision), entry_ids=list(ids))


def _page_sql(view: EntryView, *, is_default: bool, keyset: str, order: str) -> str:
    """Membership, a uniform `facts` projection, then the view's predicates, the
    keyset and the limit."""
    sort = view.sort or ""
    creator = "COALESCE(mc.primary_name, pc.primary_name)" if sort.startswith("creator") else "NULL"
    remaining = sort.startswith("remaining")
    engagement = view.projection == "in_progress" or view.completion == "unfinished"
    joins = [
        "LEFT JOIN media md ON md.id = membership.media_id",
        "LEFT JOIN podcasts pod ON pod.id = membership.podcast_id",
        """LEFT JOIN (
            SELECT podcast_id, max(published_at) AS published_at
            FROM podcast_episodes GROUP BY podcast_id
        ) latest ON latest.podcast_id = membership.podcast_id""",
    ]
    if sort.startswith("creator"):
        joins += [
            f"LEFT JOIN ({primary_creator_rows_sql('media_id')}) mc"
            " ON mc.owner_id = membership.media_id",
            f"LEFT JOIN ({primary_creator_rows_sql('podcast_id')}) pc"
            " ON pc.owner_id = membership.podcast_id",
        ]
    if engagement:
        joins.append(
            f"LEFT JOIN ({projection.engagement_fact_rows_sql()}) eng"
            " ON eng.media_id = membership.media_id"
        )
    if remaining:
        joins.append(
            f"LEFT JOIN ({reading_time_rows_sql()}) duration"
            " ON duration.media_id = membership.media_id"
        )
    # A show's NULL read state never matches, so the engagement lenses list no shows.
    predicates = ["true"]
    if view.projection == "in_progress":
        predicates.append("facts.read_state = 'InProgress'")
    if view.completion == "unfinished":
        predicates.append("facts.media_id IS NOT NULL")
        predicates.append("facts.read_state IS DISTINCT FROM 'Finished'")
    if view.entry_type == "podcast":
        predicates.append("facts.target_kind = 'podcast'")
    elif view.entry_type is not None:
        predicates.append("facts.media_kind = :entry_type")
    membership = _all_membership_sql(view) if is_default else _NAMED_MEMBERSHIP_SQL
    return f"""
        WITH {membership},
        facts AS (
            SELECT
                membership.*,
                md.kind AS media_kind,
                CASE WHEN membership.media_id IS NOT NULL THEN 'media' ELSE 'podcast' END
                    AS target_kind,
                COALESCE(membership.media_id, membership.podcast_id) AS target_id,
                lower(btrim(COALESCE(md.title, pod.title))) AS title_key,
                {creator}::text AS creator_name,
                ({creator} IS NULL)::int AS creator_name_missing,
                COALESCE(
                    md.original_published_date,
                    to_char(
                        latest.published_at AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                    )
                ) AS published_date,
                (md.original_published_date IS NULL AND latest.published_at IS NULL)::int
                    AS published_date_missing,
                {"eng.read_state" if engagement else "NULL::text"} AS read_state,
                {"duration.remaining_seconds" if remaining else "NULL::float8"}
                    AS remaining_seconds,
                {"(duration.remaining_seconds IS NULL)::int" if remaining else "1"}
                    AS remaining_seconds_missing
            FROM membership
            {" ".join(joins)}
        )
        SELECT * FROM facts
        WHERE {" AND ".join(predicates)} {keyset}
        ORDER BY {order}
        LIMIT :limit
    """


def _shows(db: Session, viewer_id: UUID, podcast_ids: list[UUID]) -> dict[UUID, Any]:
    """title, artwork, latest episode, unplayed count and viewer sync status per show."""
    if not podcast_ids:
        return {}
    episode_state = projection.episode_state_case_sql(listening_alias="pls", override_alias="co")
    state_joins = projection.episode_state_joins_sql(
        user_param=":viewer_id",
        media_expr="pe.media_id",
        listening_alias="pls",
        override_alias="co",
    )
    rows = db.execute(
        text(f"""
            WITH unplayed AS (
                SELECT pe.podcast_id,
                       COUNT(*) FILTER (WHERE {episode_state} = 'unplayed') AS n
                FROM podcast_episodes pe
                JOIN ({visible_media_ids_cte_sql()}) vm ON vm.media_id = pe.media_id
                {state_joins}
                WHERE pe.podcast_id = ANY(:ids)
                GROUP BY pe.podcast_id
            )
            SELECT p.id, p.title, p.image_url, COALESCE(u.n, 0) AS unplayed_count, ps.sync_status,
                   (SELECT max(published_at) FROM podcast_episodes WHERE podcast_id = p.id)
                       AS published_date
            FROM podcasts p
            LEFT JOIN unplayed u ON u.podcast_id = p.id
            LEFT JOIN podcast_subscriptions ps
              ON ps.podcast_id = p.id AND ps.user_id = :viewer_id
            WHERE p.id = ANY(:ids)
        """),
        {"viewer_id": viewer_id, "ids": podcast_ids},
    ).all()
    return {row.id: row for row in rows}


def list_library_entries(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
    *,
    view: EntryView,
    cursor: str | None,
    limit: int,
) -> LibraryEntriesPageOut:
    """One page of a library's entries under a view; members only. The cursor is
    bound to this viewer, library and view, and manual-order pages to their revision."""
    from nexus.services import media as media_service

    library = libraries.access(db, viewer_id, library_id, lock=False)
    if view.projection == "unfiled" and not library.is_default:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unfiled is a view of All")
    own_order = (
        SortKey("added_at", "desc", KeysetValueKind.DateTime)
        if library.is_default
        else SortKey("position", "asc", KeysetValueKind.Int)
    )
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
        plan=(*(_SORTS[view.sort] if view.sort else (own_order,)), *_IDENTITY),
        cursor=cursor,
        limit=limit,
        params={"viewer_id": viewer_id, "library_id": library_id, "entry_type": view.entry_type},
        sql=lambda keyset, order: _page_sql(
            view, is_default=library.is_default, keyset=keyset, order=order
        ),
    )
    summaries = media_service.media_summaries(
        db, viewer_id=viewer_id, media_ids=[row["media_id"] for row in rows if row["media_id"]]
    )
    podcast_ids = [row["podcast_id"] for row in rows if row["podcast_id"]]
    shows = _shows(db, viewer_id, podcast_ids)
    credits = load_contributor_credits_for_podcasts(db, podcast_ids)
    items: list[LibraryEntryOut] = []
    for row in rows:
        if row["media_id"] is not None:
            items.append(
                LibraryMediaEntryOut(
                    kind="media",
                    entry_id=row["entry_id"],
                    added_at=row["added_at"],
                    media_summary=summaries[row["media_id"]],
                )
            )
            continue
        show = shows[row["podcast_id"]]
        items.append(
            LibraryPodcastEntryOut(
                kind="podcast",
                entry_id=row["entry_id"],
                added_at=row["added_at"],
                podcast_id=show.id,
                title=show.title,
                image_url=show.image_url,
                contributors=credits.get(show.id, []),
                unplayed_count=show.unplayed_count,
                published_date=show.published_date,
                sync_status=show.sync_status,
            )
        )
    return LibraryEntriesPageOut(
        items=items, next_cursor=next_cursor, order_revision=order_revision
    )


def count_default_root_inventory(db: Session, *, viewer_id: UUID, library_id: UUID) -> int:
    """How many rows the viewer's own All lists."""
    if not libraries.access(db, viewer_id, library_id, lock=False).is_default:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Only All has a root inventory")
    return db.execute(
        text(
            f"WITH {_all_membership_sql(EntryView(None, None, None, None))} SELECT count(*) FROM membership"
        ),
        {"viewer_id": viewer_id, "library_id": library_id},
    ).scalar_one()
