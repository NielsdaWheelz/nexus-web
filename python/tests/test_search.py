"""Integration tests for keyword search service and routes.

Tests cover:
- Basic search functionality across all types
- Visibility enforcement (s4 provenance for media, highlight visibility for annotations,
  canonical conversation visibility for messages)
- Scope filtering (all, media, library, conversation)
- Type filtering
- Pagination
- Short/empty query handling
- Pending messages never searchable
- Invalid cursor handling
- No visibility leakage
- S4 shared annotation visibility and revocation
- S4 library-scope message search
- S4 conversation scope with shared-read visibility
- S4 media provenance (stale default-library rows)
- Response shape preservation
"""

from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from nexus.app import create_app
from nexus.auth.middleware import AuthMiddleware
from nexus.db.session import create_session_factory
from nexus.services.bootstrap import ensure_user_and_default_library
from tests.factories import (
    add_library_member,
    create_searchable_media,
    create_searchable_media_in_library,
    create_test_annotation,
    create_test_conversation,
    create_test_conversation_with_message,
    create_test_library,
    create_test_message,
    get_user_default_library,
    share_conversation_to_library,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.support.test_verifier import MockJwtVerifier
from tests.utils.db import DirectSessionManager

# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture
def auth_client(engine):
    """Create a client with auth middleware for testing."""
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

    return TestClient(app)


# =============================================================================
# Basic Search Tests
# =============================================================================


class TestBasicSearch:
    """Tests for basic search functionality."""

    def test_search_returns_empty_for_short_query(self, auth_client):
        """Search with < 2 chars returns empty results."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get("/search?q=a", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        assert data["results"] == []
        assert data["page"]["has_more"] is False

    def test_search_requires_query(self, auth_client):
        """Search without q param returns error."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get("/search", headers=auth_headers(user_id))

        assert response.status_code in (400, 422)  # FastAPI validation

    def test_search_finds_media_by_title(self, auth_client, direct_db: DirectSessionManager):
        """Search finds media by matching title."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Python Programming Guide")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get("/search?q=python+programming", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        assert len(data["results"]) >= 1

        # Should find the media
        media_results = [r for r in data["results"] if r["type"] == "media"]
        assert len(media_results) >= 1
        assert any(r["id"] == str(media_id) for r in media_results)

    def test_search_finds_fragments(self, auth_client, direct_db: DirectSessionManager):
        """Search finds fragments by canonical_text."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Test Article")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Search for content in fragment's canonical_text
        response = auth_client.get("/search?q=searchable+content", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        fragment_results = [r for r in data["results"] if r["type"] == "fragment"]
        assert len(fragment_results) >= 1

    def test_search_finds_annotations(self, auth_client, direct_db: DirectSessionManager):
        """Search finds annotations by body text."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Test Article")
            highlight_id, annotation_id = create_test_annotation(
                session, user_id, media_id, body="My unique annotation about databases"
            )

        direct_db.register_cleanup("annotations", "id", annotation_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get("/search?q=annotation+databases", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        annotation_results = [r for r in data["results"] if r["type"] == "annotation"]
        assert len(annotation_results) >= 1

    def test_search_finds_messages(self, auth_client, direct_db: DirectSessionManager):
        """Search finds messages in conversations."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            conversation_id, message_id = create_test_conversation_with_message(
                session, user_id, content="Important discussion about machine learning"
            )

        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        response = auth_client.get("/search?q=machine+learning", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        message_results = [r for r in data["results"] if r["type"] == "message"]
        assert len(message_results) >= 1


# =============================================================================
# Visibility Tests
# =============================================================================


class TestSearchVisibility:
    """Tests for search visibility enforcement."""

    def test_search_does_not_leak_other_users_media(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """User A cannot find User B's media via search."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        # User B creates media
        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_b, title="Secret Private Document")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # User A searches for it
        response = auth_client.get(
            "/search?q=secret+private+document", headers=auth_headers(user_a)
        )

        assert response.status_code == 200
        data = response.json()
        # Should not find User B's media
        media_results = [r for r in data["results"] if r["type"] == "media"]
        assert not any(r["id"] == str(media_id) for r in media_results)

    def test_search_does_not_leak_other_users_annotations(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """User A cannot find User B's annotations when they share no library."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        # User B creates media and annotation
        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_b, title="Shared Article")
            highlight_id, annotation_id = create_test_annotation(
                session, user_b, media_id, body="User B private annotation notes"
            )

        direct_db.register_cleanup("annotations", "id", annotation_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # User A searches for it
        response = auth_client.get(
            "/search?q=private+annotation+notes", headers=auth_headers(user_a)
        )

        assert response.status_code == 200
        data = response.json()
        # Should not find User B's annotation
        annotation_results = [r for r in data["results"] if r["type"] == "annotation"]
        assert not any(r["id"] == str(annotation_id) for r in annotation_results)

    def test_search_does_not_leak_other_users_messages(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """User A cannot find User B's messages via search."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        # User B creates conversation with message
        with direct_db.session() as session:
            conversation_id, message_id = create_test_conversation_with_message(
                session, user_b, content="Secret conversation about project alpha"
            )

        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        # User A searches for it
        response = auth_client.get("/search?q=secret+project+alpha", headers=auth_headers(user_a))

        assert response.status_code == 200
        data = response.json()
        # Should not find User B's message
        message_results = [r for r in data["results"] if r["type"] == "message"]
        assert not any(r["id"] == str(message_id) for r in message_results)

    def test_pending_messages_never_searchable(self, auth_client, direct_db: DirectSessionManager):
        """Pending messages are never returned in search results."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        # Create conversation with pending message (only assistant messages can be pending)
        with direct_db.session() as session:
            conversation_id, message_id = create_test_conversation_with_message(
                session,
                user_id,
                content="Pending message about quantum computing",
                status="pending",
                role="assistant",
            )

        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        # Search for it
        response = auth_client.get("/search?q=quantum+computing", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        # Should not find pending message
        message_results = [r for r in data["results"] if r["type"] == "message"]
        assert not any(r["id"] == str(message_id) for r in message_results)


# =============================================================================
# Scope Tests
# =============================================================================


class TestSearchScopes:
    """Tests for search scope filtering."""

    def test_scope_media_filters_results(self, auth_client, direct_db: DirectSessionManager):
        """Media scope only returns content from that media."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media1 = create_searchable_media(session, user_id, title="Programming Python Basics")
            media2 = create_searchable_media(session, user_id, title="Advanced Python Topics")

        direct_db.register_cleanup("fragments", "media_id", media1)
        direct_db.register_cleanup("fragments", "media_id", media2)
        direct_db.register_cleanup("library_media", "media_id", media1)
        direct_db.register_cleanup("library_media", "media_id", media2)
        direct_db.register_cleanup("media", "id", media1)
        direct_db.register_cleanup("media", "id", media2)

        # Search with media scope
        response = auth_client.get(
            f"/search?q=python&scope=media:{media1}", headers=auth_headers(user_id)
        )

        assert response.status_code == 200
        data = response.json()
        # Should only find content from media1
        for result in data["results"]:
            if result["type"] == "media":
                assert result["id"] == str(media1)
            elif result["type"] == "fragment":
                assert result["media_id"] == str(media1)

    def test_scope_media_not_found(self, auth_client):
        """Non-visible media scope returns 404."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(
            f"/search?q=test&scope=media:{uuid4()}", headers=auth_headers(user_id)
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_NOT_FOUND"

    def test_scope_library_filters_results(self, auth_client, direct_db: DirectSessionManager):
        """Library scope only returns content from media in that library."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            # Create a non-default library
            library_id = create_test_library(session, user_id, "Research Library")

            # Create media and add to library
            media_id = create_searchable_media(session, user_id, title="Research Paper on AI")

            # Also add to the non-default library
            session.execute(
                text("""
                    INSERT INTO library_media (library_id, media_id)
                    VALUES (:library_id, :media_id)
                    ON CONFLICT DO NOTHING
                """),
                {"library_id": library_id, "media_id": media_id},
            )
            session.commit()

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        # Search with library scope
        response = auth_client.get(
            f"/search?q=research&scope=library:{library_id}", headers=auth_headers(user_id)
        )

        assert response.status_code == 200

    def test_scope_library_not_found(self, auth_client):
        """Non-member library scope returns 404."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(
            f"/search?q=test&scope=library:{uuid4()}", headers=auth_headers(user_id)
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_NOT_FOUND"

    def test_scope_conversation_filters_messages(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Conversation scope only returns messages from that conversation."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            conv1, msg1 = create_test_conversation_with_message(
                session, user_id, content="Discussion about testing patterns"
            )
            conv2, msg2 = create_test_conversation_with_message(
                session, user_id, content="Different conversation about testing"
            )

        direct_db.register_cleanup("messages", "conversation_id", conv1)
        direct_db.register_cleanup("messages", "conversation_id", conv2)
        direct_db.register_cleanup("conversations", "id", conv1)
        direct_db.register_cleanup("conversations", "id", conv2)

        # Search with conversation scope
        response = auth_client.get(
            f"/search?q=testing&scope=conversation:{conv1}", headers=auth_headers(user_id)
        )

        assert response.status_code == 200
        data = response.json()
        # Should only find messages from conv1
        for result in data["results"]:
            if result["type"] == "message":
                assert result["conversation_id"] == str(conv1)

    def test_scope_conversation_not_found(self, auth_client):
        """Non-visible conversation scope returns 404."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(
            f"/search?q=test&scope=conversation:{uuid4()}", headers=auth_headers(user_id)
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_CONVERSATION_NOT_FOUND"

    def test_scope_invalid_format(self, auth_client):
        """Invalid scope format returns 400."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(
            "/search?q=test&scope=invalid:scope", headers=auth_headers(user_id)
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"


# =============================================================================
# Type Filtering Tests
# =============================================================================


class TestSearchTypeFiltering:
    """Tests for search type filtering."""

    def test_type_filter_media_only(self, auth_client, direct_db: DirectSessionManager):
        """Type filter returns only specified types."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(
                session, user_id, title="Python Programming Tutorial"
            )

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get("/search?q=python&types=media", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        # All results should be media type
        for result in data["results"]:
            assert result["type"] == "media"

    def test_type_filter_multiple_types(self, auth_client, direct_db: DirectSessionManager):
        """Multiple types filter works correctly."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Test Content Article")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            "/search?q=test&types=media,fragment", headers=auth_headers(user_id)
        )

        assert response.status_code == 200
        data = response.json()
        # Results should be media or fragment only
        for result in data["results"]:
            assert result["type"] in ("media", "fragment")

    def test_unknown_types_ignored(self, auth_client, direct_db: DirectSessionManager):
        """Unknown type values are silently ignored."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Test Article")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Include unknown type - should be ignored
        response = auth_client.get(
            "/search?q=test&types=media,invalid_type,fragment", headers=auth_headers(user_id)
        )

        assert response.status_code == 200


# =============================================================================
# Pagination Tests
# =============================================================================


class TestSearchPagination:
    """Tests for search pagination."""

    def test_pagination_limit_default(self, auth_client, direct_db: DirectSessionManager):
        """Default limit is 20."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        # Create many media items
        media_ids = []
        with direct_db.session() as session:
            for i in range(25):
                media_id = create_searchable_media(session, user_id, title=f"Test Article {i}")
                media_ids.append(media_id)

        for mid in media_ids:
            direct_db.register_cleanup("fragments", "media_id", mid)
            direct_db.register_cleanup("library_media", "media_id", mid)
            direct_db.register_cleanup("media", "id", mid)

        response = auth_client.get("/search?q=test+article", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        assert len(data["results"]) <= 20
        # Should have more results
        assert data["page"]["has_more"] is True
        assert data["page"]["next_cursor"] is not None

    def test_pagination_with_cursor(self, auth_client, direct_db: DirectSessionManager):
        """Pagination with cursor returns next page."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        # Create enough media for pagination
        media_ids = []
        with direct_db.session() as session:
            for i in range(10):
                media_id = create_searchable_media(session, user_id, title=f"Searchable Item {i}")
                media_ids.append(media_id)

        for mid in media_ids:
            direct_db.register_cleanup("fragments", "media_id", mid)
            direct_db.register_cleanup("library_media", "media_id", mid)
            direct_db.register_cleanup("media", "id", mid)

        # First page
        response1 = auth_client.get(
            "/search?q=searchable+item&limit=3", headers=auth_headers(user_id)
        )
        assert response1.status_code == 200
        data1 = response1.json()
        assert len(data1["results"]) == 3
        assert data1["page"]["next_cursor"] is not None

        # Second page
        cursor = data1["page"]["next_cursor"]
        response2 = auth_client.get(
            f"/search?q=searchable+item&limit=3&cursor={cursor}",
            headers=auth_headers(user_id),
        )
        assert response2.status_code == 200
        data2 = response2.json()
        assert len(data2["results"]) >= 1

        # Results should not overlap
        ids1 = {r["id"] for r in data1["results"]}
        ids2 = {r["id"] for r in data2["results"]}
        assert ids1.isdisjoint(ids2)

    def test_pagination_limit_clamped(self, auth_client):
        """Limit > 50 returns 422."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get("/search?q=test&limit=100", headers=auth_headers(user_id))

        assert response.status_code in (400, 422)

    def test_invalid_cursor(self, auth_client):
        """Invalid cursor returns 400."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(
            "/search?q=test&cursor=invalid!!!cursor", headers=auth_headers(user_id)
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_CURSOR"


# =============================================================================
# Result Format Tests
# =============================================================================


class TestSearchResultFormat:
    """Tests for search result format."""

    def test_media_result_has_required_fields(self, auth_client, direct_db: DirectSessionManager):
        """Media results include id and title."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Unique Title For Test")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            "/search?q=unique+title&types=media", headers=auth_headers(user_id)
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["results"]) >= 1

        result = data["results"][0]
        assert "id" in result
        assert "type" in result
        assert "score" in result
        assert "snippet" in result
        assert result["type"] == "media"
        assert "title" in result

    def test_fragment_result_has_required_fields(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Fragment results include id, media_id, idx."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Test Article")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get(
            "/search?q=canonical+text&types=fragment", headers=auth_headers(user_id)
        )

        assert response.status_code == 200
        data = response.json()

        if len(data["results"]) >= 1:
            result = data["results"][0]
            assert result["type"] == "fragment"
            assert "media_id" in result
            assert "idx" in result

    def test_message_result_has_required_fields(self, auth_client, direct_db: DirectSessionManager):
        """Message results include id, conversation_id, seq."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            conversation_id, message_id = create_test_conversation_with_message(
                session, user_id, content="Unique searchable message content here"
            )

        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        response = auth_client.get(
            "/search?q=unique+searchable+message&types=message", headers=auth_headers(user_id)
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["results"]) >= 1

        result = data["results"][0]
        assert result["type"] == "message"
        assert "conversation_id" in result
        assert "seq" in result

    def test_snippet_max_length(self, auth_client, direct_db: DirectSessionManager):
        """Snippets are truncated to max 300 chars."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Test")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get("/search?q=test", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        for result in data["results"]:
            # Snippet should be <= 303 (300 + "...")
            assert len(result["snippet"]) <= 303


# =============================================================================
# S4 Search Alignment Tests
# =============================================================================


class TestSearchS4ConversationScope:
    """Tests for s4 conversation scope using shared-read visibility."""

    def test_scope_conversation_shared_reader_allowed_by_read_visibility(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Shared reader can search messages within a conversation via scope.

        Conversation owned by user_a, shared to library L.
        user_b is member of L. user_b can scope-search the conversation.
        """
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            library_id = create_test_library(session, user_a, "Shared Convo Lib")
            add_library_member(session, library_id, user_b)

            conversation_id = create_test_conversation(session, user_a, sharing="private")
            msg_id = create_test_message(
                session,
                conversation_id,
                seq=1,
                content="Searchable conversation scope alignment content",
            )
            share_conversation_to_library(session, conversation_id, library_id)

        direct_db.register_cleanup("conversation_shares", "conversation_id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        response = auth_client.get(
            f"/search?q=scope+alignment+content&scope=conversation:{conversation_id}&types=message",
            headers=auth_headers(user_b),
        )

        assert response.status_code == 200
        data = response.json()
        message_results = [r for r in data["results"] if r["type"] == "message"]
        assert len(message_results) >= 1
        assert any(r["id"] == str(msg_id) for r in message_results)

    def test_scope_conversation_not_found_for_non_visible(self, auth_client):
        """Non-visible conversation scope still returns masked 404."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(
            f"/search?q=test&scope=conversation:{uuid4()}", headers=auth_headers(user_id)
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_CONVERSATION_NOT_FOUND"


class TestSearchS4AnnotationVisibility:
    """Tests for s4 annotation visibility via highlight shared-read semantics."""

    def test_search_annotations_include_shared_visible_results(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Shared-visible annotations are returned in search.

        media M in shared library L; user_a authors highlight+annotation on M;
        user_b is member of L and sees annotation.
        """
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            library_id = create_test_library(session, user_a, "Annotation Share Lib")
            add_library_member(session, library_id, user_b)

            media_id = create_searchable_media_in_library(
                session, user_a, library_id, title="Shared Annotation Article"
            )
            highlight_id, annotation_id = create_test_annotation(
                session, user_a, media_id, body="Unique shared annotation searchterm xylophone"
            )

        direct_db.register_cleanup("annotations", "id", annotation_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        response = auth_client.get(
            "/search?q=xylophone&types=annotation", headers=auth_headers(user_b)
        )

        assert response.status_code == 200
        data = response.json()
        annotation_results = [r for r in data["results"] if r["type"] == "annotation"]
        assert any(r["id"] == str(annotation_id) for r in annotation_results)

    def test_search_annotations_hidden_after_membership_revocation(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """After revoking shared library membership, annotations become invisible.

        Start from visible shared-annotation setup, then revoke user_b from
        the intersecting library.
        """
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            library_id = create_test_library(session, user_a, "Revocation Test Lib")
            add_library_member(session, library_id, user_b)

            media_id = create_searchable_media_in_library(
                session, user_a, library_id, title="Revocation Annotation Article"
            )
            highlight_id, annotation_id = create_test_annotation(
                session, user_a, media_id, body="Revocation test annotation trombone"
            )

        direct_db.register_cleanup("annotations", "id", annotation_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        # Verify visible before revocation
        resp_before = auth_client.get(
            "/search?q=trombone&types=annotation", headers=auth_headers(user_b)
        )
        assert resp_before.status_code == 200
        before_ids = [r["id"] for r in resp_before.json()["results"]]
        assert str(annotation_id) in before_ids

        # Revoke membership
        with direct_db.session() as session:
            session.execute(
                text("""
                    DELETE FROM memberships
                    WHERE library_id = :library_id AND user_id = :user_id
                """),
                {"library_id": library_id, "user_id": user_b},
            )
            session.commit()

        # Verify invisible after revocation
        resp_after = auth_client.get(
            "/search?q=trombone&types=annotation", headers=auth_headers(user_b)
        )
        assert resp_after.status_code == 200
        after_ids = [r["id"] for r in resp_after.json()["results"]]
        assert str(annotation_id) not in after_ids


class TestSearchS4LibraryScopeMessages:
    """Tests for s4 library-scope message search."""

    def test_scope_library_message_search_includes_only_target_shared_conversations(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Library-scope message search returns only conversations shared to that library.

        c1 shared to l1, c2 shared to l2; viewer_b member of l1 only.
        scope=library:l1 returns messages from c1 only.
        """
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            l1 = create_test_library(session, user_a, "Library Scope L1")
            l2 = create_test_library(session, user_a, "Library Scope L2")
            add_library_member(session, l1, user_b)

            c1 = create_test_conversation(session, user_a)
            create_test_message(
                session, c1, seq=1, content="Library scope target message xylophonist"
            )
            share_conversation_to_library(session, c1, l1)

            c2 = create_test_conversation(session, user_a)
            msg2_id = create_test_message(
                session, c2, seq=1, content="Library scope excluded message xylophonist"
            )
            share_conversation_to_library(session, c2, l2)

        direct_db.register_cleanup("conversation_shares", "conversation_id", c1)
        direct_db.register_cleanup("conversation_shares", "conversation_id", c2)
        direct_db.register_cleanup("messages", "conversation_id", c1)
        direct_db.register_cleanup("messages", "conversation_id", c2)
        direct_db.register_cleanup("conversations", "id", c1)
        direct_db.register_cleanup("conversations", "id", c2)
        direct_db.register_cleanup("memberships", "library_id", l1)
        direct_db.register_cleanup("memberships", "library_id", l2)
        direct_db.register_cleanup("libraries", "id", l1)
        direct_db.register_cleanup("libraries", "id", l2)

        response = auth_client.get(
            f"/search?q=xylophonist&scope=library:{l1}&types=message",
            headers=auth_headers(user_b),
        )

        assert response.status_code == 200
        data = response.json()
        msg_results = [r for r in data["results"] if r["type"] == "message"]
        msg_ids = [r["id"] for r in msg_results]

        # c1 messages may appear
        # c2 messages must not appear (not shared to l1)
        assert str(msg2_id) not in msg_ids

    def test_scope_library_message_search_excludes_visible_but_unshared_conversations(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Visible conversations not shared to target library are excluded from library-scope.

        viewer owns a private conversation. It's visible to viewer but not shared
        to target library. Library-scope search must exclude it.
        """
        user_a = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))

        with direct_db.session() as session:
            l1 = create_test_library(session, user_a, "Lib Scope Exclusion Test")

            # Private conversation owned by user_a (visible to user_a, not shared to l1)
            c_private, msg_private_id = create_test_conversation_with_message(
                session, user_a, content="Private unshared library scope xylophone"
            )

        direct_db.register_cleanup("messages", "conversation_id", c_private)
        direct_db.register_cleanup("conversations", "id", c_private)
        direct_db.register_cleanup("memberships", "library_id", l1)
        direct_db.register_cleanup("libraries", "id", l1)

        response = auth_client.get(
            f"/search?q=xylophone&scope=library:{l1}&types=message",
            headers=auth_headers(user_a),
        )

        assert response.status_code == 200
        data = response.json()
        msg_ids = [r["id"] for r in data["results"] if r["type"] == "message"]
        assert str(msg_private_id) not in msg_ids

    def test_scope_library_message_search_requires_library_sharing_state(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Conversation with share row but sharing != 'library' is excluded.

        A conversation that is 'public' but has a stale share row to the
        target library should not appear in library-scope message results.
        """
        user_a = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))

        with direct_db.session() as session:
            l1 = create_test_library(session, user_a, "Lib Share State Test")

            c_public = create_test_conversation(session, user_a, sharing="public")
            msg_id = create_test_message(
                session, c_public, seq=1, content="Public stale share row xylophone"
            )
            # Insert a stale share row without setting sharing='library'
            session.execute(
                text("""
                    INSERT INTO conversation_shares (conversation_id, library_id)
                    VALUES (:cid, :lid)
                    ON CONFLICT DO NOTHING
                """),
                {"cid": c_public, "lid": l1},
            )
            session.commit()

        direct_db.register_cleanup("conversation_shares", "conversation_id", c_public)
        direct_db.register_cleanup("messages", "conversation_id", c_public)
        direct_db.register_cleanup("conversations", "id", c_public)
        direct_db.register_cleanup("memberships", "library_id", l1)
        direct_db.register_cleanup("libraries", "id", l1)

        response = auth_client.get(
            f"/search?q=xylophone&scope=library:{l1}&types=message",
            headers=auth_headers(user_a),
        )

        assert response.status_code == 200
        data = response.json()
        msg_ids = [r["id"] for r in data["results"] if r["type"] == "message"]
        assert str(msg_id) not in msg_ids


class TestSearchS4ResponseShape:
    """Tests for response shape preservation."""

    def test_search_response_shape_remains_results_page(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Response has top-level 'results' and 'page', no envelope migration."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Shape Test Article")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get("/search?q=shape+test", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        assert "results" in data
        assert "page" in data
        assert isinstance(data["results"], list)
        assert isinstance(data["page"], dict)
        assert "has_more" in data["page"]
        assert "next_cursor" in data["page"]
        # No envelope wrapper like {"data": ...}
        assert "data" not in data
        assert "error" not in data


class TestSearchS4Provenance:
    """Tests for s4 media provenance in search visibility."""

    def test_search_does_not_return_stale_default_library_rows_without_intrinsic_or_closure(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Stale default library_media without intrinsic or closure is not searchable.

        Create a library_media row for the user's default library without any
        intrinsic or closure-edge provenance. Search must not return it.
        """
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            default_lib_id = get_user_default_library(session, user_id)
            assert default_lib_id is not None

            media_id = uuid4()
            fragment_id = uuid4()
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status)
                    VALUES (:id, 'web_article', :title, 'ready_for_reading')
                """),
                {"id": media_id, "title": "Stale provenance glockenspiel article"},
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
                    VALUES (:id, :media_id, 0, '<p>Content</p>', :text)
                """),
                {
                    "id": fragment_id,
                    "media_id": media_id,
                    "text": "Stale provenance glockenspiel fragment content",
                },
            )
            # Insert library_media WITHOUT intrinsic or closure (stale row)
            session.execute(
                text("""
                    INSERT INTO library_media (library_id, media_id)
                    VALUES (:lib_id, :media_id)
                """),
                {"lib_id": default_lib_id, "media_id": media_id},
            )
            session.commit()

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get("/search?q=glockenspiel", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()
        all_ids = [r["id"] for r in data["results"]]
        assert str(media_id) not in all_ids
        fragment_ids = [r["id"] for r in data["results"] if r["type"] == "fragment"]
        assert str(fragment_id) not in fragment_ids


class TestSearchS4ScopeMasking:
    """Tests for scope authorization masking with typed 404s."""

    def test_scope_media_unauthorized_returns_not_found(self, auth_client):
        """Unauthorized media scope returns 404 E_NOT_FOUND."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(
            f"/search?q=test&scope=media:{uuid4()}", headers=auth_headers(user_id)
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_NOT_FOUND"

    def test_scope_library_unauthorized_returns_not_found(self, auth_client):
        """Unauthorized library scope returns 404 E_NOT_FOUND."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(
            f"/search?q=test&scope=library:{uuid4()}", headers=auth_headers(user_id)
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_NOT_FOUND"

    def test_scope_conversation_unauthorized_returns_conversation_not_found(self, auth_client):
        """Unauthorized conversation scope returns 404 E_CONVERSATION_NOT_FOUND."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(
            f"/search?q=test&scope=conversation:{uuid4()}", headers=auth_headers(user_id)
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_CONVERSATION_NOT_FOUND"
