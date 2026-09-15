"""Provider terminal truth is accepted only after the complete stream validates."""

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import cast
from uuid import uuid4

import pytest
from provider_runtime.registry import api_model_catalog
from provider_runtime.types import Absent as RuntimeAbsent
from provider_runtime.types import (
    AttemptRecord,
    CallMeta,
    CancelSignal,
    FinalAttempt,
    GenerateIntent,
    PossiblyBillable,
    ResponsePayload,
    RuntimeStreamEvent,
    StreamStart,
    Succeeded,
    TerminalEvent,
    TextContent,
    TextDelta,
    ToolCall,
    ToolCallDone,
)
from provider_runtime.types import Present as RuntimePresent

from nexus.schemas.presence import Present
from nexus.services import generation_policy
from nexus.services.generation_backend import (
    BackendChildCompletion,
    BackendChildDispatch,
    BackendGenerationRequest,
    BackendToolExecutor,
    CodexChildProjection,
    CodexGenerationTransport,
    GenerationBackend,
    GenerationBackendComposition,
    GenerationBackendExecution,
    ProviderContinuationIdentity,
)
from nexus.services.generation_events import BackendEvent, BackendTerminal, BackendToolProposed
from nexus.services.generation_intent import GenerationIntent, TextOutput
from nexus.services.generation_service import GenerationService
from nexus.services.generation_spec import (
    FrozenToolScope,
    GenerationSpec,
    ImmutablePromptPayloadRef,
    generation_fact_digest,
)
from nexus.services.provider_generation_backend import (
    ProviderGenerationBackend,
    ProviderGenerationDefect,
)
from nexus.services.provider_generation_contract import ProviderModelTools
from nexus.services.tool_runtime.composition import compose_provider_model_tools
from tests.testkit.generation_catalog import CHAT_TEST_SELECTION, configured_chat_catalog_service
from tests.testkit.generation_tool_authority import controlled_tool_runtime


def test_late_provider_evidence_cannot_commit_publish_or_execute_a_tool_decision() -> None:
    asyncio.run(_prove_terminal_acceptance())


async def _prove_terminal_acceptance() -> None:
    tools = controlled_tool_runtime({})
    catalog = configured_chat_catalog_service()
    admission = GenerationService(
        catalog=catalog, policy=generation_policy.GENERATION_POLICY, tools=tools
    )
    generation_id = uuid4()
    intent = GenerationIntent(
        instructions="Use the admitted tools.", input="A bounded request.", output=TextOutput()
    )
    spec = await admission.freeze_chat(
        catalog_definition_revision=(
            await catalog.read_for_admission()
        ).catalog.definition_revision,
        selection=CHAT_TEST_SELECTION,
        tool_authority="ReadOnly",
        scope=FrozenToolScope(admitted_refs=("library:tail-proof",), predicates=()),
        intent=intent,
        prompt_template_revision="tail-proof.v1",
        prompt_payload_ref=ImmutablePromptPayloadRef(
            owner_kind="chat_run",
            owner_id=str(generation_id),
            revision="tail-proof.v1",
            payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
        ),
    )
    host = _Host(compose_provider_model_tools(tools.operations["ChatRead"]))
    backend = GenerationBackend(
        GenerationBackendComposition(
            codex=cast(CodexGenerationTransport, _Unused()),
            codex_projection=cast(CodexChildProjection, _Unused()),
            provider=ProviderGenerationBackend(_LateProvider()),
            provider_tools=host,
        )
    )
    with pytest.raises(ProviderGenerationDefect, match="after terminal"):
        await backend.execute(
            GenerationBackendExecution(
                request=BackendGenerationRequest(
                    generation_id=generation_id, spec=spec, intent=intent
                ),
                lifecycle=host,
                tool_executor=cast(BackendToolExecutor, _Unused()),
                observer=host,
                cancellation=asyncio.Event(),
            )
        )
    assert len(host.armed) == 1, "the provider call must cross the durable dispatch boundary"
    assert host.completed == [], "a malformed stream committed a tool decision"
    assert not any(
        isinstance(event, (BackendTerminal, BackendToolProposed)) for event in host.events
    )


class _Unused:
    def __getattr__(self, name: str) -> object:
        raise AssertionError(f"a malformed provider stream crossed a forbidden boundary: {name}")


@dataclass
class _Host:
    tools: ProviderModelTools
    armed: list[BackendChildDispatch] = field(default_factory=list)
    completed: list[BackendChildCompletion] = field(default_factory=list)
    events: list[BackendEvent] = field(default_factory=list)

    def resolve(self, spec: GenerationSpec) -> ProviderModelTools:
        assert spec.model_tool_plan_snapshot == Present(value=self.tools.snapshot)
        return self.tools

    async def arm_child(self, child: BackendChildDispatch) -> None:
        self.armed.append(child)

    async def complete_child(self, completion: BackendChildCompletion) -> BackendChildCompletion:
        self.completed.append(completion)
        return completion

    async def open_successor(self, identity: ProviderContinuationIdentity) -> bytes:
        raise AssertionError("a malformed provider stream opened a successor")

    async def observe(self, event: BackendEvent) -> None:
        self.events.append(event)


class _LateProvider:
    async def stream(
        self, intent: GenerateIntent, *, cancel: CancelSignal | None = None
    ) -> AsyncIterator[RuntimeStreamEvent]:
        call = ToolCall(id="tail-proof-call", name=intent.tools[0].name, arguments={})
        meta = CallMeta(
            provider=intent.target.provider,
            model=intent.target.model,
            provider_request_id=RuntimePresent("tail-proof-request"),
            upstream_provider=RuntimeAbsent(),
            usage=RuntimeAbsent(),
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
        yield RuntimeStreamEvent(seq=2, event=ToolCallDone(tool_call=call))
        yield RuntimeStreamEvent(
            seq=3,
            event=TerminalEvent(
                outcome=Succeeded(
                    meta=meta,
                    response=ResponsePayload(
                        content=TextContent(text="", tool_calls=(call,)),
                        continuation=RuntimeAbsent(),
                    ),
                )
            ),
        )
        yield RuntimeStreamEvent(seq=4, event=TextDelta(text="unexpected after terminal"))
