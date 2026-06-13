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
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import (
    ChatRun,
    ConversationActivePath,
    ConversationBranch,
    Message,
)
from nexus.services.conversations import (
    DEFAULT_CONVERSATION_TITLE,
    MAX_CONVERSATION_TITLE_LENGTH,
    derive_conversation_title,
)
from tests.factories import (
    add_context_edge,
    create_test_conversation,
    create_test_media_in_library,
    create_test_message,
    create_test_model,
    get_user_default_library,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

# =============================================================================
# Conversation Create Tests
# =============================================================================


class TestConversationTitleDerivation:
    """Tests for conversation title derivation helper behavior."""

    def test_derive_conversation_title_defaults_for_none_or_blank(self):
        """None/blank content falls back to default title."""
        assert derive_conversation_title(None) == DEFAULT_CONVERSATION_TITLE
        assert derive_conversation_title("") == DEFAULT_CONVERSATION_TITLE
        assert derive_conversation_title("   \n\t  ") == DEFAULT_CONVERSATION_TITLE

    def test_derive_conversation_title_normalizes_whitespace_and_truncates(self):
        """Whitespace collapses and output is bounded by max title length."""
        long_content = f"hello   world {'x' * (MAX_CONVERSATION_TITLE_LENGTH + 20)}"
        derived = derive_conversation_title(long_content)
        assert derived.startswith("hello world ")
        assert len(derived) == MAX_CONVERSATION_TITLE_LENGTH


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
        assert data["title"] == "Chat"
        assert data["sharing"] == "private"
        assert data["message_count"] == 0
        assert "id" in data
        assert "created_at" in data
        assert "updated_at" in data

    def test_create_conversation_with_initial_context_refs_is_atomic(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """POST /conversations owns initial context ref insertion in one service call."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            library_id = get_user_default_library(session, user_id)
            assert library_id is not None
            media_id = create_test_media_in_library(
                session,
                user_id,
                library_id,
                title="Create-time Reference",
            )

        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("default_library_closure_edges", "media_id", media_id)

        response = auth_client.post(
            "/conversations",
            headers=auth_headers(user_id),
            json={"initial_context_refs": [f"media:{media_id}"]},
        )

        assert response.status_code == 201, response.text
        conversation_id = UUID(response.json()["data"]["id"])
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("resource_edges", "source_id", conversation_id)

        with direct_db.session() as session:
            rows = session.execute(
                text(
                    """
                    SELECT target_scheme, target_id
                    FROM resource_edges
                    WHERE source_scheme = 'conversation' AND source_id = :conversation_id
                      AND kind = 'context'
                    """
                ),
                {"conversation_id": conversation_id},
            ).all()
            assert [f"{scheme}:{tid}" for scheme, tid in rows] == [f"media:{media_id}"]

    def test_create_conversation_rejects_initial_references_field(self, auth_client):
        user_id = create_test_user_id()

        response = auth_client.post(
            "/conversations",
            headers=auth_headers(user_id),
            json={"initial_references": []},
        )

        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_create_conversation_with_li_revision_and_library_refs_in_one_tx(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """AC-4: chat-on-LI-revision attaches revision + library refs atomically."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            library_id = create_shared_library(session, user_id)
            artifact_id = uuid4()
            revision_id = uuid4()
            session.execute(
                text(
                    """
                    INSERT INTO library_intelligence_artifacts (id, library_id, user_id)
                    VALUES (:id, :library_id, :user_id)
                    """
                ),
                {"id": artifact_id, "library_id": library_id, "user_id": user_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO library_intelligence_artifact_revisions (
                        id, artifact_id, content_md, covered_targets, status, promoted_at
                    )
                    VALUES (
                        :id, :artifact_id, 'Synthesis', '[]'::jsonb, 'ready', now()
                    )
                    """
                ),
                {"id": revision_id, "artifact_id": artifact_id},
            )
            session.execute(
                text(
                    "UPDATE library_intelligence_artifacts "
                    "SET current_revision_id = :revision_id WHERE id = :artifact_id"
                ),
                {"revision_id": revision_id, "artifact_id": artifact_id},
            )
            session.commit()

        direct_db.register_cleanup("libraries", "id", library_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)

        revision_uri = f"library_intelligence_revision:{revision_id}"
        library_uri = f"library:{library_id}"
        response = auth_client.post(
            "/conversations",
            headers=auth_headers(user_id),
            json={"initial_context_refs": [revision_uri, library_uri]},
        )

        assert response.status_code == 201, response.text
        conversation_id = UUID(response.json()["data"]["id"])
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("resource_edges", "source_id", conversation_id)

        with direct_db.session() as session:
            rows = session.execute(
                text(
                    """
                    SELECT target_scheme, target_id, source_order_key
                    FROM resource_edges
                    WHERE source_scheme = 'conversation' AND source_id = :conversation_id
                      AND kind = 'context'
                    ORDER BY source_order_key ASC
                    """
                ),
                {"conversation_id": conversation_id},
            ).all()
            assert [f"{scheme}:{tid}" for scheme, tid, _order_key in rows] == [
                revision_uri,
                library_uri,
            ], "Both refs must be inserted in one create-time transaction (AC-4)"
            assert [order_key for _scheme, _tid, order_key in rows] == [
                "0000000001",
                "0000000002",
            ]

    def test_create_conversation_invalid_initial_reference_rolls_back(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            before = session.execute(
                text("SELECT COUNT(*) FROM conversations WHERE owner_user_id = :user_id"),
                {"user_id": user_id},
            ).scalar_one()

        response = auth_client.post(
            "/conversations",
            headers=auth_headers(user_id),
            json={"initial_context_refs": ["not-a-uri"]},
        )

        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

        with direct_db.session() as session:
            after = session.execute(
                text("SELECT COUNT(*) FROM conversations WHERE owner_user_id = :user_id"),
                {"user_id": user_id},
            ).scalar_one()
        assert after == before


class TestCreateConversationVisibility:
    """Tests for conversation create-time visibility/sharing defaults."""

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
        assert all("title" in item for item in response.json()["data"])

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

    def test_list_conversations_has_context_ref_invalid_uri_returns_400(self, auth_client):
        """Invalid has_context_ref URI returns the contract error."""
        user_id = create_test_user_id()

        response = auth_client.get(
            "/conversations?has_context_ref=not-a-uri",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_list_conversations_has_context_ref_ignores_invalid_scope(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """has_context_ref returns the listing even with an invalid scope.

        Pinned bypass (decision 14): when has_context_ref is set, scope is
        meaningless (context filtering is viewer-owned-only) and is neither
        validated nor applied. An otherwise-400 scope value must NOT 400 here.
        """
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            library_id = get_user_default_library(session, user_id)
            assert library_id is not None
            media_id = create_test_media_in_library(
                session, user_id, library_id, title="Referenced Doc"
            )
            conversation_id = create_test_conversation(session, user_id)

        direct_db.register_cleanup("resource_edges", "source_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        uri = f"media:{media_id}"
        add_resp = auth_client.post(
            f"/conversations/{conversation_id}/context-refs",
            headers=auth_headers(user_id),
            json={"resource_ref": uri},
        )
        assert add_resp.status_code == 201, add_resp.text

        response = auth_client.get(
            f"/conversations?has_context_ref={uri}&scope=not-a-valid-scope",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, response.text
        ids = [c["id"] for c in response.json()["data"]]
        assert str(conversation_id) in ids


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
        assert data["title"] == "Chat"
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
        resource_uri = f"media:{uuid4()}"

        with direct_db.session() as session:
            add_context_edge(session, UUID(conversation_id), resource_uri)
            session.commit()

        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("resource_edges", "source_id", conversation_id)

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
            result = session.execute(
                text(
                    "SELECT 1 FROM resource_edges "
                    "WHERE source_scheme = 'conversation' AND source_id = :id"
                ),
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

    def test_delete_conversation_not_owner_preserves_references(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_a)
            add_context_edge(session, conversation_id, f"media:{uuid4()}")
            session.commit()

        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("resource_edges", "source_id", conversation_id)

        response = auth_client.delete(
            f"/conversations/{conversation_id}", headers=auth_headers(user_b)
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_CONVERSATION_NOT_FOUND"
        with direct_db.session() as session:
            remaining = session.execute(
                text(
                    """
                    SELECT COUNT(*)
                    FROM resource_edges
                    WHERE source_scheme = 'conversation' AND source_id = :conversation_id
                    """
                ),
                {"conversation_id": conversation_id},
            ).scalar_one()
        assert remaining == 1

    def test_delete_conversation_cleans_messages(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Deleting a conversation explicitly cleans its messages."""
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

        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)

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

        # Verify messages were explicitly deleted.
        with direct_db.session() as session:
            result = session.execute(
                text("SELECT COUNT(*) FROM messages WHERE conversation_id = :id"),
                {"id": conversation_id},
            )
            assert result.scalar() == 0

    def test_delete_conversation_cleans_branch_state_and_running_runs(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Conversation delete explicitly removes non-cascading branch state."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            root_user_id = create_test_message(
                session,
                conversation_id,
                seq=1,
                role="user",
                content="Root",
            )
            root_assistant_id = create_test_message(
                session,
                conversation_id,
                seq=2,
                role="assistant",
                content="Assistant",
                model_id=model_id,
                parent_message_id=root_user_id,
            )
            branch_user_id = create_test_message(
                session,
                conversation_id,
                seq=3,
                role="user",
                content="Branch",
                parent_message_id=root_assistant_id,
            )
            pending_assistant_id = create_test_message(
                session,
                conversation_id,
                seq=4,
                role="assistant",
                content="",
                status="pending",
                model_id=model_id,
                parent_message_id=branch_user_id,
            )
            session.add(
                ConversationBranch(
                    id=uuid4(),
                    conversation_id=conversation_id,
                    branch_user_message_id=branch_user_id,
                )
            )
            session.add(
                ConversationActivePath(
                    conversation_id=conversation_id,
                    viewer_user_id=user_id,
                    active_leaf_message_id=pending_assistant_id,
                )
            )
            session.add(
                ChatRun(
                    id=uuid4(),
                    owner_user_id=user_id,
                    conversation_id=conversation_id,
                    user_message_id=branch_user_id,
                    assistant_message_id=pending_assistant_id,
                    idempotency_key=f"test-delete-{conversation_id}",
                    payload_hash="test-delete-branch-state",
                    status="running",
                    model_id=model_id,
                    reasoning="none",
                    key_mode="auto",
                )
            )
            session.commit()

        direct_db.register_cleanup("conversation_active_paths", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversation_branches", "conversation_id", conversation_id)
        direct_db.register_cleanup("chat_runs", "conversation_id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        response = auth_client.delete(
            f"/conversations/{conversation_id}", headers=auth_headers(user_id)
        )
        assert response.status_code == 204

        with direct_db.session() as session:
            for table, column in (
                ("conversation_active_paths", "conversation_id"),
                ("conversation_branches", "conversation_id"),
                ("chat_runs", "conversation_id"),
                ("messages", "conversation_id"),
                ("conversations", "id"),
            ):
                result = session.execute(
                    text(f"SELECT COUNT(*) FROM {table} WHERE {column} = :id"),
                    {"id": conversation_id},
                )
                assert result.scalar() == 0, table


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
            first_id = create_test_message(session, conversation_id, seq=1, content="First")
            second_id = create_test_message(
                session,
                conversation_id,
                seq=2,
                role="assistant",
                content="Second",
                parent_message_id=first_id,
            )
            third_id = create_test_message(
                session,
                conversation_id,
                seq=3,
                content="Third",
                parent_message_id=second_id,
            )
            third = session.get(Message, third_id)
            assert third is not None
            third.branch_anchor_kind = "assistant_message"
            third.branch_anchor = {"message_id": str(second_id)}
            session.add(
                ConversationBranch(
                    id=third_id,
                    conversation_id=conversation_id,
                    branch_user_message_id=third_id,
                )
            )
            session.commit()

        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)

        response = auth_client.get(
            f"/conversations/{conversation_id}/messages", headers=auth_headers(user_id)
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) == 3
        # Oldest first (ASC order)
        assert data[0]["seq"] == 1
        assert data[0]["message_document"]["blocks"][0]["text"] == "First"
        assert data[1]["seq"] == 2
        assert data[2]["seq"] == 3

    def test_list_messages_pagination(self, auth_client, direct_db: DirectSessionManager):
        """Message pagination works correctly."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_id)
            first_id = create_test_message(session, conversation_id, seq=1, content="Msg 1")
            second_id = create_test_message(
                session,
                conversation_id,
                seq=2,
                role="assistant",
                content="Msg 2",
                parent_message_id=first_id,
            )
            third_id = create_test_message(
                session,
                conversation_id,
                seq=3,
                content="Msg 3",
                parent_message_id=second_id,
            )
            fourth_id = create_test_message(
                session,
                conversation_id,
                seq=4,
                role="assistant",
                content="Msg 4",
                parent_message_id=third_id,
            )
            fifth_id = create_test_message(
                session,
                conversation_id,
                seq=5,
                content="Msg 5",
                parent_message_id=fourth_id,
            )
            third = session.get(Message, third_id)
            fifth = session.get(Message, fifth_id)
            assert third is not None
            assert fifth is not None
            third.branch_anchor_kind = "assistant_message"
            third.branch_anchor = {"message_id": str(second_id)}
            fifth.branch_anchor_kind = "assistant_message"
            fifth.branch_anchor = {"message_id": str(fourth_id)}
            session.add_all(
                [
                    ConversationBranch(
                        id=third_id,
                        conversation_id=conversation_id,
                        branch_user_message_id=third_id,
                    ),
                    ConversationBranch(
                        id=fifth_id,
                        conversation_id=conversation_id,
                        branch_user_message_id=fifth_id,
                    ),
                ]
            )
            session.commit()

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

    def test_list_messages_latest_window_paginates_older(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Latest message window returns newest chat-order page and paginates older."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_id)
            first_id = create_test_message(session, conversation_id, seq=1, content="Msg 1")
            second_id = create_test_message(
                session,
                conversation_id,
                seq=2,
                role="assistant",
                content="Msg 2",
                parent_message_id=first_id,
            )
            third_id = create_test_message(
                session,
                conversation_id,
                seq=3,
                content="Msg 3",
                parent_message_id=second_id,
            )
            fourth_id = create_test_message(
                session,
                conversation_id,
                seq=4,
                role="assistant",
                content="Msg 4",
                parent_message_id=third_id,
            )
            create_test_message(
                session,
                conversation_id,
                seq=5,
                content="Msg 5",
                parent_message_id=fourth_id,
            )
            session.commit()

        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        resp1 = auth_client.get(
            f"/conversations/{conversation_id}/messages?limit=2&window=latest",
            headers=auth_headers(user_id),
        )
        assert resp1.status_code == 200
        data1 = resp1.json()
        assert [message["seq"] for message in data1["data"]] == [4, 5]
        assert data1["page"]["next_cursor"] is None
        assert data1["page"]["before_cursor"] is not None

        before_cursor = data1["page"]["before_cursor"]
        resp2 = auth_client.get(
            f"/conversations/{conversation_id}/messages?limit=2&before_cursor={before_cursor}",
            headers=auth_headers(user_id),
        )
        assert resp2.status_code == 200
        data2 = resp2.json()
        assert [message["seq"] for message in data2["data"]] == [2, 3]
        assert data2["page"]["before_cursor"] is not None

        before_cursor = data2["page"]["before_cursor"]
        resp3 = auth_client.get(
            f"/conversations/{conversation_id}/messages?limit=2&before_cursor={before_cursor}",
            headers=auth_headers(user_id),
        )
        assert resp3.status_code == 200
        data3 = resp3.json()
        assert [message["seq"] for message in data3["data"]] == [1]
        assert data3["page"]["before_cursor"] is None

    def test_list_messages_rejects_conflicting_window_parameters(self, auth_client):
        """Message pagination modes reject ambiguous parameter combinations."""
        user_id = create_test_user_id()
        conversation_id = uuid4()

        invalid_queries = [
            "limit=2&cursor=cursor-a&before_cursor=cursor-b",
            "limit=2&cursor=cursor-a&window=latest",
            "limit=2&window=middle",
        ]
        for query in invalid_queries:
            response = auth_client.get(
                f"/conversations/{conversation_id}/messages?{query}",
                headers=auth_headers(user_id),
            )
            assert response.status_code == 400, query
            assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

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
# Removed Streaming Route Tests
# =============================================================================


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


# =============================================================================
# ConversationOut owner fields
# =============================================================================


class TestConversationOutOwnerFields:
    """Tests that ConversationOut includes owner_user_id and is_owner."""

    def test_get_conversation_response_includes_owner_fields(self, auth_client):
        """GET /conversations/{id} includes owner_user_id and is_owner."""
        user_id = create_test_user_id()
        create_resp = auth_client.post("/conversations", headers=auth_headers(user_id))
        conversation_id = create_resp.json()["data"]["id"]

        response = auth_client.get(
            f"/conversations/{conversation_id}", headers=auth_headers(user_id)
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["owner_user_id"] == str(user_id)
        assert data["is_owner"] is True

    def test_list_conversations_response_includes_owner_fields(self, auth_client):
        """GET /conversations includes owner_user_id and is_owner in each item."""
        user_id = create_test_user_id()
        auth_client.post("/conversations", headers=auth_headers(user_id))

        response = auth_client.get("/conversations", headers=auth_headers(user_id))
        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) >= 1
        assert data[0]["owner_user_id"] == str(user_id)
        assert data[0]["is_owner"] is True

    def test_create_conversation_response_includes_owner_fields(self, auth_client):
        """POST /conversations includes owner_user_id and is_owner."""
        user_id = create_test_user_id()
        response = auth_client.post("/conversations", headers=auth_headers(user_id))
        assert response.status_code == 201
        data = response.json()["data"]
        assert data["owner_user_id"] == str(user_id)
        assert data["is_owner"] is True


# =============================================================================
# Conversation Scope Tests
# =============================================================================


def create_shared_library(session: Session, owner_user_id: UUID) -> UUID:
    """Create a non-default library with owner as admin member."""
    lib_id = uuid4()
    session.execute(
        text("""
            INSERT INTO libraries (id, owner_user_id, name, is_default)
            VALUES (:id, :owner_user_id, 'Shared Lib', false)
        """),
        {"id": lib_id, "owner_user_id": owner_user_id},
    )
    session.execute(
        text("""
            INSERT INTO memberships (library_id, user_id, role)
            VALUES (:library_id, :user_id, 'admin')
        """),
        {"library_id": lib_id, "user_id": owner_user_id},
    )
    session.commit()
    return lib_id


def add_member_to_library(session: Session, library_id: UUID, user_id: UUID) -> None:
    """Add a user as member of a library."""
    session.execute(
        text("""
            INSERT INTO memberships (library_id, user_id, role)
            VALUES (:library_id, :user_id, 'member')
            ON CONFLICT DO NOTHING
        """),
        {"library_id": library_id, "user_id": user_id},
    )
    session.commit()


def share_conversation_to_library(
    session: Session, conversation_id: UUID, library_id: UUID
) -> None:
    """Share a conversation to a library and set sharing='library'."""
    session.execute(
        text("""
            INSERT INTO conversation_shares (conversation_id, library_id)
            VALUES (:conversation_id, :library_id)
            ON CONFLICT DO NOTHING
        """),
        {"conversation_id": conversation_id, "library_id": library_id},
    )
    session.execute(
        text("""
            UPDATE conversations SET sharing = 'library' WHERE id = :id
        """),
        {"id": conversation_id},
    )
    session.commit()


def make_conversation_public(session: Session, conversation_id: UUID) -> None:
    """Set a conversation to public sharing."""
    session.execute(
        text("UPDATE conversations SET sharing = 'public' WHERE id = :id"),
        {"id": conversation_id},
    )
    session.commit()


class TestListConversationsScope:
    """Tests for GET /conversations scope parameter."""

    def test_list_conversations_default_scope_is_mine(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Default scope returns only owned conversations, not shared ones."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            # A creates a conversation and shares it with B via a library
            lib_id = create_shared_library(session, user_a)
            add_member_to_library(session, lib_id, user_b)
            conv_a = create_test_conversation(session, user_a)
            share_conversation_to_library(session, conv_a, lib_id)

            # B creates their own conversation
            conv_b = create_test_conversation(session, user_b)

        direct_db.register_cleanup("conversation_shares", "conversation_id", conv_a)
        direct_db.register_cleanup("conversations", "id", conv_a)
        direct_db.register_cleanup("conversations", "id", conv_b)
        direct_db.register_cleanup("memberships", "library_id", lib_id)
        direct_db.register_cleanup("libraries", "id", lib_id)

        # B lists with no scope (defaults to mine) - should only see conv_b
        response = auth_client.get("/conversations", headers=auth_headers(user_b))
        assert response.status_code == 200
        ids = [c["id"] for c in response.json()["data"]]
        assert str(conv_b) in ids
        assert str(conv_a) not in ids

    def test_list_conversations_invalid_scope_returns_400_e_invalid_request_not_422(
        self, auth_client
    ):
        """Invalid scope values return 400 E_INVALID_REQUEST, never 422."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        for invalid_scope in ["ALL", "invalid", "Mine", "SHARED", ""]:
            response = auth_client.get(
                f"/conversations?scope={invalid_scope}", headers=auth_headers(user_id)
            )
            assert response.status_code == 400, f"scope={invalid_scope} got {response.status_code}"
            assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_list_conversations_scope_all_includes_visible_non_owned(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """scope=all returns owned + shared + public conversations."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            lib_id = create_shared_library(session, user_a)
            add_member_to_library(session, lib_id, user_b)

            conv_owned = create_test_conversation(session, user_b)
            conv_shared = create_test_conversation(session, user_a)
            share_conversation_to_library(session, conv_shared, lib_id)
            conv_public = create_test_conversation(session, user_a)
            make_conversation_public(session, conv_public)

        direct_db.register_cleanup("conversation_shares", "conversation_id", conv_shared)
        direct_db.register_cleanup("conversations", "id", conv_owned)
        direct_db.register_cleanup("conversations", "id", conv_shared)
        direct_db.register_cleanup("conversations", "id", conv_public)
        direct_db.register_cleanup("memberships", "library_id", lib_id)
        direct_db.register_cleanup("libraries", "id", lib_id)

        response = auth_client.get("/conversations?scope=all", headers=auth_headers(user_b))
        assert response.status_code == 200
        ids = {c["id"] for c in response.json()["data"]}
        assert str(conv_owned) in ids
        assert str(conv_shared) in ids
        assert str(conv_public) in ids

    def test_list_conversations_scope_shared_returns_visible_non_owned_only(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """scope=shared returns only visible non-owned conversations."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            lib_id = create_shared_library(session, user_a)
            add_member_to_library(session, lib_id, user_b)

            conv_owned = create_test_conversation(session, user_b)
            conv_shared = create_test_conversation(session, user_a)
            share_conversation_to_library(session, conv_shared, lib_id)

        direct_db.register_cleanup("conversation_shares", "conversation_id", conv_shared)
        direct_db.register_cleanup("conversations", "id", conv_owned)
        direct_db.register_cleanup("conversations", "id", conv_shared)
        direct_db.register_cleanup("memberships", "library_id", lib_id)
        direct_db.register_cleanup("libraries", "id", lib_id)

        response = auth_client.get("/conversations?scope=shared", headers=auth_headers(user_b))
        assert response.status_code == 200
        ids = {c["id"] for c in response.json()["data"]}
        assert str(conv_shared) in ids
        assert str(conv_owned) not in ids

    def test_get_conversation_shared_reader_succeeds(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Shared reader can GET a conversation they don't own."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            lib_id = create_shared_library(session, user_a)
            add_member_to_library(session, lib_id, user_b)
            conv_id = create_test_conversation(session, user_a)
            share_conversation_to_library(session, conv_id, lib_id)

        direct_db.register_cleanup("conversation_shares", "conversation_id", conv_id)
        direct_db.register_cleanup("conversations", "id", conv_id)
        direct_db.register_cleanup("memberships", "library_id", lib_id)
        direct_db.register_cleanup("libraries", "id", lib_id)

        response = auth_client.get(f"/conversations/{conv_id}", headers=auth_headers(user_b))
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["owner_user_id"] == str(user_a)
        assert data["is_owner"] is False

    def test_list_messages_shared_reader_succeeds(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Shared reader can list messages of a shared conversation."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            lib_id = create_shared_library(session, user_a)
            add_member_to_library(session, lib_id, user_b)
            conv_id = create_test_conversation(session, user_a)
            create_test_message(session, conv_id, seq=1, content="Hello")
            share_conversation_to_library(session, conv_id, lib_id)

        direct_db.register_cleanup("messages", "conversation_id", conv_id)
        direct_db.register_cleanup("conversation_shares", "conversation_id", conv_id)
        direct_db.register_cleanup("conversations", "id", conv_id)
        direct_db.register_cleanup("memberships", "library_id", lib_id)
        direct_db.register_cleanup("libraries", "id", lib_id)

        response = auth_client.get(
            f"/conversations/{conv_id}/messages", headers=auth_headers(user_b)
        )
        assert response.status_code == 200
        assert len(response.json()["data"]) == 1

    def test_delete_conversation_shared_reader_still_masked_404(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Shared reader cannot delete conversation (masked 404)."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            lib_id = create_shared_library(session, user_a)
            add_member_to_library(session, lib_id, user_b)
            conv_id = create_test_conversation(session, user_a)
            share_conversation_to_library(session, conv_id, lib_id)

        direct_db.register_cleanup("conversation_shares", "conversation_id", conv_id)
        direct_db.register_cleanup("conversations", "id", conv_id)
        direct_db.register_cleanup("memberships", "library_id", lib_id)
        direct_db.register_cleanup("libraries", "id", lib_id)

        response = auth_client.delete(f"/conversations/{conv_id}", headers=auth_headers(user_b))
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_CONVERSATION_NOT_FOUND"

    def test_delete_message_shared_reader_still_masked_404(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Shared reader cannot delete a message (masked 404)."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            lib_id = create_shared_library(session, user_a)
            add_member_to_library(session, lib_id, user_b)
            conv_id = create_test_conversation(session, user_a)
            msg_id = create_test_message(session, conv_id, seq=1)
            share_conversation_to_library(session, conv_id, lib_id)

        direct_db.register_cleanup("messages", "conversation_id", conv_id)
        direct_db.register_cleanup("conversation_shares", "conversation_id", conv_id)
        direct_db.register_cleanup("conversations", "id", conv_id)
        direct_db.register_cleanup("memberships", "library_id", lib_id)
        direct_db.register_cleanup("libraries", "id", lib_id)

        response = auth_client.delete(f"/messages/{msg_id}", headers=auth_headers(user_b))
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_MESSAGE_NOT_FOUND"

    # NOTE: Chat send ownership checks are covered by the chat-run create contract.
    # (requires lifespan-aware TestClient for llm_router setup)

    def test_list_conversations_scope_all_cursor_is_stable_across_mixed_visibility(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Paginated scope=all traversal has no duplicates/skips."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            lib_id = create_shared_library(session, user_a)
            add_member_to_library(session, lib_id, user_b)

            conv_ids = []
            # Create 5 conversations: 3 owned by B, 2 shared from A
            for _ in range(3):
                conv_ids.append(create_test_conversation(session, user_b))
            for _ in range(2):
                cid = create_test_conversation(session, user_a)
                share_conversation_to_library(session, cid, lib_id)
                conv_ids.append(cid)

        for cid in conv_ids:
            direct_db.register_cleanup("conversation_shares", "conversation_id", cid)
            direct_db.register_cleanup("conversations", "id", cid)
        direct_db.register_cleanup("memberships", "library_id", lib_id)
        direct_db.register_cleanup("libraries", "id", lib_id)

        all_ids = []
        cursor = None
        for _ in range(10):  # safety bound
            url = "/conversations?scope=all&limit=2"
            if cursor:
                url += f"&cursor={cursor}"
            response = auth_client.get(url, headers=auth_headers(user_b))
            assert response.status_code == 200
            page_data = response.json()
            all_ids.extend(c["id"] for c in page_data["data"])
            cursor = page_data["page"]["next_cursor"]
            if not cursor:
                break

        assert len(all_ids) == len(set(all_ids)), "Duplicate IDs in paginated traversal"
        assert len(all_ids) == 5

    def test_list_conversations_scope_all_matches_visibility_matrix(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """scope=all includes only allowed rows and excludes revoked paths."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        user_c = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))
        auth_client.get("/me", headers=auth_headers(user_c))

        with direct_db.session() as session:
            lib_id = create_shared_library(session, user_a)
            add_member_to_library(session, lib_id, user_b)

            # Visible: B owns
            conv_owned = create_test_conversation(session, user_b)
            # Visible: shared to B via library
            conv_shared = create_test_conversation(session, user_a)
            share_conversation_to_library(session, conv_shared, lib_id)
            # Visible: public
            conv_public = create_test_conversation(session, user_c)
            make_conversation_public(session, conv_public)
            # NOT visible: private conversation owned by C
            conv_private_c = create_test_conversation(session, user_c)

        direct_db.register_cleanup("conversation_shares", "conversation_id", conv_shared)
        for cid in [conv_owned, conv_shared, conv_public, conv_private_c]:
            direct_db.register_cleanup("conversations", "id", cid)
        direct_db.register_cleanup("memberships", "library_id", lib_id)
        direct_db.register_cleanup("libraries", "id", lib_id)

        response = auth_client.get("/conversations?scope=all", headers=auth_headers(user_b))
        assert response.status_code == 200
        ids = {c["id"] for c in response.json()["data"]}

        assert str(conv_owned) in ids
        assert str(conv_shared) in ids
        assert str(conv_public) in ids
        assert str(conv_private_c) not in ids

    def test_list_conversations_scope_all_order_is_updated_at_desc_id_desc(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """scope=all order is strictly updated_at DESC, id DESC with deterministic tie-break."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            lib_id = create_shared_library(session, user_a)
            add_member_to_library(session, lib_id, user_b)

            conv_owned = create_test_conversation(session, user_b)
            conv_shared = create_test_conversation(session, user_a)
            share_conversation_to_library(session, conv_shared, lib_id)
            conv_public = create_test_conversation(session, user_a)
            make_conversation_public(session, conv_public)

            # Force controlled timestamps: conv_owned and conv_shared share the
            # same updated_at so tie-break must use id DESC.
            tied_ts = "2026-01-15T12:00:00+00:00"
            older_ts = "2026-01-14T12:00:00+00:00"
            session.execute(
                text("UPDATE conversations SET updated_at = :ts WHERE id = :id"),
                {"ts": tied_ts, "id": str(conv_owned)},
            )
            session.execute(
                text("UPDATE conversations SET updated_at = :ts WHERE id = :id"),
                {"ts": tied_ts, "id": str(conv_shared)},
            )
            session.execute(
                text("UPDATE conversations SET updated_at = :ts WHERE id = :id"),
                {"ts": older_ts, "id": str(conv_public)},
            )
            session.commit()

        direct_db.register_cleanup("conversation_shares", "conversation_id", conv_shared)
        direct_db.register_cleanup("conversations", "id", conv_owned)
        direct_db.register_cleanup("conversations", "id", conv_shared)
        direct_db.register_cleanup("conversations", "id", conv_public)
        direct_db.register_cleanup("memberships", "library_id", lib_id)
        direct_db.register_cleanup("libraries", "id", lib_id)

        response = auth_client.get("/conversations?scope=all", headers=auth_headers(user_b))
        assert response.status_code == 200
        rows = response.json()["data"]
        returned_ids = [c["id"] for c in rows]

        assert len(returned_ids) >= 3
        assert str(conv_owned) in returned_ids
        assert str(conv_shared) in returned_ids
        assert str(conv_public) in returned_ids

        # Verify strict updated_at DESC ordering
        timestamps = [c["updated_at"] for c in rows]
        for i in range(len(timestamps) - 1):
            assert timestamps[i] >= timestamps[i + 1], (
                f"Ordering violated: row {i} updated_at={timestamps[i]} "
                f"< row {i + 1} updated_at={timestamps[i + 1]}"
            )

        # Verify tie-break: among rows with equal updated_at, id DESC must hold
        tied_rows = [c for c in rows if c["updated_at"] == rows[0]["updated_at"]]
        if len(tied_rows) > 1:
            tied_ids = [c["id"] for c in tied_rows]
            assert tied_ids == sorted(tied_ids, reverse=True), (
                f"Tie-break ordering violated: {tied_ids} is not id DESC"
            )

        # The two tied conversations (conv_owned, conv_shared) should come before
        # conv_public (older timestamp).
        owned_idx = returned_ids.index(str(conv_owned))
        shared_idx = returned_ids.index(str(conv_shared))
        public_idx = returned_ids.index(str(conv_public))
        assert owned_idx < public_idx
        assert shared_idx < public_idx
