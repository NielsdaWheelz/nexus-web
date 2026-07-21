"""Integration tests for the durable chat-run HTTP contract."""

import json
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

from nexus.config import clear_settings_cache
from nexus.db.models import (
    ChatRun,
    ChatRunTurnContext,
    NoteBlock,
    ResourceEdge,
    ResourceExternalSnapshot,
)
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.schemas.conversation import NoBranchAnchorRequest, chat_run_event_payload_json
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.chat_run_citations import _citation_target_ref
from nexus.services.chat_run_event_store import ChatRunEventEmitter
from nexus.services.chat_run_tools import app_search_tool_output
from nexus.services.chat_run_validation import validate_pre_phase
from nexus.services.chat_runs import (
    _app_search_scopes_from_tool_args,
)
from nexus.services.conversation_branches import persist_active_leaf
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
    missing = {"chat_runs", "chat_run_events"} - tables
    if missing:
        pytest.fail(f"chat-runs schema missing: {', '.join(sorted(missing))}")


def _assert_openai_strict_schema(schema: dict[str, Any], path: str = "$") -> None:
    schema_type = schema.get("type")
    is_object = schema_type == "object" or (
        isinstance(schema_type, list) and "object" in schema_type
    )
    if is_object or "properties" in schema:
        properties = schema.get("properties")
        assert isinstance(properties, dict), f"{path} object schema must declare properties"
        assert schema.get("additionalProperties") is False, (
            f"{path} must set additionalProperties=false"
        )
        assert schema.get("required") == list(properties), (
            f"{path} required must exactly match properties in schema order"
        )
        for key, property_schema in properties.items():
            assert isinstance(property_schema, dict), f"{path}.properties.{key} must be an object"
            _assert_openai_strict_schema(property_schema, f"{path}.properties.{key}")

    items = schema.get("items")
    if isinstance(items, dict):
        _assert_openai_strict_schema(items, f"{path}.items")


@pytest.fixture
def chat_runs_schema(engine: Engine) -> None:
    _require_chat_runs_schema(engine)


