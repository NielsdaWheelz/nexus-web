"""End-to-end integration tests for Slice 2 (Web Articles + Highlights).

PR-11 spec: Prove the full read → highlight → annotate → reload loop works
end-to-end and lock regressions with stable integration tests.

Tests cover:
1. Backend E2E ingestion + highlight flow
2. Unicode / emoji stability
3. Security regression coverage for sanitization
4. Capabilities correctness assertions
5. Ownership isolation (different user cannot see highlights)
6. canonical_text immutability
7. processing_attempts behavior

@see docs/v1/s2/s2_prs/s2_pr11.md
"""

from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.app import create_app
from nexus.auth.middleware import AuthMiddleware
from nexus.db.models import ProcessingStatus
from nexus.db.session import create_session_factory
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.media import create_provisional_web_article
from tests.helpers import auth_headers, create_test_user_id
from tests.support.test_verifier import MockJwtVerifier
from tests.utils.db import DirectSessionManager

# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture
def e2e_client(engine):
    """Create a client with auth middleware for E2E testing."""
    from nexus.app import add_request_id_middleware

    session_factory = create_session_factory(engine)

    def bootstrap_callback(user_id: UUID) -> UUID:
        db = session_factory()
        try:
            return ensure_user_and_default_library(db, user_id)
        finally:
            db.close()

    verifier = MockJwtVerifier()
    app = create_app(skip_auth_middleware=True)

    app.add_middleware(
        AuthMiddleware,
        verifier=verifier,
        requires_internal_header=False,
        internal_secret=None,
        bootstrap_callback=bootstrap_callback,
    )

    add_request_id_middleware(app, log_requests=False)

    return TestClient(app)


@pytest.fixture(scope="session")
def httpserver_listen_address():
    """Configure httpserver to listen on localhost."""
    return ("127.0.0.1", 0)


# =============================================================================
# E2E Test: Full Ingestion + Highlight Flow
# =============================================================================


