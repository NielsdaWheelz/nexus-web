"""Integration tests for conversations and messages service and routes.

Tests cover:
- Conversation CRUD operations
- Message listing and deletion
- Cursor-based pagination
- Delete last message auto-deletes conversation
- Owner-only access with masked 404s
- Visibility isolation between users
"""

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


def create_test_conversation(
    session: Session,
    owner_user_id: UUID,
    sharing: str = "private",
) -> UUID:
    """Create a test conversation directly in the database."""
    conversation_id = uuid4()
    session.execute(
        text("""
            INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
            VALUES (:id, :owner_user_id, :sharing, 1)
        """),
        {"id": conversation_id, "owner_user_id": owner_user_id, "sharing": sharing},
    )
    session.commit()
    return conversation_id


def create_test_message(
    session: Session,
    conversation_id: UUID,
    seq: int,
    role: str = "user",
    content: str = "Test message",
) -> UUID:
    """Create a test message directly in the database."""
    message_id = uuid4()
    session.execute(
        text("""
            INSERT INTO messages (id, conversation_id, seq, role, content, status)
            VALUES (:id, :conversation_id, :seq, :role, :content, 'complete')
        """),
        {
            "id": message_id,
            "conversation_id": conversation_id,
            "seq": seq,
            "role": role,
            "content": content,
        },
    )
    # Update next_seq
    session.execute(
        text("""
            UPDATE conversations SET next_seq = :next_seq WHERE id = :id
        """),
        {"next_seq": seq + 1, "id": conversation_id},
    )
    session.commit()
    return message_id


# =============================================================================
# Conversation Create Tests
# =============================================================================


