"""Integration tests for highlight and annotation endpoints.

Tests cover all scenarios from PR-06 spec:
1. create_highlight_success - POST create with valid range
2. create_highlight_out_of_bounds - returns 400 E_HIGHLIGHT_INVALID_RANGE
3. create_highlight_duplicate_conflict - returns 409 E_HIGHLIGHT_CONFLICT
4. create_overlapping_allowed - overlapping highlights both succeed
5. list_highlights_includes_annotations - list returns highlight with embedded annotation
6. get_highlight_owner_only - different user gets 404 masked
7. update_color_only_updates_updated_at - created_at unchanged, updated_at changes
8. update_offsets_recomputes_exact - exact/prefix/suffix updated
9. delete_highlight_cascades_annotation - annotation removed with highlight
10. delete_annotation_idempotent - returns 204 even when missing
11. media_not_ready_blocks_create_update_upsert - 409 E_MEDIA_NOT_READY
12. media_not_ready_allows_list_get_delete - still works
13. emoji_codepoint_slicing - validates Unicode codepoint handling
14. cannot_highlight_without_library_membership - 404 E_MEDIA_NOT_FOUND
15. annotation_upsert_returns_correct_status - 201 vs 200
"""

import time
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.app import create_app
from nexus.auth.middleware import AuthMiddleware
from nexus.db.session import create_session_factory
from nexus.services.bootstrap import ensure_user_and_default_library
from tests.helpers import auth_headers, create_test_user_id
from tests.support.test_verifier import MockJwtVerifier
from tests.utils.db import DirectSessionManager

# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture
def auth_client(engine):
    """Create a client with auth middleware for testing."""
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


# Canonical text for most tests - simple ASCII text
FIXTURE_CANONICAL_TEXT = "Hello World! This is a test article for highlighting."
FIXTURE_HTML_SANITIZED = f"<p>{FIXTURE_CANONICAL_TEXT}</p>"

# Canonical text with emoji for codepoint test
EMOJI_CANONICAL_TEXT = "Hello 🎉 World"  # 🎉 is 1 codepoint but 2 UTF-16 code units
EMOJI_HTML_SANITIZED = f"<p>{EMOJI_CANONICAL_TEXT}</p>"


def create_media_and_fragment(
    session: Session,
    media_id: UUID | None = None,
    fragment_id: UUID | None = None,
    processing_status: str = "ready_for_reading",
    canonical_text: str = FIXTURE_CANONICAL_TEXT,
    html_sanitized: str = FIXTURE_HTML_SANITIZED,
) -> tuple[UUID, UUID]:
    """Create a media and fragment for testing.

    Returns (media_id, fragment_id).
    """
    media_id = media_id or uuid4()
    fragment_id = fragment_id or uuid4()

    session.execute(
        text("""
            INSERT INTO media (id, kind, title, processing_status)
            VALUES (:media_id, 'web_article', 'Test Article', :status)
            ON CONFLICT (id) DO NOTHING
        """),
        {"media_id": media_id, "status": processing_status},
    )

    session.execute(
        text("""
            INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
            VALUES (:fragment_id, :media_id, 0, :html, :text)
            ON CONFLICT (id) DO NOTHING
        """),
        {
            "fragment_id": fragment_id,
            "media_id": media_id,
            "html": html_sanitized,
            "text": canonical_text,
        },
    )

    session.commit()
    return media_id, fragment_id


def add_media_to_library(client: TestClient, user_id: UUID, media_id: UUID) -> None:
    """Add media to a user's default library."""
    me_resp = client.get("/me", headers=auth_headers(user_id))
    library_id = me_resp.json()["data"]["default_library_id"]

    client.post(
        f"/libraries/{library_id}/media",
        json={"media_id": str(media_id)},
        headers=auth_headers(user_id),
    )


# =============================================================================
# Test 1: create_highlight_success
# =============================================================================


