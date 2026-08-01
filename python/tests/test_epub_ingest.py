"""Integration tests for EPUB extraction artifacts.

All fixtures are built in-memory (no external network/process dependencies).
Covers both EPUB2 NCX and EPUB3 nav TOC variants.
"""

import io
import zipfile
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import (
    EpubTocNode,
    Fragment,
    FragmentBlock,
    Media,
)
from nexus.errors import ApiErrorCode
from nexus.services.epub_ingest import (
    EpubExtractionError,
    EpubExtractionResult,
    build_epub_extraction_plan,
    check_archive_safety,
    publish_epub_extraction_plan,
)
from nexus.storage.paths import build_storage_path
from nexus.tasks.storage_object_cleanup import finalize_storage_object_write
from tests.support.storage import FakeStorageClient

pytestmark = pytest.mark.integration

# ---------------------------------------------------------------------------
# EPUB fixture builders
# ---------------------------------------------------------------------------

_CONTAINER_XML = """\
<?xml version="1.0" encoding="UTF-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="{opf_path}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"""


def _build_opf(
    title: str = "Test Book",
    spine_items: list[tuple[str, str, str]] | None = None,
    nav_id: str | None = None,
    ncx_id: str | None = None,
    creators: list[str] | None = None,
) -> str:
    """Build an OPF package document.

    spine_items: [(manifest_id, href, media_type), ...]
    creators: dc:creator display names, one element per author.
    """
    if spine_items is None:
        spine_items = [("ch1", "chapter1.xhtml", "application/xhtml+xml")]

    manifest_lines = []
    for mid, href, mtype in spine_items:
        props = ' properties="nav"' if mid == nav_id else ""
        manifest_lines.append(f'    <item id="{mid}" href="{href}" media-type="{mtype}"{props}/>')
    if ncx_id:
        manifest_lines.append(
            f'    <item id="{ncx_id}" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
        )

    spine_refs = "\n".join(
        f'    <itemref idref="{mid}"/>'
        for mid, href, mtype in spine_items
        if mtype in ("application/xhtml+xml", "text/html")
    )
    toc_attr = f' toc="{ncx_id}"' if ncx_id else ""

    title_el = f"    <dc:title>{title}</dc:title>" if title else ""
    creator_els = "\n".join(f"    <dc:creator>{name}</dc:creator>" for name in (creators or []))
    metadata_lines = "\n".join(line for line in (title_el, creator_els) if line)

    return f"""\
<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf"
         xmlns:dc="http://purl.org/dc/elements/1.1/"
         version="3.0">
  <metadata>
{metadata_lines}
  </metadata>
  <manifest>
{chr(10).join(manifest_lines)}
  </manifest>
  <spine{toc_attr}>
{spine_refs}
  </spine>
</package>"""


def _build_chapter_xhtml(body_content: str) -> str:
    return f"""\
<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter</title></head>
<body>
{body_content}
</body>
</html>"""


def _build_epub3_nav(entries: list[tuple[str, str]]) -> str:
    """entries: [(label, href), ...]"""
    li_items = "\n".join(f'      <li><a href="{href}">{label}</a></li>' for label, href in entries)
    return f"""\
<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body>
  <nav epub:type="toc">
    <ol>
{li_items}
    </ol>
  </nav>
</body>
</html>"""


def _build_ncx(entries: list[tuple[str, str, str]]) -> str:
    """entries: [(nav_id, label, src), ...]"""
    points = []
    for i, (nid, label, src) in enumerate(entries):
        points.append(f"""\
    <navPoint id="{nid}" playOrder="{i + 1}">
      <navLabel><text>{label}</text></navLabel>
      <content src="{src}"/>
    </navPoint>""")
    return f"""\
<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
{chr(10).join(points)}
  </navMap>
</ncx>"""


