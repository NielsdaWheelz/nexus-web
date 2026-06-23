"""Backend contract tests for OpenAI reasoning behavior."""

import json
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from provider_runtime.errors import ModelCallError, ModelCallErrorCode
from provider_runtime.types import (
    ModelCall,
    ModelResponse,
    ModelStreamEvent,
    ProviderArtifact,
    TokenUsage,
    ToolCall,
)
from pydantic import ValidationError
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine
from web_search_tool.types import WebSearchRequest, WebSearchResponse, WebSearchResultItem

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
from nexus.services.prompt_budget import ContextBudgetError
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


class _PlanProbeRouter:
    def __init__(self, direct_db: DirectSessionManager, run_id: UUID) -> None:
        self.direct_db = direct_db
        self.run_id = run_id
        self.request: ModelCall | None = None
        self.plan_at_open = None

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del key, timeout_s, cancel
        self.request = req
        with self.direct_db.session() as session:
            self.plan_at_open = session.execute(
                text(
                    """
                    SELECT cr.retrieval_plan AS run_plan,
                           cpa.id AS prompt_assembly_id,
                           lc.call_status AS call_status,
                           lc.terminal_attempt_status AS terminal_attempt_status,
                           lc.provider_request_id AS provider_request_id
                    FROM chat_runs cr
                    JOIN chat_prompt_assemblies cpa ON cpa.chat_run_id = cr.id
                    JOIN llm_calls lc
                      ON lc.owner_kind = 'chat_run'
                     AND lc.owner_id = cr.id
                    WHERE cr.id = :run_id
                    """
                ),
                {"run_id": self.run_id},
            ).one()
        yield _done_event(
            usage=TokenUsage(input_tokens=10, output_tokens=1, total_tokens=11),
            provider_request_id="resp_plan_probe",
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


class _TwoUnknownToolBudgetRouter:
    def __init__(self) -> None:
        self.requests: list[ModelCall] = []

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        self.requests.append(req)
        if len(self.requests) == 1:
            calls = (
                ToolCall(id="first-budget-tool", name="first_budget_tool", arguments={}),
                ToolCall(id="second-pending-tool", name="second_pending_tool", arguments={}),
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
                provider_request_id="resp_two_tool_budget",
            )
            return
        yield _text_event("Final answer.")
        yield _done_event(
            usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
            provider_request_id="resp_after_two_tool_budget",
        )


class _DisallowedWebSearchRouter:
    def __init__(self) -> None:
        self.requests: list[ModelCall] = []

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        self.requests.append(req)
        if len(self.requests) == 1:
            call = ToolCall(
                id="blocked-web-search",
                name="web_search",
                arguments={"query": "current web news"},
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
                provider_request_id="resp_blocked_tool",
            )
            return
        payload = json.loads(req.messages[-1].tool_results[0].output)
        yield _text_event(f"Blocked {payload['tool_name']}.")
        yield _done_event(
            usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
            provider_request_id="resp_after_blocked_tool",
        )


class _PrivatePublicSameBatchRouter:
    def __init__(self) -> None:
        self.requests: list[ModelCall] = []

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        self.requests.append(req)
        if len(self.requests) == 1:
            calls = (
                ToolCall(id="mixed-app", name="app_search", arguments={"query": "saved notes"}),
                ToolCall(id="mixed-web", name="web_search", arguments={"query": "web news"}),
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
                provider_request_id="resp_source_batch_blocked",
            )
            return
        yield _text_event("Source policy blocked the mixed batch.")
        yield _done_event(
            usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
            provider_request_id="resp_after_source_batch_blocked",
        )


class _AppSearchThenWebSearchRouter:
    def __init__(self, media_id: UUID) -> None:
        self.media_id = media_id
        self.requests: list[ModelCall] = []

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        self.requests.append(req)
        if len(self.requests) == 1:
            call = ToolCall(
                id="private-first",
                name="app_search",
                arguments={
                    "query": "Source Boundary Private Notes",
                    "scopes": [f"media:{self.media_id}"],
                },
            )
        elif len(self.requests) == 2:
            call = ToolCall(id="public-second", name="web_search", arguments={"query": "news"})
        else:
            yield _text_event(f"Final answer {_citation_markers(req)}.")
            yield _done_event(
                usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
                provider_request_id="resp_after_later_web_block",
            )
            return
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
            provider_request_id=f"resp_{call.id}",
        )


class _ExplicitMixedRouter:
    def __init__(self, media_id: UUID) -> None:
        self.media_id = media_id
        self.requests: list[ModelCall] = []

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        self.requests.append(req)
        if len(self.requests) == 1:
            calls = (
                ToolCall(
                    id="explicit-app",
                    name="app_search",
                    arguments={
                        "query": "Source Boundary Private Notes",
                        "scopes": [f"media:{self.media_id}"],
                    },
                ),
                ToolCall(id="explicit-web", name="web_search", arguments={"query": "web news"}),
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
                provider_request_id="resp_explicit_mixed_tools",
            )
            return
        yield _text_event(f"Final mixed answer {_citation_markers(req)}.")
        yield _done_event(
            usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
            provider_request_id="resp_explicit_mixed_final",
        )


class _PublicWebOnlyRouter:
    def __init__(self) -> None:
        self.requests: list[ModelCall] = []

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        self.requests.append(req)
        if len(self.requests) == 1:
            call = ToolCall(id="public-web", name="web_search", arguments={"query": "AI news"})
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
                provider_request_id="resp_public_web_tool",
            )
            return
        yield _text_event(f"Public web answer {_citation_markers(req)}.")
        yield _done_event(
            usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
            provider_request_id="resp_public_web_final",
        )


class _WebSearchThenPrivateToolRouter:
    def __init__(self, tool_name: str, arguments: dict[str, str]) -> None:
        self.tool_name = tool_name
        self.arguments = arguments
        self.requests: list[ModelCall] = []

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        self.requests.append(req)
        if len(self.requests) == 1:
            call = ToolCall(id="public-first", name="web_search", arguments={"query": "AI news"})
        elif len(self.requests) == 2:
            call = ToolCall(id="private-second", name=self.tool_name, arguments=self.arguments)
        else:
            # The forwarded web_search result mints a citation edge; the final answer
            # must cite it, or the strict citation-marker invariant rejects the run.
            yield _text_event(f"Public source boundary answer. {_citation_markers(req)}")
            yield _done_event(
                usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
                provider_request_id="resp_after_public_private_block",
            )
            return
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
            provider_request_id=f"resp_{call.id}",
        )


