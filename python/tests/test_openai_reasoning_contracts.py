"""Backend contract tests for OpenAI reasoning behavior."""

import json
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from provider_runtime.errors import ModelCallError, ModelCallErrorCode
from provider_runtime.types import (
    ModelCall,
    ModelStreamEvent,
    ProviderArtifact,
    TokenUsage,
    ToolCall,
)
from pydantic import ValidationError
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

from nexus.config import clear_settings_cache
from nexus.db.models import ChatRun, Model
from nexus.llm_catalog import model_catalog_entry
from nexus.schemas.conversation import ChatRunCreateRequest
from nexus.services.agent_tools.app_search import APP_SEARCH_SELECTED_LIMIT
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.chat_run_finalize import MAX_ASSISTANT_CONTENT_LENGTH, TRUNCATION_NOTICE
from nexus.services.chat_runs import (
    ERROR_CODE_TO_MESSAGE,
    MAX_TOOL_ITERATIONS,
    _max_output_tokens_for_reasoning,
    execute_chat_run,
)
from nexus.services.message_trust_trails import build_assistant_trust_trail
from nexus.services.real_media_fixture_llm import RealMediaFixtureModelRuntime
from nexus.services.resource_graph.context import add_context_ref_without_commit
from nexus.services.resource_graph.refs import assert_resource_ref
from nexus.services.search.policy import APP_SEARCH_DEEP_CANDIDATE_LIMIT
from nexus.tasks.chat_run import chat_run
from tests.factories import (
    create_searchable_media,
    create_test_highlight,
    create_test_model,
    get_user_default_library,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.test_resource_graph_resolve import _make_pdf
from tests.utils.db import DirectSessionManager


class _CapturingRouter:
    def __init__(self, *events: ModelStreamEvent):
        self.events = events
        self.request: ModelCall | None = None

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        self.request = req
        for event in self.events:
            yield event


class _OversizedDeltaRouter:
    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        yield _text_event("x" * (MAX_ASSISTANT_CONTENT_LENGTH + 100))
        yield _done_event(
            usage=TokenUsage(input_tokens=10, output_tokens=50000, total_tokens=50010),
            provider_request_id="resp_after_local_truncation",
        )


def _text_event(text: str) -> ModelStreamEvent:
    return ModelStreamEvent(type="text_delta", provider="openai", model="gpt-5.5", text=text)


def _done_event(
    *,
    usage: TokenUsage | None = None,
    provider_request_id: str | None = None,
) -> ModelStreamEvent:
    return ModelStreamEvent(
        type="completed",
        provider="openai",
        model="gpt-5.5",
        usage=usage,
        provider_request_id=provider_request_id,
        status="completed",
    )


def _incomplete_chunk() -> ModelStreamEvent:
    return ModelStreamEvent(
        type="incomplete",
        provider="openai",
        model="gpt-5.5",
        usage=TokenUsage(input_tokens=10, output_tokens=25000, total_tokens=25010),
        provider_request_id="resp_incomplete",
        status="incomplete",
        incomplete_details={"reason": "max_output_tokens"},
    )


class _RecordingRateLimiter:
    def __init__(self) -> None:
        self.events: list[tuple[str, UUID, UUID | None, int | None]] = []

    def acquire_inflight_slot(self, user_id: UUID) -> None:
        self.events.append(("acquire_inflight_slot", user_id, None, None))

    def release_inflight_slot(self, user_id: UUID) -> None:
        self.events.append(("release_inflight_slot", user_id, None, None))

    def reserve_token_budget(
        self, user_id: UUID, reservation_id: UUID, est_tokens: int, ttl: int = 300
    ) -> None:
        self.events.append(("reserve_token_budget", user_id, reservation_id, est_tokens))

    def commit_token_budget(self, user_id: UUID, reservation_id: UUID, actual_tokens: int) -> None:
        self.events.append(("commit_token_budget", user_id, reservation_id, actual_tokens))

    def release_token_budget(self, user_id: UUID, reservation_id: UUID) -> None:
        self.events.append(("release_token_budget", user_id, reservation_id, None))

    def event_names(self) -> list[str]:
        return [event[0] for event in self.events]


class _ToolLoopRouter:
    """Two-iteration fake: reasoning items + a tool call, then the final answer."""

    def __init__(self) -> None:
        self.requests: list[ModelCall] = []

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        self.requests.append(req)
        if len(self.requests) == 1:
            yield ModelStreamEvent(
                type="provider_artifact",
                provider="openai",
                model="gpt-5.5",
                provider_artifact=ProviderArtifact(
                    provider="openai",
                    model="gpt-5.5",
                    purpose="reasoning",
                    payload={"type": "reasoning", "id": "rs_1"},
                ),
            )
            yield ModelStreamEvent(
                type="tool_call_start",
                provider="openai",
                model="gpt-5.5",
                tool_call_id="call-1",
                tool_name="mystery_tool",
            )
            yield ModelStreamEvent(
                type="tool_call_done",
                provider="openai",
                model="gpt-5.5",
                tool_call_id="call-1",
                tool_call=ToolCall(id="call-1", name="mystery_tool", arguments={}),
            )
            yield ModelStreamEvent(
                type="provider_artifact",
                provider="openai",
                model="gpt-5.5",
                provider_artifact=ProviderArtifact(
                    provider="openai",
                    model="gpt-5.5",
                    purpose="reasoning",
                    payload={"type": "reasoning", "id": "rs_2"},
                ),
            )
            yield _done_event(
                usage=TokenUsage(input_tokens=10, output_tokens=5, total_tokens=15),
                provider_request_id="resp_iter_1",
            )
            return
        yield _text_event("Final answer.")
        yield _done_event(
            usage=TokenUsage(input_tokens=20, output_tokens=3, total_tokens=23),
            provider_request_id="resp_iter_2",
        )


class _EndlessToolRouter:
    def __init__(self) -> None:
        self.requests: list[ModelCall] = []

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        self.requests.append(req)
        call = ToolCall(id=f"loop-call-{len(self.requests)}", name="mystery_tool", arguments={})
        yield ModelStreamEvent(
            type="tool_call_start",
            provider="openai",
            model="gpt-5.5",
            tool_call_id=call.id,
            tool_name=call.name,
        )
        yield ModelStreamEvent(
            type="tool_call_done",
            provider="openai",
            model="gpt-5.5",
            tool_call_id=call.id,
            tool_call=call,
        )
        yield _done_event(
            usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
            provider_request_id=f"resp_loop_{len(self.requests)}",
        )


class _OneUnknownToolRouter:
    def __init__(self) -> None:
        self.requests: list[ModelCall] = []

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        self.requests.append(req)
        if len(self.requests) == 1:
            call = ToolCall(id="oversized-tool", name="mystery_tool", arguments={})
            yield ModelStreamEvent(
                type="tool_call_start",
                provider="openai",
                model="gpt-5.5",
                tool_call_id=call.id,
                tool_name=call.name,
            )
            yield ModelStreamEvent(
                type="tool_call_done",
                provider="openai",
                model="gpt-5.5",
                tool_call_id=call.id,
                tool_call=call,
            )
            yield _done_event(
                usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
                provider_request_id="resp_tool_budget",
            )
            return
        yield _text_event("Final answer.")
        yield _done_event(
            usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
            provider_request_id="resp_after_budget",
        )


class _AppSearchRouter:
    def __init__(self, query: str) -> None:
        self.query = query
        self.requests: list[ModelCall] = []

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        self.requests.append(req)
        if len(self.requests) == 1:
            call = ToolCall(
                id="app-search-call",
                name="app_search",
                arguments={"query": self.query, "kinds": ["people"]},
            )
            yield ModelStreamEvent(
                type="tool_call_start",
                provider="openai",
                model="gpt-5.5",
                tool_call_id=call.id,
                tool_name=call.name,
            )
            yield ModelStreamEvent(
                type="tool_call_done",
                provider="openai",
                model="gpt-5.5",
                tool_call_id=call.id,
                tool_call=call,
            )
            yield _done_event(
                usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
                provider_request_id="resp_app_search",
            )
            return
        yield _text_event("Final answer.")
        yield _done_event(
            usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
            provider_request_id="resp_final",
        )


class _DecomposedAppSearchRouter:
    def __init__(self) -> None:
        self.requests: list[ModelCall] = []

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        self.requests.append(req)
        if len(self.requests) == 1:
            calls = (
                ToolCall(
                    id="decomposed-search-1",
                    name="app_search",
                    arguments={"query": f"decomposed theme search {uuid4().hex}"},
                ),
                ToolCall(
                    id="decomposed-search-2",
                    name="app_search",
                    arguments={"query": f"decomposed disagreement search {uuid4().hex}"},
                ),
            )
            for call in calls:
                yield ModelStreamEvent(
                    type="tool_call_start",
                    provider="openai",
                    model="gpt-5.5",
                    tool_call_id=call.id,
                    tool_name=call.name,
                )
                yield ModelStreamEvent(
                    type="tool_call_done",
                    provider="openai",
                    model="gpt-5.5",
                    tool_call_id=call.id,
                    tool_call=call,
                )
            yield _done_event(
                usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
                provider_request_id="resp_decomposed_searches",
            )
            return
        yield _text_event("Final answer.")
        yield _done_event(
            usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
            provider_request_id="resp_decomposed_final",
        )


class _LongContextAppSearchRouter:
    def __init__(self, media_id: UUID) -> None:
        self.media_id = media_id
        self.requests: list[ModelCall] = []

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        self.requests.append(req)
        if len(self.requests) == 1:
            call = ToolCall(
                id="long-context-app-search",
                name="app_search",
                arguments={
                    "query": "summarize whole Long Context Source",
                    "scopes": [f"media:{self.media_id}"],
                },
            )
            yield ModelStreamEvent(
                type="tool_call_start",
                provider="openai",
                model="gpt-5.5",
                tool_call_id=call.id,
                tool_name=call.name,
            )
            yield ModelStreamEvent(
                type="tool_call_done",
                provider="openai",
                model="gpt-5.5",
                tool_call_id=call.id,
                tool_call=call,
            )
            yield _done_event(
                usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
                provider_request_id="resp_long_context_search",
            )
            return
        payload = json.loads(req.messages[-1].tool_results[0].output)
        yield _text_event(f"Final answer [{payload['long_context']['n']}].")
        yield _done_event(
            usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
            provider_request_id="resp_long_context_final",
        )


class _LongContextThenAppSearchRouter:
    def __init__(self, media_id: UUID) -> None:
        self.media_id = media_id
        self.requests: list[ModelCall] = []

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        self.requests.append(req)
        if len(self.requests) == 1:
            calls = (
                ToolCall(
                    id="long-context-app-search",
                    name="app_search",
                    arguments={
                        "query": "summarize whole Long Context Source",
                        "scopes": [f"media:{self.media_id}"],
                    },
                ),
                ToolCall(
                    id="second-app-search",
                    name="app_search",
                    arguments={"query": f"follow-up search {uuid4().hex}"},
                ),
            )
            for call in calls:
                yield ModelStreamEvent(
                    type="tool_call_start",
                    provider="openai",
                    model="gpt-5.5",
                    tool_call_id=call.id,
                    tool_name=call.name,
                )
                yield ModelStreamEvent(
                    type="tool_call_done",
                    provider="openai",
                    model="gpt-5.5",
                    tool_call_id=call.id,
                    tool_call=call,
                )
            yield _done_event(
                usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
                provider_request_id="resp_long_context_then_search",
            )
            return
        payload = json.loads(req.messages[-1].tool_results[0].output)
        yield _text_event(f"Final answer [{payload['long_context']['n']}].")
        yield _done_event(
            usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
            provider_request_id="resp_long_context_then_search_final",
        )


class _AppSearchThenUnknownToolRouter:
    def __init__(self, media_id: UUID) -> None:
        self.media_id = media_id
        self.requests: list[ModelCall] = []

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        self.requests.append(req)
        if len(self.requests) == 1:
            calls = (
                ToolCall(
                    id="app-search-before-budget-failure",
                    name="app_search",
                    arguments={
                        "query": "searchable content",
                        "scopes": [f"media:{self.media_id}"],
                    },
                ),
                ToolCall(id="oversized-unknown-tool", name="mystery_tool", arguments={}),
            )
            for call in calls:
                yield ModelStreamEvent(
                    type="tool_call_start",
                    provider="openai",
                    model="gpt-5.5",
                    tool_call_id=call.id,
                    tool_name=call.name,
                )
                yield ModelStreamEvent(
                    type="tool_call_done",
                    provider="openai",
                    model="gpt-5.5",
                    tool_call_id=call.id,
                    tool_call=call,
                )
            yield _done_event(
                usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
                provider_request_id="resp_app_search_then_budget_failure",
            )
            return
        yield _text_event("Final answer.")
        yield _done_event(
            usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
            provider_request_id="resp_after_budget_failure",
        )


class _LongContextBodyOptionalRouter:
    def __init__(self, media_id: UUID) -> None:
        self.media_id = media_id
        self.requests: list[ModelCall] = []

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        self.requests.append(req)
        if len(self.requests) == 1:
            call = ToolCall(
                id="long-context-app-search",
                name="app_search",
                arguments={
                    "query": "summarize whole Long Context Source",
                    "scopes": [f"media:{self.media_id}"],
                },
            )
            yield ModelStreamEvent(
                type="tool_call_start",
                provider="openai",
                model="gpt-5.5",
                tool_call_id=call.id,
                tool_name=call.name,
            )
            yield ModelStreamEvent(
                type="tool_call_done",
                provider="openai",
                model="gpt-5.5",
                tool_call_id=call.id,
                tool_call=call,
            )
            yield _done_event(
                usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
                provider_request_id="resp_long_context_optional_body",
            )
            return
        payload = json.loads(req.messages[-1].tool_results[0].output)
        yield _text_event(f"Final answer saw {payload['long_context']['status']}.")
        yield _done_event(
            usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
            provider_request_id="resp_long_context_optional_final",
        )


class _RaisingStreamRouter:
    """Provider stream that raises before any terminal chunk."""

    def __init__(self, error: Exception) -> None:
        self.error = error

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        raise self.error
        yield  # pragma: no cover - makes this an async generator


class _CancellingStreamRouter:
    """Provider stream that sees a user cancel request before the first delta returns."""

    def __init__(self, direct_db: DirectSessionManager, run_id: UUID) -> None:
        self.direct_db = direct_db
        self.run_id = run_id

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        with self.direct_db.session() as session:
            session.execute(
                text(
                    "UPDATE chat_runs SET cancel_requested_at = now(), updated_at = now() "
                    "WHERE id = :run_id"
                ),
                {"run_id": self.run_id},
            )
            session.commit()
        yield _text_event("partial")
        yield _done_event(
            usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
            provider_request_id="resp_after_cancel",
        )


class _DocumentStackRouter:
    def __init__(self, media_id: UUID) -> None:
        self.media_id = media_id
        self.request_count = 0

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        self.request_count += 1
        if self.request_count == 1:
            call = ToolCall(
                id="inspect-call",
                name="inspect_resource",
                arguments={"uri": f"media:{self.media_id}"},
            )
            yield ModelStreamEvent(
                type="tool_call_start",
                provider="openai",
                model="gpt-5.5",
                tool_call_id=call.id,
                tool_name=call.name,
            )
            yield ModelStreamEvent(
                type="tool_call_done",
                provider="openai",
                model="gpt-5.5",
                tool_call_id=call.id,
                tool_call=call,
            )
            yield _done_event()
            return
        if self.request_count == 2:
            call = ToolCall(
                id="read-call",
                name="read_resource",
                arguments={"uri": f"page_range:{self.media_id}:1-1"},
            )
            yield ModelStreamEvent(
                type="tool_call_start",
                provider="openai",
                model="gpt-5.5",
                tool_call_id=call.id,
                tool_name=call.name,
            )
            yield ModelStreamEvent(
                type="tool_call_done",
                provider="openai",
                model="gpt-5.5",
                tool_call_id=call.id,
                tool_call=ToolCall(
                    id="read-call",
                    name="read_resource",
                    arguments={"uri": f"page_range:{self.media_id}:1-1"},
                ),
            )
            yield _done_event()
            return
        yield _text_event("Summary [1].")
        yield _done_event(
            usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
            provider_request_id="resp_doc_stack",
        )


def test_openai_catalog_exposes_default_separate_from_none():
    metadata = model_catalog_entry("openai", "gpt-5.5")

    assert metadata is not None
    assert list(metadata.reasoning_modes) == [
        "default",
        "none",
        "low",
        "medium",
        "high",
        "max",
    ]


def test_chat_run_request_requires_reasoning_and_key_mode():
    with pytest.raises(ValidationError) as info:
        ChatRunCreateRequest(
            conversation_id=uuid4(),
            content="Summarize this.",
            model_id=uuid4(),
        )

    missing_fields = {error["loc"][0] for error in info.value.errors()}
    assert {"reasoning", "key_mode"} <= missing_fields


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


def test_output_token_budget_uses_catalog_context_window_not_db_overlay():
    model = Model(
        provider="openai",
        model_name="gpt-5.4-mini",
        max_context_tokens=1,
        is_available=True,
    )

    assert _max_output_tokens_for_reasoning(model, "default") == 25000


def test_incomplete_error_message_is_actionable():
    message = ERROR_CODE_TO_MESSAGE["E_LLM_INCOMPLETE"]

    assert "less context" in message
    assert "lower reasoning" in message


def test_tool_loop_error_messages_are_actionable():
    assert "too many tool steps" in ERROR_CODE_TO_MESSAGE["E_LLM_TOOL_ITERATIONS_EXCEEDED"]
    assert "too much context" in ERROR_CODE_TO_MESSAGE["E_LLM_TOOL_OUTPUT_TOO_LARGE"]


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
    extra: dict | None = None,
):
    payload = {
        "conversation_id": str(conversation_id),
        "content": "Summarize the current notes.",
        "model_id": str(model_id),
        "key_mode": "auto",
    }
    if reasoning is not None:
        payload["reasoning"] = reasoning
    if extra:
        payload.update(extra)

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