def _make_epub(
    files: dict[str, str | bytes],
    opf_path: str = "OEBPS/content.opf",
) -> bytes:
    """Build an EPUB ZIP in memory."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("mimetype", "application/epub+zip")
        zf.writestr("META-INF/container.xml", _CONTAINER_XML.format(opf_path=opf_path))
        for path, content in files.items():
            if isinstance(content, str):
                zf.writestr(path, content)
            else:
                zf.writestr(path, content)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _create_media_with_epub(
    db: Session,
    storage: FakeStorageClient,
    epub_bytes: bytes,
    *,
    title: str = "test.epub",
    user_id: UUID | None = None,
) -> UUID:
    """Insert media + media_file rows and store bytes in fake storage."""
    media_id = uuid4()
    storage_path = build_storage_path(media_id, "epub")

    db.execute(
        text("""
            INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
            VALUES (:id, 'epub', :title, 'pending', :uid)
        """),
        {"id": media_id, "title": title, "uid": user_id},
    )
    db.execute(
        text("""
            INSERT INTO media_file (media_id, storage_path, content_type, size_bytes)
            VALUES (:mid, :sp, 'application/epub+zip', :sz)
        """),
        {"mid": media_id, "sp": storage_path, "sz": len(epub_bytes)},
    )
    db.flush()

    storage.put_object(storage_path, epub_bytes, "application/epub+zip")
    return media_id


def _extract_epub_artifacts(
    db: Session,
    media_id: UUID,
    storage: FakeStorageClient,
) -> EpubExtractionResult | EpubExtractionError:
    """Exercise the production prepare/publish split without a legacy service."""
    storage_path, size_bytes = db.execute(
        text(
            """
            SELECT storage_path, size_bytes
            FROM media_file
            WHERE media_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).one()
    db.commit()
    factory = sessionmaker(
        bind=db.get_bind(),
        autocommit=False,
        autoflush=False,
        expire_on_commit=False,
    )
    plan = build_epub_extraction_plan(
        session_factory=factory,
        media_id=media_id,
        attempt_id=uuid4(),
        storage_path=str(storage_path),
        source_size_bytes=int(size_bytes),
        storage_client=storage,
    )
    if isinstance(plan, EpubExtractionError):
        return plan
    result, _old_storage_paths = publish_epub_extraction_plan(
        db,
        media_id=media_id,
        plan=plan,
    )
    db.commit()
    for asset_storage_path in plan.asset_storage_paths.values():
        finalize_db = factory()
        try:
            finalize_storage_object_write(
                finalize_db,
                media_id=media_id,
                storage_path=asset_storage_path,
                storage_client=storage,
            )
        finally:
            finalize_db.close()
    return result


def _count_fragments(db: Session, media_id: UUID) -> int:
    return db.query(Fragment).filter_by(media_id=media_id).count()


def _count_fragment_blocks(db: Session, media_id: UUID) -> int:
    return (
        db.query(FragmentBlock)
        .join(Fragment, FragmentBlock.fragment_id == Fragment.id)
        .filter(Fragment.media_id == media_id)
        .count()
    )


def _count_toc_nodes(db: Session, media_id: UUID) -> int:
    return db.query(EpubTocNode).filter_by(media_id=media_id).count()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestEpubExtractMaterializesContiguousSpineFragmentsAndBlocks:
    """test_epub_extract_materializes_contiguous_spine_fragments_and_blocks"""

    def test_contiguous_fragments_and_blocks(self, db_session: Session):
        storage = FakeStorageClient()
        epub = _make_epub(
            {
                "OEBPS/content.opf": _build_opf(
                    spine_items=[
                        ("ch1", "chapter1.xhtml", "application/xhtml+xml"),
                        ("img1", "cover.png", "image/png"),
                        ("ch2", "chapter2.xhtml", "application/xhtml+xml"),
                        ("ch3", "chapter3.xhtml", "application/xhtml+xml"),
                    ],
                ),
                "OEBPS/chapter1.xhtml": _build_chapter_xhtml("<p>Chapter One content here.</p>"),
                "OEBPS/chapter2.xhtml": _build_chapter_xhtml("<p>Chapter Two content here.</p>"),
                "OEBPS/chapter3.xhtml": _build_chapter_xhtml("<p>Chapter Three content here.</p>"),
                "OEBPS/cover.png": b"\x89PNG\r\n\x1a\n" + b"\x00" * 100,
            },
        )
        mid = _create_media_with_epub(db_session, storage, epub)
        result = _extract_epub_artifacts(db_session, mid, storage)
        db_session.flush()

        assert isinstance(result, EpubExtractionResult)
        assert result.chapter_count == 3

        frags = db_session.execute(
            text(
                "SELECT idx, canonical_text, html_sanitized FROM fragments WHERE media_id = :mid ORDER BY idx"
            ),
            {"mid": mid},
        ).fetchall()

        assert len(frags) == 3
        for i, (idx, ct, hs) in enumerate(frags):
            assert idx == i, f"Expected contiguous idx {i}, got {idx}"
            assert ct.strip(), f"Fragment {i} has empty canonical_text"
            assert hs.strip(), f"Fragment {i} has empty html_sanitized"

        # fragment_blocks exist for each fragment
        block_count = db_session.execute(
            text("""
                SELECT COUNT(*) FROM fragment_blocks fb
                JOIN fragments f ON f.id = fb.fragment_id
                WHERE f.media_id = :mid
            """),
            {"mid": mid},
        ).scalar()
        assert block_count >= 3


