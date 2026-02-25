"""Shared DB-backed PDF quote-readiness predicate (S6 PR-03).

Provides single-media and batch helpers used by media.py and libraries.py
to determine whether a PDF has full pdf_quote_text_ready(media) semantics.

Does NOT perform heavy contiguity revalidation on reads — relies on write-time
enforcement in pdf_ingest/pdf_lifecycle per S6-PR03-D07.
"""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.logging import get_logger

logger = get_logger(__name__)


def is_pdf_quote_text_ready(db: Session, media_id: UUID) -> bool:
    """Check if a single PDF media has full quote-text readiness.

    True iff:
    1. media.plain_text is present and non-empty
    2. media.page_count is present and >= 1
    3. pdf_page_text_spans row count == page_count (coverage check)

    Uses lightweight fail-closed check. If data is in an impossible state,
    returns False with observability logging.
    """
    result = db.execute(
        text("""
            SELECT
                m.page_count,
                (m.plain_text IS NOT NULL AND length(m.plain_text) > 0) as has_text,
                (SELECT count(*) FROM pdf_page_text_spans p WHERE p.media_id = m.id) as span_count
            FROM media m
            WHERE m.id = :media_id
        """),
        {"media_id": media_id},
    )
    row = result.fetchone()
    if row is None:
        return False

    page_count, has_text, span_count = row

    if not has_text or page_count is None or page_count < 1:
        return False

    if span_count != page_count:
        logger.warning(
            "pdf_readiness_span_count_mismatch",
            media_id=str(media_id),
            page_count=page_count,
            span_count=span_count,
        )
        return False

    return True


def batch_pdf_quote_text_ready(
    db: Session,
    media_ids: list[UUID],
) -> dict[UUID, bool]:
    """Check quote-text readiness for multiple PDF media in one query.

    Returns a dict mapping media_id -> ready boolean.
    Non-PDF media or missing IDs return False.
    """
    if not media_ids:
        return {}

    result = db.execute(
        text("""
            SELECT
                m.id,
                m.page_count,
                (m.plain_text IS NOT NULL AND length(m.plain_text) > 0) as has_text,
                (SELECT count(*) FROM pdf_page_text_spans p WHERE p.media_id = m.id) as span_count
            FROM media m
            WHERE m.id = ANY(:media_ids)
              AND m.kind = 'pdf'
        """),
        {"media_ids": list(media_ids)},
    )

    readiness = {}
    for row in result.fetchall():
        mid, page_count, has_text, span_count = row
        if has_text and page_count is not None and page_count >= 1 and span_count == page_count:
            readiness[mid] = True
        else:
            readiness[mid] = False

    for mid in media_ids:
        if mid not in readiness:
            readiness[mid] = False

    return readiness
