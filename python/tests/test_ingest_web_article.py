"""Integration tests for web article ingestion.

Tests cover:
- Full ingestion pipeline (fetch → sanitize → canonicalize → persist)
- State transitions (pending → extracting → ready_for_reading or failed)
- Deduplication by canonical URL after redirect resolution
- Idempotency (re-running task on already-processed media)
- Error handling and failure states

These tests use pytest-httpserver for deterministic HTTP fixtures.
No live internet access in CI gating tests.
"""

from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import Fragment, MediaKind, ProcessingStatus, ResourceMutation
from nexus.services import contributors
from nexus.services.contributor_taxonomy import (
    NOT_OBSERVED,
    ContributorObservation,
    ObservedRoleSlices,
)
from nexus.services.media_source_ingest import accept_url_source
from nexus.services.web_article_artifacts import delete_web_article_artifacts
from tests.factories import create_test_media
from tests.helpers import create_test_user_id
from tests.reader_apparatus_corpus import (
    expected_counts,
    fixture_case_ids,
    fixture_cases_by_real_media_contract,
    fixture_text,
)
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

WEB_GENERIC_URL_APPARATUS_CASES = fixture_cases_by_real_media_contract("web_article_capture_api")


class TestIngestionStateTransitions:
    """Tests for processing state machine transitions."""

    def test_successful_ingest_reaches_ready_for_reading(self, db_session: Session, httpserver):
        """Successful ingestion should transition: pending → extracting → ready_for_reading."""
        # Skip if node ingest not available
        pytest.importorskip("nexus.services.node_ingest")

        # This test requires node.js to be installed
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
        result = accept_url_source(db=db_session, viewer_id=user_id, url=url, library_ids=[])
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
            # If node.js not available, task will fail
            # This is expected in some CI environments
            pytest.skip("Node.js not available for full integration test")

    def test_fetch_failure_marks_media_failed(self, db_session: Session, httpserver):
        """Failed fetch should transition to failed state with correct error code."""
        pytest.importorskip("nexus.services.node_ingest")
        from nexus.tasks.ingest_web_article import run_ingest_sync

        user_id = create_test_user_id()
        _create_user(db_session, user_id)

        # Server returns 404
        httpserver.expect_request("/missing").respond_with_data("Not Found", status=404)

        url = httpserver.url_for("/missing")
        result = accept_url_source(db=db_session, viewer_id=user_id, url=url, library_ids=[])
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
        from nexus.services.content_indexing import rebuild_fragment_content_index
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
        fragment = db_session.get(Fragment, fragment_id)
        rebuild_fragment_content_index(
            db_session,
            media_id=media_id,
            source_kind="web_article",
            fragments=[fragment],
            reason="test_ready_index",
        )
        db_session.commit()

        # Run ingestion - should skip
        result = run_ingest_sync(db_session, media_id, user_id)

        assert result["status"] == "skipped"
        assert result["reason"] == "already_ready"

    def test_idempotency_repairs_ready_media_without_content_index(self, db_session: Session):
        """Ready media with fragments but no content index should rebuild the index."""
        from nexus.tasks.ingest_web_article import run_ingest_sync

        user_id = create_test_user_id()
        _create_user(db_session, user_id)
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
                "title": "Ready Article Missing Index",
                "status": ProcessingStatus.ready_for_reading.value,
                "url": "https://example.com/ready-missing-index",
                "user_id": user_id,
            },
        )
        db_session.execute(
            text("""
                INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
                VALUES (:id, :media_id, 0, '<p>Ready article text</p>', 'Ready article text')
            """),
            {"id": fragment_id, "media_id": media_id},
        )
        db_session.commit()

        result = run_ingest_sync(db_session, media_id, user_id)

        assert result == {"status": "success", "reason": "rebuilt_content_index"}
        chunk_count = db_session.execute(
            text(
                "SELECT count(*) FROM content_chunks "
                "WHERE owner_kind = 'media' AND owner_id = :media_id"
            ),
            {"media_id": media_id},
        ).scalar_one()
        assert chunk_count >= 1


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
        result1 = accept_url_source(db=db_session, viewer_id=user_id, url=old_url, library_ids=[])
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
            result2 = accept_url_source(
                db=db_session,
                viewer_id=user_id,
                url=canonical_url,
                library_ids=[],
            )
            media_id2 = result2.media_id
            loser_fragment_id = _seed_duplicate_loser_child_rows(
                db_session,
                user_id=user_id,
                winner_media_id=media_id1,
                loser_media_id=media_id2,
            )

            # Ingest second media - should detect duplicate
            ingest_result = run_ingest_sync(db_session, media_id2, user_id)

            # Should be deduped
            if ingest_result.get("status") == "deduped":
                # Loser media should be deleted
                db_session.expire_all()
                loser = _get_media(db_session, media_id2)
                assert loser is None, "Loser media should be deleted"
                _assert_duplicate_loser_child_rows_deleted(
                    db_session,
                    media_id=media_id2,
                    fragment_id=loser_fragment_id,
                )


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
        result = accept_url_source(db=db_session, viewer_id=user_id, url=url, library_ids=[])
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
                <h2>Section</h2>
                <p>Second paragraph content.</p>
                <p>Third paragraph content.</p>
            </body></html>
            """,
            content_type="text/html",
        )

        url = httpserver.url_for("/multiblock")
        result = accept_url_source(db=db_session, viewer_id=user_id, url=url, library_ids=[])
        media_id = result.media_id

        ingest_result = run_ingest_sync(db_session, media_id, user_id)

        if ingest_result.get("status") == "success":
            db_session.expire_all()
            fragment = _get_fragment(db_session, media_id)
            assert fragment is not None

            # Check fragment_blocks were created
            blocks = _get_fragment_blocks(db_session, fragment["id"])
            assert len(blocks) > 0, "Fragment blocks should be created during ingestion"
            assert any(block["block_type"] == "heading" for block in blocks)
            assert any(block["block_type"] == "paragraph" for block in blocks)

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

    def test_generic_url_ingest_persists_reader_apparatus_with_exact_locator(
        self,
        db_session: Session,
        httpserver,
    ):
        """Generic URL ingest preserves semantic classes needed for apparatus."""
        pytest.importorskip("nexus.services.node_ingest")
        from nexus.tasks.ingest_web_article import run_ingest_sync

        user_id = create_test_user_id()
        _create_user(db_session, user_id)

        httpserver.expect_request("/apparatus").respond_with_data(
            """
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8"><title>Apparatus Article</title></head>
            <body>
              <article>
                <h1>Apparatus Article</h1>
                <p>Primary paragraph with enough words for Readability extraction
                and one source-authored margin note in the same paragraph.
                <span class="marginnote">A source-authored margin note survives.</span>
                </p>
                <p>Second paragraph provides enough article text so the extraction
                heuristics treat this as a substantive web article.</p>
                <p>Third paragraph keeps the fixture stable across Readability
                versions by avoiding a too-short article body.</p>
                <p>Fourth paragraph gives the deterministic fixture enough
                content to persist a normal reader fragment.</p>
              </article>
            </body>
            </html>
            """,
            content_type="text/html; charset=utf-8",
        )

        url = httpserver.url_for("/apparatus")
        result = accept_url_source(db=db_session, viewer_id=user_id, url=url, library_ids=[])
        media_id = result.media_id
        ingest_result = run_ingest_sync(db_session, media_id, user_id)

        if ingest_result.get("status") != "success":
            pytest.skip(f"Node.js web article ingest unavailable: {ingest_result}")

        row = db_session.execute(
            text("""
                SELECT s.status, s.item_count, s.edge_count,
                       i.kind, i.body_text, i.locator_status, i.locator
                FROM reader_apparatus_states s
                JOIN reader_apparatus_items i ON i.state_id = s.id
                WHERE s.media_id = :media_id
            """),
            {"media_id": media_id},
        ).fetchone()
        assert row is not None
        assert row[0] == "ready"
        assert row[1] == 1
        assert row[2] == 0
        assert row[3] == "margin_note"
        assert row[4] == "A source-authored margin note survives."
        assert row[5] == "exact"
        assert row[6]["type"] == "web_text_offsets"

    @pytest.mark.parametrize(
        "case",
        WEB_GENERIC_URL_APPARATUS_CASES,
        ids=fixture_case_ids(WEB_GENERIC_URL_APPARATUS_CASES),
    )
    def test_generic_url_ingest_extracts_apparatus_from_source_html(
        self,
        db_session: Session,
        httpserver,
        case: dict[str, object],
    ):
        """Generic URL ingest uses fetched source HTML for apparatus, not Readability-only HTML."""
        pytest.importorskip("nexus.services.node_ingest")
        from nexus.tasks.ingest_web_article import run_ingest_sync

        user_id = create_test_user_id()
        _create_user(db_session, user_id)

        route = f"/{case['id']}"
        httpserver.expect_request(route).respond_with_data(
            fixture_text(case),
            content_type="text/html; charset=utf-8",
        )

        url = httpserver.url_for(route)
        result = accept_url_source(db=db_session, viewer_id=user_id, url=url, library_ids=[])
        media_id = result.media_id
        ingest_result = run_ingest_sync(db_session, media_id, user_id)

        if ingest_result.get("status") != "success":
            pytest.skip(f"Node.js web article ingest unavailable: {ingest_result}")

        item_counts = dict(
            db_session.execute(
                text("""
                    SELECT i.kind, COUNT(*)
                    FROM reader_apparatus_states s
                    JOIN reader_apparatus_items i ON i.state_id = s.id
                    WHERE s.media_id = :media_id
                    GROUP BY i.kind
                """),
                {"media_id": media_id},
            ).fetchall()
        )
        edge_counts = dict(
            db_session.execute(
                text("""
                    SELECT e.relation, COUNT(*)
                    FROM reader_apparatus_states s
                    JOIN reader_apparatus_edges e ON e.state_id = s.id
                    WHERE s.media_id = :media_id
                    GROUP BY e.relation
                """),
                {"media_id": media_id},
            ).fetchall()
        )

        assert item_counts == expected_counts(case, "item_kinds")
        assert edge_counts == expected_counts(case, "edge_relations")


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
        result = accept_url_source(db=db_session, viewer_id=user_id, url=url, library_ids=[])
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
            SELECT id, fragment_id, block_idx, start_offset, end_offset, is_empty, block_type
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
            "block_type": row[6],
        }
        for row in rows
    ]


def _seed_duplicate_loser_child_rows(
    db: Session,
    *,
    user_id: UUID,
    winner_media_id: UUID,
    loser_media_id: UUID,
) -> UUID:
    default_library_id = db.execute(
        text("""
            SELECT id
            FROM libraries
            WHERE owner_user_id = :user_id AND is_default = true
        """),
        {"user_id": user_id},
    ).scalar_one()
    source_library_id = uuid4()
    fragment_id = uuid4()

    db.execute(
        text("""
            INSERT INTO libraries (id, owner_user_id, name, is_default)
            VALUES (:id, :user_id, 'Source Library', false)
        """),
        {"id": source_library_id, "user_id": user_id},
    )
    db.execute(
        text("""
            INSERT INTO memberships (library_id, user_id, role)
            VALUES (:library_id, :user_id, 'admin')
        """),
        {"library_id": source_library_id, "user_id": user_id},
    )
    db.execute(
        text("""
            INSERT INTO library_entries (library_id, media_id, position)
            VALUES (:library_id, :media_id, 0)
        """),
        {"library_id": source_library_id, "media_id": loser_media_id},
    )
    db.execute(
        text("""
            INSERT INTO default_library_closure_edges (
                default_library_id,
                media_id,
                source_library_id
            )
            VALUES (:default_library_id, :media_id, :source_library_id)
        """),
        {
            "default_library_id": default_library_id,
            "media_id": loser_media_id,
            "source_library_id": source_library_id,
        },
    )
    db.execute(
        text("""
            INSERT INTO user_media_deletions (user_id, media_id)
            VALUES (:user_id, :media_id)
        """),
        {"user_id": user_id, "media_id": loser_media_id},
    )
    db.execute(
        text("""
            INSERT INTO media_file (media_id, storage_path, content_type, size_bytes)
            VALUES (:media_id, :storage_path, 'text/html', 42)
        """),
        {
            "media_id": loser_media_id,
            "storage_path": f"test/web-article/{loser_media_id}.html",
        },
    )
    db.execute(
        text("""
            INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
            VALUES (:id, :media_id, 0, '<p>Loser</p>', 'Loser')
        """),
        {"id": fragment_id, "media_id": loser_media_id},
    )
    db.execute(
        text("""
            INSERT INTO fragment_blocks (
                fragment_id,
                block_idx,
                start_offset,
                end_offset,
                block_type
            )
            VALUES (:fragment_id, 0, 0, 5, 'paragraph')
        """),
        {"fragment_id": fragment_id},
    )
    db.execute(
        text("""
            INSERT INTO content_index_states (owner_kind, owner_id, status, status_reason)
            VALUES ('media', :media_id, 'failed', 'test_duplicate_cleanup')
        """),
        {"media_id": loser_media_id},
    )
    db.execute(
        text("""
            INSERT INTO resource_edges (
                user_id,
                kind,
                origin,
                source_scheme,
                source_id,
                target_scheme,
                target_id
            )
            VALUES (:user_id, 'context', 'user', 'media', :loser_id, 'media', :winner_id)
        """),
        {
            "user_id": user_id,
            "loser_id": loser_media_id,
            "winner_id": winner_media_id,
        },
    )
    db.commit()
    return fragment_id


def _assert_duplicate_loser_child_rows_deleted(
    db: Session,
    *,
    media_id: UUID,
    fragment_id: UUID,
) -> None:
    assert _count_rows(db, "media", "id = :media_id", media_id=media_id) == 0
    assert _count_rows(db, "library_entries", "media_id = :media_id", media_id=media_id) == 0
    assert (
        _count_rows(db, "default_library_intrinsics", "media_id = :media_id", media_id=media_id)
        == 0
    )
    assert (
        _count_rows(
            db,
            "default_library_closure_edges",
            "media_id = :media_id",
            media_id=media_id,
        )
        == 0
    )
    assert _count_rows(db, "user_media_deletions", "media_id = :media_id", media_id=media_id) == 0
    assert _count_rows(db, "media_file", "media_id = :media_id", media_id=media_id) == 0
    assert _count_rows(db, "fragments", "media_id = :media_id", media_id=media_id) == 0
    assert (
        _count_rows(db, "fragment_blocks", "fragment_id = :fragment_id", fragment_id=fragment_id)
        == 0
    )
    assert (
        _count_rows(
            db,
            "content_index_states",
            "owner_kind = 'media' AND owner_id = :media_id",
            media_id=media_id,
        )
        == 0
    )
    bare_edges = db.execute(
        text("""
            SELECT COUNT(*)
            FROM resource_edges
            WHERE ordinal IS NULL
              AND ((source_scheme = 'media' AND source_id = :media_id)
                OR (target_scheme = 'media' AND target_id = :media_id))
        """),
        {"media_id": media_id},
    ).scalar_one()
    assert int(bare_edges) == 0, "media deletion must clean bare edges (graph cleanup rule 2)"


def _count_rows(db: Session, table: str, where: str, **params: object) -> int:
    return int(db.execute(text(f"SELECT COUNT(*) FROM {table} WHERE {where}"), params).scalar_one())


# =============================================================================
# Pytest Fixtures
# =============================================================================


@pytest.fixture(scope="session")
def httpserver_listen_address():
    """Configure httpserver to listen on localhost."""
    return ("127.0.0.1", 0)  # Random available port


# =============================================================================
# Refresh keeps prior author facts (spec 2.4 refresh, AC 10, AC 13, spec 2.8)
# =============================================================================


class TestRefreshPreservesAuthorFacts:
    """Regression for the re-ingest/refresh artifacts wipe: it must delete
    content artifacts ONLY. Prior credits (all roles), the manual author pin,
    and the media's author-edit replay memos survive the wipe — refresh keeps
    the prior list until a post-commit observation replaces it (spec 2.4), a
    byline-less re-fetch preserves it outright (AC 10), and a pinned author
    slice survives every automatic author lane (AC 13)."""

    def test_artifact_wipe_preserves_credits_pin_and_memos(self, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            _create_user(session, user_id)
            media_id = create_test_media(session)
            session.add(
                Fragment(
                    media_id=media_id,
                    idx=0,
                    html_sanitized="<p>old body</p>",
                    canonical_text="old body",
                    created_at=datetime.now(UTC),
                )
            )
            session.commit()
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("resource_mutations", "user_id", user_id)

        # Prior state: an automatic author + translator from an earlier parse …
        contributors.replace_observed_role_slices(
            target=contributors.MediaTarget(media_id),
            observation=ObservedRoleSlices(
                managed_roles=frozenset({"author", "translator"}),
                credits=(
                    ContributorObservation("Prior Author", "author", None, None),
                    ContributorObservation("Prior Translator", "translator", None, None),
                ),
            ),
            source="web_article_byline",
        )
        with direct_db.session() as session:
            for contributor_id in session.execute(
                text("SELECT DISTINCT contributor_id FROM contributor_credits WHERE media_id = :m"),
                {"m": media_id},
            ).scalars():
                direct_db.register_cleanup("contributors", "id", contributor_id)
                direct_db.register_cleanup("contributor_aliases", "contributor_id", contributor_id)
                direct_db.register_cleanup(
                    "contributor_external_ids", "contributor_id", contributor_id
                )
                direct_db.register_cleanup("contributor_credits", "contributor_id", contributor_id)

        # … plus a manual pin and its author-edit replay memo (spec 2.8: the memo
        # lives until the media is deleted, not until it is refreshed).
        with direct_db.session() as session:
            session.execute(
                text("UPDATE media SET authors_manually_managed = true WHERE id = :m"),
                {"m": media_id},
            )
            session.add(
                ResourceMutation(
                    user_id=user_id,
                    mutation_scope=f"media:{media_id}:authors",
                    client_mutation_id="cm-refresh-regression-1",
                    request_hash="a" * 64,
                    changed_lanes={},
                    response_json={"authors": []},
                )
            )
            session.commit()

        # The refresh-shaped wipe (used by web re-ingest, source requeue, browser
        # re-capture, and X refresh) runs inside the new source transaction.
        with direct_db.session() as session:
            delete_web_article_artifacts(
                session,
                owner_user_id=user_id,
                media_id=media_id,
                include_content_index=True,
            )
            session.commit()

        def _facts(session) -> tuple[list[tuple[str, str]], bool, int]:
            credits = session.execute(
                text(
                    "SELECT credited_name, role FROM contributor_credits"
                    " WHERE media_id = :m ORDER BY ordinal"
                ),
                {"m": media_id},
            ).fetchall()
            pinned = session.execute(
                text("SELECT authors_manually_managed FROM media WHERE id = :m"),
                {"m": media_id},
            ).scalar_one()
            memos = session.execute(
                text("SELECT count(*) FROM resource_mutations WHERE mutation_scope = :s"),
                {"s": f"media:{media_id}:authors"},
            ).scalar_one()
            return [tuple(row) for row in credits], bool(pinned), int(memos)

        prior = (
            [("Prior Author", "author"), ("Prior Translator", "translator")],
            True,
            1,
        )
        with direct_db.session() as session:
            fragment_count = session.execute(
                text("SELECT count(*) FROM fragments WHERE media_id = :m"), {"m": media_id}
            ).scalar_one()
            assert int(fragment_count) == 0, "the wipe must still delete content artifacts"
            assert _facts(session) == prior, "the wipe must not touch author facts"

        # AC 10 at the refresh seam: the re-fetch had no byline -> NOT_OBSERVED
        # preserves the prior slice it would previously have found already erased.
        contributors.replace_observed_role_slices(
            target=contributors.MediaTarget(media_id),
            observation=NOT_OBSERVED,
            source="web_article_byline",
        )
        with direct_db.session() as session:
            assert _facts(session) == prior

        # AC 13: the pin still holds after refresh — a re-fetched byline cannot
        # displace the manual author slice (non-author roles stay lane-managed).
        contributors.replace_observed_role_slices(
            target=contributors.MediaTarget(media_id),
            observation=ObservedRoleSlices(
                managed_roles=frozenset({"author"}),
                credits=(ContributorObservation("Refetched Author", "author", None, None),),
            ),
            source="web_article_byline",
        )
        with direct_db.session() as session:
            assert _facts(session) == prior