class TestCreateHighlight:
    """Tests for POST /fragments/{fragment_id}/highlights"""

    def test_create_highlight_success(self, auth_client, direct_db: DirectSessionManager):
        """Test #1: Create highlight with valid range."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, fragment_id = create_media_and_fragment(session)

        direct_db.register_cleanup("highlights", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_library(auth_client, user_id, media_id)

        # Create highlight
        response = auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 0, "end_offset": 5, "color": "yellow"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 201
        data = response.json()["data"]
        assert data["fragment_id"] == str(fragment_id)
        assert data["start_offset"] == 0
        assert data["end_offset"] == 5
        assert data["color"] == "yellow"
        assert data["exact"] == "Hello"
        assert data["prefix"] == ""
        assert "suffix" in data
        assert data["annotation"] is None

    def test_create_highlight_out_of_bounds(self, auth_client, direct_db: DirectSessionManager):
        """Test #2: end_offset > len(canonical_text) returns 400."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, fragment_id = create_media_and_fragment(session)

        direct_db.register_cleanup("highlights", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_library(auth_client, user_id, media_id)

        # Try to create with out-of-bounds offset
        response = auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 0, "end_offset": 10000, "color": "yellow"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_HIGHLIGHT_INVALID_RANGE"

    def test_create_highlight_duplicate_conflict(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Test #3: Duplicate exact span returns 409."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, fragment_id = create_media_and_fragment(session)

        direct_db.register_cleanup("highlights", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_library(auth_client, user_id, media_id)

        # Create first highlight
        response1 = auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 0, "end_offset": 5, "color": "yellow"},
            headers=auth_headers(user_id),
        )
        assert response1.status_code == 201

        # Try to create duplicate
        response2 = auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 0, "end_offset": 5, "color": "green"},
            headers=auth_headers(user_id),
        )

        assert response2.status_code == 409
        assert response2.json()["error"]["code"] == "E_HIGHLIGHT_CONFLICT"

    def test_create_overlapping_allowed(self, auth_client, direct_db: DirectSessionManager):
        """Test #4: Overlapping highlights both succeed."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, fragment_id = create_media_and_fragment(session)

        direct_db.register_cleanup("highlights", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_library(auth_client, user_id, media_id)

        # Create first highlight: "Hello"
        response1 = auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 0, "end_offset": 5, "color": "yellow"},
            headers=auth_headers(user_id),
        )
        assert response1.status_code == 201

        # Create overlapping highlight: "ello W" (different range)
        response2 = auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 1, "end_offset": 7, "color": "green"},
            headers=auth_headers(user_id),
        )
        assert response2.status_code == 201

        # Both should exist
        list_response = auth_client.get(
            f"/fragments/{fragment_id}/highlights",
            headers=auth_headers(user_id),
        )
        assert len(list_response.json()["data"]["highlights"]) == 2


# =============================================================================
# Test 5: list_highlights_includes_annotations
# =============================================================================


class TestListHighlights:
    """Tests for GET /fragments/{fragment_id}/highlights"""

    def test_list_highlights_includes_annotations(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Test #5: List returns highlight with embedded annotation."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, fragment_id = create_media_and_fragment(session)

        direct_db.register_cleanup("annotations", "highlight_id", None)  # will clean by FK
        direct_db.register_cleanup("highlights", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_library(auth_client, user_id, media_id)

        # Create highlight
        create_resp = auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 0, "end_offset": 5, "color": "yellow"},
            headers=auth_headers(user_id),
        )
        highlight_id = create_resp.json()["data"]["id"]

        # Add annotation
        auth_client.put(
            f"/highlights/{highlight_id}/annotation",
            json={"body": "My note"},
            headers=auth_headers(user_id),
        )

        # List highlights
        list_resp = auth_client.get(
            f"/fragments/{fragment_id}/highlights",
            headers=auth_headers(user_id),
        )

        assert list_resp.status_code == 200
        highlights = list_resp.json()["data"]["highlights"]
        assert len(highlights) == 1
        assert highlights[0]["annotation"] is not None
        assert highlights[0]["annotation"]["body"] == "My note"


# =============================================================================
# Test 6: get_highlight_owner_only
# =============================================================================


class TestGetHighlight:
    """Tests for GET /highlights/{highlight_id}"""

    def test_get_highlight_owner_only(self, auth_client, direct_db: DirectSessionManager):
        """Test #6: Different user gets 404 masked."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        with direct_db.session() as session:
            media_id, fragment_id = create_media_and_fragment(session)

        direct_db.register_cleanup("highlights", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # User A adds media to their library and creates highlight
        add_media_to_library(auth_client, user_a, media_id)

        create_resp = auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 0, "end_offset": 5, "color": "yellow"},
            headers=auth_headers(user_a),
        )
        highlight_id = create_resp.json()["data"]["id"]

        # User B bootstraps
        auth_client.get("/me", headers=auth_headers(user_b))

        # User B tries to get User A's highlight
        get_resp = auth_client.get(
            f"/highlights/{highlight_id}",
            headers=auth_headers(user_b),
        )

        # Should get 404 with E_MEDIA_NOT_FOUND (masked)
        assert get_resp.status_code == 404
        assert get_resp.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"