class TestEpubExtractPersistsDeterministicTocSnapshot:
    """test_epub_extract_persists_deterministic_toc_snapshot"""

    def test_epub3_nav_deterministic(self, db_session: Session):
        storage = FakeStorageClient()
        nav_content = _build_epub3_nav(
            [
                ("Introduction", "chapter1.xhtml"),
                ("Main Body", "chapter2.xhtml"),
                ("Conclusion", "chapter1.xhtml"),
            ]
        )
        epub = _make_epub(
            {
                "OEBPS/content.opf": _build_opf(
                    spine_items=[
                        ("ch1", "chapter1.xhtml", "application/xhtml+xml"),
                        ("ch2", "chapter2.xhtml", "application/xhtml+xml"),
                        ("nav1", "nav.xhtml", "application/xhtml+xml"),
                    ],
                    nav_id="nav1",
                ),
                "OEBPS/chapter1.xhtml": _build_chapter_xhtml("<p>Chapter one.</p>"),
                "OEBPS/chapter2.xhtml": _build_chapter_xhtml("<p>Chapter two.</p>"),
                "OEBPS/nav.xhtml": nav_content,
            },
        )

        # Run extraction twice on separate media rows
        mid1 = _create_media_with_epub(db_session, storage, epub)
        result1 = _extract_epub_artifacts(db_session, mid1, storage)
        db_session.flush()

        mid2 = _create_media_with_epub(db_session, storage, epub)
        result2 = _extract_epub_artifacts(db_session, mid2, storage)
        db_session.flush()

        assert isinstance(result1, EpubExtractionResult)
        assert isinstance(result2, EpubExtractionResult)

        toc1 = db_session.execute(
            text(
                "SELECT node_id, order_key, fragment_idx, label FROM epub_toc_nodes WHERE media_id = :mid ORDER BY order_key"
            ),
            {"mid": mid1},
        ).fetchall()
        toc2 = db_session.execute(
            text(
                "SELECT node_id, order_key, fragment_idx, label FROM epub_toc_nodes WHERE media_id = :mid ORDER BY order_key"
            ),
            {"mid": mid2},
        ).fetchall()

        assert len(toc1) > 0
        assert len(toc1) == len(toc2)

        for r1, r2 in zip(toc1, toc2, strict=True):
            assert r1[0] == r2[0], "node_id not deterministic"
            assert r1[1] == r2[1], "order_key not deterministic"
            assert r1[2] == r2[2], "fragment_idx not deterministic"
            assert r1[3] == r2[3], "label not deterministic"

    def test_epub2_ncx_deterministic(self, db_session: Session):
        storage = FakeStorageClient()
        ncx = _build_ncx(
            [
                ("np1", "Foreword", "chapter1.xhtml"),
                ("np2", "Content", "chapter2.xhtml"),
            ]
        )
        epub = _make_epub(
            {
                "OEBPS/content.opf": _build_opf(
                    spine_items=[
                        ("ch1", "chapter1.xhtml", "application/xhtml+xml"),
                        ("ch2", "chapter2.xhtml", "application/xhtml+xml"),
                    ],
                    ncx_id="ncx",
                ),
                "OEBPS/chapter1.xhtml": _build_chapter_xhtml("<p>Foreword text.</p>"),
                "OEBPS/chapter2.xhtml": _build_chapter_xhtml("<p>Content text.</p>"),
                "OEBPS/toc.ncx": ncx,
            },
        )

        mid = _create_media_with_epub(db_session, storage, epub)
        result = _extract_epub_artifacts(db_session, mid, storage)
        db_session.flush()

        assert isinstance(result, EpubExtractionResult)
        toc = db_session.execute(
            text(
                "SELECT node_id, order_key, label FROM epub_toc_nodes WHERE media_id = :mid ORDER BY order_key"
            ),
            {"mid": mid},
        ).fetchall()
        assert len(toc) == 2
        assert toc[0][1] < toc[1][1]  # order_key ordering


class TestEpubExtractMissingTocIsNonFatal:
    """test_epub_extract_missing_toc_is_non_fatal"""

    def test_no_toc_still_succeeds(self, db_session: Session):
        storage = FakeStorageClient()
        epub = _make_epub(
            {
                "OEBPS/content.opf": _build_opf(
                    title="No TOC Book",
                    spine_items=[
                        ("ch1", "chapter1.xhtml", "application/xhtml+xml"),
                    ],
                ),
                "OEBPS/chapter1.xhtml": _build_chapter_xhtml("<p>Content without TOC.</p>"),
            },
        )
        mid = _create_media_with_epub(db_session, storage, epub)
        result = _extract_epub_artifacts(db_session, mid, storage)
        db_session.flush()

        assert isinstance(result, EpubExtractionResult)
        assert result.toc_node_count == 0
        assert result.chapter_count == 1

        toc_count = _count_toc_nodes(db_session, mid)
        assert toc_count == 0

        frag_count = _count_fragments(db_session, mid)
        assert frag_count == 1


