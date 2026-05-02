"""Real EPUB fixture smoke tests (S5 PR-07).

Exercises ``run_epub_ingest_sync`` over checked-in real EPUB files with no
parser or service internals mocked.  Complements synthetic in-memory builders
in ``test_epub_ingest.py`` with parser-fidelity coverage on complete archives.
"""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import Media
from nexus.services.epub_ingest import EpubExtractionResult
from nexus.storage.client import FakeStorageClient
from nexus.tasks.ingest_epub import run_epub_ingest_sync

pytestmark = pytest.mark.integration

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "epub"

# ---------------------------------------------------------------------------
# Fixture corpus metadata
# ---------------------------------------------------------------------------

CORPUS: list[dict] = [
    # ── Real books (Project Gutenberg, public domain) ──────────────────
    {
        "file": "confessions-epub3.epub",
        "expected": "success",
        "tags": ["epub3", "nav", "toc", "css", "cover"],
        "min_chapters": 5,
        "has_toc": True,
        "has_assets": True,
    },
    {
        "file": "confessions-old.epub",
        "expected": "success",
        "tags": ["epub2", "ncx", "toc", "css", "cover"],
        "min_chapters": 5,
        "has_toc": True,
        "has_assets": True,
    },
    {
        "file": "zarathustra-epub3.epub",
        "expected": "success",
        "tags": ["epub3", "nav", "toc", "css", "cover", "many-chapters"],
        "min_chapters": 10,
        "has_toc": True,
        "has_assets": True,
    },
    {
        "file": "zarathustra-old.epub",
        "expected": "success",
        "tags": ["epub2", "ncx", "toc", "css", "cover", "many-chapters"],
        "min_chapters": 10,
        "has_toc": True,
        "has_assets": True,
    },
    {
        "file": "moby-dick-epub3.epub",
        "expected": "success",
        "tags": ["epub3", "nav", "toc", "css", "cover", "large"],
        "min_chapters": 10,
        "has_toc": True,
        "has_assets": True,
    },
    {
        "file": "moby-dick-old.epub",
        "expected": "success",
        "tags": ["epub2", "ncx", "toc", "css", "cover", "large"],
        "min_chapters": 10,
        "has_toc": True,
        "has_assets": True,
    },
    {
        "file": "city-of-god-epub3.epub",
        "expected": "success",
        "tags": ["epub3", "nav", "toc", "css", "cover", "large"],
        "min_chapters": 8,
        "has_toc": True,
        "has_assets": True,
    },
    {
        "file": "city-of-god-old.epub",
        "expected": "success",
        "tags": ["epub2", "ncx", "toc", "css", "cover", "large"],
        "min_chapters": 8,
        "has_toc": True,
        "has_assets": True,
    },
    # ── Synthetic edge-case fixtures ───────────────────────────────────
    {
        "file": "epub3_assets.epub",
        "expected": "failed",
        "error_contains": "Referenced EPUB image asset missing",
        "tags": ["epub3", "assets", "sanitization"],
        "min_chapters": 1,
        "has_toc": True,
        "has_assets": True,
    },
    {
        "file": "epub3_unicode.epub",
        "expected": "success",
        "tags": ["epub3", "unicode"],
        "min_chapters": 1,
        "has_toc": True,
        "has_assets": False,
    },
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _create_media_with_epub(
    db: Session,
    storage: FakeStorageClient,
    epub_bytes: bytes,
    *,
    title: str = "fixture.epub",
):
    media_id = uuid4()
    storage_path = f"media/{media_id}/original.epub"

    db.execute(
        text("""
            INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
            VALUES (:id, 'epub', :title, 'pending', NULL)
        """),
        {"id": media_id, "title": title},
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


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestRealEpubFixtureCorpusExtractsToS5ContractMinimums:
    """test_real_epub_fixture_corpus_extracts_to_s5_contract_minimums"""

    @pytest.mark.parametrize(
        "fixture_meta",
        CORPUS,
        ids=[c["file"] for c in CORPUS],
    )
    def test_extraction(self, db_session: Session, fixture_meta: dict):
        fixture_path = FIXTURES_DIR / fixture_meta["file"]
        assert fixture_path.exists(), f"Missing fixture: {fixture_path}"

        epub_bytes = fixture_path.read_bytes()
        storage = FakeStorageClient()

        mid = _create_media_with_epub(
            db_session,
            storage,
            epub_bytes,
            title=fixture_meta["file"],
        )
        result = run_epub_ingest_sync(db_session, mid, storage)
        db_session.flush()

        if fixture_meta["expected"] == "success":
            assert isinstance(result, EpubExtractionResult), (
                f"{fixture_meta['file']}: expected success, got {result}"
            )
            assert result.chapter_count >= fixture_meta["min_chapters"]

            frags = db_session.execute(
                text(
                    "SELECT idx, html_sanitized FROM fragments WHERE media_id = :mid ORDER BY idx"
                ),
                {"mid": mid},
            ).fetchall()

            assert len(frags) >= fixture_meta["min_chapters"]
            for i, (idx, hs) in enumerate(frags):
                assert idx == i, f"Non-contiguous idx at position {i}"
                assert hs and hs.strip(), f"Empty html_sanitized at idx {i}"

            media = db_session.get(Media, mid)
            assert media.title and media.title.strip(), "Title is empty"

            if fixture_meta["has_toc"]:
                toc_count = db_session.execute(
                    text("SELECT COUNT(*) FROM epub_toc_nodes WHERE media_id = :mid"),
                    {"mid": mid},
                ).scalar()
                assert toc_count > 0, "Expected TOC nodes but found none"
            if fixture_meta["has_assets"]:
                assert result.asset_count > 0, "Expected stored EPUB assets but found none"
        else:
            assert not isinstance(result, EpubExtractionResult), (
                f"{fixture_meta['file']}: expected failure, got success"
            )
            if fixture_meta.get("error_contains"):
                assert fixture_meta["error_contains"] in result.error_message


class TestRealEpubFixtureCorpusAssetsAndSanitizationDegradeSafely:
    """test_real_epub_fixture_corpus_assets_and_sanitization_degrade_safely"""

    @pytest.mark.parametrize(
        "fixture_meta",
        [c for c in CORPUS if c.get("has_assets") and c.get("expected") == "success"],
        ids=[c["file"] for c in CORPUS if c.get("has_assets") and c.get("expected") == "success"],
    )
    def test_assets_and_sanitization(self, db_session: Session, fixture_meta: dict):
        fixture_path = FIXTURES_DIR / fixture_meta["file"]
        epub_bytes = fixture_path.read_bytes()
        storage = FakeStorageClient()

        mid = _create_media_with_epub(
            db_session,
            storage,
            epub_bytes,
            title=fixture_meta["file"],
        )
        result = run_epub_ingest_sync(db_session, mid, storage)
        db_session.flush()

        assert isinstance(result, EpubExtractionResult)

        frags = db_session.execute(
            text("SELECT html_sanitized FROM fragments WHERE media_id = :mid ORDER BY idx"),
            {"mid": mid},
        ).fetchall()

        for (html,) in frags:
            assert "<script" not in html, "Script tag not stripped"
            assert "onclick=" not in html.lower(), "onclick handler survived"
            assert "onerror=" not in html.lower(), "onerror handler survived"
            assert "javascript:" not in html.lower(), "javascript: protocol survived"