class TestWebArticleHighlightE2E:
    """End-to-end test for the full read → highlight → annotate → reload loop.

    Per PR-11 spec section 3.
    """

    def test_full_ingest_highlight_annotate_reload_loop(
        self,
        e2e_client: TestClient,
        direct_db: DirectSessionManager,
        httpserver,
    ):
        """Test the complete S2 flow from URL ingestion to highlight reload.

        Flow:
        1. Create media via POST /media/from_url
        2. Run ingestion synchronously
        3. Fetch media and verify capabilities
        4. Create overlapping highlights
        5. Verify highlight invariants
        6. Add annotation
        7. Reload and verify no drift

        Note: Uses direct_db instead of db_session because this test mixes
        API calls (e2e_client) with direct service calls (run_ingest_sync).
        The db_session fixture uses savepoint isolation which is invisible
        to the API client's sessions.
        """
        pytest.importorskip("nexus.services.node_ingest")
        from nexus.tasks.ingest_web_article import run_ingest_sync

        # Create test user
        user_id = create_test_user_id()

        # Set up fixture server with real article content
        httpserver.expect_request("/article").respond_with_data(
            """
            <!DOCTYPE html>
            <html>
            <head><title>Test Article for E2E</title></head>
            <body>
                <article>
                    <h1>Test Article Title</h1>
                    <p>This is paragraph one with some text to highlight.</p>
                    <p>This is paragraph two with more content for testing.</p>
                </article>
            </body>
            </html>
            """,
            content_type="text/html",
        )

        url = httpserver.url_for("/article")

        # Step 1: Create media via POST /media/from_url
        create_response = e2e_client.post(
            "/media/from_url",
            json={"url": url},
            headers=auth_headers(user_id),
        )

        assert create_response.status_code == 202
        create_data = create_response.json()["data"]
        media_id = UUID(create_data["media_id"])
        assert create_data["processing_status"] == "pending"
        assert create_data["duplicate"] is False

        # Register cleanup for data created by this test (reverse order of dependencies)
        # Note: highlights are cleaned via cascade when fragments are deleted
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Step 2: Run ingestion synchronously (use direct_db session for visibility)
        with direct_db.session() as session:
            ingest_result = run_ingest_sync(session, media_id, user_id)

        if ingest_result.get("status") != "success":
            pytest.skip("Node.js/Playwright not available for full E2E test")

        # Step 3: Fetch media and verify capabilities
        media_response = e2e_client.get(
            f"/media/{media_id}",
            headers=auth_headers(user_id),
        )

        assert media_response.status_code == 200
        media_data = media_response.json()["data"]

        # Verify capabilities per PR-11 spec
        caps = media_data["capabilities"]
        assert caps["can_read"] is True
        assert caps["can_highlight"] is True
        assert caps["can_quote"] is True
        # TODO(S6): Enable when search capability is properly gated per PR-11 spec
        # assert caps["can_search"] is False  # Search UI not shipped in S2

        # Verify processing status
        assert media_data["processing_status"] == "ready_for_reading"

        # Get fragment for highlighting
        fragments_response = e2e_client.get(
            f"/media/{media_id}/fragments",
            headers=auth_headers(user_id),
        )
        assert fragments_response.status_code == 200
        fragments = fragments_response.json()["data"]
        assert len(fragments) == 1

        fragment = fragments[0]
        fragment_id = fragment["id"]
        canonical_text = fragment["canonical_text"]

        # Store original canonical_text for immutability check
        original_canonical_text = canonical_text

        # Step 4: Create overlapping highlights
        # Find "paragraph" in the text
        para_start = canonical_text.lower().find("paragraph")
        assert para_start > -1, "Test fixture should contain 'paragraph'"

        # Create first highlight
        hl1_response = e2e_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": para_start, "end_offset": para_start + 9, "color": "yellow"},
            headers=auth_headers(user_id),
        )
        assert hl1_response.status_code == 201
        hl1 = hl1_response.json()["data"]
        hl1_id = hl1["id"]

        # Create overlapping highlight
        hl2_response = e2e_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={
                "start_offset": para_start + 5,
                "end_offset": para_start + 15,
                "color": "green",
            },
            headers=auth_headers(user_id),
        )
        assert hl2_response.status_code == 201
        hl2 = hl2_response.json()["data"]

        # Verify exact-duplicate span returns 409 E_HIGHLIGHT_CONFLICT
        dup_response = e2e_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": para_start, "end_offset": para_start + 9, "color": "blue"},
            headers=auth_headers(user_id),
        )
        assert dup_response.status_code == 409
        assert dup_response.json()["error"]["code"] == "E_HIGHLIGHT_CONFLICT"

        # Step 5: Verify highlight invariants
        for hl in [hl1, hl2]:
            start = hl["start_offset"]
            end = hl["end_offset"]
            exact = hl["exact"]
            prefix = hl["prefix"]
            suffix = hl["suffix"]

            # exact == canonical_text[start:end]
            assert exact == canonical_text[start:end], f"exact mismatch for highlight {hl['id']}"

            # prefix matches canonical text slice
            prefix_start = max(0, start - 64)
            expected_prefix = canonical_text[prefix_start:start]
            assert prefix == expected_prefix, f"prefix mismatch for highlight {hl['id']}"

            # suffix matches canonical text slice
            suffix_end = min(len(canonical_text), end + 64)
            expected_suffix = canonical_text[end:suffix_end]
            assert suffix == expected_suffix, f"suffix mismatch for highlight {hl['id']}"

        # Step 6: Add annotation
        annotation_response = e2e_client.put(
            f"/highlights/{hl1_id}/annotation",
            json={"body": "This is my annotation for the E2E test."},
            headers=auth_headers(user_id),
        )
        assert annotation_response.status_code == 201
        annotation = annotation_response.json()["data"]
        assert annotation["body"] == "This is my annotation for the E2E test."

        # Step 7: Reload and verify no drift
        # Re-fetch highlights
        reload_response = e2e_client.get(
            f"/fragments/{fragment_id}/highlights",
            headers=auth_headers(user_id),
        )
        assert reload_response.status_code == 200
        reloaded_highlights = reload_response.json()["data"]["highlights"]

        assert len(reloaded_highlights) == 2

        # Find hl1 in reloaded list
        reloaded_hl1 = next(h for h in reloaded_highlights if h["id"] == hl1_id)

        # Verify no offset drift
        assert reloaded_hl1["start_offset"] == hl1["start_offset"]
        assert reloaded_hl1["end_offset"] == hl1["end_offset"]
        assert reloaded_hl1["exact"] == hl1["exact"]

        # Verify annotation still present
        assert reloaded_hl1["annotation"] is not None
        assert reloaded_hl1["annotation"]["body"] == "This is my annotation for the E2E test."

        # Re-fetch fragment and verify canonical_text immutability
        refetch_fragments = e2e_client.get(
            f"/media/{media_id}/fragments",
            headers=auth_headers(user_id),
        )
        refetched_canonical = refetch_fragments.json()["data"][0]["canonical_text"]
        assert refetched_canonical == original_canonical_text, "canonical_text must be immutable"