class TestEpubExtractTitleResolution:
    """test_epub_extract_title_resolution"""

    def test_missing_title_uses_filename(self, db_session: Session):
        storage = FakeStorageClient()
        epub = _make_epub(
            {
                "OEBPS/content.opf": _build_opf(
                    title="",
                    spine_items=[("ch1", "chapter1.xhtml", "application/xhtml+xml")],
                ),
                "OEBPS/chapter1.xhtml": _build_chapter_xhtml("<p>Fallback test.</p>"),
            },
        )
        mid = _create_media_with_epub(db_session, storage, epub, title="my_great_book.epub")
        result = _extract_epub_artifacts(db_session, mid, storage)
        db_session.flush()

        assert isinstance(result, EpubExtractionResult)
        media = db_session.get(Media, mid)
        assert result.title == "Untitled EPUB"
        assert media.title == "my_great_book.epub"

    def test_no_title_no_usable_filename(self, db_session: Session):
        storage = FakeStorageClient()
        epub = _make_epub(
            {
                "OEBPS/content.opf": _build_opf(
                    title="",
                    spine_items=[("ch1", "chapter1.xhtml", "application/xhtml+xml")],
                ),
                "OEBPS/chapter1.xhtml": _build_chapter_xhtml("<p>Untitled test.</p>"),
            },
        )
        mid = _create_media_with_epub(db_session, storage, epub)
        result = _extract_epub_artifacts(db_session, mid, storage)
        db_session.flush()

        assert isinstance(result, EpubExtractionResult)
        media = db_session.get(Media, mid)
        assert result.title == "Untitled EPUB"
        assert media.title == "test.epub"

    def test_valid_dc_title_used(self, db_session: Session):
        storage = FakeStorageClient()
        epub = _make_epub(
            {
                "OEBPS/content.opf": _build_opf(
                    title="  My Great Book  ",
                    spine_items=[("ch1", "chapter1.xhtml", "application/xhtml+xml")],
                ),
                "OEBPS/chapter1.xhtml": _build_chapter_xhtml("<p>Title test.</p>"),
            },
        )
        mid = _create_media_with_epub(db_session, storage, epub)
        result = _extract_epub_artifacts(db_session, mid, storage)
        db_session.flush()

        assert isinstance(result, EpubExtractionResult)
        media = db_session.get(Media, mid)
        assert result.title == "My Great Book"
        assert media.title == "test.epub"


