"""One route-neutral runtime for an immutable ``GenerationSpec``.

The dispatcher chooses only from the frozen selection.  Route adapters retain
their native transport behavior, while this owner enforces the shared child,
event, tool-loop, continuation, and cancellation lifecycle.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator, Awaitable, Callable, Mapping
from contextlib import aclosing
from dataclasses import dataclass, field
from types import MappingProxyType
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
from llm_agent_kernel.generation import (
    GenerationFrame as KernelFrame,
)
from llm_agent_kernel.generation import (
    GenerationTerminal as KernelTerminal,
)
from provider_runtime.types import CancelSignal, ProviderTarget

from nexus.schemas.presence import Absent, Presence, Present
from nexus.services.codex_generation_contract import (
    GenerationAdmission,
    GenerationCommand,
    GenerationCommandDraft,
    GenerationFrame,
    generation_command_draft,
    generation_command_from_draft,
    generation_draft_fingerprint,
)
from nexus.services.generation_events import (
    BackendEvent,
    BackendTerminal,
    BackendToolProposed,
    project_codex_generation_frame,
    project_provider_generation_event,
)
from nexus.services.generation_intent import GenerationIntent
from nexus.services.generation_selection import (
    CodexPersonalSelection,
    ProviderApiSelection,
)
from nexus.services.generation_spec import (
    GenerationSpec,
    ProviderDispatchTargetSnapshot,
    StrictJsonOutputSnapshot,
)
from nexus.services.provider_generation_contract import (
    ProviderGenerationEvent,
    ProviderModelTools,
    ProviderTerminal,
    ProviderToolResult,
    ProviderTurnContinuation,
    decode_provider_turn_continuation,
    provider_turn_continuation_fingerprint,
)

if TYPE_CHECKING:
    from provider_runtime.tool_adapter import ToolCallResolution

    from nexus.services.provider_generation_backend import ProviderTurnRequest

type CodexAdmissionBinder = Callable[[GenerationAdmission], Awaitable[GenerationCommand]]
type BackendRoute = Literal["CodexPersonal", "ProviderApi"]


class GenerationBackendDefect(AssertionError):
    """A frozen same-system fact or injected backend contract was inconsistent."""


class GenerationBackendCompositionRefused(ValueError):
    """The requested output/tool composition is intentionally unsupported."""


@dataclass(frozen=True, slots=True)
class BackendGenerationRequest:
    generation_id: UUID
    spec: GenerationSpec
    intent: GenerationIntent = field(repr=False)


@dataclass(frozen=True, slots=True)
class BackendChildDispatch:
    """Durable identity to arm immediately before one native model call."""

    generation_id: UUID
    child_seq: int
    route: BackendRoute
    request_fingerprint: str
    route_request_identity: Mapping[str, object]

    def __post_init__(self) -> None:
        if self.child_seq < 1:
            raise ValueError("backend child sequence must be positive")
        if len(self.request_fingerprint) != 64 or any(
            character not in "0123456789abcdef" for character in self.request_fingerprint
        ):
            raise ValueError("backend child request fingerprint must be SHA-256")
        object.__setattr__(
            self,
            "route_request_identity",
            MappingProxyType(_canonical_route_request_identity(self.route_request_identity)),
        )


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
        if len(self.target_fingerprint) != 64 or len(self.canonical_fingerprint) != 64:
            raise ValueError("provider continuation fingerprints must be SHA-256")
        if not self.codec_id.strip() or not self.policy_revision.strip():
            raise ValueError("provider continuation identity must be complete")


@dataclass(frozen=True, slots=True)
class ProviderContinuationMaterial:
    """Canonical bytes supplied only to the durable lifecycle sealing owner."""

    identity: ProviderContinuationIdentity
    provider_call_ids: tuple[str, ...]
    canonical_bytes: bytes = field(repr=False)

    def __post_init__(self) -> None:
        if not self.provider_call_ids or len(set(self.provider_call_ids)) != len(
            self.provider_call_ids
        ):
            raise ValueError("provider continuation call ids must be nonempty and unique")
        if (
            provider_turn_continuation_fingerprint(self.canonical_bytes)
            != self.identity.canonical_fingerprint
        ):
            raise ValueError("provider continuation fingerprint differs from its bytes")


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

    def __post_init__(self) -> None:
        if (
            self.terminal.route != self.child.route
            or self.terminal.child_seq != self.child.child_seq
        ):
            raise ValueError("backend child terminal identity differs from its dispatch")
        if self.child.route == "CodexPersonal" and not isinstance(self.successor, Absent):
            raise ValueError("Codex native child cannot carry an API continuation")


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

    def __post_init__(self) -> None:
        if not self.provider_call_id.strip():
            raise ValueError("backend tool result call id must not be blank")
        if not isinstance(self.output, str):
            raise TypeError("backend tool result output must be text")
        if type(self.is_error) is not bool:
            raise TypeError("backend tool result is_error must be bool")


class CodexGenerationTransport(Protocol):
    def stream(
        self,
        draft: GenerationCommandDraft,
        *,
        bind_admission: CodexAdmissionBinder,
    ) -> AsyncGenerator[GenerationFrame]: ...

    async def cancel(self, request_id: UUID) -> None: ...


class ProviderGenerationTransport(Protocol):
    def prepare_initial_turn(
        self,
        *,
        generation_id: UUID,
        spec: GenerationSpec,
        intent: GenerationIntent,
        model_tools: ProviderModelTools | None,
    ) -> ProviderTurnRequest: ...

    def prepare_successor_turn(
        self,
        *,
        generation_id: UUID,
        spec: GenerationSpec,
        intent: GenerationIntent,
        source_turn_seq: int,
        canonical_continuation: bytes,
        tool_results: tuple[ProviderToolResult, ...],
        model_tools: ProviderModelTools,
    ) -> ProviderTurnRequest: ...

    def stream_turn(
        self,
        turn: ProviderTurnRequest,
        *,
        cancel: CancelSignal,
    ) -> AsyncGenerator[ProviderGenerationEvent]: ...


class ProviderModelToolProjection(Protocol):
    def resolve(self, spec: GenerationSpec) -> ProviderModelTools | None: ...


class BackendChildLifecycle(Protocol):
    """Persistence hooks; implementations own transactions and sealing keys."""

    async def arm_child(self, child: BackendChildDispatch) -> None: ...

    async def complete_child(
        self,
        completion: BackendChildCompletion,
    ) -> BackendChildCompletion: ...

    async def open_successor(self, identity: ProviderContinuationIdentity) -> bytes: ...


class BackendToolExecutor(Protocol):
    async def execute(
        self,
        request: BackendToolExecutionRequest,
    ) -> BackendToolExecutionResult: ...


class BackendEventObserver(Protocol):
    async def observe(self, event: BackendEvent) -> None: ...


@dataclass(frozen=True, slots=True)
class GenerationBackendComposition:
    codex: CodexGenerationTransport
    provider: ProviderGenerationTransport
    provider_tools: ProviderModelToolProjection


@dataclass(frozen=True, slots=True)
class GenerationBackendExecution:
    request: BackendGenerationRequest
    lifecycle: BackendChildLifecycle
    tool_executor: BackendToolExecutor
    observer: BackendEventObserver
    cancellation: CancelSignal
    codex_bind_admission: CodexAdmissionBinder | None = field(default=None, repr=False)
    provider_resume: ProviderResumeState | None = field(default=None, repr=False)


type NativeTurn = GenerationCommandDraft | ProviderTurnRequest
type KernelContinuation = GenerationContinuation[ProviderContinuationMaterial, ToolCallResolution]
type KernelCompletion = KernelTerminal[
    BackendTerminal, ProviderContinuationMaterial, ToolCallResolution
]
type BackendGenerationOutcome = BackendTerminal | GenerationStopped[BackendTerminal]


class GenerationBackend:
    """Adapt frozen Nexus facts to the single shared execution owner."""

    def __init__(self, composition: GenerationBackendComposition) -> None:
        self._composition = composition

    async def execute(self, execution: GenerationBackendExecution) -> BackendGenerationOutcome:
        request = execution.request
        model_tools: ProviderModelTools | None = None
        start: GenerationTurn[NativeTurn] | KernelContinuation
        match request.spec.selection:
            case CodexPersonalSelection():
                if execution.provider_resume is not None:
                    raise GenerationBackendDefect(
                        "CodexPersonal execution received a ProviderApi resume state"
                    )
                draft = GenerationCommandDraft(
                    request_id=request.generation_id,
                    spec=request.spec,
                    intent=request.intent,
                )
                has_tools = isinstance(request.spec.model_tool_plan_snapshot, Present)
                if has_tools != (execution.codex_bind_admission is not None):
                    raise GenerationBackendDefect(
                        "Codex ModelTools must use exactly one post-admission MCP grant binder"
                    )
                start = GenerationTurn(1, draft)
                max_turns = 1
            case ProviderApiSelection():
                if execution.codex_bind_admission is not None:
                    raise GenerationBackendDefect(
                        "ProviderApi execution received a Codex MCP grant binder"
                    )
                frozen = request.spec.model_tool_plan_snapshot
                if isinstance(
                    request.spec.output_contract, StrictJsonOutputSnapshot
                ) and isinstance(frozen, Present):
                    raise GenerationBackendCompositionRefused(
                        "ProviderApi strict structured output and model tools cannot share "
                        "one generation"
                    )
                model_tools = self._composition.provider_tools.resolve(request.spec)
                max_turns = model_tools.snapshot.run_limits.max_calls + 1 if model_tools else 1
                if execution.provider_resume is None:
                    turn = self._composition.provider.prepare_initial_turn(
                        generation_id=request.generation_id,
                        spec=request.spec,
                        intent=request.intent,
                        model_tools=model_tools,
                    )
                    start = GenerationTurn(turn.turn_seq, turn)
                else:
                    start = _resume_continuation(execution, model_tools)
            case other:
                assert_never(other)
        adapter = _KernelAdapter(self._composition, execution, model_tools)
        try:
            result = await run_generation(
                start=start,
                driver=adapter,
                lifecycle=adapter,
                tools=adapter,
                observer=adapter,
                cancellation=execution.cancellation,
                max_turns=max_turns,
            )
        except GenerationDefect as error:
            raise GenerationBackendDefect(str(error)) from error
        if isinstance(result, GenerationCompleted):
            return result.terminal
        return result


@dataclass(frozen=True, slots=True)
class _KernelAdapter:
    """Nexus lowering and durable hooks; execution ordering belongs to the kernel."""

    composition: GenerationBackendComposition
    execution: GenerationBackendExecution
    model_tools: ProviderModelTools | None

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
        if isinstance(native, GenerationCommandDraft):

            async def bind(admission: GenerationAdmission) -> GenerationCommand:
                await arm()
                binder = self.execution.codex_bind_admission
                command = (
                    generation_command_from_draft(native, tool_grant=None)
                    if binder is None
                    else await binder(admission)
                )
                if generation_command_draft(command) != native:
                    raise GenerationBackendDefect(
                        "Codex admission binder changed frozen generation identity"
                    )
                return command

            # Race only the next transport read against cancellation. The native
            # transport owns interrupt and terminal truth; no effect is raced.
            stream = self.composition.codex.stream(native, bind_admission=bind)
            cancel_task = asyncio.create_task(cancellation.wait())
            read_task: asyncio.Task[GenerationFrame] | None = None
            cancelled = False
            try:
                while True:
                    read_task = asyncio.create_task(anext(stream))
                    if not cancelled:
                        done, _ = await asyncio.wait(
                            (read_task, cancel_task), return_when=asyncio.FIRST_COMPLETED
                        )
                        if read_task not in done:
                            await cancel_task
                            await self.composition.codex.cancel(native.request_id)
                            cancelled = True
                    try:
                        frame = await read_task
                    except StopAsyncIteration:
                        break
                    if frame.request_id != native.request_id:
                        raise GenerationBackendDefect("Codex changed frozen generation identity")
                    event = project_codex_generation_frame(frame)
                    if event is None:
                        continue
                    if isinstance(event, BackendTerminal):
                        yield KernelTerminal(event.backend_seq, event)
                    else:
                        yield GenerationObservation(event.backend_seq, event)
            finally:
                pending: list[asyncio.Task[object]] = [cancel_task]
                if read_task is not None:
                    pending.append(read_task)
                for task in pending:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
                await stream.aclose()
            return
        await arm()
        calls: list[GenerationToolCall[ToolCallResolution]] = []
        stream = self.composition.provider.stream_turn(native, cancel=cancellation)
        sequence = 0
        async with aclosing(stream):
            async for frame in stream:
                sequence += 1
                if frame.turn_seq != turn.ordinal:
                    raise GenerationBackendDefect("provider changed frozen child identity")
                event = project_provider_generation_event(frame)
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
        request = self.execution.request
        if self.model_tools is None:
            raise GenerationBackendDefect("provider successor lacks its frozen tool publication")
        turn = self.composition.provider.prepare_successor_turn(
            generation_id=request.generation_id,
            spec=request.spec,
            intent=request.intent,
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
        await self.execution.lifecycle.arm_child(self._child(turn))

    async def complete(
        self, turn: GenerationTurn[NativeTurn], terminal: KernelCompletion
    ) -> KernelCompletion:
        proposed = BackendChildCompletion(
            child=self._child(turn),
            terminal=terminal.value,
            successor=(
                Absent()
                if terminal.continuation is None
                else Present(value=terminal.continuation.payload)
            ),
        )
        completed = await self.execution.lifecycle.complete_child(proposed)
        return KernelTerminal(
            terminal.sequence,
            completed.terminal,
            terminal.continuation if isinstance(completed.successor, Present) else None,
        )

    async def open(self, continuation: KernelContinuation) -> None:
        material = continuation.payload
        opened = await self.execution.lifecycle.open_successor(material.identity)
        if opened != material.canonical_bytes:
            raise GenerationBackendDefect(
                "opened provider continuation differs from committed canonical identity"
            )

    async def execute(
        self, source_ordinal: int, call: GenerationToolCall[ToolCallResolution]
    ) -> GenerationToolResult[BackendToolExecutionResult]:
        result = await self.execution.tool_executor.execute(
            BackendToolExecutionRequest(
                generation_id=self.execution.request.generation_id,
                child_seq=source_ordinal,
                proposal=call.payload,
            )
        )
        return GenerationToolResult(result.provider_call_id, result)

    async def observe(self, event: BackendEvent) -> None:
        await self.execution.observer.observe(event)

    def _child(self, turn: GenerationTurn[NativeTurn]) -> BackendChildDispatch:
        if isinstance(turn.request, GenerationCommandDraft):
            return _codex_child_dispatch(self.execution.request, turn.request)
        return _provider_child_dispatch(turn.request)


def _resume_continuation(
    execution: GenerationBackendExecution, model_tools: ProviderModelTools | None
) -> KernelContinuation:
    request = execution.request
    resume = execution.provider_resume
    if resume is None:
        raise GenerationBackendDefect("provider resume state is absent")
    identity = resume.identity
    dispatch = request.spec.resolved_dispatch_target
    if not isinstance(dispatch, ProviderDispatchTargetSnapshot):
        raise GenerationBackendDefect("ProviderApi resume lacks its frozen dispatch target")
    if (
        identity.generation_id != request.generation_id
        or identity.target_fingerprint != request.spec.source_row_fingerprint
        or identity.codec_id != dispatch.continuation_codec
        or identity.policy_revision != request.spec.policy_revision
    ):
        raise GenerationBackendDefect(
            "ProviderApi resume identity differs from its frozen generation"
        )
    if model_tools is None:
        raise GenerationBackendDefect("ProviderApi resume requires frozen model tools")
    decoded = decode_provider_turn_continuation(
        resume.canonical_bytes,
        spec=request.spec,
        expected_source_turn_seq=identity.source_child_seq,
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


def _codex_child_dispatch(
    request: BackendGenerationRequest,
    draft: GenerationCommandDraft,
) -> BackendChildDispatch:
    dispatch = request.spec.resolved_dispatch_target
    if dispatch.kind != "CodexPersonal":
        raise GenerationBackendDefect("Codex selection lacks a Codex dispatch target")
    fingerprint = generation_draft_fingerprint(draft)
    return BackendChildDispatch(
        generation_id=request.generation_id,
        child_seq=1,
        route="CodexPersonal",
        request_fingerprint=fingerprint,
        route_request_identity={
            "kind": "CodexPersonal",
            "request_id": str(request.generation_id),
            "generation_spec_fingerprint": request.spec.fingerprint,
            "request_fingerprint": fingerprint,
            "model_key": dispatch.model_key,
            "dispatch_model": dispatch.dispatch_model,
            "reasoning": request.spec.selection.reasoning,
            "agent_definition_revision": dispatch.agent_definition_revision,
        },
    )


def _provider_child_dispatch(turn: ProviderTurnRequest) -> BackendChildDispatch:
    return BackendChildDispatch(
        generation_id=turn.generation_id,
        child_seq=turn.turn_seq,
        route="ProviderApi",
        request_fingerprint=turn.request_fingerprint,
        route_request_identity=turn.route_request_identity,
    )


def _provider_continuation_material(
    turn: ProviderTurnRequest,
    terminal: ProviderTerminal,
) -> Presence[ProviderContinuationMaterial]:
    successor = terminal.successor
    if isinstance(successor, Absent):
        return Absent()
    if not isinstance(successor, Present):
        assert_never(successor)
    continuation: ProviderTurnContinuation = successor.value
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


def _canonical_route_request_identity(value: Mapping[str, object]) -> dict[str, object]:
    """Detach an adapter-owned frozen tree into ledger-safe canonical JSON."""

    def plain(item: object) -> object:
        if isinstance(item, Mapping):
            if any(not isinstance(key, str) for key in item):
                raise ValueError("backend route request identity keys must be text")
            return {key: plain(child) for key, child in item.items()}
        if isinstance(item, tuple | list):
            return [plain(child) for child in item]
        if item is None or type(item) in {bool, int, float, str}:
            return item
        raise ValueError("backend route request identity is not canonical JSON")

    detached = plain(value)
    if not isinstance(detached, dict):
        raise ValueError("backend route request identity must be an object")
    try:
        encoded = json.dumps(
            detached,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        canonical = json.loads(encoded)
    except (TypeError, ValueError):
        raise ValueError("backend route request identity is not canonical JSON") from None
    if not isinstance(canonical, dict):
        raise ValueError("backend route request identity must be an object")
    return canonical


__all__ = [
    "BackendChildCompletion",
    "BackendChildDispatch",
    "BackendChildLifecycle",
    "BackendEventObserver",
    "BackendGenerationRequest",
    "BackendGenerationOutcome",
    "BackendToolExecutionRequest",
    "BackendToolExecutionResult",
    "BackendToolExecutor",
    "CodexAdmissionBinder",
    "CodexGenerationTransport",
    "GenerationBackend",
    "GenerationBackendComposition",
    "GenerationBackendCompositionRefused",
    "GenerationBackendDefect",
    "GenerationBackendExecution",
    "ProviderContinuationIdentity",
    "ProviderContinuationMaterial",
    "ProviderResumeState",
    "ProviderGenerationTransport",
    "ProviderModelToolProjection",
]