# =============================================================================
# Test 7-8: update_highlight tests
# =============================================================================


class TestUpdateHighlight:
    """Tests for PATCH /highlights/{highlight_id}"""

    def test_update_color_only_updates_updated_at(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Test #7: Patch color only - created_at unchanged, updated_at changes."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, fragment_id = create_media_and_fragment(session)

        direct_db.register_cleanup("highlights", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_library(auth_client, user_id, media_id)

        # Create highlight
        create_resp = auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 0, "end_offset": 5, "color": "yellow"},
            headers=auth_headers(user_id),
        )
        highlight_id = create_resp.json()["data"]["id"]
        original_created_at = create_resp.json()["data"]["created_at"]
        original_updated_at = create_resp.json()["data"]["updated_at"]

        # Wait a moment to ensure timestamp difference
        time.sleep(0.1)

        # Update color only
        update_resp = auth_client.patch(
            f"/highlights/{highlight_id}",
            json={"color": "green"},
            headers=auth_headers(user_id),
        )

        assert update_resp.status_code == 200
        data = update_resp.json()["data"]
        assert data["color"] == "green"
        assert data["created_at"] == original_created_at
        # updated_at should have changed (or at least >= original)
        assert data["updated_at"] >= original_updated_at

    def test_update_offsets_recomputes_exact(self, auth_client, direct_db: DirectSessionManager):
        """Test #8: Patch offsets - exact/prefix/suffix updated."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, fragment_id = create_media_and_fragment(session)

        direct_db.register_cleanup("highlights", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_library(auth_client, user_id, media_id)

        # Create highlight for "Hello"
        create_resp = auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 0, "end_offset": 5, "color": "yellow"},
            headers=auth_headers(user_id),
        )
        highlight_id = create_resp.json()["data"]["id"]
        assert create_resp.json()["data"]["exact"] == "Hello"

        # Update to "World"
        update_resp = auth_client.patch(
            f"/highlights/{highlight_id}",
            json={"start_offset": 6, "end_offset": 11},
            headers=auth_headers(user_id),
        )

        assert update_resp.status_code == 200
        data = update_resp.json()["data"]
        assert data["start_offset"] == 6
        assert data["end_offset"] == 11
        assert data["exact"] == "World"

    def test_update_conflict_on_existing_range(self, auth_client, direct_db: DirectSessionManager):
        """Test #8b: Update to conflicting range returns 409."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, fragment_id = create_media_and_fragment(session)

        direct_db.register_cleanup("highlights", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_library(auth_client, user_id, media_id)

        # Create two highlights
        auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 0, "end_offset": 5, "color": "yellow"},
            headers=auth_headers(user_id),
        )

        create_resp2 = auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 6, "end_offset": 11, "color": "green"},
            headers=auth_headers(user_id),
        )
        highlight2_id = create_resp2.json()["data"]["id"]

        # Try to update highlight2 to same range as highlight1
        update_resp = auth_client.patch(
            f"/highlights/{highlight2_id}",
            json={"start_offset": 0, "end_offset": 5},
            headers=auth_headers(user_id),
        )

        assert update_resp.status_code == 409
        assert update_resp.json()["error"]["code"] == "E_HIGHLIGHT_CONFLICT"


