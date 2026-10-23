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
    """Count displayed source occurrences, using stored fragment counts.

    X composition has one primary level and one context level. Reply parents
    already in a thread link to that primary occurrence instead of repeating it.
    Ordinary wrappers include only their placed X slots, including repetitions.
    """
    return """
        WITH displayed_fragments AS (
            SELECT f.media_id, f.canonical_text_word_count AS words FROM fragments f
            UNION ALL
            SELECT p.thread_media_id, f.canonical_text_word_count
            FROM x_thread_posts p JOIN fragments f ON f.media_id=p.post_media_id
            UNION ALL
            SELECT e.media_id, f.canonical_text_word_count
            FROM document_embeds e JOIN x_post_sources s ON s.media_id=e.target_media_id
            JOIN fragments f ON f.media_id=s.media_id
            WHERE e.provider='x' AND e.resolution_status='resolved'
              AND e.canonical_end_offset IS NOT NULL
            UNION ALL
            SELECT p.thread_media_id, f.canonical_text_word_count
            FROM x_thread_posts p
            JOIN x_post_sources parent ON parent.media_id=p.post_media_id
            CROSS JOIN LATERAL jsonb_array_elements(parent.payload->'references') ref
            JOIN x_post_aliases a ON a.revision_id=ref->>'target_revision_id'
            JOIN fragments f ON f.media_id=a.post_media_id
            WHERE EXISTS (
                  SELECT 1 FROM document_embeds e WHERE e.media_id=p.post_media_id
                    AND e.provider='x' AND e.resolution_status='resolved'
                    AND e.canonical_end_offset IS NOT NULL
                    AND e.provider_target_ref=ref->>'target_revision_id'
                    AND e.target_media_id=a.post_media_id
              ) AND NOT (
                  ref->>'kind'='replied_to' AND EXISTS (
                      SELECT 1 FROM x_thread_posts member
                      WHERE member.thread_media_id=p.thread_media_id
                        AND member.post_media_id=a.post_media_id
                  )
              )
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