class _StubWebSearchProvider:
    def __init__(self) -> None:
        self.requests: list[WebSearchRequest] = []

    async def search(self, request: WebSearchRequest) -> WebSearchResponse:
        self.requests.append(request)
        return WebSearchResponse(
            provider="stub",
            provider_request_id="stub-web-request",
            results=(
                WebSearchResultItem(
                    result_ref="stub:web:1",
                    title="Stub web result",
                    url="https://example.com/news",
                    display_url="example.com/news",
                    snippet="Current public context",
                    extra_snippets=(),
                    published_at=None,
                    source_name="Example",
                    rank=1,
                    provider="stub",
                    provider_request_id="stub-item-request",
                ),
            ),
        )


def _citation_markers(req) -> str:
    numbers: list[int] = []
    for message in req.messages:
        for result in getattr(message, "tool_results", ()) or ():
            try:
                payload = json.loads(result.output)
            except json.JSONDecodeError:
                continue
            for item in payload.get("results", []):
                n = item.get("n")
                if isinstance(n, int) and n not in numbers:
                    numbers.append(n)
            long_context = payload.get("long_context")
            if isinstance(long_context, dict):
                n = long_context.get("n")
                if isinstance(n, int) and n not in numbers:
                    numbers.append(n)
    return " ".join(f"[{number}]" for number in sorted(numbers))


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


class _BlankFilterAppSearchRouter:
    def __init__(self) -> None:
        self.requests: list[ModelCall] = []

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        self.requests.append(req)
        if len(self.requests) == 1:
            call = ToolCall(
                id="blank-filter-app-search",
                name="app_search",
                arguments={"query": "saved notes", "kinds": [" "]},
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
                provider_request_id="resp_blank_filter_app_search",
            )
            return
        payload = json.loads(req.messages[-1].tool_results[0].output)
        yield _text_event(f"Rejected {payload['error_code']}.")
        yield _done_event(
            usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
            provider_request_id="resp_after_blank_filter",
        )


class _ProviderRerankAppSearchRouter:
    def __init__(self, query: str, *, fail: bool = False, invalid_output: bool = False) -> None:
        self.query = query
        self.fail = fail
        self.invalid_output = invalid_output
        self.requests: list[ModelCall] = []
        self.generate_requests: list[ModelCall] = []

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del key, timeout_s, cancel
        self.requests.append(req)
        if len(self.requests) == 1:
            call = ToolCall(
                id="provider-rerank-app-search",
                name="app_search",
                arguments={"query": self.query},
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
                provider_request_id="resp_provider_rerank_search",
            )
            return
        yield _text_event(f"Final answer {_citation_markers(req)}.")
        yield _done_event(
            usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
            provider_request_id="resp_provider_rerank_final",
        )

    async def generate(self, req, *, key, timeout_s):
        del key, timeout_s
        self.generate_requests.append(req)
        if self.fail:
            raise ModelCallError(
                ModelCallErrorCode.TIMEOUT,
                "provider rerank timeout",
                provider_request_id="req_provider_rerank_timeout",
            )
        if self.invalid_output:
            return ModelResponse(
                text=json.dumps(
                    {
                        "version": "app_search_reranker.v1",
                        "ranked": [{"ordinal": 0, "score": 0.9, "reason": "direct_answer"}],
                    }
                ),
                usage=TokenUsage(input_tokens=17, output_tokens=11, total_tokens=28),
                provider_request_id=f"req_provider_rerank_invalid_{len(self.generate_requests)}",
            )
        count = sum(1 for line in req.messages[1].content.splitlines() if line.startswith("{"))
        return ModelResponse(
            text=json.dumps(
                {
                    "version": "app_search_reranker.v1",
                    "ranked": [
                        {
                            "ordinal": ordinal,
                            "score": round(max(0.1, 1 - ordinal * 0.01), 2),
                            "reason": "direct_answer" if ordinal == 0 else "supporting_context",
                        }
                        for ordinal in range(count)
                    ],
                }
            ),
            usage=TokenUsage(input_tokens=17, output_tokens=11, total_tokens=28),
            provider_request_id="req_provider_rerank_1",
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


class _WholeDocumentAppSearchRouter:
    def __init__(self, media_id: UUID) -> None:
        self.media_id = media_id
        self.requests: list[ModelCall] = []
        self.tool_payload: dict[str, Any] | None = None

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        self.requests.append(req)
        if len(self.requests) == 1:
            call = ToolCall(
                id="whole-document-app-search",
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
                provider_request_id="resp_whole_document_search",
            )
            return
        self.tool_payload = json.loads(req.messages[-1].tool_results[0].output)
        markers = _citation_markers(req)
        yield _text_event(f"Final answer {markers}".strip())
        yield _done_event(
            usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
            provider_request_id="resp_whole_document_final",
        )


class _DirectToolThenFinalRouter:
    def __init__(self, tool_name: str, media_id: UUID) -> None:
        self.tool_name = tool_name
        self.media_id = media_id
        self.requests: list[ModelCall] = []

    async def stream(self, req, *, key, timeout_s, cancel=None):
        del cancel
        self.requests.append(req)
        if len(self.requests) == 1:
            call = ToolCall(
                id=f"{self.tool_name}-before-final",
                name=self.tool_name,
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
            yield _done_event(
                usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
                provider_request_id="resp_read_before_cancel",
            )
            return
        yield _text_event("This continuation should not open.")
        yield _done_event(
            usage=TokenUsage(input_tokens=10, output_tokens=3, total_tokens=13),
            provider_request_id="resp_after_cancelled_read",
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
    assert [tool.name for tool in router.request.tools] == [
        "app_search",
        "inspect_resource",
        "read_resource",
    ]
    # The usage ledger moved to llm_calls (written by llm_ledger at the call
    # sites, wired in the harness slice); only the prompt assembly pin remains.
    with direct_db.session() as session:
        row = session.execute(
            text(
                """
                SELECT cpa.prompt_block_manifest, cr.retrieval_plan
                FROM chat_prompt_assemblies cpa
                JOIN chat_runs cr ON cr.id = cpa.chat_run_id
                WHERE cpa.assistant_message_id = :message_id
                """
            ),
            {"message_id": UUID(data["assistant_message"]["id"])},
        ).first()

    assert row is not None, "Expected a prompt assembly row"
    assert "Summarize the current notes." not in str(row.prompt_block_manifest)
    assert row.retrieval_plan["version"] == "chat_retrieval_plan.v1"
    assert row.retrieval_plan["route_intent"] == "private_app_search"
    assert row.retrieval_plan["allowed_tools"] == [
        "app_search",
        "inspect_resource",
        "read_resource",
    ]


@pytest.mark.integration
async def test_retrieval_plan_is_persisted_before_provider_stream_opens(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    run_id = _create_run_for_executor(auth_client, direct_db)
    router = _PlanProbeRouter(direct_db, run_id)

    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "complete"}
    assert router.request is not None
    assert router.plan_at_open is not None
    assert router.plan_at_open.prompt_assembly_id is not None
    assert router.plan_at_open.run_plan["version"] == "chat_retrieval_plan.v1"
    assert router.plan_at_open.run_plan["route_intent"] == "private_app_search"
    assert [tool.name for tool in router.request.tools] == router.plan_at_open.run_plan[
        "allowed_tools"
    ]
    assert router.plan_at_open.call_status == "started"
    assert router.plan_at_open.terminal_attempt_status == "started"
    assert router.plan_at_open.provider_request_id is None
    with direct_db.session() as session:
        events = session.execute(
            text(
                """
                SELECT event_type, payload
                FROM chat_run_events
                WHERE run_id = :run_id
                  AND event_type IN ('retrieval_plan', 'prompt_assembly')
                ORDER BY seq
                """
            ),
            {"run_id": run_id},
        ).all()
    assert [row.event_type for row in events] == ["retrieval_plan", "prompt_assembly"]
    assert events[0].payload["retrieval_plan"] == router.plan_at_open.run_plan


@pytest.mark.integration
async def test_retrieval_plan_persists_when_prompt_plan_budget_errors(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema, monkeypatch
):
    run_id = _create_run_for_executor(auth_client, direct_db)
    router = _CapturingRouter(_done_event(provider_request_id="should_not_open"))

    def fail_budget(*args, **kwargs):
        raise ContextBudgetError(
            "forced assembled prompt overflow",
            item_key="chat_retrieval_plan",
            requested_tokens=999,
            remaining_tokens=1,
        )

    monkeypatch.setattr(
        "nexus.services.context_assembler.validate_prompt_plan_budget",
        fail_budget,
    )

    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "error", "error_code": "E_LLM_CONTEXT_TOO_LARGE"}
    assert router.request is None
    assert _fetch_llm_calls(direct_db, run_id) == []
    error = _fetch_run_error(direct_db, run_id)
    assert error.status == "error"
    assert error.message_status == "error"
    assert error.error_code == "E_LLM_CONTEXT_TOO_LARGE"
    with direct_db.session() as session:
        row = session.execute(
            text(
                """
                SELECT cr.retrieval_plan, cpa.id AS prompt_assembly_id
                FROM chat_runs cr
                LEFT JOIN chat_prompt_assemblies cpa ON cpa.chat_run_id = cr.id
                WHERE cr.id = :run_id
                """
            ),
            {"run_id": run_id},
        ).one()
    assert row.prompt_assembly_id is None
    assert row.retrieval_plan["version"] == "chat_retrieval_plan.v1"
    assert row.retrieval_plan["route_intent"] == "private_app_search"
    assert row.retrieval_plan["allowed_tools"] == [
        "app_search",
        "inspect_resource",
        "read_resource",
    ]


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
    auth_client,
    direct_db: DirectSessionManager,
    *,
    reasoning: str = "default",
    content: str = "Summarize the current notes.",
) -> UUID:
    """Create a run via the API and register cleanups (incl. its llm_calls rows)."""
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
        reasoning=reasoning,
        conversation_id=conversation_id,
        extra={"content": content},
    )
    assert response.status_code == 200, f"Create failed: {response.text}"
    run_id = UUID(response.json()["data"]["run"]["id"])
    _register_run_cleanup(direct_db, conversation_id)
    direct_db.register_cleanup("llm_calls", "owner_id", run_id)
    return run_id