def test_omitted_reasoning_is_rejected(
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

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    _register_run_cleanup(direct_db, conversation_id)


@pytest.mark.integration
def test_unsupported_reasoning_mode_returns_actionable_400(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    _seed_ai_plus_billing(direct_db, user_id)
    with direct_db.session() as session:
        model = (
            session.query(Model)
            .filter(
                Model.provider == "openai",
                Model.model_name == "gpt-5.5",
            )
            .first()
        )
        if model is None:
            model = Model(
                id=uuid4(),
                provider="openai",
                model_name="gpt-5.5",
                max_context_tokens=400000,
                is_available=True,
            )
            session.add(model)
        model.is_available = True
        session.commit()
        model_id = model.id
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
    assert "openai/gpt-5.5" in response.json()["error"]["message"]


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
        _done_event(
            usage=TokenUsage(input_tokens=10, output_tokens=1, total_tokens=11),
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
    assert router.request.reasoning.effort == "default"
    assert router.request.max_output_tokens == 25000
    # The usage ledger moved to llm_calls (written by llm_ledger at the call
    # sites, wired in the harness slice); only the prompt assembly pin remains.
    with direct_db.session() as session:
        row = session.execute(
            text(
                """
                SELECT prompt_block_manifest
                FROM chat_prompt_assemblies
                WHERE assistant_message_id = :message_id
                """
            ),
            {"message_id": UUID(data["assistant_message"]["id"])},
        ).first()

    assert row is not None, "Expected a prompt assembly row"
    assert "Summarize the current notes." not in str(row.prompt_block_manifest)


@pytest.mark.integration
async def test_attached_highlight_public_run_persists_citation_index_and_reader_selection(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    _seed_ai_plus_billing(direct_db, user_id)
    with direct_db.session() as session:
        model_id = create_test_model(session)
        media_id = create_searchable_media(session, user_id, title="Attached Source")
        fragment_id = session.execute(
            text("SELECT id FROM fragments WHERE media_id = :media_id ORDER BY idx LIMIT 1"),
            {"media_id": media_id},
        ).scalar_one()
        highlight_id = create_test_highlight(session, user_id, fragment_id, exact="selected words")
    conversation_id = _create_conversation(auth_client, user_id)
    with direct_db.session() as session:
        add_context_ref_without_commit(
            session,
            viewer_id=user_id,
            conversation_id=conversation_id,
            target=assert_resource_ref(f"highlight:{highlight_id}"),
            origin="user",
        )
        session.commit()
    selection_payload = {
        "media_id": str(media_id),
        "highlight_id": str(highlight_id),
        "exact": "selected words",
    }

    response = _post_chat_run(
        auth_client,
        user_id,
        model_id,
        reasoning="default",
        conversation_id=conversation_id,
        extra={"reader_selection": selection_payload},
    )
    assert response.status_code == 200, f"Create failed: {response.text}"
    data = response.json()["data"]
    run_id = UUID(data["run"]["id"])
    assistant_message_id = UUID(data["assistant_message"]["id"])
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("highlights", "id", highlight_id)
    direct_db.register_cleanup("highlight_fragment_anchors", "highlight_id", highlight_id)
    direct_db.register_cleanup("resource_edges", "user_id", user_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)

    with direct_db.session() as session:
        job_payload = session.execute(
            text(
                """
                SELECT payload
                FROM background_jobs
                WHERE payload->>'run_id' = :run_id
                """
            ),
            {"run_id": str(run_id)},
        ).scalar_one()
    assert job_payload == {"run_id": str(run_id)}

    router = _CapturingRouter(
        _text_event("Attached quote [1]."),
        _done_event(
            usage=TokenUsage(input_tokens=12, output_tokens=4, total_tokens=16),
            provider_request_id="resp_attached_quote",
        ),
    )
    with direct_db.session() as session:
        result = await execute_chat_run(
            session,
            run_id=run_id,
            llm_router=router,
        )

    assert result == {"status": "complete"}
    assert router.request is not None
    rendered_prompt = "\n".join(turn.content for turn in router.request.messages)
    assert "<reader_selection" in rendered_prompt
    assert "<exact>selected words</exact>" in rendered_prompt
    with direct_db.session() as session:
        row = session.execute(
            text(
                """
                SELECT mtc.tool_name, mtc.tool_call_index, mr.cited_edge_id, mr.result_ref
                FROM message_tool_calls mtc
                JOIN message_retrievals mr ON mr.tool_call_id = mtc.id
                WHERE mtc.assistant_message_id = :assistant_message_id
                  AND mtc.tool_name = 'attached_resources'
                """
            ),
            {"assistant_message_id": assistant_message_id},
        ).first()
        citation_event = session.execute(
            text(
                """
                SELECT payload
                FROM chat_run_events
                WHERE run_id = :run_id AND event_type = 'citation_index'
                LIMIT 1
                """
            ),
            {"run_id": run_id},
        ).scalar_one_or_none()
        edge_ordinal = session.execute(
            text(
                "SELECT ordinal FROM resource_edges "
                "WHERE id = :edge_id AND source_scheme = 'message' "
                "AND source_id = :assistant_message_id AND origin = 'citation'"
            ),
            {"edge_id": row.cited_edge_id, "assistant_message_id": assistant_message_id},
        ).scalar_one_or_none()

    assert row is not None
    assert row.tool_name == "attached_resources"
    assert row.tool_call_index == 0
    assert row.cited_edge_id is not None, "the attached citation row must point at its edge"
    assert edge_ordinal == 1, (
        f"The attached citation edge must exist with ordinal 1; got {edge_ordinal}"
    )
    assert row.result_ref["result_type"] == "highlight"
    assert isinstance(citation_event, dict)
    item = citation_event["citations"][0]
    assert item["citation"]["ordinal"] == 1
    assert item["citation_edge_id"] == str(row.cited_edge_id)
    assert item["citation"]["snapshot"]["result_type"] == "highlight"


@pytest.mark.integration
async def test_document_summary_trace_inspects_then_reads_map_pointer(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    _seed_ai_plus_billing(direct_db, user_id)
    with direct_db.session() as session:
        model_id = create_test_model(session)
        library_id = get_user_default_library(session, user_id)
        assert library_id is not None
        media_id = _make_pdf(session, library_id, pages=["PDF evidence page. "], title="Trace PDF")
    conversation_id = _create_conversation(auth_client, user_id)
    with direct_db.session() as session:
        add_context_ref_without_commit(
            session,
            viewer_id=user_id,
            conversation_id=conversation_id,
            target=assert_resource_ref(f"media:{media_id}"),
            origin="user",
        )
        session.commit()

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
    assistant_message_id = UUID(data["assistant_message"]["id"])
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)

    router = _DocumentStackRouter(media_id)
    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "complete"}
    assert router.request_count == 3
    with direct_db.session() as session:
        tool_rows = session.execute(
            text(
                """
                SELECT id, tool_name, tool_call_index, result_refs
                FROM message_tool_calls
                WHERE assistant_message_id = :assistant_message_id
                ORDER BY tool_call_index ASC
                """
            ),
            {"assistant_message_id": assistant_message_id},
        ).fetchall()
        retrieval_row = session.execute(
            text(
                """
                SELECT mr.result_type, mr.cited_edge_id, mr.result_ref
                FROM message_retrievals mr
                JOIN message_tool_calls mtc ON mtc.id = mr.tool_call_id
                WHERE mtc.assistant_message_id = :assistant_message_id
                  AND mtc.tool_name = 'read_resource'
                """
            ),
            {"assistant_message_id": assistant_message_id},
        ).first()
        citation_event = session.execute(
            text(
                """
                SELECT payload
                FROM chat_run_events
                WHERE run_id = :run_id AND event_type = 'citation_index'
                LIMIT 1
                """
            ),
            {"run_id": run_id},
        ).scalar_one_or_none()

    assert [(row[1], row[2]) for row in tool_rows] == [
        ("inspect_resource", 1),
        ("read_resource", 2),
    ]
    assert tool_rows[0][3][0]["uri"] == f"media:{media_id}"
    assert tool_rows[1][3][0]["uri"] == f"page_range:{media_id}:1-1"
    assert retrieval_row is not None
    assert retrieval_row[0] == "media"
    assert retrieval_row[1] is not None, "the cited read row must point at its citation edge"
    assert retrieval_row[2]["result_type"] == "media"
    assert isinstance(citation_event, dict)
    item = citation_event["citations"][0]
    assert item["citation"]["ordinal"] == 1
    assert item["citation_edge_id"] == str(retrieval_row[1])
    assert item["citation"]["target_ref"] == {
        "type": "media",
        "id": str(media_id),
    }
    assert item["citation"]["snapshot"]["result_type"] == "media"


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
            llm_router=_CapturingRouter(_incomplete_chunk()),
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
async def test_local_assistant_content_limit_finalizes_interrupted_and_ledgers_same_cause(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    run_id = _create_run_for_executor(auth_client, direct_db)

    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=_OversizedDeltaRouter())

    assert result == {"status": "error", "error_code": "E_LLM_INTERRUPTED"}

    with direct_db.session() as session:
        row = session.execute(
            text(
                """
                SELECT cr.status AS run_status, cr.error_code AS run_error_code,
                       cr.error_detail AS run_error_detail,
                       m.status AS message_status, m.error_code AS message_error_code,
                       m.content AS message_content
                FROM chat_runs cr
                JOIN messages m ON m.id = cr.assistant_message_id
                WHERE cr.id = :run_id
                """
            ),
            {"run_id": run_id},
        ).one()

    assert row.run_status == "error"
    assert row.run_error_code == "E_LLM_INTERRUPTED"
    assert row.run_error_detail == "stream abandoned after local assistant content limit"
    assert row.message_status == "error"
    assert row.message_error_code == "E_LLM_INTERRUPTED"
    assert row.message_content == ("x" * MAX_ASSISTANT_CONTENT_LENGTH) + TRUNCATION_NOTICE

    (call_row,) = _fetch_llm_calls(direct_db, run_id)
    assert call_row.error_class == "E_LLM_INTERRUPTED"
    assert call_row.error_detail == "stream abandoned after local assistant content limit"
    assert call_row.provider_request_id is None


def _create_run_for_executor(
    auth_client, direct_db: DirectSessionManager, *, reasoning: str = "default"
) -> UUID:
    """Create a run via the API and register cleanups (incl. its llm_calls rows)."""
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    _seed_ai_plus_billing(direct_db, user_id)
    with direct_db.session() as session:
        model_id = create_test_model(session)
    conversation_id = _create_conversation(auth_client, user_id)

    response = _post_chat_run(
        auth_client, user_id, model_id, reasoning=reasoning, conversation_id=conversation_id
    )
    assert response.status_code == 200, f"Create failed: {response.text}"
    run_id = UUID(response.json()["data"]["run"]["id"])
    _register_run_cleanup(direct_db, conversation_id)
    direct_db.register_cleanup("llm_calls", "owner_id", run_id)
    return run_id


def _create_run_with_context_media(
    auth_client, direct_db: DirectSessionManager, *, title: str = "Long Context Source"
) -> tuple[UUID, UUID]:
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    _seed_ai_plus_billing(direct_db, user_id)
    with direct_db.session() as session:
        model_id = create_test_model(session)
        media_id = create_searchable_media(session, user_id, title=title)
    conversation_id = _create_conversation(auth_client, user_id)
    with direct_db.session() as session:
        add_context_ref_without_commit(
            session,
            viewer_id=user_id,
            conversation_id=conversation_id,
            target=assert_resource_ref(f"media:{media_id}"),
            origin="user",
        )
        session.commit()

    response = _post_chat_run(
        auth_client,
        user_id,
        model_id,
        reasoning="default",
        conversation_id=conversation_id,
    )
    assert response.status_code == 200, f"Create failed: {response.text}"
    run_id = UUID(response.json()["data"]["run"]["id"])
    direct_db.register_cleanup("llm_calls", "owner_id", run_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    _register_run_cleanup(direct_db, conversation_id)
    return run_id, media_id


def _fetch_run_error(direct_db: DirectSessionManager, run_id: UUID):
    with direct_db.session() as session:
        return session.execute(
            text(
                """
                SELECT cr.status AS status, cr.error_code AS error_code,
                       cr.error_detail AS error_detail,
                       m.status AS message_status, m.error_code AS message_error_code
                FROM chat_runs cr
                JOIN messages m ON m.id = cr.assistant_message_id
                WHERE cr.id = :run_id
                """
            ),
            {"run_id": run_id},
        ).one()


def _fetch_llm_calls(direct_db: DirectSessionManager, run_id: UUID):
    with direct_db.session() as session:
        return session.execute(
            text(
                """
                SELECT call_seq, streaming, llm_operation, provider_request_id,
                       key_mode_requested, key_mode_used, error_class, error_detail
                FROM llm_calls
                WHERE owner_kind = 'chat_run' AND owner_id = :run_id
                ORDER BY call_seq ASC
                """
            ),
            {"run_id": run_id},
        ).fetchall()


def _fetch_done_event(direct_db: DirectSessionManager, run_id: UUID):
    with direct_db.session() as session:
        return session.execute(
            text(
                """
                SELECT payload
                FROM chat_run_events
                WHERE run_id = :run_id AND event_type = 'done'
                ORDER BY seq DESC
                LIMIT 1
                """
            ),
            {"run_id": run_id},
        ).scalar_one()


@pytest.mark.integration
async def test_tool_loop_replays_provider_artifacts_and_ledgers_each_iteration(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema, monkeypatch, log_sink
):
    run_id = _create_run_for_executor(auth_client, direct_db)
    rate_limiter = _RecordingRateLimiter()
    monkeypatch.setattr("nexus.services.chat_runs.get_rate_limiter", lambda: rate_limiter)

    router = _ToolLoopRouter()
    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "complete"}
    assert len(router.requests) == 2

    # S0: the captured provider items ride the assistant turn, in capture order,
    # ahead of the tool-results turn on the continuation request.
    assistant_turn, tool_turn = router.requests[1].messages[-2:]
    assert assistant_turn.role == "assistant"
    assert [artifact.payload for artifact in assistant_turn.provider_artifacts] == [
        {"type": "reasoning", "id": "rs_1"},
        {"type": "reasoning", "id": "rs_2"},
    ]
    assert [tc.id for tc in assistant_turn.tool_calls] == ["call-1"]
    assert tool_turn.role == "tool"

    # AC-3: a run with N tool iterations leaves N llm_calls rows, call_seq 1..N.
    rows = _fetch_llm_calls(direct_db, run_id)
    assert [(row.call_seq, row.provider_request_id) for row in rows] == [
        (1, "resp_iter_1"),
        (2, "resp_iter_2"),
    ]
    assert all(row.streaming for row in rows)
    assert all(row.llm_operation == "chat_send" for row in rows)
    assert all(row.key_mode_requested == "auto" for row in rows)
    assert all(row.key_mode_used == "platform" for row in rows)
    assert all(row.error_class is None for row in rows)
    assert rate_limiter.event_names() == [
        "acquire_inflight_slot",
        "reserve_token_budget",
        "commit_token_budget",
        "release_inflight_slot",
    ], f"unexpected envelope: {rate_limiter.events}"
    assert rate_limiter.events[2][3] == 38
    stream_logs = [event for event in log_sink if event.get("event") == "chat_run.stream.finished"]
    assert stream_logs == [
        {
            "event": "chat_run.stream.finished",
            "chat_run_id": str(run_id),
            "status": "complete",
            "error_code": None,
            "terminal_cause": "complete",
            "first_provider_event_ms": stream_logs[0]["first_provider_event_ms"],
            "first_visible_text_ms": stream_logs[0]["first_visible_text_ms"],
            "provider_event_count": 7,
            "durable_flush_count": 1,
            "cancel_latency_ms": None,
            "provider_request_id": "resp_iter_2",
            "provider_request_ids": ["resp_iter_1", "resp_iter_2"],
        }
    ]
    assert stream_logs[0]["first_provider_event_ms"] >= 0
    assert stream_logs[0]["first_visible_text_ms"] >= 0


@pytest.mark.integration
async def test_tool_loop_max_iterations_finalizes_typed_error(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema, log_sink
):
    run_id = _create_run_for_executor(auth_client, direct_db)
    router = _EndlessToolRouter()

    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "error", "error_code": "E_LLM_TOOL_ITERATIONS_EXCEEDED"}
    assert len(router.requests) == MAX_TOOL_ITERATIONS

    run_row = _fetch_run_error(direct_db, run_id)
    assert run_row.status == "error"
    assert run_row.error_code == "E_LLM_TOOL_ITERATIONS_EXCEEDED"
    assert run_row.message_status == "error"
    assert run_row.message_error_code == "E_LLM_TOOL_ITERATIONS_EXCEEDED"
    assert str(MAX_TOOL_ITERATIONS) in run_row.error_detail
    assert _fetch_done_event(direct_db, run_id)["error_code"] == "E_LLM_TOOL_ITERATIONS_EXCEEDED"

    rows = _fetch_llm_calls(direct_db, run_id)
    assert [(row.call_seq, row.provider_request_id) for row in rows] == [
        (index, f"resp_loop_{index}") for index in range(1, MAX_TOOL_ITERATIONS + 1)
    ]
    assert all(row.error_class is None for row in rows)
    stream_logs = [event for event in log_sink if event.get("event") == "chat_run.stream.finished"]
    assert stream_logs[-1]["status"] == "error"
    assert stream_logs[-1]["error_code"] == "E_LLM_TOOL_ITERATIONS_EXCEEDED"
    assert stream_logs[-1]["terminal_cause"] == "max_tool_iterations"


@pytest.mark.integration
async def test_tool_loop_enforces_aggregate_tool_output_budget_before_continuation(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema, monkeypatch
):
    run_id = _create_run_for_executor(auth_client, direct_db)
    router = _OneUnknownToolRouter()

    def fake_estimate_tokens(text: str) -> int:
        return 10**9 if "unknown tool" in text else 1

    monkeypatch.setattr("nexus.services.chat_runs.estimate_tokens", fake_estimate_tokens)
    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "error", "error_code": "E_LLM_TOOL_OUTPUT_TOO_LARGE"}
    assert len(router.requests) == 1
    run_row = _fetch_run_error(direct_db, run_id)
    assert run_row.status == "error"
    assert run_row.error_code == "E_LLM_TOOL_OUTPUT_TOO_LARGE"
    assert run_row.message_status == "error"
    assert run_row.message_error_code == "E_LLM_TOOL_OUTPUT_TOO_LARGE"
    assert "aggregate tool output budget exceeded" in run_row.error_detail
    assert _fetch_done_event(direct_db, run_id)["error_code"] == "E_LLM_TOOL_OUTPUT_TOO_LARGE"

    (call_row,) = _fetch_llm_calls(direct_db, run_id)
    assert call_row.provider_request_id == "resp_tool_budget"
    assert call_row.error_class is None


@pytest.mark.integration
async def test_tool_output_budget_marks_unforwarded_retrievals_not_in_prompt(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema, monkeypatch
):
    run_id, media_id = _create_run_with_context_media(auth_client, direct_db)
    router = _AppSearchThenUnknownToolRouter(media_id)

    def fake_estimate_tokens(text: str) -> int:
        return 10**9 if "unknown tool" in text else 1

    monkeypatch.setattr("nexus.services.chat_runs.estimate_tokens", fake_estimate_tokens)
    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "error", "error_code": "E_LLM_TOOL_OUTPUT_TOO_LARGE"}
    assert len(router.requests) == 1
    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        retrieval = session.execute(
            text(
                """
                SELECT COUNT(*) FILTER (WHERE mr.selected) AS selected_count,
                       COUNT(*) FILTER (WHERE mr.included_in_prompt) AS included_count,
                       COUNT(*) FILTER (WHERE mr.cited_edge_id IS NOT NULL) AS cited_count,
                       COUNT(*) FILTER (
                           WHERE mr.selected
                             AND mr.retrieval_status = 'excluded_by_budget'
                       ) AS selected_excluded_count
                FROM message_tool_calls mtc
                JOIN message_retrievals mr ON mr.tool_call_id = mtc.id
                WHERE mtc.assistant_message_id = :assistant_message_id
                  AND mtc.tool_name = 'app_search'
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).one()
        ledger = session.execute(
            text(
                """
                SELECT COUNT(*) FILTER (WHERE mcl.selected) AS selected_count,
                       COUNT(*) FILTER (WHERE mcl.included_in_prompt) AS included_count,
                       COUNT(*) FILTER (
                           WHERE mcl.selected
                             AND mcl.selection_status = 'excluded_by_budget'
                             AND mcl.selection_reason = 'tool_output_budget'
                       ) AS selected_excluded_count
                FROM message_tool_calls mtc
                JOIN message_retrieval_candidate_ledgers mcl ON mcl.tool_call_id = mtc.id
                WHERE mtc.assistant_message_id = :assistant_message_id
                  AND mtc.tool_name = 'app_search'
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).one()

    assert retrieval.selected_count > 0
    assert retrieval.included_count == 0
    assert retrieval.cited_count == 0
    assert retrieval.selected_excluded_count == retrieval.selected_count
    assert ledger.selected_count == retrieval.selected_count
    assert ledger.included_count == 0
    assert ledger.selected_excluded_count == ledger.selected_count


@pytest.mark.integration
async def test_app_search_policy_survives_chat_run_dispatch_and_trust_trail(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    run_id = _create_run_for_executor(auth_client, direct_db)
    query = f"chat run app search policy {uuid4().hex}"
    router = _AppSearchRouter(query)

    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "complete"}
    assert len(router.requests) == 2

    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        trail = build_assistant_trust_trail(
            session,
            viewer_id=run.owner_user_id,
            assistant_message_id=run.assistant_message_id,
        )

    tool = next(item for item in trail.tool_calls if item.tool_name == "app_search")
    assert tool.status == "complete"
    assert tool.selected_count <= APP_SEARCH_SELECTED_LIMIT
    assert len(tool.rerank_ledgers) == 1
    metadata = tool.rerank_ledgers[0].metadata
    assert metadata["candidate_limit"] == APP_SEARCH_DEEP_CANDIDATE_LIMIT
    assert metadata["selected_limit"] == APP_SEARCH_SELECTED_LIMIT
    assert metadata["retrieval_mode"] == "deep"
    assert metadata["policy_reason"] == "global_scope"
    assert metadata["context_route"] == "search_fetch_read"
    assert metadata["scope"] == "all"
    assert metadata["resolved_scopes"] == []


@pytest.mark.integration
async def test_decomposed_app_search_calls_persist_as_ordered_tool_calls(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    run_id = _create_run_for_executor(auth_client, direct_db)
    router = _DecomposedAppSearchRouter()

    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "complete"}
    assert len(router.requests) == 2
    assert [item.call_id for item in router.requests[1].messages[-1].tool_results] == [
        "decomposed-search-1",
        "decomposed-search-2",
    ]

    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        trail = build_assistant_trust_trail(
            session,
            viewer_id=run.owner_user_id,
            assistant_message_id=run.assistant_message_id,
        )
        rows = session.execute(
            text(
                """
                SELECT tool_call_index, tool_name, status
                FROM message_tool_calls
                WHERE assistant_message_id = :assistant_message_id
                ORDER BY tool_call_index
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).fetchall()
        trail = build_assistant_trust_trail(
            session,
            viewer_id=run.owner_user_id,
            assistant_message_id=run.assistant_message_id,
        )

    assert [(row.tool_call_index, row.tool_name, row.status) for row in rows] == [
        (1, "app_search", "complete"),
        (2, "app_search", "complete"),
    ]
    app_search_tools = [tool for tool in trail.tool_calls if tool.tool_name == "app_search"]
    assert len(app_search_tools) == 2
    assert all(len(tool.rerank_ledgers) == 1 for tool in app_search_tools)


@pytest.mark.integration
async def test_long_context_app_search_executes_private_read_path(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    run_id, media_id = _create_run_with_context_media(auth_client, direct_db)

    router = _LongContextAppSearchRouter(media_id)
    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "complete"}
    assert len(router.requests) == 2
    payload = json.loads(router.requests[1].messages[-1].tool_results[0].output)
    assert payload["long_context"]["status"] == "included"
    assert payload["long_context"]["uri"] == f"media:{media_id}"
    assert "canonical text for Long Context Source" in payload["long_context"]["body"]
    assert payload["long_context"]["n"] >= 1

    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        rows = session.execute(
            text(
                """
                SELECT mtc.tool_name, mr.result_type, mr.included_in_prompt,
                       mr.cited_edge_id IS NOT NULL AS cited
                FROM message_tool_calls mtc
                JOIN message_retrievals mr ON mr.tool_call_id = mtc.id
                WHERE mtc.assistant_message_id = :assistant_message_id
                ORDER BY mtc.tool_call_index, mr.ordinal
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).fetchall()
        trail = build_assistant_trust_trail(
            session,
            viewer_id=run.owner_user_id,
            assistant_message_id=run.assistant_message_id,
        )

    assert any(
        row.tool_name == "read_resource"
        and row.result_type == "media"
        and row.included_in_prompt
        and row.cited
        for row in rows
    )
    read_tool = next(tool for tool in trail.tool_calls if tool.tool_name == "read_resource")
    assert read_tool.more_candidates_available is False


@pytest.mark.integration
async def test_long_context_body_is_omitted_when_citation_materialization_fails(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema, monkeypatch
):
    run_id, media_id = _create_run_with_context_media(auth_client, direct_db)

    def missing_search_result(*args, **kwargs):
        del args, kwargs
        raise ValueError("citation target is gone")

    monkeypatch.setattr("nexus.services.chat_runs.get_search_result", missing_search_result)
    router = _LongContextBodyOptionalRouter(media_id)
    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "complete"}
    payload = json.loads(router.requests[1].messages[-1].tool_results[0].output)
    assert payload["long_context"]["status"] == "error"
    assert payload["long_context"]["error_code"] == "citation_unavailable"
    assert "body" not in payload["long_context"]
    assert "n" not in payload["long_context"]

    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        row = session.execute(
            text(
                """
                SELECT COUNT(*) AS trace_count,
                       COUNT(mr.id) AS retrieval_count
                FROM message_tool_calls mtc
                LEFT JOIN message_retrievals mr ON mr.tool_call_id = mtc.id
                WHERE mtc.assistant_message_id = :assistant_message_id
                  AND mtc.tool_name = 'read_resource'
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).one()

    assert row.trace_count == 1
    assert row.retrieval_count == 0


@pytest.mark.integration
async def test_long_context_non_full_read_returns_message_without_body_or_citation(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    run_id, media_id = _create_run_with_context_media(auth_client, direct_db)
    with direct_db.session() as session:
        session.execute(
            text("UPDATE fragments SET canonical_text = :body WHERE media_id = :media_id"),
            {"media_id": media_id, "body": "x" * 60_000},
        )
        session.commit()

    router = _LongContextBodyOptionalRouter(media_id)
    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "complete"}
    payload = json.loads(router.requests[1].messages[-1].tool_results[0].output)
    assert payload["long_context"]["status"] == "too_large"
    assert payload["long_context"]["kind"] == "too_large"
    assert "inspect_resource" in payload["long_context"]["message"]
    assert "body" not in payload["long_context"]
    assert "n" not in payload["long_context"]

    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        row = session.execute(
            text(
                """
                SELECT COUNT(*) AS trace_count,
                       COUNT(mr.id) AS retrieval_count
                FROM message_tool_calls mtc
                LEFT JOIN message_retrievals mr ON mr.tool_call_id = mtc.id
                WHERE mtc.assistant_message_id = :assistant_message_id
                  AND mtc.tool_name = 'read_resource'
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).one()

    assert row.trace_count == 1
    assert row.retrieval_count == 0


@pytest.mark.integration
async def test_long_context_internal_read_does_not_steal_provider_tool_index(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    run_id, media_id = _create_run_with_context_media(auth_client, direct_db)

    router = _LongContextThenAppSearchRouter(media_id)
    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "complete"}
    assert [item.call_id for item in router.requests[1].messages[-1].tool_results] == [
        "long-context-app-search",
        "second-app-search",
    ]
    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        rows = session.execute(
            text(
                """
                SELECT id, tool_call_index, tool_name
                FROM message_tool_calls
                WHERE assistant_message_id = :assistant_message_id
                ORDER BY tool_call_index
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).fetchall()
        events = (
            session.execute(
                text(
                    """
                SELECT payload
                FROM chat_run_events
                WHERE run_id = :run_id AND event_type = 'tool_call_done'
                ORDER BY seq
                """
                ),
                {"run_id": run_id},
            )
            .scalars()
            .all()
        )

    assert [(row.tool_call_index, row.tool_name) for row in rows] == [
        (1, "app_search"),
        (2, "app_search"),
        (3, "read_resource"),
    ]
    assert [
        (payload["provider_tool_call_id"], payload["tool_call_id"], payload["tool_call_index"])
        for payload in events
    ] == [
        ("long-context-app-search", str(rows[0].id), 1),
        ("second-app-search", str(rows[1].id), 2),
    ]


@pytest.mark.integration
async def test_long_context_app_search_budget_checks_final_payload(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema, monkeypatch
):
    run_id, media_id = _create_run_with_context_media(auth_client, direct_db)

    def fake_estimate_tokens(text: str) -> int:
        try:
            payload = json.loads(text)
        except ValueError:
            return 1
        if isinstance(payload, dict) and isinstance(payload.get("long_context"), dict):
            return 10**9 if "n" in payload["long_context"] else 1
        return 1

    monkeypatch.setattr("nexus.services.chat_runs.estimate_tokens", fake_estimate_tokens)
    router = _LongContextAppSearchRouter(media_id)
    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "error", "error_code": "E_LLM_TOOL_OUTPUT_TOO_LARGE"}
    assert len(router.requests) == 1
    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        read_trace_count = session.execute(
            text(
                """
                SELECT COUNT(*)
                FROM message_tool_calls
                WHERE assistant_message_id = :assistant_message_id
                  AND tool_name = 'read_resource'
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).scalar_one()

    assert read_trace_count == 0


@pytest.mark.integration
async def test_real_media_fixture_stream_tool_loop_completes(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    run_id = _create_run_for_executor(auth_client, direct_db)

    with direct_db.session() as session:
        result = await execute_chat_run(
            session,
            run_id=run_id,
            llm_router=RealMediaFixtureModelRuntime(),
        )

    assert result == {"status": "complete"}
    with direct_db.session() as session:
        row = session.execute(
            text(
                """
                SELECT cr.status AS run_status, m.content AS message_content
                FROM chat_runs cr
                JOIN messages m ON m.id = cr.assistant_message_id
                WHERE cr.id = :run_id
                """
            ),
            {"run_id": run_id},
        ).one()
    assert row.run_status == "complete"
    assert "The source says SOFIA" in row.message_content


@pytest.mark.integration
def test_worker_chat_run_uses_real_media_fixture_router(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema, monkeypatch
):
    run_id = _create_run_for_executor(auth_client, direct_db)
    monkeypatch.setenv("REAL_MEDIA_PROVIDER_FIXTURES", "1")
    monkeypatch.setenv(
        "REAL_MEDIA_FIXTURE_DIR",
        str(Path(__file__).parent / "fixtures" / "real_media"),
    )
    clear_settings_cache()

    try:
        result = chat_run(str(run_id))
    finally:
        clear_settings_cache()

    assert result == {"status": "complete"}
    with direct_db.session() as session:
        row = session.execute(
            text(
                """
                SELECT cr.status AS run_status, m.content AS message_content
                FROM chat_runs cr
                JOIN messages m ON m.id = cr.assistant_message_id
                WHERE cr.id = :run_id
                """
            ),
            {"run_id": run_id},
        ).one()
    assert row.run_status == "complete"
    assert "The source says SOFIA" in row.message_content


@pytest.mark.integration
async def test_llm_error_stamps_run_error_code_and_detail(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    run_id = _create_run_for_executor(auth_client, direct_db)

    router = _RaisingStreamRouter(
        ModelCallError(ModelCallErrorCode.RATE_LIMIT, "slow down", provider="openai")
    )
    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "error", "error_code": "E_LLM_RATE_LIMIT"}
    run_row = _fetch_run_error(direct_db, run_id)
    assert run_row.error_code == "E_LLM_RATE_LIMIT"
    assert run_row.error_detail == "ModelCallError: slow down"

    (call_row,) = _fetch_llm_calls(direct_db, run_id)
    assert call_row.error_class == "E_LLM_RATE_LIMIT"
    assert call_row.error_detail == "ModelCallError: slow down"


@pytest.mark.integration
async def test_cancelled_mid_stream_ledgers_abandoned_provider_call(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    run_id = _create_run_for_executor(auth_client, direct_db)

    router = _CancellingStreamRouter(direct_db, run_id)
    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "cancelled"}
    run_row = _fetch_run_error(direct_db, run_id)
    assert run_row.status == "cancelled"
    assert run_row.error_code == "E_CANCELLED"

    (call_row,) = _fetch_llm_calls(direct_db, run_id)
    assert call_row.error_class == "E_CANCELLED"
    assert call_row.error_detail == "chat run cancelled during provider stream"
    assert call_row.provider_request_id is None


@pytest.mark.integration
async def test_boundary_exception_finalizes_internal_with_detail_and_ledger_row(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    run_id = _create_run_for_executor(auth_client, direct_db)

    router = _RaisingStreamRouter(RuntimeError("stream socket exploded"))
    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "error", "error_code": "E_INTERNAL"}
    run_row = _fetch_run_error(direct_db, run_id)
    assert run_row.error_code == "E_INTERNAL"
    assert run_row.error_detail == "RuntimeError: stream socket exploded"

    # The stream wrapper ledgered the failed provider call before the boundary ran.
    (call_row,) = _fetch_llm_calls(direct_db, run_id)
    assert call_row.error_class == "RuntimeError"
    assert call_row.error_detail == "RuntimeError: stream socket exploded"