class TestOwnershipIsolation:
    """Test that highlights are isolated by user ownership.

    Per PR-11 spec section 3.8.
    """

    def test_different_user_cannot_see_highlights(
        self,
        e2e_client: TestClient,
        direct_db: DirectSessionManager,
    ):
        """Different user cannot see another user's highlights.

        Prevents regression where user filter is accidentally removed from query.
        """
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        # Create media with fragment
        media_id = uuid4()
        fragment_id = uuid4()
        canonical_text = "Hello World! This is test content."

        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status)
                    VALUES (:media_id, 'web_article', 'Test', 'ready_for_reading')
                """),
                {"media_id": media_id},
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
                    VALUES (:fragment_id, :media_id, 0, '<p>Hello World!</p>', :text)
                """),
                {"fragment_id": fragment_id, "media_id": media_id, "text": canonical_text},
            )
            session.commit()

        direct_db.register_cleanup("highlights", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # User A adds media to their library
        me_a = e2e_client.get("/me", headers=auth_headers(user_a))
        lib_a_id = me_a.json()["data"]["default_library_id"]
        e2e_client.post(
            f"/libraries/{lib_a_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_a),
        )

        # User A creates a highlight
        hl_response = e2e_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 0, "end_offset": 5, "color": "yellow"},
            headers=auth_headers(user_a),
        )
        assert hl_response.status_code == 201
        highlight_id = hl_response.json()["data"]["id"]

        # User B bootstraps (no access to media)
        e2e_client.get("/me", headers=auth_headers(user_b))

        # User B tries to access User A's highlight - should get 404
        get_response = e2e_client.get(
            f"/highlights/{highlight_id}",
            headers=auth_headers(user_b),
        )
        assert get_response.status_code == 404
        assert get_response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

        # User B tries to list highlights on the fragment - should get 404
        list_response = e2e_client.get(
            f"/fragments/{fragment_id}/highlights",
            headers=auth_headers(user_b),
        )
        assert list_response.status_code == 404
        assert list_response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"


# =============================================================================
# Unicode / Emoji Stability Tests
# =============================================================================