class TestEpubExtractRewritesResourcesAndDegradesUnresolvedAssets:
    """test_epub_extract_rewrites_resources_and_degrades_unresolved_assets"""

    def test_resource_rewriting(self, db_session: Session):
        storage = FakeStorageClient()
        img_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 50

        chapter_html = _build_chapter_xhtml(
            '<p>Internal: <img src="images/fig1.png" alt="fig1"/></p>'
            '<p>Responsive: <img srcset="images/fig2.png 1x, images/fig3.webp 2x" '
            'alt="responsive"/></p>'
            '<p>External: <img src="https://example.com/photo.jpg" alt="ext"/></p>'
            '<p>Unsupported: <img src="styles/book.css" alt="gone"/></p>'
            '<p>Link: <a href="chapter2.xhtml#sec1">Jump</a></p>'
            '<p onclick="alert(1)">Handler test</p>'
            '<p><a href="javascript:void(0)">JS link</a></p>'
            '<script>alert("xss")</script>'
            '<img src="x" onerror="alert(1)"/>'
        )

        epub = _make_epub(
            {
                "OEBPS/content.opf": _build_opf(
                    spine_items=[
                        ("ch1", "chapter1.xhtml", "application/xhtml+xml"),
                        ("ch2", "chapter2.xhtml", "application/xhtml+xml"),
                        ("img1", "images/fig1.png", "image/png"),
                        ("img2", "images/fig2.png", "image/png"),
                        ("img3", "images/fig3.webp", "image/webp"),
                        ("css1", "styles/book.css", "text/css"),
                    ],
                ),
                "OEBPS/chapter1.xhtml": chapter_html,
                "OEBPS/chapter2.xhtml": _build_chapter_xhtml("<p>Second chapter.</p>"),
                "OEBPS/images/fig1.png": img_bytes,
                "OEBPS/images/fig2.png": img_bytes,
                "OEBPS/images/fig3.webp": b"RIFF\x1a\x00\x00\x00WEBPVP8 " + b"\x00" * 32,
                "OEBPS/styles/book.css": "body { color: red; }",
            },
        )
        mid = _create_media_with_epub(db_session, storage, epub)
        result = _extract_epub_artifacts(db_session, mid, storage)
        db_session.flush()

        assert isinstance(result, EpubExtractionResult)
        # Only referenced image assets should be extracted/uploaded.
        # Chapter-to-chapter XHTML links must not be treated as binary assets.
        assert result.asset_count == 3

        frag = db_session.execute(
            text("SELECT html_sanitized FROM fragments WHERE media_id = :mid AND idx = 0"),
            {"mid": mid},
        ).fetchone()
        html = frag[0]

        # internal image rewritten to safe fetch path
        assert f"/api/media/{mid}/assets/" in html
        assert f"/api/media/{mid}/assets/OEBPS/images/fig2.png 1x" in html
        assert f"/api/media/{mid}/assets/OEBPS/images/fig3.webp 2x" in html
        # chapter xhtml links remain logical chapter links, not asset fetches
        assert f"/api/media/{mid}/assets/OEBPS/chapter2.xhtml" not in html
        # external images are not fetched by the reader pipeline
        assert "https://example.com/photo.jpg" not in html
        # unsupported local resources are stripped, not stored or rewritten
        assert "styles/book.css" not in html
        # active content stripped: script tags
        assert "<script" not in html
        assert "alert" not in html.lower()
        # inline event handlers stripped
        assert "onclick" not in html.lower()
        assert "onerror" not in html.lower()
        # javascript: protocol stripped from href
        assert "javascript:" not in html.lower()

    def test_epub_asset_storage_paths_are_attempt_scoped(self, db_session: Session):
        storage = FakeStorageClient()
        img_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
        epub = _make_epub(
            {
                "OEBPS/content.opf": _build_opf(
                    spine_items=[
                        ("ch1", "chapter1.xhtml", "application/xhtml+xml"),
                        ("img1", "images/fig1.png", "image/png"),
                    ],
                ),
                "OEBPS/chapter1.xhtml": _build_chapter_xhtml(
                    '<p><img src="images/fig1.png" alt="fig1"/></p>'
                ),
                "OEBPS/images/fig1.png": img_bytes,
            },
        )
        mid = _create_media_with_epub(db_session, storage, epub)

        result = _extract_epub_artifacts(db_session, mid, storage)
        db_session.flush()

        assert isinstance(result, EpubExtractionResult)
        stored_path = db_session.execute(
            text(
                """
                SELECT storage_path
                FROM epub_resources
                WHERE media_id = :media_id
                  AND asset_key = 'OEBPS/images/fig1.png'
                """
            ),
            {"media_id": mid},
        ).scalar_one()
        assert stored_path.startswith(f"media/{mid}/source/")
        assert stored_path.endswith("/assets/OEBPS/images/fig1.png")
        assert storage.get_object(stored_path) == img_bytes

    def test_unsupported_manifest_resources_are_not_stored(self, db_session: Session):
        storage = FakeStorageClient()
        img_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 50

        epub = _make_epub(
            {
                "OEBPS/content.opf": _build_opf(
                    spine_items=[
                        ("ch1", "chapter1.xhtml", "application/xhtml+xml"),
                        ("img1", "images/fig1.png", "image/png"),
                        ("css1", "styles/book.css", "text/css"),
                        ("font1", "fonts/book.woff2", "font/woff2"),
                        ("audio1", "audio/ch1.mp3", "audio/mpeg"),
                        ("video1", "video/clip.mp4", "video/mp4"),
                    ],
                ),
                "OEBPS/chapter1.xhtml": _build_chapter_xhtml(
                    '<img src="images/fig1.png" alt="fig1"/>'
                ),
                "OEBPS/images/fig1.png": img_bytes,
                "OEBPS/styles/book.css": "body { color: red; }",
                "OEBPS/fonts/book.woff2": b"font-bytes",
                "OEBPS/audio/ch1.mp3": b"audio-bytes",
                "OEBPS/video/clip.mp4": b"video-bytes",
            },
        )
        mid = _create_media_with_epub(db_session, storage, epub)
        result = _extract_epub_artifacts(db_session, mid, storage)
        db_session.flush()

        assert isinstance(result, EpubExtractionResult)
        assert result.asset_count == 1

        rows = db_session.execute(
            text("SELECT package_href, content_type FROM epub_resources WHERE media_id = :mid"),
            {"mid": mid},
        ).fetchall()
        assert rows == [("OEBPS/images/fig1.png", "image/png")]

    def test_missing_referenced_image_fails_ingest(self, db_session: Session):
        storage = FakeStorageClient()
        epub = _make_epub(
            {
                "OEBPS/content.opf": _build_opf(
                    spine_items=[
                        ("ch1", "chapter1.xhtml", "application/xhtml+xml"),
                        ("img1", "images/missing.png", "image/png"),
                    ],
                ),
                "OEBPS/chapter1.xhtml": _build_chapter_xhtml(
                    '<img src="images/missing.png" alt="missing"/>'
                ),
            },
        )
        mid = _create_media_with_epub(db_session, storage, epub)
        result = _extract_epub_artifacts(db_session, mid, storage)

        assert isinstance(result, EpubExtractionError)
        assert result.error_code == ApiErrorCode.E_INVALID_FILE_TYPE.value
        assert "Referenced EPUB image asset missing" in result.error_message

    def test_svg_asset_is_sanitized_before_storage(self, db_session: Session):
        storage = FakeStorageClient()
        svg = b"""<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
          <script>alert(1)</script>
          <foreignObject><body>html</body></foreignObject>
          <image href="https://example.com/pixel.png" />
          <rect width="10" height="10" fill="url(https://example.com/x)" />
        </svg>"""

        epub = _make_epub(
            {
                "OEBPS/content.opf": _build_opf(
                    spine_items=[
                        ("ch1", "chapter1.xhtml", "application/xhtml+xml"),
                        ("svg1", "images/unsafe.svg", "image/svg+xml"),
                    ],
                ),
                "OEBPS/chapter1.xhtml": _build_chapter_xhtml(
                    '<img src="images/unsafe.svg" alt="svg"/>'
                ),
                "OEBPS/images/unsafe.svg": svg,
            },
        )
        mid = _create_media_with_epub(db_session, storage, epub)
        result = _extract_epub_artifacts(db_session, mid, storage)
        db_session.flush()

        assert isinstance(result, EpubExtractionResult)
        stored_path = db_session.execute(
            text(
                """
                SELECT storage_path
                FROM epub_resources
                WHERE media_id = :media_id
                  AND asset_key = 'OEBPS/images/unsafe.svg'
                """
            ),
            {"media_id": mid},
        ).scalar_one()
        stored = storage.get_object(stored_path)
        assert stored is not None
        stored_text = stored.decode("utf-8").lower()
        assert "<script" not in stored_text
        assert "foreignobject" not in stored_text
        assert "onload" not in stored_text
        assert "https://example.com" not in stored_text


