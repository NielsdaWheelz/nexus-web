"""Integration tests for the durable chat-run HTTP contract."""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

from nexus.config import clear_settings_cache
from tests.factories import create_test_conversation, create_test_message, create_test_model
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
        pytest.skip(f"chat-runs schema not present yet: {', '.join(sorted(missing))}")


@pytest.fixture
def chat_runs_schema(engine: Engine) -> None:
    _require_chat_runs_schema(engine)


def _create_run_payload(model_id: UUID, **overrides) -> dict:
    payload = {
        "content": "Summarize the current notes.",
        "model_id": str(model_id),
        "reasoning": "none",
        "key_mode": "auto",
        "contexts": [],
        "web_search": {"mode": "off"},
    }
    if "conversation_id" not in overrides:
        payload["conversation_scope"] = {"type": "general"}
    payload.update(overrides)
    return payload


def _post_chat_run(auth_client, user_id: UUID, payload: dict, idempotency_key: str):
    return auth_client.post(
        "/chat-runs",
        headers={**auth_headers(user_id), "Idempotency-Key": idempotency_key},
        json=payload,
    )


def _seed_ai_plus_billing(direct_db: DirectSessionManager, user_id: UUID) -> None:
    with direct_db.session() as session:
        session.execute(
            text(
                """
                INSERT INTO billing_accounts (
                    id,
                    user_id,
                    plan_tier,
                    subscription_status,
                    current_period_start,
                    current_period_end,
                    created_at,
                    updated_at
                )
                VALUES (
                    gen_random_uuid(),
                    :user_id,
                    'ai_plus',
                    'active',
                    now(),
                    now() + interval '30 days',
                    now(),
                    now()
                )
                """
            ),
            {"user_id": user_id},
        )
        session.commit()
    direct_db.register_cleanup("billing_accounts", "user_id", user_id)


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


class TestChatRunCreate:
    def test_missing_idempotency_key_returns_400(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)

        response = auth_client.post(
            "/chat-runs",
            headers=auth_headers(user_id),
            json=_create_run_payload(model_id),
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

        response = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(model_id),
            idempotency_key="chat-run-new-conversation",
        )

        assert response.status_code == 200, (
            f"Expected chat run create to succeed, got {response.status_code}: {response.text}"
        )
        data = response.json()["data"]
        _assert_create_shape(data)

        run_id = UUID(data["run"]["id"])
        conversation_id = UUID(data["conversation"]["id"])
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

    def test_create_run_for_existing_conversation(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
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
            idempotency_key="chat-run-existing-conversation",
        )

        assert response.status_code == 200, (
            f"Expected existing-conversation run to succeed, got "
            f"{response.status_code}: {response.text}"
        )
        data = response.json()["data"]
        _assert_create_shape(data)
        assert data["conversation"]["id"] == str(conversation_id)

        run_id = UUID(data["run"]["id"])
        _register_run_cleanup(direct_db, run_id, conversation_id)

    def test_idempotency_replay_returns_same_run(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)
        payload = _create_run_payload(model_id)

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
        conversation_id = UUID(first_data["conversation"]["id"])
        _register_run_cleanup(direct_db, run_id, conversation_id)

    def test_idempotency_mismatch_returns_409(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        with direct_db.session() as session:
            model_id = create_test_model(session)

        first = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(model_id, content="First prompt"),
            "chat-run-mismatch",
        )
        second = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(model_id, content="Different prompt"),
            "chat-run-mismatch",
        )

        assert first.status_code == 200, f"Initial create failed: {first.text}"
        assert second.status_code == 409, (
            f"Expected idempotency mismatch 409, got {second.status_code}: {second.text}"
        )
        assert second.json()["error"]["code"] == "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH"

        first_data = first.json()["data"]
        run_id = UUID(first_data["run"]["id"])
        conversation_id = UUID(first_data["conversation"]["id"])
        _register_run_cleanup(direct_db, run_id, conversation_id)

    def test_conversation_busy_returns_409(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        run_id = uuid4()
        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            user_message_id = create_test_message(
                session, conversation_id=conversation_id, seq=1, role="user", content="Busy"
            )
            assistant_message_id = create_test_message(
                session,
                conversation_id=conversation_id,
                seq=2,
                role="assistant",
                content="",
                status="pending",
                model_id=model_id,
            )
            session.execute(
                text(
                    """
                    INSERT INTO chat_runs (
                        id, owner_user_id, conversation_id, user_message_id,
                        assistant_message_id, idempotency_key, payload_hash, status,
                        model_id, reasoning, key_mode, web_search
                    )
                    VALUES (
                        :id, :owner_user_id, :conversation_id, :user_message_id,
                        :assistant_message_id, :idempotency_key, :payload_hash, 'queued',
                        :model_id, 'none', 'auto', '{"mode": "off"}'::jsonb
                    )
                    """
                ),
                {
                    "id": run_id,
                    "owner_user_id": user_id,
                    "conversation_id": conversation_id,
                    "user_message_id": user_message_id,
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
            _create_run_payload(model_id, conversation_id=str(conversation_id)),
            idempotency_key="chat-run-busy",
        )

        assert response.status_code == 409, (
            f"Expected E_CONVERSATION_BUSY, got {response.status_code}: {response.text}"
        )
        assert response.json()["error"]["code"] == "E_CONVERSATION_BUSY"

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
            conversation_id = create_test_conversation(session, user_id)

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
            conversation_id = create_test_conversation(session, user_id)

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


class TestLegacySendRoutesRemoved:
    def test_old_json_send_routes_are_removed(self, auth_client, chat_runs_schema):
        user_id = create_test_user_id()

        new_conversation_response = auth_client.post(
            "/conversations/messages",
            headers=auth_headers(user_id),
            json={},
        )
        existing_conversation_response = auth_client.post(
            f"/conversations/{uuid4()}/messages",
            headers=auth_headers(user_id),
            json={},
        )

        assert new_conversation_response.status_code in (404, 405)
        assert existing_conversation_response.status_code in (404, 405)
