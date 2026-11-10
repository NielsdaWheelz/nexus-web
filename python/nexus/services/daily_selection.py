"""Account-calendar windows and publisher-evidenced daily candidate facts.

Discovery is an account acquisition fact, not a feed observation or extraction
timestamp. Only the publication owner decides whether a due window is published.
"""

from datetime import UTC, date, datetime, time, timedelta
from uuid import UUID
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.services.capabilities import quotable_document_rows_sql
from nexus.services.feeds.queries import active_subscription_rows_sql, catalog_feed_ids_sql
from nexus.services.publication_facts import earliest_publisher_fact_sql


class DailyWindow(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    local_date: date
    time_zone: str
    window_start: datetime
    window_end: datetime


def due_window(
    *, observed_at: datetime, time_zone: str, previous_cutoff: datetime | None
) -> DailyWindow | None:
    """The latest due civil morning; absence never creates a backlog of editions."""
    zone = ZoneInfo(time_zone)
    local = observed_at.astimezone(zone)
    day = local.date() - timedelta(days=local.time() < time(7))
    end = datetime.combine(day, time(7), zone).astimezone(UTC)
    if previous_cutoff is not None and end <= previous_cutoff:
        return None
    start = datetime.combine(day - timedelta(days=1), time(7), zone).astimezone(UTC)
    return DailyWindow(
        local_date=day,
        time_zone=time_zone,
        window_start=max(start, previous_cutoff) if previous_cutoff is not None else start,
        window_end=end,
    )


def next_cutoff(*, observed_at: datetime, time_zone: str) -> datetime:
    zone = ZoneInfo(time_zone)
    local = observed_at.astimezone(zone)
    day = local.date() + timedelta(days=local.time() >= time(7))
    return datetime.combine(day, time(7), zone).astimezone(UTC)


def bindings(window: DailyWindow) -> dict[str, object]:
    zone = ZoneInfo(window.time_zone)
    return {
        "window_start": window.window_start,
        "window_end": window.window_end,
        "edition_date": window.local_date,
        "time_zone": window.time_zone,
        "publication_start": datetime.combine(
            window.local_date - timedelta(days=7), time(7), zone
        ).astimezone(UTC),
        "publication_day_start": window.local_date - timedelta(days=6),
    }


def eligible_media_rows_sql() -> str:
    """Daily admission over visible media, before any ranking or lexical retrieval.

    Choose the earliest credible publication fact by its lower bound in this edition's
    zone. Its original precision decides freshness; date-only evidence never acquires
    an invented stored timestamp. Link usability belongs to authorized source entries.
    """
    return f"""
        WITH followed AS MATERIALIZED ({active_subscription_rows_sql()}),
        catalog AS MATERIALIZED ({catalog_feed_ids_sql()}),
        readable AS MATERIALIZED ({quotable_document_rows_sql()})
        SELECT m.id AS media_id, d.first_discovered_at,
               original.published_at,original.published_on,
               (SELECT MIN(fe.feed_id::text)::uuid FROM feed_entries fe
                JOIN catalog c ON c.feed_id=fe.feed_id WHERE fe.media_id=m.id) AS feed_id
        FROM media m JOIN visible v ON v.media_id=m.id
        JOIN viewer_media_discoveries d ON d.media_id=m.id AND d.user_id=:viewer_id
        CROSS JOIN LATERAL (
            {earliest_publisher_fact_sql(media_id_sql="m.id", time_zone_sql=":time_zone")}
        ) original
        WHERE d.origin NOT IN ('history','existing')
          AND EXISTS (SELECT 1 FROM library_entries entry
                      JOIN libraries library ON library.id=entry.library_id
                      JOIN memberships member ON member.library_id=library.id
                      WHERE entry.media_id=m.id AND member.user_id=:viewer_id
                        AND library.system_key IS NULL)
          AND d.first_discovered_at>=:window_start AND d.first_discovered_at<:window_end
          AND (EXISTS (SELECT 1 FROM feed_entries fe JOIN followed f ON f.feed_id=fe.feed_id
                       WHERE fe.media_id=m.id)
               OR (d.manually_saved AND m.kind='web_article'))
          AND ((original.published_at IS NOT NULL
                AND original.published_at BETWEEN :publication_start AND :window_end)
               OR (original.published_at IS NULL
                   AND original.published_on BETWEEN :publication_day_start AND :edition_date))
          AND (m.id IN (SELECT media_id FROM readable)
               OR (m.kind='podcast_episode'
                   AND EXISTS (SELECT 1 FROM podcast_episodes pe WHERE pe.media_id=m.id)
                   AND NULLIF(btrim(m.external_playback_url),'') IS NOT NULL)
               OR (d.manually_saved AND m.kind='web_article'
                   AND COALESCE(m.canonical_source_url,m.requested_url) ~ '^https?://[^/[:space:]]+')
               OR EXISTS (SELECT 1 FROM feed_entries fe JOIN catalog c ON c.feed_id=fe.feed_id
                          WHERE fe.media_id=m.id AND fe.entry_url ~ '^https?://[^/[:space:]]+'))
    """


def head_coverage(db: Session, *, viewer_id: UUID, window: DailyWindow) -> dict[str, int]:
    row = db.execute(
        text(f"""
            SELECT COUNT(*) AS source_count,
                   COUNT(*) FILTER (WHERE f.head_run_id IS NULL
                       AND f.last_checked_at>=:fresh_since
                       AND f.last_check_error_code IS NULL
                       AND NOT f.last_check_had_coverage_gaps) AS checked_source_count
            FROM ({active_subscription_rows_sql()}) followed
            JOIN feeds f ON f.id=followed.feed_id
        """),
        {"viewer_id": viewer_id, "fresh_since": window.window_end - timedelta(hours=1)},
    ).one()
    return {"source_count": row.source_count, "checked_source_count": row.checked_source_count}