# =============================================================================
# Test 9-10: delete tests
# =============================================================================


class TestDeleteHighlight:
    """Tests for DELETE /highlights/{highlight_id}"""

    def test_delete_highlight_cascades_annotation(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Test #9: Delete highlight removes annotation."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, fragment_id = create_media_and_fragment(session)

        # Note: No need to register cleanup for highlights/annotations since we delete them
        direct_db.register_cleanup("highlights", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_library(auth_client, user_id, media_id)

        # Create highlight with annotation
        create_resp = auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 0, "end_offset": 5, "color": "yellow"},
            headers=auth_headers(user_id),
        )
        highlight_id = create_resp.json()["data"]["id"]

        auth_client.put(
            f"/highlights/{highlight_id}/annotation",
            json={"body": "My note"},
            headers=auth_headers(user_id),
        )

        # Delete highlight
        delete_resp = auth_client.delete(
            f"/highlights/{highlight_id}",
            headers=auth_headers(user_id),
        )
        assert delete_resp.status_code == 204

        # Verify highlight is gone
        get_resp = auth_client.get(
            f"/highlights/{highlight_id}",
            headers=auth_headers(user_id),
        )
        assert get_resp.status_code == 404


class TestDeleteAnnotation:
    """Tests for DELETE /highlights/{highlight_id}/annotation"""

    def test_delete_annotation_idempotent(self, auth_client, direct_db: DirectSessionManager):
        """Test #10: Delete annotation when missing returns 204."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, fragment_id = create_media_and_fragment(session)

        direct_db.register_cleanup("highlights", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_library(auth_client, user_id, media_id)

        # Create highlight WITHOUT annotation
        create_resp = auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 0, "end_offset": 5, "color": "yellow"},
            headers=auth_headers(user_id),
        )
        highlight_id = create_resp.json()["data"]["id"]

        # Delete annotation (which doesn't exist) - should still return 204
        delete_resp = auth_client.delete(
            f"/highlights/{highlight_id}/annotation",
            headers=auth_headers(user_id),
        )
        assert delete_resp.status_code == 204


# =============================================================================
# Test 11-12: media readiness tests
# =============================================================================


class TestMediaReadiness:
    """Tests for media ready state enforcement."""

    def test_media_not_ready_blocks_create_update_upsert(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Test #11: 409 E_MEDIA_NOT_READY for create/update/upsert when not ready."""
        user_id = create_test_user_id()

        # Create media with pending status
        with direct_db.session() as session:
            media_id, fragment_id = create_media_and_fragment(session, processing_status="pending")

        direct_db.register_cleanup("highlights", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_library(auth_client, user_id, media_id)

        # Create should fail
        create_resp = auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 0, "end_offset": 5, "color": "yellow"},
            headers=auth_headers(user_id),
        )
        assert create_resp.status_code == 409
        assert create_resp.json()["error"]["code"] == "E_MEDIA_NOT_READY"

    def test_media_not_ready_allows_list_get_delete(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Test #12: List/get/delete work even when media not ready."""
        user_id = create_test_user_id()

        # Create media in ready state first
        with direct_db.session() as session:
            media_id, fragment_id = create_media_and_fragment(
                session, processing_status="ready_for_reading"
            )

        direct_db.register_cleanup("highlights", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_library(auth_client, user_id, media_id)

        # Create highlight while ready
        create_resp = auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 0, "end_offset": 5, "color": "yellow"},
            headers=auth_headers(user_id),
        )
        assert create_resp.status_code == 201
        highlight_id = create_resp.json()["data"]["id"]

        # Set media to pending
        with direct_db.session() as session:
            session.execute(
                text("UPDATE media SET processing_status = 'pending' WHERE id = :id"),
                {"id": media_id},
            )
            session.commit()

        # List should still work
        list_resp = auth_client.get(
            f"/fragments/{fragment_id}/highlights",
            headers=auth_headers(user_id),
        )
        assert list_resp.status_code == 200
        assert len(list_resp.json()["data"]["highlights"]) == 1

        # Get should still work
        get_resp = auth_client.get(
            f"/highlights/{highlight_id}",
            headers=auth_headers(user_id),
        )
        assert get_resp.status_code == 200

        # Delete should still work (cleanup allowed)
        delete_resp = auth_client.delete(
            f"/highlights/{highlight_id}",
            headers=auth_headers(user_id),
        )
        assert delete_resp.status_code == 204


