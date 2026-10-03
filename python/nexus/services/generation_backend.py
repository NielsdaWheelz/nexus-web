"""One route-neutral runtime for an immutable ``GenerationSpec``.

The dispatcher chooses only from the frozen selection. Route adapters keep
their native transport behaviour; this owner enforces the shared child, event,
tool-loop, continuation, and cancellation lifecycle.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator, Awaitable, Callable, Mapping
from contextlib import aclosing
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal, Protocol, assert_never
from uuid import UUID

from llm_agent_kernel.generation import (
    GenerationCompleted,
    GenerationContinuation,
    GenerationDefect,
    GenerationObservation,
    GenerationProposal,
    GenerationStopped,
    GenerationToolCall,
    GenerationToolResult,
    GenerationTurn,
    run_generation,
)
from llm_agent_kernel.generation import GenerationFrame as KernelFrame
from llm_agent_kernel.generation import GenerationTerminal as KernelTerminal
from provider_runtime.agent_runtime import AgentTerminal
from provider_runtime.types import Absent as RuntimeAbsent
from provider_runtime.types import (
    CancelSignal,
    ProviderTarget,
    ResponsePayload,
    StreamOutcome,
    Succeeded,
    TokenUsage,
)

from nexus.schemas.presence import Absent, Presence, Present
from nexus.services.generation_spec import (
    GenerationIntent,
    GenerationSpec,
    ProviderApiSelection,
    ProviderDispatchTargetSnapshot,
    ProviderFunctions,
    StrictJsonOutputSnapshot,
)
from nexus.services.generation_terminal import (
    GenerationTerminal,
    GenerationToolUse,
    GenerationUsage,
    project_terminal,
)
from nexus.services.provider_generation_contract import (
    ProviderGenerationEvent,
    ProviderModelTools,
    ProviderTerminal,
    ProviderTextDelta,
    ProviderToolProposed,
    ProviderToolResult,
    ProviderUsageObserved,
    decode_provider_turn_continuation,
    provider_turn_continuation_fingerprint,
)

if TYPE_CHECKING:
    from provider_runtime.tool_adapter import ToolCallResolution

    from nexus.services.provider_generation_backend import (
        ProviderGenerationBackend,
        ProviderTurnRequest,
    )

type BackendRoute = Literal["CodexPersonal", "ProviderApi"]
type ProviderToolProjection = Callable[[GenerationSpec], ProviderModelTools | None]


class GenerationBackendDefect(AssertionError):
    """A frozen same-system fact or injected backend contract was inconsistent."""


class GenerationBackendCompositionRefused(ValueError):
    """The requested output/tool composition is intentionally unsupported."""


@dataclass(frozen=True, slots=True)
class BackendTextDelta:
    kind: Literal["TextDelta"] = field(default="TextDelta", init=False)
    route: BackendRoute
    child_seq: int
    backend_seq: int
    text: str


@dataclass(frozen=True, slots=True)
class BackendUsageObserved:
    kind: Literal["UsageObserved"] = field(default="UsageObserved", init=False)
    route: BackendRoute
    child_seq: int
    backend_seq: int
    usage: GenerationUsage | TokenUsage


@dataclass(frozen=True, slots=True)
class BackendToolProposed:
    """An API-native proposal awaiting the shared Nexus ToolAuthority."""

    kind: Literal["ToolProposed"] = field(default="ToolProposed", init=False)
    route: Literal["ProviderApi"] = field(default="ProviderApi", init=False)
    child_seq: int
    backend_seq: int
    proposal: ToolCallResolution = field(repr=False)


@dataclass(frozen=True, slots=True)
class BackendToolObserved:
    """Sanitized callback progress from the canonical local tool executor."""

    kind: Literal["ToolObserved"] = field(default="ToolObserved", init=False)
    route: Literal["CodexPersonal"] = field(default="CodexPersonal", init=False)
    child_seq: Literal[1] = field(default=1, init=False)
    backend_seq: int
    observation: GenerationToolUse


@dataclass(frozen=True, slots=True)
class CodexTerminalEvidence:
    route: Literal["CodexPersonal"] = field(default="CodexPersonal", init=False)
    terminal: AgentTerminal

    @property
    def native(self) -> GenerationTerminal:
        """Decode product material only after this original terminal was committed."""
        return project_terminal(self.terminal)


@dataclass(frozen=True, slots=True)
class ProviderTerminalEvidence:
    """Provider terminal truth without successor secret material."""

    route: Literal["ProviderApi"] = field(default="ProviderApi", init=False)
    outcome: StreamOutcome = field(repr=False)
    correlation: Presence[str]


type BackendTerminalEvidence = CodexTerminalEvidence | ProviderTerminalEvidence


@dataclass(frozen=True, slots=True)
class BackendTerminal:
    kind: Literal["Terminal"] = field(default="Terminal", init=False)
    route: BackendRoute
    child_seq: int
    backend_seq: int
    evidence: BackendTerminalEvidence


type BackendEvent = (
    BackendTextDelta
    | BackendUsageObserved
    | BackendToolProposed
    | BackendToolObserved
    | BackendTerminal
)


@dataclass(frozen=True, slots=True)
class BackendChildDispatch:
    """Durable identity to arm immediately before one native model call."""

    generation_id: UUID
    child_seq: int
    route: BackendRoute
    request_fingerprint: str
    route_request_identity: Mapping[str, object]


@dataclass(frozen=True, slots=True)
class ProviderContinuationIdentity:
    """Non-secret identity used to reopen one exact durable successor."""

    generation_id: UUID
    source_child_seq: int
    successor_child_seq: int
    target_fingerprint: str
    codec_id: str
    policy_revision: str
    canonical_fingerprint: str

    def __post_init__(self) -> None:
        if self.source_child_seq < 1 or self.successor_child_seq != self.source_child_seq + 1:
            raise ValueError("provider successor must immediately follow its source child")


@dataclass(frozen=True, slots=True)
class ProviderContinuationMaterial:
    """Canonical bytes supplied only to the durable lifecycle sealing owner."""

    identity: ProviderContinuationIdentity
    provider_call_ids: tuple[str, ...]
    canonical_bytes: bytes = field(repr=False)


@dataclass(frozen=True, slots=True)
class ProviderResumeState:
    """One lifecycle-opened continuation used to resume after its source terminal."""

    identity: ProviderContinuationIdentity
    canonical_bytes: bytes = field(repr=False)

    def __post_init__(self) -> None:
        if (
            provider_turn_continuation_fingerprint(self.canonical_bytes)
            != self.identity.canonical_fingerprint
        ):
            raise ValueError("provider resume bytes differ from their durable identity")


@dataclass(frozen=True, slots=True)
class BackendChildCompletion:
    """One terminal child plus successor material to commit atomically."""

    child: BackendChildDispatch
    terminal: BackendTerminal
    successor: Presence[ProviderContinuationMaterial]


@dataclass(frozen=True, slots=True)
class BackendToolExecutionRequest:
    """One provider proposal passed to the shared route-neutral ToolAuthority."""

    generation_id: UUID
    child_seq: int
    proposal: ToolCallResolution = field(repr=False)


@dataclass(frozen=True, slots=True)
class BackendToolExecutionResult:
    """Bounded public result returned to the matching provider call id."""

    provider_call_id: str
    output: str = field(repr=False)
    is_error: bool


class BackendChildLifecycle(Protocol):
    """Persistence hooks; the implementation owns transactions and sealing keys."""

    async def arm_child(self, child: BackendChildDispatch) -> None: ...

    async def record_child_terminal(self, completion: BackendChildCompletion) -> None: ...

    async def resolve_child_terminal(
        self, completion: BackendChildCompletion
    ) -> BackendChildCompletion: ...

    async def open_successor(self, identity: ProviderContinuationIdentity) -> bytes: ...


class BackendToolExecutor(Protocol):
    async def execute(self, request: BackendToolExecutionRequest) -> BackendToolExecutionResult: ...


type NativeTurn = ProviderTurnRequest
type KernelContinuation = GenerationContinuation[ProviderContinuationMaterial, ToolCallResolution]
type KernelCompletion = KernelTerminal[
    BackendTerminal, ProviderContinuationMaterial, ToolCallResolution
]
type BackendGenerationOutcome = BackendTerminal | GenerationStopped[BackendTerminal]
type ObserveEvent = Callable[[BackendEvent], Awaitable[None]]


class GenerationBackend:
    """Adapt frozen Nexus facts to the single shared execution owner."""

    def __init__(
        self,
        *,
        provider: ProviderGenerationBackend,
        provider_tools: ProviderToolProjection,
    ) -> None:
        self._provider = provider
        self._provider_tools = provider_tools

    async def execute(
        self,
        *,
        generation_id: UUID,
        spec: GenerationSpec,
        intent: GenerationIntent,
        lifecycle: BackendChildLifecycle,
        tool_executor: BackendToolExecutor,
        observe: ObserveEvent,
        cancellation: CancelSignal,
        provider_resume: ProviderResumeState | None,
    ) -> BackendGenerationOutcome:
        model_tools: ProviderModelTools | None = None
        start: GenerationTurn[NativeTurn] | KernelContinuation
        if isinstance(spec.selection, ProviderApiSelection):
            if not isinstance(spec.authority, ProviderFunctions):
                raise GenerationBackendDefect("provider function authority is absent")
            if isinstance(spec.output_contract, StrictJsonOutputSnapshot) and isinstance(
                spec.authority.model_tool_plan_snapshot, Present
            ):
                raise GenerationBackendCompositionRefused(
                    "ProviderApi strict structured output and model tools cannot share "
                    "one generation"
                )
            model_tools = self._provider_tools(spec)
            max_turns = None if model_tools else 1
            if provider_resume is None:
                turn = self._provider.prepare_initial_turn(
                    generation_id=generation_id, spec=spec, intent=intent, model_tools=model_tools
                )
                start = GenerationTurn(turn.turn_seq, turn)
            else:
                start = _resume_continuation(generation_id, spec, provider_resume, model_tools)
        else:
            raise GenerationBackendDefect("raw API backend received a non-API selection")
        adapter = _KernelAdapter(
            provider=self._provider,
            generation_id=generation_id,
            spec=spec,
            intent=intent,
            lifecycle=lifecycle,
            tool_executor=tool_executor,
            observe_event=observe,
            model_tools=model_tools,
        )
        try:
            result = await run_generation(
                start=start,
                driver=adapter,
                lifecycle=adapter,
                tools=adapter,
                observer=adapter,
                cancellation=cancellation,
                max_turns=max_turns,
            )
        except GenerationDefect as error:
            raise GenerationBackendDefect(str(error)) from error
        if isinstance(result, GenerationCompleted):
            return result.terminal
        return result


@dataclass(frozen=True, slots=True, kw_only=True)
class _KernelAdapter:
    """Nexus lowering and durable hooks; execution ordering belongs to the kernel."""

    provider: ProviderGenerationBackend
    generation_id: UUID
    spec: GenerationSpec
    intent: GenerationIntent = field(repr=False)
    lifecycle: BackendChildLifecycle
    tool_executor: BackendToolExecutor
    observe_event: ObserveEvent = field(repr=False)
    model_tools: ProviderModelTools | None = field(repr=False)

    async def stream(
        self,
        turn: GenerationTurn[NativeTurn],
        *,
        arm: Callable[[], Awaitable[None]],
        cancellation: CancelSignal,
    ) -> AsyncGenerator[
        KernelFrame[BackendEvent, BackendTerminal, ProviderContinuationMaterial, ToolCallResolution]
    ]:
        native = turn.request
        await arm()
        calls: list[GenerationToolCall[ToolCallResolution]] = []
        sequence = 0
        async with aclosing(self.provider.stream_turn(native, cancel=cancellation)) as stream:
            async for frame in stream:
                sequence += 1
                if frame.turn_seq != turn.ordinal:
                    raise GenerationBackendDefect("provider changed frozen child identity")
                event = _project_provider_event(frame)
                if isinstance(event, BackendToolProposed):
                    call = GenerationToolCall(event.proposal.provider_call_id, event.proposal)
                    calls.append(call)
                    yield GenerationProposal(sequence, call, event)
                elif isinstance(frame, ProviderTerminal):
                    if not isinstance(event, BackendTerminal):
                        raise GenerationBackendDefect(
                            "provider terminal projection is not terminal"
                        )
                    material = _provider_continuation_material(native, frame)
                    continuation = None
                    if isinstance(material, Present):
                        if material.value.provider_call_ids != tuple(
                            call.call_id for call in calls
                        ):
                            raise GenerationBackendDefect(
                                "provider terminal continuation differs from observed proposals"
                            )
                        continuation = GenerationContinuation(
                            turn.ordinal, material.value, tuple(calls)
                        )
                    yield KernelTerminal(sequence, event, continuation)
                else:
                    yield GenerationObservation(sequence, event)

    def successor(
        self,
        continuation: KernelContinuation,
        results: tuple[GenerationToolResult[BackendToolExecutionResult], ...],
    ) -> GenerationTurn[NativeTurn]:
        if self.model_tools is None:
            raise GenerationBackendDefect("provider successor lacks its frozen tool publication")
        turn = self.provider.prepare_successor_turn(
            generation_id=self.generation_id,
            spec=self.spec,
            source_turn_seq=continuation.source_ordinal,
            canonical_continuation=continuation.payload.canonical_bytes,
            tool_results=tuple(
                ProviderToolResult(
                    provider_call_id=result.payload.provider_call_id,
                    output=result.payload.output,
                    is_error=result.payload.is_error,
                )
                for result in results
            ),
            model_tools=self.model_tools,
        )
        return GenerationTurn(turn.turn_seq, turn)

    async def arm(self, turn: GenerationTurn[NativeTurn]) -> None:
        await self.lifecycle.arm_child(self._child(turn))

    async def record_terminal(
        self, turn: GenerationTurn[NativeTurn], terminal: KernelCompletion
    ) -> None:
        await self.lifecycle.record_child_terminal(
            BackendChildCompletion(
                child=self._child(turn),
                terminal=terminal.value,
                successor=(
                    Absent()
                    if terminal.continuation is None
                    else Present(value=terminal.continuation.payload)
                ),
            )
        )

    async def resolve_terminal(
        self, turn: GenerationTurn[NativeTurn], terminal: KernelCompletion
    ) -> KernelCompletion:
        completed = await self.lifecycle.resolve_child_terminal(
            BackendChildCompletion(
                child=self._child(turn),
                terminal=terminal.value,
                successor=(
                    Absent()
                    if terminal.continuation is None
                    else Present(value=terminal.continuation.payload)
                ),
            )
        )
        return KernelTerminal(
            terminal.sequence,
            completed.terminal,
            terminal.continuation if isinstance(completed.successor, Present) else None,
        )

    async def open(self, continuation: KernelContinuation) -> None:
        material = continuation.payload
        opened = await self.lifecycle.open_successor(material.identity)
        if opened != material.canonical_bytes:
            raise GenerationBackendDefect(
                "opened provider continuation differs from committed canonical identity"
            )

    async def execute(
        self, source_ordinal: int, call: GenerationToolCall[ToolCallResolution]
    ) -> GenerationToolResult[BackendToolExecutionResult]:
        result = await self.tool_executor.execute(
            BackendToolExecutionRequest(
                generation_id=self.generation_id, child_seq=source_ordinal, proposal=call.payload
            )
        )
        return GenerationToolResult(result.provider_call_id, result)

    async def observe(self, event: BackendEvent) -> None:
        await self.observe_event(event)

    def _child(self, turn: GenerationTurn[NativeTurn]) -> BackendChildDispatch:
        native = turn.request
        return BackendChildDispatch(
            generation_id=native.generation_id,
            child_seq=native.turn_seq,
            route="ProviderApi",
            request_fingerprint=native.request_fingerprint,
            route_request_identity=native.route_request_identity,
        )


def _project_provider_event(event: ProviderGenerationEvent) -> BackendEvent:
    """Project one route-local API event without exposing continuation bytes."""

    match event:
        case ProviderTextDelta():
            return BackendTextDelta(
                route="ProviderApi",
                child_seq=event.turn_seq,
                backend_seq=event.provider_seq,
                text=event.text,
            )
        case ProviderUsageObserved():
            return BackendUsageObserved(
                route="ProviderApi",
                child_seq=event.turn_seq,
                backend_seq=event.provider_seq,
                usage=event.usage,
            )
        case ProviderToolProposed():
            return BackendToolProposed(
                child_seq=event.turn_seq, backend_seq=event.provider_seq, proposal=event.proposal
            )
        case ProviderTerminal():
            return BackendTerminal(
                route="ProviderApi",
                child_seq=event.turn_seq,
                backend_seq=event.provider_seq,
                evidence=ProviderTerminalEvidence(
                    outcome=_public_outcome(event.outcome), correlation=event.correlation
                ),
            )
        case other:
            assert_never(other)


def _public_outcome(outcome: StreamOutcome) -> StreamOutcome:
    """Remove opaque native continuation material from observable terminal truth."""

    if not isinstance(outcome, Succeeded):
        return outcome
    return Succeeded(
        meta=outcome.meta,
        response=ResponsePayload(content=outcome.response.content, continuation=RuntimeAbsent()),
    )


def _resume_continuation(
    generation_id: UUID,
    spec: GenerationSpec,
    resume: ProviderResumeState,
    model_tools: ProviderModelTools | None,
) -> KernelContinuation:
    identity = resume.identity
    dispatch = spec.resolved_dispatch_target
    if not isinstance(dispatch, ProviderDispatchTargetSnapshot):
        raise GenerationBackendDefect("ProviderApi resume lacks its frozen dispatch target")
    if (
        identity.generation_id != generation_id
        or identity.target_fingerprint != spec.source_row_fingerprint
        or identity.codec_id != dispatch.continuation_codec
        or identity.policy_revision != spec.policy_revision
    ):
        raise GenerationBackendDefect(
            "ProviderApi resume identity differs from its frozen generation"
        )
    if model_tools is None:
        raise GenerationBackendDefect("ProviderApi resume requires frozen model tools")
    decoded = decode_provider_turn_continuation(
        resume.canonical_bytes,
        target=ProviderTarget(provider=dispatch.provider, model=dispatch.model_id),
        codec_id=dispatch.continuation_codec,
    )
    calls = tuple(
        GenerationToolCall(call.id, model_tools.publication.decode_tool_call(call))
        for call in decoded.tool_calls
    )
    return GenerationContinuation(
        identity.source_child_seq,
        ProviderContinuationMaterial(
            identity=identity,
            provider_call_ids=tuple(call.call_id for call in calls),
            canonical_bytes=resume.canonical_bytes,
        ),
        calls,
    )


def _provider_continuation_material(
    turn: ProviderTurnRequest, terminal: ProviderTerminal
) -> Presence[ProviderContinuationMaterial]:
    successor = terminal.successor
    if isinstance(successor, Absent):
        return Absent()
    continuation = successor.value
    dispatch = turn.spec.resolved_dispatch_target
    if not isinstance(dispatch, ProviderDispatchTargetSnapshot):
        raise GenerationBackendDefect("provider child lacks its provider dispatch target")
    return Present(
        value=ProviderContinuationMaterial(
            identity=ProviderContinuationIdentity(
                generation_id=turn.generation_id,
                source_child_seq=turn.turn_seq,
                successor_child_seq=turn.turn_seq + 1,
                target_fingerprint=turn.spec.source_row_fingerprint,
                codec_id=dispatch.continuation_codec,
                policy_revision=turn.spec.policy_revision,
                canonical_fingerprint=continuation.fingerprint,
            ),
            provider_call_ids=continuation.provider_call_ids,
            canonical_bytes=continuation.canonical_bytes,
        )
    )
