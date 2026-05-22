"""Integration tests for conversations and messages service and routes.

Tests cover:
- Conversation CRUD operations
- Message listing and deletion
- Cursor-based pagination
- Delete last message auto-deletes conversation
- Owner-only access with masked 404s
- Visibility isolation between users
"""

import hashlib
from uuid import UUID, uuid4

import pytest
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.db.models import (
    AssistantMessageVerifierRun,
    ChatRun,
    ConversationBranch,
    Message,
    MessageContextItem,
    MessageRerankLedger,
    MessageRetrieval,
    MessageRetrievalCandidateLedger,
    MessageToolCall,
)
from nexus.schemas.conversation import ChatRunCreateRequest
from nexus.services.conversations import (
    DEFAULT_CONVERSATION_TITLE,
    MAX_CONVERSATION_TITLE_LENGTH,
    derive_conversation_title,
    load_message_context_snapshots_for_message_ids,
)
from nexus.services.message_context_snapshots import object_ref_context_snapshot
from tests.factories import (
    create_test_conversation,
    create_test_library,
    create_test_media_in_library,
    create_test_message,
    create_test_model,
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


class TestResolveConversationScope:
    def test_resolve_media_scope_reuses_canonical_conversation(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        with direct_db.session() as session:
            library_id = create_test_library(session, user_id, "Scoped Chat Library")
            media_id = create_test_media_in_library(
                session,
                user_id,
                library_id,
                title="Scoped Chat Document",
            )

        first = auth_client.post(
            "/conversations/resolve",
            headers=auth_headers(user_id),
            json={"type": "media", "media_id": str(media_id)},
        )
        second = auth_client.post(
            "/conversations/resolve",
            headers=auth_headers(user_id),
            json={"type": "media", "media_id": str(media_id)},
        )

        assert first.status_code == 200, first.text
        assert second.status_code == 200, second.text
        first_data = first.json()["data"]
        second_data = second.json()["data"]
        assert first_data["id"] == second_data["id"]
        assert first_data["scope"]["type"] == "media"
        assert first_data["scope"]["media_id"] == str(media_id)
        assert first_data["scope"]["title"] == "Scoped Chat Document"

        direct_db.register_cleanup("conversations", "id", UUID(first_data["id"]))
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)
        direct_db.register_cleanup("users", "id", user_id)

    def test_resolve_library_scope_reuses_canonical_conversation(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        with direct_db.session() as session:
            library_id = create_test_library(session, user_id, "Scoped Research Library")

        first = auth_client.post(
            "/conversations/resolve",
            headers=auth_headers(user_id),
            json={"type": "library", "library_id": str(library_id)},
        )
        second = auth_client.post(
            "/conversations/resolve",
            headers=auth_headers(user_id),
            json={"type": "library", "library_id": str(library_id)},
        )

        assert first.status_code == 200, first.text
        assert second.status_code == 200, second.text
        first_data = first.json()["data"]
        second_data = second.json()["data"]
        assert first_data["id"] == second_data["id"]
        assert first_data["scope"]["type"] == "library"
        assert first_data["scope"]["library_id"] == str(library_id)
        assert first_data["scope"]["title"] == "Scoped Research Library"

        direct_db.register_cleanup("conversations", "id", UUID(first_data["id"]))
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)
        direct_db.register_cleanup("users", "id", user_id)

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

        # Verify messages deleted (cascade)
        with direct_db.session() as session:
            result = session.execute(
                text("SELECT COUNT(*) FROM messages WHERE conversation_id = :id"),
                {"id": conversation_id},
            )
            assert result.scalar() == 0

    def test_delete_conversation_removes_context_links_tool_and_evidence_rows(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        message_context_id = uuid4()
        object_link_id = uuid4()
        tool_call_id = uuid4()
        retrieval_id = uuid4()
        claim_id = uuid4()
        claim_evidence_id = uuid4()

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_id)
            user_message_id = create_test_message(session, conversation_id, seq=1)
            assistant_message_id = create_test_message(
                session,
                conversation_id,
                seq=2,
                role="assistant",
                content="Answer",
            )
            session.execute(
                text("""
                    INSERT INTO message_context_items (
                        id,
                        message_id,
                        user_id,
                        context_kind,
                        object_type,
                        object_id,
                        ordinal,
                        context_snapshot
                    )
                    VALUES (
                        :id,
                        :message_id,
                        :user_id,
                        'object_ref',
                        'message',
                        :object_id,
                        0,
                        :context_snapshot
                    )
                """).bindparams(bindparam("context_snapshot", type_=JSONB)),
                {
                    "id": message_context_id,
                    "message_id": user_message_id,
                    "user_id": user_id,
                    "object_id": assistant_message_id,
                    "context_snapshot": object_ref_context_snapshot(
                        object_type="message",
                        object_id=assistant_message_id,
                        title="Message #2",
                        preview="Answer",
                        route=f"/conversations/{conversation_id}",
                    ),
                },
            )
            session.execute(
                text("""
                    INSERT INTO object_links (
                        id, user_id, relation_type, a_type, a_id, b_type, b_id, metadata
                    )
                    VALUES (
                        :id, :user_id, 'used_as_context', 'message', :message_id,
                        'message', :object_id, '{}'::jsonb
                    )
                """),
                {
                    "id": object_link_id,
                    "user_id": user_id,
                    "message_id": user_message_id,
                    "object_id": assistant_message_id,
                },
            )
            session.execute(
                text("""
                    INSERT INTO message_tool_calls (
                        id, conversation_id, user_message_id, assistant_message_id,
                        tool_name, tool_call_index, scope, status
                    )
                    VALUES (
                        :id, :conversation_id, :user_message_id, :assistant_message_id,
                        'app_search', 0, 'all', 'complete'
                    )
                """),
                {
                    "id": tool_call_id,
                    "conversation_id": conversation_id,
                    "user_message_id": user_message_id,
                    "assistant_message_id": assistant_message_id,
                },
            )
            session.execute(
                text("""
                    INSERT INTO message_retrievals (
                        id, tool_call_id, ordinal, result_type, source_id,
                        context_ref, result_ref, selected
                    )
                    VALUES (
                        :id, :tool_call_id, 0, 'message', :source_id,
                        jsonb_build_object('type', 'message', 'id', CAST(:source_id AS text)),
                        jsonb_build_object('type', 'message', 'id', CAST(:source_id AS text)),
                        true
                    )
                """),
                {
                    "id": retrieval_id,
                    "tool_call_id": tool_call_id,
                    "source_id": str(user_message_id),
                },
            )
            session.execute(
                text("""
                    INSERT INTO assistant_message_evidence_summaries (
                        message_id, scope_type, scope_ref, retrieval_status, support_status,
                        verifier_status, claim_count, supported_claim_count,
                        unsupported_claim_count, not_enough_evidence_count
                    )
                    VALUES (
                        :message_id, 'general', NULL, 'included_in_prompt', 'supported',
                        'llm_verified', 1, 1, 0, 0
                    )
                """),
                {"message_id": assistant_message_id},
            )
            session.execute(
                text("""
                    INSERT INTO assistant_message_claims (
                        id, message_id, ordinal, claim_text, answer_start_offset,
                        answer_end_offset, claim_kind, support_status, verifier_status
                    )
                    VALUES (
                        :id, :message_id, 0, 'Claim', 0, 5, 'answer', 'supported', 'llm_verified'
                    )
                """),
                {"id": claim_id, "message_id": assistant_message_id},
            )
            session.execute(
                text("""
                    INSERT INTO assistant_message_claim_evidence (
                        id, claim_id, ordinal, evidence_role, source_ref, context_ref,
                        result_ref, exact_snippet, locator, score, retrieval_status,
                        selected, included_in_prompt, source_version
                    )
                    VALUES (
                        :id, :claim_id, 0, 'supports',
                        jsonb_build_object('type', 'message_retrieval', 'id', CAST(:retrieval_id AS text)),
                        jsonb_build_object('type', 'message', 'id', CAST(:source_id AS text)),
                        jsonb_build_object('type', 'message', 'id', CAST(:source_id AS text)),
                        'Evidence',
                        jsonb_build_object(
                            'type', 'message_offsets',
                            'conversation_id', CAST(:conversation_id AS text),
                            'message_id', CAST(:source_id AS text),
                            'start_offset', 0,
                            'end_offset', 8
                        ),
                        1.0, 'included_in_prompt', true, true, 'message:v1'
                    )
                """),
                {
                    "id": claim_evidence_id,
                    "claim_id": claim_id,
                    "retrieval_id": str(retrieval_id),
                    "source_id": str(user_message_id),
                    "conversation_id": str(conversation_id),
                },
            )
            session.commit()

        response = auth_client.delete(
            f"/conversations/{conversation_id}", headers=auth_headers(user_id)
        )
        assert response.status_code == 204, response.text

        with direct_db.session() as session:
            counts = session.execute(
                text("""
                    SELECT
                        (SELECT count(*) FROM messages WHERE conversation_id = :conversation_id),
                        (SELECT count(*) FROM message_context_items WHERE id = :context_id),
                        (SELECT count(*) FROM object_links WHERE id = :link_id),
                        (SELECT count(*) FROM message_tool_calls WHERE id = :tool_call_id),
                        (SELECT count(*) FROM message_retrievals WHERE id = :retrieval_id),
                        (SELECT count(*) FROM assistant_message_evidence_summaries
                         WHERE message_id = :assistant_message_id),
                        (SELECT count(*) FROM assistant_message_claims WHERE id = :claim_id),
                        (SELECT count(*) FROM assistant_message_claim_evidence
                         WHERE id = :claim_evidence_id)
                """),
                {
                    "conversation_id": conversation_id,
                    "context_id": message_context_id,
                    "link_id": object_link_id,
                    "tool_call_id": tool_call_id,
                    "retrieval_id": retrieval_id,
                    "assistant_message_id": assistant_message_id,
                    "claim_id": claim_id,
                    "claim_evidence_id": claim_evidence_id,
                },
            ).one()
        assert counts == (0, 0, 0, 0, 0, 0, 0, 0)


# =============================================================================
# Message List Tests
# =============================================================================


class TestListMessages:
    """Tests for GET /conversations/:id/messages endpoint."""

    @staticmethod
    def _insert_object_ref_context_snapshot(
        session: Session,
        *,
        user_id: UUID,
        snapshot: dict[str, object],
    ) -> UUID:
        context_id = uuid4()
        chunk_id = uuid4()
        conversation_id = create_test_conversation(session, user_id)
        message_id = create_test_message(
            session,
            conversation_id,
            seq=1,
            content="Message with saved context",
        )
        session.add(
            MessageContextItem(
                id=context_id,
                message_id=message_id,
                user_id=user_id,
                context_kind="object_ref",
                object_type="content_chunk",
                object_id=chunk_id,
                ordinal=0,
                context_snapshot_json={
                    "kind": "object_ref",
                    "type": "content_chunk",
                    "id": str(chunk_id),
                    "title": "Saved Context Title",
                    "source_version": "content-index:test:v1",
                    "locator": {
                        "type": "web_text_offsets",
                        "media_id": str(uuid4()),
                        "fragment_id": str(uuid4()),
                        "start_offset": 0,
                        "end_offset": 12,
                    },
                    **snapshot,
                },
            )
        )
        session.commit()
        return message_id

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
        assert data[0]["contexts"] == []
        assert data[1]["seq"] == 2
        assert data[1]["contexts"] == []
        assert data[2]["seq"] == 3
        assert data[2]["contexts"] == []

    def test_message_artifact_read_path(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        artifact_id = uuid4()
        part_id = uuid4()

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_id)
            user_message_id = create_test_message(session, conversation_id, seq=1, content="Make")
            assistant_message_id = create_test_message(
                session,
                conversation_id,
                seq=2,
                role="assistant",
                content="Done",
                parent_message_id=user_message_id,
            )
            session.execute(
                text(
                    """
                    INSERT INTO message_artifacts (
                        id,
                        conversation_id,
                        message_id,
                        artifact_key,
                        artifact_kind,
                        title,
                        status,
                        preview_text
                    )
                    VALUES (
                        :artifact_id,
                        :conversation_id,
                        :message_id,
                        'artifact-1',
                        'timeline',
                        'Timeline',
                        'complete',
                        'Durable preview'
                    )
                    """
                ),
                {
                    "artifact_id": artifact_id,
                    "conversation_id": conversation_id,
                    "message_id": assistant_message_id,
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO message_artifact_parts (
                        id,
                        artifact_id,
                        ordinal,
                        part_key,
                        part_type,
                        text,
                        source_version,
                        locator,
                        source_ref,
                        evidence_span_ids
                    )
                    VALUES (
                        :part_id,
                        :artifact_id,
                        0,
                        'part-1',
                        'event',
                        'Cited event',
                        concat('artifact_part', chr(58), CAST(:part_id AS text), chr(58), 'v1'),
                        jsonb_build_object(
                            'type', 'artifact_part_ref',
                            'artifact_id', CAST(:artifact_id AS text),
                            'artifact_part_id', CAST(:part_id AS text),
                            'message_id', CAST(:message_id AS text),
                            'conversation_id', CAST(:conversation_id AS text),
                            'part_key', 'part-1'
                        ),
                        '{"type":"message_retrieval","id":"retrieval-1"}'::jsonb,
                        jsonb_build_array(to_jsonb(CAST(:evidence_span_id AS text)))
                    )
                    """
                ),
                {
                    "part_id": part_id,
                    "artifact_id": artifact_id,
                    "message_id": assistant_message_id,
                    "conversation_id": conversation_id,
                    "evidence_span_id": str(uuid4()),
                },
            )
            session.commit()

        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("message_artifacts", "id", artifact_id)
        direct_db.register_cleanup("message_artifact_parts", "artifact_id", artifact_id)
        direct_db.register_cleanup("message_artifact_exports", "artifact_id", artifact_id)

        response = auth_client.get(
            f"/artifacts/{artifact_id}",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["id"] == str(artifact_id)
        assert data["artifact_key"] == "artifact-1"
        assert data["artifact_kind"] == "timeline"
        assert data["parts"][0]["id"] == str(part_id)
        assert data["parts"][0]["source_ref"]["type"] == "message_retrieval"
        assert data["parts"][0]["source_ref"]["id"] == "retrieval-1"

        list_response = auth_client.get(
            f"/artifacts?message_id={assistant_message_id}",
            headers=auth_headers(user_id),
        )
        assert list_response.status_code == 200, list_response.text
        assert list_response.json()["data"][0]["id"] == str(artifact_id)

    def test_message_artifact_exports_markdown_with_citation_manifest(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        artifact_id = uuid4()
        part_id = uuid4()

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_id)
            user_message_id = create_test_message(session, conversation_id, seq=1, content="Make")
            assistant_message_id = create_test_message(
                session,
                conversation_id,
                seq=2,
                role="assistant",
                content="Done",
                parent_message_id=user_message_id,
            )
            session.execute(
                text(
                    """
                    INSERT INTO message_artifacts (
                        id, conversation_id, message_id, artifact_key,
                        artifact_kind, title, status, preview_text
                    )
                    VALUES (
                        :artifact_id, :conversation_id, :message_id, 'artifact-1',
                        'timeline', 'Timeline', 'complete', 'Durable preview'
                    )
                    """
                ),
                {
                    "artifact_id": artifact_id,
                    "conversation_id": conversation_id,
                    "message_id": assistant_message_id,
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO message_artifact_parts (
                        id, artifact_id, ordinal, part_key, part_type, text,
                        source_version, locator, source_ref, evidence_span_ids
                    )
                    VALUES (
                        :part_id, :artifact_id, 0, 'part-1', 'event', 'Cited event',
                        concat('artifact_part', chr(58), CAST(:part_id AS text), chr(58), 'v1'),
                        jsonb_build_object(
                            'type', 'artifact_part_ref',
                            'artifact_id', CAST(:artifact_id AS text),
                            'artifact_part_id', CAST(:part_id AS text),
                            'message_id', CAST(:message_id AS text),
                            'conversation_id', CAST(:conversation_id AS text),
                            'part_key', 'part-1'
                        ),
                        '{"type":"message_retrieval","id":"retrieval-1"}'::jsonb,
                        '[]'::jsonb
                    )
                    """
                ),
                {
                    "part_id": part_id,
                    "artifact_id": artifact_id,
                    "message_id": assistant_message_id,
                    "conversation_id": conversation_id,
                },
            )
            session.commit()

        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("message_artifacts", "id", artifact_id)
        direct_db.register_cleanup("message_artifact_parts", "artifact_id", artifact_id)
        direct_db.register_cleanup("message_artifact_exports", "artifact_id", artifact_id)

        response = auth_client.post(
            f"/artifacts/{artifact_id}/export?format=markdown",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, response.text
        assert response.headers["content-disposition"] == 'attachment; filename="timeline.md"'
        assert response.headers["x-nexus-artifact-version"] == "1"
        assert (
            response.headers["x-nexus-artifact-content-sha256"]
            == hashlib.sha256(response.content).hexdigest()
        )
        assert "# Timeline" in response.text
        assert "Cited event [^artifact-part-1]" in response.text

        json_response = auth_client.post(
            f"/artifacts/{artifact_id}/export?format=json",
            headers=auth_headers(user_id),
        )
        assert json_response.status_code == 200, json_response.text
        data = json_response.json()
        assert data["artifact"]["id"] == str(artifact_id)
        assert data["citation_manifest"]["entries"][0]["artifact_part_id"] == str(part_id)
        assert data["citation_manifest"]["entries"][0]["source_ref"]["type"] == "message_retrieval"
        assert data["citation_manifest"]["entries"][0]["source_ref"]["id"] == "retrieval-1"
        assert (
            json_response.headers["x-nexus-artifact-content-sha256"]
            == hashlib.sha256(json_response.content).hexdigest()
        )

        repeat_markdown_response = auth_client.post(
            f"/artifacts/{artifact_id}/export?format=markdown",
            headers=auth_headers(user_id),
        )
        assert repeat_markdown_response.status_code == 200, repeat_markdown_response.text
        assert repeat_markdown_response.content == response.content, (
            "Re-exporting markdown for an unchanged artifact must be byte-identical"
        )

        for export_format, content_type in {
            "html": "text/html",
            "csv": "text/csv",
            "pdf": "application/pdf",
        }.items():
            format_response = auth_client.post(
                f"/artifacts/{artifact_id}/export?format={export_format}",
                headers=auth_headers(user_id),
            )
            assert format_response.status_code == 200, format_response.text
            assert format_response.headers["content-type"].startswith(content_type)
            assert (
                format_response.headers["x-nexus-artifact-manifest-sha256"]
                == response.headers["x-nexus-artifact-manifest-sha256"]
            )

        with direct_db.session() as session:
            export_rows = (
                session.execute(
                    text(
                        """
                        SELECT export_format,
                               artifact_version,
                               content_sha256,
                               manifest_sha256
                        FROM message_artifact_exports
                        WHERE artifact_id = :artifact_id
                        ORDER BY created_at ASC, id ASC
                        """
                    ),
                    {"artifact_id": artifact_id},
                )
                .mappings()
                .all()
            )
        assert [row["export_format"] for row in export_rows] == [
            "markdown",
            "json",
            "markdown",
            "html",
            "csv",
            "pdf",
        ]
        assert {row["artifact_version"] for row in export_rows} == {1}
        assert export_rows[0]["content_sha256"] == export_rows[2]["content_sha256"]
        assert len({row["manifest_sha256"] for row in export_rows}) == 1

        ledger_response = auth_client.get(
            f"/artifacts/{artifact_id}/exports",
            headers=auth_headers(user_id),
        )
        assert ledger_response.status_code == 200, ledger_response.text
        ledger_rows = ledger_response.json()["data"]
        assert [row["format"] for row in ledger_rows] == [
            "pdf",
            "csv",
            "html",
            "markdown",
            "json",
            "markdown",
        ]
        assert {row["artifact_version"] for row in ledger_rows} == {1}
        assert {row["manifest_sha256"] for row in ledger_rows} == {
            response.headers["x-nexus-artifact-manifest-sha256"]
        }
        assert ledger_rows[0]["metadata"] == {
            "artifact_key": "artifact-1",
            "artifact_kind": "timeline",
            "part_count": 1,
        }

    def test_artifact_export_ledgers_are_visible_to_owner_and_private_to_shared_reader(
        self, auth_client, direct_db: DirectSessionManager
    ):
        owner_id = create_test_user_id()
        reader_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(owner_id))
        auth_client.get("/me", headers=auth_headers(reader_id))
        artifact_id = uuid4()
        part_id = uuid4()

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, owner_id)
            user_message_id = create_test_message(session, conversation_id, seq=1, content="Make")
            assistant_message_id = create_test_message(
                session,
                conversation_id,
                seq=2,
                role="assistant",
                content="Done",
                parent_message_id=user_message_id,
            )
            library_id = create_shared_library(session, owner_id)
            add_member_to_library(session, library_id, reader_id)
            share_conversation_to_library(session, conversation_id, library_id)
            session.execute(
                text(
                    """
                    INSERT INTO message_artifacts (
                        id, conversation_id, message_id, artifact_key,
                        artifact_kind, title, status
                    )
                    VALUES (
                        :artifact_id, :conversation_id, :message_id, 'artifact-1',
                        'timeline', 'Timeline', 'complete'
                    )
                    """
                ),
                {
                    "artifact_id": artifact_id,
                    "conversation_id": conversation_id,
                    "message_id": assistant_message_id,
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO message_artifact_parts (
                        id, artifact_id, ordinal, part_key, part_type, text,
                        source_version, locator, source_ref, evidence_span_ids
                    )
                    VALUES (
                        :part_id, :artifact_id, 0, 'part-1', 'event', 'Cited event',
                        concat('artifact_part', chr(58), CAST(:part_id AS text), chr(58), 'v1'),
                        jsonb_build_object(
                            'type', 'artifact_part_ref',
                            'artifact_id', CAST(:artifact_id AS text),
                            'artifact_part_id', CAST(:part_id AS text),
                            'message_id', CAST(:message_id AS text),
                            'conversation_id', CAST(:conversation_id AS text),
                            'part_key', 'part-1'
                        ),
                        '{"type":"message","id":"reader-visible"}'::jsonb,
                        '[]'::jsonb
                    )
                    """
                ),
                {
                    "part_id": part_id,
                    "artifact_id": artifact_id,
                    "message_id": assistant_message_id,
                    "conversation_id": conversation_id,
                },
            )
            session.commit()

        direct_db.register_cleanup("conversation_shares", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("message_artifacts", "id", artifact_id)
        direct_db.register_cleanup("message_artifact_parts", "artifact_id", artifact_id)
        direct_db.register_cleanup("message_artifact_exports", "artifact_id", artifact_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        owner_export = auth_client.post(
            f"/artifacts/{artifact_id}/export?format=markdown",
            headers=auth_headers(owner_id),
        )
        assert owner_export.status_code == 200, owner_export.text
        reader_export = auth_client.post(
            f"/artifacts/{artifact_id}/export?format=json",
            headers=auth_headers(reader_id),
        )
        assert reader_export.status_code == 200, reader_export.text

        owner_ledgers = auth_client.get(
            f"/artifacts/{artifact_id}/exports",
            headers=auth_headers(owner_id),
        )
        assert owner_ledgers.status_code == 200, owner_ledgers.text
        assert [row["format"] for row in owner_ledgers.json()["data"]] == ["json", "markdown"]

        reader_ledgers = auth_client.get(
            f"/artifacts/{artifact_id}/exports",
            headers=auth_headers(reader_id),
        )
        assert reader_ledgers.status_code == 200, reader_ledgers.text
        assert [row["format"] for row in reader_ledgers.json()["data"]] == ["json"]
        assert reader_ledgers.json()["data"][0]["viewer_user_id"] == str(reader_id)

    def test_create_artifact_requires_assistant_message_parts_and_readable_refs(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_id)
            user_message_id = create_test_message(session, conversation_id, seq=1, content="Make")
            assistant_message_id = create_test_message(
                session,
                conversation_id,
                seq=2,
                role="assistant",
                content="Done",
                parent_message_id=user_message_id,
            )
            session.commit()

        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)

        missing_key_response = auth_client.post(
            "/artifacts",
            headers=auth_headers(user_id),
            json={
                "message_id": str(assistant_message_id),
                "artifact_kind": "timeline",
                "parts": [
                    {
                        "part_key": "part-1",
                        "text": "Cited event",
                        "source_ref": {"type": "message", "id": str(user_message_id)},
                    }
                ],
            },
        )
        assert missing_key_response.status_code == 400, missing_key_response.text

        user_message_response = auth_client.post(
            "/artifacts",
            headers=auth_headers(user_id),
            json={
                "message_id": str(user_message_id),
                "artifact_key": "artifact-1",
                "artifact_kind": "timeline",
                "parts": [
                    {
                        "part_key": "part-1",
                        "text": "Cited event",
                        "source_ref": {"type": "message", "id": str(user_message_id)},
                    }
                ],
            },
        )
        assert user_message_response.status_code == 400, user_message_response.text

        empty_response = auth_client.post(
            "/artifacts",
            headers=auth_headers(user_id),
            json={
                "message_id": str(assistant_message_id),
                "artifact_key": "artifact-1",
                "artifact_kind": "timeline",
            },
        )
        assert empty_response.status_code == 400, empty_response.text

        response = auth_client.post(
            "/artifacts",
            headers=auth_headers(user_id),
            json={
                "message_id": str(assistant_message_id),
                "artifact_key": "artifact-1",
                "artifact_kind": "timeline",
                "title": "Timeline",
                "parts": [
                    {
                        "part_key": "part-1",
                        "part_type": "event",
                        "text": "Cited event",
                        "source_ref": {"type": "message", "id": str(user_message_id)},
                    }
                ],
            },
        )
        assert response.status_code == 201, response.text
        data = response.json()["data"]
        direct_db.register_cleanup("message_artifacts", "id", data["id"])
        direct_db.register_cleanup("message_artifact_parts", "artifact_id", data["id"])
        assert data["message_id"] == str(assistant_message_id)
        assert data["artifact_version"] == 1
        assert data["supersedes_artifact_id"] is None
        assert data["parts"][0]["source_ref"]["type"] == "message"
        assert data["parts"][0]["source_ref"]["id"] == str(user_message_id)

        next_response = auth_client.post(
            "/artifacts",
            headers=auth_headers(user_id),
            json={
                "message_id": str(assistant_message_id),
                "artifact_key": "artifact-1",
                "artifact_kind": "timeline",
                "title": "Timeline revised",
                "parts": [
                    {
                        "part_key": "part-1",
                        "part_type": "event",
                        "text": "Cited event revised",
                        "source_ref": {"type": "message", "id": str(user_message_id)},
                    }
                ],
            },
        )
        assert next_response.status_code == 201, next_response.text
        next_data = next_response.json()["data"]
        direct_db.register_cleanup("message_artifacts", "id", next_data["id"])
        direct_db.register_cleanup("message_artifact_parts", "artifact_id", next_data["id"])
        assert next_data["artifact_version"] == 2
        assert next_data["supersedes_artifact_id"] == data["id"]

    def test_artifact_ask_returns_chat_run_payload(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        artifact_id = uuid4()
        part_id = uuid4()
        first_span_id = uuid4()
        second_span_id = uuid4()
        model_id = uuid4()
        artifact_version = 7

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_id)
            user_message_id = create_test_message(session, conversation_id, seq=1, content="Make")
            assistant_message_id = create_test_message(
                session,
                conversation_id,
                seq=2,
                role="assistant",
                content="Done",
                parent_message_id=user_message_id,
            )
            session.execute(
                text(
                    """
                    INSERT INTO message_artifacts (
                        id, conversation_id, message_id, artifact_key,
                        artifact_kind, title, status, artifact_version
                    )
                    VALUES (
                        :artifact_id, :conversation_id, :message_id, 'artifact-1',
                        'timeline', 'Timeline', 'complete', :artifact_version
                    )
                    """
                ),
                {
                    "artifact_id": artifact_id,
                    "conversation_id": conversation_id,
                    "message_id": assistant_message_id,
                    "artifact_version": artifact_version,
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO message_artifact_parts (
                        id, artifact_id, ordinal, part_key, part_type, text,
                        source_version, locator, evidence_span_ids, metadata
                    )
                    VALUES (
                        :part_id, :artifact_id, 0, 'part-1', 'event', 'Cited event',
                        concat('artifact_part', chr(58), CAST(:part_id AS text), chr(58), 'v1'),
                        jsonb_build_object(
                            'type', 'artifact_part_ref',
                            'artifact_id', CAST(:artifact_id AS text),
                            'artifact_part_id', CAST(:part_id AS text),
                            'message_id', CAST(:message_id AS text),
                            'conversation_id', CAST(:conversation_id AS text),
                            'part_key', 'part-1'
                        ),
                        jsonb_build_array(
                            to_jsonb(CAST(:first_span_id AS text)),
                            to_jsonb(CAST(:second_span_id AS text))
                        ),
                        '{"support_state":"not_source_grounded"}'::jsonb
                    )
                    """
                ),
                {
                    "part_id": part_id,
                    "artifact_id": artifact_id,
                    "message_id": assistant_message_id,
                    "conversation_id": conversation_id,
                    "first_span_id": first_span_id,
                    "second_span_id": second_span_id,
                },
            )
            session.commit()

        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("message_artifacts", "id", artifact_id)
        direct_db.register_cleanup("message_artifact_parts", "artifact_id", artifact_id)

        response = auth_client.post(
            f"/artifacts/{artifact_id}/ask",
            headers=auth_headers(user_id),
            json={
                "content": "Explain this part",
                "artifact_part_id": str(part_id),
                "model_id": str(model_id),
            },
        )

        assert response.status_code == 200, response.text
        payload = response.json()["data"]
        ChatRunCreateRequest.model_validate(payload)
        assert "conversation_scope" not in payload
        assert payload["conversation_id"] == str(conversation_id)
        assert payload["parent_message_id"] == str(assistant_message_id)
        assert payload["branch_anchor"] == {
            "kind": "assistant_message",
            "message_id": str(assistant_message_id),
        }
        assert payload["artifact_intent"] == {"kind": "off"}
        assert payload["contexts"][0]["kind"] == "object_ref"
        assert payload["contexts"][0]["type"] == "artifact_part"
        assert payload["contexts"][0]["id"] == str(part_id)
        assert payload["contexts"][0]["artifact_id"] == str(artifact_id)
        assert payload["contexts"][0]["artifact_key"] == "artifact-1"
        assert payload["contexts"][0]["artifact_version"] == artifact_version
        assert payload["contexts"][0]["evidence_span_ids"] == [
            str(first_span_id),
            str(second_span_id),
        ]
        assert payload["contexts"][0]["source_version"] == f"artifact_part:{part_id}:v1"
        assert payload["contexts"][0]["locator"] == {
            "type": "artifact_part_ref",
            "artifact_id": str(artifact_id),
            "artifact_part_id": str(part_id),
            "message_id": str(assistant_message_id),
            "conversation_id": str(conversation_id),
            "part_key": "part-1",
        }
        provenance = payload["contexts"][0]["artifact_part_provenance"]
        assert provenance["artifact_part_id"] == str(part_id)
        assert provenance["artifact_version"] == artifact_version
        assert provenance["evidence_span_ids"] == [
            str(first_span_id),
            str(second_span_id),
        ]

        whole_response = auth_client.post(
            f"/artifacts/{artifact_id}/ask",
            headers=auth_headers(user_id),
            json={
                "content": "Explain the artifact",
                "model_id": str(model_id),
            },
        )

        assert whole_response.status_code == 200, whole_response.text
        whole_payload = whole_response.json()["data"]
        ChatRunCreateRequest.model_validate(whole_payload)
        assert "conversation_scope" not in whole_payload
        whole_context = whole_payload["contexts"][0]
        assert whole_context["type"] == "artifact"
        assert whole_context["id"] == str(artifact_id)
        assert whole_context["artifact_id"] == str(artifact_id)
        assert whole_context["artifact_key"] == "artifact-1"
        assert whole_context["artifact_version"] == artifact_version
        whole_provenance = whole_context["artifact_part_provenance"]
        assert whole_provenance["type"] == "artifact"
        assert whole_provenance["artifact_id"] == str(artifact_id)
        assert whole_provenance["artifact_key"] == "artifact-1"
        assert whole_provenance["artifact_version"] == artifact_version

        missing_part_response = auth_client.post(
            f"/artifacts/{artifact_id}/ask",
            headers=auth_headers(user_id),
            json={
                "content": "Explain this missing part",
                "artifact_part_id": str(uuid4()),
                "model_id": str(model_id),
            },
        )
        assert missing_part_response.status_code == 404, missing_part_response.text
        assert missing_part_response.json()["error"]["code"] == "E_NOT_FOUND"

    def test_source_manifest_message_cleanup(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_id)
            model_id = create_test_model(session)
            user_message_id = create_test_message(session, conversation_id, seq=1, content="Find")
            assistant_message_id = create_test_message(
                session,
                conversation_id,
                seq=2,
                role="assistant",
                content="Done",
                parent_message_id=user_message_id,
            )
            run_id = uuid4()
            tool_call_id = uuid4()
            manifest_id = uuid4()
            session.execute(
                text(
                    """
                    INSERT INTO chat_runs (
                        id,
                        owner_user_id,
                        conversation_id,
                        user_message_id,
                        assistant_message_id,
                        idempotency_key,
                        payload_hash,
                        status,
                        model_id,
                        reasoning,
                        key_mode,
                        web_search
                    )
                    VALUES (
                        :run_id,
                        :user_id,
                        :conversation_id,
                        :user_message_id,
                        :assistant_message_id,
                        :idempotency_key,
                        'payload',
                        'complete',
                        :model_id,
                        'none',
                        'auto',
                        '{"mode":"auto"}'::jsonb
                    )
                    """
                ),
                {
                    "run_id": run_id,
                    "user_id": user_id,
                    "conversation_id": conversation_id,
                    "user_message_id": user_message_id,
                    "assistant_message_id": assistant_message_id,
                    "idempotency_key": str(uuid4()),
                    "model_id": model_id,
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO message_tool_calls (
                        id,
                        conversation_id,
                        user_message_id,
                        assistant_message_id,
                        tool_name,
                        tool_call_index,
                        query_hash,
                        scope,
                        requested_types,
                        semantic,
                        status
                    )
                    VALUES (
                        :tool_call_id,
                        :conversation_id,
                        :user_message_id,
                        :assistant_message_id,
                        'web_search',
                        1,
                        'sha256:web',
                        'public_web',
                        '["web_result"]'::jsonb,
                        false,
                        'complete'
                    )
                    """
                ),
                {
                    "tool_call_id": tool_call_id,
                    "conversation_id": conversation_id,
                    "user_message_id": user_message_id,
                    "assistant_message_id": assistant_message_id,
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO source_manifests (
                        id,
                        conversation_id,
                        assistant_message_id,
                        chat_run_id,
                        tool_call_id,
                        tool_name,
                        tool_call_index,
                        query_hash,
                        scope,
                        filters,
                        requested_types,
                        candidate_count,
                        result_count,
                        selected_count,
                        included_in_prompt_count,
                        excluded_by_budget_count,
                        excluded_by_scope_count,
                        stale_count,
                        unreadable_count,
                        web_search_mode,
                        index_versions,
                        metadata,
                        latency_ms,
                        status,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        :manifest_id,
                        :conversation_id,
                        :assistant_message_id,
                        :run_id,
                        :tool_call_id,
                        'web_search',
                        1,
                        'sha256:web',
                        'public_web',
                        '{"allowed_domains":["example.com"]}'::jsonb,
                        '["web_result"]'::jsonb,
                        3,
                        3,
                        2,
                        1,
                        1,
                        0,
                        0,
                        0,
                        'auto',
                        '["web:index:v1"]'::jsonb,
                        '{"provider":"test"}'::jsonb,
                        25,
                        'complete',
                        now(),
                        now()
                    )
                    """
                ),
                {
                    "manifest_id": manifest_id,
                    "conversation_id": conversation_id,
                    "assistant_message_id": assistant_message_id,
                    "run_id": run_id,
                    "tool_call_id": tool_call_id,
                },
            )
            session.commit()

        direct_db.register_cleanup("source_manifests", "id", manifest_id)
        direct_db.register_cleanup("message_tool_calls", "id", tool_call_id)
        direct_db.register_cleanup("chat_runs", "id", run_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)

        delete_response = auth_client.delete(
            f"/messages/{assistant_message_id}",
            headers=auth_headers(user_id),
        )
        assert delete_response.status_code == 204, delete_response.text

        with direct_db.session() as session:
            remaining = session.execute(
                text("SELECT count(*) FROM source_manifests WHERE id = :id"),
                {"id": manifest_id},
            ).scalar_one()
        assert remaining == 0

    def test_message_ledger_read_paths_include_honest_candidate_prompt_status(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_id)
            model_id = create_test_model(session)
            user_message_id = create_test_message(session, conversation_id, seq=1, content="Find")
            assistant_message_id = create_test_message(
                session,
                conversation_id,
                seq=2,
                role="assistant",
                content="Done",
                parent_message_id=user_message_id,
            )
            run = ChatRun(
                id=uuid4(),
                owner_user_id=user_id,
                conversation_id=conversation_id,
                user_message_id=user_message_id,
                assistant_message_id=assistant_message_id,
                idempotency_key=str(uuid4()),
                payload_hash="payload",
                status="complete",
                model_id=model_id,
                reasoning="none",
                key_mode="auto",
                web_search={"mode": "off"},
            )
            tool_call = MessageToolCall(
                id=uuid4(),
                conversation_id=conversation_id,
                user_message_id=user_message_id,
                assistant_message_id=assistant_message_id,
                tool_name="app_search",
                tool_call_index=0,
                query_hash="sha256:ledger",
                scope="all",
                requested_types=["message"],
                semantic=True,
                status="complete",
            )
            result_ref = {
                "type": "message",
                "id": str(user_message_id),
                "result_type": "message",
                "source_id": str(user_message_id),
                "conversation_id": str(conversation_id),
                "seq": 1,
                "title": "Source message",
                "snippet": "Evidence excerpt",
                "deep_link": f"/conversations/{conversation_id}",
                "context_ref": {"type": "message", "id": str(user_message_id)},
                "source_version": "message:v1",
                "selected": True,
            }
            locator = {
                "type": "message_offsets",
                "conversation_id": str(conversation_id),
                "message_id": str(user_message_id),
                "start_offset": 0,
                "end_offset": len("Evidence excerpt"),
                "message_seq": 1,
            }
            result_ref["locator"] = locator
            retrieval = MessageRetrieval(
                id=uuid4(),
                tool_call_id=tool_call.id,
                ordinal=0,
                result_type="message",
                source_id=str(user_message_id),
                scope="all",
                context_ref={"type": "message", "id": str(user_message_id)},
                result_ref=result_ref,
                deep_link=f"/conversations/{conversation_id}",
                score=0.9,
                selected=True,
                source_title="Source message",
                exact_snippet="Evidence excerpt",
                locator=locator,
                retrieval_status="included_in_prompt",
                included_in_prompt=True,
                source_version="message:v1",
            )
            candidate = MessageRetrievalCandidateLedger(
                id=uuid4(),
                tool_call_id=tool_call.id,
                retrieval_id=retrieval.id,
                ordinal=0,
                result_type="message",
                source_id=str(user_message_id),
                score=0.9,
                selected=True,
                included_in_prompt=False,
                selection_status="selected",
                selection_reason="within_context_budget",
                result_ref=result_ref,
                locator=locator,
                source_version="message:v1",
            )
            rerank = MessageRerankLedger(
                id=uuid4(),
                tool_call_id=tool_call.id,
                strategy="search_score_then_context_budget",
                input_count=1,
                selected_count=1,
                budget_chars=12000,
                selected_chars=17,
                status="complete",
                metadata_={"selected_limit": 4},
            )
            verifier_run = AssistantMessageVerifierRun(
                id=uuid4(),
                message_id=assistant_message_id,
                chat_run_id=run.id,
                verifier_name="lexical_matcher",
                verifier_version="v1",
                verifier_status="llm_verified",
                support_status="supported",
                claim_count=1,
                supported_claim_count=1,
                unsupported_claim_count=0,
                not_enough_evidence_count=0,
                metadata_={"source": "test"},
            )
            session.add_all(
                [
                    run,
                    tool_call,
                    retrieval,
                    candidate,
                    rerank,
                    verifier_run,
                ]
            )
            session.commit()
            run_id = run.id
            tool_call_id = tool_call.id
            retrieval_id = retrieval.id
            candidate_id = candidate.id
            rerank_id = rerank.id
            verifier_run_id = verifier_run.id

        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("chat_runs", "id", run_id)
        direct_db.register_cleanup("message_tool_calls", "id", tool_call_id)
        direct_db.register_cleanup("message_retrievals", "id", retrieval_id)
        direct_db.register_cleanup("assistant_message_verifier_runs", "id", verifier_run_id)
        direct_db.register_cleanup("message_rerank_ledgers", "id", rerank_id)
        direct_db.register_cleanup("message_retrieval_candidate_ledgers", "id", candidate_id)

        verifier_response = auth_client.get(
            f"/messages/{assistant_message_id}/verifier-runs",
            headers=auth_headers(user_id),
        )
        candidate_response = auth_client.get(
            f"/messages/{assistant_message_id}/retrieval-candidate-ledgers",
            headers=auth_headers(user_id),
        )
        rerank_response = auth_client.get(
            f"/messages/{assistant_message_id}/rerank-ledgers",
            headers=auth_headers(user_id),
        )
        filtered_candidate_response = auth_client.get(
            f"/messages/{assistant_message_id}/retrieval-candidate-ledgers?tool_call_id={uuid4()}",
            headers=auth_headers(user_id),
        )

        assert verifier_response.status_code == 200, verifier_response.text
        verifier_data = verifier_response.json()["data"]
        assert verifier_data[0]["id"] == str(verifier_run_id)
        assert verifier_data[0]["verifier_name"] == "lexical_matcher"
        assert verifier_data[0]["metadata"] == {"source": "test"}

        assert candidate_response.status_code == 200, candidate_response.text
        candidate_data = candidate_response.json()["data"]
        assert candidate_data[0]["id"] == str(candidate_id)
        assert candidate_data[0]["included_in_prompt"] is True
        assert candidate_data[0]["ledger_included_in_prompt"] is False
        assert candidate_data[0]["linked_retrieval_included_in_prompt"] is True
        assert candidate_data[0]["included_in_prompt_source"] == "linked_retrieval"
        assert candidate_data[0]["included_in_prompt_reconciled"] is False
        assert candidate_data[0]["selection_status"] == "selected"

        assert rerank_response.status_code == 200, rerank_response.text
        rerank_data = rerank_response.json()["data"]
        assert rerank_data[0]["strategy"] == "search_score_then_context_budget"
        assert rerank_data[0]["metadata"] == {"selected_limit": 4}

        assert filtered_candidate_response.status_code == 200, filtered_candidate_response.text
        assert filtered_candidate_response.json()["data"] == []

    def test_list_messages_preserves_rich_context_snapshot_fields(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        context_id = uuid4()
        chunk_id = uuid4()
        first_span_id = uuid4()
        second_span_id = uuid4()
        media_id = uuid4()
        fragment_id = uuid4()
        source_version = "content-index:test:v1"
        locator = {
            "type": "web_text_offsets",
            "media_id": str(media_id),
            "fragment_id": str(fragment_id),
            "start_offset": 0,
            "end_offset": 12,
        }
        context_snapshot = {
            **object_ref_context_snapshot(
                object_type="content_chunk",
                object_id=chunk_id,
                title="Saved Context Title",
                preview="Saved preview",
                route=f"/media/{media_id}",
                evidence_span_ids=[first_span_id, second_span_id],
                media_id=media_id,
                media_title="Snapshot Source",
                media_kind="web_article",
                locator=locator,
                source_version=source_version,
            ),
            "color": "green",
            "exact": "exact quote",
            "prefix": "before",
            "suffix": "after",
        }

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_id)
            message_id = create_test_message(
                session,
                conversation_id,
                seq=1,
                content="Message with saved context",
            )
            session.execute(
                text(
                    """
                    INSERT INTO message_context_items (
                        id,
                        message_id,
                        user_id,
                        context_kind,
                        object_type,
                        object_id,
                        ordinal,
                        context_snapshot
                    )
                    VALUES (
                        :id,
                        :message_id,
                        :user_id,
                        'object_ref',
                        'content_chunk',
                        :object_id,
                        0,
                        :context_snapshot
                    )
                    """
                ).bindparams(bindparam("context_snapshot", type_=JSONB)),
                {
                    "id": context_id,
                    "message_id": message_id,
                    "user_id": user_id,
                    "object_id": chunk_id,
                    "context_snapshot": context_snapshot,
                },
            )
            session.commit()

        direct_db.register_cleanup("message_context_items", "id", context_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("users", "id", user_id)

        response = auth_client.get(
            f"/conversations/{conversation_id}/messages", headers=auth_headers(user_id)
        )

        assert response.status_code == 200, (
            f"Expected message list to succeed, got {response.status_code}: {response.text}"
        )
        context = response.json()["data"][0]["contexts"][0]
        assert context == {
            "kind": "object_ref",
            "type": "content_chunk",
            "id": str(chunk_id),
            "evidence_span_ids": [str(first_span_id), str(second_span_id)],
            "color": "green",
            "preview": "Saved preview",
            "exact": "exact quote",
            "prefix": "before",
            "suffix": "after",
            "media_id": str(media_id),
            "media_title": "Snapshot Source",
            "media_kind": "web_article",
            "locator": locator,
            "source_version": source_version,
            "title": "Saved Context Title",
            "route": f"/media/{media_id}",
        }

    def test_load_message_context_snapshots_rejects_invalid_object_ref_evidence_span_ids(
        self,
        db_session: Session,
        bootstrapped_user: UUID,
    ):
        message_id = self._insert_object_ref_context_snapshot(
            db_session,
            user_id=bootstrapped_user,
            snapshot={
                "evidence_span_ids": ["not-a-uuid"],
            },
        )

        with pytest.raises(ValueError, match="evidence_span_ids must be UUIDs"):
            load_message_context_snapshots_for_message_ids(db_session, [message_id])

    @pytest.mark.parametrize(
        ("field_name", "field_value", "error_message"),
        [
            ("color", "orange", "context snapshot color must be a highlight color"),
            ("media_id", "not-a-uuid", "context snapshot media_id must be a UUID string"),
            ("locator", "not-an-object", "context snapshot locator must be an object"),
            ("source_version", 42, "context snapshot source_version must be a string"),
            (
                "source_version",
                "",
                "context snapshot source_version must be a non-empty string",
            ),
            ("title", [], "context snapshot title must be a string"),
            ("preview", 7, "context snapshot preview must be a string"),
        ],
    )
    def test_load_message_context_snapshots_rejects_invalid_object_ref_optional_fields(
        self,
        db_session: Session,
        bootstrapped_user: UUID,
        field_name: str,
        field_value: object,
        error_message: str,
    ):
        message_id = self._insert_object_ref_context_snapshot(
            db_session,
            user_id=bootstrapped_user,
            snapshot={field_name: field_value},
        )

        with pytest.raises(ValueError, match=error_message):
            load_message_context_snapshots_for_message_ids(db_session, [message_id])

    def test_list_messages_returns_reader_selection_snapshot(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        context_id = uuid4()
        client_context_id = uuid4()
        media_id = uuid4()
        conversation_id = uuid4()

        locator = {
            "type": "web_text_offsets",
            "media_id": str(media_id),
            "fragment_id": str(uuid4()),
            "start_offset": 4,
            "end_offset": 18,
            "media_kind": "web_article",
        }
        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_id)
            message_id = create_test_message(
                session,
                conversation_id,
                seq=1,
                content="Message with reader selection",
            )
            session.execute(
                text("""
                    INSERT INTO message_context_items (
                        id,
                        message_id,
                        user_id,
                        context_kind,
                        source_media_id,
                        locator_json,
                        ordinal,
                        context_snapshot
                    )
                    VALUES (
                        :id,
                        :message_id,
                        :user_id,
                        'reader_selection',
                        :media_id,
                        :locator,
                        0,
                        :context_snapshot
                    )
                """).bindparams(
                    bindparam("locator", type_=JSONB),
                    bindparam("context_snapshot", type_=JSONB),
                ),
                {
                    "id": context_id,
                    "message_id": message_id,
                    "user_id": user_id,
                    "media_id": media_id,
                    "locator": locator,
                    "context_snapshot": {
                        "kind": "reader_selection",
                        "client_context_id": str(client_context_id),
                        "media_id": str(media_id),
                        "source_media_id": str(media_id),
                        "media_title": "Reader Source",
                        "media_kind": "web_article",
                        "exact": "selected quote",
                        "prefix": "before ",
                        "suffix": " after",
                        "locator": locator,
                        "source_version": "content-index:v1",
                        "route": f"/media/{media_id}",
                    },
                },
            )
            session.commit()

        direct_db.register_cleanup("message_context_items", "id", context_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        response = auth_client.get(
            f"/conversations/{conversation_id}/messages", headers=auth_headers(user_id)
        )

        assert response.status_code == 200, response.text
        context = response.json()["data"][0]["contexts"][0]
        assert context == {
            "kind": "reader_selection",
            "client_context_id": str(client_context_id),
            "exact": "selected quote",
            "prefix": "before ",
            "suffix": " after",
            "media_id": str(media_id),
            "source_media_id": str(media_id),
            "media_title": "Reader Source",
            "media_kind": "web_article",
            "locator": locator,
            "source_version": "content-index:v1",
            "route": f"/media/{media_id}",
        }

    def test_list_messages_returns_claim_evidence(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_id)
            user_message_id = create_test_message(
                session,
                conversation_id,
                seq=1,
                content="What supports this?",
            )
            assistant_message_id = create_test_message(
                session,
                conversation_id,
                seq=2,
                role="assistant",
                content="The answer is supported.",
                parent_message_id=user_message_id,
            )
            summary_id = uuid4()
            claim_id = uuid4()
            evidence_id = uuid4()
            retrieval_id = uuid4()
            tool_call_id = uuid4()
            audit_id = uuid4()
            session.execute(
                text(
                    """
                    INSERT INTO message_tool_calls (
                        id,
                        conversation_id,
                        user_message_id,
                        assistant_message_id,
                        tool_name,
                        tool_call_index,
                        scope,
                        status
                    )
                    VALUES (
                        :tool_call_id,
                        :conversation_id,
                        :user_message_id,
                        :assistant_message_id,
                        'app_search',
                        0,
                        'all',
                        'complete'
                    )
                    """
                ),
                {
                    "tool_call_id": tool_call_id,
                    "conversation_id": conversation_id,
                    "user_message_id": user_message_id,
                    "assistant_message_id": assistant_message_id,
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO message_retrievals (
                        id,
                        tool_call_id,
                        ordinal,
                        result_type,
                        source_id,
                        context_ref,
                        result_ref,
                        deep_link,
                        selected,
                        exact_snippet,
                        locator,
                        retrieval_status,
                        included_in_prompt,
                        source_version
                    )
                    VALUES (
                        :retrieval_id,
                        :tool_call_id,
                        0,
                        'message',
                        :source_id,
                        :context_ref,
                        :result_ref,
                        :deep_link,
                        true,
                        'Exact source excerpt.',
                        :locator,
                        'included_in_prompt',
                        true,
                        'message:v1'
                    )
                    """
                ).bindparams(
                    bindparam("context_ref", type_=JSONB),
                    bindparam("result_ref", type_=JSONB),
                    bindparam("locator", type_=JSONB),
                ),
                {
                    "retrieval_id": retrieval_id,
                    "tool_call_id": tool_call_id,
                    "source_id": str(assistant_message_id),
                    "context_ref": {"type": "message", "id": str(assistant_message_id)},
                    "result_ref": {
                        "type": "message",
                        "id": str(assistant_message_id),
                        "result_type": "message",
                        "source_id": str(assistant_message_id),
                        "conversation_id": str(conversation_id),
                        "seq": 2,
                        "title": "Source message",
                        "snippet": "Exact source excerpt.",
                        "deep_link": f"/conversations/{conversation_id}",
                        "context_ref": {"type": "message", "id": str(assistant_message_id)},
                        "source_version": "message:v1",
                        "locator": {
                            "type": "message_offsets",
                            "conversation_id": str(conversation_id),
                            "message_id": str(assistant_message_id),
                            "start_offset": 0,
                            "end_offset": len("Exact source excerpt."),
                            "message_seq": 2,
                        },
                    },
                    "locator": {
                        "type": "message_offsets",
                        "conversation_id": str(conversation_id),
                        "message_id": str(assistant_message_id),
                        "start_offset": 0,
                        "end_offset": len("Exact source excerpt."),
                        "message_seq": 2,
                    },
                    "deep_link": f"/conversations/{conversation_id}",
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO assistant_message_evidence_summaries (
                        id,
                        message_id,
                        scope_type,
                        scope_ref,
                        retrieval_status,
                        support_status,
                        verifier_status,
                        claim_count,
                        supported_claim_count,
                        unsupported_claim_count,
                        not_enough_evidence_count
                    )
                    VALUES (
                        :summary_id,
                        :message_id,
                        'general',
                        NULL,
                        'included_in_prompt',
                        'supported',
                        'llm_verified',
                        1,
                        1,
                        0,
                        0
                    )
                    """
                ),
                {"summary_id": summary_id, "message_id": assistant_message_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO assistant_message_claims (
                        id,
                        message_id,
                        ordinal,
                        claim_text,
                        answer_start_offset,
                        answer_end_offset,
                        claim_kind,
                        support_status,
                        verifier_status
                    )
                    VALUES (
                        :claim_id,
                        :message_id,
                        0,
                        'The answer is supported.',
                        0,
                        24,
                        'answer',
                        'supported',
                        'llm_verified'
                    )
                    """
                ),
                {"claim_id": claim_id, "message_id": assistant_message_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO assistant_message_claim_evidence (
                        id,
                        claim_id,
                        ordinal,
                        evidence_role,
                        source_ref,
                        retrieval_id,
                        context_ref,
                        result_ref,
                        exact_snippet,
                        locator,
                        deep_link,
                        retrieval_status,
                        selected,
                        included_in_prompt,
                        source_version
                    )
                    VALUES (
                        :evidence_id,
                        :claim_id,
                        0,
                        'supports',
                        :source_ref,
                        :retrieval_id,
                        :context_ref,
                        :result_ref,
                        'Exact source excerpt.',
                        :locator,
                        :deep_link,
                        'included_in_prompt',
                        true,
                        true,
                        'message:v1'
                    )
                    """
                ).bindparams(
                    bindparam("source_ref", type_=JSONB),
                    bindparam("context_ref", type_=JSONB),
                    bindparam("result_ref", type_=JSONB),
                    bindparam("locator", type_=JSONB),
                ),
                {
                    "evidence_id": evidence_id,
                    "claim_id": claim_id,
                    "source_ref": {
                        "type": "message_retrieval",
                        "id": str(retrieval_id),
                        "retrieval_id": str(retrieval_id),
                    },
                    "retrieval_id": retrieval_id,
                    "context_ref": {"type": "message", "id": str(assistant_message_id)},
                    "result_ref": {
                        "type": "message",
                        "id": str(assistant_message_id),
                        "result_type": "message",
                        "source_id": str(assistant_message_id),
                        "conversation_id": str(conversation_id),
                        "seq": 2,
                        "title": "Source message",
                        "snippet": "Exact source excerpt.",
                        "deep_link": f"/conversations/{conversation_id}",
                        "context_ref": {"type": "message", "id": str(assistant_message_id)},
                        "source_version": "message:v1",
                        "locator": {
                            "type": "message_offsets",
                            "conversation_id": str(conversation_id),
                            "message_id": str(assistant_message_id),
                            "start_offset": 0,
                            "end_offset": len("Exact source excerpt."),
                            "message_seq": 2,
                        },
                    },
                    "locator": {
                        "type": "message_offsets",
                        "conversation_id": str(conversation_id),
                        "message_id": str(assistant_message_id),
                        "start_offset": 0,
                        "end_offset": len("Exact source excerpt."),
                        "message_seq": 2,
                    },
                    "deep_link": f"/conversations/{conversation_id}",
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO assistant_message_citation_audits (
                        id,
                        message_id,
                        chat_run_id,
                        verifier_run_id,
                        supported_claim_count,
                        supported_claims_with_valid_offsets_count,
                        supported_claims_with_citation_count,
                        missing_locator_count,
                        missing_source_version_count,
                        supported_claims_have_valid_offsets,
                        supported_claims_have_citation_placement,
                        claim_evidence_has_required_locators,
                        claim_evidence_has_source_versions,
                        details
                    )
                    VALUES (
                        :audit_id,
                        :message_id,
                        NULL,
                        NULL,
                        1,
                        1,
                        1,
                        0,
                        0,
                        true,
                        true,
                        true,
                        true,
                        :details
                    )
                    """
                ).bindparams(bindparam("details", type_=JSONB)),
                {
                    "audit_id": audit_id,
                    "message_id": assistant_message_id,
                    "details": {},
                },
            )
            session.execute(
                text(
                    """
                    UPDATE messages
                    SET message_document = :message_document
                    WHERE id = :message_id
                    """
                ).bindparams(bindparam("message_document", type_=JSONB)),
                {
                    "message_id": assistant_message_id,
                    "message_document": {
                        "type": "message_document",
                        "version": 1,
                        "blocks": [
                            {
                                "type": "text",
                                "format": "markdown",
                                "text": "The answer is supported.",
                            },
                            {
                                "type": "verification_summary",
                                "id": str(summary_id),
                                "message_id": str(assistant_message_id),
                                "scope_type": "general",
                                "scope_ref": None,
                                "retrieval_status": "included_in_prompt",
                                "support_status": "supported",
                                "verifier_status": "llm_verified",
                                "claim_count": 1,
                                "supported_claim_count": 1,
                                "unsupported_claim_count": 0,
                                "not_enough_evidence_count": 0,
                                "prompt_assembly_id": None,
                                "created_at": "2026-01-01T00:00:00Z",
                                "updated_at": "2026-01-01T00:00:00Z",
                            },
                            {
                                "type": "citation_audit",
                                "id": str(audit_id),
                                "message_id": str(assistant_message_id),
                                "chat_run_id": None,
                                "verifier_run_id": None,
                                "supported_claim_count": 1,
                                "supported_claims_with_valid_offsets_count": 1,
                                "supported_claims_with_citation_count": 1,
                                "missing_locator_count": 0,
                                "missing_source_version_count": 0,
                                "supported_claims_have_valid_offsets": True,
                                "supported_claims_have_citation_placement": True,
                                "claim_evidence_has_required_locators": True,
                                "claim_evidence_has_source_versions": True,
                                "details": {},
                                "created_at": "2026-01-01T00:00:00Z",
                            },
                            {
                                "type": "claim",
                                "claim_id": str(claim_id),
                                "message_id": str(assistant_message_id),
                                "ordinal": 0,
                                "claim_text": "The answer is supported.",
                                "answer_start_offset": 0,
                                "answer_end_offset": 24,
                                "claim_kind": "answer",
                                "support_status": "supported",
                                "unsupported_reason": None,
                                "confidence": None,
                                "verifier_status": "llm_verified",
                                "created_at": "2026-01-01T00:00:00Z",
                                "evidence_ids": [str(evidence_id)],
                            },
                            {
                                "type": "claim_evidence",
                                "id": str(evidence_id),
                                "claim_id": str(claim_id),
                                "ordinal": 0,
                                "evidence_role": "supports",
                                "source_ref": {
                                    "type": "message_retrieval",
                                    "id": str(retrieval_id),
                                    "retrieval_id": str(retrieval_id),
                                },
                                "retrieval_id": str(retrieval_id),
                                "evidence_span_id": None,
                                "context_ref": {
                                    "type": "message",
                                    "id": str(assistant_message_id),
                                },
                                "result_ref": {
                                    "type": "message",
                                    "id": str(assistant_message_id),
                                    "result_type": "message",
                                    "source_id": str(assistant_message_id),
                                    "conversation_id": str(conversation_id),
                                    "seq": 2,
                                    "title": "Source message",
                                    "snippet": "Exact source excerpt.",
                                    "deep_link": f"/conversations/{conversation_id}",
                                    "context_ref": {
                                        "type": "message",
                                        "id": str(assistant_message_id),
                                    },
                                    "source_version": "message:v1",
                                    "locator": {
                                        "type": "message_offsets",
                                        "conversation_id": str(conversation_id),
                                        "message_id": str(assistant_message_id),
                                        "start_offset": 0,
                                        "end_offset": len("Exact source excerpt."),
                                        "message_seq": 2,
                                    },
                                },
                                "exact_snippet": "Exact source excerpt.",
                                "snippet_prefix": None,
                                "snippet_suffix": None,
                                "locator": {
                                    "type": "message_offsets",
                                    "conversation_id": str(conversation_id),
                                    "message_id": str(assistant_message_id),
                                    "start_offset": 0,
                                    "end_offset": len("Exact source excerpt."),
                                    "message_seq": 2,
                                },
                                "deep_link": f"/conversations/{conversation_id}",
                                "citation_label": None,
                                "score": None,
                                "retrieval_status": "included_in_prompt",
                                "selected": True,
                                "included_in_prompt": True,
                                "source_version": "message:v1",
                                "created_at": "2026-01-01T00:00:00Z",
                            },
                        ],
                    },
                },
            )
            session.commit()

        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("message_tool_calls", "id", tool_call_id)
        direct_db.register_cleanup("message_retrievals", "id", retrieval_id)
        direct_db.register_cleanup("assistant_message_evidence_summaries", "id", summary_id)
        direct_db.register_cleanup("assistant_message_claims", "id", claim_id)
        direct_db.register_cleanup("assistant_message_claim_evidence", "id", evidence_id)
        direct_db.register_cleanup(
            "assistant_message_citation_audits", "message_id", assistant_message_id
        )

        response = auth_client.get(
            f"/conversations/{conversation_id}/messages", headers=auth_headers(user_id)
        )

        assert response.status_code == 200
        message = next(
            item for item in response.json()["data"] if item["id"] == str(assistant_message_id)
        )
        assert "evidence_summary" not in message
        assert "citation_audit" not in message
        assert "claims" not in message
        assert "claim_evidence" not in message
        blocks = message["message_document"]["blocks"]
        summary = next(block for block in blocks if block["type"] == "verification_summary")
        audit = next(block for block in blocks if block["type"] == "citation_audit")
        claim = next(block for block in blocks if block["type"] == "claim")
        evidence = next(block for block in blocks if block["type"] == "claim_evidence")
        assert summary["support_status"] == "supported"
        assert audit["supported_claim_count"] == 1
        assert audit["supported_claims_have_citation_placement"] is True
        assert audit["claim_evidence_has_required_locators"] is True
        assert claim["claim_text"] == "The answer is supported."
        assert evidence["exact_snippet"] == "Exact source excerpt."
        assert evidence["retrieval_status"] == "included_in_prompt"

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
# Legacy Streaming Route Removal Tests
# =============================================================================


class TestLegacyStreamingRoutesRemoved:
    """Old conversation-scoped streaming routes are gone after the cutover."""

    def test_new_conversation_stream_route_returns_404(self, auth_client):
        user_id = create_test_user_id()

        response = auth_client.post(
            "/conversations/messages/stream",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 404

    def test_existing_conversation_stream_route_returns_404(self, auth_client):
        user_id = create_test_user_id()

        response = auth_client.post(
            f"/conversations/{uuid4()}/messages/stream",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 404


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

    def test_delete_message_removes_context_links_tool_and_evidence_rows(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        message_context_id = uuid4()
        object_link_id = uuid4()
        tool_call_id = uuid4()
        retrieval_id = uuid4()
        claim_id = uuid4()
        claim_evidence_id = uuid4()

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_id)
            user_message_id = create_test_message(session, conversation_id, seq=1)
            assistant_message_id = create_test_message(
                session,
                conversation_id,
                seq=2,
                role="assistant",
                content="Answer",
            )
            session.execute(
                text("""
                    INSERT INTO message_context_items (
                        id,
                        message_id,
                        user_id,
                        context_kind,
                        object_type,
                        object_id,
                        ordinal,
                        context_snapshot
                    )
                    VALUES (
                        :id,
                        :message_id,
                        :user_id,
                        'object_ref',
                        'message',
                        :object_id,
                        0,
                        :context_snapshot
                    )
                """).bindparams(bindparam("context_snapshot", type_=JSONB)),
                {
                    "id": message_context_id,
                    "message_id": assistant_message_id,
                    "user_id": user_id,
                    "object_id": user_message_id,
                    "context_snapshot": object_ref_context_snapshot(
                        object_type="message",
                        object_id=user_message_id,
                        title="Message #1",
                        preview="Test message",
                        route=f"/conversations/{conversation_id}",
                    ),
                },
            )
            session.execute(
                text("""
                    INSERT INTO object_links (
                        id, user_id, relation_type, a_type, a_id, b_type, b_id, metadata
                    )
                    VALUES (
                        :id, :user_id, 'used_as_context', 'message', :message_id,
                        'message', :object_id, '{}'::jsonb
                    )
                """),
                {
                    "id": object_link_id,
                    "user_id": user_id,
                    "message_id": assistant_message_id,
                    "object_id": user_message_id,
                },
            )
            session.execute(
                text("""
                    INSERT INTO message_tool_calls (
                        id, conversation_id, user_message_id, assistant_message_id,
                        tool_name, tool_call_index, scope, status
                    )
                    VALUES (
                        :id, :conversation_id, :user_message_id, :assistant_message_id,
                        'app_search', 0, 'all', 'complete'
                    )
                """),
                {
                    "id": tool_call_id,
                    "conversation_id": conversation_id,
                    "user_message_id": user_message_id,
                    "assistant_message_id": assistant_message_id,
                },
            )
            session.execute(
                text("""
                    INSERT INTO message_retrievals (
                        id, tool_call_id, ordinal, result_type, source_id,
                        context_ref, result_ref, selected
                    )
                    VALUES (
                        :id, :tool_call_id, 0, 'message', :source_id,
                        jsonb_build_object('type', 'message', 'id', CAST(:source_id AS text)),
                        jsonb_build_object('type', 'message', 'id', CAST(:source_id AS text)),
                        true
                    )
                """),
                {
                    "id": retrieval_id,
                    "tool_call_id": tool_call_id,
                    "source_id": str(user_message_id),
                },
            )
            session.execute(
                text("""
                    INSERT INTO assistant_message_evidence_summaries (
                        message_id, scope_type, scope_ref, retrieval_status, support_status,
                        verifier_status, claim_count, supported_claim_count,
                        unsupported_claim_count, not_enough_evidence_count
                    )
                    VALUES (
                        :message_id, 'general', NULL, 'included_in_prompt', 'supported',
                        'llm_verified', 1, 1, 0, 0
                    )
                """),
                {"message_id": assistant_message_id},
            )
            session.execute(
                text("""
                    INSERT INTO assistant_message_claims (
                        id, message_id, ordinal, claim_text, answer_start_offset,
                        answer_end_offset, claim_kind, support_status, verifier_status
                    )
                    VALUES (
                        :id, :message_id, 0, 'Claim', 0, 5, 'answer', 'supported', 'llm_verified'
                    )
                """),
                {"id": claim_id, "message_id": assistant_message_id},
            )
            session.execute(
                text("""
                    INSERT INTO assistant_message_claim_evidence (
                        id, claim_id, ordinal, evidence_role, source_ref, context_ref,
                        result_ref, exact_snippet, locator, score, retrieval_status,
                        selected, included_in_prompt, source_version
                    )
                    VALUES (
                        :id, :claim_id, 0, 'supports',
                        jsonb_build_object('type', 'message_retrieval', 'id', CAST(:retrieval_id AS text)),
                        jsonb_build_object('type', 'message', 'id', CAST(:source_id AS text)),
                        jsonb_build_object('type', 'message', 'id', CAST(:source_id AS text)),
                        'Evidence',
                        jsonb_build_object(
                            'type', 'message_offsets',
                            'conversation_id', CAST(:conversation_id AS text),
                            'message_id', CAST(:source_id AS text),
                            'start_offset', 0,
                            'end_offset', 8
                        ),
                        1.0, 'included_in_prompt', true, true, 'message:v1'
                    )
                """),
                {
                    "id": claim_evidence_id,
                    "claim_id": claim_id,
                    "retrieval_id": str(retrieval_id),
                    "source_id": str(user_message_id),
                    "conversation_id": str(conversation_id),
                },
            )
            session.commit()

        response = auth_client.delete(
            f"/messages/{assistant_message_id}", headers=auth_headers(user_id)
        )
        assert response.status_code == 204, response.text

        with direct_db.session() as session:
            counts = session.execute(
                text("""
                    SELECT
                        (SELECT count(*) FROM messages WHERE id = :assistant_message_id),
                        (SELECT count(*) FROM conversations WHERE id = :conversation_id),
                        (SELECT count(*) FROM message_context_items WHERE id = :context_id),
                        (SELECT count(*) FROM object_links WHERE id = :link_id),
                        (SELECT count(*) FROM message_tool_calls WHERE id = :tool_call_id),
                        (SELECT count(*) FROM message_retrievals WHERE id = :retrieval_id),
                        (SELECT count(*) FROM assistant_message_evidence_summaries
                         WHERE message_id = :assistant_message_id),
                        (SELECT count(*) FROM assistant_message_claims WHERE id = :claim_id),
                        (SELECT count(*) FROM assistant_message_claim_evidence
                         WHERE id = :claim_evidence_id)
                """),
                {
                    "assistant_message_id": assistant_message_id,
                    "conversation_id": conversation_id,
                    "context_id": message_context_id,
                    "link_id": object_link_id,
                    "tool_call_id": tool_call_id,
                    "retrieval_id": retrieval_id,
                    "claim_id": claim_id,
                    "claim_evidence_id": claim_evidence_id,
                },
            ).one()
        assert counts == (0, 1, 0, 0, 0, 0, 0, 0, 0)

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
# S4 PR-06: ConversationOut owner fields
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
# S4 PR-06: Conversation Scope Tests
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

    # NOTE: Chat send ownership checks are covered by the chat-run create contract
    # after the durable chat-runs cutover.
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