def _create_run_payload(model_id: UUID, **overrides) -> dict:
    """Build a /chat-runs request body.

    Per spec §7.1 (post-cutover), ChatRunCreateRequest requires
    ``conversation_id``. Callers must supply it via ``overrides`` (or via the
    POST /conversations bootstrap pattern these tests use).
    """
    payload = {
        "content": "Summarize the current notes.",
        "model_id": str(model_id),
        "reasoning": "none",
        "key_mode": "auto",
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


def _post_resend(auth_client, user_id: UUID, assistant_message_id: UUID, idempotency_key: str):
    return auth_client.post(
        f"/messages/{assistant_message_id}/resend",
        headers={**auth_headers(user_id), "Idempotency-Key": idempotency_key},
    )


def _assert_chat_run_meta_payload(
    payload: dict,
    *,
    run_id: UUID,
    conversation_id: UUID,
    user_message_id: UUID,
    assistant_message_id: UUID,
    model_id: UUID,
    chat_subject: dict | None,
) -> None:
    assert payload == {
        "run_id": str(run_id),
        "conversation_id": str(conversation_id),
        "user_message_id": str(user_message_id),
        "assistant_message_id": str(assistant_message_id),
        "model_id": str(model_id),
        "provider": "openai",
        "chat_subject": chat_subject,
    }


def test_chat_run_meta_payload_requires_chat_subject_key():
    with pytest.raises(ValidationError):
        chat_run_event_payload_json(
            "meta",
            {
                "run_id": str(uuid4()),
                "conversation_id": str(uuid4()),
                "user_message_id": str(uuid4()),
                "assistant_message_id": str(uuid4()),
                "model_id": str(uuid4()),
                "provider": "openai",
            },
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

        # New chat lands via POST /conversations + POST /chat-runs with conversation_id.
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
        _assert_chat_run_meta_payload(
            event_rows[0].payload,
            run_id=run_id,
            conversation_id=conversation_id,
            user_message_id=UUID(data["user_message"]["id"]),
            assistant_message_id=UUID(data["assistant_message"]["id"]),
            model_id=model_id,
            chat_subject=None,
        )
        assert job_count == 1, f"Expected one chat_run background job for run {run_id}"

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
            conversation_id = create_test_conversation(session, user_id)
            root_user_id = create_test_message(
                session, conversation_id, 1, "user", "Root question."
            )
            complete_assistant_id = create_test_message(
                session,
                conversation_id,
                2,
                "assistant",
                "Complete answer.",
                parent_message_id=root_user_id,
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
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversation_active_paths", "conversation_id", conversation_id)

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

    def test_catalog_drift_defects_instead_of_hiding_model(self, monkeypatch: pytest.MonkeyPatch):
        """Enabled DB rows outside the curated catalog are operator defects."""
        monkeypatch.setattr(
            "nexus.services.chat_run_validation.get_model_by_id",
            lambda _db, _model_id: SimpleNamespace(
                provider="openai",
                model_name="uncataloged-model",
                is_available=True,
            ),
        )

        with pytest.raises(AssertionError, match="uncataloged-model"):
            validate_pre_phase(
                db=object(),  # type: ignore[arg-type]
                viewer_id=uuid4(),
                conversation_id=uuid4(),
                parent_message_id=None,
                branch_anchor=NoBranchAnchorRequest(),
                chat_subject=None,
                reader_selection=None,
                content="hello",
                model_id=uuid4(),
                reasoning="none",
                key_mode="auto",
                use_platform_key=True,
            )

    def test_non_chat_capable_catalog_model_is_rejected_before_enqueue(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(
            "nexus.services.chat_run_validation.get_model_by_id",
            lambda _db, _model_id: SimpleNamespace(
                provider="cloudflare",
                model_name="@cf/openai/gpt-oss-20b",
                is_available=True,
            ),
        )

        with pytest.raises(ApiError) as exc_info:
            validate_pre_phase(
                db=object(),  # type: ignore[arg-type]
                viewer_id=uuid4(),
                conversation_id=uuid4(),
                parent_message_id=None,
                branch_anchor=NoBranchAnchorRequest(),
                chat_subject=None,
                reader_selection=None,
                content="hello",
                model_id=uuid4(),
                reasoning="none",
                key_mode="auto",
                use_platform_key=True,
            )

        assert exc_info.value.code == ApiErrorCode.E_MODEL_NOT_AVAILABLE

    @pytest.mark.parametrize("field", ["reasoning", "key_mode"])
    def test_chat_run_request_requires_provider_policy_fields(
        self, auth_client, chat_runs_schema, field: str
    ):
        """Reasoning and key mode are explicit post-cutover request fields."""
        user_id = create_test_user_id()
        payload = _create_run_payload(uuid4(), conversation_id=str(uuid4()))
        payload.pop(field)

        response = auth_client.post(
            "/chat-runs",
            headers={**auth_headers(user_id), "Idempotency-Key": f"chat-run-missing-{field}"},
            json=payload,
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_chat_run_request_rejects_unknown_key_mode(self, auth_client, chat_runs_schema):
        """The request body owns key-mode validation before service-layer routing."""
        user_id = create_test_user_id()
        payload = _create_run_payload(
            uuid4(),
            conversation_id=str(uuid4()),
            key_mode="byok",
        )

        response = auth_client.post(
            "/chat-runs",
            headers={**auth_headers(user_id), "Idempotency-Key": "chat-run-rejects-key-mode"},
            json=payload,
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

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


class TestChatRunTooling:
    """Tooling and prompt-input contracts for POST /chat-runs."""

    def test_chat_tool_schemas_are_openai_strict_compatible(self):
        from nexus.services.agent_tools.app_search import APP_SEARCH_TOOL_DEFINITION
        from nexus.services.agent_tools.inspect_resource import INSPECT_RESOURCE_TOOL_DEFINITION
        from nexus.services.agent_tools.read_resource import READ_RESOURCE_TOOL_DEFINITION
        from nexus.services.agent_tools.web_search import WEB_SEARCH_TOOL_DEFINITION
        from nexus.services.chat_runs import _CHAT_TOOL_SPECS

        definitions = {
            APP_SEARCH_TOOL_DEFINITION["name"]: APP_SEARCH_TOOL_DEFINITION,
            WEB_SEARCH_TOOL_DEFINITION["name"]: WEB_SEARCH_TOOL_DEFINITION,
            READ_RESOURCE_TOOL_DEFINITION["name"]: READ_RESOURCE_TOOL_DEFINITION,
            INSPECT_RESOURCE_TOOL_DEFINITION["name"]: INSPECT_RESOURCE_TOOL_DEFINITION,
        }
        assert {tool.name for tool in _CHAT_TOOL_SPECS} == set(definitions)
        for tool in _CHAT_TOOL_SPECS:
            assert tool.strict is True
            assert tool.parameters == definitions[tool.name]["parameters"]
            _assert_openai_strict_schema(tool.parameters, path=f"$.tools.{tool.name}")

        app_props = APP_SEARCH_TOOL_DEFINITION["parameters"]["properties"]
        assert {
            "query",
            "kinds",
            "formats",
            "authors",
            "roles",
            "scopes",
        } == set(app_props)
        for key in ("kinds", "formats", "authors", "roles", "scopes"):
            branches = app_props[key]["anyOf"]
            assert branches[0]["type"] == "array", f"{key} non-null arm must be an array"
            assert branches[1] == {"type": "null"}, f"{key} must be required-nullable"

        web_props = WEB_SEARCH_TOOL_DEFINITION["parameters"]["properties"]
        assert WEB_SEARCH_TOOL_DEFINITION["parameters"]["required"] == [
            "query",
            "freshness_days",
        ]
        assert web_props["freshness_days"]["anyOf"] == [
            {"type": "integer"},
            {"type": "null"},
        ]
        assert "minimum" not in web_props["freshness_days"], (
            "freshness_days minimum is domain validation (search_web_readonly), "
            "not a schema keyword"
        )

    def test_app_search_tool_empty_filter_arrays_are_omitted(self):
        from nexus.services.chat_runs import _app_search_string_array_from_tool_args

        assert _app_search_string_array_from_tool_args({"kinds": []}, "kinds") == (
            None,
            None,
        )
        assert _app_search_string_array_from_tool_args({"kinds": ["  "]}, "kinds") == (
            None,
            None,
        )

    def test_chat_run_tools_always_registered(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        """Tool SSE events accept any non-empty tool name."""
        from nexus.schemas.conversation import (
            ChatRunToolCallStartEventPayload,
            ChatRunToolResultEventPayload,
        )

        common = {
            "tool_call_id": None,
            "assistant_message_id": str(uuid4()),
            "tool_call_index": 0,
        }
        for tool_name in (
            "app_search",
            "web_search",
            "read_resource",
            "inspect_resource",
            "future_tool",
        ):
            ChatRunToolCallStartEventPayload.model_validate(
                {
                    **common,
                    "tool_name": tool_name,
                    "provider_event_seq_start": 0,
                    "provider_event_seq_end": 0,
                }
            )
            ChatRunToolResultEventPayload.model_validate(
                {
                    **common,
                    "tool_name": tool_name,
                    "status": "complete",
                    "scope": "all",
                    "types": [],
                    "filters": {},
                    "result_count": 0,
                    "selected_count": 0,
                    "results": [],
                }
            )

    def test_app_search_singular_scope_is_always_tool_error(self):
        scopes, forced_error = _app_search_scopes_from_tool_args(
            {"query": "needle", "scope": "media:legacy", "scopes": ["media:current"]}
        )

        assert scopes == []
        assert forced_error is not None
        assert "singular scope field is invalid" in forced_error

    def test_app_search_scopes_must_be_array_of_strings(self):
        scopes, forced_error = _app_search_scopes_from_tool_args(
            {"query": "needle", "scopes": "media:not-an-array"}
        )

        assert scopes == []
        assert forced_error == "app_search scopes must be an array of URI strings"

        scopes, forced_error = _app_search_scopes_from_tool_args(
            {"query": "needle", "scopes": ["media:ok", 123]}
        )

        assert scopes == []
        assert forced_error == "app_search scopes must be an array of URI strings"

        scopes, forced_error = _app_search_scopes_from_tool_args(
            {"query": "needle", "scopes": ["  "]}
        )

        assert scopes == []
        assert forced_error == "app_search scopes must be non-empty URI strings"

    def test_app_search_scopes_accepts_array_of_strings(self):
        scopes, forced_error = _app_search_scopes_from_tool_args(
            {"query": "needle", "scopes": ["media:one", "library:two"]}
        )

        assert scopes == ["media:one", "library:two"]
        assert forced_error is None

    def test_citation_target_reads_search_owned_target(self):
        """Citation-edge targets come from the validated retrieval result ref."""
        span_id = uuid4()
        media_id = uuid4()
        chunk_id = uuid4()
        note_block_id = uuid4()
        highlight_id = uuid4()
        fragment_id = uuid4()
        message_id = uuid4()
        apparatus_item_id = uuid4()

        def target(uri: str | None):
            return _citation_target_ref(
                None, run=None, row={"result_ref": {"citation_target": uri}}
            )

        for uri in (
            f"evidence_span:{span_id}",
            f"content_chunk:{chunk_id}",
            f"media:{media_id}",
            f"highlight:{highlight_id}",
            f"fragment:{fragment_id}",
            f"note_block:{note_block_id}",
            f"message:{message_id}",
            f"reader_apparatus_item:{apparatus_item_id}",
        ):
            assert target(uri).uri == uri

        assert target(None) is None
        assert _citation_target_ref(None, run=None, row={"result_ref": {}}) is None

    def test_citation_target_rejects_malformed_or_uncitable_targets(self):
        for raw_target in ("not-a-ref", "library:not-a-uuid", f"library:{uuid4()}"):
            with pytest.raises(AssertionError):
                _citation_target_ref(
                    None,
                    run=None,
                    row={"result_ref": {"citation_target": raw_target}},
                )

    def test_chat_run_subject_persists_turn_context_and_job_payload(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
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
            chat_subject={"resource_ref": f"media:{media_id}"},
        )
        response = _post_chat_run(
            auth_client,
            user_id,
            payload,
            idempotency_key="chat-run-subject-media",
        )
        assert response.status_code == 200, (
            f"Expected chat-run with chat_subject to succeed, got "
            f"{response.status_code}: {response.text}"
        )
        data = response.json()["data"]
        run_id = UUID(data["run"]["id"])
        _register_run_cleanup(direct_db, run_id)

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
            meta_payload = session.execute(
                text(
                    """
                    SELECT payload FROM chat_run_events
                    WHERE run_id = :run_id
                      AND event_type = 'meta'
                    """
                ),
                {"run_id": run_id},
            ).scalar_one()
            turn_context = session.get(ChatRunTurnContext, run_id)
            context_edge_count = session.execute(
                text(
                    """
                    SELECT COUNT(*) FROM resource_edges
                    WHERE source_scheme = 'conversation'
                      AND source_id = :conversation_id
                      AND target_scheme = 'media'
                      AND target_id = :media_id
                      AND kind = 'context'
                      AND origin = 'user'
                      AND ordinal IS NULL
                    """
                ),
                {"conversation_id": conversation_id, "media_id": media_id},
            ).scalar_one()

        assert job_payload == {"run_id": str(run_id)}
        assert turn_context is not None
        _assert_chat_run_meta_payload(
            meta_payload,
            run_id=run_id,
            conversation_id=conversation_id,
            user_message_id=UUID(data["user_message"]["id"]),
            assistant_message_id=UUID(data["assistant_message"]["id"]),
            model_id=model_id,
            chat_subject={
                "requested_resource_ref": f"media:{media_id}",
                "resource_ref": f"media:{media_id}",
                "context_edge_id": str(turn_context.subject_context_edge_id),
                "companions": [],
            },
        )
        assert turn_context.requested_subject_scheme == "media"
        assert turn_context.requested_subject_id == media_id
        assert turn_context.subject_scheme == "media"
        assert turn_context.subject_id == media_id
        assert turn_context.subject_context_edge_id is not None
        assert context_edge_count == 1

    def test_chat_run_rejects_reader_context_field(
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

        response = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(
                model_id,
                conversation_id=str(conversation_id),
                reader_context={"media_id": str(uuid4())},
            ),
            idempotency_key="chat-run-reader-context-rejected",
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"


class TestChatResponseRetry:
    def test_retry_failed_root_response_creates_new_root_attempt_and_preserves_failure(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        """Retrying a failed root response creates a sibling attempt under the
        same parent, leaves the prior failure intact, and re-enqueues a run.
        """
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
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
            session.commit()
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

        assert data["run"]["status"] == "queued"
        assert data["run"]["model_id"] == str(model_id)
        assert data["run"]["reasoning"] == "none"
        assert data["user_message"]["message_document"]["blocks"][0]["text"] == (
            "Why did the first answer fail?"
        )
        assert data["user_message"]["parent_message_id"] is None
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
            meta_payload = session.execute(
                text(
                    """
                    SELECT payload
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

        assert failed_status == "error"
        assert active_leaf_id == retry_assistant_id
        assert meta_count == 1
        _assert_chat_run_meta_payload(
            meta_payload,
            run_id=retry_run_id,
            conversation_id=conversation_id,
            user_message_id=retry_user_id,
            assistant_message_id=retry_assistant_id,
            model_id=model_id,
            chat_subject=None,
        )
        assert job_count == 1

    def test_retry_failed_followup_response_creates_sibling_under_same_parent(
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
        _seed_ai_plus_billing(direct_db, user_id)
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
        resendable = {row["id"]: row["can_resend_response"] for row in messages}
        assert retryable[str(source_user_id)] is False
        assert retryable[str(failed_assistant_id)] is True
        assert resendable[str(source_user_id)] is False
        assert resendable[str(failed_assistant_id)] is True
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

    def test_retry_and_resend_recheck_current_model_availability(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            retry_user_id = create_test_message(session, conversation_id, 1, "user", "Retry?")
            retry_assistant_id = create_test_message(
                session,
                conversation_id,
                2,
                "assistant",
                "Timed out.",
                status="error",
                model_id=model_id,
                parent_message_id=retry_user_id,
            )
            resend_user_id = create_test_message(
                session, conversation_id, 3, "user", "Bad request?"
            )
            resend_assistant_id = create_test_message(
                session,
                conversation_id,
                4,
                "assistant",
                "The request was rejected by the model provider.",
                status="error",
                model_id=model_id,
                parent_message_id=resend_user_id,
            )
        _create_failed_chat_run(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            model_id=model_id,
            user_message_id=retry_user_id,
            assistant_message_id=retry_assistant_id,
            idempotency_key="retry-unavailable-source",
        )
        _create_failed_chat_run(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            model_id=model_id,
            user_message_id=resend_user_id,
            assistant_message_id=resend_assistant_id,
            idempotency_key="resend-unavailable-source",
            error_code="E_LLM_BAD_REQUEST",
        )
        with direct_db.session() as session:
            session.execute(
                text("UPDATE models SET is_available = false WHERE id = :model_id"),
                {"model_id": model_id},
            )
            run_count_before = session.execute(
                text("SELECT COUNT(*) FROM chat_runs WHERE conversation_id = :conversation_id"),
                {"conversation_id": conversation_id},
            ).scalar_one()
            session.commit()

        try:
            retry_response = _post_retry(
                auth_client, user_id, retry_assistant_id, "retry-unavailable"
            )
            resend_response = _post_resend(
                auth_client, user_id, resend_assistant_id, "resend-unavailable"
            )

            assert retry_response.status_code == 400
            assert retry_response.json()["error"]["code"] == "E_MODEL_NOT_AVAILABLE"
            assert resend_response.status_code == 400
            assert resend_response.json()["error"]["code"] == "E_MODEL_NOT_AVAILABLE"
            with direct_db.session() as session:
                run_count_after = session.execute(
                    text("SELECT COUNT(*) FROM chat_runs WHERE conversation_id = :conversation_id"),
                    {"conversation_id": conversation_id},
                ).scalar_one()
            assert run_count_after == run_count_before
        finally:
            with direct_db.session() as session:
                session.execute(
                    text("UPDATE models SET is_available = true WHERE id = :model_id"),
                    {"model_id": model_id},
                )
                session.commit()
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)

    def test_resend_nonretryable_failed_root_response_creates_new_attempt(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
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
            idempotency_key="failed-resend-source",
            error_code="E_LLM_BAD_REQUEST",
        )

        response = _post_resend(auth_client, user_id, failed_assistant_id, "resend-bad-request")

        assert response.status_code == 200, f"Expected resend to succeed: {response.text}"
        data = response.json()["data"]
        resend_run_id = UUID(data["run"]["id"])
        resend_user_id = UUID(data["user_message"]["id"])
        resend_assistant_id = UUID(data["assistant_message"]["id"])
        _register_run_cleanup(direct_db, resend_run_id, conversation_id)

        assert data["run"]["status"] == "queued"
        assert data["run"]["model_id"] == str(model_id)
        assert data["user_message"]["message_document"]["blocks"][0]["text"] == "Bad request?"
        assert data["user_message"]["parent_message_id"] is None
        assert data["assistant_message"]["status"] == "pending"
        assert data["assistant_message"]["parent_message_id"] == str(resend_user_id)

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
            job_count = session.execute(
                text(
                    """
                    SELECT COUNT(*)
                    FROM background_jobs
                    WHERE kind = 'chat_run'
                      AND payload->>'run_id' = :run_id
                    """
                ),
                {"run_id": str(resend_run_id)},
            ).scalar_one()

        assert failed_status == "error"
        assert active_leaf_id == resend_assistant_id
        assert job_count == 1

    def test_resend_cancelled_response_creates_new_attempt(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            source_user_id = create_test_message(session, conversation_id, 1, "user", "Again?")
            cancelled_assistant_id = create_test_message(
                session,
                conversation_id,
                2,
                "assistant",
                "Request cancelled.",
                status="cancelled",
                model_id=model_id,
                parent_message_id=source_user_id,
            )
            run_id = uuid4()
            session.add(
                ChatRun(
                    id=run_id,
                    owner_user_id=user_id,
                    conversation_id=conversation_id,
                    user_message_id=source_user_id,
                    assistant_message_id=cancelled_assistant_id,
                    idempotency_key="cancelled-resend-source",
                    payload_hash="cancelled-resend-source-payload",
                    status="cancelled",
                    model_id=model_id,
                    reasoning="none",
                    key_mode="auto",
                    completed_at=datetime.now(UTC),
                )
            )
            session.commit()

        response = _post_resend(auth_client, user_id, cancelled_assistant_id, "resend-cancelled")

        assert response.status_code == 200, f"Expected cancelled resend: {response.text}"
        data = response.json()["data"]
        resend_run_id = UUID(data["run"]["id"])
        _register_run_cleanup(direct_db, resend_run_id, conversation_id)
        direct_db.register_cleanup("chat_runs", "id", run_id)
        assert data["run"]["status"] == "queued"
        assert data["user_message"]["message_document"]["blocks"][0]["text"] == "Again?"
        assert data["assistant_message"]["status"] == "pending"


class TestCitationEdgeWriteThrough:
    """Spec §5.2/§11.6: citations are edges; telemetry keeps only `cited_edge_id`.

    ``record_tool_citations`` mints one ``origin='citation'`` edge per selected
    retrieval (``source = message:<assistant_message_id>``, dense ordinals,
    replace-by-ordinal on re-execution) and points the row at it.
    ``emit_citation_index`` emits backend-built citations keyed by
    ``citation_edge_id`` and graduates cited LOCAL targets into
    ``origin='citation'`` context edges with a ``context_ref_added`` event in the
    context-ref shape.
    """

    def _create_chat_run_row(
        self,
        direct_db: DirectSessionManager,
        *,
        user_id: UUID,
        conversation_id: UUID,
        user_message_id: UUID,
        assistant_message_id: UUID,
        model_id: UUID,
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
                    idempotency_key=f"write-through-{run_id}",
                    payload_hash="hash",
                    status="running",
                    model_id=model_id,
                    reasoning="none",
                    key_mode="auto",
                )
            )
            session.commit()
        return run_id

    def _seed_tool_call_with_chunk_row(
        self,
        direct_db: DirectSessionManager,
        *,
        conversation_id: UUID,
        user_message_id: UUID,
        assistant_message_id: UUID,
        media_id: UUID,
        chunk_id: UUID,
        selected: bool,
    ) -> UUID:
        """Insert one app_search tool-call + one content_chunk retrieval row.

        ``selected`` is what marks a row citable now — there is no per-row
        ordinal column. Returns the tool_call_id.
        """
        tool_call_id = uuid4()
        with direct_db.session() as session:
            session.execute(
                text(
                    """
                    INSERT INTO message_tool_calls (
                        id, conversation_id, user_message_id, assistant_message_id,
                        tool_name, tool_call_index, query_hash, scope,
                        requested_types, status
                    )
                    VALUES (
                        :tool_call_id, :conversation_id, :user_message_id,
                        :assistant_message_id, 'app_search', 1, 'sha-citation-test',
                        'all', '["content_chunk"]'::jsonb, 'complete'
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
            locator = {
                "type": "web_text_offsets",
                "media_id": str(media_id),
                "fragment_id": str(chunk_id),
                "start_offset": 0,
                "end_offset": 12,
                "media_kind": "web_article",
            }
            result_ref = {
                "type": "content_chunk",
                "id": str(chunk_id),
                "result_type": "content_chunk",
                "source_id": str(chunk_id),
                "source_kind": "web_article",
                "title": "Chunk title",
                "source_label": "Section 1",
                "snippet": "chunk snippet",
                "deep_link": "/media/deep-link",
                "citation_target": f"content_chunk:{chunk_id}",
                "citation_label": "Chunk title",
                "context_ref": {"type": "content_chunk", "id": str(chunk_id)},
                "evidence_span_id": None,
                "evidence_span_ids": [],
                "locator": locator,
                "media_id": str(media_id),
                "media_kind": "web_article",
                "score": 0.9,
                "selected": selected,
            }
            session.execute(
                text(
                    """
                    INSERT INTO message_retrievals (
                        tool_call_id, ordinal, result_type, source_id, media_id,
                        scope, context_ref, result_ref, selected, source_title,
                        section_label, exact_snippet, deep_link, locator
                    )
                    VALUES (
                        :tool_call_id, 1, 'content_chunk', :chunk_id_str, :media_id,
                        'all',
                        CAST(:context_ref AS jsonb),
                        CAST(:result_ref AS jsonb),
                        :selected, 'Chunk title', 'Section 1', 'chunk snippet',
                        '/media/deep-link', CAST(:locator AS jsonb)
                    )
                    """
                ),
                {
                    "tool_call_id": tool_call_id,
                    "media_id": media_id,
                    "chunk_id_str": str(chunk_id),
                    "context_ref": json.dumps({"type": "content_chunk", "id": str(chunk_id)}),
                    "result_ref": json.dumps(result_ref),
                    "locator": json.dumps(locator),
                    "selected": selected,
                },
            )
            session.commit()
        return tool_call_id

    def _setup_conversation(self, auth_client, direct_db: DirectSessionManager):
        """Bootstrapped user + searchable media (real content chunk) + run shell."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            media_id = create_searchable_media(session, user_id, title="Cited Source")
            chunk_id = session.execute(
                text(
                    "SELECT id FROM content_chunks "
                    "WHERE owner_kind = 'media' AND owner_id = :media_id "
                    "ORDER BY chunk_idx LIMIT 1"
                ),
                {"media_id": media_id},
            ).scalar_one()
            user_message_id = create_test_message(session, conversation_id, 1, "user", "Ask")
            assistant_message_id = create_test_message(
                session,
                conversation_id,
                2,
                "assistant",
                "Answer [1].",
                parent_message_id=user_message_id,
            )
        return (
            user_id,
            model_id,
            conversation_id,
            media_id,
            chunk_id,
            user_message_id,
            assistant_message_id,
        )

    def _register_cleanups(
        self,
        direct_db: DirectSessionManager,
        *,
        user_id: UUID,
        conversation_id: UUID,
        media_id: UUID,
        run_id: UUID,
        tool_call_id: UUID,
    ) -> None:
        # LIFO: the messages(conversation_id) handler is registered LAST so it
        # runs FIRST and wipes the chat graph (tool calls, retrievals, runs,
        # events, message-sourced resource_edges) before the generic deletes.
        direct_db.register_cleanup("resource_edges", "user_id", user_id)
        direct_db.register_cleanup("resource_external_snapshots", "user_id", user_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("chat_run_events", "run_id", run_id)
        direct_db.register_cleanup("message_retrievals", "tool_call_id", tool_call_id)
        direct_db.register_cleanup("message_tool_calls", "id", tool_call_id)
        direct_db.register_cleanup("chat_runs", "id", run_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)

    def test_selected_retrieval_mints_edge_and_graduates_context(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        from nexus.db.models import ChatRun as ChatRunModel
        from nexus.services.chat_run_citations import emit_citation_index, record_tool_citations

        (
            user_id,
            model_id,
            conversation_id,
            media_id,
            chunk_id,
            user_message_id,
            assistant_message_id,
        ) = self._setup_conversation(auth_client, direct_db)
        run_id = self._create_chat_run_row(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            model_id=model_id,
        )
        tool_call_id = self._seed_tool_call_with_chunk_row(
            direct_db,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            media_id=media_id,
            chunk_id=chunk_id,
            selected=True,
        )
        self._register_cleanups(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            media_id=media_id,
            run_id=run_id,
            tool_call_id=tool_call_id,
        )

        with direct_db.session() as session:
            run = session.get(ChatRunModel, run_id)
            assert run is not None, "Test setup must persist the chat run row"
            next_ordinal = record_tool_citations(
                session, run=run, tool_call_id=tool_call_id, start_ordinal=1
            )
            assert next_ordinal == 2, (
                f"One selected row must consume exactly one ordinal; got next={next_ordinal}"
            )
            # Re-execution parity: recording the same tool call again replaces
            # the edge at that ordinal instead of failing on the unique index.
            next_ordinal = record_tool_citations(
                session, run=run, tool_call_id=tool_call_id, start_ordinal=1
            )
            assert next_ordinal == 2
            session.commit()

        with direct_db.session() as session:
            edges = (
                session.query(ResourceEdge)
                .filter(
                    ResourceEdge.source_scheme == "message",
                    ResourceEdge.source_id == assistant_message_id,
                    ResourceEdge.origin == "citation",
                )
                .all()
            )
            assert len(edges) == 1, (
                f"Exactly one citation edge must exist after re-recording; got "
                f"{[(e.ordinal, e.target_scheme, e.target_id) for e in edges]}"
            )
            edge = edges[0]
            assert edge.ordinal == 1
            assert edge.kind == "context"
            assert (edge.target_scheme, edge.target_id) == ("content_chunk", chunk_id), (
                f"Chunk citations target content_chunk:<id>; got "
                f"{edge.target_scheme}:{edge.target_id}"
            )
            assert edge.snapshot is not None and edge.snapshot["title"] == "Chunk title", (
                f"Citation edges carry the display snapshot; got {edge.snapshot}"
            )
            cited_edge_id = session.execute(
                text(
                    "SELECT cited_edge_id FROM message_retrievals "
                    "WHERE tool_call_id = :tool_call_id"
                ),
                {"tool_call_id": tool_call_id},
            ).scalar_one()
            assert cited_edge_id == edge.id, (
                f"The telemetry row must point at its citation edge; "
                f"got {cited_edge_id} != {edge.id}"
            )

        with direct_db.session() as session:
            run = session.get(ChatRunModel, run_id)
            emit_citation_index(
                session, run, "Answer [1].", emitter=ChatRunEventEmitter(session, run)
            )
            session.commit()

        with direct_db.session() as session:
            events = session.execute(
                text(
                    "SELECT event_type, payload FROM chat_run_events "
                    "WHERE run_id = :run_id ORDER BY seq ASC"
                ),
                {"run_id": run_id},
            ).fetchall()
            context_edge_count = session.execute(
                text(
                    """
                    SELECT COUNT(*) FROM resource_edges
                    WHERE source_scheme = 'conversation' AND source_id = :conversation_id
                      AND target_scheme = 'content_chunk' AND target_id = :chunk_id
                      AND kind = 'context' AND origin = 'citation'
                    """
                ),
                {"conversation_id": conversation_id, "chunk_id": chunk_id},
            ).scalar_one()
        event_types = [row[0] for row in events]
        assert event_types.count("citation_index") == 1, (
            f"citation_index must fire once for a cited run; got {event_types}"
        )
        assert "context_ref_added" in event_types, (
            f"context_ref_added must follow when a cited local target graduates; got {event_types}"
        )
        assert event_types.index("context_ref_added") > event_types.index("citation_index"), (
            "context_ref_added must be emitted AFTER citation_index"
        )
        citation_payload = next(row[1] for row in events if row[0] == "citation_index")
        item = citation_payload["citations"][0]
        with direct_db.session() as session:
            edge_id = session.execute(
                text(
                    "SELECT id FROM resource_edges WHERE source_scheme = 'message' "
                    "AND source_id = :amid AND ordinal = 1"
                ),
                {"amid": assistant_message_id},
            ).scalar_one()
        assert item["citation_edge_id"] == str(edge_id), (
            f"citation_index items are keyed by citation_edge_id; got {item}"
        )
        citation = item["citation"]
        assert citation["ordinal"] == 1
        assert citation["role"] == "context"
        assert citation["target_ref"] == {"type": "content_chunk", "id": str(chunk_id)}
        assert citation["media_id"] == str(media_id)
        assert citation["locator"] is None
        assert citation["snapshot"] == {
            "title": "Chunk title",
            "excerpt": "chunk snippet",
            "section_label": "Section 1",
            "result_type": "content_chunk",
            # A content_chunk target is a finer grain than media, so it carries no
            # summary_md abstract (that enrichment is media-target-only); the strict
            # citation_index payload still serializes the field as null.
            "summary_md": None,
        }, f"CitationOut carries the chip display snapshot; got {citation['snapshot']}"
        assert citation["deep_link"] == "/media/deep-link"
        assert context_edge_count == 1, (
            "A cited local target must graduate into exactly one origin='citation' context edge"
        )
        reference_payload = next(row[1] for row in events if row[0] == "context_ref_added")
        assert reference_payload["resource_ref"] == f"content_chunk:{chunk_id}", (
            f"context_ref_added carries the context-ref target; got {reference_payload}"
        )
        assert reference_payload["citation_edge_id"] == str(edge_id)
        assert reference_payload["conversation_id"] == str(conversation_id)
        assert reference_payload["missing"] is False
        assert {"id", "label", "summary", "created_at"} <= set(reference_payload), (
            f"context_ref_added payload must match the ContextRefOut shape; got {reference_payload}"
        )

    def test_unselected_retrieval_mints_no_edge_and_no_events(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        from nexus.db.models import ChatRun as ChatRunModel
        from nexus.services.chat_run_citations import emit_citation_index, record_tool_citations

        (
            user_id,
            model_id,
            conversation_id,
            media_id,
            chunk_id,
            user_message_id,
            assistant_message_id,
        ) = self._setup_conversation(auth_client, direct_db)
        run_id = self._create_chat_run_row(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            model_id=model_id,
        )
        tool_call_id = self._seed_tool_call_with_chunk_row(
            direct_db,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            media_id=media_id,
            chunk_id=chunk_id,
            selected=False,
        )
        self._register_cleanups(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            media_id=media_id,
            run_id=run_id,
            tool_call_id=tool_call_id,
        )

        with direct_db.session() as session:
            run = session.get(ChatRunModel, run_id)
            assert run is not None
            next_ordinal = record_tool_citations(
                session, run=run, tool_call_id=tool_call_id, start_ordinal=1
            )
            assert next_ordinal == 1, "Unselected rows must not consume ordinals"
            emit_citation_index(session, run, "Answer.", emitter=ChatRunEventEmitter(session, run))
            session.commit()

        with direct_db.session() as session:
            edge_count = session.execute(
                text(
                    "SELECT COUNT(*) FROM resource_edges WHERE source_scheme = 'message' "
                    "AND source_id = :amid"
                ),
                {"amid": assistant_message_id},
            ).scalar_one()
            event_count = session.execute(
                text(
                    "SELECT COUNT(*) FROM chat_run_events WHERE run_id = :run_id "
                    "AND event_type IN ('citation_index', 'context_ref_added')"
                ),
                {"run_id": run_id},
            ).scalar_one()
            cited_edge_id = session.execute(
                text(
                    "SELECT cited_edge_id FROM message_retrievals "
                    "WHERE tool_call_id = :tool_call_id"
                ),
                {"tool_call_id": tool_call_id},
            ).scalar_one()
        assert edge_count == 0, "Unselected retrievals must not mint citation edges"
        assert event_count == 0, "No citations → no citation_index / context_ref_added events"
        assert cited_edge_id is None

    def test_citation_index_rejects_missing_assistant_marker(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        from nexus.db.models import ChatRun as ChatRunModel
        from nexus.services.chat_run_citations import emit_citation_index, record_tool_citations

        (
            user_id,
            model_id,
            conversation_id,
            media_id,
            chunk_id,
            user_message_id,
            assistant_message_id,
        ) = self._setup_conversation(auth_client, direct_db)
        run_id = self._create_chat_run_row(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            model_id=model_id,
        )
        tool_call_id = self._seed_tool_call_with_chunk_row(
            direct_db,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            media_id=media_id,
            chunk_id=chunk_id,
            selected=True,
        )
        self._register_cleanups(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            media_id=media_id,
            run_id=run_id,
            tool_call_id=tool_call_id,
        )

        with direct_db.session() as session:
            run = session.get(ChatRunModel, run_id)
            assert run is not None
            record_tool_citations(session, run=run, tool_call_id=tool_call_id, start_ordinal=1)
            with pytest.raises(InvalidRequestError, match=r"markers=\[\], citations=\[1\]"):
                emit_citation_index(
                    session,
                    run,
                    "Answer without marker.",
                    emitter=ChatRunEventEmitter(session, run),
                )
            session.rollback()

    def test_citation_index_prunes_uncited_selected_retrieval(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        from nexus.db.models import ChatRun as ChatRunModel
        from nexus.services.chat_run_citations import emit_citation_index, record_tool_citations

        (
            user_id,
            model_id,
            conversation_id,
            media_id,
            chunk_id,
            user_message_id,
            assistant_message_id,
        ) = self._setup_conversation(auth_client, direct_db)
        run_id = self._create_chat_run_row(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            model_id=model_id,
        )
        tool_call_id = self._seed_tool_call_with_chunk_row(
            direct_db,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            media_id=media_id,
            chunk_id=chunk_id,
            selected=True,
        )
        self._register_cleanups(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            media_id=media_id,
            run_id=run_id,
            tool_call_id=tool_call_id,
        )

        with direct_db.session() as session:
            session.execute(
                text(
                    """
                    INSERT INTO message_retrievals (
                        tool_call_id, ordinal, result_type, source_id, media_id,
                        scope, context_ref, result_ref, selected, source_title,
                        section_label, exact_snippet, deep_link, locator
                    )
                    SELECT
                        tool_call_id, 2, result_type, source_id, media_id,
                        scope, context_ref, result_ref, selected, source_title,
                        section_label, exact_snippet, deep_link, locator
                    FROM message_retrievals
                    WHERE tool_call_id = :tool_call_id AND ordinal = 1
                    """
                ),
                {"tool_call_id": tool_call_id},
            )
            run = session.get(ChatRunModel, run_id)
            assert run is not None
            assert (
                record_tool_citations(session, run=run, tool_call_id=tool_call_id, start_ordinal=1)
                == 3
            )
            emit_citation_index(
                session, run, "Answer [1].", emitter=ChatRunEventEmitter(session, run)
            )
            session.commit()

        with direct_db.session() as session:
            edge_ordinals = (
                session.execute(
                    text(
                        "SELECT ordinal FROM resource_edges WHERE source_scheme = 'message' "
                        "AND source_id = :assistant_message_id AND origin = 'citation' "
                        "ORDER BY ordinal"
                    ),
                    {"assistant_message_id": assistant_message_id},
                )
                .scalars()
                .all()
            )
            cited_edge_ids = session.execute(
                text(
                    "SELECT ordinal, cited_edge_id FROM message_retrievals "
                    "WHERE tool_call_id = :tool_call_id ORDER BY ordinal"
                ),
                {"tool_call_id": tool_call_id},
            ).fetchall()
            citation_payload = session.execute(
                text(
                    "SELECT payload FROM chat_run_events WHERE run_id = :run_id "
                    "AND event_type = 'citation_index'"
                ),
                {"run_id": run_id},
            ).scalar_one()

        assert edge_ordinals == [1]
        assert cited_edge_ids[0][1] is not None
        assert cited_edge_ids[1][1] is None
        assert [item["citation"]["ordinal"] for item in citation_payload["citations"]] == [1]

    def test_selected_uncitable_retrieval_is_unnumbered(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        from nexus.db.models import ChatRun as ChatRunModel
        from nexus.services.chat_run_citations import record_tool_citations

        (
            user_id,
            model_id,
            conversation_id,
            media_id,
            _chunk_id,
            user_message_id,
            assistant_message_id,
        ) = self._setup_conversation(auth_client, direct_db)
        run_id = self._create_chat_run_row(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            model_id=model_id,
        )
        tool_call_id = self._seed_tool_call_with_chunk_row(
            direct_db,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            media_id=media_id,
            chunk_id=uuid4(),
            selected=True,
        )
        self._register_cleanups(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            media_id=media_id,
            run_id=run_id,
            tool_call_id=tool_call_id,
        )

        with direct_db.session() as session:
            session.execute(
                text(
                    "UPDATE message_retrievals "
                    "SET result_ref = result_ref - 'citation_target' "
                    "WHERE tool_call_id = :tool_call_id"
                ),
                {"tool_call_id": tool_call_id},
            )
            run = session.get(ChatRunModel, run_id)
            assert run is not None
            next_ordinal = record_tool_citations(
                session, run=run, tool_call_id=tool_call_id, start_ordinal=4
            )
            session.commit()

        with direct_db.session() as session:
            edge_count = session.execute(
                text(
                    "SELECT COUNT(*) FROM resource_edges WHERE source_scheme = 'message' "
                    "AND source_id = :assistant_message_id AND origin = 'citation'"
                ),
                {"assistant_message_id": assistant_message_id},
            ).scalar_one()
            cited_edge_id = session.execute(
                text(
                    "SELECT cited_edge_id FROM message_retrievals "
                    "WHERE tool_call_id = :tool_call_id"
                ),
                {"tool_call_id": tool_call_id},
            ).scalar_one()

        assert next_ordinal == 4
        assert edge_count == 0
        assert cited_edge_id is None
        payload = json.loads(
            app_search_tool_output(
                SimpleNamespace(
                    selected_citations=[
                        SimpleNamespace(
                            citation_target=None,
                            title="Uncitable row",
                            snippet="Still visible",
                            result_type="conversation",
                            source_label=None,
                        )
                    ],
                    citations=[],
                    status="complete",
                    error_code=None,
                ),
                4,
            )
        )
        assert payload["results"] == [
            {
                "title": "Uncitable row",
                "snippet": "Still visible",
                "kind": "conversation",
                "source_label": None,
            }
        ]

    def test_emit_citation_index_streams_note_block_locator(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        from nexus.db.models import ChatRun as ChatRunModel
        from nexus.services.chat_run_citations import emit_citation_index

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        body = "Note citation body"
        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            user_message_id = create_test_message(session, conversation_id, 1, "user", "Ask")
            assistant_message_id = create_test_message(
                session,
                conversation_id,
                2,
                "assistant",
                "Answer [1].",
                parent_message_id=user_message_id,
            )
            note = NoteBlock(
                id=uuid4(),
                user_id=user_id,
                body_pm_json={
                    "type": "paragraph",
                    "content": [{"type": "text", "text": body}],
                },
                body_text=body,
            )
            session.add(note)
            session.flush()
            edge_id = uuid4()
            session.add(
                ResourceEdge(
                    id=edge_id,
                    user_id=user_id,
                    kind="context",
                    origin="citation",
                    source_scheme="message",
                    source_id=assistant_message_id,
                    target_scheme="note_block",
                    target_id=note.id,
                    ordinal=1,
                    snapshot={
                        "title": "Research note",
                        "excerpt": body,
                        "result_type": "note_block",
                        "deep_link": f"/notes/{note.id}",
                    },
                )
            )
            session.commit()
            note_block_id = note.id

        run_id = self._create_chat_run_row(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            model_id=model_id,
        )
        direct_db.register_cleanup("resource_edges", "user_id", user_id)
        direct_db.register_cleanup("note_blocks", "id", note_block_id)
        direct_db.register_cleanup("chat_run_events", "run_id", run_id)
        direct_db.register_cleanup("chat_runs", "id", run_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)

        with direct_db.session() as session:
            run = session.get(ChatRunModel, run_id)
            assert run is not None, "Test setup must persist the chat run row"
            emit_citation_index(
                session, run, "Answer [1].", emitter=ChatRunEventEmitter(session, run)
            )
            session.commit()

        with direct_db.session() as session:
            citation_payload = session.execute(
                text(
                    "SELECT payload FROM chat_run_events WHERE run_id = :run_id "
                    "AND event_type = 'citation_index'"
                ),
                {"run_id": run_id},
            ).scalar_one()

        assert "entries" not in citation_payload
        item = citation_payload["citations"][0]
        assert item["citation_edge_id"] == str(edge_id)
        citation = item["citation"]
        assert citation["ordinal"] == 1
        assert citation["role"] == "context"
        assert citation["target_ref"] == {"type": "note_block", "id": str(note_block_id)}
        assert citation["media_id"] is None
        assert citation["locator"] == {
            "type": "note_block_offsets",
            "block_id": str(note_block_id),
            "start_offset": 0,
            "end_offset": len(body),
        }
        assert citation["deep_link"] == f"/notes/{note_block_id}"
        assert citation["snapshot"]["title"] == "Research note"

    def test_web_search_citation_mints_external_snapshot(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        """Persisted web results get external_snapshot identities; cited rows
        point their citation edge at the selected snapshot, while external
        targets never graduate into conversation context (AC7 scope)."""
        from nexus.db.models import ChatRun as ChatRunModel
        from nexus.services.agent_tools.web_search import (
            WebSearchCitation,
            WebSearchRun,
            persist_web_search_run,
        )
        from nexus.services.chat_run_citations import emit_citation_index, record_tool_citations

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            user_message_id = create_test_message(session, conversation_id, 1, "user", "Ask")
            assistant_message_id = create_test_message(
                session,
                conversation_id,
                2,
                "assistant",
                "Web answer [1].",
                parent_message_id=user_message_id,
            )
        run_id = self._create_chat_run_row(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            model_id=model_id,
        )

        def web_citation(rank: int, *, selected: bool) -> WebSearchCitation:
            return WebSearchCitation(
                result_ref=f"web:result-{rank}",
                title=f"Web Result {rank}",
                url=f"https://example.com/{rank}",
                display_url=f"example.com/{rank}",
                snippet=f"Snippet {rank}",
                extra_snippets=(),
                published_at=None,
                source_name="Example",
                rank=rank,
                provider="brave",
                provider_request_id="req-1",
                selected=selected,
            )

        cited = web_citation(1, selected=True)
        uncited = web_citation(2, selected=False)
        web_run = WebSearchRun(
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            query_hash="sha-web",
            result_type="mixed",
            requested_freshness_days=None,
            requested_domains={"allowed": [], "blocked": []},
            citations=[cited, uncited],
            selected_citations=[cited],
            context_text="<web_search_result/>",
            context_chars=20,
            latency_ms=5,
            status="complete",
            tool_call_index=1,
        )
        with direct_db.session() as session:
            persist_web_search_run(session, web_run)
        tool_call_id = web_run.tool_call_id
        assert tool_call_id is not None
        direct_db.register_cleanup("resource_edges", "user_id", user_id)
        direct_db.register_cleanup("resource_external_snapshots", "user_id", user_id)
        direct_db.register_cleanup("message_retrievals", "tool_call_id", tool_call_id)
        direct_db.register_cleanup("message_tool_calls", "id", tool_call_id)
        direct_db.register_cleanup("chat_run_events", "run_id", run_id)
        direct_db.register_cleanup("chat_runs", "id", run_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)

        with direct_db.session() as session:
            run = session.get(ChatRunModel, run_id)
            assert run is not None
            next_ordinal = record_tool_citations(
                session, run=run, tool_call_id=tool_call_id, start_ordinal=1
            )
            assert next_ordinal == 2, "Only the selected web result consumes an ordinal"
            emit_citation_index(
                session, run, "Web answer [1].", emitter=ChatRunEventEmitter(session, run)
            )
            session.commit()

        with direct_db.session() as session:
            snapshots = (
                session.query(ResourceExternalSnapshot)
                .filter(ResourceExternalSnapshot.user_id == user_id)
                .order_by(ResourceExternalSnapshot.url.asc())
                .all()
            )
            assert len(snapshots) == 2, (
                f"Every persisted web result gets a searchable resource identity; "
                f"got {[(s.url, s.title) for s in snapshots]}"
            )
            snapshot = next(s for s in snapshots if s.url == "https://example.com/1")
            assert snapshot.provider == "brave"
            assert snapshot.url == "https://example.com/1"
            assert snapshot.title == "Web Result 1"
            assert snapshot.snippet == "Snippet 1"
            assert snapshot.source_snapshot["result_type"] == "web_result", (
                f"source_snapshot keeps the telemetry display payload; got "
                f"{snapshot.source_snapshot}"
            )
            assert snapshot.source_snapshot["source_id"] == str(snapshot.id)
            edge = (
                session.query(ResourceEdge)
                .filter(
                    ResourceEdge.source_scheme == "message",
                    ResourceEdge.source_id == assistant_message_id,
                )
                .one()
            )
            assert (edge.target_scheme, edge.target_id) == ("external_snapshot", snapshot.id), (
                f"The citation edge must target the minted snapshot; got "
                f"{edge.target_scheme}:{edge.target_id}"
            )
            assert edge.ordinal == 1
            cited_rows = session.execute(
                text(
                    "SELECT selected, source_id, cited_edge_id FROM message_retrievals "
                    "WHERE tool_call_id = :tool_call_id ORDER BY ordinal"
                ),
                {"tool_call_id": tool_call_id},
            ).fetchall()
            assert cited_rows[0] == (True, str(snapshot.id), edge.id), (
                f"Cited web row must point at its edge; got {cited_rows[0]}"
            )
            assert cited_rows[1][0] is False and cited_rows[1][2] is None, (
                f"Uncited web rows stay telemetry-only; got {cited_rows[1]}"
            )
            assert UUID(cited_rows[1][1]) == next(
                s.id for s in snapshots if s.url == "https://example.com/2"
            )
            context_edges = session.execute(
                text(
                    "SELECT COUNT(*) FROM resource_edges WHERE source_scheme = 'conversation' "
                    "AND source_id = :conversation_id"
                ),
                {"conversation_id": conversation_id},
            ).scalar_one()
            reference_events = session.execute(
                text(
                    "SELECT COUNT(*) FROM chat_run_events WHERE run_id = :run_id "
                    "AND event_type = 'context_ref_added'"
                ),
                {"run_id": run_id},
            ).scalar_one()
            citation_payload = session.execute(
                text(
                    "SELECT payload FROM chat_run_events WHERE run_id = :run_id "
                    "AND event_type = 'citation_index'"
                ),
                {"run_id": run_id},
            ).scalar_one()
        assert context_edges == 0, "external_snapshot targets never become conversation context"
        assert reference_events == 0
        citation = citation_payload["citations"][0]["citation"]
        assert citation["target_ref"]["type"] == "external_snapshot"
        assert citation["deep_link"] == "https://example.com/1"
        assert citation["snapshot"]["result_type"] == "web_result"

    def test_message_replay_builds_chips_and_trust_trail_from_edges_and_telemetry(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        """Reload keeps answer content text-only and rebuilds trust from durable rows."""
        from nexus.db.models import ChatRun as ChatRunModel
        from nexus.services.chat_run_citations import record_tool_citations
        from nexus.services.chat_run_message_blocks import message_document
        from nexus.services.message_trust_trails import build_assistant_trust_trail

        (
            user_id,
            model_id,
            conversation_id,
            media_id,
            chunk_id,
            user_message_id,
            assistant_message_id,
        ) = self._setup_conversation(auth_client, direct_db)
        run_id = self._create_chat_run_row(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            model_id=model_id,
        )
        tool_call_id = self._seed_tool_call_with_chunk_row(
            direct_db,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            media_id=media_id,
            chunk_id=chunk_id,
            selected=True,
        )
        self._register_cleanups(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            media_id=media_id,
            run_id=run_id,
            tool_call_id=tool_call_id,
        )

        with direct_db.session() as session:
            run = session.get(ChatRunModel, run_id)
            assert run is not None
            record_tool_citations(session, run=run, tool_call_id=tool_call_id, start_ordinal=1)
            session.commit()

        with direct_db.session() as session:
            document = message_document("assistant", "Answer [1].")
            trail = build_assistant_trust_trail(
                session,
                viewer_id=user_id,
                assistant_message_id=assistant_message_id,
            )

        assert document["blocks"] == [{"type": "text", "format": "markdown", "text": "Answer [1]."}]
        assert len(trail.tool_calls) == 1
        assert len(trail.tool_calls[0].retrievals) == 1
        retrieval = trail.tool_calls[0].retrievals[0]
        assert retrieval.result_type == "content_chunk"
        assert retrieval.citation_number == 1
        assert retrieval.cited_edge_id is not None
        assert len(trail.citations) == 1, f"Chips come from edges; got {trail.citations}"
        chip = trail.citations[0].citation
        assert chip.ordinal == 1
        assert chip.role == "context"
        assert chip.target_ref.type == "content_chunk"
        assert chip.target_ref.id == chunk_id
        assert chip.deep_link == "/media/deep-link"
        assert chip.snapshot is not None and chip.snapshot.title == "Chunk title", (
            f"Chip snapshot renders from the edge snapshot; got {chip.snapshot}"
        )

    def test_build_chat_run_response_rehydrates_assistant_citations(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        """The ChatRunResponse envelope carries the assistant message's chips.

        The FE reconcile() replaces the message on every stream completion, so a
        ChatRunResponse whose assistant_message.citations is empty would clobber
        the SSE-folded chips until a full reload. The envelope must rehydrate
        citations from edges exactly like list_messages does; the user message
        carries none.
        """
        from nexus.db.models import ChatRun as ChatRunModel
        from nexus.services.chat_run_citations import record_tool_citations
        from nexus.services.chat_run_response import build_chat_run_response

        (
            user_id,
            model_id,
            conversation_id,
            media_id,
            chunk_id,
            user_message_id,
            assistant_message_id,
        ) = self._setup_conversation(auth_client, direct_db)
        run_id = self._create_chat_run_row(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            model_id=model_id,
        )
        tool_call_id = self._seed_tool_call_with_chunk_row(
            direct_db,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            media_id=media_id,
            chunk_id=chunk_id,
            selected=True,
        )
        self._register_cleanups(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            media_id=media_id,
            run_id=run_id,
            tool_call_id=tool_call_id,
        )

        with direct_db.session() as session:
            run = session.get(ChatRunModel, run_id)
            assert run is not None
            record_tool_citations(session, run=run, tool_call_id=tool_call_id, start_ordinal=1)
            session.commit()

        with direct_db.session() as session:
            run = session.get(ChatRunModel, run_id)
            response = build_chat_run_response(session, user_id, run)
        assert [c.ordinal for c in response.assistant_message.citations] == [1], (
            "build_chat_run_response must rehydrate the assistant chips from edges; "
            f"got {response.assistant_message.citations}"
        )
        chip = response.assistant_message.citations[0]
        assert chip.target_ref.type == "content_chunk"
        assert chip.target_ref.id == chunk_id
        assert chip.snapshot is not None and chip.snapshot.title == "Chunk title"
        assert response.user_message.citations == [], (
            f"Only the assistant message carries citations; got {response.user_message.citations}"
        )

    def test_build_chat_run_response_folds_live_stream_state(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        from nexus.db.models import ChatRun as ChatRunModel
        from nexus.services.chat_run_event_store import append_run_event
        from nexus.services.chat_run_response import build_chat_run_response

        (
            user_id,
            model_id,
            conversation_id,
            media_id,
            _chunk_id,
            user_message_id,
            assistant_message_id,
        ) = self._setup_conversation(auth_client, direct_db)
        run_id = self._create_chat_run_row(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            model_id=model_id,
        )
        self._register_cleanups(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            media_id=media_id,
            run_id=run_id,
            tool_call_id=uuid4(),
        )

        with direct_db.session() as session:
            run = session.get(ChatRunModel, run_id)
            assert run is not None
            append_run_event(
                session,
                run,
                "assistant_activity",
                {
                    "assistant_message_id": str(assistant_message_id),
                    "phase": "tool_calling",
                    "label": "Searching",
                    "provider_event_seq_start": 1,
                    "provider_event_seq_end": 1,
                },
            )
            append_run_event(
                session,
                run,
                "assistant_text_delta",
                {
                    "assistant_message_id": str(assistant_message_id),
                    "text": "Live",
                    "provider_event_seq_start": 2,
                    "provider_event_seq_end": 2,
                },
            )
            append_run_event(
                session,
                run,
                "tool_call_start",
                {
                    "tool_call_id": None,
                    "assistant_message_id": str(assistant_message_id),
                    "tool_name": "app_search",
                    "tool_call_index": 1,
                    "provider_tool_call_id": "provider-tool-1",
                    "provider_event_seq_start": 3,
                    "provider_event_seq_end": 3,
                },
            )
            append_run_event(
                session,
                run,
                "tool_call_delta",
                {
                    "tool_call_id": None,
                    "assistant_message_id": str(assistant_message_id),
                    "tool_name": "app_search",
                    "tool_call_index": 1,
                    "provider_tool_call_id": "provider-tool-1",
                    "input_delta": '{"query":"ne',
                    "input_preview": '{"query":"nexus"}',
                    "provider_event_seq_start": 4,
                    "provider_event_seq_end": 4,
                },
            )
            session.commit()

        with direct_db.session() as session:
            run = session.get(ChatRunModel, run_id)
            assert run is not None
            response = build_chat_run_response(session, user_id, run)

        assert response.stream_state.folded_event_seq == 4
        assert response.stream_state.assistant_current_text == "Live"
        assert response.stream_state.activity is not None
        assert response.stream_state.activity.phase == "tool_calling"
        assert response.stream_state.activity.label == "Searching"
        assert len(response.stream_state.tool_calls) == 1
        tool = response.stream_state.tool_calls[0]
        assert tool.tool_name == "app_search"
        assert tool.tool_call_index == 1
        assert tool.status == "running"
        assert tool.input_preview == '{"query":"nexus"}'

    def test_messages_http_get_replays_assistant_citations_field_for_field(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        """P1 golden-message replay: GET messages over HTTP returns the seeded
        assistant message's citations[] field-for-field (n, kind, target,
        snapshot, and the media_id/locator render-contract fields)."""
        from nexus.db.models import ChatRun as ChatRunModel
        from nexus.services.chat_run_citations import record_tool_citations

        (
            user_id,
            model_id,
            conversation_id,
            media_id,
            chunk_id,
            user_message_id,
            assistant_message_id,
        ) = self._setup_conversation(auth_client, direct_db)
        run_id = self._create_chat_run_row(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            model_id=model_id,
        )
        tool_call_id = self._seed_tool_call_with_chunk_row(
            direct_db,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            media_id=media_id,
            chunk_id=chunk_id,
            selected=True,
        )
        self._register_cleanups(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            media_id=media_id,
            run_id=run_id,
            tool_call_id=tool_call_id,
        )

        with direct_db.session() as session:
            run = session.get(ChatRunModel, run_id)
            assert run is not None
            record_tool_citations(session, run=run, tool_call_id=tool_call_id, start_ordinal=1)
            session.commit()
        with direct_db.session() as session:
            evidence_span_id = session.execute(
                text("SELECT primary_evidence_span_id FROM content_chunks WHERE id = :id"),
                {"id": chunk_id},
            ).scalar_one()
            assert evidence_span_id is not None

        resp = auth_client.get(
            f"/conversations/{conversation_id}/messages",
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 200, resp.text
        messages = {m["id"]: m for m in resp.json()["data"]}
        assistant = messages[str(assistant_message_id)]
        assert assistant["citations"] == [
            {
                "ordinal": 1,
                "role": "context",
                "target_ref": {"type": "content_chunk", "id": str(chunk_id)},
                "activation": {
                    "resource_ref": f"content_chunk:{chunk_id}",
                    "kind": "route",
                    "href": f"/media/{media_id}#evidence-{evidence_span_id}",
                    "unresolved_reason": None,
                },
                # build_citation_outs reconstructs the in-reader jump from the
                # target: a content_chunk resolves to its parent media (media_id),
                # with no offset locator (D11). Spans add a locator; chunks do not.
                "media_id": str(media_id),
                "locator": None,
                "deep_link": "/media/deep-link",
                "snapshot": {
                    "title": "Chunk title",
                    "excerpt": "chunk snippet",
                    "section_label": "Section 1",
                    "result_type": "content_chunk",
                    # Only media-scheme targets carry the LLM summary_md abstract
                    # (reconstructed via get_ready_summaries); a content_chunk is a
                    # finer grain, so the rendered snapshot abstract is null.
                    "summary_md": None,
                },
            }
        ], f"GET messages must replay the citation field-for-field; got {assistant['citations']}"
        assert messages[str(user_message_id)]["citations"] == []

    def test_pruned_telemetry_deletes_paired_citation_edge_and_external_snapshot(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        """#4/#8: trimming an over-count telemetry row on re-execution deletes its
        citation edge AND the external_snapshot the edge orphaned — no phantom
        chip survives. Re-runs persist_web_search_run with FEWER results after a
        first run cited two web results."""
        from nexus.db.models import ChatRun as ChatRunModel
        from nexus.services.agent_tools.web_search import (
            WebSearchCitation,
            WebSearchRun,
            persist_web_search_run,
        )
        from nexus.services.chat_run_citations import record_tool_citations

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            user_message_id = create_test_message(session, conversation_id, 1, "user", "Ask")
            assistant_message_id = create_test_message(
                session,
                conversation_id,
                2,
                "assistant",
                "Web answer [1][2].",
                parent_message_id=user_message_id,
            )
        run_id = self._create_chat_run_row(
            direct_db,
            user_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            model_id=model_id,
        )

        def web_citation(rank: int) -> WebSearchCitation:
            return WebSearchCitation(
                result_ref=f"web:result-{rank}",
                title=f"Web Result {rank}",
                url=f"https://example.com/{rank}",
                display_url=f"example.com/{rank}",
                snippet=f"Snippet {rank}",
                extra_snippets=(),
                published_at=None,
                source_name="Example",
                rank=rank,
                provider="brave",
                provider_request_id="req-1",
                selected=True,
            )

        def web_run(citations: list[WebSearchCitation]) -> WebSearchRun:
            return WebSearchRun(
                conversation_id=conversation_id,
                user_message_id=user_message_id,
                assistant_message_id=assistant_message_id,
                query_hash="sha-web",
                result_type="mixed",
                requested_freshness_days=None,
                requested_domains={"allowed": [], "blocked": []},
                citations=citations,
                selected_citations=citations,
                context_text="<web_search_result/>",
                context_chars=20,
                latency_ms=5,
                status="complete",
                tool_call_index=1,
            )

        # Attempt 1: two cited web results → two edges, two snapshots.
        with direct_db.session() as session:
            persist_web_search_run(session, web_run([web_citation(1), web_citation(2)]))
        tool_call_id = self._tool_call_index_1_id(direct_db, assistant_message_id)
        direct_db.register_cleanup("resource_edges", "user_id", user_id)
        direct_db.register_cleanup("resource_external_snapshots", "user_id", user_id)
        direct_db.register_cleanup("message_retrievals", "tool_call_id", tool_call_id)
        direct_db.register_cleanup("message_tool_calls", "id", tool_call_id)
        direct_db.register_cleanup("chat_run_events", "run_id", run_id)
        direct_db.register_cleanup("chat_runs", "id", run_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)

        with direct_db.session() as session:
            run = session.get(ChatRunModel, run_id)
            assert run is not None
            next_ordinal = record_tool_citations(
                session, run=run, tool_call_id=tool_call_id, start_ordinal=1
            )
            assert next_ordinal == 3, "Two cited results consume ordinals 1 and 2"
            session.commit()

        with direct_db.session() as session:
            assert (
                session.query(ResourceEdge)
                .filter(ResourceEdge.source_id == assistant_message_id)
                .count()
                == 2
            )
            assert (
                session.query(ResourceExternalSnapshot)
                .filter(ResourceExternalSnapshot.user_id == user_id)
                .count()
                == 2
            )

        # Attempt 2 (re-execution): only ONE result this time. The writer prunes
        # the previous telemetry set first, so old citation edges and snapshots
        # die before the new selected row records its current edge.
        with direct_db.session() as session:
            persist_web_search_run(session, web_run([web_citation(1)]))
            run = session.get(ChatRunModel, run_id)
            assert run is not None
            next_ordinal = record_tool_citations(
                session, run=run, tool_call_id=tool_call_id, start_ordinal=1
            )
            assert next_ordinal == 2
            session.commit()

        with direct_db.session() as session:
            edges = (
                session.query(ResourceEdge)
                .filter(ResourceEdge.source_id == assistant_message_id)
                .all()
            )
            assert len(edges) == 1, (
                f"The trimmed row's phantom citation edge must be deleted; got "
                f"{[(e.ordinal, e.target_scheme) for e in edges]}"
            )
            snapshots = (
                session.query(ResourceExternalSnapshot)
                .filter(ResourceExternalSnapshot.user_id == user_id)
                .all()
            )
            assert len(snapshots) == 1, (
                f"The edge that was pruned orphaned its external_snapshot; it must be "
                f"deleted, leaving only the surviving citation's snapshot; got "
                f"{[s.url for s in snapshots]}"
            )
            assert (edges[0].target_scheme, edges[0].target_id) == (
                "external_snapshot",
                snapshots[0].id,
            ), "The surviving edge still points at the surviving snapshot"
            surviving_cited = session.execute(
                text(
                    "SELECT cited_edge_id FROM message_retrievals "
                    "WHERE tool_call_id = :tcid AND ordinal = 0"
                ),
                {"tcid": tool_call_id},
            ).scalar_one()
            assert surviving_cited == edges[0].id

    def _tool_call_index_1_id(
        self, direct_db: DirectSessionManager, assistant_message_id: UUID
    ) -> UUID:
        with direct_db.session() as session:
            return session.execute(
                text(
                    "SELECT id FROM message_tool_calls "
                    "WHERE assistant_message_id = :amid AND tool_call_index = 1"
                ),
                {"amid": assistant_message_id},
            ).scalar_one()
