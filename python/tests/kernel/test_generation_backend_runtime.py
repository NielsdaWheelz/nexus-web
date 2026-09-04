"""Behavior proof for route-neutral generation runtime composition."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from importlib.util import find_spec
from typing import TYPE_CHECKING, cast
from uuid import UUID, uuid4

import pytest

# BASE sensitivity overlays this proof without candidate production owners.
_CUTOVER_PRESENT = find_spec("nexus.services.generation_backend") is not None

if TYPE_CHECKING or _CUTOVER_PRESENT:
    from provider_runtime.types import (
        Absent as RuntimeAbsent,
    )
    from provider_runtime.types import (
        AttemptRecord,
        CallMeta,
        CancelSignal,
        ContinuationArtifact,
        FinalAttempt,
        PossiblyBillable,
        ProviderTarget,
        ResponsePayload,
        RuntimeStreamEvent,
        StreamStart,
        Succeeded,
        TerminalEvent,
        TextContent,
        TextDelta,
        TokenUsage,
        ToolCall,
        ToolCallDone,
        ToolResultMessage,
    )
    from provider_runtime.types import (
        GenerateIntent as RuntimeGenerateIntent,
    )
    from provider_runtime.types import (
        Present as RuntimePresent,
    )
    from pydantic import SecretStr

    from nexus.schemas.presence import Absent, Present
    from nexus.services.codex_generation_client import CodexGenerationCapacityUnavailable
    from nexus.services.codex_generation_contract import (
        GenerationAdmission,
        GenerationCommand,
        GenerationCommandDraft,
        GenerationFrame,
        GenerationNative,
        GenerationPermissionRequest,
        GenerationSessionRef,
        GenerationTerminal,
        GenerationText,
        GenerationToolUse,
        GenerationUsage,
        GenerationUsageEvent,
        generation_command_draft,
        generation_command_from_draft,
    )
    from nexus.services.generation_backend import (
        BackendChildCompletion,
        BackendChildDispatch,
        BackendGenerationRequest,
        BackendToolExecutionRequest,
        BackendToolExecutionResult,
        CodexAdmissionBinder,
        GenerationBackend,
        GenerationBackendComposition,
        GenerationBackendCompositionRefused,
        GenerationBackendDefect,
        GenerationBackendExecution,
        PreparedCodexChild,
        ProviderContinuationIdentity,
        ProviderResumeState,
    )
    from nexus.services.generation_events import (
        BackendEvent,
        BackendNativeDiagnostic,
        BackendPermissionDecision,
        BackendTerminal,
        BackendToolObserved,
        BackendToolProposed,
        BackendUsageObserved,
        CodexTerminalEvidence,
        ProviderTerminalEvidence,
        project_codex_generation_frame,
        project_provider_generation_event,
    )
    from nexus.services.generation_intent import BearerToolGrant
    from nexus.services.generation_selection import ProviderApiSelection
    from nexus.services.generation_spec import (
        GenerationSpec,
        GenerationSpecFacts,
        ProviderDispatchTargetSnapshot,
    )
    from nexus.services.provider_generation_backend import (
        ProviderGenerationBackend,
    )
    from nexus.services.provider_generation_contract import (
        ProviderModelTools,
        ProviderTerminal,
    )
    from nexus.services.tool_runtime.composition import (
        compose_provider_model_tools,
        freeze_tool_plan_snapshot,
    )
    from tests.testkit.codex_generation import (
        codex_generation_draft,
        codex_model_tool_fixture,
    )


def test_closed_backend_event_projection_retains_codex_terminal_truth() -> None:
    assert _CUTOVER_PRESENT, "the route-neutral generation backend is absent"
    request_id = uuid4()
    usage = GenerationUsage(input_tokens=3, output_tokens=2, total_tokens=5)
    terminal = _codex_terminal()
    events = (
        GenerationText(text="delta"),
        GenerationUsageEvent(usage=usage),
        GenerationToolUse(
            tool_call_id="tool-1",
            name="nexus.search",
            phase="completed",
            succeeded=True,
        ),
        GenerationPermissionRequest(
            operation="tool_use",
            summary="allow frozen read",
            tool_name="nexus.search",
            decision="allow",
        ),
        GenerationNative(native_type="thread.started"),
        terminal,
    )

    projected = tuple(
        project_codex_generation_frame(
            GenerationFrame(request_id=request_id, sequence=sequence, event=event)
        )
        for sequence, event in enumerate(events)
    )

    assert isinstance(projected[1], BackendUsageObserved)
    assert projected[1].usage is usage
    assert isinstance(projected[2], BackendToolObserved)
    assert projected[2].observation is events[2]
    assert isinstance(projected[3], BackendPermissionDecision)
    assert projected[3].decision is events[3]
    assert isinstance(projected[4], BackendNativeDiagnostic)
    assert projected[4].diagnostic is events[4]
    assert isinstance(projected[5], BackendTerminal)
    assert isinstance(projected[5].evidence, CodexTerminalEvidence)
    assert projected[5].evidence.native is terminal

    meta = _provider_meta()
    private_continuation = ContinuationArtifact(
        ProviderTarget(provider="openai", model="gpt-proof"),
        "openai.responses.v1",
        {"encrypted_state": "must-not-cross-observer-boundary"},
    )
    provider_terminal = project_provider_generation_event(
        ProviderTerminal(
            turn_seq=1,
            provider_seq=2,
            outcome=Succeeded(
                meta=meta,
                response=ResponsePayload(
                    content=TextContent(text="safe answer", tool_calls=()),
                    continuation=RuntimePresent(private_continuation),
                ),
            ),
            correlation=Absent(),
            successor=Absent(),
        )
    )
    assert isinstance(provider_terminal, BackendTerminal)
    assert isinstance(provider_terminal.evidence, ProviderTerminalEvidence)
    public_outcome = provider_terminal.evidence.outcome
    assert isinstance(public_outcome, Succeeded)
    assert public_outcome.meta is meta
    assert public_outcome.response.content.text == "safe answer"
    assert isinstance(public_outcome.response.continuation, RuntimeAbsent)
    assert "must-not-cross-observer-boundary" not in repr(provider_terminal)


def test_codex_uses_one_native_child_mcp_binder_and_live_cancellation() -> None:
    assert _CUTOVER_PRESENT, "the route-neutral generation backend is absent"
    asyncio.run(_codex_cancellation_scenario())


async def _codex_cancellation_scenario() -> None:
    request_id = uuid4()
    _registry, tool_runtime = codex_model_tool_fixture()
    operation = tool_runtime.operations["ChatRead"]
    draft = codex_generation_draft(
        request_id=request_id,
        operation="chat",
        instructions="Use the frozen Nexus tools.",
        input_text="Wait for cancellation after the tool observation.",
        model="gpt-5.6-terra",
        reasoning="medium",
        turn_timeout_seconds=60,
        model_tool_plan=freeze_tool_plan_snapshot(operation),
    )
    binder_calls: list[UUID] = []

    async def bind_admission(admission: GenerationAdmission) -> GenerationCommand:
        binder_calls.append(admission.admission_id)
        return generation_command_from_draft(
            draft,
            tool_grant=BearerToolGrant(token=SecretStr("kernel-mcp-grant")),
        )

    capacity_lifecycle = _Lifecycle(timeline=[])
    capacity_backend = GenerationBackend(
        GenerationBackendComposition(
            codex=_CapacityRefusingCodex(),
            provider=ProviderGenerationBackend(_TwoTurnProviderRuntime()),
            codex_projection=_CodexProjection(draft),
            provider_tools=_ProviderTools(compose_provider_model_tools(operation)),
        )
    )
    with pytest.raises(CodexGenerationCapacityUnavailable):
        await capacity_backend.execute(
            GenerationBackendExecution(
                request=BackendGenerationRequest(
                    generation_id=request_id,
                    spec=draft.spec,
                    intent=draft.intent,
                ),
                lifecycle=capacity_lifecycle,
                tool_executor=_ForbiddenToolExecutor(),
                observer=_Observer(),
                cancellation=_NeverCancelled(),
                codex_bind_admission=bind_admission,
            )
        )
    assert capacity_lifecycle.armed == [], (
        "a proven pre-admission capacity refusal must remain safe to park and retry"
    )
    assert binder_calls == []

    codex = _CancellableCodex()
    replacement_terminal = BackendTerminal(
        route="CodexPersonal",
        child_seq=1,
        backend_seq=1,
        evidence=CodexTerminalEvidence(
            native=_codex_cancelled_terminal().model_copy(
                update={"diagnostics": ("resolved by durable owner",)}
            )
        ),
    )
    lifecycle = _Lifecycle(timeline=[], replacement_terminal=replacement_terminal)
    observer = _Observer()
    cancellation = asyncio.Event()
    backend = GenerationBackend(
        GenerationBackendComposition(
            codex=codex,
            provider=ProviderGenerationBackend(_TwoTurnProviderRuntime()),
            codex_projection=_CodexProjection(draft),
            provider_tools=_ProviderTools(compose_provider_model_tools(operation)),
        )
    )
    execution = asyncio.create_task(
        backend.execute(
            GenerationBackendExecution(
                request=BackendGenerationRequest(
                    generation_id=request_id,
                    spec=draft.spec,
                    intent=draft.intent,
                ),
                lifecycle=lifecycle,
                tool_executor=_ForbiddenToolExecutor(),
                observer=observer,
                cancellation=cancellation,
                codex_bind_admission=bind_admission,
            )
        )
    )
    await codex.started.wait()
    cancellation.set()
    terminal = await execution

    assert terminal.route == "CodexPersonal"
    assert terminal.child_seq == 1
    assert terminal is replacement_terminal
    assert observer.events[-1] is replacement_terminal
    assert binder_calls == [codex.admission_id]
    assert codex.cancelled_request_id == request_id
    assert [child.child_seq for child in lifecycle.armed] == [1]
    assert [completion.child.child_seq for completion in lifecycle.completed] == [1]
    assert any(isinstance(event, BackendToolObserved) for event in observer.events)


def test_api_tool_loop_commits_each_native_child_before_tools_and_successor() -> None:
    assert _CUTOVER_PRESENT, "the route-neutral generation backend is absent"
    asyncio.run(_api_tool_loop_scenario())


async def _api_tool_loop_scenario() -> None:
    request_id = uuid4()
    _registry, tool_runtime = codex_model_tool_fixture()
    operation = tool_runtime.operations["ChatRead"]
    model_tools = compose_provider_model_tools(operation)
    draft = codex_generation_draft(
        request_id=request_id,
        operation="chat",
        instructions="Use the frozen search tool before answering.",
        input_text="Find fixture evidence.",
        model="gpt-5.6-terra",
        reasoning="medium",
        turn_timeout_seconds=60,
        model_tool_plan=freeze_tool_plan_snapshot(operation),
    )
    spec = _provider_spec(draft.spec)
    request = BackendGenerationRequest(
        generation_id=request_id,
        spec=spec,
        intent=draft.intent,
    )
    timeline: list[str] = []
    runtime = _TwoTurnProviderRuntime()
    lifecycle = _Lifecycle(timeline=timeline)
    observer = _Observer()
    backend = GenerationBackend(
        GenerationBackendComposition(
            codex=_UnusedCodex(),
            provider=ProviderGenerationBackend(runtime),
            codex_projection=_CodexProjection(draft),
            provider_tools=_ProviderTools(model_tools),
        )
    )

    async def wrong_route_binder(_admission: GenerationAdmission) -> GenerationCommand:
        return generation_command_from_draft(
            draft,
            tool_grant=BearerToolGrant(token=SecretStr("wrong-route-grant")),
        )

    rejected_lifecycle = _Lifecycle(timeline=[])
    with pytest.raises(
        GenerationBackendDefect,
        match="ProviderApi execution received a Codex MCP grant binder",
    ):
        await backend.execute(
            GenerationBackendExecution(
                request=request,
                lifecycle=rejected_lifecycle,
                tool_executor=_ToolExecutor(timeline=[]),
                observer=_Observer(),
                cancellation=_NeverCancelled(),
                codex_bind_admission=wrong_route_binder,
            )
        )
    assert rejected_lifecycle.armed == []

    terminal = await backend.execute(
        GenerationBackendExecution(
            request=request,
            lifecycle=lifecycle,
            tool_executor=_ToolExecutor(timeline=timeline),
            observer=observer,
            cancellation=_NeverCancelled(),
        )
    )

    assert terminal.child_seq == 2
    assert isinstance(terminal.evidence, ProviderTerminalEvidence)
    assert isinstance(terminal.evidence.outcome, Succeeded)
    assert terminal.evidence.outcome.response.content.text == "answer from tool evidence"
    assert not hasattr(terminal.evidence, "successor"), (
        "observable terminal evidence must not expose sealed continuation material"
    )
    assert timeline == [
        "arm:1",
        "complete:1",
        "tool:1",
        "open:1",
        "arm:2",
        "complete:2",
    ]
    assert [child.child_seq for child in lifecycle.armed] == [1, 2]
    assert [completion.child.child_seq for completion in lifecycle.completed] == [1, 2]
    assert [event.child_seq for event in observer.events if isinstance(event, BackendTerminal)] == [
        1,
        2,
    ]
    first_terminal_index = next(
        index
        for index, event in enumerate(observer.events)
        if isinstance(event, BackendTerminal) and event.child_seq == 1
    )
    proposal_index = next(
        index
        for index, event in enumerate(observer.events)
        if isinstance(event, BackendToolProposed)
    )
    assert "fixture" not in repr(observer.events[proposal_index])
    assert "fixture" not in repr(observer.events[first_terminal_index])
    assert proposal_index < first_terminal_index
    assert runtime.turns == [1, 2]

    first_successor = lifecycle.completed[0].successor
    assert isinstance(first_successor, Present)
    resume_material = first_successor.value
    resume_timeline: list[str] = []
    resume_runtime = _TwoTurnProviderRuntime()
    resume_lifecycle = _Lifecycle(timeline=resume_timeline)
    resume_observer = _Observer()
    resumed = await GenerationBackend(
        GenerationBackendComposition(
            codex=_UnusedCodex(),
            provider=ProviderGenerationBackend(resume_runtime),
            codex_projection=_CodexProjection(draft),
            provider_tools=_ProviderTools(model_tools),
        )
    ).execute(
        GenerationBackendExecution(
            request=request,
            lifecycle=resume_lifecycle,
            tool_executor=_ToolExecutor(timeline=resume_timeline),
            observer=resume_observer,
            cancellation=_NeverCancelled(),
            provider_resume=ProviderResumeState(
                identity=resume_material.identity,
                canonical_bytes=resume_material.canonical_bytes,
            ),
        )
    )

    assert resumed.child_seq == 2
    assert resume_runtime.turns == [2], "resume redispatched the already-terminal provider child"
    assert [child.child_seq for child in resume_lifecycle.armed] == [2]
    assert resume_timeline == ["tool:1", "arm:2", "complete:2"]
    assert not any(isinstance(event, BackendToolProposed) for event in resume_observer.events)


def test_strict_tools_use_native_codex_but_provider_refuses_before_a_child() -> None:
    assert _CUTOVER_PRESENT, "the route-neutral generation backend is absent"
    asyncio.run(_strict_tools_refusal_scenario())


async def _strict_tools_refusal_scenario() -> None:
    request_id = uuid4()
    _registry, tool_runtime = codex_model_tool_fixture()
    operation = tool_runtime.operations["ChatRead"]
    draft = codex_generation_draft(
        request_id=request_id,
        operation="chat",
        instructions="Return one object.",
        input_text="Use a tool.",
        model="gpt-5.6-terra",
        reasoning="medium",
        turn_timeout_seconds=60,
        structured_schema={
            "type": "object",
            "properties": {"answer": {"type": "string"}},
            "required": ["answer"],
            "additionalProperties": False,
        },
        model_tool_plan=freeze_tool_plan_snapshot(operation),
    )
    codex = _ImmediateCodex()
    lifecycle = _Lifecycle(timeline=[])
    backend = GenerationBackend(
        GenerationBackendComposition(
            codex=codex,
            provider=ProviderGenerationBackend(_TwoTurnProviderRuntime()),
            codex_projection=_CodexProjection(draft),
            provider_tools=_ProviderTools(compose_provider_model_tools(operation)),
        )
    )

    async def bind_admission(_admission: GenerationAdmission) -> GenerationCommand:
        return generation_command_from_draft(
            draft,
            tool_grant=BearerToolGrant(token=SecretStr("strict-native-mcp-grant")),
        )

    codex_terminal = await backend.execute(
        GenerationBackendExecution(
            request=BackendGenerationRequest(
                generation_id=request_id,
                spec=draft.spec,
                intent=draft.intent,
            ),
            lifecycle=lifecycle,
            tool_executor=_ForbiddenToolExecutor(),
            observer=_Observer(),
            cancellation=_NeverCancelled(),
            codex_bind_admission=bind_admission,
        )
    )
    assert codex_terminal.route == "CodexPersonal"
    assert codex.dispatched is not None and codex.dispatched.tool_grant is not None
    assert [child.child_seq for child in lifecycle.armed] == [1]

    provider_lifecycle = _Lifecycle(timeline=[])
    with pytest.raises(
        GenerationBackendCompositionRefused,
        match="ProviderApi strict structured output and model tools",
    ):
        await backend.execute(
            GenerationBackendExecution(
                request=BackendGenerationRequest(
                    generation_id=request_id,
                    spec=_provider_spec(draft.spec),
                    intent=draft.intent,
                ),
                lifecycle=provider_lifecycle,
                tool_executor=_ToolExecutor(timeline=[]),
                observer=_Observer(),
                cancellation=_NeverCancelled(),
            )
        )
    assert provider_lifecycle.armed == []


def _provider_spec(codex_spec: GenerationSpec) -> GenerationSpec:
    facts = {name: getattr(codex_spec, name) for name in GenerationSpecFacts.model_fields}
    facts.update(
        selection=ProviderApiSelection(
            route="ProviderApi",
            model_ref="openai:gpt-proof",
            reasoning="medium",
        ),
        resolved_dispatch_target=ProviderDispatchTargetSnapshot(
            model_ref="openai:gpt-proof",
            provider="openai",
            model_id="gpt-proof",
            engine="openai_responses",
            base_url=Absent(),
            correlation="header",
            routing=Absent(),
            continuation_codec="openai.responses.v1",
            registry_revision="registry-proof",
        ),
        agent_definition_revision=Absent(),
        backend_contract_revision="provider-runtime.proof.v1",
        provider_registry_revision=Present(value="registry-proof"),
    )
    return GenerationSpec.freeze(GenerationSpecFacts(**facts))


def _codex_terminal() -> GenerationTerminal:
    return GenerationTerminal(
        status="succeeded",
        failure=None,
        final_text="done",
        structured_output=None,
        session_ref=GenerationSessionRef(
            schema_version="agent-session-ref.v1",
            backend="codex",
            transport="sdk",
            native_session_id="session-proof",
            profile_key="codex-personal",
            state_root_fingerprint="1" * 64,
            cwd_fingerprint="2" * 64,
        ),
        usage=GenerationUsage(input_tokens=3, output_tokens=2, total_tokens=5),
        diagnostics=(),
        accepted_at="2026-08-31T12:00:00.000000Z",
        sdk_version="proof-sdk",
        runtime_version="proof-runtime",
    )


def _codex_cancelled_terminal() -> GenerationTerminal:
    return GenerationTerminal(
        status="cancelled",
        failure=None,
        final_text="",
        structured_output=None,
        session_ref=None,
        usage=None,
        diagnostics=("cancelled by generation owner",),
        accepted_at="2026-08-31T12:00:00.000000Z",
        sdk_version="proof-sdk",
        runtime_version="proof-runtime",
    )


class _NeverCancelled:
    async def wait(self) -> bool:
        await asyncio.Future()
        return True

    def is_set(self) -> bool:
        return False


@dataclass(slots=True)
class _Observer:
    events: list[BackendEvent] = field(default_factory=list)

    async def observe(self, event: BackendEvent) -> None:
        self.events.append(event)


@dataclass(slots=True)
class _Lifecycle:
    timeline: list[str]
    replacement_terminal: BackendTerminal | None = None
    armed: list[BackendChildDispatch] = field(default_factory=list)
    completed: list[BackendChildCompletion] = field(default_factory=list)
    continuation_by_source: dict[int, bytes] = field(default_factory=dict)

    async def arm_child(self, child: BackendChildDispatch) -> None:
        self.armed.append(child)
        self.timeline.append(f"arm:{child.child_seq}")

    async def complete_child(
        self,
        completion: BackendChildCompletion,
    ) -> BackendChildCompletion:
        effective = (
            BackendChildCompletion(
                child=completion.child,
                terminal=self.replacement_terminal,
                successor=completion.successor,
            )
            if self.replacement_terminal is not None
            else completion
        )
        self.completed.append(effective)
        self.timeline.append(f"complete:{effective.child.child_seq}")
        if isinstance(effective.successor, Present):
            material = effective.successor.value
            self.continuation_by_source[effective.child.child_seq] = material.canonical_bytes
        return effective

    async def open_successor(self, identity: ProviderContinuationIdentity) -> bytes:
        self.timeline.append(f"open:{identity.source_child_seq}")
        return self.continuation_by_source[identity.source_child_seq]


@dataclass(slots=True)
class _ToolExecutor:
    timeline: list[str]

    async def execute(self, request: BackendToolExecutionRequest) -> BackendToolExecutionResult:
        self.timeline.append(f"tool:{request.child_seq}")
        return BackendToolExecutionResult(
            provider_call_id=request.proposal.provider_call_id,
            output='{"matches":["fixture evidence"]}',
            is_error=False,
        )


class _ForbiddenToolExecutor:
    async def execute(
        self,
        _request: BackendToolExecutionRequest,
    ) -> BackendToolExecutionResult:
        raise AssertionError("Codex MCP observations must not enter the API proposal executor")


@dataclass(frozen=True, slots=True)
class _CodexProjection:
    draft: GenerationCommandDraft

    def prepare(self, _request: BackendGenerationRequest) -> PreparedCodexChild:
        return PreparedCodexChild(draft=self.draft)


@dataclass(frozen=True, slots=True)
class _ProviderTools:
    tools: ProviderModelTools

    def resolve(self, _spec: GenerationSpec) -> ProviderModelTools:
        return self.tools


class _UnusedCodex:
    def stream(
        self,
        _draft: GenerationCommandDraft,
        *,
        bind_admission: CodexAdmissionBinder,
    ) -> AsyncIterator[GenerationFrame]:
        del bind_admission
        raise AssertionError("frozen ProviderApi selection fell through to Codex")

    async def cancel(self, _request_id: UUID) -> None:
        raise AssertionError("unused Codex backend was cancelled")


class _CancellableCodex:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.cancel_received = asyncio.Event()
        self.admission_id = uuid4()
        self.cancelled_request_id: UUID | None = None

    async def stream(
        self,
        draft: GenerationCommandDraft,
        *,
        bind_admission: CodexAdmissionBinder,
    ) -> AsyncIterator[GenerationFrame]:
        dispatched = await bind_admission(
            GenerationAdmission(
                request_id=draft.request_id,
                admission_id=self.admission_id,
                admitted_at="2026-08-31T12:00:00.000000Z",
                runtime_deadline_seconds=draft.spec.bounds.turn_timeout_seconds,
            )
        )
        if generation_command_draft(dispatched) != draft:
            raise AssertionError("Codex binder changed the frozen command")
        self.started.set()
        yield GenerationFrame(
            request_id=draft.request_id,
            sequence=0,
            event=GenerationToolUse(
                tool_call_id="mcp-call-1",
                name="nexus.search",
                phase="completed",
                succeeded=True,
            ),
        )
        await self.cancel_received.wait()
        yield GenerationFrame(
            request_id=draft.request_id,
            sequence=1,
            event=_codex_cancelled_terminal(),
        )

    async def cancel(self, request_id: UUID) -> None:
        self.cancelled_request_id = request_id
        self.cancel_received.set()


class _ImmediateCodex:
    def __init__(self) -> None:
        self.dispatched: GenerationCommand | None = None

    async def stream(
        self,
        draft: GenerationCommandDraft,
        *,
        bind_admission: CodexAdmissionBinder,
    ) -> AsyncIterator[GenerationFrame]:
        self.dispatched = await bind_admission(
            GenerationAdmission(
                request_id=draft.request_id,
                admission_id=uuid4(),
                admitted_at="2026-08-31T12:00:00.000000Z",
                runtime_deadline_seconds=draft.spec.bounds.turn_timeout_seconds,
            )
        )
        yield GenerationFrame(
            request_id=draft.request_id,
            sequence=0,
            event=_codex_cancelled_terminal(),
        )

    async def cancel(self, _request_id: UUID) -> None:
        raise AssertionError("completed Codex backend was cancelled")


class _CapacityRefusingCodex:
    async def stream(
        self,
        _draft: GenerationCommandDraft,
        *,
        bind_admission: CodexAdmissionBinder,
    ) -> AsyncIterator[GenerationFrame]:
        del bind_admission
        if False:
            yield cast(GenerationFrame, None)
        raise CodexGenerationCapacityUnavailable("fixture capacity refusal")

    async def cancel(self, _request_id: UUID) -> None:
        raise AssertionError("pre-admission capacity refusal must not be cancelled")


class _TwoTurnProviderRuntime:
    def __init__(self) -> None:
        self.turns: list[int] = []

    async def stream(
        self,
        intent: RuntimeGenerateIntent,
        *,
        cancel: CancelSignal | None = None,
    ) -> AsyncIterator[RuntimeStreamEvent]:
        del cancel
        turn = (
            2 if any(isinstance(message, ToolResultMessage) for message in intent.messages) else 1
        )
        self.turns.append(turn)
        meta = _provider_meta()
        yield RuntimeStreamEvent(seq=1, event=StreamStart())
        if turn == 1:
            call = ToolCall(
                id="provider-call-1",
                name=intent.tools[0].name,
                arguments={"query": "fixture"},
            )
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
            return
        yield RuntimeStreamEvent(seq=2, event=TextDelta(text="answer from tool evidence"))
        yield RuntimeStreamEvent(
            seq=3,
            event=TerminalEvent(
                outcome=Succeeded(
                    meta=meta,
                    response=ResponsePayload(
                        content=TextContent(
                            text="answer from tool evidence",
                            tool_calls=(),
                        ),
                        continuation=RuntimeAbsent(),
                    ),
                )
            ),
        )


def _provider_meta() -> CallMeta:
    usage = TokenUsage(
        input_tokens=4,
        output_tokens=2,
        total_tokens=6,
        reasoning_tokens=RuntimeAbsent(),
        cache_read_input_tokens=RuntimeAbsent(),
        cache_write_input_tokens=RuntimeAbsent(),
    )
    return CallMeta(
        provider="openai",
        model="gpt-proof",
        provider_request_id=RuntimePresent("provider-request-proof"),
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
        native_reasoning=RuntimePresent("medium"),
        registry_revision="registry-proof",
    )