class TestEpubExtractTocMappingIncludesImageOnlySpineItems:
    """TOC href->fragment mapping includes textless renderable spine items."""

    def test_toc_mapping_preserves_image_only_spine_item(self, db_session: Session):
        storage = FakeStorageClient()
        cover_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 20

        # chapter0.xhtml is readable XHTML but canonicalizes to empty text.
        # It still becomes a fragment so image-only sections remain reachable.
        epub = _make_epub(
            {
                "OEBPS/content.opf": _build_opf(
                    spine_items=[
                        ("ch0", "chapter0.xhtml", "application/xhtml+xml"),
                        ("ch1", "chapter1.xhtml", "application/xhtml+xml"),
                        ("ch2", "chapter2.xhtml", "application/xhtml+xml"),
                        ("cover", "cover.png", "image/png"),
                    ],
                    ncx_id="ncx",
                ),
                "OEBPS/chapter0.xhtml": _build_chapter_xhtml('<img src="cover.png" alt="cover"/>'),
                "OEBPS/chapter1.xhtml": _build_chapter_xhtml("<p>First readable chapter.</p>"),
                "OEBPS/chapter2.xhtml": _build_chapter_xhtml("<p>Second readable chapter.</p>"),
                "OEBPS/cover.png": cover_bytes,
                "OEBPS/toc.ncx": _build_ncx(
                    [
                        ("np1", "Chapter One", "chapter1.xhtml"),
                        ("np2", "Chapter Two", "chapter2.xhtml"),
                    ]
                ),
            }
        )

        mid = _create_media_with_epub(db_session, storage, epub)
        result = _extract_epub_artifacts(db_session, mid, storage)
        db_session.flush()

        assert isinstance(result, EpubExtractionResult)
        assert result.chapter_count == 3

        toc_rows = db_session.execute(
            text(
                "SELECT label, fragment_idx FROM epub_toc_nodes "
                "WHERE media_id = :mid ORDER BY order_key"
            ),
            {"mid": mid},
        ).fetchall()

        assert len(toc_rows) == 2
        assert toc_rows[0][0] == "Chapter One"
        assert toc_rows[0][1] == 1
        assert toc_rows[1][0] == "Chapter Two"
        assert toc_rows[1][1] == 2


