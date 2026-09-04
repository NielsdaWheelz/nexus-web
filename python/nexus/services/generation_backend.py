"""One route-neutral runtime for an immutable ``GenerationSpec``.

The dispatcher chooses only from the frozen selection.  Route adapters retain
their native transport behavior, while this owner enforces the shared child,
event, tool-loop, continuation, and cancellation lifecycle.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import TYPE_CHECKING, Literal, Protocol, assert_never
from uuid import UUID

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
from nexus.services.provider_generation_backend import ProviderTurnRequest
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
class PreparedCodexChild:
    """Pure grant-free route projection prepared before host admission."""

    draft: GenerationCommandDraft = field(repr=False)


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
    ) -> AsyncIterator[GenerationFrame]: ...

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
        cancel: CancelSignal | None = None,
    ) -> AsyncIterator[ProviderGenerationEvent]: ...


class CodexChildProjection(Protocol):
    def prepare(self, request: BackendGenerationRequest) -> PreparedCodexChild: ...


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
    codex_projection: CodexChildProjection
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


class GenerationBackend:
    """Dispatch one frozen generation with no policy, catalog, env, or fallback read."""

    __slots__ = ("_composition",)

    def __init__(self, composition: GenerationBackendComposition) -> None:
        self._composition = composition

    async def execute(self, execution: GenerationBackendExecution) -> BackendTerminal:
        request = execution.request
        selection = request.spec.selection
        match selection:
            case CodexPersonalSelection():
                if execution.provider_resume is not None:
                    raise GenerationBackendDefect(
                        "CodexPersonal execution received a ProviderApi resume state"
                    )
                return await self._execute_codex(execution)
            case ProviderApiSelection():
                if isinstance(
                    request.spec.output_contract, StrictJsonOutputSnapshot
                ) and isinstance(request.spec.model_tool_plan_snapshot, Present):
                    raise GenerationBackendCompositionRefused(
                        "ProviderApi strict structured output and model tools cannot share "
                        "one generation"
                    )
                return await self._execute_provider(execution)
            case other:
                assert_never(other)

    async def _execute_codex(self, execution: GenerationBackendExecution) -> BackendTerminal:
        request = execution.request
        prepared = self._composition.codex_projection.prepare(request)
        draft = prepared.draft
        if (
            draft.request_id != request.generation_id
            or draft.spec != request.spec
            or draft.intent != request.intent
        ):
            raise GenerationBackendDefect("Codex projection changed frozen generation identity")
        has_model_tools = isinstance(request.spec.model_tool_plan_snapshot, Present)
        if has_model_tools != (execution.codex_bind_admission is not None):
            raise GenerationBackendDefect(
                "Codex ModelTools must use exactly one post-admission MCP grant binder"
            )
        child = _codex_child_dispatch(request, draft)
        armed = False

        async def bind_after_admission(admission: GenerationAdmission) -> GenerationCommand:
            nonlocal armed
            if armed:
                raise GenerationBackendDefect("Codex host invoked admission binding twice")
            await execution.lifecycle.arm_child(child)
            armed = True
            if execution.codex_bind_admission is None:
                return generation_command_from_draft(draft, tool_grant=None)
            dispatched = await execution.codex_bind_admission(admission)
            if generation_command_draft(dispatched) != draft:
                raise GenerationBackendDefect(
                    "Codex admission binder changed frozen generation identity"
                )
            return dispatched

        async def consume() -> BackendTerminal:
            terminal: BackendTerminal | None = None
            async for frame in self._composition.codex.stream(
                draft,
                bind_admission=bind_after_admission,
            ):
                if not armed:
                    raise GenerationBackendDefect(
                        "Codex emitted model evidence before durable child arming"
                    )
                event = project_codex_generation_frame(frame)
                if isinstance(event, BackendTerminal):
                    if terminal is not None:
                        raise GenerationBackendDefect("Codex emitted more than one terminal")
                    proposed = BackendChildCompletion(
                        child=child,
                        terminal=event,
                        successor=Absent(),
                    )
                    completed = _validate_effective_completion(
                        proposed,
                        await execution.lifecycle.complete_child(proposed),
                    )
                    event = completed.terminal
                    terminal = event
                await execution.observer.observe(event)
            if terminal is None:
                raise GenerationBackendDefect("Codex stream ended without terminal truth")
            return terminal

        stream_task = asyncio.create_task(consume())
        cancel_task = asyncio.create_task(execution.cancellation.wait())
        try:
            done, _pending = await asyncio.wait(
                (stream_task, cancel_task),
                return_when=asyncio.FIRST_COMPLETED,
            )
            if stream_task in done:
                return await stream_task
            await self._composition.codex.cancel(request.generation_id)
            return await stream_task
        finally:
            for task in (stream_task, cancel_task):
                if not task.done():
                    task.cancel()
            await asyncio.gather(stream_task, cancel_task, return_exceptions=True)

    async def _execute_provider(self, execution: GenerationBackendExecution) -> BackendTerminal:
        request = execution.request
        if execution.codex_bind_admission is not None:
            raise GenerationBackendDefect("ProviderApi execution received a Codex MCP grant binder")
        model_tools = self._composition.provider_tools.resolve(request.spec)
        frozen_tools = request.spec.model_tool_plan_snapshot
        if isinstance(frozen_tools, Present):
            if model_tools is None or model_tools.snapshot != frozen_tools.value:
                raise GenerationBackendDefect(
                    "provider tool projection differs from the frozen GenerationSpec"
                )
        elif not isinstance(frozen_tools, Absent) or model_tools is not None:
            raise GenerationBackendDefect("NoModelTools resolved a provider tool publication")

        resume = execution.provider_resume
        if resume is None:
            turn = self._composition.provider.prepare_initial_turn(
                generation_id=request.generation_id,
                spec=request.spec,
                intent=request.intent,
                model_tools=model_tools,
            )
        else:
            turn = await self._prepare_provider_resume(
                execution=execution,
                resume=resume,
                model_tools=model_tools,
            )
        while True:
            terminal, proposals, continuation = await self._consume_provider_child(
                execution=execution,
                turn=turn,
            )
            if isinstance(continuation, Absent):
                if proposals:
                    raise GenerationBackendDefect(
                        "provider terminal omitted continuation for its tool proposals"
                    )
                return terminal
            if model_tools is None:
                raise GenerationBackendDefect(
                    "provider continuation exists without frozen model tools"
                )
            material = continuation.value
            if tuple(_proposal_call_id(item.proposal) for item in proposals) != (
                material.provider_call_ids
            ):
                raise GenerationBackendDefect(
                    "provider terminal continuation differs from observed proposals"
                )
            if (
                material.identity.successor_child_seq
                > model_tools.snapshot.run_limits.max_calls + 1
            ):
                raise GenerationBackendDefect(
                    "provider model/tool loop exceeded its frozen maximum call count"
                )
            results = await self._execute_provider_tools(
                execution=execution,
                source_child_seq=turn.turn_seq,
                proposals=tuple(proposal.proposal for proposal in proposals),
            )
            canonical_continuation = await execution.lifecycle.open_successor(material.identity)
            if not isinstance(canonical_continuation, bytes) or (
                provider_turn_continuation_fingerprint(canonical_continuation)
                != material.identity.canonical_fingerprint
            ):
                raise GenerationBackendDefect(
                    "opened provider continuation differs from committed canonical identity"
                )
            turn = self._composition.provider.prepare_successor_turn(
                generation_id=request.generation_id,
                spec=request.spec,
                intent=request.intent,
                source_turn_seq=material.identity.source_child_seq,
                canonical_continuation=canonical_continuation,
                tool_results=results,
                model_tools=model_tools,
            )

    async def _prepare_provider_resume(
        self,
        *,
        execution: GenerationBackendExecution,
        resume: ProviderResumeState,
        model_tools: ProviderModelTools | None,
    ) -> ProviderTurnRequest:
        request = execution.request
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
        if identity.successor_child_seq > model_tools.snapshot.run_limits.max_calls + 1:
            raise GenerationBackendDefect(
                "ProviderApi resume exceeds its frozen maximum call count"
            )
        decoded = decode_provider_turn_continuation(
            resume.canonical_bytes,
            spec=request.spec,
            expected_source_turn_seq=identity.source_child_seq,
            target=ProviderTarget(provider=dispatch.provider, model=dispatch.model_id),
            codec_id=dispatch.continuation_codec,
        )
        proposals = tuple(
            model_tools.publication.decode_tool_call(call) for call in decoded.tool_calls
        )
        results = await self._execute_provider_tools(
            execution=execution,
            source_child_seq=identity.source_child_seq,
            proposals=proposals,
        )
        return self._composition.provider.prepare_successor_turn(
            generation_id=request.generation_id,
            spec=request.spec,
            intent=request.intent,
            source_turn_seq=identity.source_child_seq,
            canonical_continuation=resume.canonical_bytes,
            tool_results=results,
            model_tools=model_tools,
        )

    async def _execute_provider_tools(
        self,
        *,
        execution: GenerationBackendExecution,
        source_child_seq: int,
        proposals: tuple[ToolCallResolution, ...],
    ) -> tuple[ProviderToolResult, ...]:
        results: list[ProviderToolResult] = []
        for proposal in proposals:
            observed = await execution.tool_executor.execute(
                BackendToolExecutionRequest(
                    generation_id=execution.request.generation_id,
                    child_seq=source_child_seq,
                    proposal=proposal,
                )
            )
            expected_call_id = _proposal_call_id(proposal)
            if observed.provider_call_id != expected_call_id:
                raise GenerationBackendDefect(
                    "ToolAuthority result differs from its provider proposal identity"
                )
            results.append(
                ProviderToolResult(
                    provider_call_id=observed.provider_call_id,
                    output=observed.output,
                    is_error=observed.is_error,
                )
            )
        return tuple(results)

    async def _consume_provider_child(
        self,
        *,
        execution: GenerationBackendExecution,
        turn: ProviderTurnRequest,
    ) -> tuple[
        BackendTerminal,
        tuple[BackendToolProposed, ...],
        Presence[ProviderContinuationMaterial],
    ]:
        child = _provider_child_dispatch(turn)
        await execution.lifecycle.arm_child(child)
        proposals: list[BackendToolProposed] = []
        async for native in self._composition.provider.stream_turn(
            turn,
            cancel=execution.cancellation,
        ):
            event = project_provider_generation_event(native)
            if isinstance(event, BackendToolProposed):
                proposals.append(event)
                continue
            if isinstance(native, ProviderTerminal):
                if not isinstance(event, BackendTerminal):
                    raise GenerationBackendDefect("provider terminal projection is not terminal")
                continuation = _provider_continuation_material(turn, native)
                proposed = BackendChildCompletion(
                    child=child,
                    terminal=event,
                    successor=continuation,
                )
                completed = _validate_effective_completion(
                    proposed,
                    await execution.lifecycle.complete_child(proposed),
                )
                event = completed.terminal
                for proposal in proposals:
                    await execution.observer.observe(proposal)
                await execution.observer.observe(event)
                return event, tuple(proposals), completed.successor
            await execution.observer.observe(event)
        raise GenerationBackendDefect("provider stream ended without terminal truth")


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


def _validate_effective_completion(
    proposed: BackendChildCompletion,
    completed: BackendChildCompletion,
) -> BackendChildCompletion:
    """Accept lifecycle-owned terminal resolution without successor substitution."""

    successor_is_exact = completed.successor == proposed.successor
    successor_was_dropped = isinstance(proposed.successor, Present) and isinstance(
        completed.successor,
        Absent,
    )
    if completed.child != proposed.child or not (successor_is_exact or successor_was_dropped):
        raise GenerationBackendDefect(
            "backend lifecycle changed child or continuation identity while completing"
        )
    return completed


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


def _proposal_call_id(proposal: ToolCallResolution) -> str:
    return proposal.provider_call_id


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
    "BackendToolExecutionRequest",
    "BackendToolExecutionResult",
    "BackendToolExecutor",
    "CodexAdmissionBinder",
    "CodexChildProjection",
    "CodexGenerationTransport",
    "GenerationBackend",
    "GenerationBackendComposition",
    "GenerationBackendCompositionRefused",
    "GenerationBackendDefect",
    "GenerationBackendExecution",
    "PreparedCodexChild",
    "ProviderContinuationIdentity",
    "ProviderContinuationMaterial",
    "ProviderResumeState",
    "ProviderGenerationTransport",
    "ProviderModelToolProjection",
]