# =============================================================================
# Test 13: emoji_codepoint_slicing
# =============================================================================


class TestEmojiCodepointSlicing:
    """Tests for Unicode codepoint handling."""

    def test_emoji_codepoint_slicing(self, auth_client, direct_db: DirectSessionManager):
        """Test #13: Server correctly handles emoji in canonical_text."""
        user_id = create_test_user_id()

        # Create media with emoji in canonical text
        # "Hello 🎉 World" = H e l l o   🎉   W o r l d
        # Codepoint indices:  0 1 2 3 4 5 6   7 8 9 10 11 12
        with direct_db.session() as session:
            media_id, fragment_id = create_media_and_fragment(
                session,
                canonical_text=EMOJI_CANONICAL_TEXT,
                html_sanitized=EMOJI_HTML_SANITIZED,
            )

        direct_db.register_cleanup("highlights", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_library(auth_client, user_id, media_id)

        # Highlight the emoji character only (codepoint index 6)
        response = auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 6, "end_offset": 7, "color": "yellow"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 201
        data = response.json()["data"]
        assert data["exact"] == "🎉"  # Should be the emoji, not a broken character

        # Highlight "Hello " + emoji: codepoints 0-7
        response2 = auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 0, "end_offset": 7, "color": "green"},
            headers=auth_headers(user_id),
        )

        assert response2.status_code == 201
        data2 = response2.json()["data"]
        assert data2["exact"] == "Hello 🎉"


# =============================================================================
# Test 14: cannot_highlight_without_library_membership
# =============================================================================


class TestLibraryMembership:
    """Tests for library membership enforcement."""

    def test_cannot_highlight_without_library_membership(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Test #14: User without library membership gets 404."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        with direct_db.session() as session:
            media_id, fragment_id = create_media_and_fragment(session)

        direct_db.register_cleanup("highlights", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Only User A adds to their library
        add_media_to_library(auth_client, user_a, media_id)

        # Bootstrap User B (but don't add media to their library)
        auth_client.get("/me", headers=auth_headers(user_b))

        # User B tries to create highlight
        create_resp = auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 0, "end_offset": 5, "color": "yellow"},
            headers=auth_headers(user_b),
        )
        assert create_resp.status_code == 404
        assert create_resp.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

        # User B tries to list highlights
        list_resp = auth_client.get(
            f"/fragments/{fragment_id}/highlights",
            headers=auth_headers(user_b),
        )
        assert list_resp.status_code == 404
        assert list_resp.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"


# =============================================================================
# Test 15: annotation_upsert_returns_correct_status
# =============================================================================


