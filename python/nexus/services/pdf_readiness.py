"""Shared DB-backed PDF quote-readiness predicate.

Does NOT perform heavy contiguity revalidation on reads; relies on write-time
enforcement in pdf_ingest and pdf_lifecycle.
"""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.logging import get_logger

logger = get_logger(__name__)


def is_pdf_quote_text_ready(db: Session, media_id: UUID) -> bool:
    """Check quote-text readiness for one PDF."""
    return batch_pdf_quote_text_ready(db, [media_id])[media_id]


def batch_pdf_quote_text_ready(
    db: Session,
    media_ids: list[UUID],
) -> dict[UUID, bool]:
    """Check quote-text readiness for multiple PDF media in one query.

    A PDF is ready when its canonical text has at least one word, its page
    count is positive, and its text-span count matches that page count.
    A span-count mismatch is logged only when text and page count are present.
    Non-PDF media or missing IDs return False.
    """
    if not media_ids:
        return {}

    result = db.execute(
        text("""
            SELECT
                m.id,
                m.page_count,
                (m.plain_text_word_count > 0) as has_quote_text,
                (SELECT count(*) FROM pdf_page_text_spans p WHERE p.media_id = m.id) as span_count
            FROM media m
            WHERE m.id = ANY(:media_ids)
              AND m.kind = 'pdf'
        """),
        {"media_ids": list(media_ids)},
    )

    readiness = dict.fromkeys(media_ids, False)
    for row in result.fetchall():
        mid, page_count, has_quote_text, span_count = row
        if not has_quote_text or page_count is None or page_count < 1:
            continue
        if span_count != page_count:
            logger.warning(
                "pdf_readiness_span_count_mismatch",
                media_id=str(mid),
                page_count=page_count,
                span_count=span_count,
            )
            continue
        readiness[mid] = True

    return readiness
