"""Stored word-count and section-count projections for canonical media text."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session


@dataclass(frozen=True)
class MediaSummaryMetrics:
    word_count: int
    source_section_count: int | None


def media_word_count_rows_sql() -> str:
    """Stored canonical document counts; no text bodies are read or tokenized."""
    return """
        SELECT m.id AS media_id,
               CASE
                   WHEN m.kind IN ('web_article', 'epub') THEN COALESCE((
                       SELECT SUM(f.canonical_text_word_count)
                       FROM fragments f WHERE f.media_id = m.id
                   ), 0)
                   WHEN m.kind = 'pdf' THEN m.plain_text_word_count::bigint
                   ELSE NULL
               END AS word_count
        FROM media m
    """


def load_media_word_counts(db: Session, media_ids: list[UUID]) -> dict[UUID, int]:
    """One entry per distinct input id, in input order; a vanished row counts 0."""
    distinct_ids = list(dict.fromkeys(media_ids))
    if not distinct_ids:
        return {}
    rows = db.execute(
        text(f"""
            SELECT media_id, word_count FROM ({media_word_count_rows_sql()}) counts
            WHERE media_id = ANY(:media_ids)
        """),
        {"media_ids": distinct_ids},
    ).all()
    counts = {UUID(str(row[0])): int(row[1] or 0) for row in rows}
    return {media_id: counts.get(media_id, 0) for media_id in distinct_ids}


def load_media_summary_metrics(db: Session, media_id: UUID) -> MediaSummaryMetrics:
    """Word count, plus PDF page count or timed-media fragment count where one exists."""
    row = db.execute(
        text(
            """
            SELECT CASE
                       WHEN m.kind = 'pdf' THEN m.plain_text_word_count::bigint
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
            LEFT JOIN fragments f ON f.media_id = m.id AND m.kind != 'pdf'
            WHERE m.id = :media_id
            GROUP BY m.id, m.kind, m.plain_text_word_count, m.page_count
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
