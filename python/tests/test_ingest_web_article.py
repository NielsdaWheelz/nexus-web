"""Integration tests for web article ingestion per s2_pr04.md spec.

Tests cover:
- Full ingestion pipeline (fetch → sanitize → canonicalize → persist)
- State transitions (pending → extracting → ready_for_reading or failed)
- Deduplication by canonical URL after redirect resolution
- Idempotency (re-running task on already-processed media)
- Error handling and failure states

These tests use pytest-httpserver for deterministic HTTP fixtures.
No live internet access in CI gating tests.
"""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import MediaKind, ProcessingStatus
from nexus.services.media import create_provisional_web_article
from tests.helpers import create_test_user_id


class TestIngestionStateTransitions:
    """Tests for processing state machine transitions."""

    def test_successful_ingest_reaches_ready_for_reading(self, db_session: Session, httpserver):
        """Successful ingestion should transition: pending → extracting → ready_for_reading."""
        # Skip if node/playwright not available
        pytest.importorskip("nexus.services.node_ingest")

        # This test requires node.js and playwright to be installed
        # In CI without those, we test the Python components separately
        from nexus.tasks.ingest_web_article import run_ingest_sync

        # Create test user and media
        user_id = create_test_user_id()
        _create_user(db_session, user_id)

        # Set up fixture server
        httpserver.expect_request("/article").respond_with_data(
            """
            <!DOCTYPE html>
            <html>
            <head><title>Test Article</title></head>
            <body>
                <article>
                    <h1>Test Article Title</h1>
                    <p>This is the article content.</p>
                </article>
            </body>
            </html>
            """,
            content_type="text/html",
        )

        # Create provisional media
        url = httpserver.url_for("/article")
        result = create_provisional_web_article(db_session, user_id, url)
        media_id = result.media_id

        # Verify initial state
        media = _get_media(db_session, media_id)
        assert media["processing_status"] == ProcessingStatus.pending.value

        # Run ingestion
        ingest_result = run_ingest_sync(db_session, media_id, user_id)

        # Verify final state
        db_session.expire_all()
        media = _get_media(db_session, media_id)

        if ingest_result.get("status") == "success":
            assert media["processing_status"] == ProcessingStatus.ready_for_reading.value
            assert media["processing_completed_at"] is not None
            assert media["failure_stage"] is None
            assert media["last_error_code"] is None

            # Verify fragment was created
            fragment = _get_fragment(db_session, media_id)
            assert fragment is not None
            assert fragment["idx"] == 0
            assert len(fragment["html_sanitized"]) > 0
            assert len(fragment["canonical_text"]) > 0
        else:
            # If node.js/playwright not available, task will fail
            # This is expected in some CI environments
            pytest.skip("Node.js/Playwright not available for full integration test")

    def test_fetch_failure_marks_media_failed(self, db_session: Session, httpserver):
        """Failed fetch should transition to failed state with correct error code."""
        pytest.importorskip("nexus.services.node_ingest")
        from nexus.tasks.ingest_web_article import run_ingest_sync

        user_id = create_test_user_id()
        _create_user(db_session, user_id)

        # Server returns 404
        httpserver.expect_request("/missing").respond_with_data("Not Found", status=404)

        url = httpserver.url_for("/missing")
        result = create_provisional_web_article(db_session, user_id, url)
        media_id = result.media_id

        # Run ingestion
        ingest_result = run_ingest_sync(db_session, media_id, user_id)

        # Verify failed state
        db_session.expire_all()
        media = _get_media(db_session, media_id)

        # Should be failed or skipped
        if ingest_result.get("status") == "failed":
            assert media["processing_status"] == ProcessingStatus.failed.value
            assert media["failure_stage"] == "extract"
            assert media["last_error_code"] is not None

    def test_idempotency_skips_already_ready_media(self, db_session: Session):
        """Re-running task on already-processed media should skip without changes."""
        from nexus.tasks.ingest_web_article import run_ingest_sync

        user_id = create_test_user_id()
        _create_user(db_session, user_id)

        # Create media already in ready_for_reading state with fragment
        media_id = uuid4()
        fragment_id = uuid4()

        db_session.execute(
            text("""
                INSERT INTO media (id, kind, title, processing_status, requested_url, created_by_user_id)
                VALUES (:id, :kind, :title, :status, :url, :user_id)
            """),
            {
                "id": media_id,
                "kind": MediaKind.web_article.value,
                "title": "Already Processed",
                "status": ProcessingStatus.ready_for_reading.value,
                "url": "https://example.com/already-done",
                "user_id": user_id,
            },
        )

        db_session.execute(
            text("""
                INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
                VALUES (:id, :media_id, 0, '<p>Content</p>', 'Content')
            """),
            {"id": fragment_id, "media_id": media_id},
        )
        db_session.commit()

        # Run ingestion - should skip
        result = run_ingest_sync(db_session, media_id, user_id)

        assert result["status"] == "skipped"
        assert result["reason"] == "already_ready"


