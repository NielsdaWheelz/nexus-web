"""Source publication dates stay edition-scoped; accepted research can replace or clear."""

from __future__ import annotations

import hashlib
from pathlib import Path
from uuid import uuid4

import fitz
import pytest
from sqlalchemy.orm import Session

from nexus.db.models import Media, MediaKind, ProcessingStatus
from nexus.schemas.presence import absent, present
from nexus.services.contributors import (
    MediaTarget,
    apply_observed_role_slices_in_current_transaction,
)
from nexus.services.epub_ingest import EpubExtractionResult, extract_epub_metadata
from nexus.services.epub_metadata import build_epub_author_observation, persist_epub_metadata
from nexus.services.metadata_enrichment import (
    MetadataEnrichmentOutput,
    build_enrichment_user_content,
    merge_enrichment,
    validate_structured_enrichment,
)
from nexus.services.pdf_ingest import PdfExtractionPlan, build_pdf_extraction_plan
from nexus.services.pdf_metadata import persist_pdf_metadata
from tests.testkit.epub_fixtures import ChunkedSourceStorage, zip_payload


def _epub_path(tmp_path: Path, identifiers: str, dates: str) -> Path:
    path = tmp_path / "edition.epub"
    path.write_bytes(
        zip_payload(
            {
                "mimetype": b"application/epub+zip",
                "META-INF/container.xml": b"""<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>""",
                "content.opf": f"""<package xmlns="http://www.idpf.org/2007/opf" xmlns:opf="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="primary">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>Heart of Darkness</dc:title><dc:creator>Joseph Conrad</dc:creator>
<dc:publisher>Penguin</dc:publisher>{dates}
{identifiers}</metadata></package>""".encode(),
            }
        )
    )
    return path


def test_epub_reprint_date_never_replaces_original_and_null_research_clears(
    tmp_path: Path, db_session: Session
) -> None:
    media = Media(
        kind=MediaKind.epub.value,
        title="Heart of Darkness",
        processing_status=ProcessingStatus.ready_for_reading,
    )
    db_session.add(media)
    db_session.flush()
    path = _epub_path(
        tmp_path,
        '<dc:identifier id="primary">urn:isbn:978-0-14-144167-2</dc:identifier>',
        "<dc:date>2007-09-06</dc:date>",
    )
    result = extract_epub_metadata(path)
    assert isinstance(result, EpubExtractionResult), result
    persist_epub_metadata(db_session, media, result)
    db_session.flush()
    db_session.refresh(media)
    assert media.original_published_date is None
    assert media.edition_published_date == "2007-09-06"
    assert media.edition_isbn == "9780141441672"
    # Controlled accepted research proves publication semantics, not model accuracy.
    accepted = validate_structured_enrichment(
        {
            "title": None,
            "authors": None,
            "publisher": None,
            "description": None,
            "original_published_date": "1899",
            "edition_published_date": "2007-09-06",
            "language": None,
        }
    )
    assert accepted is not None
    merge_enrichment(db_session, media, accepted)
    db_session.flush()
    db_session.refresh(media)
    assert media.original_published_date == "1899"
    prompt = build_enrichment_user_content(db_session, media, "Joseph Conrad's novella")
    assert 'current_original_published_date: "1899"' in prompt
    assert 'current_edition_published_date: "2007-09-06"' in prompt
    assert 'edition_isbn: "9780141441672"' in prompt

    reprint = extract_epub_metadata(_epub_path(tmp_path, "", "<dc:date>2010</dc:date>"))
    assert isinstance(reprint, EpubExtractionResult), reprint
    persist_epub_metadata(db_session, media, reprint)
    db_session.flush()
    db_session.refresh(media)
    assert (media.original_published_date, media.edition_published_date) == ("1899", "2010")

    invalid = extract_epub_metadata(_epub_path(tmp_path, "", "<dc:date>2023-02-29</dc:date>"))
    assert isinstance(invalid, EpubExtractionResult), invalid
    persist_epub_metadata(db_session, media, invalid)
    assert media.edition_published_date == "2010", "invalid source dates are not erasures"
    assert media.original_published_date == "1899"

    merged = merge_enrichment(
        db_session,
        media,
        MetadataEnrichmentOutput(
            title=None,
            authors=None,
            publisher=None,
            description=None,
            original_published_date=None,
            edition_published_date=None,
            language=None,
        ),
    )
    db_session.flush()
    db_session.refresh(media)
    assert media.original_published_date is None
    assert media.edition_published_date is None
    assert merged.accepted_fields == ("original_published_date", "edition_published_date")


