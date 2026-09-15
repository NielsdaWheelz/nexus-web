"""Chat execution proof for the exact route-neutral generation boundary."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, AsyncIterator
from dataclasses import dataclass, field
from uuid import UUID

import pytest
from provider_runtime import GenerateIntent as RuntimeGenerateIntent
from provider_runtime import SystemMessage, UserMessage
from provider_runtime.registry import api_model_catalog
from provider_runtime.types import (
    Absent as RuntimeAbsent,
)
from provider_runtime.types import (
    AttemptRecord,
    CallMeta,
    CancelSignal,
    FinalAttempt,
    PossiblyBillable,
    ResponsePayload,
    RuntimeStreamEvent,
    StreamStart,
    Succeeded,
    TerminalEvent,
    TextContent,
    TextDelta,
    TokenUsage,
    UsageEvent,
)
from provider_runtime.types import (
    Present as RuntimePresent,
)
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import ChatPromptAssembly, ChatRun, LLMCall, LLMModelTurn
from nexus.db.session import create_session_factory
from nexus.jobs.queue import get_job
from nexus.schemas.presence import Present
from nexus.services import generation_policy
from nexus.services.chat_runs import PublishedChatExecution, execute_chat_run, get_chat_run
from nexus.services.codex_generation_contract import GenerationFrame
from nexus.services.generation_backend import (
    BackendGenerationRequest,
    GenerationBackend,
    GenerationBackendComposition,
    PreparedCodexChild,
)
from nexus.services.generation_catalog import GenerationCatalogService
from nexus.services.generation_continuations import GenerationContinuationCipher
from nexus.services.generation_intent import GenerationIntent
from nexus.services.generation_service import GenerationService
from nexus.services.generation_spec import GenerationSpec, decode_generation_spec_document
from nexus.services.llm_execution import ComposedExecutionRuntime
from nexus.services.provider_generation_backend import ProviderGenerationBackend
from nexus.services.provider_generation_contract import ProviderModelTools
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from nexus.services.tool_runtime.composition import (
    ComposedToolRuntime,
    compose_provider_model_tools,
    freeze_tool_plan_snapshot,
)
from tests.testkit.chat import create_entitled_chat
from tests.testkit.generation_catalog import (
    CHAT_TEST_SELECTION,
    configured_chat_catalog_service,
)
from tests.testkit.llm_tool_scenarios import (
    claim_chat_tool_job,
    compose_available_product_tool_runtime,
)

pytestmark = pytest.mark.usefixtures("committed_chat_state_isolation")

_ANSWER = "The frozen Chat selection reached its exact provider route."


def test_chat_executes_its_admission_frozen_provider_generation(engine: Engine) -> None:
    """Risk: dispatch reconstructs or changes Chat selection, prompt, tools, or ledger facts."""

    asyncio.run(_prove_chat_executes_its_admission_frozen_provider_generation(engine))


async def _prove_chat_executes_its_admission_frozen_provider_generation(
    engine: Engine,
) -> None:
    session_factory = create_session_factory(engine)
    catalog = configured_chat_catalog_service()
    catalog_snapshot = await catalog.read_chat()
    tool_runtime = compose_available_product_tool_runtime()
    provider = _SuccessfulProviderRuntime()
    execution_runtime = _execution_runtime(
        provider=provider,
        tools=tool_runtime,
        catalog=catalog,
    )
    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=session_factory))
    try:
        with Session(engine, expire_on_commit=False) as db:
            chat = await create_entitled_chat(
                db,
                content="Prove that this exact Chat admission is what gets dispatched.",
                catalog_definition_revision=catalog_snapshot.catalog.definition_revision,
                selection=CHAT_TEST_SELECTION,
                tool_authority="ReadOnly",
                catalog=catalog,
                tool_runtime=tool_runtime,
            )
            context = claim_chat_tool_job(
                db,
                job_id=chat.job_id,
                worker_id="exact-chat-provider-execution",
            )
            job = get_job(db, chat.job_id)
            assert job is not None, "the admitted Chat job disappeared before execution"
            db.commit()

            outcome = await execute_chat_run(
                db,
                run_id=chat.run_id,
                job=job,
                execution_context=context,
                session_factory=session_factory,
                runtime=execution_runtime,
                settings=get_settings(),
            )

            assert isinstance(outcome, PublishedChatExecution), (
                f"exact ProviderApi Chat did not publish: {outcome!r}"
            )
            public = get_chat_run(
                db,
                viewer_id=chat.user_id,
                run_id=chat.run_id,
                catalog_snapshot=catalog_snapshot,
            )
            assert public.run.status == "complete"
            assert [block.text for block in public.assistant_message.message_document.blocks] == [
                _ANSWER
            ]
            assert public.run.run_selection.selection == CHAT_TEST_SELECTION
            assert public.run.run_selection.tool_authority == "ReadOnly"
            assert public.stream_state.assistant_current_text == _ANSWER
            assert public.stream_state.terminal

            run = db.get(ChatRun, chat.run_id)
            assert run is not None
            spec = decode_generation_spec_document(run.generation_spec)
            prompt = db.scalar(
                select(ChatPromptAssembly).where(ChatPromptAssembly.chat_run_id == run.id)
            )
            assert prompt is not None, "Chat execution lost its admission-time prompt"
            intent = GenerationIntent.model_validate(prompt.generation_intent)
            assert provider.intents == [
                _expected_provider_intent(provider.intents[0], spec=spec, intent=intent)
            ], "provider dispatch differed from the admission-frozen prompt or selection"

            parent = db.scalar(
                select(LLMCall).where(
                    LLMCall.owner_kind == "chat_run",
                    LLMCall.owner_id == run.id,
                )
            )
            assert parent is not None, "Chat execution omitted its route-neutral ledger parent"
            assert parent.generation_spec == run.generation_spec, (
                "Chat dispatch ledger did not retain the exact admission-time GenerationSpec"
            )
            assert parent.generation_fingerprint == spec.fingerprint
            assert parent.outcome == "Succeeded"
            child = db.scalar(select(LLMModelTurn).where(LLMModelTurn.generation_id == parent.id))
            assert child is not None, "Chat execution omitted its billable model-turn child"
            assert child.turn_seq == 1
            assert child.route_request_identity["kind"] == "ProviderApi"
            assert child.route_request_identity["model_ref"] == CHAT_TEST_SELECTION.model_ref
            assert child.route_request_identity["reasoning"] == CHAT_TEST_SELECTION.reasoning
            assert not {
                "profile",
                "profile_id",
                "tool_profile",
            }.intersection(child.route_request_identity), (
                "legacy Chat profile facts crossed the hard-cut dispatch boundary"
            )
    finally:
        set_rate_limiter(previous_limiter)


def _expected_provider_intent(
    observed: RuntimeGenerateIntent,
    *,
    spec: GenerationSpec,
    intent: GenerationIntent,
) -> RuntimeGenerateIntent:
    """Assert the externally observable lowering and return the observed receipt."""

    assert observed.target.provider == "openai"
    assert observed.target.model == spec.resolved_dispatch_target.model_id
    assert observed.reasoning == CHAT_TEST_SELECTION.reasoning
    assert observed.max_output_tokens == spec.effective_output_budget_tokens
    assert observed.tool_choice == "auto"
    assert tuple(tool.name for tool in observed.tools), "frozen Chat tools were not published"
    assert len(observed.messages) == 2
    system, user = observed.messages
    assert isinstance(system, SystemMessage)
    assert isinstance(user, UserMessage)
    assert system.blocks[0].text == intent.instructions
    assert user.blocks[0].text == intent.input
    return observed


@dataclass(slots=True)
class _SuccessfulProviderRuntime:
    """Controlled external ProviderRuntime boundary; all Nexus owners stay real."""

    intents: list[RuntimeGenerateIntent] = field(default_factory=list)

    async def stream(
        self,
        intent: RuntimeGenerateIntent,
        *,
        cancel: CancelSignal | None = None,
    ) -> AsyncIterator[RuntimeStreamEvent]:
        assert cancel is not None, "Chat dispatch omitted its live cancellation signal"
        self.intents.append(intent)
        usage = TokenUsage(
            input_tokens=23,
            output_tokens=11,
            total_tokens=34,
            reasoning_tokens=RuntimePresent(4),
            cache_read_input_tokens=RuntimeAbsent(),
            cache_write_input_tokens=RuntimeAbsent(),
        )
        meta = CallMeta(
            provider=intent.target.provider,
            model=intent.target.model,
            provider_request_id=RuntimePresent("chat-provider-request-proof"),
            upstream_provider=RuntimeAbsent(),
            usage=RuntimePresent(usage),
            attempt_trace=(
                AttemptRecord(
                    attempt=1,
                    signal=FinalAttempt(),
                    status_code=RuntimePresent(200),
                    started_at_ms=1,
                    ended_at_ms=2,
                ),
            ),
            billability=PossiblyBillable(),
            native_reasoning=RuntimePresent(intent.reasoning),
            registry_revision=api_model_catalog().registry_revision,
        )
        yield RuntimeStreamEvent(seq=1, event=StreamStart())
        yield RuntimeStreamEvent(seq=2, event=TextDelta(text=_ANSWER))
        yield RuntimeStreamEvent(seq=3, event=UsageEvent(usage=usage))
        yield RuntimeStreamEvent(
            seq=4,
            event=TerminalEvent(
                outcome=Succeeded(
                    meta=meta,
                    response=ResponsePayload(
                        content=TextContent(text=_ANSWER, tool_calls=()),
                        continuation=RuntimeAbsent(),
                    ),
                )
            ),
        )


@dataclass(frozen=True, slots=True)
class _ProviderTools:
    tools: ComposedToolRuntime

    def resolve(self, spec: GenerationSpec) -> ProviderModelTools:
        snapshot = spec.model_tool_plan_snapshot
        assert isinstance(snapshot, Present), "Chat ProviderApi spec omitted its tool plan"
        operation = self.tools.operations[snapshot.value.plan_id]
        assert freeze_tool_plan_snapshot(operation) == snapshot.value, (
            "test runtime tools differ from the admitted Chat plan"
        )
        return compose_provider_model_tools(operation)


class _UnusedCodex:
    def stream(self, *_args: object, **_kwargs: object) -> AsyncGenerator[GenerationFrame]:
        raise AssertionError("exact ProviderApi Chat selection fell through to Codex")

    async def cancel(self, request_id: UUID) -> None:
        raise AssertionError(f"unused Codex transport was cancelled for {request_id}")


class _UnusedCodexProjection:
    def prepare(self, request: BackendGenerationRequest) -> PreparedCodexChild:
        raise AssertionError(
            f"ProviderApi generation {request.generation_id} used Codex projection"
        )


def _execution_runtime(
    *,
    provider: _SuccessfulProviderRuntime,
    tools: ComposedToolRuntime,
    catalog: GenerationCatalogService,
) -> ComposedExecutionRuntime:
    backend = GenerationBackend(
        GenerationBackendComposition(
            codex=_UnusedCodex(),
            provider=ProviderGenerationBackend(provider),
            codex_projection=_UnusedCodexProjection(),
            provider_tools=_ProviderTools(tools),
        )
    )
    return ComposedExecutionRuntime(
        backend=backend,
        continuation_cipher=GenerationContinuationCipher(b"c" * 32),
        admission=GenerationService(
            catalog=catalog,
            policy=generation_policy.GENERATION_POLICY,
            tools=tools,
        ),
    )
