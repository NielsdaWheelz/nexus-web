"""Backend contract tests for OpenAI reasoning behavior."""

from uuid import UUID, uuid4

import httpx
import pytest
from llm_calling.types import LLMChunk, LLMRequest, LLMUsage
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

from nexus.config import clear_settings_cache
from nexus.db.models import Model
from nexus.schemas.conversation import ChatRunCreateRequest
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.chat_runs import (
    ERROR_CODE_TO_MESSAGE,
    _max_output_tokens_for_reasoning,
    execute_chat_run,
)
from nexus.services.models import get_model_catalog_metadata
from tests.factories import create_test_model
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager


class _CapturingRouter:
    def __init__(self, terminal_chunk):
        self.terminal_chunk = terminal_chunk
        self.request: LLMRequest | None = None

    async def generate_stream(self, provider, req, api_key, timeout_s):
        self.request = req
        yield self.terminal_chunk


class _IncompleteChunk:
    delta_text = ""
    done = True
    usage = LLMUsage(input_tokens=10, output_tokens=25000, total_tokens=25010)
    provider_request_id = "resp_incomplete"
    status = "incomplete"
    incomplete_details = {"reason": "max_output_tokens"}


class _UnreadStreamErrorRouter:
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code

    async def generate_stream(self, provider, req, api_key, timeout_s):
        request = httpx.Request("POST", "https://api.openai.com/v1/responses")
        response = httpx.Response(self.status_code, request=request)
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as status_error:
            error = httpx.ResponseNotRead()
            error.__context__ = status_error
            raise error from status_error
        raise AssertionError("Expected stream response to raise")
        yield


def test_openai_catalog_exposes_default_separate_from_none():
    metadata = get_model_catalog_metadata("openai", "gpt-5.5")

    assert metadata is not None
    assert metadata[3] == ["default", "none", "low", "medium", "high", "max"]


def test_chat_run_request_defaults_reasoning_to_default():
    request = ChatRunCreateRequest(
        conversation_id=uuid4(),
        content="Summarize this.",
        model_id=uuid4(),
    )

    assert request.reasoning == "default"


def test_output_token_budget_is_reasoning_aware():
    model = Model(
        provider="openai",
        model_name="gpt-5.5",
        max_context_tokens=400000,
        is_available=True,
    )

    assert _max_output_tokens_for_reasoning(model, "none") == 4096
    assert _max_output_tokens_for_reasoning(model, "default") == 25000
    assert _max_output_tokens_for_reasoning(model, "high") == 25000


def test_incomplete_error_message_is_actionable():
    message = ERROR_CODE_TO_MESSAGE["E_LLM_INCOMPLETE"]

    assert "less context" in message
    assert "lower reasoning" in message


@pytest.fixture
def chat_runs_schema(engine: Engine) -> None:
    tables = set(inspect(engine).get_table_names())
    missing = {"chat_runs", "chat_run_events"} - tables
    if missing:
        pytest.skip(f"chat-runs schema not present yet: {', '.join(sorted(missing))}")


@pytest.fixture(autouse=True)
def platform_key(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-platform-openai")
    clear_settings_cache()
    yield
    clear_settings_cache()


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
            reason="reasoning test access",
            actor_label="test",
        )


def _post_chat_run(
    auth_client,
    user_id: UUID,
    model_id: UUID,
    reasoning: str | None,
    conversation_id: UUID,
):
    payload = {
        "conversation_id": str(conversation_id),
        "content": "Summarize the current notes.",
        "model_id": str(model_id),
        "key_mode": "auto",
    }
    if reasoning is not None:
        payload["reasoning"] = reasoning

    return auth_client.post(
        "/chat-runs",
        headers={**auth_headers(user_id), "Idempotency-Key": f"reasoning-{uuid4()}"},
        json=payload,
    )


