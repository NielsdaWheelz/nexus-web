"""One source's known media, using ordinary consumption and media presentation."""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import requested_media_ids_cte_sql
from nexus.db.models import TranscriptState
from nexus.schemas import feed as wire
from nexus.services import media
from nexus.services.collection_keyset import KeysetValueKind, SortKey, keyset_page
from nexus.services.consumption import projection
from nexus.services.reading_time import reading_time_rows_sql


def entry_rows_sql() -> str:
    return f"""
        WITH observations AS (
            SELECT DISTINCT ON (feed_id,media_id) * FROM feed_entries
            ORDER BY feed_id,media_id,published_at DESC NULLS LAST,published_on DESC NULLS LAST,id
        )
        SELECT e.id AS entry_id,e.feed_id,e.media_id,e.entry_url,e.published_at,e.published_on,
            COALESCE(e.published_at,e.published_on::timestamptz) AS publication_order,
            (e.published_at IS NULL AND e.published_on IS NULL)::int AS published_missing,
            COALESCE(pe.duration_seconds::float8,reading.total_seconds) AS duration_sort,
            (COALESCE(pe.duration_seconds::float8,reading.total_seconds) IS NULL)::int AS duration_missing,
            CASE COALESCE(c.read_state,'Unread') WHEN 'Finished' THEN 'finished'
                WHEN 'InProgress' THEN 'in_progress' ELSE 'unread' END AS entry_state,
            mts.transcript_state
        FROM observations e JOIN ({requested_media_ids_cte_sql()}) readable ON readable.media_id=e.media_id
        LEFT JOIN ({projection.engagement_fact_rows_sql()}) c ON c.media_id=e.media_id
        LEFT JOIN podcast_episodes pe ON pe.media_id=e.media_id
        LEFT JOIN ({reading_time_rows_sql()}) reading ON reading.media_id=e.media_id
        LEFT JOIN media_transcript_states mts ON mts.media_id=e.media_id
    """


def entry_counts(db: Session, viewer_id: UUID, feed_id: UUID) -> wire.FeedEntryCountsOut:
    row = (
        db.execute(
            text(f"""SELECT count(*)::int AS known_count,
        count(*) FILTER(WHERE entry_state<>'finished')::int AS unfinished_count
        FROM ({entry_rows_sql()}) entries WHERE feed_id=:feed"""),
            {"viewer_id": viewer_id, "feed": feed_id},
        )
        .mappings()
        .one()
    )
    return wire.FeedEntryCountsOut(**row)


def entry_order_plan(sort: wire.EntrySort) -> list[SortKey]:
    direction = "asc" if sort == "oldest" else "desc"
    publication = [
        SortKey("published_missing", "asc", KeysetValueKind.Int),
        SortKey("publication_order", direction, KeysetValueKind.DateTimeOrNull),
        SortKey("media_id", direction, KeysetValueKind.Uuid),
    ]
    if sort in ("newest", "oldest"):
        return publication
    return [
        SortKey("duration_missing", "asc", KeysetValueKind.Int),
        SortKey(
            "duration_sort",
            "asc" if sort == "duration_asc" else "desc",
            KeysetValueKind.FloatOrNull,
        ),
        *publication,
    ]


def list_entries(
    db: Session,
    viewer_id: UUID,
    feed_id: UUID,
    *,
    state: wire.EntryState,
    sort: wire.EntrySort,
    cursor: str | None = None,
    limit: int = 100,
) -> wire.FeedEntryIndexOut:
    from .queries import get_feed_detail

    detail = get_feed_detail(db, viewer_id, feed_id)
    rows, next_cursor = keyset_page(
        db,
        binding={
            "feed_id": str(feed_id),
            "viewer_id": str(viewer_id),
            "state": state,
            "sort": sort,
        },
        plan=entry_order_plan(sort),
        cursor=cursor,
        limit=limit,
        params={"viewer_id": viewer_id, "feed": feed_id, "state": state},
        alias="entries",
        sql=lambda predicate, order: f"""SELECT * FROM ({entry_rows_sql()}) entries
            WHERE feed_id=:feed AND (:state='all' OR entry_state=:state) {predicate}
            ORDER BY {order} LIMIT :limit""",
    )
    summaries = media.media_summaries(
        db, viewer_id=viewer_id, media_ids=[row["media_id"] for row in rows]
    )
    return wire.FeedEntryIndexOut(
        feed=detail,
        next_cursor=next_cursor,
        items=[
            wire.FeedEntryListItemOut(
                id=row["media_id"],
                entry_id=row["entry_id"],
                media_summary=summaries[row["media_id"]],
                published_at=row["published_at"],
                published_on=row["published_on"],
                entry_url=row["entry_url"],
                transcript_state=TranscriptState(row["transcript_state"])
                if row["transcript_state"]
                else None,
            )
            for row in rows
        ],
    )
