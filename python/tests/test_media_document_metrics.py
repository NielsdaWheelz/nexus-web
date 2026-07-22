"""Database-backed contracts for stored canonical media metrics."""

import re
from uuid import uuid4

import pytest
from sqlalchemy import event
from sqlalchemy.orm import Session

from nexus.db.models import Fragment, Media, MediaKind, PdfPageTextSpan, ProcessingStatus
from nexus.schemas.presence import Absent, Present
from nexus.services.media_document_metrics import (
    load_media_summary_metrics,
    load_media_word_counts,
)

pytestmark = pytest.mark.integration


def _add_media(
    db: Session,
    kind: MediaKind,
    *,
    plain_text: str | None = None,
    page_count: int | None = None,
) -> Media:
    media = Media(
        id=uuid4(),
        kind=kind.value,
        title=f"Metrics {kind.value}",
        processing_status=ProcessingStatus.ready_for_reading,
        plain_text=plain_text,
        page_count=page_count,
    )
    db.add(media)
    db.flush()
    return media


def _add_fragment(db: Session, media: Media, idx: int, canonical_text: str) -> None:
    db.add(
        Fragment(
            id=uuid4(),
            media_id=media.id,
            idx=idx,
            canonical_text=canonical_text,
            html_sanitized="",
        )
    )


def test_word_count_batch_deduplicates_and_reads_mixed_document_counts_once(
    db_session: Session,
):
    article = _add_media(db_session, MediaKind.web_article)
    _add_fragment(db_session, article, 0, "one two")
    _add_fragment(db_session, article, 1, "three\tfour\nfive")
    epub = _add_media(db_session, MediaKind.epub)
    _add_fragment(db_session, epub, 0, "one two three four")
    pdf = _add_media(db_session, MediaKind.pdf, plain_text="one two\tthree")
    db_session.flush()

    statements: list[str] = []

    def capture_statement(_connection, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)

    bind = db_session.get_bind()
    event.listen(bind, "before_cursor_execute", capture_statement)
    try:
        assert load_media_word_counts(db_session, []) == {}
        assert statements == []

        counts = load_media_word_counts(
            db_session,
            [article.id, pdf.id, article.id, epub.id],
        )
    finally:
        event.remove(bind, "before_cursor_execute", capture_statement)

    assert counts == {article.id: 5, pdf.id: 3, epub.id: 4}
    assert len(statements) == 1, (
        f"expected one stored-count query for a mixed batch, got {len(statements)}"
    )
    assert re.search(r"\bcanonical_text\b", statements[0], re.IGNORECASE) is None
    assert re.search(r"\bplain_text\b", statements[0], re.IGNORECASE) is None


def test_word_count_batch_accepts_200_distinct_ids_and_rejects_201(db_session: Session):
    media = [_add_media(db_session, MediaKind.pdf, plain_text="one") for _ in range(200)]
    db_session.flush()

    counts = load_media_word_counts(db_session, [item.id for item in media])

    assert counts == {item.id: 1 for item in media}
    with pytest.raises(AssertionError, match="exceeds 200 distinct IDs"):
        load_media_word_counts(db_session, [item.id for item in media] + [uuid4()])
    assert load_media_word_counts(db_session, [media[0].id] * 201) == {media[0].id: 1}


def test_word_count_batch_defects_on_missing_unsupported_or_null_source(db_session: Session):
    podcast = _add_media(db_session, MediaKind.podcast_episode)
    null_pdf = _add_media(db_session, MediaKind.pdf, plain_text=None)
    db_session.flush()

    with pytest.raises(AssertionError, match="Missing media word counts"):
        load_media_word_counts(db_session, [uuid4()])
    with pytest.raises(AssertionError, match="Unsupported document metrics kind"):
        load_media_word_counts(db_session, [podcast.id])
    with pytest.raises(AssertionError, match="Missing word count"):
        load_media_word_counts(db_session, [null_pdf.id])


def test_summary_metrics_preserve_per_kind_word_and_section_semantics(db_session: Session):
    article = _add_media(db_session, MediaKind.web_article)
    _add_fragment(db_session, article, 0, "one two three")
    epub = _add_media(db_session, MediaKind.epub)
    _add_fragment(db_session, epub, 0, "one two")

    pdf = _add_media(db_session, MediaKind.pdf, plain_text="one two three four")
    db_session.add_all(
        [
            PdfPageTextSpan(
                media_id=pdf.id,
                page_number=1,
                start_offset=0,
                end_offset=7,
            ),
            PdfPageTextSpan(
                media_id=pdf.id,
                page_number=2,
                start_offset=8,
                end_offset=18,
            ),
        ]
    )

    podcast = _add_media(db_session, MediaKind.podcast_episode)
    _add_fragment(db_session, podcast, 0, "one two")
    _add_fragment(db_session, podcast, 1, "three")
    video = _add_media(db_session, MediaKind.video)
    _add_fragment(db_session, video, 0, "one two three four five")
    db_session.flush()

    article_metrics = load_media_summary_metrics(db_session, article.id)
    epub_metrics = load_media_summary_metrics(db_session, epub.id)
    pdf_metrics = load_media_summary_metrics(db_session, pdf.id)
    podcast_metrics = load_media_summary_metrics(db_session, podcast.id)
    video_metrics = load_media_summary_metrics(db_session, video.id)

    assert article_metrics.word_count == 3
    assert isinstance(article_metrics.source_section_count, Absent)
    assert epub_metrics.word_count == 2
    assert isinstance(epub_metrics.source_section_count, Absent)
    assert pdf_metrics.word_count == 4
    assert isinstance(pdf_metrics.source_section_count, Present)
    assert pdf_metrics.source_section_count.value == 2
    assert podcast_metrics.word_count == 3
    assert isinstance(podcast_metrics.source_section_count, Present)
    assert podcast_metrics.source_section_count.value == 2
    assert video_metrics.word_count == 5
    assert isinstance(video_metrics.source_section_count, Present)
    assert video_metrics.source_section_count.value == 1
