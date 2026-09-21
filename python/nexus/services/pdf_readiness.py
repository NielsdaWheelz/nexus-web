"""PDF quote-readiness: text present, and one text span per page."""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.logging import get_logger

logger = get_logger(__name__)


def pdf_quote_text_readiness_rows_sql() -> str:
    """PDF quote facts and their single readiness predicate, for composed queries."""
    return """
        SELECT facts.*,
               COALESCE(has_quote_text AND page_count > 0 AND span_count = page_count, false)
                   AS quote_text_ready
        FROM (
            SELECT m.id AS media_id, m.page_count,
                   m.plain_text_word_count > 0 AS has_quote_text,
                   (SELECT count(*) FROM pdf_page_text_spans p WHERE p.media_id = m.id)
                       AS span_count
            FROM media m WHERE m.kind = 'pdf'
        ) facts
    """


def is_pdf_quote_text_ready(db: Session, media_id: UUID) -> bool:
    return batch_pdf_quote_text_ready(db, [media_id])[media_id]


def batch_pdf_quote_text_ready(db: Session, media_ids: list[UUID]) -> dict[UUID, bool]:
    """A PDF is ready when it has quote text, a positive page count, and a span
    for every page. Non-PDF media and missing ids are not ready."""
    if not media_ids:
        return {}
    rows = db.execute(
        text(f"""
            SELECT media_id, page_count, has_quote_text, span_count, quote_text_ready
            FROM ({pdf_quote_text_readiness_rows_sql()}) facts
            WHERE media_id = ANY(:media_ids)
        """),
        {"media_ids": list(media_ids)},
    ).fetchall()

    readiness = dict.fromkeys(media_ids, False)
    for media_id, page_count, has_quote_text, span_count, quote_text_ready in rows:
        if (
            has_quote_text
            and page_count is not None
            and page_count > 0
            and span_count != page_count
        ):
            logger.warning(
                "pdf_readiness_span_count_mismatch",
                media_id=str(media_id),
                page_count=page_count,
                span_count=span_count,
            )
        readiness[media_id] = bool(quote_text_ready)
    return readiness