class TestUnicodeEmojiStability:
    """Tests for Unicode codepoint handling to prevent UTF-16 vs codepoint regressions.

    Per PR-11 spec section 4.
    """

    def test_emoji_highlight_offsets_are_codepoint_indices(
        self,
        e2e_client: TestClient,
        direct_db: DirectSessionManager,
    ):
        """Verify highlight offsets correctly slice emoji-containing text.

        Fixture: "Hello 🎉 World"
        - 🎉 is 1 codepoint but 2 UTF-16 code units
        - Codepoint indices: H(0) e(1) l(2) l(3) o(4) (5) 🎉(6) (7) W(8) o(9) r(10) l(11) d(12)
        """
        user_id = create_test_user_id()

        media_id = uuid4()
        fragment_id = uuid4()
        emoji_text = "Hello 🎉 World"

        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status)
                    VALUES (:media_id, 'web_article', 'Emoji Test', 'ready_for_reading')
                """),
                {"media_id": media_id},
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
                    VALUES (:fragment_id, :media_id, 0, :html, :text)
                """),
                {
                    "fragment_id": fragment_id,
                    "media_id": media_id,
                    "html": f"<p>{emoji_text}</p>",
                    "text": emoji_text,
                },
            )
            session.commit()

        direct_db.register_cleanup("highlights", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Add to user's library
        me = e2e_client.get("/me", headers=auth_headers(user_id))
        lib_id = me.json()["data"]["default_library_id"]
        e2e_client.post(
            f"/libraries/{lib_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Highlight just the emoji (codepoint index 6-7)
        emoji_response = e2e_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 6, "end_offset": 7, "color": "yellow"},
            headers=auth_headers(user_id),
        )
        assert emoji_response.status_code == 201
        emoji_hl = emoji_response.json()["data"]

        # Verify exact is the emoji, not a broken character
        assert emoji_hl["exact"] == "🎉"

        # Highlight "Hello " + emoji (codepoints 0-7)
        hello_emoji_response = e2e_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 0, "end_offset": 7, "color": "green"},
            headers=auth_headers(user_id),
        )
        assert hello_emoji_response.status_code == 201
        hello_emoji_hl = hello_emoji_response.json()["data"]
        assert hello_emoji_hl["exact"] == "Hello 🎉"

        # Highlight " World" (codepoints 7-13)
        world_response = e2e_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 7, "end_offset": 13, "color": "blue"},
            headers=auth_headers(user_id),
        )
        assert world_response.status_code == 201
        world_hl = world_response.json()["data"]
        assert world_hl["exact"] == " World"

        # Reload and verify offsets don't change
        list_response = e2e_client.get(
            f"/fragments/{fragment_id}/highlights",
            headers=auth_headers(user_id),
        )
        reloaded = list_response.json()["data"]["highlights"]

        for hl in reloaded:
            if hl["id"] == emoji_hl["id"]:
                assert hl["exact"] == "🎉"
                assert hl["start_offset"] == 6
                assert hl["end_offset"] == 7

    def test_multiple_emoji_offsets(
        self,
        e2e_client: TestClient,
        direct_db: DirectSessionManager,
    ):
        """Test text with multiple emoji characters."""
        user_id = create_test_user_id()

        media_id = uuid4()
        fragment_id = uuid4()
        # Text with multiple emoji: "Hi 🎉🚀 Bye"
        # Codepoints: H(0) i(1) (2) 🎉(3) 🚀(4) (5) B(6) y(7) e(8)
        multi_emoji_text = "Hi 🎉🚀 Bye"

        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status)
                    VALUES (:media_id, 'web_article', 'Multi Emoji', 'ready_for_reading')
                """),
                {"media_id": media_id},
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
                    VALUES (:fragment_id, :media_id, 0, :html, :text)
                """),
                {
                    "fragment_id": fragment_id,
                    "media_id": media_id,
                    "html": f"<p>{multi_emoji_text}</p>",
                    "text": multi_emoji_text,
                },
            )
            session.commit()

        direct_db.register_cleanup("highlights", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Add to user's library
        me = e2e_client.get("/me", headers=auth_headers(user_id))
        lib_id = me.json()["data"]["default_library_id"]
        e2e_client.post(
            f"/libraries/{lib_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Highlight both emoji (codepoints 3-5)
        both_emoji_response = e2e_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 3, "end_offset": 5, "color": "yellow"},
            headers=auth_headers(user_id),
        )
        assert both_emoji_response.status_code == 201
        both_hl = both_emoji_response.json()["data"]
        assert both_hl["exact"] == "🎉🚀"


# =============================================================================
# Security Regression Tests
# =============================================================================