class TestCreateConversation:
    """Tests for POST /conversations endpoint."""

    def test_create_conversation_success(self, auth_client):
        """Create conversation returns 201 with conversation data."""
        user_id = create_test_user_id()

        response = auth_client.post(
            "/conversations",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 201
        data = response.json()["data"]
        assert data["sharing"] == "private"
        assert data["message_count"] == 0
        assert "id" in data
        assert "created_at" in data
        assert "updated_at" in data

    def test_create_conversation_is_private(self, auth_client, direct_db: DirectSessionManager):
        """New conversations are always private."""
        user_id = create_test_user_id()

        response = auth_client.post(
            "/conversations",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 201
        conversation_id = response.json()["data"]["id"]

        # Verify in DB
        with direct_db.session() as session:
            result = session.execute(
                text("SELECT sharing FROM conversations WHERE id = :id"),
                {"id": conversation_id},
            )
            row = result.fetchone()
            assert row is not None
            assert row[0] == "private"


# =============================================================================
# Conversation List Tests
# =============================================================================


class TestListConversations:
    """Tests for GET /conversations endpoint."""

    def test_list_conversations_empty(self, auth_client):
        """List conversations returns empty list for new user."""
        user_id = create_test_user_id()

        response = auth_client.get("/conversations", headers=auth_headers(user_id))

        assert response.status_code == 200
        assert response.json()["data"] == []
        assert response.json()["page"]["next_cursor"] is None

    def test_list_conversations_returns_owned(self, auth_client):
        """List conversations returns only owned conversations."""
        user_id = create_test_user_id()

        # Create 3 conversations
        for _ in range(3):
            auth_client.post("/conversations", headers=auth_headers(user_id))

        response = auth_client.get("/conversations", headers=auth_headers(user_id))

        assert response.status_code == 200
        assert len(response.json()["data"]) == 3

    def test_list_conversations_ordering(self, auth_client, direct_db: DirectSessionManager):
        """Conversations are ordered by updated_at DESC."""
        user_id = create_test_user_id()

        # Create conversations
        resp1 = auth_client.post("/conversations", headers=auth_headers(user_id))
        resp2 = auth_client.post("/conversations", headers=auth_headers(user_id))
        resp3 = auth_client.post("/conversations", headers=auth_headers(user_id))

        # List should return newest first
        response = auth_client.get("/conversations", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) == 3
        # Newest should be first (resp3)
        assert data[0]["id"] == resp3.json()["data"]["id"]
        assert data[1]["id"] == resp2.json()["data"]["id"]
        assert data[2]["id"] == resp1.json()["data"]["id"]

    def test_list_conversations_pagination(self, auth_client):
        """Pagination with cursor works correctly."""
        user_id = create_test_user_id()

        # Create 5 conversations
        for _ in range(5):
            auth_client.post("/conversations", headers=auth_headers(user_id))

        # First page
        response1 = auth_client.get("/conversations?limit=2", headers=auth_headers(user_id))
        assert response1.status_code == 200
        data1 = response1.json()
        assert len(data1["data"]) == 2
        assert data1["page"]["next_cursor"] is not None

        # Second page
        cursor = data1["page"]["next_cursor"]
        response2 = auth_client.get(
            f"/conversations?limit=2&cursor={cursor}", headers=auth_headers(user_id)
        )
        assert response2.status_code == 200
        data2 = response2.json()
        assert len(data2["data"]) == 2
        assert data2["page"]["next_cursor"] is not None

        # Third page (last)
        cursor2 = data2["page"]["next_cursor"]
        response3 = auth_client.get(
            f"/conversations?limit=2&cursor={cursor2}", headers=auth_headers(user_id)
        )
        assert response3.status_code == 200
        data3 = response3.json()
        assert len(data3["data"]) == 1
        assert data3["page"]["next_cursor"] is None

        # Verify no duplicates
        all_ids = [c["id"] for c in data1["data"] + data2["data"] + data3["data"]]
        assert len(all_ids) == len(set(all_ids)) == 5

    def test_list_conversations_limit_clamped(self, auth_client):
        """Limit > 100 is rejected by FastAPI validation."""
        user_id = create_test_user_id()

        # FastAPI Query validation (le=100) rejects values > 100
        response = auth_client.get("/conversations?limit=200", headers=auth_headers(user_id))

        # FastAPI Query validation returns 422, which our handler maps to 400
        assert response.status_code in (400, 422)

    def test_list_conversations_invalid_cursor(self, auth_client):
        """Invalid cursor returns 400 E_INVALID_CURSOR."""
        user_id = create_test_user_id()

        response = auth_client.get(
            "/conversations?cursor=not-valid-base64!!!", headers=auth_headers(user_id)
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_CURSOR"


# =============================================================================
# Conversation Get Tests
# =============================================================================


class TestGetConversation:
    """Tests for GET /conversations/:id endpoint."""

    def test_get_conversation_success(self, auth_client):
        """Get conversation returns conversation data."""
        user_id = create_test_user_id()

        create_resp = auth_client.post("/conversations", headers=auth_headers(user_id))
        conversation_id = create_resp.json()["data"]["id"]

        response = auth_client.get(
            f"/conversations/{conversation_id}", headers=auth_headers(user_id)
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["id"] == conversation_id
        assert data["sharing"] == "private"
        assert data["message_count"] == 0

    def test_get_conversation_not_found(self, auth_client):
        """Get non-existent conversation returns 404."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))  # Bootstrap

        response = auth_client.get(f"/conversations/{uuid4()}", headers=auth_headers(user_id))

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_CONVERSATION_NOT_FOUND"

    def test_get_conversation_not_owner(self, auth_client, direct_db: DirectSessionManager):
        """Non-owner cannot get conversation (masked as 404)."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        # User A creates conversation
        create_resp = auth_client.post("/conversations", headers=auth_headers(user_a))
        conversation_id = create_resp.json()["data"]["id"]

        # User B tries to get it
        auth_client.get("/me", headers=auth_headers(user_b))  # Bootstrap
        response = auth_client.get(
            f"/conversations/{conversation_id}", headers=auth_headers(user_b)
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_CONVERSATION_NOT_FOUND"


# =============================================================================
# Conversation Delete Tests
# =============================================================================


class TestDeleteConversation:
    """Tests for DELETE /conversations/:id endpoint."""

    def test_delete_conversation_success(self, auth_client, direct_db: DirectSessionManager):
        """Delete conversation returns 204."""
        user_id = create_test_user_id()

        create_resp = auth_client.post("/conversations", headers=auth_headers(user_id))
        conversation_id = create_resp.json()["data"]["id"]

        response = auth_client.delete(
            f"/conversations/{conversation_id}", headers=auth_headers(user_id)
        )

        assert response.status_code == 204

        # Verify deleted
        with direct_db.session() as session:
            result = session.execute(
                text("SELECT 1 FROM conversations WHERE id = :id"),
                {"id": conversation_id},
            )
            assert result.fetchone() is None

    def test_delete_conversation_not_found(self, auth_client):
        """Delete non-existent conversation returns 404."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.delete(f"/conversations/{uuid4()}", headers=auth_headers(user_id))

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_CONVERSATION_NOT_FOUND"

    def test_delete_conversation_not_owner(self, auth_client):
        """Non-owner cannot delete conversation (masked as 404)."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        create_resp = auth_client.post("/conversations", headers=auth_headers(user_a))
        conversation_id = create_resp.json()["data"]["id"]

        auth_client.get("/me", headers=auth_headers(user_b))
        response = auth_client.delete(
            f"/conversations/{conversation_id}", headers=auth_headers(user_b)
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_CONVERSATION_NOT_FOUND"

    def test_delete_conversation_cascades_messages(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Deleting conversation cascades to messages."""
        user_id = create_test_user_id()

        # Bootstrap user
        auth_client.get("/me", headers=auth_headers(user_id))

        # Create conversation with messages using direct_db
        with direct_db.session() as session:
            result = session.execute(
                text("SELECT id FROM users WHERE id = :id"),
                {"id": user_id},
            )
            assert result.fetchone() is not None

            conversation_id = create_test_conversation(session, user_id)
            create_test_message(session, conversation_id, seq=1)
            create_test_message(session, conversation_id, seq=2)

        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        # Verify messages exist
        with direct_db.session() as session:
            result = session.execute(
                text("SELECT COUNT(*) FROM messages WHERE conversation_id = :id"),
                {"id": conversation_id},
            )
            assert result.scalar() == 2

        # Delete conversation
        response = auth_client.delete(
            f"/conversations/{conversation_id}", headers=auth_headers(user_id)
        )
        assert response.status_code == 204

        # Verify messages deleted (cascade)
        with direct_db.session() as session:
            result = session.execute(
                text("SELECT COUNT(*) FROM messages WHERE conversation_id = :id"),
                {"id": conversation_id},
            )
            assert result.scalar() == 0


# =============================================================================
# Message List Tests
# =============================================================================


class TestListMessages:
    """Tests for GET /conversations/:id/messages endpoint."""

    def test_list_messages_empty(self, auth_client):
        """List messages for empty conversation returns empty list."""
        user_id = create_test_user_id()

        create_resp = auth_client.post("/conversations", headers=auth_headers(user_id))
        conversation_id = create_resp.json()["data"]["id"]

        response = auth_client.get(
            f"/conversations/{conversation_id}/messages", headers=auth_headers(user_id)
        )

        assert response.status_code == 200
        assert response.json()["data"] == []
        assert response.json()["page"]["next_cursor"] is None

    def test_list_messages_returns_messages(self, auth_client, direct_db: DirectSessionManager):
        """List messages returns messages in seq ASC order."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_id)
            create_test_message(session, conversation_id, seq=1, content="First")
            create_test_message(session, conversation_id, seq=2, content="Second")
            create_test_message(session, conversation_id, seq=3, content="Third")

        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        response = auth_client.get(
            f"/conversations/{conversation_id}/messages", headers=auth_headers(user_id)
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) == 3
        # Oldest first (ASC order)
        assert data[0]["seq"] == 1
        assert data[0]["content"] == "First"
        assert data[1]["seq"] == 2
        assert data[2]["seq"] == 3

    def test_list_messages_pagination(self, auth_client, direct_db: DirectSessionManager):
        """Message pagination works correctly."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_id)
            for i in range(1, 6):
                create_test_message(session, conversation_id, seq=i, content=f"Msg {i}")

        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        # First page
        resp1 = auth_client.get(
            f"/conversations/{conversation_id}/messages?limit=2",
            headers=auth_headers(user_id),
        )
        assert resp1.status_code == 200
        data1 = resp1.json()
        assert len(data1["data"]) == 2
        assert data1["data"][0]["seq"] == 1
        assert data1["data"][1]["seq"] == 2
        assert data1["page"]["next_cursor"] is not None

        # Second page
        cursor = data1["page"]["next_cursor"]
        resp2 = auth_client.get(
            f"/conversations/{conversation_id}/messages?limit=2&cursor={cursor}",
            headers=auth_headers(user_id),
        )
        assert resp2.status_code == 200
        data2 = resp2.json()
        assert len(data2["data"]) == 2
        assert data2["data"][0]["seq"] == 3
        assert data2["data"][1]["seq"] == 4

        # Third page (last)
        cursor2 = data2["page"]["next_cursor"]
        resp3 = auth_client.get(
            f"/conversations/{conversation_id}/messages?limit=2&cursor={cursor2}",
            headers=auth_headers(user_id),
        )
        assert resp3.status_code == 200
        data3 = resp3.json()
        assert len(data3["data"]) == 1
        assert data3["data"][0]["seq"] == 5
        assert data3["page"]["next_cursor"] is None

    def test_list_messages_conversation_not_found(self, auth_client):
        """List messages for non-existent conversation returns 404."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(
            f"/conversations/{uuid4()}/messages", headers=auth_headers(user_id)
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_CONVERSATION_NOT_FOUND"

    def test_list_messages_not_owner(self, auth_client, direct_db: DirectSessionManager):
        """Non-owner cannot list messages (masked as 404)."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_a)

        direct_db.register_cleanup("conversations", "id", conversation_id)

        response = auth_client.get(
            f"/conversations/{conversation_id}/messages", headers=auth_headers(user_b)
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_CONVERSATION_NOT_FOUND"


# =============================================================================
# Message Delete Tests
# =============================================================================


class TestDeleteMessage:
    """Tests for DELETE /messages/:id endpoint."""

    def test_delete_message_success(self, auth_client, direct_db: DirectSessionManager):
        """Delete message returns 204."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_id)
            msg1_id = create_test_message(session, conversation_id, seq=1)
            create_test_message(session, conversation_id, seq=2)

        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        # Delete one message
        response = auth_client.delete(f"/messages/{msg1_id}", headers=auth_headers(user_id))

        assert response.status_code == 204

        # Verify message deleted but conversation remains
        with direct_db.session() as session:
            result = session.execute(
                text("SELECT 1 FROM messages WHERE id = :id"),
                {"id": msg1_id},
            )
            assert result.fetchone() is None

            result = session.execute(
                text("SELECT 1 FROM conversations WHERE id = :id"),
                {"id": conversation_id},
            )
            assert result.fetchone() is not None

    def test_delete_last_message_deletes_conversation(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Deleting the last message deletes the conversation."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_id)
            msg_id = create_test_message(session, conversation_id, seq=1)

        # Don't need cleanup since conversation will be deleted

        # Delete the only message
        response = auth_client.delete(f"/messages/{msg_id}", headers=auth_headers(user_id))

        assert response.status_code == 204

        # Verify both message and conversation deleted
        with direct_db.session() as session:
            result = session.execute(
                text("SELECT 1 FROM messages WHERE id = :id"),
                {"id": msg_id},
            )
            assert result.fetchone() is None

            result = session.execute(
                text("SELECT 1 FROM conversations WHERE id = :id"),
                {"id": conversation_id},
            )
            assert result.fetchone() is None

    def test_delete_message_not_found(self, auth_client):
        """Delete non-existent message returns 404."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.delete(f"/messages/{uuid4()}", headers=auth_headers(user_id))

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_MESSAGE_NOT_FOUND"

    def test_delete_message_not_owner(self, auth_client, direct_db: DirectSessionManager):
        """Non-owner cannot delete message (masked as 404)."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_a)
            msg_id = create_test_message(session, conversation_id, seq=1)

        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        response = auth_client.delete(f"/messages/{msg_id}", headers=auth_headers(user_b))

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_MESSAGE_NOT_FOUND"


# =============================================================================
# Visibility / Isolation Tests
# =============================================================================


class TestVisibility:
    """Tests for conversation visibility and user isolation."""

    def test_users_cannot_see_each_others_conversations(self, auth_client):
        """Users cannot see conversations owned by other users."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        # User A creates conversations
        auth_client.post("/conversations", headers=auth_headers(user_a))
        auth_client.post("/conversations", headers=auth_headers(user_a))

        # User B creates conversations
        auth_client.post("/conversations", headers=auth_headers(user_b))

        # User A lists - should see only their 2
        resp_a = auth_client.get("/conversations", headers=auth_headers(user_a))
        assert len(resp_a.json()["data"]) == 2

        # User B lists - should see only their 1
        resp_b = auth_client.get("/conversations", headers=auth_headers(user_b))
        assert len(resp_b.json()["data"]) == 1

    def test_message_count_accurate(self, auth_client, direct_db: DirectSessionManager):
        """Message count reflects actual message count."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_id)
            for i in range(1, 4):
                create_test_message(session, conversation_id, seq=i)

        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        response = auth_client.get(
            f"/conversations/{conversation_id}", headers=auth_headers(user_id)
        )

        assert response.status_code == 200
        assert response.json()["data"]["message_count"] == 3
