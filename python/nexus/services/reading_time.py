"""Current-resume reading duration shared by library ordering and resonance."""

import math
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.presence import presence_from_nullable
from nexus.schemas.reading_time import ReadingTimeEstimateOut
from nexus.services.capabilities import quotable_document_rows_sql
from nexus.services.consumption.reader_cursor import current_position_rows_sql
from nexus.services.media_document_metrics import media_word_count_rows_sql


def reading_time_rows_sql() -> str:
    """Quotable positive-count documents, with raw float8 total/remaining seconds.

    Bind ``viewer_id``. This relation owns duration, not visibility or consumption
    completion; the composing library/resonance read owns those policies.
    """
    return f"""
        SELECT duration.media_id, duration.total_seconds,
               CASE
                   WHEN NOT COALESCE(cursor.positioned, false) THEN duration.total_seconds
                   WHEN duration.media_kind IN ('web_article', 'epub')
                       THEN duration.total_seconds * (1.0::float8 - cursor.total_progression)
                   ELSE NULL::float8
               END AS remaining_seconds
        FROM (
            SELECT document.media_id, document.media_kind,
                   counts.word_count::float8 / 4.0::float8 AS total_seconds
            FROM ({quotable_document_rows_sql()}) document
            JOIN ({media_word_count_rows_sql()}) counts ON counts.media_id = document.media_id
            WHERE counts.word_count > 0
        ) duration
        LEFT JOIN ({current_position_rows_sql()}) cursor ON cursor.media_id = duration.media_id
    """


def _display_minutes(seconds: float) -> int:
    """Half-up 1/5/15-minute rounding; exact zero stays zero."""
    if seconds == 0:
        return 0
    minutes = seconds / 60.0
    quantum = 1 if minutes < 10 else (5 if minutes < 60 else 15)
    return max(1, quantum * math.floor(minutes / quantum + 0.5))


def load_reading_time_estimates(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, ReadingTimeEstimateOut]:
    """Batch display projection over the same raw facts used for filtering/ordering."""
    if not media_ids:
        return {}
    rows = db.execute(
        text(f"""
            SELECT media_id, total_seconds, remaining_seconds
            FROM ({reading_time_rows_sql()}) duration
            WHERE media_id = ANY(:media_ids)
        """),
        {"viewer_id": viewer_id, "media_ids": media_ids},
    )
    return {
        row.media_id: ReadingTimeEstimateOut(
            total_minutes=_display_minutes(row.total_seconds),
            remaining_minutes=presence_from_nullable(
                None if row.remaining_seconds is None else _display_minutes(row.remaining_seconds)
            ),
        )
        for row in rows
    }
