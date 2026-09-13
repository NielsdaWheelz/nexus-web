"""Real ingest proof for repaired EPUB structural anchors and intervals."""

from __future__ import annotations

import hashlib
import io
import re
import zipfile
from uuid import uuid4

import pytest
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


def _semantic_structure_epub(*, final_entry_number: int) -> bytes:
    """Publisher order, heading rank and physical files deliberately disagree."""
    entries = {
        "META-INF/container.xml": """<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="book.opf"/></rootfiles></container>""",
        "book.opf": """<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Structure</dc:title></metadata>
<manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/>
<item id="two" href="two%2520.xhtml" media-type="application/xhtml+xml"/>
<item id="tail" href="tail.xhtml" media-type="application/xhtml+xml"/>
<item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
<item id="entries-a" href="entries-a.xhtml" media-type="application/xhtml+xml"/>
<item id="entries-b" href="entries-b.xhtml" media-type="application/xhtml+xml"/>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest>
<spine><itemref idref="one"/><itemref idref="two"/><itemref idref="tail"/>
<itemref idref="chapter"/><itemref idref="entries-a"/><itemref idref="entries-b"/>
</spine></package>""",
        "nav.xhtml": """<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body><nav epub:type="toc"><ol>
<li><a href="two%2520.xhtml#next">Next</a><ol>
<li><a href="chapter.xhtml#chapter">Chapter III</a></li></ol></li>
<li><a href="one.xhtml#part-link">Part</a><ol>
<li><a href="one.xhtml#one">One</a><ol>
<li><a href="one.xhtml#one-middle">One ending</a></li></ol></li>
<li><a href="one.xhtml#one">One alias</a></li>
<li><a href="two%2520.xhtml#closed">Closed</a><ol>
<li><a href="two%2520.xhtml#inside">Inside</a></li>
</ol></li></ol></li>
<li><a href="one.xhtml#preface">Preface</a></li>
<li><a href="entries-b.xhtml#not-an-entry">Interlude</a></li>
<li><a href="one.xhtml#part-sibling">Part boundary</a></li>
</ol></nav></body></html>""",
        "one.xhtml": """<html><body><p id="preface">Prelude.</p><a id="part-sibling"></a>
<h1 id="part"><a id="part-link"></a>Part</h1>
<h2 id="one">One <span hidden="hidden">excluded</span><a id="one-middle"></a>🐺</h2>
<p>First.</p></body></html>""",
        "two%20.xhtml": """<html><body><h2 id="second">Two</h2><p>Second.</p>
<section id="closed"><h3 id="inside">Inside</h3><p>Body.</p></section>
<p>Tail.</p><section><h1 id="next">Next</h1><p>Last.</p></section>
<p>After.</p></body></html>""",
        "tail.xhtml": "<html><body><p>Unsectioned.</p></body></html>",
        "chapter.xhtml": """<html><body><section aria-labelledby="chapter">
<h1 id="chapter">III</h1><h1 id="ambiguous">Title</h1><p>Body.</p>
<h2>Left</h2><p>A.</p><h2 id="ambiguous">Right</h2><p>B.</p>
</section><p>After chapter.</p></body></html>""",
        "entries-a.xhtml": """<html><body><h1>Notebook</h1>
<p id="n1">[1]* <em>Morning</em>. One.</p>
<p><a id="n2"></a>[2] <em>Night</em>. Two.</p></body></html>""",
        "entries-b.xhtml": f"""<html><body><p>Still two.</p>
<p><a id="n3"></a>[{final_entry_number}] ‘<em>Again</em>’. Three.</p>
<aside><p id="note">[4] <em>Note</em>.</p></aside>
<blockquote><p id="quote">[9] <em>Quotation</em>.</p></blockquote>
<p id="not-an-entry"><em>[8] Not an incipit</em>.</p>
<h2 id="afterword">Afterword</h2>
</body></html>""",
    }
    chapter_link = '<li><a href="chapter.xhtml#chapter">Chapter III</a></li>'
    grouped_link = chapter_link
    for depth in range(6):
        grouped_link = (
            f'<li><span id="{"group-" + "g" * 60}">Group {depth}</span><ol>{grouped_link}</ol></li>'
        )
    entries["nav.xhtml"] = entries["nav.xhtml"].replace(chapter_link, grouped_link)
    # Distinct physical resources share more than the old 255-character id budget.
    prefix = "segment/" * 32
    for path in ("one.xhtml", "two%20.xhtml"):
        entries[prefix + path] = entries.pop(path)
    for path in ("book.opf", "nav.xhtml"):
        entries[path] = entries[path].replace("one.xhtml", prefix + "one.xhtml")
        entries[path] = entries[path].replace("two%2520.xhtml", prefix + "two%2520.xhtml")
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        for path, content in entries.items():
            archive.writestr(path, re.sub(r">\s+<", "><", content))
    return output.getvalue()