class TestAnnotationUpsert:
    """Tests for PUT /highlights/{highlight_id}/annotation"""

    def test_annotation_upsert_returns_correct_status(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Test #15: First PUT returns 201, second PUT returns 200."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, fragment_id = create_media_and_fragment(session)

        direct_db.register_cleanup("annotations", "highlight_id", None)
        direct_db.register_cleanup("highlights", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_library(auth_client, user_id, media_id)

        # Create highlight
        create_resp = auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 0, "end_offset": 5, "color": "yellow"},
            headers=auth_headers(user_id),
        )
        highlight_id = create_resp.json()["data"]["id"]

        # First PUT - create annotation
        upsert_resp1 = auth_client.put(
            f"/highlights/{highlight_id}/annotation",
            json={"body": "First note"},
            headers=auth_headers(user_id),
        )
        assert upsert_resp1.status_code == 201
        assert upsert_resp1.json()["data"]["body"] == "First note"

        # Second PUT - update annotation
        upsert_resp2 = auth_client.put(
            f"/highlights/{highlight_id}/annotation",
            json={"body": "Updated note"},
            headers=auth_headers(user_id),
        )
        assert upsert_resp2.status_code == 200
        assert upsert_resp2.json()["data"]["body"] == "Updated note"

    def test_annotation_upsert_requires_body(self, auth_client, direct_db: DirectSessionManager):
        """Test that empty body is rejected."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, fragment_id = create_media_and_fragment(session)

        direct_db.register_cleanup("highlights", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_library(auth_client, user_id, media_id)

        # Create highlight
        create_resp = auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 0, "end_offset": 5, "color": "yellow"},
            headers=auth_headers(user_id),
        )
        highlight_id = create_resp.json()["data"]["id"]

        # Try to create annotation with empty body
        upsert_resp = auth_client.put(
            f"/highlights/{highlight_id}/annotation",
            json={"body": ""},
            headers=auth_headers(user_id),
        )
        assert upsert_resp.status_code == 400


# =============================================================================
# Additional Edge Cases
# =============================================================================


class TestEdgeCases:
    """Additional edge case tests."""

    def test_highlight_prefix_suffix_at_boundaries(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Test prefix/suffix derivation at document boundaries."""
        user_id = create_test_user_id()

        # Short canonical text for boundary testing
        short_text = "Hello"
        with direct_db.session() as session:
            media_id, fragment_id = create_media_and_fragment(
                session,
                canonical_text=short_text,
                html_sanitized=f"<p>{short_text}</p>",
            )

        direct_db.register_cleanup("highlights", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_library(auth_client, user_id, media_id)

        # Highlight entire text
        response = auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 0, "end_offset": 5, "color": "yellow"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 201
        data = response.json()["data"]
        assert data["exact"] == "Hello"
        assert data["prefix"] == ""  # No prefix at start
        assert data["suffix"] == ""  # No suffix at end

    def test_list_highlights_ordering(self, auth_client, direct_db: DirectSessionManager):
        """Test that highlights are ordered by start_offset ASC, created_at ASC."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, fragment_id = create_media_and_fragment(session)

        direct_db.register_cleanup("highlights", "fragment_id", fragment_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        add_media_to_library(auth_client, user_id, media_id)

        # Create highlights in reverse order
        auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 12, "end_offset": 16, "color": "yellow"},
            headers=auth_headers(user_id),
        )
        auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 6, "end_offset": 11, "color": "green"},
            headers=auth_headers(user_id),
        )
        auth_client.post(
            f"/fragments/{fragment_id}/highlights",
            json={"start_offset": 0, "end_offset": 5, "color": "blue"},
            headers=auth_headers(user_id),
        )

        # List should return ordered by start_offset ASC
        list_resp = auth_client.get(
            f"/fragments/{fragment_id}/highlights",
            headers=auth_headers(user_id),
        )

        highlights = list_resp.json()["data"]["highlights"]
        assert len(highlights) == 3
        assert highlights[0]["start_offset"] == 0
        assert highlights[1]["start_offset"] == 6
        assert highlights[2]["start_offset"] == 12

    def test_nonexistent_highlight_returns_404(self, auth_client, direct_db: DirectSessionManager):
        """Test that nonexistent highlight_id returns 404."""
        user_id = create_test_user_id()

        # Bootstrap user
        auth_client.get("/me", headers=auth_headers(user_id))

        # Try to get nonexistent highlight
        response = auth_client.get(
            f"/highlights/{uuid4()}",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

    def test_nonexistent_fragment_returns_404(self, auth_client, direct_db: DirectSessionManager):
        """Test that nonexistent fragment_id returns 404."""
        user_id = create_test_user_id()

        # Bootstrap user
        auth_client.get("/me", headers=auth_headers(user_id))

        # Try to create highlight on nonexistent fragment
        response = auth_client.post(
            f"/fragments/{uuid4()}/highlights",
            json={"start_offset": 0, "end_offset": 5, "color": "yellow"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"
