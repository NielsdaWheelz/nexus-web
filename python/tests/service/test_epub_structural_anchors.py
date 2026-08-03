"""Real ingest proof for repaired EPUB structural anchors and intervals."""

from __future__ import annotations

import io
import zipfile
from uuid import uuid4

from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from nexus.db.models import (
    EpubNavLocation,
    Fragment,
    Media,
    MediaFile,
    MediaKind,
    ProcessingStatus,
)
from nexus.db.session import create_session_factory
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.epub_ingest import (
    EpubExtractionPlan,
    build_epub_extraction_plan,
    publish_epub_extraction_plan,
)
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_storage_path


def _structural_anchor_epub() -> bytes:
    """Build the smallest source that crosses body and unsupported anchor repair."""
    entries = {
        "META-INF/container.xml": """\
<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
""",
        "EPUB/package.opf": """\
<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" unique-identifier="book-id"
         xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">structural-anchor-proof</dc:identifier>
    <dc:title>Structural Anchor Proof</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine><itemref id="chapter-ref" idref="chapter"/></spine>
</package>
""",
        "EPUB/nav.xhtml": """\
<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"
      xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Contents</title></head>
  <body>
    <nav epub:type="toc"><ol>
      <li><a href="chapter.xhtml#late">Later</a></li>
      <li><a href="chapter.xhtml#chapter-start">Chapter start</a></li>
      <li><a href="chapter.xhtml#center-target">Centered</a></li>
      <li><a href="chapter.xhtml#early">Early</a></li>
      <li><a href="chapter.xhtml#page-target">Page marker</a></li>
    </ol></nav>
  </body>
</html>
""",
        "EPUB/chapter.xhtml": """\
<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Chapter</title></head>
  <body id="chapter-start">
    <center id="center-target" class="layout" style="color:red"
            onclick="alert(1)">Centered target.</center>
    <p id="early">Early.</p>
    <pagebreak id="page-target"></pagebreak>
    <p id="late">Later.</p>
    <p>Tail.</p>
  </body>
</html>
""",
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "mimetype",
            "application/epub+zip",
            compress_type=zipfile.ZIP_STORED,
        )
        for path, content in entries.items():
            archive.writestr(path, content)
    return output.getvalue()


def test_epub_ingest_repairs_structural_anchors_without_reordering_intervals(
    engine: Engine,
) -> None:
    """Sanitized anchors remain navigable while intervals follow document order."""
    viewer_id = uuid4()
    media_id = uuid4()
    payload = _structural_anchor_epub()
    storage_path = build_storage_path(media_id, "epub")
    storage = get_storage_client()

    with Session(engine) as db:
        ensure_user_and_default_library(
            db,
            viewer_id,
            f"structural-anchor-{viewer_id}@example.invalid",
        )
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.epub.value,
                title="Structural Anchor Proof",
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
            f"structural-anchor EPUB did not produce an extraction plan: {plan!r}"
        )

        with Session(engine) as db:
            publish_epub_extraction_plan(db, media_id=media_id, plan=plan)
            media = db.get(Media, media_id)
            assert media is not None
            media.processing_status = ProcessingStatus.ready_for_reading
            db.commit()

        with Session(engine) as db:
            fragment = db.scalar(select(Fragment).where(Fragment.media_id == media_id))
            locations = list(
                db.scalars(
                    select(EpubNavLocation)
                    .where(EpubNavLocation.media_id == media_id)
                    .order_by(EpubNavLocation.ordinal)
                )
            )

        assert fragment is not None, f"EPUB {media_id} did not persist its reader fragment"
        assert '<span id="chapter-start"></span>' in fragment.html_sanitized
        assert '<span id="center-target">Centered target.</span>' in fragment.html_sanitized
        assert '<span id="page-target"></span>' in fragment.html_sanitized
        assert "<center" not in fragment.html_sanitized
        assert "<pagebreak" not in fragment.html_sanitized
        assert "onclick" not in fragment.html_sanitized
        assert "color:red" not in fragment.html_sanitized
        assert 'class="layout"' not in fragment.html_sanitized

        by_label = {location.label: location for location in locations}
        assert [location.label for location in locations] == [
            "Later",
            "Chapter start",
            "Centered",
            "Early",
            "Page marker",
        ], f"EPUB {media_id} lost its authored TOC order: {locations!r}"
        assert by_label["Later"].start_offset > by_label["Early"].start_offset
        assert by_label["Early"].end_offset == by_label["Page marker"].start_offset
        assert by_label["Later"].end_offset == len(fragment.canonical_text)
        assert by_label["Chapter start"].start_offset == 0
        assert by_label["Centered"].start_offset == 0
    finally:
        storage.delete_object(storage_path)
