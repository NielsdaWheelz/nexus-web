"""Integration tests for the durable chat-run HTTP contract."""

import hashlib
from uuid import UUID, uuid4

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

from nexus.config import clear_settings_cache
from nexus.db.models import ChatRun
from tests.factories import (
    create_searchable_media,
    create_test_conversation,
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


def _assistant_message_anchor(message_id: UUID) -> dict:
    return {"kind": "assistant_message", "message_id": str(message_id)}


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

    def test_create_run_for_existing_conversation_requires_parent(
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

        assert response.status_code == 400, (
            f"Expected existing-conversation run without parent to fail, got "
            f"{response.status_code}: {response.text}"
        )
        assert response.json()["error"]["code"] == "E_BRANCH_PATH_INVALID"
        direct_db.register_cleanup("conversations", "id", conversation_id)

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
                    web_search={"mode": "off"},
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

        first_payload = _create_run_payload(
            model_id,
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

        response = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(model_id),
            idempotency_key="chat-run-list-active",
        )

        assert response.status_code == 200, f"Create failed: {response.text}"
        created = response.json()["data"]
        run_id = UUID(created["run"]["id"])
        conversation_id = UUID(created["conversation"]["id"])
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

        response = _post_chat_run(
            auth_client,
            user_id,
            _create_run_payload(model_id),
            idempotency_key="chat-run-delete-conversation",
        )

        assert response.status_code == 200, f"Create failed: {response.text}"
        run_id = UUID(response.json()["data"]["run"]["id"])
        conversation_id = UUID(response.json()["data"]["conversation"]["id"])
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
