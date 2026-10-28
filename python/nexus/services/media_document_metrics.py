"""Stored word-count and section-count projections for canonical media text."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.services.media_text_scope import x_capture_scope_rows_sql


@dataclass(frozen=True)
class MediaSummaryMetrics:
    word_count: int
    source_section_count: int | None


def media_word_count_rows_sql() -> str:
    """Count displayed source occurrences, using stored fragment counts.

    X composition has one primary level and one context level. Reply parents
    already in a thread link to that primary occurrence instead of repeating it.
    Ordinary wrappers include only their placed X slots, including repetitions.
    """
    return f"""
        WITH displayed_fragments AS (
            SELECT f.media_id, f.canonical_text_word_count AS words FROM fragments f
            WHERE f.media_id IS NOT NULL
            UNION ALL
            SELECT x.reading_media_id, f.canonical_text_word_count
            FROM ({x_capture_scope_rows_sql("SELECT id AS media_id FROM media")}) x
            JOIN fragments f ON f.id=x.fragment_id
        )
        SELECT m.id AS media_id,
               CASE
                   WHEN m.kind IN ('web_article', 'epub') THEN COALESCE((
                       SELECT SUM(f.words)
                       FROM displayed_fragments f WHERE f.media_id = m.id
                   ), 0)
                   WHEN m.kind = 'text_part' THEN (SELECT p.word_count FROM media_parts p WHERE p.media_id=m.id)::bigint
                   WHEN m.kind = 'pdf' THEN m.plain_text_word_count::bigint
                   ELSE NULL
               END AS word_count
        FROM media m
    """


def load_media_summary_metrics(db: Session, media_id: UUID) -> MediaSummaryMetrics:
    """Word count, plus PDF page count or timed-media fragment count where one exists."""
    row = db.execute(
        text(
            f"""
            SELECT CASE WHEN m.kind IN ('web_article', 'epub', 'pdf', 'text_part') THEN counts.word_count
                        ELSE COALESCE(SUM(f.canonical_text_word_count), 0)
                   END AS word_count,
                   CASE
                       WHEN m.kind = 'pdf' THEN COALESCE(
                           NULLIF(m.page_count, 0),
                           (
                               SELECT COUNT(DISTINCT page_number)
                               FROM pdf_page_text_spans
                               WHERE media_id = m.id
                           ),
                           0
                       )
                       WHEN m.kind IN ('podcast_episode', 'video') THEN COUNT(f.id)
                       ELSE NULL
                   END AS source_section_count
            FROM media m
            JOIN ({media_word_count_rows_sql()}) counts ON counts.media_id=m.id
            LEFT JOIN fragments f ON f.media_id = m.id AND m.kind != 'pdf'
            WHERE m.id = :media_id
            GROUP BY m.id, m.kind, m.page_count, counts.word_count
            """
        ),
        {"media_id": media_id},
    ).first()
    if row is None:
        return MediaSummaryMetrics(word_count=0, source_section_count=None)
    section_count = row.source_section_count
    return MediaSummaryMetrics(
        word_count=int(row.word_count or 0),
        source_section_count=None if section_count is None else int(section_count),
    )