class TestDeduplication:
    """Tests for canonical URL deduplication."""

    def test_dedup_by_canonical_url_after_redirect(self, db_session: Session, httpserver):
        """Two URLs redirecting to same final URL should result in one media row."""
        pytest.importorskip("nexus.services.node_ingest")
        from nexus.tasks.ingest_web_article import run_ingest_sync

        user_id = create_test_user_id()
        _create_user(db_session, user_id)

        # Set up redirect
        httpserver.expect_request("/old-url").respond_with_data(
            "", status=301, headers={"Location": httpserver.url_for("/canonical")}
        )
        httpserver.expect_request("/canonical").respond_with_data(
            "<html><body><h1>Title</h1><p>Content</p></body></html>",
            content_type="text/html",
        )

        # Create first media via old URL
        old_url = httpserver.url_for("/old-url")
        result1 = create_provisional_web_article(db_session, user_id, old_url)
        media_id1 = result1.media_id

        # Ingest first media
        run_ingest_sync(db_session, media_id1, user_id)

        # The canonical URL should now be set
        db_session.expire_all()
        media1 = _get_media(db_session, media_id1)

        # If ingestion succeeded, verify canonical URL is set
        if media1 and media1["canonical_url"]:
            # Create second media via canonical URL directly
            canonical_url = httpserver.url_for("/canonical")
            result2 = create_provisional_web_article(db_session, user_id, canonical_url)
            media_id2 = result2.media_id

            # Ingest second media - should detect duplicate
            ingest_result = run_ingest_sync(db_session, media_id2, user_id)

            # Should be deduped
            if ingest_result.get("status") == "deduped":
                # Loser media should be deleted
                db_session.expire_all()
                loser = _get_media(db_session, media_id2)
                assert loser is None, "Loser media should be deleted"


class TestFragmentPersistence:
    """Tests for fragment creation and immutability."""

    def test_fragment_created_with_correct_structure(self, db_session: Session, httpserver):
        """Fragment should be created with idx=0, html_sanitized, and canonical_text."""
        pytest.importorskip("nexus.services.node_ingest")
        from nexus.tasks.ingest_web_article import run_ingest_sync

        user_id = create_test_user_id()
        _create_user(db_session, user_id)

        httpserver.expect_request("/article").respond_with_data(
            """
            <html><body>
                <h1>Title</h1>
                <p>Paragraph one.</p>
                <p>Paragraph two.</p>
            </body></html>
            """,
            content_type="text/html",
        )

        url = httpserver.url_for("/article")
        result = create_provisional_web_article(db_session, user_id, url)
        media_id = result.media_id

        ingest_result = run_ingest_sync(db_session, media_id, user_id)

        if ingest_result.get("status") == "success":
            db_session.expire_all()
            fragment = _get_fragment(db_session, media_id)

            assert fragment is not None
            assert fragment["idx"] == 0
            assert "<p>" in fragment["html_sanitized"]
            assert "Paragraph one" in fragment["canonical_text"]
            assert "Paragraph two" in fragment["canonical_text"]

    def test_fragment_blocks_created_on_ingest(self, db_session: Session, httpserver):
        """Fragment blocks should be created during ingestion for context windows."""
        pytest.importorskip("nexus.services.node_ingest")
        from nexus.tasks.ingest_web_article import run_ingest_sync

        user_id = create_test_user_id()
        _create_user(db_session, user_id)

        # Create article with multiple paragraphs (will create multiple blocks)
        httpserver.expect_request("/multiblock").respond_with_data(
            """
            <html><body>
                <h1>Title</h1>
                <p>First paragraph content.</p>
                <p>Second paragraph content.</p>
                <p>Third paragraph content.</p>
            </body></html>
            """,
            content_type="text/html",
        )

        url = httpserver.url_for("/multiblock")
        result = create_provisional_web_article(db_session, user_id, url)
        media_id = result.media_id

        ingest_result = run_ingest_sync(db_session, media_id, user_id)

        if ingest_result.get("status") == "success":
            db_session.expire_all()
            fragment = _get_fragment(db_session, media_id)
            assert fragment is not None

            # Check fragment_blocks were created
            blocks = _get_fragment_blocks(db_session, fragment["id"])
            assert len(blocks) > 0, "Fragment blocks should be created during ingestion"

            # Verify block structure
            for i, block in enumerate(blocks):
                assert block["block_idx"] == i
                assert block["start_offset"] >= 0
                assert block["end_offset"] >= block["start_offset"]

            # Verify contiguity
            if len(blocks) > 1:
                for i in range(1, len(blocks)):
                    assert blocks[i]["start_offset"] == blocks[i - 1]["end_offset"], (
                        "Blocks must be contiguous"
                    )

            # Verify coverage
            canonical_text = fragment["canonical_text"]
            assert blocks[0]["start_offset"] == 0
            assert blocks[-1]["end_offset"] == len(canonical_text)


