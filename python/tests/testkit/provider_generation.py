"""Controlled tool-bearing provider response for real generation-owner proofs."""

from __future__ import annotations

from collections.abc import AsyncGenerator, AsyncIterator
from dataclasses import dataclass
from uuid import UUID

from provider_runtime.registry import api_model_catalog
from provider_runtime.types import (
    Absent as RuntimeAbsent,
)
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
    TokenUsage,
    ToolCall,
    ToolCallDone,
)
from provider_runtime.types import (
    Present as RuntimePresent,
)

from nexus.schemas.presence import Present
from nexus.services.codex_generation_contract import GenerationFrame
from nexus.services.generation_backend import (
    BackendGenerationRequest,
    GenerationBackend,
    GenerationBackendComposition,
    PreparedCodexChild,
)
from nexus.services.generation_spec import (
    GenerationSpec,
)
from nexus.services.provider_generation_backend import (
    ProviderGenerationBackend,
    ProviderGenerationRuntime,
)
from nexus.services.provider_generation_contract import ProviderModelTools
from nexus.services.tool_runtime.composition import (
    FrozenToolOperation,
    compose_provider_model_tools,
    freeze_tool_plan_snapshot,
)


def tool_decision_generation_backend(
    operation: FrozenToolOperation,
) -> tuple[GenerationBackend, ToolDecisionPeer]:
    """Real generation composition around one controlled external provider boundary."""
    peer = ToolDecisionPeer()
    return provider_generation_backend(operation, peer), peer


def provider_generation_backend(
    operation: FrozenToolOperation, peer: ProviderGenerationRuntime
) -> GenerationBackend:
    """Keep production composition around the supplied external provider boundary."""
    return GenerationBackend(
        GenerationBackendComposition(
            codex=_UnusedCodex(),
            codex_projection=_UnusedCodexProjection(),
            provider=ProviderGenerationBackend(peer),
            provider_tools=_FrozenProviderTools(operation),
        )
    )


class ToolDecisionPeer:
    """External ProviderRuntime response seam: every paid terminal requests one invalid call."""

    def __init__(self) -> None:
        self.dispatches = 0

    async def stream(
        self, intent: GenerateIntent, *, cancel: CancelSignal | None = None
    ) -> AsyncIterator[RuntimeStreamEvent]:
        del cancel
        self.dispatches += 1
        call = ToolCall(
            id=f"original-call-{self.dispatches}", name=intent.tools[0].name, arguments={}
        )
        usage = TokenUsage(
            input_tokens=100,
            output_tokens=10,
            total_tokens=110,
            reasoning_tokens=RuntimeAbsent(),
            cache_read_input_tokens=RuntimeAbsent(),
            cache_write_input_tokens=RuntimeAbsent(),
        )
        meta = CallMeta(
            provider=intent.target.provider,
            model=intent.target.model,
            provider_request_id=RuntimePresent(f"paid-request-{self.dispatches}"),
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


@dataclass(frozen=True, slots=True)
class _FrozenProviderTools:
    operation: FrozenToolOperation

    def resolve(self, spec: GenerationSpec) -> ProviderModelTools | None:
        plan = spec.model_tool_plan_snapshot
        assert isinstance(plan, Present) and plan.value == freeze_tool_plan_snapshot(self.operation)
        return compose_provider_model_tools(self.operation)


class _UnusedCodex:
    def stream(self, *_args: object, **_kwargs: object) -> AsyncGenerator[GenerationFrame]:
        raise AssertionError("ProviderApi stop proof dispatched Codex")

    async def cancel(self, request_id: UUID) -> None:
        raise AssertionError(f"unused Codex request was cancelled: {request_id}")


class _UnusedCodexProjection:
    def prepare(self, request: BackendGenerationRequest) -> PreparedCodexChild:
        raise AssertionError(f"ProviderApi stop used Codex projection: {request.generation_id}")