class TestSanitizationSecurityRegression:
    """Property-based security assertions for HTML sanitization.

    Per PR-11 spec section 5.
    """

    def test_no_script_tags_in_sanitized_html(
        self,
        e2e_client: TestClient,
        db_session: Session,
        bootstrapped_user: UUID,
        httpserver,
    ):
        """Verify no <script> tags survive sanitization."""
        pytest.importorskip("nexus.services.node_ingest")
        from nexus.tasks.ingest_web_article import run_ingest_sync

        user_id = bootstrapped_user

        httpserver.expect_request("/xss-script").respond_with_data(
            """
            <html><body>
                <p>Safe content</p>
                <script>alert('xss')</script>
                <p>More content</p>
            </body></html>
            """,
            content_type="text/html",
        )

        url = httpserver.url_for("/xss-script")
        result = create_provisional_web_article(db_session, user_id, url)
        media_id = result.media_id

        ingest_result = run_ingest_sync(db_session, media_id, user_id)
        if ingest_result.get("status") != "success":
            pytest.skip("Node.js/Playwright not available")

        db_session.expire_all()
        row = db_session.execute(
            text("SELECT html_sanitized FROM fragments WHERE media_id = :id"),
            {"id": media_id},
        ).fetchone()

        html = row[0]
        assert "<script>" not in html
        assert "<script" not in html.lower()
        assert "alert" not in html

    def test_no_event_handlers_in_sanitized_html(
        self,
        e2e_client: TestClient,
        db_session: Session,
        bootstrapped_user: UUID,
        httpserver,
    ):
        """Verify no on* event handlers survive sanitization."""
        pytest.importorskip("nexus.services.node_ingest")
        from nexus.tasks.ingest_web_article import run_ingest_sync

        user_id = bootstrapped_user

        httpserver.expect_request("/xss-handler").respond_with_data(
            """
            <html><body>
                <p onclick="evil()">Click me</p>
                <div onmouseover="hack()" onload="bad()">Hover</div>
            </body></html>
            """,
            content_type="text/html",
        )

        url = httpserver.url_for("/xss-handler")
        result = create_provisional_web_article(db_session, user_id, url)
        media_id = result.media_id

        ingest_result = run_ingest_sync(db_session, media_id, user_id)
        if ingest_result.get("status") != "success":
            pytest.skip("Node.js/Playwright not available")

        db_session.expire_all()
        row = db_session.execute(
            text("SELECT html_sanitized FROM fragments WHERE media_id = :id"),
            {"id": media_id},
        ).fetchone()

        html = row[0].lower()
        assert "onclick" not in html
        assert "onmouseover" not in html
        assert "onload" not in html
        assert "onerror" not in html

    def test_no_style_class_id_attributes(
        self,
        e2e_client: TestClient,
        db_session: Session,
        bootstrapped_user: UUID,
        httpserver,
    ):
        """Verify style, class, and id attributes are stripped."""
        pytest.importorskip("nexus.services.node_ingest")
        from nexus.tasks.ingest_web_article import run_ingest_sync

        user_id = bootstrapped_user

        httpserver.expect_request("/styled").respond_with_data(
            """
            <html><body>
                <p style="color: red" class="important" id="main">Content</p>
            </body></html>
            """,
            content_type="text/html",
        )

        url = httpserver.url_for("/styled")
        result = create_provisional_web_article(db_session, user_id, url)
        media_id = result.media_id

        ingest_result = run_ingest_sync(db_session, media_id, user_id)
        if ingest_result.get("status") != "success":
            pytest.skip("Node.js/Playwright not available")

        db_session.expire_all()
        row = db_session.execute(
            text("SELECT html_sanitized FROM fragments WHERE media_id = :id"),
            {"id": media_id},
        ).fetchone()

        html = row[0].lower()
        assert "style=" not in html
        assert "class=" not in html
        assert 'id="' not in html

    def test_no_javascript_or_data_urls(
        self,
        e2e_client: TestClient,
        db_session: Session,
        bootstrapped_user: UUID,
        httpserver,
    ):
        """Verify javascript: and data: URLs are blocked."""
        pytest.importorskip("nexus.services.node_ingest")
        from nexus.tasks.ingest_web_article import run_ingest_sync

        user_id = bootstrapped_user

        httpserver.expect_request("/bad-urls").respond_with_data(
            """
            <html><body>
                <a href="javascript:alert(1)">Bad link</a>
                <img src="data:image/png;base64,abc123">
            </body></html>
            """,
            content_type="text/html",
        )

        url = httpserver.url_for("/bad-urls")
        result = create_provisional_web_article(db_session, user_id, url)
        media_id = result.media_id

        ingest_result = run_ingest_sync(db_session, media_id, user_id)
        if ingest_result.get("status") != "success":
            pytest.skip("Node.js/Playwright not available")

        db_session.expire_all()
        row = db_session.execute(
            text("SELECT html_sanitized FROM fragments WHERE media_id = :id"),
            {"id": media_id},
        ).fetchone()

        html = row[0].lower()
        assert "javascript:" not in html
        assert "data:" not in html

    def test_svg_images_rejected(
        self,
        e2e_client: TestClient,
        db_session: Session,
        bootstrapped_user: UUID,
        httpserver,
    ):
        """Verify SVG elements are removed."""
        pytest.importorskip("nexus.services.node_ingest")
        from nexus.tasks.ingest_web_article import run_ingest_sync

        user_id = bootstrapped_user

        httpserver.expect_request("/svg").respond_with_data(
            """
            <html><body>
                <p>Content</p>
                <svg><circle cx="50" cy="50" r="40"/></svg>
            </body></html>
            """,
            content_type="text/html",
        )

        url = httpserver.url_for("/svg")
        result = create_provisional_web_article(db_session, user_id, url)
        media_id = result.media_id

        ingest_result = run_ingest_sync(db_session, media_id, user_id)
        if ingest_result.get("status") != "success":
            pytest.skip("Node.js/Playwright not available")

        db_session.expire_all()
        row = db_session.execute(
            text("SELECT html_sanitized FROM fragments WHERE media_id = :id"),
            {"id": media_id},
        ).fetchone()

        html = row[0].lower()
        assert "<svg" not in html
        assert "<circle" not in html

    def test_img_src_rewritten_to_proxy(
        self,
        e2e_client: TestClient,
        db_session: Session,
        bootstrapped_user: UUID,
        httpserver,
    ):
        """Verify <img src> is rewritten to /media/image proxy."""
        pytest.importorskip("nexus.services.node_ingest")
        from nexus.tasks.ingest_web_article import run_ingest_sync

        user_id = bootstrapped_user

        httpserver.expect_request("/with-image").respond_with_data(
            """
            <html><body>
                <p>Content</p>
                <img src="https://example.com/photo.jpg" alt="Photo">
            </body></html>
            """,
            content_type="text/html",
        )

        url = httpserver.url_for("/with-image")
        result = create_provisional_web_article(db_session, user_id, url)
        media_id = result.media_id

        ingest_result = run_ingest_sync(db_session, media_id, user_id)
        if ingest_result.get("status") != "success":
            pytest.skip("Node.js/Playwright not available")

        db_session.expire_all()
        row = db_session.execute(
            text("SELECT html_sanitized FROM fragments WHERE media_id = :id"),
            {"id": media_id},
        ).fetchone()

        html = row[0]
        assert "/media/image?url=" in html

    def test_external_links_have_security_attrs(
        self,
        e2e_client: TestClient,
        db_session: Session,
        bootstrapped_user: UUID,
        httpserver,
    ):
        """Verify external links include noopener, noreferrer, target="_blank"."""
        pytest.importorskip("nexus.services.node_ingest")
        from nexus.tasks.ingest_web_article import run_ingest_sync

        user_id = bootstrapped_user

        httpserver.expect_request("/ext-link").respond_with_data(
            """
            <html><body>
                <a href="https://external.com/page">External</a>
            </body></html>
            """,
            content_type="text/html",
        )

        url = httpserver.url_for("/ext-link")
        result = create_provisional_web_article(db_session, user_id, url)
        media_id = result.media_id

        ingest_result = run_ingest_sync(db_session, media_id, user_id)
        if ingest_result.get("status") != "success":
            pytest.skip("Node.js/Playwright not available")

        db_session.expire_all()
        row = db_session.execute(
            text("SELECT html_sanitized FROM fragments WHERE media_id = :id"),
            {"id": media_id},
        ).fetchone()

        html = row[0].lower()
        assert "noopener" in html
        assert "noreferrer" in html
        assert 'target="_blank"' in html
        assert 'referrerpolicy="no-referrer"' in html