@pytest.mark.parametrize("final_entry_number", [3, 5])
def test_epub_structure_preserves_semantic_sections_across_render_units(
    engine: Engine, final_entry_number: int
) -> None:
    """Source headings remain exact without making aliases or files extra content."""
    media_id = uuid4()
    payload = _semantic_structure_epub(final_entry_number=final_entry_number)
    storage_path = build_storage_path(media_id, "epub")
    storage = get_storage_client()
    storage.put_object(storage_path, payload, "application/epub+zip")
    try:
        plans: list[EpubExtractionPlan] = []
        for _ in range(2):
            plan = build_epub_extraction_plan(
                session_factory=create_session_factory(engine),
                media_id=media_id,
                attempt_id=uuid4(),
                storage_path=storage_path,
                source_size_bytes=len(payload),
                expected_source_sha256=hashlib.sha256(payload).hexdigest(),
                storage_client=storage,
                record_progress=lambda _completed, _total, _unit: None,
            )
            assert isinstance(plan, EpubExtractionPlan), plan
            plans.append(plan)
        plan, repeated = plans
        locations = plan.nav_locations
        assert len([location for location in locations if location.label == "Part"]) == 1, (
            "a leading publisher anchor inside a heading must identify that same heading"
        )
        assert [location.label for location in locations] == [
            "Preface",
            "Part boundary",
            "Part",
            "One",
            "One alias",
            "One ending",
            "Two",
            "Closed",
            "Inside",
            "Next",
            "Chapter III",
            "Title",
            "Left",
            "Right",
            "Notebook",
        ] + (["[1] Morning", "[2] Night", "[3] Again"] if final_entry_number == 3 else []) + [
            "Interlude",
            "Afterword",
        ], (
            "source structure was omitted, ambiguous numbering inferred, or a fake file chapter created"
        )
        fragments = [fragment for fragment, *_rest in plan.fragment_specs]
        assert [fragment.canonical_text for fragment in fragments] == [
            "Prelude.\nPart\nOne 🐺\nFirst.",
            "Two\nSecond.\nInside\nBody.\nTail.\nNext\nLast.\nAfter.",
            "Unsectioned.",
            "III\nTitle\nBody.\nLeft\nA.\nRight\nB.\nAfter chapter.",
            "Notebook\n[1]* Morning. One.\n[2] Night. Two.",
            f"Still two.\n[{final_entry_number}] ‘Again’. Three.\n[4] Note.\n[9] Quotation.\n[8] Not an incipit.\nAfterword",
        ]
        assert [(location.fragment_idx, location.start_offset) for location in locations] == [
            (0, 0),
            (0, 9),
            (0, 9),
            (0, 14),
            (0, 14),
            (0, 18),
            (1, 0),
            (1, 12),
            (1, 12),
            (1, 31),
            (3, 0),
            (3, 4),
            (3, 16),
            (3, 24),
            (4, 0),
        ] + ([(4, 9), (4, 28), (5, 11)] if final_entry_number == 3 else []) + [
            (5, 56),
            (5, 76),
        ]
        by_label = {location.label: location for location in locations}
        assert by_label["Part"].source == "Both"
        assert by_label["Part"].href_fragment.model_dump() == {
            "kind": "Present",
            "value": "part-link",
        }
        assert by_label["Part boundary"].source == "Publisher"
        assert by_label["Part boundary"].location_id != by_label["Part"].location_id
        assert by_label["One ending"].source == "Publisher"
        assert by_label["One ending"].start_offset == 18
        assert by_label["Part"].parent_section_id.model_dump() == {"kind": "Absent"}, (
            "an unrelated publisher anchor cannot parent source headings"
        )
        assert by_label["Preface"].end.model_dump() == {
            "kind": "Present",
            "value": {"fragment_idx": 0, "offset": 9},
        }
        assert by_label["Afterword"].parent_section_id.model_dump() == {"kind": "Absent"}, (
            "a publisher root boundary must retire the preceding heading context"
        )
        assert by_label["Interlude"].end.model_dump() == {
            "kind": "Present",
            "value": {"fragment_idx": 5, "offset": 76},
        }
        assert by_label["Notebook"].end.model_dump() == {
            "kind": "Present",
            "value": {"fragment_idx": 5, "offset": 56},
        }
        assert by_label["Afterword"].end.model_dump() == {
            "kind": "Present",
            "value": {"fragment_idx": 5, "offset": 85},
        }
        assert by_label["Chapter III"].location_id == "chapter.xhtml#chapter"
        assert by_label["One alias"].location_id != by_label["One"].location_id
        assert by_label["Two"].href_fragment.model_dump() == {
            "kind": "Present",
            "value": "second",
        }
        assert by_label["Title"].href_fragment.model_dump() == {"kind": "Absent"}
        assert by_label["Right"].href_fragment.model_dump() == {"kind": "Absent"}
        assert by_label["Part"].end.model_dump() == {
            "kind": "Present",
            "value": {"fragment_idx": 1, "offset": 31},
        }
        assert by_label["Two"].parent_section_id.model_dump() == {
            "kind": "Present",
            "value": by_label["Part"].location_id,
        }
        assert by_label["Closed"].parent_section_id.model_dump() == {
            "kind": "Present",
            "value": by_label["Part"].location_id,
        }
        assert by_label["Inside"].parent_section_id.model_dump() == {
            "kind": "Present",
            "value": by_label["Closed"].location_id,
        }
        assert by_label["Closed"].end.model_dump() == {
            "kind": "Present",
            "value": {"fragment_idx": 1, "offset": 25},
        }
        assert by_label["Inside"].end == by_label["Closed"].end
        assert by_label["Next"].end.model_dump() == {
            "kind": "Present",
            "value": {"fragment_idx": 1, "offset": 42},
        }
        assert [node.label for node in plan.toc_nodes if node.parent_node_id is None] == [
            "Next",
            "Part",
            "Preface",
            "Interlude",
            "Part boundary",
        ]
        toc_by_label = {node.label: node for node in plan.toc_nodes}
        toc_by_id = {node.node_id: node for node in plan.toc_nodes}
        assert len(toc_by_id) == len(plan.toc_nodes)
        assert all(1 <= len(node.node_id) <= 255 for node in plan.toc_nodes)
        one_path = ("segment/" * 32) + "one.xhtml"
        two_path = ("segment/" * 32) + "two%20.xhtml"
        assert one_path[:255] == two_path[:255] and one_path != two_path
        assert by_label["One"].href_path == by_label["One alias"].href_path == one_path
        assert by_label["Two"].href_path == two_path
        assert by_label["Next"].href_path == two_path
        assert 1 <= len(by_label["One"].location_id) <= 255
        assert 1 <= len(by_label["One alias"].location_id) <= 255
        assert 1 <= len(by_label["Next"].location_id) <= 255
        assert len({by_label[label].location_id for label in ("One", "One alias", "Next")}) == 3
        assert [node.node_id for node in repeated.toc_nodes] == [
            node.node_id for node in plan.toc_nodes
        ], "long source-target navigation ids must be stable across repeated extraction"
        assert [
            (location.source_node_id, location.location_id)
            for location in repeated.nav_locations
            if location.source in {"Publisher", "Both"}
        ] == [
            (location.source_node_id, location.location_id)
            for location in plan.nav_locations
            if location.source in {"Publisher", "Both"}
        ], "long source-target section ids must be stable across repeated extraction"
        parent_id = toc_by_label["Chapter III"].parent_node_id
        for depth in range(6):
            assert parent_id is not None
            parent = toc_by_id[parent_id]
            assert parent.label == f"Group {depth}"
            parent_id = parent.parent_node_id
        assert parent_id == toc_by_label["Next"].node_id
        assert by_label["Chapter III"].parent_section_id.model_dump() == {"kind": "Absent"}
        assert by_label["Chapter III"].end.model_dump() == {
            "kind": "Present",
            "value": {"fragment_idx": 3, "offset": 33},
        }
        assert by_label["Title"].parent_section_id.model_dump() == {
            "kind": "Present",
            "value": by_label["Chapter III"].location_id,
        }
        assert by_label["Left"].end.model_dump() == {
            "kind": "Present",
            "value": {"fragment_idx": 3, "offset": 24},
        }
        assert by_label["Right"].end == by_label["Chapter III"].end
        if final_entry_number == 3:
            assert by_label["[2] Night"].end.model_dump() == {
                "kind": "Present",
                "value": {"fragment_idx": 5, "offset": 11},
            }
            for label in ("[1] Morning", "[2] Night", "[3] Again"):
                assert by_label[label].source == "InferredNumberedEntry"
                assert by_label[label].parent_section_id.model_dump() == {
                    "kind": "Present",
                    "value": by_label["Notebook"].location_id,
                }
    finally:
        storage.delete_object(storage_path)


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
        plan = build_epub_extraction_plan(
            session_factory=create_session_factory(engine),
            media_id=media_id,
            attempt_id=uuid4(),
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
            toc = list(
                db.scalars(
                    select(EpubTocNode)
                    .where(EpubTocNode.media_id == media_id)
                    .order_by(EpubTocNode.order_key)
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
        assert [node.label for node in toc] == [
            "Later",
            "Chapter start",
            "Centered",
            "Early",
            "Page marker",
        ], f"EPUB {media_id} lost its authored TOC order: {toc!r}"
        assert [location.start_offset for location in locations] == sorted(
            location.start_offset for location in locations
        )
        assert by_label["Later"].start_offset > by_label["Early"].start_offset
        assert by_label["Early"].end_offset == by_label["Page marker"].start_offset
        assert by_label["Later"].end_offset == len(fragment.canonical_text)
        assert by_label["Chapter start"].start_offset == 0
        assert by_label["Centered"].start_offset == 0
    finally:
        storage.delete_object(storage_path)
