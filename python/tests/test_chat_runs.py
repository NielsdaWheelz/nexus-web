"""Integration tests for the durable chat-run HTTP contract."""

import hashlib
import json
import threading
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from sqlalchemy import bindparam, inspect, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import Engine

from nexus.config import clear_settings_cache
from nexus.db.models import ChatRun
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.conversation_branches import persist_active_leaf
from nexus.services.message_context_snapshots import object_ref_context_snapshot
from tests.factories import (
    create_searchable_media,
    create_test_conversation,
    create_test_library,
    create_test_media_in_library,
    create_test_message,
    create_test_model,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def platform_key(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-platform-openai")
    clear_settings_cache()
    yield
    clear_settings_cache()


def _require_chat_runs_schema(engine: Engine) -> None:
    tables = set(inspect(engine).get_table_names())
    missing = {"chat_runs", "chat_run_events", "chat_singletons"} - tables
    if missing:
        pytest.fail(f"chat-runs schema missing: {', '.join(sorted(missing))}")


@pytest.fixture
def chat_runs_schema(engine: Engine) -> None:
    _require_chat_runs_schema(engine)


def _create_run_payload(model_id: UUID, **overrides) -> dict:
    """Build a /chat-runs request body.

    By default targets a not-yet-set conversation_id; callers either set
    ``conversation_id`` or ``singleton``. The schema requires exactly one,
    so omitting both is a 422.
    """
    payload = {
        "content": "Summarize the current notes.",
        "model_id": str(model_id),
        "reasoning": "none",
        "key_mode": "auto",
        "contexts": [],
    }
    payload.update(overrides)
    return payload


def _assistant_message_anchor(message_id: UUID) -> dict:
    return {"kind": "assistant_message", "message_id": str(message_id)}


def _post_chat_run(auth_client, user_id: UUID, payload: dict, idempotency_key: str):
    return auth_client.post(
        "/chat-runs",
        headers={**auth_headers(user_id), "Idempotency-Key": idempotency_key},
        json=payload,
    )


def _seed_ai_plus_billing(direct_db: DirectSessionManager, user_id: UUID) -> None:
    direct_db.register_cleanup("billing_entitlement_overrides", "user_id", user_id)
    direct_db.register_cleanup("billing_entitlement_override_events", "user_id", user_id)
    with direct_db.session() as session:
        grant_entitlement_override(
            session,
            user_id=user_id,
            plan_tier="ai_plus",
            platform_token_quota_mode="plan",
            platform_token_limit_monthly=None,
            transcription_quota_mode="plan",
            transcription_minutes_limit_monthly=None,
            expires_at=None,
            reason="chat run test access",
            actor_label="test",
        )


def _assert_create_shape(data: dict) -> None:
    assert data["run"]["id"], f"Missing run id in response: {data}"
    assert data["run"]["status"] == "queued", f"Run should start queued: {data}"
    assert data["conversation"]["id"], f"Missing conversation id in response: {data}"
    assert data["user_message"]["role"] == "user", f"Unexpected user message: {data}"
    assert data["user_message"]["status"] == "complete", f"Unexpected user message: {data}"
    assert data["assistant_message"]["role"] == "assistant", f"Unexpected assistant: {data}"
    assert data["assistant_message"]["status"] == "pending", f"Unexpected assistant: {data}"


def _register_run_cleanup(
    direct_db: DirectSessionManager, run_id: UUID, conversation_id: UUID | None = None
) -> None:
    if conversation_id is not None:
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("chat_runs", "id", run_id)
    direct_db.register_cleanup("chat_run_events", "run_id", run_id)
    with direct_db.session() as session:
        job_ids = session.execute(
            text("SELECT id FROM background_jobs WHERE payload->>'run_id' = :run_id"),
            {"run_id": str(run_id)},
        ).scalars()
        for job_id in job_ids:
            direct_db.register_cleanup("background_jobs", "id", job_id)


def _create_failed_chat_run(
    direct_db: DirectSessionManager,
    *,
    user_id: UUID,
    conversation_id: UUID,
    model_id: UUID,
    user_message_id: UUID,
    assistant_message_id: UUID,
    idempotency_key: str,
    error_code: str = "E_LLM_TIMEOUT",
) -> UUID:
    run_id = uuid4()
    with direct_db.session() as session:
        session.add(
            ChatRun(
                id=run_id,
                owner_user_id=user_id,
                conversation_id=conversation_id,
                user_message_id=user_message_id,
                assistant_message_id=assistant_message_id,
                idempotency_key=idempotency_key,
                payload_hash=f"{idempotency_key}-payload",
                status="error",
                model_id=model_id,
                reasoning="none",
                key_mode="auto",
                error_code=error_code,
                completed_at=datetime.now(UTC),
            )
        )
        session.commit()
    return run_id


def _post_retry(auth_client, user_id: UUID, assistant_message_id: UUID, idempotency_key: str):
    return auth_client.post(
        f"/messages/{assistant_message_id}/retry",
        headers={**auth_headers(user_id), "Idempotency-Key": idempotency_key},
    )


class TestChatRunCreate:
    def test_missing_idempotency_key_returns_400(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
        create_resp = auth_client.post("/conversations", headers=auth_headers(user_id))
        conversation_id = UUID(create_resp.json()["data"]["id"])
        direct_db.register_cleanup("conversations", "id", conversation_id)

        response = auth_client.post(
            "/chat-runs",
            headers=auth_headers(user_id),
            json=_create_run_payload(model_id, conversation_id=str(conversation_id)),
        )

        assert response.status_code == 400, (
            f"Expected missing Idempotency-Key to fail with 400, got "
            f"{response.status_code}: {response.text}"
        )

    def test_create_run_for_new_conversation_persists_run_event_and_job(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)

        # New chat lands via POST /conversations + POST /chat-runs with conversation_id
        # since ChatRunCreateRequest requires either conversation_id or singleton.
        create_resp = auth_client.post("/conversations", headers=auth_headers(user_id))
        assert create_resp.status_code == 201, (
            f"Expected conversation create to succeed, got {create_resp.status_code}: "
            f"{create_resp.text}"
        )
        conversation_id = UUID(create_resp.json()["data"]["id"])

        response = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(model_id, conversation_id=str(conversation_id)),
            idempotency_key="chat-run-new-conversation",
        )

        assert response.status_code == 200, (
            f"Expected chat run create to succeed, got {response.status_code}: {response.text}"
        )
        data = response.json()["data"]
        _assert_create_shape(data)

        run_id = UUID(data["run"]["id"])
        assert UUID(data["conversation"]["id"]) == conversation_id
        _register_run_cleanup(direct_db, run_id, conversation_id)

        with direct_db.session() as session:
            event_rows = session.execute(
                text(
                    """
                    SELECT seq, event_type, payload
                    FROM chat_run_events
                    WHERE run_id = :run_id
                    ORDER BY seq
                    """
                ),
                {"run_id": run_id},
            ).fetchall()
            job_count = session.execute(
                text(
                    """
                    SELECT COUNT(*)
                    FROM background_jobs
                    WHERE kind = 'chat_run'
                      AND payload->>'run_id' = :run_id
                    """
                ),
                {"run_id": str(run_id)},
            ).scalar_one()

        assert [(row.seq, row.event_type) for row in event_rows] == [(1, "meta")]
        assert event_rows[0].payload["conversation_id"] == str(conversation_id)
        assert job_count == 1, f"Expected one chat_run background job for run {run_id}"

    def test_singleton_second_send_continues_existing_singleton_selected_path(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        """After the doc singleton is materialized, a second send anchored to the
        selected assistant leaf appends under that branch (no scope coupling)."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
            media_id = create_searchable_media(session, user_id, title="Singleton Run Source")

        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)

        # First send into the doc singleton materializes the conversation.
        first = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(
                model_id,
                singleton={"kind": "media", "target_id": str(media_id)},
                content="Root question about this doc.",
            ),
            idempotency_key="chat-run-singleton-first-send",
        )
        assert first.status_code == 200, (
            f"Expected singleton first send to succeed, got {first.status_code}: {first.text}"
        )
        first_data = first.json()["data"]
        conversation_id = UUID(first_data["conversation"]["id"])
        first_run_id = UUID(first_data["run"]["id"])
        first_user_id = UUID(first_data["user_message"]["id"])
        first_assistant_id = UUID(first_data["assistant_message"]["id"])
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversation_active_paths", "conversation_id", conversation_id)
        direct_db.register_cleanup("chat_singletons", "conversation_id", conversation_id)
        _register_run_cleanup(direct_db, first_run_id)

        # Promote the pending assistant to "complete" so the parent is sendable.
        with direct_db.session() as session:
            session.execute(
                text("UPDATE messages SET status = 'complete' WHERE id = :id"),
                {"id": first_assistant_id},
            )
            persist_active_leaf(
                session,
                viewer_id=user_id,
                conversation_id=conversation_id,
                active_leaf_message_id=first_assistant_id,
            )
            session.commit()

        response = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(
                model_id,
                conversation_id=str(conversation_id),
                parent_message_id=str(first_assistant_id),
                branch_anchor=_assistant_message_anchor(first_assistant_id),
                content="Follow-up on the same doc.",
            ),
            idempotency_key="chat-run-singleton-follow-up",
        )

        assert response.status_code == 200, (
            f"Expected singleton follow-up to succeed, got {response.status_code}: {response.text}"
        )
        data = response.json()["data"]
        assert data["conversation"]["id"] == str(conversation_id)
        assert data["user_message"]["parent_message_id"] == str(first_assistant_id)
        assert data["assistant_message"]["parent_message_id"] == data["user_message"]["id"]

        messages_response = auth_client.get(
            f"/conversations/{conversation_id}/messages",
            headers=auth_headers(user_id),
        )
        assert messages_response.status_code == 200, messages_response.text
        visible_message_ids = [item["id"] for item in messages_response.json()["data"]]
        # Selected path: original user + assistant, then the follow-up pair.
        assert str(first_user_id) in visible_message_ids
        assert str(first_assistant_id) in visible_message_ids
        assert data["user_message"]["id"] in visible_message_ids
        assert data["assistant_message"]["id"] in visible_message_ids

    def test_chat_run_singleton_rejects_pending_active_leaf(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        """A second send while the singleton's assistant is still pending is 409
        E_CONVERSATION_BUSY when the client correctly anchors on the pending
        leaf (the frontend always echoes parent_message_id from the latest
        active path)."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
            media_id = create_searchable_media(session, user_id, title="Busy Singleton Source")

        first = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(
                model_id,
                singleton={"kind": "media", "target_id": str(media_id)},
            ),
            idempotency_key="chat-run-busy-singleton-first",
        )
        assert first.status_code == 200, (
            f"Expected first singleton send to succeed, got {first.status_code}: {first.text}"
        )
        first_data = first.json()["data"]
        run_id = UUID(first_data["run"]["id"])
        conversation_id = UUID(first_data["conversation"]["id"])
        pending_assistant_id = UUID(first_data["assistant_message"]["id"])
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        _register_run_cleanup(direct_db, run_id, conversation_id)
        # chat_singletons FK -> conversations.id; register after the
        # conversations cleanup so LIFO order cleans the singleton first.
        direct_db.register_cleanup("chat_singletons", "conversation_id", conversation_id)

        # Second send anchored to the still-pending assistant — the only target
        # the frontend would have. Service must reject as E_CONVERSATION_BUSY
        # (or E_BRANCH_PATH_INVALID, since a pending assistant fails the
        # "parent must be complete" guard in validate_pre_phase). Either path
        # is a user-visible block — assert one of them.
        second = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(
                model_id,
                content="Second send while assistant is pending.",
                conversation_id=str(conversation_id),
                parent_message_id=str(pending_assistant_id),
                branch_anchor=_assistant_message_anchor(pending_assistant_id),
            ),
            idempotency_key="chat-run-busy-singleton-second",
        )

        assert second.status_code in (400, 409), (
            f"Expected second send to fail while assistant is pending, "
            f"got {second.status_code}: {second.text}"
        )
        assert second.json()["error"]["code"] in {
            "E_CONVERSATION_BUSY",
            "E_BRANCH_PATH_INVALID",
        }, f"Expected E_CONVERSATION_BUSY or E_BRANCH_PATH_INVALID, got: {second.text}"

    def test_chat_run_resends_after_failed_leaf_with_explicit_parent(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        """When the prior assistant errored, the client can resend by anchoring
        on the previous *complete* assistant (the parent of the failed
        follow-up). The chat-runs path no longer auto-resolves the parent
        from the active leaf; the client supplies it explicitly."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
            media_id = create_searchable_media(session, user_id, title="Errored Singleton Source")

        # Materialize the singleton via the first send.
        first = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(
                model_id,
                singleton={"kind": "media", "target_id": str(media_id)},
                content="Root question.",
            ),
            idempotency_key="chat-run-error-leaf-first",
        )
        assert first.status_code == 200, first.text
        first_data = first.json()["data"]
        conversation_id = UUID(first_data["conversation"]["id"])
        complete_assistant_id = UUID(first_data["assistant_message"]["id"])
        first_run_id = UUID(first_data["run"]["id"])
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        _register_run_cleanup(direct_db, first_run_id, conversation_id)
        direct_db.register_cleanup("chat_singletons", "conversation_id", conversation_id)

        with direct_db.session() as session:
            session.execute(
                text("UPDATE messages SET status = 'complete' WHERE id = :id"),
                {"id": complete_assistant_id},
            )
            failed_user_id = create_test_message(
                session,
                conversation_id,
                3,
                "user",
                "Failed follow-up",
                parent_message_id=complete_assistant_id,
            )
            failed_assistant_id = create_test_message(
                session,
                conversation_id,
                4,
                "assistant",
                "Provider failed.",
                status="error",
                parent_message_id=failed_user_id,
            )
            persist_active_leaf(
                session,
                viewer_id=user_id,
                conversation_id=conversation_id,
                active_leaf_message_id=failed_assistant_id,
            )
            session.commit()

        response = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(
                model_id,
                conversation_id=str(conversation_id),
                content="Continue after failed answer.",
                parent_message_id=str(complete_assistant_id),
                branch_anchor=_assistant_message_anchor(complete_assistant_id),
            ),
            idempotency_key="chat-run-error-leaf-second",
        )

        assert response.status_code == 200, response.text
        data = response.json()["data"]
        _register_run_cleanup(direct_db, UUID(data["run"]["id"]))
        assert data["conversation"]["id"] == str(conversation_id)
        assert data["user_message"]["parent_message_id"] == str(complete_assistant_id)

    def test_create_run_for_empty_conversation_succeeds_without_parent(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        """An empty conversation (no messages yet) accepts the first send without a
        parent_message_id: load_valid_parent_for_send returns None and the
        run is created as the conversation's root user message."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)

        response = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(model_id, conversation_id=str(conversation_id)),
            idempotency_key="chat-run-empty-conversation",
        )

        assert response.status_code == 200, (
            f"Expected empty-conversation send to succeed, got "
            f"{response.status_code}: {response.text}"
        )
        data = response.json()["data"]
        assert data["user_message"]["parent_message_id"] is None
        _register_run_cleanup(direct_db, UUID(data["run"]["id"]), conversation_id)

    def test_create_run_for_existing_non_empty_conversation_requires_parent(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            create_test_message(session, conversation_id, 1, "user", "Root")

        response = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(model_id, conversation_id=str(conversation_id)),
            idempotency_key="chat-run-existing-requires-parent",
        )

        assert response.status_code == 400, (
            f"Expected missing parent to fail, got {response.status_code}: {response.text}"
        )
        assert response.json()["error"]["code"] == "E_BRANCH_PATH_INVALID"
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)

    def test_create_run_for_existing_conversation_rejects_none_anchor_with_parent(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            root_user_id = create_test_message(session, conversation_id, 1, "user", "Root")
            parent_assistant_id = create_test_message(
                session,
                conversation_id,
                2,
                "assistant",
                "Complete answer",
                parent_message_id=root_user_id,
            )

        omitted_anchor = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(
                model_id,
                conversation_id=str(conversation_id),
                parent_message_id=str(parent_assistant_id),
            ),
            idempotency_key="chat-run-parent-omitted-anchor",
        )
        explicit_none_anchor = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(
                model_id,
                conversation_id=str(conversation_id),
                parent_message_id=str(parent_assistant_id),
                branch_anchor={"kind": "none"},
            ),
            idempotency_key="chat-run-parent-none-anchor",
        )

        assert omitted_anchor.status_code == 400, (
            f"Expected omitted branch anchor to fail, got {omitted_anchor.status_code}: "
            f"{omitted_anchor.text}"
        )
        assert explicit_none_anchor.status_code == 400, (
            f"Expected explicit none branch anchor to fail, got "
            f"{explicit_none_anchor.status_code}: {explicit_none_anchor.text}"
        )
        assert omitted_anchor.json()["error"]["code"] == "E_BRANCH_ANCHOR_INVALID"
        assert explicit_none_anchor.json()["error"]["code"] == "E_BRANCH_ANCHOR_INVALID"
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)

    def test_create_run_anchored_to_complete_assistant_persists_branch_path(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            root_user_id = create_test_message(session, conversation_id, 1, "user", "Root")
            parent_assistant_id = create_test_message(
                session,
                conversation_id,
                2,
                "assistant",
                "Complete answer",
                parent_message_id=root_user_id,
            )

        response = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(
                model_id,
                conversation_id=str(conversation_id),
                parent_message_id=str(parent_assistant_id),
                branch_anchor={
                    "kind": "assistant_selection",
                    "message_id": str(parent_assistant_id),
                    "exact": "Complete",
                    "prefix": None,
                    "suffix": " answer",
                    "offset_status": "mapped",
                    "start_offset": 0,
                    "end_offset": 8,
                    "client_selection_id": "selection-test-anchor",
                },
            ),
            idempotency_key="chat-run-anchored-branch",
        )

        assert response.status_code == 200, (
            f"Expected anchored create to succeed, got {response.status_code}: {response.text}"
        )
        data = response.json()["data"]
        user_message_id = UUID(data["user_message"]["id"])
        assistant_message_id = UUID(data["assistant_message"]["id"])
        run_id = UUID(data["run"]["id"])
        assert data["user_message"]["parent_message_id"] == str(parent_assistant_id)
        assert data["assistant_message"]["parent_message_id"] == str(user_message_id)
        assert data["user_message"]["branch_anchor_kind"] == "assistant_selection"

        with direct_db.session() as session:
            branch_count = session.execute(
                text(
                    """
                    SELECT COUNT(*)
                    FROM conversation_branches
                    WHERE branch_user_message_id = :user_message_id
                    """
                ),
                {"user_message_id": user_message_id},
            ).scalar_one()
            active_leaf_id = session.execute(
                text(
                    """
                    SELECT active_leaf_message_id
                    FROM conversation_active_paths
                    WHERE conversation_id = :conversation_id
                      AND viewer_user_id = :viewer_user_id
                    """
                ),
                {"conversation_id": conversation_id, "viewer_user_id": user_id},
            ).scalar_one()
        assert branch_count == 1
        assert active_leaf_id == assistant_message_id
        _register_run_cleanup(direct_db, run_id, conversation_id)

    @pytest.mark.parametrize(
        "case",
        [
            "wrong_message_id",
            "missing_offsets",
            "wrong_offsets_exact_mismatch",
            "prefix_mismatch",
            "suffix_mismatch",
            "unmapped_with_offsets",
        ],
    )
    def test_create_run_rejects_invalid_assistant_selection_anchor(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        chat_runs_schema,
        case: str,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            root_user_id = create_test_message(session, conversation_id, 1, "user", "Root")
            parent_assistant_id = create_test_message(
                session,
                conversation_id,
                2,
                "assistant",
                "Alpha beta gamma beta.",
                parent_message_id=root_user_id,
            )

        branch_anchor = {
            "kind": "assistant_selection",
            "message_id": str(parent_assistant_id),
            "exact": "beta",
            "prefix": "Alpha ",
            "suffix": " gamma",
            "offset_status": "mapped",
            "start_offset": 6,
            "end_offset": 10,
            "client_selection_id": f"invalid-{case}",
        }
        if case == "wrong_message_id":
            branch_anchor["message_id"] = str(uuid4())
        elif case == "missing_offsets":
            branch_anchor.pop("start_offset")
            branch_anchor.pop("end_offset")
        elif case == "wrong_offsets_exact_mismatch":
            branch_anchor["start_offset"] = 0
            branch_anchor["end_offset"] = 5
        elif case == "prefix_mismatch":
            branch_anchor["prefix"] = "Wrong "
        elif case == "suffix_mismatch":
            branch_anchor["suffix"] = " wrong"
        elif case == "unmapped_with_offsets":
            branch_anchor["offset_status"] = "unmapped"

        response = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(
                model_id,
                conversation_id=str(conversation_id),
                parent_message_id=str(parent_assistant_id),
                branch_anchor=branch_anchor,
            ),
            idempotency_key=f"chat-run-invalid-anchor-{case}",
        )

        assert response.status_code == 400, (
            f"Expected invalid assistant selection anchor {case} to fail, got "
            f"{response.status_code}: {response.text}"
        )
        assert response.json()["error"]["code"] == "E_BRANCH_ANCHOR_INVALID"
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)

    def test_create_run_rejects_assistant_message_anchor_with_wrong_message_id(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            root_user_id = create_test_message(session, conversation_id, 1, "user", "Root")
            parent_assistant_id = create_test_message(
                session,
                conversation_id,
                2,
                "assistant",
                "Complete answer",
                parent_message_id=root_user_id,
            )

        response = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(
                model_id,
                conversation_id=str(conversation_id),
                parent_message_id=str(parent_assistant_id),
                branch_anchor=_assistant_message_anchor(uuid4()),
            ),
            idempotency_key="chat-run-assistant-message-wrong-anchor",
        )

        assert response.status_code == 400, (
            f"Expected wrong assistant_message anchor to fail, got {response.status_code}: "
            f"{response.text}"
        )
        assert response.json()["error"]["code"] == "E_BRANCH_ANCHOR_INVALID"
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)

    def test_create_run_allows_sibling_branch_while_another_branch_runs(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            root_user_id = create_test_message(session, conversation_id, 1, "user", "Root")
            parent_assistant_id = create_test_message(
                session,
                conversation_id,
                2,
                "assistant",
                "Complete answer",
                parent_message_id=root_user_id,
            )
            running_user_id = create_test_message(
                session,
                conversation_id,
                3,
                "user",
                "Existing running branch",
                parent_message_id=parent_assistant_id,
            )
            running_assistant_id = create_test_message(
                session,
                conversation_id,
                4,
                "assistant",
                "",
                status="pending",
                model_id=model_id,
                parent_message_id=running_user_id,
            )
            session.add(
                ChatRun(
                    owner_user_id=user_id,
                    conversation_id=conversation_id,
                    user_message_id=running_user_id,
                    assistant_message_id=running_assistant_id,
                    idempotency_key="sibling-running-branch",
                    payload_hash="sibling-running-branch",
                    status="running",
                    model_id=model_id,
                    reasoning="none",
                    key_mode="auto",
                )
            )
            session.commit()

        response = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(
                model_id,
                conversation_id=str(conversation_id),
                parent_message_id=str(parent_assistant_id),
                branch_anchor=_assistant_message_anchor(parent_assistant_id),
            ),
            idempotency_key="chat-run-sibling-while-active",
        )

        assert response.status_code == 200, (
            f"Expected sibling branch create to succeed, got {response.status_code}: "
            f"{response.text}"
        )
        data = response.json()["data"]
        assert data["user_message"]["parent_message_id"] == str(parent_assistant_id)
        _register_run_cleanup(direct_db, UUID(data["run"]["id"]), conversation_id)

    def test_idempotency_replay_returns_same_run(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
        create_resp = auth_client.post("/conversations", headers=auth_headers(user_id))
        conversation_id = UUID(create_resp.json()["data"]["id"])
        payload = _create_run_payload(model_id, conversation_id=str(conversation_id))

        first = _post_chat_run(auth_client, user_id, payload, "chat-run-replay")
        second = _post_chat_run(auth_client, user_id, payload, "chat-run-replay")

        assert first.status_code == 200, f"First create failed: {first.text}"
        assert second.status_code == 200, f"Replay failed: {second.text}"
        first_data = first.json()["data"]
        second_data = second.json()["data"]
        assert second_data["run"]["id"] == first_data["run"]["id"]
        assert second_data["user_message"]["id"] == first_data["user_message"]["id"]
        assert second_data["assistant_message"]["id"] == first_data["assistant_message"]["id"]

        run_id = UUID(first_data["run"]["id"])
        _register_run_cleanup(direct_db, run_id, conversation_id)

    def test_idempotency_mismatch_returns_409(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
        create_resp = auth_client.post("/conversations", headers=auth_headers(user_id))
        conversation_id = UUID(create_resp.json()["data"]["id"])

        first = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(
                model_id, conversation_id=str(conversation_id), content="First prompt"
            ),
            "chat-run-mismatch",
        )
        second = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(
                model_id, conversation_id=str(conversation_id), content="Different prompt"
            ),
            "chat-run-mismatch",
        )

        assert first.status_code == 200, f"Initial create failed: {first.text}"
        assert second.status_code == 409, (
            f"Expected idempotency mismatch 409, got {second.status_code}: {second.text}"
        )
        assert second.json()["error"]["code"] == "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH"

        first_data = first.json()["data"]
        run_id = UUID(first_data["run"]["id"])
        _register_run_cleanup(direct_db, run_id, conversation_id)

    def test_idempotency_mismatch_includes_context_evidence_span_ids(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
            media_id = create_searchable_media(session, user_id, title="Hash Context Source")
            row = session.execute(
                text(
                    """
                    SELECT
                        cc.id,
                        cc.index_run_id,
                        cc.source_snapshot_id,
                        ccp.block_id,
                        cc.primary_evidence_span_id
                    FROM content_chunks cc
                    JOIN content_chunk_parts ccp ON ccp.chunk_id = cc.id
                    WHERE cc.media_id = :media_id
                    ORDER BY cc.chunk_idx ASC, ccp.part_idx ASC
                    LIMIT 1
                    """
                ),
                {"media_id": media_id},
            ).one()
            second_span_text = "Hash"
            second_span_id = session.execute(
                text(
                    """
                    INSERT INTO evidence_spans (
                        media_id,
                        index_run_id,
                        source_snapshot_id,
                        start_block_id,
                        end_block_id,
                        start_block_offset,
                        end_block_offset,
                        span_text,
                        span_sha256,
                        selector,
                        citation_label,
                        resolver_kind
                    )
                    VALUES (
                        :media_id,
                        :index_run_id,
                        :source_snapshot_id,
                        :block_id,
                        :block_id,
                        0,
                        4,
                        :span_text,
                        :span_sha,
                        '{}'::jsonb,
                        'Hash',
                        'web'
                    )
                    RETURNING id
                    """
                ),
                {
                    "media_id": media_id,
                    "index_run_id": row[1],
                    "source_snapshot_id": row[2],
                    "block_id": row[3],
                    "span_text": second_span_text,
                    "span_sha": hashlib.sha256(second_span_text.encode("utf-8")).hexdigest(),
                },
            ).scalar_one()
            session.commit()

        create_resp = auth_client.post("/conversations", headers=auth_headers(user_id))
        conversation_id_for_evidence = UUID(create_resp.json()["data"]["id"])
        first_payload = _create_run_payload(
            model_id,
            conversation_id=str(conversation_id_for_evidence),
            contexts=[
                {
                    "kind": "object_ref",
                    "type": "content_chunk",
                    "id": str(row[0]),
                    "evidence_span_ids": [str(row[4])],
                }
            ],
        )
        second_payload = _create_run_payload(
            model_id,
            conversation_id=str(conversation_id_for_evidence),
            contexts=[
                {
                    "kind": "object_ref",
                    "type": "content_chunk",
                    "id": str(row[0]),
                    "evidence_span_ids": [str(second_span_id)],
                }
            ],
        )

        first = _post_chat_run(
            auth_client,
            user_id,
            first_payload,
            "chat-run-evidence-span-mismatch",
        )
        second = _post_chat_run(
            auth_client,
            user_id,
            second_payload,
            "chat-run-evidence-span-mismatch",
        )

        assert first.status_code == 200, f"Initial create failed: {first.text}"
        assert second.status_code == 409, (
            f"Expected evidence span id change to mismatch, got {second.status_code}: {second.text}"
        )
        assert second.json()["error"]["code"] == "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH"

        first_data = first.json()["data"]
        run_id = UUID(first_data["run"]["id"])
        conversation_id = UUID(first_data["conversation"]["id"])
        _register_run_cleanup(direct_db, run_id, conversation_id)
        direct_db.register_cleanup(
            "message_context_items",
            "message_id",
            UUID(first_data["user_message"]["id"]),
        )
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

    def test_stale_content_chunk_evidence_context_returns_invalid_request(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        replacement_run_id = uuid4()
        with direct_db.session() as session:
            model_id = create_test_model(session)
            media_id = create_searchable_media(session, user_id, title="Stale Context Source")
            chunk_id, active_run_id, evidence_span_id = session.execute(
                text(
                    """
                    SELECT cc.id, cc.index_run_id, cc.primary_evidence_span_id
                    FROM content_chunks cc
                    WHERE cc.media_id = :media_id
                    ORDER BY cc.chunk_idx ASC
                    LIMIT 1
                    """
                ),
                {"media_id": media_id},
            ).one()
            session.execute(
                text(
                    """
                    INSERT INTO content_index_runs (
                        id,
                        media_id,
                        state,
                        source_version,
                        extractor_version,
                        chunker_version,
                        embedding_provider,
                        embedding_model,
                        embedding_version,
                        embedding_config_hash,
                        started_at,
                        finished_at,
                        activated_at
                    )
                    SELECT
                        :replacement_run_id,
                        media_id,
                        'ready',
                        source_version || '-replacement',
                        extractor_version,
                        chunker_version,
                        embedding_provider,
                        embedding_model,
                        embedding_version,
                        embedding_config_hash,
                        now(),
                        now(),
                        now()
                    FROM content_index_runs
                    WHERE id = :active_run_id
                    """
                ),
                {"replacement_run_id": replacement_run_id, "active_run_id": active_run_id},
            )
            session.execute(
                text(
                    """
                    UPDATE media_content_index_states
                    SET active_run_id = :replacement_run_id,
                        latest_run_id = :replacement_run_id,
                        updated_at = now()
                    WHERE media_id = :media_id
                    """
                ),
                {"replacement_run_id": replacement_run_id, "media_id": media_id},
            )
            session.commit()

        create_resp = auth_client.post("/conversations", headers=auth_headers(user_id))
        conv_id_for_stale = UUID(create_resp.json()["data"]["id"])
        response = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(
                model_id,
                conversation_id=str(conv_id_for_stale),
                contexts=[
                    {
                        "kind": "object_ref",
                        "type": "content_chunk",
                        "id": str(chunk_id),
                        "evidence_span_ids": [str(evidence_span_id)],
                    }
                ],
            ),
            "chat-run-stale-content-context",
        )

        assert response.status_code == 400, (
            f"Expected stale evidence context to be rejected, got "
            f"{response.status_code}: {response.text}"
        )
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("conversations", "id", conv_id_for_stale)

    def test_active_sibling_run_does_not_block_anchored_send(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        run_id = uuid4()
        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            root_user_id = create_test_message(
                session, conversation_id=conversation_id, seq=1, role="user", content="Root"
            )
            parent_assistant_id = create_test_message(
                session,
                conversation_id=conversation_id,
                seq=2,
                role="assistant",
                content="Complete parent",
                parent_message_id=root_user_id,
            )
            sibling_user_id = create_test_message(
                session,
                conversation_id=conversation_id,
                seq=3,
                role="user",
                content="Busy sibling",
                parent_message_id=parent_assistant_id,
            )
            assistant_message_id = create_test_message(
                session,
                conversation_id=conversation_id,
                seq=4,
                role="assistant",
                content="",
                status="pending",
                model_id=model_id,
                parent_message_id=sibling_user_id,
            )
            session.execute(
                text(
                    """
                    INSERT INTO chat_runs (
                        id, owner_user_id, conversation_id, user_message_id,
                        assistant_message_id, idempotency_key, payload_hash, status,
                        model_id, reasoning, key_mode
                    )
                    VALUES (
                        :id, :owner_user_id, :conversation_id, :user_message_id,
                        :assistant_message_id, :idempotency_key, :payload_hash, 'queued',
                        :model_id, 'none', 'auto'
                    )
                    """
                ),
                {
                    "id": run_id,
                    "owner_user_id": user_id,
                    "conversation_id": conversation_id,
                    "user_message_id": sibling_user_id,
                    "assistant_message_id": assistant_message_id,
                    "idempotency_key": "existing-busy-run",
                    "payload_hash": "existing-busy-payload",
                    "model_id": model_id,
                },
            )
            session.commit()

        response = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(
                model_id,
                conversation_id=str(conversation_id),
                parent_message_id=str(parent_assistant_id),
                branch_anchor=_assistant_message_anchor(parent_assistant_id),
            ),
            idempotency_key="chat-run-busy",
        )

        assert response.status_code == 200, (
            f"Expected sibling active run not to block, got {response.status_code}: {response.text}"
        )
        created = response.json()["data"]
        _register_run_cleanup(direct_db, UUID(created["run"]["id"]), conversation_id)

        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("chat_runs", "id", run_id)

    def test_list_active_runs_for_conversation(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
        create_resp = auth_client.post("/conversations", headers=auth_headers(user_id))
        conversation_id = UUID(create_resp.json()["data"]["id"])

        response = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(model_id, conversation_id=str(conversation_id)),
            idempotency_key="chat-run-list-active",
        )

        assert response.status_code == 200, f"Create failed: {response.text}"
        created = response.json()["data"]
        run_id = UUID(created["run"]["id"])
        _register_run_cleanup(direct_db, run_id, conversation_id)

        listed = auth_client.get(
            f"/chat-runs?conversation_id={conversation_id}&status=active",
            headers=auth_headers(user_id),
        )

        assert listed.status_code == 200, (
            f"Expected active run list to succeed, got {listed.status_code}: {listed.text}"
        )
        assert [row["run"]["id"] for row in listed.json()["data"]] == [str(run_id)]

    def test_delete_conversation_removes_chat_run_rows(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
        create_resp = auth_client.post("/conversations", headers=auth_headers(user_id))
        conversation_id = UUID(create_resp.json()["data"]["id"])

        response = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(model_id, conversation_id=str(conversation_id)),
            idempotency_key="chat-run-delete-conversation",
        )

        assert response.status_code == 200, f"Create failed: {response.text}"
        run_id = UUID(response.json()["data"]["run"]["id"])
        _register_run_cleanup(direct_db, run_id, conversation_id)

        deleted = auth_client.delete(
            f"/conversations/{conversation_id}",
            headers=auth_headers(user_id),
        )

        assert deleted.status_code == 204, (
            f"Expected conversation delete to succeed, got {deleted.status_code}: {deleted.text}"
        )
        with direct_db.session() as session:
            remaining_runs = session.execute(
                text("SELECT COUNT(*) FROM chat_runs WHERE id = :run_id"),
                {"run_id": run_id},
            ).scalar_one()
            remaining_events = session.execute(
                text("SELECT COUNT(*) FROM chat_run_events WHERE run_id = :run_id"),
                {"run_id": run_id},
            ).scalar_one()
        assert remaining_runs == 0
        assert remaining_events == 0


class TestChatRunRequestSchema:
    """Pydantic-level contracts on POST /chat-runs."""

    def test_chat_run_request_rejects_web_search_field(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        """Per spec §7.1: requests with `web_search` field are rejected by
        Pydantic extra-fields-forbid. The app maps every Pydantic error to a
        single 400 E_INVALID_REQUEST envelope (validation_exception_handler in
        ``nexus/app.py``), so we assert the API-level behavior here."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
        create_resp = auth_client.post("/conversations", headers=auth_headers(user_id))
        conversation_id = UUID(create_resp.json()["data"]["id"])
        direct_db.register_cleanup("conversations", "id", conversation_id)

        payload = _create_run_payload(model_id, conversation_id=str(conversation_id))
        payload["web_search"] = {"mode": "auto"}

        response = auth_client.post(
            "/chat-runs",
            headers={**auth_headers(user_id), "Idempotency-Key": "chat-run-rejects-web-search"},
            json=payload,
        )
        assert response.status_code == 400, (
            f"Expected web_search extra-field to be rejected, got {response.status_code}: "
            f"{response.text}"
        )
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_chat_run_request_rejects_conversation_scope_field(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        """Per spec §7.1: requests with `conversation_scope` field are rejected
        by Pydantic extra-fields-forbid. See the matching note in
        ``test_chat_run_request_rejects_web_search_field``."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
        create_resp = auth_client.post("/conversations", headers=auth_headers(user_id))
        conversation_id = UUID(create_resp.json()["data"]["id"])
        direct_db.register_cleanup("conversations", "id", conversation_id)

        payload = _create_run_payload(model_id, conversation_id=str(conversation_id))
        payload["conversation_scope"] = {"type": "general"}

        response = auth_client.post(
            "/chat-runs",
            headers={
                **auth_headers(user_id),
                "Idempotency-Key": "chat-run-rejects-conversation-scope",
            },
            json=payload,
        )
        assert response.status_code == 400, (
            f"Expected conversation_scope extra-field to be rejected, got "
            f"{response.status_code}: {response.text}"
        )
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_chat_run_request_requires_conversation_id_or_singleton(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        """Per spec §7.1: exactly one of conversation_id or singleton is set.
        Both/neither hit the model-validator and are rejected as 400
        E_INVALID_REQUEST per the global validation_exception_handler."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
            media_id = create_searchable_media(session, user_id, title="Either-Or Source")
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Neither -> 400 E_INVALID_REQUEST.
        neither = auth_client.post(
            "/chat-runs",
            headers={**auth_headers(user_id), "Idempotency-Key": "chat-run-neither-target"},
            json=_create_run_payload(model_id),
        )
        assert neither.status_code == 400, (
            f"Expected omitting both conversation_id and singleton to fail, got "
            f"{neither.status_code}: {neither.text}"
        )
        assert neither.json()["error"]["code"] == "E_INVALID_REQUEST"

        # Both -> 400 E_INVALID_REQUEST.
        create_resp = auth_client.post("/conversations", headers=auth_headers(user_id))
        conversation_id = UUID(create_resp.json()["data"]["id"])
        direct_db.register_cleanup("conversations", "id", conversation_id)

        both = auth_client.post(
            "/chat-runs",
            headers={**auth_headers(user_id), "Idempotency-Key": "chat-run-both-targets"},
            json=_create_run_payload(
                model_id,
                conversation_id=str(conversation_id),
                singleton={"kind": "media", "target_id": str(media_id)},
            ),
        )
        assert both.status_code == 400, (
            f"Expected supplying both conversation_id and singleton to fail, got "
            f"{both.status_code}: {both.text}"
        )
        assert both.json()["error"]["code"] == "E_INVALID_REQUEST"


class TestChatRunSingleton:
    """Singleton resolution contracts for POST /chat-runs."""

    def test_chat_run_singleton_creates_lazily(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        """First send into a doc singleton creates the chat_singletons row + a new
        conversation in the same transaction."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
            media_id = create_searchable_media(session, user_id, title="Lazy Singleton Source")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Pre-condition: no chat_singletons row yet.
        with direct_db.session() as session:
            pre = session.execute(
                text(
                    """
                    SELECT count(*) FROM chat_singletons
                    WHERE user_id = :user_id AND kind = 'media' AND target_id = :media_id
                    """
                ),
                {"user_id": user_id, "media_id": media_id},
            ).scalar_one()
        assert pre == 0

        response = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(
                model_id,
                singleton={"kind": "media", "target_id": str(media_id)},
            ),
            idempotency_key="chat-run-singleton-creates-lazily",
        )
        assert response.status_code == 200, (
            f"Expected first singleton send to succeed, got {response.status_code}: {response.text}"
        )
        data = response.json()["data"]
        run_id = UUID(data["run"]["id"])
        conversation_id = UUID(data["conversation"]["id"])
        # Singletons FK to conversations.id (no CASCADE), so chat_singletons
        # rows must be cleaned BEFORE conversations rows. LIFO: register
        # _register_run_cleanup first (its conversations cleanup runs late),
        # then register chat_singletons (it runs first).
        _register_run_cleanup(direct_db, run_id, conversation_id)
        direct_db.register_cleanup("chat_singletons", "conversation_id", conversation_id)

        # Post-condition: singleton row exists and points at the conversation.
        with direct_db.session() as session:
            singleton_conv_id = session.execute(
                text(
                    """
                    SELECT conversation_id FROM chat_singletons
                    WHERE user_id = :user_id AND kind = 'media' AND target_id = :media_id
                    """
                ),
                {"user_id": user_id, "media_id": media_id},
            ).scalar_one()
        assert singleton_conv_id == conversation_id

    def test_chat_run_singleton_resolves_existing(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        """A second singleton send for the same (viewer, kind, target) reuses the
        existing conversation_id."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
            media_id = create_searchable_media(session, user_id, title="Existing Singleton Source")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        first = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(
                model_id,
                singleton={"kind": "media", "target_id": str(media_id)},
                content="First singleton send.",
            ),
            idempotency_key="chat-run-singleton-resolves-existing-first",
        )
        assert first.status_code == 200, first.text
        first_data = first.json()["data"]
        first_conversation_id = UUID(first_data["conversation"]["id"])
        first_assistant_id = UUID(first_data["assistant_message"]["id"])
        _register_run_cleanup(direct_db, UUID(first_data["run"]["id"]), first_conversation_id)
        # chat_singletons FK -> conversations.id (no CASCADE); LIFO order needs
        # this registered AFTER the conversations cleanup above.
        direct_db.register_cleanup("chat_singletons", "conversation_id", first_conversation_id)

        # Promote the pending assistant so the conversation isn't busy.
        with direct_db.session() as session:
            session.execute(
                text("UPDATE messages SET status = 'complete' WHERE id = :id"),
                {"id": first_assistant_id},
            )
            persist_active_leaf(
                session,
                viewer_id=user_id,
                conversation_id=first_conversation_id,
                active_leaf_message_id=first_assistant_id,
            )
            session.commit()

        second = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(
                model_id,
                singleton={"kind": "media", "target_id": str(media_id)},
                content="Second singleton send.",
                parent_message_id=str(first_assistant_id),
                branch_anchor=_assistant_message_anchor(first_assistant_id),
            ),
            idempotency_key="chat-run-singleton-resolves-existing-second",
        )
        assert second.status_code == 200, (
            f"Expected second singleton send to succeed, got {second.status_code}: {second.text}"
        )
        second_data = second.json()["data"]
        second_conversation_id = UUID(second_data["conversation"]["id"])
        _register_run_cleanup(direct_db, UUID(second_data["run"]["id"]))

        assert second_conversation_id == first_conversation_id, (
            "Second send must reuse the singleton's existing conversation_id; "
            f"got new conversation {second_conversation_id} (first was {first_conversation_id})"
        )

    def test_chat_run_singleton_race_safety(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        """Two concurrent first-sends into the same (viewer, kind, target) settle
        on exactly one chat_singletons row.

        Uses threading on the live TestClient + auth_client (which is itself
        thread-safe under FastAPI's TestClient). One winner conversation_id is
        observed; the other request also returns it (or fails cleanly), but
        ``chat_singletons`` ends with exactly one row."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
            media_id = create_searchable_media(session, user_id, title="Race Singleton Source")

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        results: list[dict] = []
        results_lock = threading.Lock()
        barrier = threading.Barrier(2)

        def send(idem_suffix: str) -> None:
            barrier.wait(timeout=5)
            try:
                response = _post_chat_run(
                    auth_client,
                    user_id,
                    _create_run_payload(
                        model_id,
                        singleton={"kind": "media", "target_id": str(media_id)},
                        content=f"Race send {idem_suffix}.",
                    ),
                    idempotency_key=f"chat-run-singleton-race-{idem_suffix}",
                )
            except (
                Exception
            ) as exc:  # justify-ignore-error: surface race outcome to assertions below
                with results_lock:
                    results.append({"error": str(exc)})
                return
            with results_lock:
                results.append({"status": response.status_code, "body": response.text})

        threads = [
            threading.Thread(target=send, args=("alpha",)),
            threading.Thread(target=send, args=("beta",)),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)

        # Both attempts settle (200) or one of them surfaces a transient retry-safe error.
        # The hard contract is: at most one chat_singletons row for (viewer, media).
        with direct_db.session() as session:
            singleton_count = session.execute(
                text(
                    """
                    SELECT count(*) FROM chat_singletons
                    WHERE user_id = :user_id AND kind = 'media' AND target_id = :media_id
                    """
                ),
                {"user_id": user_id, "media_id": media_id},
            ).scalar_one()
            singleton_conv_id = session.execute(
                text(
                    """
                    SELECT conversation_id FROM chat_singletons
                    WHERE user_id = :user_id AND kind = 'media' AND target_id = :media_id
                    """
                ),
                {"user_id": user_id, "media_id": media_id},
            ).scalar_one_or_none()
        assert singleton_count == 1, (
            f"Expected exactly one singleton row after concurrent first-sends, got "
            f"{singleton_count}. Results: {results}"
        )
        if singleton_conv_id is not None:
            # LIFO order: register the "last cleaned" first so dependents
            # (chat_run_events FK -> chat_runs; chat_singletons FK -> conversations)
            # are cleaned earlier.
            direct_db.register_cleanup("conversations", "id", singleton_conv_id)
            direct_db.register_cleanup("messages", "conversation_id", singleton_conv_id)
            direct_db.register_cleanup(
                "conversation_active_paths", "conversation_id", singleton_conv_id
            )
            with direct_db.session() as session:
                run_ids = (
                    session.execute(
                        text("SELECT id FROM chat_runs WHERE conversation_id = :id"),
                        {"id": singleton_conv_id},
                    )
                    .scalars()
                    .all()
                )
            direct_db.register_cleanup("chat_runs", "conversation_id", singleton_conv_id)
            for run_id in run_ids:
                direct_db.register_cleanup("chat_run_events", "run_id", run_id)
                with direct_db.session() as session:
                    job_ids = (
                        session.execute(
                            text(
                                "SELECT id FROM background_jobs WHERE payload->>'run_id' = :run_id"
                            ),
                            {"run_id": str(run_id)},
                        )
                        .scalars()
                        .all()
                    )
                for job_id in job_ids:
                    direct_db.register_cleanup("background_jobs", "id", job_id)
            direct_db.register_cleanup("chat_singletons", "conversation_id", singleton_conv_id)

    def test_chat_run_tools_always_registered(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        """Every chat-run accepts both `app_search` and `web_search` as tool_name on
        SSE tool_call events: the schemas registered for those events expose both."""
        from nexus.schemas.conversation import (
            ChatRunRetrievalResultEventPayload,
            ChatRunSourceManifestDeltaEventPayload,
            ChatRunToolCallEventPayload,
        )

        common = {
            "tool_call_id": None,
            "assistant_message_id": str(uuid4()),
            "tool_call_index": 0,
            "status": "running",
            "scope": "all",
        }
        for tool_name in ("app_search", "web_search"):
            ChatRunToolCallEventPayload.model_validate(
                {**common, "tool_name": tool_name, "types": [], "semantic": True, "filters": {}}
            )
            ChatRunRetrievalResultEventPayload.model_validate(
                {
                    "assistant_message_id": common["assistant_message_id"],
                    "tool_name": tool_name,
                    "tool_call_index": 0,
                    "status": "complete",
                    "result_count": 0,
                    "selected_count": 0,
                    "filters": {},
                    "results": [],
                }
            )
            ChatRunSourceManifestDeltaEventPayload.model_validate(
                {
                    "assistant_message_id": common["assistant_message_id"],
                    "tool_name": tool_name,
                    "tool_call_index": 0,
                    "scope": "all",
                    "filters": {},
                    "requested_types": [],
                    "candidate_count": 0,
                    "result_count": 0,
                    "selected_count": 0,
                    "included_in_prompt_count": 0,
                    "excluded_by_budget_count": 0,
                    "excluded_by_scope_count": 0,
                    "stale_count": 0,
                    "unreadable_count": 0,
                    "index_versions": [],
                    "status": "complete",
                }
            )

    def test_chat_run_reader_context_passes_to_prompt(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        """`reader_context.media_id` shows up in the chat_run job payload so the
        worker can render the retrieval hint block; the request payload itself
        ships the hint (without it becoming a hard filter)."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
            library_id = create_test_library(session, user_id, "Reader Hint Library")
            media_id = create_test_media_in_library(
                session, user_id, library_id, title="Reader Hint Doc"
            )
        create_resp = auth_client.post("/conversations", headers=auth_headers(user_id))
        conversation_id = UUID(create_resp.json()["data"]["id"])
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", library_id)
        direct_db.register_cleanup("libraries", "id", library_id)

        payload = _create_run_payload(
            model_id,
            conversation_id=str(conversation_id),
            reader_context={"media_id": str(media_id), "library_id": str(library_id)},
        )
        response = _post_chat_run(
            auth_client,
            user_id,
            payload,
            idempotency_key="chat-run-reader-context-hint",
        )
        assert response.status_code == 200, (
            f"Expected chat-run with reader_context to succeed, got "
            f"{response.status_code}: {response.text}"
        )
        data = response.json()["data"]
        run_id = UUID(data["run"]["id"])
        _register_run_cleanup(direct_db, run_id)

        # Behavior: the chat_run worker payload carries the reader_context, which
        # is what tells the prompt assembler to render the reader_context_hint
        # block (the model-prompt hint, not a hard filter).
        with direct_db.session() as session:
            job_payload = session.execute(
                text(
                    """
                    SELECT payload FROM background_jobs
                    WHERE kind = 'chat_run' AND payload->>'run_id' = :run_id
                    """
                ),
                {"run_id": str(run_id)},
            ).scalar_one()
        assert isinstance(job_payload, dict)
        hint = job_payload.get("reader_context")
        assert isinstance(hint, dict), (
            f"Expected reader_context dict in chat_run job payload, got {job_payload!r}"
        )
        assert hint.get("media_id") == str(media_id)
        assert hint.get("library_id") == str(library_id)


class TestChatResponseRetry:
    def test_retry_failed_root_response_creates_new_root_attempt_and_preserves_failure(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            context_object_id = uuid4()
            source_user_id = create_test_message(
                session,
                conversation_id,
                1,
                "user",
                "Why did the first answer fail?",
            )
            failed_assistant_id = create_test_message(
                session,
                conversation_id,
                2,
                "assistant",
                "The model timed out while responding. Please try again.",
                status="error",
                model_id=model_id,
                parent_message_id=source_user_id,
            )
            session.execute(
                text(
                    """
                    INSERT INTO message_context_items (
                        message_id,
                        user_id,
                        context_kind,
                        object_type,
                        object_id,
                        ordinal,
                        context_snapshot
                    )
                    VALUES (
                        :message_id,
                        :user_id,
                        'object_ref',
                        'page',
                        :object_id,
                        0,
                        :snapshot
                    )
                    """
                ).bindparams(bindparam("snapshot", type_=JSONB)),
                {
                    "message_id": source_user_id,
                    "user_id": user_id,
                    "object_id": context_object_id,
                    "snapshot": object_ref_context_snapshot(
                        object_type="page",
                        object_id=context_object_id,
                        title="Retry Source",
                    ),
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO object_links (
                        user_id,
                        relation_type,
                        a_type,
                        a_id,
                        b_type,
                        b_id,
                        a_order_key,
                        metadata
                    )
                    VALUES (
                        :user_id,
                        'used_as_context',
                        'message',
                        :message_id,
                        'page',
                        :object_id,
                        '0000000001',
                        '{}'::jsonb
                    )
                    """
                ),
                {
                    "user_id": user_id,
                    "message_id": source_user_id,
                    "object_id": context_object_id,
                },
            )
            session.commit()
        direct_db.register_cleanup("object_links", "a_id", source_user_id)
        _create_failed_chat_run(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            model_id=model_id,
            user_message_id=source_user_id,
            assistant_message_id=failed_assistant_id,
            idempotency_key="failed-root-source",
        )

        response = _post_retry(auth_client, user_id, failed_assistant_id, "retry-root")

        assert response.status_code == 200, f"Expected retry to succeed: {response.text}"
        data = response.json()["data"]
        retry_run_id = UUID(data["run"]["id"])
        retry_user_id = UUID(data["user_message"]["id"])
        retry_assistant_id = UUID(data["assistant_message"]["id"])
        _register_run_cleanup(direct_db, retry_run_id, conversation_id)
        direct_db.register_cleanup("object_links", "a_id", retry_user_id)

        assert data["run"]["status"] == "queued"
        assert data["run"]["model_id"] == str(model_id)
        assert data["run"]["reasoning"] == "none"
        assert data["user_message"]["message_document"]["blocks"][0]["text"] == (
            "Why did the first answer fail?"
        )
        assert data["user_message"]["parent_message_id"] is None
        assert data["user_message"]["contexts"][0]["title"] == "Retry Source"
        assert data["assistant_message"]["status"] == "pending"
        assert data["assistant_message"]["parent_message_id"] == str(retry_user_id)

        with direct_db.session() as session:
            failed_status = session.execute(
                text("SELECT status FROM messages WHERE id = :message_id"),
                {"message_id": failed_assistant_id},
            ).scalar_one()
            active_leaf_id = session.execute(
                text(
                    """
                    SELECT active_leaf_message_id
                    FROM conversation_active_paths
                    WHERE conversation_id = :conversation_id
                      AND viewer_user_id = :viewer_user_id
                    """
                ),
                {"conversation_id": conversation_id, "viewer_user_id": user_id},
            ).scalar_one()
            meta_count = session.execute(
                text(
                    """
                    SELECT COUNT(*)
                    FROM chat_run_events
                    WHERE run_id = :run_id
                      AND event_type = 'meta'
                    """
                ),
                {"run_id": retry_run_id},
            ).scalar_one()
            job_count = session.execute(
                text(
                    """
                    SELECT COUNT(*)
                    FROM background_jobs
                    WHERE kind = 'chat_run'
                      AND payload->>'run_id' = :run_id
                    """
                ),
                {"run_id": str(retry_run_id)},
            ).scalar_one()
            copied_link_count = session.execute(
                text(
                    """
                    SELECT COUNT(*)
                    FROM object_links
                    WHERE user_id = :user_id
                      AND relation_type = 'used_as_context'
                      AND a_type = 'message'
                      AND a_id = :message_id
                      AND b_type = 'page'
                      AND b_id = :object_id
                    """
                ),
                {
                    "user_id": user_id,
                    "message_id": retry_user_id,
                    "object_id": context_object_id,
                },
            ).scalar_one()

        assert failed_status == "error"
        assert active_leaf_id == retry_assistant_id
        assert meta_count == 1
        assert job_count == 1
        assert copied_link_count == 1

    def test_retry_failed_followup_response_creates_sibling_under_same_parent(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            root_user_id = create_test_message(session, conversation_id, 1, "user", "Root")
            parent_assistant_id = create_test_message(
                session,
                conversation_id,
                2,
                "assistant",
                "Complete parent",
                parent_message_id=root_user_id,
            )
            source_user_id = create_test_message(
                session,
                conversation_id,
                3,
                "user",
                "Follow up",
                parent_message_id=parent_assistant_id,
            )
            session.execute(
                text(
                    """
                    UPDATE messages
                    SET branch_anchor_kind = 'assistant_message',
                        branch_anchor = CAST(:branch_anchor AS jsonb)
                    WHERE id = :message_id
                    """
                ),
                {
                    "message_id": source_user_id,
                    "branch_anchor": json.dumps({"message_id": str(parent_assistant_id)}),
                },
            )
            failed_assistant_id = create_test_message(
                session,
                conversation_id,
                4,
                "assistant",
                "Provider unavailable.",
                status="error",
                model_id=model_id,
                parent_message_id=source_user_id,
            )
            session.commit()
        _create_failed_chat_run(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            model_id=model_id,
            user_message_id=source_user_id,
            assistant_message_id=failed_assistant_id,
            idempotency_key="failed-followup-source",
            error_code="E_LLM_PROVIDER_DOWN",
        )

        response = _post_retry(auth_client, user_id, failed_assistant_id, "retry-followup")

        assert response.status_code == 200, f"Expected follow-up retry to succeed: {response.text}"
        data = response.json()["data"]
        retry_run_id = UUID(data["run"]["id"])
        retry_user_id = UUID(data["user_message"]["id"])
        retry_assistant_id = UUID(data["assistant_message"]["id"])
        _register_run_cleanup(direct_db, retry_run_id, conversation_id)

        assert data["user_message"]["message_document"]["blocks"][0]["text"] == "Follow up"
        assert data["user_message"]["parent_message_id"] == str(parent_assistant_id)
        assert data["user_message"]["branch_anchor_kind"] == "assistant_message"
        assert data["user_message"]["branch_anchor"]["message_id"] == str(parent_assistant_id)
        assert data["assistant_message"]["parent_message_id"] == str(retry_user_id)

        with direct_db.session() as session:
            branch_count = session.execute(
                text(
                    """
                    SELECT COUNT(*)
                    FROM conversation_branches
                    WHERE branch_user_message_id = :message_id
                    """
                ),
                {"message_id": retry_user_id},
            ).scalar_one()
            active_leaf_id = session.execute(
                text(
                    """
                    SELECT active_leaf_message_id
                    FROM conversation_active_paths
                    WHERE conversation_id = :conversation_id
                      AND viewer_user_id = :viewer_user_id
                    """
                ),
                {"conversation_id": conversation_id, "viewer_user_id": user_id},
            ).scalar_one()
        assert branch_count == 1
        assert active_leaf_id == retry_assistant_id

    def test_retry_idempotency_replay_and_mismatch(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            source_user_id = create_test_message(session, conversation_id, 1, "user", "First")
            failed_assistant_id = create_test_message(
                session,
                conversation_id,
                2,
                "assistant",
                "Timed out.",
                status="error",
                model_id=model_id,
                parent_message_id=source_user_id,
            )
            other_user_id = create_test_message(session, conversation_id, 3, "user", "Second")
            other_failed_assistant_id = create_test_message(
                session,
                conversation_id,
                4,
                "assistant",
                "Timed out again.",
                status="error",
                model_id=model_id,
                parent_message_id=other_user_id,
            )
        _create_failed_chat_run(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            model_id=model_id,
            user_message_id=source_user_id,
            assistant_message_id=failed_assistant_id,
            idempotency_key="failed-replay-source",
        )
        _create_failed_chat_run(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            model_id=model_id,
            user_message_id=other_user_id,
            assistant_message_id=other_failed_assistant_id,
            idempotency_key="failed-mismatch-source",
        )

        first = _post_retry(auth_client, user_id, failed_assistant_id, "retry-replay")
        second = _post_retry(auth_client, user_id, failed_assistant_id, "retry-replay")
        mismatch = _post_retry(auth_client, user_id, other_failed_assistant_id, "retry-replay")

        assert first.status_code == 200, f"Initial retry failed: {first.text}"
        assert second.status_code == 200, f"Retry replay failed: {second.text}"
        assert mismatch.status_code == 409, (
            f"Expected retry idempotency mismatch, got {mismatch.status_code}: {mismatch.text}"
        )
        assert first.json()["data"]["run"]["id"] == second.json()["data"]["run"]["id"]
        assert mismatch.json()["error"]["code"] == "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH"

        retry_run_id = UUID(first.json()["data"]["run"]["id"])
        _register_run_cleanup(direct_db, retry_run_id, conversation_id)

    def test_message_list_marks_only_retryable_failed_assistant(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            source_user_id = create_test_message(session, conversation_id, 1, "user", "Retry?")
            failed_assistant_id = create_test_message(
                session,
                conversation_id,
                2,
                "assistant",
                "Timed out.",
                status="error",
                model_id=model_id,
                parent_message_id=source_user_id,
            )
        _create_failed_chat_run(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            model_id=model_id,
            user_message_id=source_user_id,
            assistant_message_id=failed_assistant_id,
            idempotency_key="failed-capability-source",
        )

        listed = auth_client.get(
            f"/conversations/{conversation_id}/messages",
            headers=auth_headers(user_id),
        )

        assert listed.status_code == 200, f"Expected messages list: {listed.text}"
        messages = listed.json()["data"]
        retryable = {row["id"]: row["can_retry_response"] for row in messages}
        assert retryable[str(source_user_id)] is False
        assert retryable[str(failed_assistant_id)] is True
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)

    def test_retry_rejects_nonretryable_failed_assistant(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            source_user_id = create_test_message(
                session, conversation_id, 1, "user", "Bad request?"
            )
            failed_assistant_id = create_test_message(
                session,
                conversation_id,
                2,
                "assistant",
                "The request was rejected by the model provider.",
                status="error",
                model_id=model_id,
                parent_message_id=source_user_id,
            )
        _create_failed_chat_run(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            model_id=model_id,
            user_message_id=source_user_id,
            assistant_message_id=failed_assistant_id,
            idempotency_key="failed-nonretryable-source",
            error_code="E_LLM_BAD_REQUEST",
        )

        response = _post_retry(auth_client, user_id, failed_assistant_id, "retry-nonretryable")

        assert response.status_code == 409, (
            f"Expected nonretryable retry to fail, got {response.status_code}: {response.text}"
        )
        assert response.json()["error"]["code"] == "E_RETRY_NOT_ALLOWED"
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
