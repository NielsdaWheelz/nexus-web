"""Backend contract tests for the OpenAI reasoning cutover."""

from uuid import UUID, uuid4

import pytest
from llm_calling.types import LLMChunk, LLMRequest, LLMUsage
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

from nexus.config import clear_settings_cache
from nexus.db.models import Model
from nexus.schemas.conversation import ChatRunCreateRequest, WebSearchOptions
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
    usage = LLMUsage(prompt_tokens=10, completion_tokens=25000, total_tokens=25010)
    provider_request_id = "resp_incomplete"
    status = "incomplete"
    incomplete_details = {"reason": "max_output_tokens"}


def test_openai_catalog_exposes_default_separate_from_none():
    metadata = get_model_catalog_metadata("openai", "gpt-5.5")

    assert metadata is not None
    assert metadata[3] == ["default", "none", "low", "medium", "high", "max"]


def test_chat_run_request_defaults_reasoning_to_default():
    request = ChatRunCreateRequest(
        content="Summarize this.",
        model_id=uuid4(),
        web_search=WebSearchOptions(mode="off"),
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


def _post_chat_run(auth_client, user_id: UUID, model_id: UUID, reasoning: str | None):
    payload = {
        "content": "Summarize the current notes.",
        "model_id": str(model_id),
        "key_mode": "auto",
        "conversation_scope": {"type": "general"},
        "contexts": [],
        "web_search": {"mode": "off"},
    }
    if reasoning is not None:
        payload["reasoning"] = reasoning

    return auth_client.post(
        "/chat-runs",
        headers={**auth_headers(user_id), "Idempotency-Key": f"reasoning-{uuid4()}"},
        json=payload,
    )


def _register_run_cleanup(
    direct_db: DirectSessionManager, run_id: UUID, conversation_id: UUID
) -> None:
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("chat_runs", "id", run_id)
    direct_db.register_cleanup("chat_run_events", "run_id", run_id)


@pytest.mark.integration
def test_omitted_reasoning_stores_explicit_default(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    _seed_ai_plus_billing(direct_db, user_id)
    with direct_db.session() as session:
        model_id = create_test_model(session)

    response = _post_chat_run(auth_client, user_id, model_id, reasoning=None)

    assert response.status_code == 200, (
        f"Expected omitted reasoning to default, got {response.status_code}: {response.text}"
    )
    data = response.json()["data"]
    assert data["run"]["reasoning"] == "default"

    _register_run_cleanup(direct_db, UUID(data["run"]["id"]), UUID(data["conversation"]["id"]))


@pytest.mark.integration
def test_unsupported_reasoning_mode_returns_actionable_400(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    _seed_ai_plus_billing(direct_db, user_id)
    with direct_db.session() as session:
        model_id = create_test_model(session)

    response = _post_chat_run(auth_client, user_id, model_id, reasoning="minimal")

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

    response = _post_chat_run(auth_client, user_id, model_id, reasoning="default")
    assert response.status_code == 200, f"Create failed: {response.text}"
    data = response.json()["data"]
    run_id = UUID(data["run"]["id"])
    conversation_id = UUID(data["conversation"]["id"])
    _register_run_cleanup(direct_db, run_id, conversation_id)

    router = _CapturingRouter(
        LLMChunk(
            delta_text="",
            done=True,
            usage=LLMUsage(prompt_tokens=10, completion_tokens=1, total_tokens=11),
            provider_request_id="resp_ok",
        )
    )
    with direct_db.session() as session:
        result = await execute_chat_run(
            session,
            run_id=run_id,
            llm_router=router,
            web_search_provider=None,
        )

    assert result == {"status": "complete"}
    assert router.request is not None, "Expected chat run to call the LLM router"
    assert router.request.reasoning_effort == "default"
    assert router.request.max_tokens == 25000


@pytest.mark.integration
async def test_incomplete_llm_result_finalizes_error_not_success(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    _seed_ai_plus_billing(direct_db, user_id)
    with direct_db.session() as session:
        model_id = create_test_model(session)

    response = _post_chat_run(auth_client, user_id, model_id, reasoning="medium")
    assert response.status_code == 200, f"Create failed: {response.text}"
    data = response.json()["data"]
    run_id = UUID(data["run"]["id"])
    conversation_id = UUID(data["conversation"]["id"])
    _register_run_cleanup(direct_db, run_id, conversation_id)

    with direct_db.session() as session:
        result = await execute_chat_run(
            session,
            run_id=run_id,
            llm_router=_CapturingRouter(_IncompleteChunk()),
            web_search_provider=None,
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
    assert "output tokens" in fetched_data["assistant_message"]["content"]