def _create_run_with_context_media(
    auth_client,
    direct_db: DirectSessionManager,
    *,
    title: str = "Long Context Source",
    content: str = "Summarize the current notes.",
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
        extra={"content": content},
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
async def test_tool_output_budget_persists_later_pending_tool_calls(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema, monkeypatch
):
    run_id = _create_run_for_executor(auth_client, direct_db)
    router = _TwoUnknownToolBudgetRouter()

    def fake_estimate_tokens(text: str) -> int:
        return 10**9 if "first_budget_tool" in text else 1

    monkeypatch.setattr("nexus.services.chat_runs.estimate_tokens", fake_estimate_tokens)
    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "error", "error_code": "E_LLM_TOOL_OUTPUT_TOO_LARGE"}
    assert len(router.requests) == 1
    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        rows = session.execute(
            text(
                """
                SELECT tool_call_index, tool_name, scope, status, error_code
                FROM message_tool_calls
                WHERE assistant_message_id = :assistant_message_id
                ORDER BY tool_call_index
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).fetchall()

    assert [(row.tool_call_index, row.tool_name, row.status, row.error_code) for row in rows] == [
        (1, "first_budget_tool", "error", "unknown_tool"),
        (2, "second_pending_tool", "error", "tool_output_budget_exhausted"),
    ]
    assert rows[1].scope == "tool_output_budget"


@pytest.mark.integration
async def test_disallowed_plan_tool_call_persists_error_without_execution(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    run_id = _create_run_for_executor(auth_client, direct_db)
    router = _DisallowedWebSearchRouter()

    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "complete"}
    assert len(router.requests) == 2
    assert [tool.name for tool in router.requests[0].tools] == [
        "app_search",
        "inspect_resource",
        "read_resource",
    ]
    payload = json.loads(router.requests[1].messages[-1].tool_results[0].output)
    assert payload == {
        "allowed_tools": ["app_search", "inspect_resource", "read_resource"],
        "blocked_tools": ["web_search"],
        "error": "tool_disallowed_by_retrieval_plan",
        "route_intent": "private_app_search",
        "tool_name": "web_search",
    }

    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        row = session.execute(
            text(
                """
                SELECT mtc.status, mtc.error_code, mtc.source_policy,
                       COUNT(mr.id) AS retrieval_count
                FROM message_tool_calls mtc
                LEFT JOIN message_retrievals mr ON mr.tool_call_id = mtc.id
                WHERE mtc.assistant_message_id = :assistant_message_id
                  AND mtc.tool_name = 'web_search'
                GROUP BY mtc.id, mtc.status, mtc.error_code, mtc.source_policy
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).one()
        ledger_count = session.execute(
            text(
                """
                SELECT COUNT(*)
                FROM message_tool_calls mtc
                LEFT JOIN message_retrieval_candidate_ledgers mcl ON mcl.tool_call_id = mtc.id
                LEFT JOIN message_rerank_ledgers mrl ON mrl.tool_call_id = mtc.id
                WHERE mtc.assistant_message_id = :assistant_message_id
                  AND mtc.tool_name = 'web_search'
                  AND (mcl.id IS NOT NULL OR mrl.id IS NOT NULL)
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).scalar_one()

    assert row.status == "error"
    assert row.error_code == "tool_disallowed_by_retrieval_plan"
    assert row.source_policy["decision"] == "blocked"
    assert row.source_policy["reason"] == "retrieval_plan_disallowed"
    assert row.retrieval_count == 0
    assert ledger_count == 0


@pytest.mark.integration
async def test_source_policy_blocks_same_batch_private_public_before_execution(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    run_id = _create_run_for_executor(
        auth_client,
        direct_db,
        content="What do my saved sources say about this?",
    )
    router = _PrivatePublicSameBatchRouter()

    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "complete"}
    assert len(router.requests) == 2
    payloads = [json.loads(item.output) for item in router.requests[1].messages[-1].tool_results]
    assert [payload["error"] for payload in payloads] == [
        "source_policy_blocked",
        "source_policy_blocked",
    ]

    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        rows = session.execute(
            text(
                """
                SELECT mtc.tool_name, mtc.status, mtc.error_code, mtc.source_domain,
                       mtc.source_policy, COUNT(mr.id) AS retrieval_count,
                       COUNT(mcl.id) AS candidate_count,
                       COUNT(mrl.id) AS rerank_count
                FROM message_tool_calls mtc
                LEFT JOIN message_retrievals mr ON mr.tool_call_id = mtc.id
                LEFT JOIN message_retrieval_candidate_ledgers mcl ON mcl.tool_call_id = mtc.id
                LEFT JOIN message_rerank_ledgers mrl ON mrl.tool_call_id = mtc.id
                WHERE mtc.assistant_message_id = :assistant_message_id
                GROUP BY mtc.id, mtc.tool_name, mtc.status, mtc.error_code,
                         mtc.source_domain, mtc.source_policy
                ORDER BY mtc.tool_call_index
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).fetchall()

    assert [(row.tool_name, row.status, row.error_code) for row in rows] == [
        ("app_search", "error", "source_policy_blocked"),
        ("web_search", "error", "source_policy_blocked"),
    ]
    assert [row.source_domain for row in rows] == ["private_app", "public_web"]
    assert all(
        row.source_policy["reason"] == "would_mix_private_app_with_public_web" for row in rows
    )
    assert all(row.retrieval_count == 0 for row in rows)
    assert all(row.candidate_count == 0 for row in rows)
    assert all(row.rerank_count == 0 for row in rows)


@pytest.mark.integration
async def test_blocked_source_policy_batch_persists_all_calls_before_budget_failure(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema, monkeypatch
):
    run_id = _create_run_for_executor(
        auth_client,
        direct_db,
        content="What do my saved sources say about this?",
    )
    router = _PrivatePublicSameBatchRouter()

    def fake_estimate_tokens(text: str) -> int:
        return 10**9 if "source_policy_blocked" in text else 1

    monkeypatch.setattr("nexus.services.chat_runs.estimate_tokens", fake_estimate_tokens)
    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "error", "error_code": "E_LLM_TOOL_OUTPUT_TOO_LARGE"}
    assert len(router.requests) == 1
    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        rows = session.execute(
            text(
                """
                SELECT tool_name, status, error_code
                FROM message_tool_calls
                WHERE assistant_message_id = :assistant_message_id
                ORDER BY tool_call_index
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).fetchall()

    assert [(row.tool_name, row.status, row.error_code) for row in rows] == [
        ("app_search", "error", "source_policy_blocked"),
        ("web_search", "error", "source_policy_blocked"),
    ]


@pytest.mark.integration
async def test_source_policy_blocks_later_web_after_forwarded_private_domain(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    run_id, media_id = _create_run_with_context_media(
        auth_client,
        direct_db,
        title="Source Boundary Private Notes",
        content="Search my saved notes for this topic.",
    )
    router = _AppSearchThenWebSearchRouter(media_id)

    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "complete"}
    assert len(router.requests) == 3
    payload = json.loads(router.requests[2].messages[-1].tool_results[0].output)
    assert payload["error"] == "source_policy_blocked"
    assert payload["source_policy"]["domains_seen"] == ["private_app"]
    assert payload["source_policy"]["requested_domains"] == ["public_web"]

    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        rows = session.execute(
            text(
                """
                SELECT tool_name, status, error_code, source_domain, source_policy
                FROM message_tool_calls
                WHERE assistant_message_id = :assistant_message_id
                ORDER BY tool_call_index
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).fetchall()

    assert [(row.tool_name, row.status, row.error_code) for row in rows] == [
        ("app_search", "complete", None),
        ("web_search", "error", "source_policy_blocked"),
    ]
    assert rows[0].source_domain == "private_app"
    assert rows[1].source_domain == "public_web"
    assert rows[1].source_policy["reason"] == "would_mix_private_app_with_public_web"


@pytest.mark.integration
@pytest.mark.parametrize(
    ("tool_name", "arguments"),
    [
        ("read_resource", {"uri": "media:11111111-1111-4111-8111-111111111111"}),
        ("inspect_resource", {"uri": "media:11111111-1111-4111-8111-111111111111"}),
    ],
)
async def test_source_policy_blocks_later_private_tool_after_forwarded_public_domain(
    auth_client,
    direct_db: DirectSessionManager,
    chat_runs_schema,
    tool_name: str,
    arguments: dict[str, str],
):
    run_id = _create_run_for_executor(
        auth_client,
        direct_db,
        content="Search the web for current AI news.",
    )
    router = _WebSearchThenPrivateToolRouter(tool_name, arguments)
    provider = _StubWebSearchProvider()

    with direct_db.session() as session:
        result = await execute_chat_run(
            session,
            run_id=run_id,
            llm_router=router,
            web_search_provider=provider,
        )

    assert result == {"status": "complete"}
    assert len(router.requests) == 3
    assert len(provider.requests) == 1
    payload = json.loads(router.requests[2].messages[-1].tool_results[0].output)
    assert payload["error"] == "source_policy_blocked"
    assert payload["source_policy"]["domains_seen"] == ["public_web"]
    assert payload["source_policy"]["requested_domains"] == ["private_app"]

    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        rows = session.execute(
            text(
                """
                SELECT mtc.tool_name, mtc.status, mtc.error_code, mtc.source_domain,
                       mtc.source_policy, COUNT(mr.id) AS retrieval_count,
                       COUNT(mr.cited_edge_id) AS cited_count,
                       COUNT(re.id) AS citation_edge_count
                FROM message_tool_calls mtc
                LEFT JOIN message_retrievals mr ON mr.tool_call_id = mtc.id
                LEFT JOIN resource_edges re ON re.id = mr.cited_edge_id
                WHERE mtc.assistant_message_id = :assistant_message_id
                GROUP BY mtc.id, mtc.tool_name, mtc.status, mtc.error_code,
                         mtc.source_domain, mtc.source_policy
                ORDER BY mtc.tool_call_index
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).fetchall()

    assert [(row.tool_name, row.status, row.error_code) for row in rows] == [
        ("web_search", "complete", None),
        (tool_name, "error", "source_policy_blocked"),
    ]
    assert [row.source_domain for row in rows] == ["public_web", "private_app"]
    assert rows[1].source_policy["reason"] == "would_mix_private_app_with_public_web"
    assert rows[1].retrieval_count == 0
    assert rows[1].cited_count == 0
    assert rows[1].citation_edge_count == 0


@pytest.mark.integration
async def test_explicit_mixed_source_prompt_allows_private_and_public_tools(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    run_id, media_id = _create_run_with_context_media(
        auth_client,
        direct_db,
        title="Source Boundary Private Notes",
        content="Compare my saved notes against web news.",
    )
    router = _ExplicitMixedRouter(media_id)
    provider = _StubWebSearchProvider()

    with direct_db.session() as session:
        result = await execute_chat_run(
            session,
            run_id=run_id,
            llm_router=router,
            web_search_provider=provider,
        )

    assert result == {"status": "complete"}
    assert len(router.requests) == 2
    assert len(provider.requests) == 1

    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        rows = session.execute(
            text(
                """
                SELECT tool_name, status, error_code, source_domain, source_policy
                FROM message_tool_calls
                WHERE assistant_message_id = :assistant_message_id
                  AND tool_name IN ('app_search', 'web_search')
                ORDER BY tool_call_index
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).fetchall()

    assert [(row.tool_name, row.status, row.error_code) for row in rows] == [
        ("app_search", "complete", None),
        ("web_search", "complete", None),
    ]
    assert [row.source_domain for row in rows] == ["private_app", "public_web"]
    assert all(row.source_policy["mixing_allowed"] for row in rows)
    assert all(
        row.source_policy["reason"] == "explicit_saved_source_web_comparison" for row in rows
    )


@pytest.mark.integration
async def test_public_web_route_with_attached_context_does_not_forward_private_context(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    run_id, media_id = _create_run_with_context_media(
        auth_client,
        direct_db,
        title="Private Context Should Stay Out",
        content="Search the web for AI news.",
    )
    router = _PublicWebOnlyRouter()
    provider = _StubWebSearchProvider()

    with direct_db.session() as session:
        result = await execute_chat_run(
            session,
            run_id=run_id,
            llm_router=router,
            web_search_provider=provider,
        )

    assert result == {"status": "complete"}
    assert [tool.name for tool in router.requests[0].tools] == ["web_search"]
    assert len(provider.requests) == 1
    assert all(
        str(media_id) not in turn.content and "Private Context Should Stay Out" not in turn.content
        for turn in router.requests[0].messages
        if turn.content is not None
    )

    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        assembly = session.execute(
            text(
                """
                SELECT cr.retrieval_plan, cpa.included_context_refs, cpa.prompt_block_manifest
                FROM chat_prompt_assemblies cpa
                JOIN chat_runs cr ON cr.id = cpa.chat_run_id
                WHERE cpa.chat_run_id = :run_id
                """
            ),
            {"run_id": run_id},
        ).one()
        rows = session.execute(
            text(
                """
                SELECT tool_name, status, error_code, source_domain, source_policy
                FROM message_tool_calls
                WHERE assistant_message_id = :assistant_message_id
                ORDER BY tool_call_index
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).fetchall()

    assert assembly.retrieval_plan["route_intent"] == "public_web_search"
    assert assembly.retrieval_plan["source_domain"] == "public_web"
    assert assembly.retrieval_plan["allowed_tools"] == ["web_search"]
    assert assembly.included_context_refs == []
    assert str(media_id) not in json.dumps(assembly.prompt_block_manifest, default=str)
    assert [(row.tool_name, row.status, row.error_code) for row in rows] == [
        ("web_search", "complete", None)
    ]
    assert rows[0].source_domain == "public_web"
    assert rows[0].source_policy["reason"] == "single_domain_public_web"


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
                SELECT COUNT(*) AS row_count,
                       COUNT(*) FILTER (WHERE mr.selected) AS selected_count,
                       COUNT(*) FILTER (WHERE mr.included_in_prompt) AS included_count,
                       COUNT(*) FILTER (WHERE mr.cited_edge_id IS NOT NULL) AS cited_count,
                       COUNT(*) FILTER (
                           WHERE NOT mr.selected
                             AND mr.retrieval_status = 'excluded_by_budget'
                       ) AS excluded_count
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
                SELECT COUNT(*) AS row_count,
                       COUNT(*) FILTER (WHERE mcl.selected) AS selected_count,
                       COUNT(*) FILTER (WHERE mcl.included_in_prompt) AS included_count,
                       COUNT(*) FILTER (
                           WHERE NOT mcl.selected
                             AND mcl.selection_status = 'excluded_by_budget'
                             AND mcl.selection_reason = 'tool_output_budget'
                       ) AS excluded_count
                FROM message_tool_calls mtc
                JOIN message_retrieval_candidate_ledgers mcl ON mcl.tool_call_id = mtc.id
                WHERE mtc.assistant_message_id = :assistant_message_id
                  AND mtc.tool_name = 'app_search'
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).one()
        app_search_events = session.execute(
            text(
                """
                SELECT payload
                FROM chat_run_events
                WHERE run_id = :run_id
                  AND event_type = 'tool_result'
                  AND payload->>'tool_name' = 'app_search'
                ORDER BY seq
                """
            ),
            {"run_id": run.id},
        ).fetchall()

    assert retrieval.row_count > 0
    assert retrieval.selected_count == 0
    assert retrieval.included_count == 0
    assert retrieval.cited_count == 0
    assert retrieval.excluded_count == retrieval.row_count
    assert ledger.row_count == retrieval.row_count
    assert ledger.selected_count == 0
    assert ledger.included_count == 0
    assert ledger.excluded_count == ledger.row_count
    complete_events = [
        row.payload for row in app_search_events if row.payload["status"] == "complete"
    ]
    assert len(complete_events) == 1
    assert complete_events[0]["result_count"] == 0
    assert complete_events[0]["selected_count"] == 0
    assert complete_events[0]["results"] == []
    assert complete_events[0]["more_candidates_available"] is False


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
async def test_app_search_dispatch_rejects_blank_filter_tokens(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    run_id = _create_run_for_executor(auth_client, direct_db)
    router = _BlankFilterAppSearchRouter()

    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "complete"}
    assert len(router.requests) == 2
    payload = json.loads(router.requests[1].messages[-1].tool_results[0].output)
    assert payload["error_code"] == "E_INVALID_REQUEST"
    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        row = session.execute(
            text(
                """
                SELECT status, error_code
                FROM message_tool_calls
                WHERE assistant_message_id = :assistant_message_id
                  AND tool_name = 'app_search'
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).one()

    assert row.status == "error"
    assert row.error_code == "E_INVALID_REQUEST"


@pytest.mark.integration
async def test_private_deep_app_search_uses_provider_rerank_route(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    query = f"trace multi hop connection saved source provider rerank {uuid4().hex}"
    run_id = _create_run_for_executor(auth_client, direct_db, content=query)
    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        media_id = create_searchable_media(session, run.owner_user_id, title=query)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)

    router = _ProviderRerankAppSearchRouter(query)
    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "complete"}
    assert len(router.generate_requests) == 1

    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        route = session.execute(
            text(
                """
                SELECT retrieval_plan
                FROM chat_runs
                WHERE id = :run_id
                """
            ),
            {"run_id": run_id},
        ).scalar_one()
        tool = session.execute(
            text(
                """
                SELECT mtc.status, mtc.error_code, mrl.strategy, mrl.selected_count,
                       mrl.metadata
                FROM message_tool_calls mtc
                JOIN message_rerank_ledgers mrl ON mrl.tool_call_id = mtc.id
                WHERE mtc.assistant_message_id = :assistant_message_id
                  AND mtc.tool_name = 'app_search'
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).one()
        llm_rows = session.execute(
            text(
                """
                SELECT llm_operation, provider_request_id, error_class
                FROM llm_calls
                WHERE owner_id = :run_id
                ORDER BY call_seq
                """
            ),
            {"run_id": run_id},
        ).fetchall()
        events = session.execute(
            text(
                """
                SELECT event_type, payload
                FROM chat_run_events
                WHERE run_id = :run_id
                  AND event_type IN ('prompt_assembly', 'tool_ledger_snapshot')
                ORDER BY seq
                """
            ),
            {"run_id": run_id},
        ).fetchall()
        trail = build_assistant_trust_trail(
            session,
            viewer_id=run.owner_user_id,
            assistant_message_id=run.assistant_message_id,
        )

    metadata = dict(tool.metadata)
    trust_tool = next(item for item in trail.tool_calls if item.tool_name == "app_search")
    trust_rerank = trust_tool.rerank_ledgers[0]
    assert route["route_intent"] == "private_deep_retrieval"
    assert tool.status == "complete"
    assert tool.error_code is None
    assert tool.strategy == "app_search_provider_rerank"
    assert tool.selected_count > 0
    assert metadata["selection_strategy"] == "app_search_provider_rerank"
    assert metadata["baseline_strategy"] == "app_search_deterministic_selection"
    assert metadata["rerank_mode"] == "provider_rerank"
    assert metadata["rerank_reason"] == "multi_hop_deep_retrieval"
    assert metadata["provider_request_id"] == "req_provider_rerank_1"
    assert metadata["provider_request_ids"] == ["req_provider_rerank_1"]
    assert metadata["llm_call_id"]
    assert metadata["key_mode_used"] == "platform"
    assert metadata["input_tokens"] == 17
    assert metadata["output_tokens"] == 11
    assert metadata["total_tokens"] == 28
    assert metadata["private_snippet_policy"] == "allowed"
    assert metadata["private_snippet_policy_reason"] == (
        "platform_llm_entitlement_allows_private_deep_route"
    )
    assert metadata["rerank_input_count"] == metadata["rerank_output_count"]
    assert metadata["rerank_input_count"] > 0
    assert metadata["candidate_rerank_trace"][0]["provider_reason"] == "direct_answer"
    assert "citation_quality" in metadata["candidate_rerank_trace"][0]
    assert trust_rerank.strategy == "app_search_provider_rerank"
    assert trust_rerank.status == "complete"
    assert trust_rerank.metadata["provider"] == metadata["provider"]
    assert trust_rerank.metadata["model"] == metadata["model"]
    assert trust_rerank.metadata["key_mode_used"] == "platform"
    assert trust_rerank.metadata["llm_call_id"] == metadata["llm_call_id"]
    assert trust_rerank.metadata["provider_request_id"] == "req_provider_rerank_1"
    assert trust_rerank.metadata["latency_ms"] >= 0
    assert trust_rerank.metadata["cost_status"] == metadata["cost_status"]
    assert trust_rerank.metadata["rerank_input_count"] == metadata["rerank_input_count"]
    assert trust_rerank.metadata["rerank_output_count"] == metadata["rerank_output_count"]
    assert trust_rerank.metadata["candidate_rerank_trace"][0]["provider_score"] >= 0
    assert any(row.llm_operation == "search_rerank" for row in llm_rows)
    assert any(row.provider_request_id == "req_provider_rerank_1" for row in llm_rows)
    assert all(row.error_class is None for row in llm_rows if row.llm_operation == "search_rerank")
    assert [row.event_type for row in events] == [
        "prompt_assembly",
        "tool_ledger_snapshot",
        "tool_ledger_snapshot",
    ]
    assert run.retrieval_plan["route_intent"] == ("private_deep_retrieval")
    assert events[1].payload["tool_name"] == "app_search"
    assert events[1].payload["rerank_ledgers"][0]["status"] == "running"
    assert events[1].payload["rerank_ledgers"][0]["strategy"] == ("app_search_provider_rerank")
    assert events[1].payload["candidate_ledgers"]
    assert all(
        item["selected"] is False and item["included_in_prompt"] is False
        for item in events[1].payload["candidate_ledgers"]
    )
    assert events[2].payload["tool_name"] == "app_search"
    assert events[2].payload["rerank_ledgers"][0]["status"] == "complete"
    assert events[2].payload["rerank_ledgers"][0]["strategy"] == ("app_search_provider_rerank")
    assert events[2].payload["candidate_ledgers"]


@pytest.mark.integration
async def test_private_app_search_tool_query_cannot_enable_provider_rerank(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    query = f"trace multi hop connection saved source deterministic {uuid4().hex}"
    run_id = _create_run_for_executor(
        auth_client,
        direct_db,
        content="Search my saved notes for the saved topic.",
    )
    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        media_id = create_searchable_media(session, run.owner_user_id, title=query)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)

    router = _ProviderRerankAppSearchRouter(query)
    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "complete"}
    assert router.generate_requests == []

    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        route = session.execute(
            text(
                """
                SELECT retrieval_plan
                FROM chat_runs
                WHERE id = :run_id
                """
            ),
            {"run_id": run_id},
        ).scalar_one()
        rerank = session.execute(
            text(
                """
                SELECT mrl.strategy, mrl.status, mrl.metadata
                FROM message_tool_calls mtc
                JOIN message_rerank_ledgers mrl ON mrl.tool_call_id = mtc.id
                WHERE mtc.assistant_message_id = :assistant_message_id
                  AND mtc.tool_name = 'app_search'
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).one()
        search_rerank_calls = session.execute(
            text(
                """
                SELECT count(*)
                FROM llm_calls
                WHERE owner_id = :run_id
                  AND llm_operation = 'search_rerank'
                """
            ),
            {"run_id": run_id},
        ).scalar_one()

    assert route["route_intent"] == "private_app_search"
    assert rerank.strategy == "app_search_deterministic_selection"
    assert rerank.status == "complete"
    assert rerank.metadata["rerank_mode"] == "deterministic"
    assert search_rerank_calls == 0


@pytest.mark.integration
async def test_provider_rerank_failure_forwards_no_app_search_evidence(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    query = f"trace multi hop connection saved source provider failure {uuid4().hex}"
    run_id = _create_run_for_executor(auth_client, direct_db, content=query)
    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        media_id = create_searchable_media(session, run.owner_user_id, title=query)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)

    router = _ProviderRerankAppSearchRouter(query, fail=True)
    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "complete"}
    assert len(router.generate_requests) == 1
    payload = json.loads(router.requests[1].messages[-1].tool_results[0].output)
    assert payload["status"] == "error"
    assert payload["error_code"] == "E_LLM_TIMEOUT"
    assert payload["selected_count"] == 0
    assert payload["results"] == []
    assert router.requests[1].messages[-1].tool_results[0].is_error

    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        row = session.execute(
            text(
                """
                SELECT mtc.status, mtc.error_code,
                       jsonb_array_length(mtc.selected_context_refs) AS selected_refs,
                       COUNT(mr.id) FILTER (WHERE mr.selected) AS selected_retrievals,
                       COUNT(mr.id) FILTER (WHERE mr.cited_edge_id IS NOT NULL) AS citations,
                       mrl.strategy, mrl.selected_count, mrl.status, mrl.metadata
                FROM message_tool_calls mtc
                LEFT JOIN message_retrievals mr ON mr.tool_call_id = mtc.id
                JOIN message_rerank_ledgers mrl ON mrl.tool_call_id = mtc.id
                WHERE mtc.assistant_message_id = :assistant_message_id
                  AND mtc.tool_name = 'app_search'
                GROUP BY mtc.id, mrl.id
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).one()
        llm_row = session.execute(
            text(
                """
                SELECT id, provider_request_id, error_class
                FROM llm_calls
                WHERE owner_id = :run_id
                  AND llm_operation = 'search_rerank'
                """
            ),
            {"run_id": run_id},
        ).one()
        trail = build_assistant_trust_trail(
            session,
            viewer_id=run.owner_user_id,
            assistant_message_id=run.assistant_message_id,
        )

    metadata = dict(row.metadata)
    trust_tool = next(item for item in trail.tool_calls if item.tool_name == "app_search")
    trust_rerank = trust_tool.rerank_ledgers[0]
    assert row.status == "error"
    assert row.error_code == "E_LLM_TIMEOUT"
    assert row.selected_refs == 0
    assert row.selected_retrievals == 0
    assert row.citations == 0
    assert row.strategy == "app_search_provider_rerank"
    assert row.selected_count == 0
    assert metadata["failure_error_code"] == "E_LLM_TIMEOUT"
    assert metadata["selection_strategy"] == "app_search_provider_rerank"
    assert metadata["baseline_strategy"] == "app_search_deterministic_selection"
    assert metadata["rerank_input_count"] > 0
    assert metadata["rerank_output_count"] == 0
    assert metadata["llm_call_id"] == str(llm_row.id)
    assert metadata["provider_request_id"] == "req_provider_rerank_timeout"
    assert set(metadata["selection_reason_counts"]) == {"skipped_provider_rerank_failed"}
    assert all(
        item["selection_reason"] == "skipped_provider_rerank_failed"
        for item in metadata["candidate_rerank_trace"]
    )
    assert trust_tool.selected_count == 0
    assert trust_rerank.strategy == "app_search_provider_rerank"
    assert trust_rerank.status == "error"
    assert trust_rerank.metadata["failure_error_code"] == "E_LLM_TIMEOUT"
    assert trust_rerank.metadata["llm_call_id"] == str(llm_row.id)
    assert trust_rerank.metadata["provider_request_id"] == "req_provider_rerank_timeout"
    assert trust_rerank.metadata["rerank_output_count"] == 0
    assert (llm_row.provider_request_id, llm_row.error_class) == (
        "req_provider_rerank_timeout",
        "E_LLM_TIMEOUT",
    )


@pytest.mark.integration
async def test_provider_rerank_invalid_output_forwards_no_app_search_evidence(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    query = f"trace multi hop connection saved source provider invalid {uuid4().hex}"
    run_id = _create_run_for_executor(auth_client, direct_db, content=query)
    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        media_id = create_searchable_media(session, run.owner_user_id, title=query)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)

    router = _ProviderRerankAppSearchRouter(query, invalid_output=True)
    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "complete"}
    assert len(router.generate_requests) == 1
    payload = json.loads(router.requests[1].messages[-1].tool_results[0].output)
    assert payload["status"] == "error"
    assert payload["error_code"] == "E_LLM_BAD_REQUEST"
    assert payload["selected_count"] == 0
    assert payload["results"] == []
    assert router.requests[1].messages[-1].tool_results[0].is_error

    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        row = session.execute(
            text(
                """
                SELECT mtc.status, mtc.error_code,
                       jsonb_array_length(mtc.selected_context_refs) AS selected_refs,
                       COUNT(mr.id) FILTER (WHERE mr.selected) AS selected_retrievals,
                       COUNT(mr.id) FILTER (WHERE mr.cited_edge_id IS NOT NULL) AS citations,
                       mrl.strategy, mrl.selected_count, mrl.status, mrl.metadata
                FROM message_tool_calls mtc
                LEFT JOIN message_retrievals mr ON mr.tool_call_id = mtc.id
                JOIN message_rerank_ledgers mrl ON mrl.tool_call_id = mtc.id
                WHERE mtc.assistant_message_id = :assistant_message_id
                  AND mtc.tool_name = 'app_search'
                GROUP BY mtc.id, mrl.id
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).one()
        llm_rows = session.execute(
            text(
                """
                SELECT provider_request_id, error_class
                FROM llm_calls
                WHERE owner_id = :run_id
                  AND llm_operation = 'search_rerank'
                ORDER BY call_seq
                """
            ),
            {"run_id": run_id},
        ).fetchall()

    metadata = dict(row.metadata)
    assert row.status == "error"
    assert row.error_code == "E_LLM_BAD_REQUEST"
    assert row.selected_refs == 0
    assert row.selected_retrievals == 0
    assert row.citations == 0
    assert row.strategy == "app_search_provider_rerank"
    assert row.selected_count == 0
    assert row.status == "error"
    assert metadata["failure_error_code"] == "E_LLM_BAD_REQUEST"
    assert metadata["rerank_input_count"] > 0
    assert metadata["rerank_output_count"] == 0
    assert metadata["provider_request_ids"] == ["req_provider_rerank_invalid_1"]
    assert [row.error_class for row in llm_rows] == [None]


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
    run_id, media_id = _create_run_with_context_media(
        auth_client,
        direct_db,
        content="Summarize the whole source text.",
    )

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
        assembly = session.execute(
            text(
                """
                SELECT retrieval_plan
                FROM chat_runs
                WHERE id = :run_id
                """
            ),
            {"run_id": run_id},
        ).one()

    assert assembly.retrieval_plan["allowed_tools"] == ["app_search"]
    assert assembly.retrieval_plan["blocked_tools"] == [
        "web_search",
        "read_resource",
        "inspect_resource",
    ]
    assert assembly.retrieval_plan["internal_tool_sequence"] == ["read_resource"]
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
async def test_whole_document_app_search_hint_does_not_override_chat_route(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema
):
    run_id, media_id = _create_run_with_context_media(
        auth_client,
        direct_db,
        content="Search my saved notes for this topic.",
    )
    router = _WholeDocumentAppSearchRouter(media_id)

    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "complete"}
    assert len(router.requests) == 2
    assert router.tool_payload is not None
    assert "long_context" not in router.tool_payload

    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        assembly = session.execute(
            text(
                """
                SELECT retrieval_plan
                FROM chat_runs
                WHERE id = :run_id
                """
            ),
            {"run_id": run_id},
        ).one()
        read_count = session.execute(
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

    assert assembly.retrieval_plan["route_intent"] == "private_app_search"
    assert read_count == 0


@pytest.mark.integration
async def test_long_context_body_is_omitted_when_citation_materialization_fails(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema, monkeypatch
):
    run_id, media_id = _create_run_with_context_media(
        auth_client,
        direct_db,
        content="Summarize the whole source text.",
    )

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
    run_id, media_id = _create_run_with_context_media(
        auth_client,
        direct_db,
        content="Summarize the whole source text.",
    )
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
    run_id, media_id = _create_run_with_context_media(
        auth_client,
        direct_db,
        content="Summarize the whole source text.",
    )

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
    run_id, media_id = _create_run_with_context_media(
        auth_client,
        direct_db,
        content="Summarize the whole source text.",
    )

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
async def test_cancelled_after_direct_read_does_not_forward_tool_output(
    auth_client, direct_db: DirectSessionManager, chat_runs_schema, monkeypatch
):
    from nexus.services.agent_tools.read_resource import execute_read_resource as real_read

    run_id, media_id = _create_run_with_context_media(
        auth_client,
        direct_db,
        content="Read this source exactly.",
    )
    router = _DirectToolThenFinalRouter("read_resource", media_id)

    def read_then_cancel(db, **kwargs):
        result = real_read(db, **kwargs)
        db.execute(
            text(
                """
                UPDATE chat_runs
                SET cancel_requested_at = now(), updated_at = now()
                WHERE id = :run_id
                """
            ),
            {"run_id": run_id},
        )
        return result

    monkeypatch.setattr(
        "nexus.services.chat_runs.execute_read_resource",
        read_then_cancel,
    )
    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "cancelled"}
    assert len(router.requests) == 1
    run_row = _fetch_run_error(direct_db, run_id)
    assert run_row.status == "cancelled"
    assert run_row.error_code == "E_CANCELLED"

    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        row = session.execute(
            text(
                """
                SELECT mtc.status, mtc.error_code, COUNT(mr.id) AS retrieval_count
                FROM message_tool_calls mtc
                LEFT JOIN message_retrievals mr ON mr.tool_call_id = mtc.id
                WHERE mtc.assistant_message_id = :assistant_message_id
                  AND mtc.tool_name = 'read_resource'
                GROUP BY mtc.status, mtc.error_code
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).one()
        cited_edges = session.execute(
            text(
                """
                SELECT COUNT(*)
                FROM resource_edges
                WHERE source_scheme = 'message'
                  AND source_id = :assistant_message_id
                  AND origin = 'citation'
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).scalar_one()

    assert row.status == "error"
    assert row.error_code == "E_CANCELLED"
    assert row.retrieval_count == 0
    assert cited_edges == 0


@pytest.mark.integration
@pytest.mark.parametrize(
    ("tool_name", "oversize_marker"),
    [
        ("read_resource", "canonical text for Long Context Source"),
        ("inspect_resource", "<document_map "),
    ],
)
async def test_direct_tool_output_budget_blocks_continuation(
    auth_client,
    direct_db: DirectSessionManager,
    chat_runs_schema,
    monkeypatch,
    tool_name: str,
    oversize_marker: str,
):
    run_id, media_id = _create_run_with_context_media(
        auth_client,
        direct_db,
        content="Inspect and read this source.",
    )
    router = _DirectToolThenFinalRouter(tool_name, media_id)

    def fake_estimate_tokens(text_value: str) -> int:
        return 10**9 if oversize_marker in text_value else 1

    monkeypatch.setattr("nexus.services.chat_runs.estimate_tokens", fake_estimate_tokens)
    with direct_db.session() as session:
        result = await execute_chat_run(session, run_id=run_id, llm_router=router)

    assert result == {"status": "error", "error_code": "E_LLM_TOOL_OUTPUT_TOO_LARGE"}
    assert len(router.requests) == 1
    run_row = _fetch_run_error(direct_db, run_id)
    assert run_row.status == "error"
    assert run_row.error_code == "E_LLM_TOOL_OUTPUT_TOO_LARGE"
    assert "aggregate tool output budget exceeded" in run_row.error_detail

    with direct_db.session() as session:
        run = session.get(ChatRun, run_id)
        assert run is not None
        row = session.execute(
            text(
                """
                SELECT mtc.status, mtc.error_code, COUNT(mr.id) AS retrieval_count
                FROM message_tool_calls mtc
                LEFT JOIN message_retrievals mr ON mr.tool_call_id = mtc.id
                WHERE mtc.assistant_message_id = :assistant_message_id
                  AND mtc.tool_name = :tool_name
                GROUP BY mtc.status, mtc.error_code
                """
            ),
            {"assistant_message_id": run.assistant_message_id, "tool_name": tool_name},
        ).one()
        cited_edges = session.execute(
            text(
                """
                SELECT COUNT(*)
                FROM resource_edges
                WHERE source_scheme = 'message'
                  AND source_id = :assistant_message_id
                  AND origin = 'citation'
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).scalar_one()

    assert row.status == "complete"
    assert row.error_code is None
    assert row.retrieval_count == 0
    assert cited_edges == 0


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
    assert call_row.error_class == "E_LLM_PROVIDER_DOWN"
    assert call_row.error_detail == "RuntimeError: stream socket exploded"
