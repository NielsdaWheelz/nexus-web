"""Real ingest proof for repaired EPUB structural anchors and intervals."""

from __future__ import annotations

import hashlib
import io
import zipfile
from uuid import uuid4

from lxml import html
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from nexus.db.models import (
    EpubNavLocation,
    EpubTocNode,
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
    _materialize_toc,
    _parse_manifest,
    _parse_xml_entry,
    _XmlStructuralBudget,
    build_epub_extraction_plan,
    publish_epub_extraction_plan,
)
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.services.parser_temp import parser_attempt_directory
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_storage_path
from tests.testkit.epub_fixtures import zip_payload


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
    <p id="not-visible" hidden="hidden">Must stay hidden.</p>
    <p aria-hidden="true">Must stay inaccessible.</p>
    <section aria-labelledby="early"><p id="early">Early.</p></section>
    <pagebreak id="page-target"></pagebreak>
    <p id="late">Later.</p>
    <p>Tail.</p>
    <svg xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="local-paint"><stop offset="0" stop-color="red"/></linearGradient></defs>
      <rect id="paint" width="10" height="10" fill="\\75rl(https://outside.example/paint.svg)"
            stroke="u\\72l(&quot;#local-paint&quot;)"/>
    </svg>
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
                source_sha256=hashlib.sha256(payload).hexdigest(),
            )
        )
        db.commit()

    storage.put_object(storage_path, payload, "application/epub+zip")
    try:
        attempt_id = uuid4()
        with parser_attempt_directory(attempt_id) as attempt_directory:
            plan = build_epub_extraction_plan(
                attempt_directory=attempt_directory,
                session_factory=create_session_factory(engine),
                media_id=media_id,
                attempt_id=attempt_id,
                storage_path=storage_path,
                source_size_bytes=len(payload),
                expected_source_sha256=hashlib.sha256(payload).hexdigest(),
                storage_client=storage,
                record_progress=lambda _completed, _total, _unit: None,
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
            assert "Must stay hidden." not in fragment.canonical_text
            assert "Must stay inaccessible." not in fragment.canonical_text
            assert 'aria-labelledby="early"' in fragment.html_sanitized
            assert "<center" not in fragment.html_sanitized
            assert "<pagebreak" not in fragment.html_sanitized
            assert "onclick" not in fragment.html_sanitized
            assert "color:red" not in fragment.html_sanitized
            assert 'class="layout"' not in fragment.html_sanitized
            paint = html.fragment_fromstring(
                fragment.html_sanitized, create_parent=True
            ).get_element_by_id("paint")
            assert paint.get("fill") is None, "escaped CSS must not load an undeclared resource"
            assert "#local-paint" in paint.get("stroke", ""), "local SVG paint must remain readable"

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


def test_epub_long_navigation_ids_preserve_distinct_targets_and_parentage(engine: Engine) -> None:
    """Long shared prefixes and repeated aliases keep exact source identities."""
    first_path = "segment/" * 32 + "one.xhtml"
    second_path = "segment/" * 32 + "two.xhtml"
    assert first_path[:255] == second_path[:255]
    nested = f'<li><a href="{second_path}#first">Other</a></li>'
    for depth in range(7):
        nested = f'<li><span id="group-{"g" * 60}">Group {depth}</span><ol>{nested}</ol></li>'
    chapter = (
        '<html><body><p id="first">First.</p>'
        '<p hidden="hidden">Hidden.</p><p aria-hidden="true">Also hidden.</p>'
        '<p id="second">Second.</p></body></html>'
    )
    payload = zip_payload(
        {
            "mimetype": b"application/epub+zip",
            "META-INF/container.xml": (
                '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
                '<rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'
            ).encode(),
            "book.opf": (
                '<package xmlns="http://www.idpf.org/2007/opf" version="3.0">'
                '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
                "<dc:title>Long navigation</dc:title></metadata><manifest>"
                f'<item id="one" href="{first_path}" media-type="application/xhtml+xml"/>'
                f'<item id="two" href="{second_path}" media-type="application/xhtml+xml"/>'
                '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
                '</manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>'
            ).encode(),
            "nav.xhtml": (
                '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
                '<body><nav epub:type="toc"><ol>'
                f'<li><a href="{first_path}#first">First</a></li>'
                f'<li><a href="{first_path}#second">Second</a></li>'
                f'<li><a href="{first_path}#first">Again</a></li>'
                f"{nested}</ol></nav></body></html>"
            ).encode(),
            first_path: chapter.encode(),
            second_path: chapter.encode(),
        }
    )
    # Read the real archive's navigation before section allocation. Duplicate
    # persisted node identities are a source defect even if allocation then hangs.
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        structural_budget = _XmlStructuralBudget()
        opf = _parse_xml_entry(archive, "book.opf", structural_budget, decoded_bytes_limit=None)
        assert opf is not None
        source_nodes = _materialize_toc(
            archive,
            opf,
            _parse_manifest(opf, ""),
            {first_path: 0, second_path: 1},
            structural_budget,
        )
    assert len(source_nodes) == 11
    assert len({node.node_id for node in source_nodes}) == 11, (
        "EPUB navigation aliases distinct source nodes before section allocation"
    )
    viewer_id, media_id = uuid4(), uuid4()
    storage_path = build_storage_path(media_id, "epub")
    storage = get_storage_client()
    with Session(engine) as db:
        ensure_user_and_default_library(
            db, viewer_id, f"long-navigation-{viewer_id}@example.invalid"
        )
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.epub.value,
                title="Long navigation",
                processing_status=ProcessingStatus.extracting,
                created_by_user_id=viewer_id,
            )
        )
        db.commit()
    storage.put_object(storage_path, payload, "application/epub+zip")
    previous_ids: tuple[tuple[str, ...], tuple[str, ...]] | None = None
    try:
        for _ in range(2):
            attempt_id = uuid4()
            with parser_attempt_directory(attempt_id) as attempt_directory:
                plan = build_epub_extraction_plan(
                    attempt_directory=attempt_directory,
                    session_factory=create_session_factory(engine),
                    media_id=media_id,
                    attempt_id=attempt_id,
                    storage_path=storage_path,
                    source_size_bytes=len(payload),
                    expected_source_sha256=hashlib.sha256(payload).hexdigest(),
                    storage_client=storage,
                    record_progress=lambda _completed, _total, _unit: None,
                )
                assert isinstance(plan, EpubExtractionPlan), plan
                ids = (
                    tuple(node.node_id for node in plan.toc_nodes),
                    tuple(location.location_id for location in plan.nav_locations),
                )
                assert len(set(ids[0])) == 11 and len(set(ids[1])) == 4
                assert all(0 < len(value) <= 255 for values in ids for value in values)
                if previous_ids is not None:
                    assert ids == previous_ids, (
                        "navigation identities changed on repeated extraction"
                    )
                previous_ids = ids
                with Session(engine) as db:
                    publish_epub_extraction_plan(db, media_id=media_id, plan=plan)
                    db.commit()
            assert not attempt_directory.exists()
        with Session(engine) as db:
            locations = list(
                db.scalars(
                    select(EpubNavLocation)
                    .where(EpubNavLocation.media_id == media_id)
                    .order_by(EpubNavLocation.ordinal)
                )
            )
            nodes = list(db.scalars(select(EpubTocNode).where(EpubTocNode.media_id == media_id)))
            fragments = list(
                db.scalars(
                    select(Fragment).where(Fragment.media_id == media_id).order_by(Fragment.idx)
                )
            )
        assert [fragment.canonical_text for fragment in fragments] == ["First.\nSecond."] * 2
        assert [
            (location.label, location.href_path, location.href_fragment, location.start_offset)
            for location in locations
        ] == [
            ("First", first_path, "first", 0),
            ("Second", first_path, "second", 7),
            ("Again", first_path, "first", 0),
            ("Other", second_path, "first", 0),
        ]
        by_id = {node.node_id: node for node in nodes}
        parent_id = next(node.parent_node_id for node in nodes if node.label == "Other")
        for depth in range(7):
            assert parent_id is not None
            parent = by_id[parent_id]
            assert parent.label == f"Group {depth}"
            parent_id = parent.parent_node_id
        assert parent_id is None
    finally:
        storage.delete_object(storage_path)