def test_collection_and_same_title_works_keep_identifying_context_and_separate_dates(
    db_session: Session,
) -> None:
    """Synthetic identities and accepted outputs prove transport/storage, not research accuracy."""
    examples = [
        ("The Crossing", "Ada Vale", "A novella by Ada Vale.", "1991", "2018"),
        ("The Crossing", "Benoit Reed", "A novel by Benoit Reed.", "1983", "2020"),
        (
            "The Crossing and Other Stories",
            "Ada Vale",
            "A collection first published in 2004, including The Crossing, first published in 1991.",
            "2004",
            "2024",
        ),
    ]
    records: list[Media] = []
    for title, author, sample, original, edition in examples:
        media = Media(
            kind=MediaKind.epub.value,
            title=title,
            processing_status=ProcessingStatus.ready_for_reading,
        )
        db_session.add(media)
        db_session.flush()
        observation, _ = build_epub_author_observation(EpubExtractionResult(creators=[author]))
        apply_observed_role_slices_in_current_transaction(
            db_session,
            target=MediaTarget(media.id),
            observation=observation,
            source="epub_opf",
        )
        db_session.flush()
        prompt = build_enrichment_user_content(db_session, media, sample)
        assert f'current_title: "{title}"' in prompt
        assert f'current_authors: ["{author}"]' in prompt
        assert f'media_ref: "media:{media.id}"' in prompt
        assert sample in prompt
        accepted = validate_structured_enrichment(
            {
                "title": None,
                "authors": None,
                "publisher": None,
                "description": None,
                "original_published_date": original,
                "edition_published_date": edition,
                "language": None,
            }
        )
        assert accepted is not None
        merge_enrichment(db_session, media, accepted)
        records.append(media)
    db_session.flush()
    for media in records:
        db_session.refresh(media)
    assert len({media.id for media in records}) == 3
    assert [(media.original_published_date, media.edition_published_date) for media in records] == [
        ("1991", "2018"),
        ("1983", "2020"),
        ("2004", "2024"),
    ]


@pytest.mark.parametrize(
    ("identifiers", "expected"),
    [
        (
            '<dc:identifier id="primary">9780141441672</dc:identifier><dc:identifier>9780140449136</dc:identifier>',
            "9780141441672",
        ),
        (
            '<dc:identifier id="primary">urn:uuid:0a178ec2-9377-4a44-9c49-eb7f0df4986e</dc:identifier><dc:identifier>0141441674</dc:identifier>',
            "9780141441672",
        ),
        (
            "<dc:identifier>9780141441672</dc:identifier><dc:identifier>0141441674</dc:identifier>",
            "9780141441672",
        ),
        (
            "<dc:identifier>9780141441672</dc:identifier><dc:identifier>9780140449136</dc:identifier>",
            None,
        ),
        ('<dc:identifier id="primary">9780141441673</dc:identifier>', None),
        (
            '<dc:identifier id="primary">urn:uuid:0a178ec2-9377-4a44-9c49-eb7f0df4986e</dc:identifier>',
            None,
        ),
    ],
)
def test_epub_identifier_selection_preserves_only_an_unambiguous_valid_isbn(
    tmp_path: Path, identifiers: str, expected: str | None
) -> None:
    result = extract_epub_metadata(_epub_path(tmp_path, identifiers, "<dc:date>2007</dc:date>"))
    assert isinstance(result, EpubExtractionResult), result
    assert result.edition_isbn == (present(expected) if expected is not None else absent())


@pytest.mark.parametrize(
    ("dates", "expected"),
    [
        (
            '<dc:date opf:event="creation">2026</dc:date>'
            '<dc:date opf:event="modification">2026-09</dc:date>'
            '<dc:date>2010</dc:date><dc:date opf:event="publication">2007</dc:date>',
            "2007",
        ),
        (
            '<dc:date opf:event="creation">2026</dc:date>'
            '<dc:date opf:event="modification">2026-09</dc:date>',
            None,
        ),
        (
            '<dc:date opf:event="publication">2007</dc:date>'
            '<dc:date opf:event="publication">2008</dc:date><dc:date>2010</dc:date>',
            None,
        ),
        ("<dc:date>2007</dc:date><dc:date>2008</dc:date>", None),
    ],
)
def test_epub_publication_dates_respect_event_meaning_and_ambiguity(
    tmp_path: Path, dates: str, expected: str | None
) -> None:
    result = extract_epub_metadata(_epub_path(tmp_path, "", dates))
    assert isinstance(result, EpubExtractionResult), result
    assert result.edition_published_date == (
        present(expected) if expected is not None else absent()
    )


def test_pdf_export_timestamp_is_not_a_publication_date(db_session: Session) -> None:
    with fitz.open() as document:
        page = document.new_page()
        page.insert_text((72, 72), "Heart of Darkness by Joseph Conrad")
        document.set_metadata({"creationDate": "D:20260914000000Z"})
        payload = document.tobytes()
    media = Media(
        kind=MediaKind.pdf.value,
        title="heart-of-darkness.pdf",
        processing_status=ProcessingStatus.ready_for_reading,
    )
    db_session.add(media)
    db_session.flush()
    plan = build_pdf_extraction_plan(
        media_id=media.id,
        attempt_id=uuid4(),
        storage_path="sources/heart-of-darkness.pdf",
        source_size_bytes=len(payload),
        expected_source_sha256=hashlib.sha256(payload).hexdigest(),
        storage_client=ChunkedSourceStorage(payload),
        record_progress=lambda _completed, _total, _unit: None,
    )
    assert isinstance(plan, PdfExtractionPlan), plan
    assert "Joseph Conrad" in plan.result.plain_text
    persist_pdf_metadata(db_session, media, plan.result)
    db_session.flush()
    db_session.refresh(media)
    assert media.original_published_date is None
    assert media.edition_published_date is None


def test_invalid_generated_date_rejects_the_whole_proposal() -> None:
    assert (
        validate_structured_enrichment(
            {
                "title": "Heart of Darkness",
                "authors": ["Joseph Conrad"],
                "publisher": "Penguin",
                "description": None,
                "original_published_date": "1899",
                "edition_published_date": "2023-02-29",
                "language": "en",
            }
        )
        is None
    )
