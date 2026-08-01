"""Real-stack proof for canonical EPUB document positions."""

from __future__ import annotations

import io
import zipfile
from uuid import uuid4

import pytest
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from nexus.db.models import Fragment, Media, MediaFile, MediaKind, ProcessingStatus
from nexus.db.session import create_session_factory
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.epub_ingest import (
    EpubExtractionPlan,
    build_epub_extraction_plan,
    publish_epub_extraction_plan,
)
from nexus.services.epub_read import get_epub_navigation_for_viewer
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.services.reader_document_map import get_reader_document_map
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_storage_path


def _authored_epub() -> bytes:
    """Build one tiny EPUB whose section starts are independently obvious."""
    container = """<?xml version="1.0"?>
    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
      <rootfiles>
        <rootfile full-path="OEBPS/content.opf"
                  media-type="application/oebps-package+xml"/>
      </rootfiles>
    </container>
    """
    package = """<?xml version="1.0" encoding="UTF-8"?>
    <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:identifier id="book-id">canonical-reader-position-proof</dc:identifier>
        <dc:title>Canonical Reader Positions</dc:title>
        <dc:language>en</dc:language>
      </metadata>
      <manifest>
        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine><itemref idref="chapter"/></spine>
    </package>
    """
    navigation = """<?xml version="1.0" encoding="UTF-8"?>
    <html xmlns="http://www.w3.org/1999/xhtml"
          xmlns:epub="http://www.idpf.org/2007/ops">
      <body><nav epub:type="toc"><ol>
        <li><a href="chapter.xhtml#opening">Opening</a></li>
        <li><a href="chapter.xhtml#second">Second</a></li>
      </ol></nav></body>
    </html>
    """
    chapter = """<?xml version="1.0" encoding="UTF-8"?>
    <html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="opening">Opening</h1><p>Café alpha.</p><h2 id="second">Second</h2><p>Omega.</p></body></html>
    """
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as epub:
        epub.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        epub.writestr("META-INF/container.xml", container)
        epub.writestr("OEBPS/content.opf", package)
        epub.writestr("OEBPS/nav.xhtml", navigation)
        epub.writestr("OEBPS/chapter.xhtml", chapter)
    return archive.getvalue()


def test_epub_navigation_and_document_map_share_exact_canonical_positions(
    engine: Engine,
) -> None:
    """Ingest, navigation, and overview markers must share one canonical coordinate system."""
    viewer_id = uuid4()
    media_id = uuid4()
    payload = _authored_epub()
    storage_path = build_storage_path(media_id, "epub")
    storage = get_storage_client()

    with Session(engine) as db:
        ensure_user_and_default_library(
            db,
            viewer_id,
            f"reader-position-{viewer_id}@example.invalid",
        )
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.epub.value,
                title="Canonical Reader Positions",
                processing_status=ProcessingStatus.extracting,
                created_by_user_id=viewer_id,
            )
        )
        db.flush()
        ensure_media_in_default_library(db, viewer_id, media_id)
        db.add(
            MediaFile(
                media_id=media_id,
                storage_path=storage_path,
                content_type="application/epub+zip",
                size_bytes=len(payload),
            )
        )
        db.commit()

    storage.put_object(storage_path, payload, "application/epub+zip")
    try:
        plan = build_epub_extraction_plan(
            session_factory=create_session_factory(engine),
            media_id=media_id,
            attempt_id=uuid4(),
            storage_path=storage_path,
            source_size_bytes=len(payload),
            storage_client=storage,
        )
        assert isinstance(plan, EpubExtractionPlan), (
            f"authored EPUB did not produce an extraction plan: {plan!r}"
        )

        with Session(engine) as db:
            publish_epub_extraction_plan(db, media_id=media_id, plan=plan)
            media = db.get(Media, media_id)
            assert media is not None
            media.processing_status = ProcessingStatus.ready_for_reading
            db.commit()

        expected_text = "Opening\nCafé alpha.\nSecond\nOmega."
        second_start = expected_text.index("Second")
        with Session(engine) as db:
            canonical_text = db.scalar(
                select(Fragment.canonical_text).where(Fragment.media_id == media_id)
            )
            navigation = get_epub_navigation_for_viewer(db, viewer_id, media_id)
            document_map = get_reader_document_map(
                db,
                viewer_id=viewer_id,
                media_id=media_id,
            )

        assert canonical_text == expected_text
        assert [fragment.char_count for fragment in navigation.fragments] == [len(expected_text)]
        assert [section.label for section in navigation.sections] == ["Opening", "Second"]
        assert [(section.start_offset, section.end_offset) for section in navigation.sections] == [
            (0, second_start),
            (second_start, len(expected_text)),
        ], "EPUB sections did not retain their canonical anchor intervals"

        contents_positions = {
            marker.label: marker.position
            for marker in document_map.markers
            if marker.kind == "Contents"
        }
        assert contents_positions == {
            "Opening": pytest.approx(0.0),
            "Second": pytest.approx(second_start / len(expected_text)),
        }, f"Document Map used non-canonical section positions: {contents_positions!r}"
    finally:
        storage.delete_object(storage_path)