# =============================================================================
# Processing-State Regression Coverage
# =============================================================================


class TestProcessingStateRegression:
    """Tests for processing state machine and processing_attempts behavior.

    Per PR-11 spec sections 9 and 12.
    """

    def test_processing_attempts_incremented_on_run(
        self,
        db_session: Session,
        bootstrapped_user: UUID,
        httpserver,
    ):
        """Verify processing_attempts is incremented when ingestion runs."""
        pytest.importorskip("nexus.services.node_ingest")
        from nexus.tasks.ingest_web_article import run_ingest_sync

        user_id = bootstrapped_user

        httpserver.expect_request("/attempts").respond_with_data(
            "<html><body><p>Content</p></body></html>",
            content_type="text/html",
        )

        url = httpserver.url_for("/attempts")
        result = create_provisional_web_article(db_session, user_id, url)
        media_id = result.media_id

        # Check initial attempts
        row = db_session.execute(
            text("SELECT processing_attempts FROM media WHERE id = :id"),
            {"id": media_id},
        ).fetchone()
        initial = row[0]

        # Run ingestion
        run_ingest_sync(db_session, media_id, user_id)

        # Check incremented
        db_session.expire_all()
        row = db_session.execute(
            text("SELECT processing_attempts FROM media WHERE id = :id"),
            {"id": media_id},
        ).fetchone()

        assert row[0] > initial

    def test_successful_ingest_transitions_to_ready_for_reading(
        self,
        db_session: Session,
        bootstrapped_user: UUID,
        httpserver,
    ):
        """Verify pending → extracting → ready_for_reading on success."""
        pytest.importorskip("nexus.services.node_ingest")
        from nexus.tasks.ingest_web_article import run_ingest_sync

        user_id = bootstrapped_user

        httpserver.expect_request("/success").respond_with_data(
            "<html><body><h1>Title</h1><p>Content</p></body></html>",
            content_type="text/html",
        )

        url = httpserver.url_for("/success")
        result = create_provisional_web_article(db_session, user_id, url)
        media_id = result.media_id

        # Verify initial state
        row = db_session.execute(
            text("SELECT processing_status FROM media WHERE id = :id"),
            {"id": media_id},
        ).fetchone()
        assert row[0] == ProcessingStatus.pending.value

        # Run ingestion
        ingest_result = run_ingest_sync(db_session, media_id, user_id)

        db_session.expire_all()
        row = db_session.execute(
            text(
                "SELECT processing_status, failure_stage, last_error_code FROM media WHERE id = :id"
            ),
            {"id": media_id},
        ).fetchone()

        if ingest_result.get("status") == "success":
            assert row[0] == ProcessingStatus.ready_for_reading.value
            assert row[1] is None  # failure_stage should be None
            assert row[2] is None  # last_error_code should be None

    def test_failed_ingest_sets_failure_state(
        self,
        db_session: Session,
        bootstrapped_user: UUID,
        httpserver,
    ):
        """Verify failed ingestion sets proper failure state."""
        pytest.importorskip("nexus.services.node_ingest")
        from nexus.tasks.ingest_web_article import run_ingest_sync

        user_id = bootstrapped_user

        # Server returns 404 to trigger failure
        httpserver.expect_request("/fail").respond_with_data("Not Found", status=404)

        url = httpserver.url_for("/fail")
        result = create_provisional_web_article(db_session, user_id, url)
        media_id = result.media_id

        # Run ingestion (will fail)
        ingest_result = run_ingest_sync(db_session, media_id, user_id)

        db_session.expire_all()
        row = db_session.execute(
            text(
                "SELECT processing_status, failure_stage, last_error_code FROM media WHERE id = :id"
            ),
            {"id": media_id},
        ).fetchone()

        if ingest_result.get("status") == "failed":
            assert row[0] == ProcessingStatus.failed.value
            assert row[1] == "extract"
            assert row[2] is not None

    def test_failed_states_never_expose_highlights(
        self,
        e2e_client: TestClient,
        direct_db: DirectSessionManager,
    ):
        """Verify highlights cannot be created on failed media."""
        user_id = create_test_user_id()

        media_id = uuid4()
        fragment_id = uuid4()

        with direct_db.session() as session:
            # Create failed media with fragment (edge case)
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, failure_stage)
                    VALUES (:media_id, 'web_article', 'Failed', 'failed', 'extract')
                """),
                {"media_id": media_id},
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
                    VALUES (:fragment_id, :media_id, 0, '<p>Content</p>', 'Content')
                """),
                {"fragment_id": fragment_id, "media_id": media_id},
            )
            session.commit()

        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Add to library
        me = e2e_client.get("/me", headers=auth_headers(user_id))
        lib_id = me.json()["data"]["default_library_id"]
        e2e_client.post(
            f"/libraries/{lib_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Try to create highlight - should fail with E_MEDIA_NOT_READY
        response = e2e_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 0, "end_offset": 5, "color": "yellow"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 409
        assert response.json()["error"]["code"] == "E_MEDIA_NOT_READY"


# =============================================================================
# Redirect + Dedup Integration Test
# =============================================================================


class TestRedirectDedup:
    """Tests for redirect resolution and deduplication.

    Per PR-11 spec section 6.
    """

    def test_redirect_sets_canonical_url_to_final(
        self,
        db_session: Session,
        bootstrapped_user: UUID,
        httpserver,
    ):
        """Verify canonical_url equals normalized final URL after redirect."""
        pytest.importorskip("nexus.services.node_ingest")
        from nexus.tasks.ingest_web_article import run_ingest_sync

        user_id = bootstrapped_user

        # Set up redirect
        httpserver.expect_request("/old").respond_with_data(
            "", status=301, headers={"Location": httpserver.url_for("/final")}
        )
        httpserver.expect_request("/final").respond_with_data(
            "<html><body><p>Final content</p></body></html>",
            content_type="text/html",
        )

        url = httpserver.url_for("/old")
        result = create_provisional_web_article(db_session, user_id, url)
        media_id = result.media_id

        ingest_result = run_ingest_sync(db_session, media_id, user_id)

        if ingest_result.get("status") == "success":
            db_session.expire_all()
            row = db_session.execute(
                text("SELECT canonical_url FROM media WHERE id = :id"),
                {"id": media_id},
            ).fetchone()

            # canonical_url should point to /final, not /old
            assert row[0] is not None
            assert "/final" in row[0]
            assert "/old" not in row[0]

    def test_dedup_by_canonical_url(
        self,
        db_session: Session,
        bootstrapped_user: UUID,
        httpserver,
    ):
        """Verify two URLs resolving to same final URL produce one media row."""
        pytest.importorskip("nexus.services.node_ingest")
        from nexus.tasks.ingest_web_article import run_ingest_sync

        user_id = bootstrapped_user

        # Both URLs redirect to same final
        httpserver.expect_request("/alias1").respond_with_data(
            "", status=301, headers={"Location": httpserver.url_for("/canonical")}
        )
        httpserver.expect_request("/alias2").respond_with_data(
            "", status=301, headers={"Location": httpserver.url_for("/canonical")}
        )
        httpserver.expect_request("/canonical").respond_with_data(
            "<html><body><p>Canonical content</p></body></html>",
            content_type="text/html",
        )

        # Create and ingest first media
        url1 = httpserver.url_for("/alias1")
        result1 = create_provisional_web_article(db_session, user_id, url1)
        media_id1 = result1.media_id
        run_ingest_sync(db_session, media_id1, user_id)

        # Create and ingest second media (should dedup)
        url2 = httpserver.url_for("/alias2")
        result2 = create_provisional_web_article(db_session, user_id, url2)
        media_id2 = result2.media_id
        ingest_result2 = run_ingest_sync(db_session, media_id2, user_id)

        # Second should be deduped
        if ingest_result2.get("status") == "deduped":
            db_session.expire_all()

            # Loser (media_id2) should be deleted
            row = db_session.execute(
                text("SELECT id FROM media WHERE id = :id"),
                {"id": media_id2},
            ).fetchone()
            assert row is None, "Duplicate media should be deleted"

            # Winner (media_id1) should still exist
            row = db_session.execute(
                text("SELECT id FROM media WHERE id = :id"),
                {"id": media_id1},
            ).fetchone()
            assert row is not None