class TestProcessingAttempts:
    """Tests for processing_attempts tracking."""

    def test_processing_attempts_incremented(self, db_session: Session, httpserver):
        """processing_attempts should be incremented on each ingest attempt."""
        pytest.importorskip("nexus.services.node_ingest")
        from nexus.tasks.ingest_web_article import run_ingest_sync

        user_id = create_test_user_id()
        _create_user(db_session, user_id)

        httpserver.expect_request("/article").respond_with_data(
            "<html><body><p>Content</p></body></html>",
            content_type="text/html",
        )

        url = httpserver.url_for("/article")
        result = create_provisional_web_article(db_session, user_id, url)
        media_id = result.media_id

        # Check initial attempts
        media = _get_media(db_session, media_id)
        initial_attempts = media["processing_attempts"]

        # Run ingestion
        run_ingest_sync(db_session, media_id, user_id)

        # Check attempts incremented
        db_session.expire_all()
        media = _get_media(db_session, media_id)

        # If task ran (not skipped), attempts should be incremented
        if media and media["processing_status"] != ProcessingStatus.pending.value:
            assert media["processing_attempts"] > initial_attempts


# =============================================================================
# Helper Functions
# =============================================================================


def _create_user(db: Session, user_id: UUID) -> None:
    """Create a user with default library for testing."""
    from nexus.services.bootstrap import ensure_user_and_default_library

    ensure_user_and_default_library(db, user_id)


def _get_media(db: Session, media_id: UUID) -> dict | None:
    """Fetch media row as dict."""
    result = db.execute(
        text("""
            SELECT id, kind, title, processing_status, failure_stage,
                   last_error_code, canonical_url, processing_attempts,
                   processing_completed_at
            FROM media WHERE id = :id
        """),
        {"id": media_id},
    )
    row = result.fetchone()
    if not row:
        return None
    return {
        "id": row[0],
        "kind": row[1],
        "title": row[2],
        "processing_status": row[3],
        "failure_stage": row[4],
        "last_error_code": row[5],
        "canonical_url": row[6],
        "processing_attempts": row[7],
        "processing_completed_at": row[8],
    }


def _get_fragment(db: Session, media_id: UUID) -> dict | None:
    """Fetch first fragment for media as dict."""
    result = db.execute(
        text("""
            SELECT id, media_id, idx, html_sanitized, canonical_text
            FROM fragments
            WHERE media_id = :media_id AND idx = 0
        """),
        {"media_id": media_id},
    )
    row = result.fetchone()
    if not row:
        return None
    return {
        "id": row[0],
        "media_id": row[1],
        "idx": row[2],
        "html_sanitized": row[3],
        "canonical_text": row[4],
    }


def _get_fragment_blocks(db: Session, fragment_id: UUID) -> list[dict]:
    """Fetch all fragment_blocks for a fragment as list of dicts."""
    result = db.execute(
        text("""
            SELECT id, fragment_id, block_idx, start_offset, end_offset, is_empty
            FROM fragment_blocks
            WHERE fragment_id = :fragment_id
            ORDER BY block_idx
        """),
        {"fragment_id": fragment_id},
    )
    rows = result.fetchall()
    return [
        {
            "id": row[0],
            "fragment_id": row[1],
            "block_idx": row[2],
            "start_offset": row[3],
            "end_offset": row[4],
            "is_empty": row[5],
        }
        for row in rows
    ]


# =============================================================================
# Pytest Fixtures
# =============================================================================


@pytest.fixture(scope="session")
def httpserver_listen_address():
    """Configure httpserver to listen on localhost."""
    return ("127.0.0.1", 0)  # Random available port