class TestEpubExtractPreservesAnchorTargetsForInFragmentNavigation:
    """EPUB sanitization must retain in-fragment anchor targets."""

    def test_anchor_id_and_name_survive_sanitization(self, db_session: Session):
        storage = FakeStorageClient()

        chapter_html = _build_chapter_xhtml(
            '<h2 id="sec-a">Section A</h2><a name="named-anchor"></a><p>Body text.</p>'
        )
        epub = _make_epub(
            {
                "OEBPS/content.opf": _build_opf(
                    spine_items=[("ch1", "chapter1.xhtml", "application/xhtml+xml")],
                    ncx_id="ncx",
                ),
                "OEBPS/chapter1.xhtml": chapter_html,
                "OEBPS/toc.ncx": _build_ncx(
                    [
                        ("np1", "Section A", "chapter1.xhtml#sec-a"),
                        ("np2", "Named anchor", "chapter1.xhtml#named-anchor"),
                    ]
                ),
            }
        )

        mid = _create_media_with_epub(db_session, storage, epub)
        result = _extract_epub_artifacts(db_session, mid, storage)
        db_session.flush()

        assert isinstance(result, EpubExtractionResult)
        assert result.chapter_count == 1

        html = db_session.execute(
            text("SELECT html_sanitized FROM fragments WHERE media_id = :mid AND idx = 0"),
            {"mid": mid},
        ).scalar_one()

        # These anchors are required for TOC items that target positions inside
        # the currently loaded fragment.
        assert 'id="sec-a"' in html
        assert 'name="named-anchor"' in html

    def test_missing_named_navigation_anchor_rejects_the_source(self, db_session: Session):
        storage = FakeStorageClient()
        epub = _make_epub(
            {
                "OEBPS/content.opf": _build_opf(
                    spine_items=[("ch1", "chapter1.xhtml", "application/xhtml+xml")],
                    ncx_id="ncx",
                ),
                "OEBPS/chapter1.xhtml": _build_chapter_xhtml(
                    '<h2 id="present">Readable body.</h2>'
                ),
                "OEBPS/toc.ncx": """\
<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="outer" playOrder="1">
      <navLabel><text>Present target</text></navLabel>
      <content src="chapter1.xhtml#present"/>
      <navPoint id="nested" playOrder="2">
        <navLabel><text>Missing nested target</text></navLabel>
        <content src="chapter1.xhtml#does-not-exist"/>
      </navPoint>
    </navPoint>
  </navMap>
</ncx>""",
            }
        )

        mid = _create_media_with_epub(db_session, storage, epub)
        result = _extract_epub_artifacts(db_session, mid, storage)

        assert isinstance(result, EpubExtractionError)
        assert result.error_code == ApiErrorCode.E_SOURCE_NOT_READABLE.value
        assert result.error_message == (
            "EPUB navigation target OEBPS/chapter1.xhtml#does-not-exist names a missing anchor"
        )


class TestEpubExtractRejectsUnsafeArchiveWithTerminalCode:
    """test_epub_extract_rejects_unsafe_archive_with_terminal_code"""

    def test_path_traversal_rejected(self, db_session: Session):
        storage = FakeStorageClient()
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("mimetype", "application/epub+zip")
            zf.writestr("META-INF/container.xml", _CONTAINER_XML.format(opf_path="content.opf"))
            zf.writestr("../../../etc/passwd", "root:x:0:0")
            zf.writestr(
                "content.opf",
                _build_opf(spine_items=[("ch1", "ch.xhtml", "application/xhtml+xml")]),
            )
            zf.writestr("ch.xhtml", _build_chapter_xhtml("<p>test</p>"))
        epub_bytes = buf.getvalue()

        mid = _create_media_with_epub(db_session, storage, epub_bytes)
        result = _extract_epub_artifacts(db_session, mid, storage)

        assert isinstance(result, EpubExtractionError)
        assert result.error_code == ApiErrorCode.E_ARCHIVE_UNSAFE.value
        assert result.terminal is True
        assert _count_fragments(db_session, mid) == 0
        assert _count_toc_nodes(db_session, mid) == 0

    def test_oversized_entry_rejected(self, db_session: Session):
        storage = FakeStorageClient()
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
            zf.writestr("mimetype", "application/epub+zip")
            zf.writestr("META-INF/container.xml", _CONTAINER_XML.format(opf_path="content.opf"))
            zf.writestr(
                "content.opf",
                _build_opf(spine_items=[("ch1", "ch.xhtml", "application/xhtml+xml")]),
            )
            # Create entry that exceeds single-entry limit (>64MB)
            big_content = b"x" * (67_108_864 + 1)
            zf.writestr("ch.xhtml", big_content)
        epub_bytes = buf.getvalue()

        mid = _create_media_with_epub(db_session, storage, epub_bytes)
        result = _extract_epub_artifacts(db_session, mid, storage)

        assert isinstance(result, EpubExtractionError)
        assert result.error_code == ApiErrorCode.E_ARCHIVE_UNSAFE.value
        assert _count_fragments(db_session, mid) == 0

    def test_unexpected_archive_reader_error_is_not_classified_as_unsafe(self, monkeypatch):
        def fail_unexpectedly(_stream):
            raise RuntimeError("zip runtime defect")

        monkeypatch.setattr("nexus.services.epub_ingest.zipfile.ZipFile", fail_unexpectedly)

        with pytest.raises(RuntimeError, match="zip runtime defect"):
            check_archive_safety(b"irrelevant")