def _register_run_cleanup(direct_db: DirectSessionManager, conversation_id: UUID) -> None:
    # The "conversations"/"id" and "messages"/"conversation_id" cleanup branches
    # both cascade-delete every chat_runs child (chat_run_events,
    # source_manifests, chat_prompt_assemblies, assistant_message_* ledgers,
    # retrieval/rerank ledgers) keyed on the
    # conversation, then delete chat_runs itself. Registering a bare
    # "chat_runs"/"id" item instead deletes that row before those cascades run
    # (cleanup is LIFO), which trips chat_prompt_assemblies_chat_run_id_fkey.
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)


@pytest.mark.integration
def _create_conversation(auth_client, user_id: UUID) -> UUID:
    resp = auth_client.post("/conversations", headers=auth_headers(user_id))
    assert resp.status_code == 201, resp.text
    return UUID(resp.json()["data"]["id"])


def test_omitted_reasoning_stores_explicit_default(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    _seed_ai_plus_billing(direct_db, user_id)
    with direct_db.session() as session:
        model_id = create_test_model(session)
    conversation_id = _create_conversation(auth_client, user_id)

    response = _post_chat_run(
        auth_client, user_id, model_id, reasoning=None, conversation_id=conversation_id
    )

    assert response.status_code == 200, (
        f"Expected omitted reasoning to default, got {response.status_code}: {response.text}"
    )
    data = response.json()["data"]
    assert data["run"]["reasoning"] == "default"

    _register_run_cleanup(direct_db, conversation_id)


@pytest.mark.integration
def test_unsupported_reasoning_mode_returns_actionable_400(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    _seed_ai_plus_billing(direct_db, user_id)
    with direct_db.session() as session:
        model_id = create_test_model(session)
    conversation_id = _create_conversation(auth_client, user_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)

    response = _post_chat_run(
        auth_client,
        user_id,
        model_id,
        reasoning="minimal",
        conversation_id=conversation_id,
    )

    assert response.status_code == 400, (
        f"Expected unsupported reasoning to fail, got {response.status_code}: {response.text}"
    )
    assert response.json()["error"]["code"] == "E_INVALID_REQUEST"
    assert "minimal" in response.json()["error"]["message"]
    assert "openai/gpt-5.4-mini" in response.json()["error"]["message"]


@pytest.mark.integration
async def test_default_reasoning_uses_reasoning_aware_output_budget(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    _seed_ai_plus_billing(direct_db, user_id)
    with direct_db.session() as session:
        model_id = create_test_model(session)
    conversation_id = _create_conversation(auth_client, user_id)

    response = _post_chat_run(
        auth_client,
        user_id,
        model_id,
        reasoning="default",
        conversation_id=conversation_id,
    )
    assert response.status_code == 200, f"Create failed: {response.text}"
    data = response.json()["data"]
    run_id = UUID(data["run"]["id"])
    _register_run_cleanup(direct_db, conversation_id)

    router = _CapturingRouter(
        LLMChunk(
            delta_text="",
            done=True,
            usage=LLMUsage(input_tokens=10, output_tokens=1, total_tokens=11),
            provider_request_id="resp_ok",
        )
    )
    with direct_db.session() as session:
        result = await execute_chat_run(
            session,
            run_id=run_id,
            llm_router=router,
        )

    assert result == {"status": "complete"}
    assert router.request is not None, "Expected chat run to call the LLM router"
    assert router.request.reasoning_effort == "default"
    assert router.request.max_tokens == 25000
    with direct_db.session() as session:
        row = session.execute(
            text(
                """
                SELECT ml.input_tokens,
                       ml.output_tokens,
                       ml.cache_write_input_tokens,
                       ml.cache_read_input_tokens,
                       ml.provider_usage,
                       ml.prompt_plan_version,
                       ml.stable_prefix_hash AS message_stable_prefix_hash,
                       cpa.prompt_block_manifest,
                       cpa.stable_prefix_hash AS assembly_stable_prefix_hash
                FROM message_llm ml
                JOIN chat_prompt_assemblies cpa
                  ON cpa.assistant_message_id = ml.message_id
                WHERE ml.message_id = :message_id
                """
            ),
            {"message_id": UUID(data["assistant_message"]["id"])},
        ).first()

    assert row is not None, "Expected LLM metadata and prompt assembly rows"
    assert row.input_tokens == 10
    assert row.output_tokens == 1
    assert row.cache_write_input_tokens == 0
    assert row.cache_read_input_tokens == 0
    assert row.provider_usage["total_tokens"] == 11
    assert row.prompt_plan_version == "prompt-plan-v1"
    assert row.message_stable_prefix_hash == row.assembly_stable_prefix_hash
    assert "Summarize the current notes." not in str(row.prompt_block_manifest)


@pytest.mark.integration
async def test_incomplete_llm_result_finalizes_error_not_success(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    _seed_ai_plus_billing(direct_db, user_id)
    with direct_db.session() as session:
        model_id = create_test_model(session)
    conversation_id = _create_conversation(auth_client, user_id)

    response = _post_chat_run(
        auth_client,
        user_id,
        model_id,
        reasoning="medium",
        conversation_id=conversation_id,
    )
    assert response.status_code == 200, f"Create failed: {response.text}"
    data = response.json()["data"]
    run_id = UUID(data["run"]["id"])
    _register_run_cleanup(direct_db, conversation_id)

    with direct_db.session() as session:
        result = await execute_chat_run(
            session,
            run_id=run_id,
            llm_router=_CapturingRouter(_IncompleteChunk()),
        )

    assert result == {"status": "error", "error_code": "E_LLM_INCOMPLETE"}
    fetched = auth_client.get(f"/chat-runs/{run_id}", headers=auth_headers(user_id))
    assert fetched.status_code == 200, (
        f"Expected chat run fetch to succeed, got {fetched.status_code}: {fetched.text}"
    )
    fetched_data = fetched.json()["data"]
    assert fetched_data["run"]["status"] == "error"
    assert fetched_data["run"]["error_code"] == "E_LLM_INCOMPLETE"
    assert fetched_data["assistant_message"]["status"] == "error"
    assert fetched_data["assistant_message"]["error_code"] == "E_LLM_INCOMPLETE"
    assert (
        "output tokens"
        in fetched_data["assistant_message"]["message_document"]["blocks"][0]["text"]
    )


@pytest.mark.integration
@pytest.mark.parametrize(
    ("status_code", "expected_error_code"),
    [
        (401, "E_LLM_INVALID_KEY"),
        (429, "E_LLM_RATE_LIMIT"),
        (500, "E_LLM_PROVIDER_DOWN"),
    ],
)
async def test_unread_stream_http_errors_keep_provider_error_classification(
    auth_client,
    direct_db: DirectSessionManager,
    chat_runs_schema,
    status_code: int,
    expected_error_code: str,
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    _seed_ai_plus_billing(direct_db, user_id)
    with direct_db.session() as session:
        model_id = create_test_model(session)
    conversation_id = _create_conversation(auth_client, user_id)

    response = _post_chat_run(
        auth_client,
        user_id,
        model_id,
        reasoning="default",
        conversation_id=conversation_id,
    )
    assert response.status_code == 200, f"Create failed: {response.text}"
    data = response.json()["data"]
    run_id = UUID(data["run"]["id"])
    _register_run_cleanup(direct_db, conversation_id)

    with direct_db.session() as session:
        result = await execute_chat_run(
            session,
            run_id=run_id,
            llm_router=_UnreadStreamErrorRouter(status_code),
        )

    assert result == {"status": "error", "error_code": expected_error_code}
    fetched = auth_client.get(f"/chat-runs/{run_id}", headers=auth_headers(user_id))
    assert fetched.status_code == 200, (
        f"Expected chat run fetch to succeed, got {fetched.status_code}: {fetched.text}"
    )
    fetched_data = fetched.json()["data"]
    assert fetched_data["run"]["error_code"] == expected_error_code
    assert fetched_data["assistant_message"]["error_code"] == expected_error_code