class TestEpubExtractFailureClassificationMatrix:
    """test_epub_extract_failure_classification_matrix"""

    def test_sanitization_failure(self, db_session: Session):
        storage = FakeStorageClient()
        epub = _make_epub(
            {
                "OEBPS/content.opf": _build_opf(
                    spine_items=[("ch1", "chapter1.xhtml", "application/xhtml+xml")],
                ),
                "OEBPS/chapter1.xhtml": _build_chapter_xhtml("<!-- comment-only chapter -->"),
            },
        )
        mid = _create_media_with_epub(db_session, storage, epub)

        result = _extract_epub_artifacts(db_session, mid, storage)

        assert isinstance(result, EpubExtractionError)
        assert result.error_code == ApiErrorCode.E_SANITIZATION_FAILED.value
        assert db_session.get(Media, mid).title == "test.epub"

    def test_structural_parse_failure(self, db_session: Session):
        storage = FakeStorageClient()
        # EPUB with no valid OPF
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("mimetype", "application/epub+zip")
            zf.writestr("META-INF/container.xml", _CONTAINER_XML.format(opf_path="bad.opf"))
            zf.writestr("bad.opf", "this is not xml at all {{{")
        epub_bytes = buf.getvalue()

        mid = _create_media_with_epub(db_session, storage, epub_bytes)
        result = _extract_epub_artifacts(db_session, mid, storage)

        assert isinstance(result, EpubExtractionError)
        assert result.error_code == ApiErrorCode.E_INVALID_FILE_TYPE.value


class TestEpubExtractCommitsArtifactsAtomically:
    """test_epub_extract_commits_artifacts_atomically"""

    def test_no_partial_artifacts_on_failure(self, db_session: Session):
        storage = FakeStorageClient()
        epub = _make_epub(
            {
                "OEBPS/content.opf": _build_opf(
                    spine_items=[
                        ("ch1", "chapter1.xhtml", "application/xhtml+xml"),
                        ("img1", "images/missing.png", "image/png"),
                    ],
                ),
                "OEBPS/chapter1.xhtml": _build_chapter_xhtml(
                    '<img src="images/missing.png" alt="missing"/>'
                ),
            },
        )
        mid = _create_media_with_epub(db_session, storage, epub)

        result = _extract_epub_artifacts(db_session, mid, storage)

        assert isinstance(result, EpubExtractionError)
        assert "Referenced EPUB image asset missing" in result.error_message

        # After rollback, no partial artifacts should exist — including
        # fragments that were successfully flushed before the failure point.
        assert _count_fragments(db_session, mid) == 0
        assert _count_fragment_blocks(db_session, mid) == 0
        assert _count_toc_nodes(db_session, mid) == 0


class TestBuildEpubAuthorObservation:
    """`build_epub_author_observation` — the EPUB `author` observation.

    Each OPF `dc:creator` is one credited name; only semicolons split a single
    creator string, so `Last, First` stays one name (D-31). Asserts observation
    shape, not DB effect.
    """

    @staticmethod
    def _observe(creators: list[str]):
        from nexus.services.epub_metadata import build_epub_author_observation

        return build_epub_author_observation(EpubExtractionResult(creators=creators))

    def test_each_creator_is_one_name_comma_preserved(self):
        from nexus.services.contributor_taxonomy import ObservedRoleSlices

        batch, truncated = self._observe(["Herman Melville", "Melville, Herman"])
        assert isinstance(batch, ObservedRoleSlices)
        assert batch.managed_roles == frozenset({"author"})
        assert [c.credited_name for c in batch.credits] == ["Herman Melville", "Melville, Herman"]
        assert truncated == {}

    def test_semicolon_inside_a_creator_splits(self):
        from nexus.services.contributor_taxonomy import ObservedRoleSlices

        batch, _ = self._observe(["Alice; Bob", "Carol"])
        assert isinstance(batch, ObservedRoleSlices)
        assert [c.credited_name for c in batch.credits] == ["Alice", "Bob", "Carol"]

    def test_no_creators_is_not_observed(self):
        from nexus.services.contributor_taxonomy import NotObserved

        for creators in ([], ["", "   "]):
            batch, truncated = self._observe(creators)
            assert isinstance(batch, NotObserved)
            assert truncated == {}
