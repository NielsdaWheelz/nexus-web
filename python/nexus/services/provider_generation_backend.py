"""ProviderRuntime adapter for one frozen Nexus generation model turn."""

from __future__ import annotations

import asyncio
import hashlib
import time
from collections.abc import AsyncGenerator, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, assert_never
from uuid import UUID

import httpx
from provider_runtime import (
    AssistantMessage,
    ProviderTarget,
    SystemMessage,
    ToolResultMessage,
    UserMessage,
)
from provider_runtime import GenerateIntent as RuntimeGenerateIntent
from provider_runtime import TextOutput as RuntimeTextOutput
from provider_runtime.types import Absent as RuntimeAbsent
from provider_runtime.types import (
    CancelSignal,
    ContinuationDelta,
    PromptBlock,
    StreamOutcome,
    StreamStart,
    StrictJsonOutput,
    StructuredContent,
    Succeeded,
    TerminalEvent,
    TextContent,
    TextDelta,
    ToolCall,
    ToolCallDelta,
    ToolCallDone,
    ToolCallStart,
    UsageEvent,
    canonical_json_bytes,
    freeze_json_object,
)
from provider_runtime.types import Present as RuntimePresent

from nexus.config import Settings
from nexus.schemas.presence import Absent, Present
from nexus.services.generation_spec import (
    GenerationIntent,
    GenerationSpec,
    JsonSchemaOutput,
    ProviderApiSelection,
    ProviderDispatchTargetSnapshot,
    StrictJsonOutputSnapshot,
    TextOutput,
)
from nexus.services.llm_credentials import provider_generation_credentials
from nexus.services.provider_generation_contract import (
    ProviderGenerationDefect,
    ProviderGenerationEvent,
    ProviderModelTools,
    ProviderTerminal,
    ProviderTextDelta,
    ProviderToolProposed,
    ProviderToolResult,
    ProviderTurnContinuation,
    ProviderUsageObserved,
    decode_provider_turn_continuation,
    encode_provider_turn_continuation,
    provider_turn_continuation_fingerprint,
)

if TYPE_CHECKING:
    from provider_runtime import ProviderRuntime


@dataclass(frozen=True, slots=True)
class ProviderTurnRequest:
    """One independently ledgered and billable ProviderRuntime call."""

    generation_id: UUID
    turn_seq: int
    spec: GenerationSpec
    request_fingerprint: str
    route_request_identity: Mapping[str, object]
    runtime_intent: RuntimeGenerateIntent = field(repr=False)
    model_tools: ProviderModelTools | None = field(repr=False)


class ProviderGenerationBackend:
    """Lower and stream exact frozen ProviderApi turns without domain calls."""

    __slots__ = ("_runtime",)

    def __init__(self, runtime: ProviderRuntime) -> None:
        self._runtime = runtime

    def prepare_initial_turn(
        self,
        *,
        generation_id: UUID,
        spec: GenerationSpec,
        intent: GenerationIntent,
        model_tools: ProviderModelTools | None,
    ) -> ProviderTurnRequest:
        dispatch, selection = _frozen_request(spec, model_tools)
        target = ProviderTarget(provider=dispatch.provider, model=dispatch.model_id)
        return _turn_request(
            generation_id=generation_id,
            turn_seq=1,
            spec=spec,
            dispatch=dispatch,
            runtime_intent=RuntimeGenerateIntent(
                target=target,
                messages=(
                    SystemMessage(blocks=(PromptBlock(intent.instructions),)),
                    UserMessage(blocks=(PromptBlock(intent.input),)),
                ),
                max_output_tokens=spec.effective_output_budget_tokens,
                reasoning=selection.reasoning,
                tools=() if model_tools is None else model_tools.publication.tools,
                tool_choice="none" if model_tools is None else "auto",
                output=_runtime_output(intent),
                provider_options={},
            ),
            model_tools=model_tools,
            continuation_fingerprint=None,
            tool_results=(),
        )

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
    ) -> ProviderTurnRequest:
        dispatch, selection = _frozen_request(spec, model_tools)
        target = ProviderTarget(provider=dispatch.provider, model=dispatch.model_id)
        decoded = decode_provider_turn_continuation(
            canonical_continuation,
            spec=spec,
            expected_source_turn_seq=source_turn_seq,
            target=target,
            codec_id=dispatch.continuation_codec,
        )
        if tuple(result.provider_call_id for result in tool_results) != tuple(
            call.id for call in decoded.tool_calls
        ):
            raise ProviderGenerationDefect(
                origin="plan",
                message="provider successor requires one ordered result for every proposed call",
            )
        result_bytes = sum(len(result.output.encode("utf-8")) for result in tool_results)
        if result_bytes > model_tools.snapshot.run_limits.max_output_bytes:
            raise ProviderGenerationDefect(
                origin="plan",
                message="provider successor tool results exceed the frozen run output bound",
            )
        return _turn_request(
            generation_id=generation_id,
            turn_seq=source_turn_seq + 1,
            spec=spec,
            dispatch=dispatch,
            runtime_intent=RuntimeGenerateIntent(
                target=target,
                messages=(
                    SystemMessage(blocks=(PromptBlock(intent.instructions),)),
                    UserMessage(blocks=(PromptBlock(intent.input),)),
                    AssistantMessage(
                        text=decoded.assistant_text,
                        tool_calls=decoded.tool_calls,
                        continuation=decoded.native_continuation,
                    ),
                    *(
                        ToolResultMessage(
                            call_id=result.provider_call_id,
                            output=result.output,
                            is_error=result.is_error,
                        )
                        for result in tool_results
                    ),
                ),
                max_output_tokens=spec.effective_output_budget_tokens,
                reasoning=selection.reasoning,
                tools=model_tools.publication.tools,
                tool_choice="auto",
                output=_runtime_output(intent),
                provider_options={},
            ),
            model_tools=model_tools,
            continuation_fingerprint=provider_turn_continuation_fingerprint(canonical_continuation),
            tool_results=tool_results,
        )

    async def stream_turn(
        self, turn: ProviderTurnRequest, *, cancel: CancelSignal
    ) -> AsyncGenerator[ProviderGenerationEvent]:
        """Stream one bounded call; tool proposals publish only after success."""

        bounds = turn.spec.bounds
        source = self._runtime.stream(
            turn.runtime_intent,
            cancel=_DeadlineCancelSignal(
                deadline_at=time.monotonic() + bounds.transport_deadline_seconds, parent=cancel
            ),
        )
        expected_seq = 1
        stream_bytes = 0
        completed_calls: list[tuple[int, ToolCall]] = []
        observed_continuation: RuntimePresent[object] | RuntimeAbsent = RuntimeAbsent()
        last_usage = None
        terminal_seen = False
        try:
            async for envelope in source:
                if terminal_seen or envelope.seq != expected_seq:
                    raise ProviderGenerationDefect(
                        origin="provider_stream",
                        message="ProviderRuntime stream sequence is not contiguous",
                    )
                expected_seq += 1
                event = envelope.event
                match event:
                    case StreamStart() | ToolCallStart() | ToolCallDelta():
                        pass
                    case TextDelta(text=text):
                        stream_bytes += len(text.encode("utf-8"))
                        yield ProviderTextDelta(
                            turn_seq=turn.turn_seq, provider_seq=envelope.seq, text=text
                        )
                    case UsageEvent(usage=usage):
                        last_usage = usage
                        yield ProviderUsageObserved(
                            turn_seq=turn.turn_seq, provider_seq=envelope.seq, usage=usage
                        )
                    case ToolCallDone(tool_call=tool_call):
                        stream_bytes += len(
                            canonical_json_bytes(
                                freeze_json_object(
                                    tool_call.arguments, context="provider tool-call arguments"
                                )
                            )
                        )
                        completed_calls.append((envelope.seq, tool_call))
                    case ContinuationDelta(artifact=artifact):
                        if isinstance(observed_continuation, RuntimePresent):
                            raise ProviderGenerationDefect(
                                origin="provider_stream",
                                message="ProviderRuntime emitted more than one continuation",
                            )
                        observed_continuation = RuntimePresent(artifact)
                    case TerminalEvent(outcome=outcome):
                        terminal_seen = True
                        successor = _successor(
                            turn=turn,
                            outcome=outcome,
                            completed_calls=tuple(call for _seq, call in completed_calls),
                            observed_continuation=observed_continuation,
                        )
                        if isinstance(successor, Present):
                            if turn.model_tools is None:
                                raise ProviderGenerationDefect(
                                    origin="plan",
                                    message="tool-bearing provider terminal lacks frozen tools",
                                )
                            for provider_seq, call in completed_calls:
                                yield ProviderToolProposed(
                                    turn_seq=turn.turn_seq,
                                    provider_seq=provider_seq,
                                    proposal=turn.model_tools.publication.decode_tool_call(call),
                                )
                        if (
                            isinstance(outcome.meta.usage, RuntimePresent)
                            and outcome.meta.usage.value != last_usage
                        ):
                            yield ProviderUsageObserved(
                                turn_seq=turn.turn_seq,
                                provider_seq=envelope.seq,
                                usage=outcome.meta.usage.value,
                            )
                        yield ProviderTerminal(
                            turn_seq=turn.turn_seq,
                            provider_seq=envelope.seq,
                            outcome=outcome,
                            correlation=_correlation(outcome),
                            successor=successor,
                        )
                    case other:
                        assert_never(other)
                if stream_bytes > bounds.stream.max_stream_bytes:
                    raise ProviderGenerationDefect(
                        origin="provider_stream",
                        message="ProviderRuntime stream exceeded its frozen byte bound",
                    )
        finally:
            if isinstance(source, AsyncGenerator):
                await source.aclose()
        if not terminal_seen:
            raise ProviderGenerationDefect(
                origin="provider_stream",
                message="ProviderRuntime stream ended without its terminal truth",
            )


def build_provider_generation_backend(
    settings: Settings, client: httpx.AsyncClient
) -> ProviderGenerationBackend:
    """Wire credentials once at the process boundary."""

    from provider_runtime import Credentials, ProviderRuntime

    return ProviderGenerationBackend(
        ProviderRuntime(
            Credentials(
                **{
                    provider: credential.get_secret_value()
                    for provider, credential in provider_generation_credentials(settings).items()
                }
            ),
            http_client=client,
        )
    )


def _frozen_request(
    spec: GenerationSpec, model_tools: ProviderModelTools | None
) -> tuple[ProviderDispatchTargetSnapshot, ProviderApiSelection]:
    dispatch = spec.resolved_dispatch_target
    if not isinstance(dispatch, ProviderDispatchTargetSnapshot) or not isinstance(
        spec.selection, ProviderApiSelection
    ):
        raise ProviderGenerationDefect(
            origin="plan", message="provider backend received a non-ProviderApi generation"
        )
    if isinstance(spec.output_contract, StrictJsonOutputSnapshot) and model_tools is not None:
        raise ProviderGenerationDefect(
            origin="plan",
            message="ProviderRuntime does not support strict output and tools in one call",
        )
    return dispatch, spec.selection


def _runtime_output(intent: GenerationIntent) -> RuntimeTextOutput | StrictJsonOutput:
    if isinstance(intent.output, TextOutput):
        return RuntimeTextOutput()
    if isinstance(intent.output, JsonSchemaOutput):
        return StrictJsonOutput(name=intent.output.name, schema=intent.output.schema_)
    assert_never(intent.output)


def _turn_request(
    *,
    generation_id: UUID,
    turn_seq: int,
    spec: GenerationSpec,
    dispatch: ProviderDispatchTargetSnapshot,
    runtime_intent: RuntimeGenerateIntent,
    model_tools: ProviderModelTools | None,
    continuation_fingerprint: str | None,
    tool_results: tuple[ProviderToolResult, ...],
) -> ProviderTurnRequest:
    continuation_presence: dict[str, object] = (
        {"kind": "Present", "value": continuation_fingerprint}
        if continuation_fingerprint is not None
        else {"kind": "Absent"}
    )
    request_facts: dict[str, object] = {
        "schema_version": "nexus-provider-request.v1",
        "generation_id": str(generation_id),
        "generation_spec_fingerprint": spec.fingerprint,
        "turn_seq": turn_seq,
        "target": {"provider": dispatch.provider, "model": dispatch.model_id},
        "reasoning": spec.selection.reasoning,
        "max_output_tokens": spec.effective_output_budget_tokens,
        "tool_plan_revision": (
            {"kind": "Present", "value": model_tools.snapshot.plan_revision}
            if model_tools is not None
            else {"kind": "Absent"}
        ),
        "continuation_fingerprint": continuation_presence,
        "tool_results": [
            {
                "provider_call_id": result.provider_call_id,
                "output_sha256": hashlib.sha256(result.output.encode("utf-8")).hexdigest(),
                "is_error": result.is_error,
            }
            for result in tool_results
        ],
    }
    canonical = canonical_json_bytes(
        freeze_json_object(request_facts, context="provider request identity")
    )
    request_fingerprint = hashlib.sha256(b"nexus.provider-request.v1\0" + canonical).hexdigest()
    return ProviderTurnRequest(
        generation_id=generation_id,
        turn_seq=turn_seq,
        spec=spec,
        request_fingerprint=request_fingerprint,
        route_request_identity={
            "kind": "ProviderApi",
            "provider": dispatch.provider,
            "model_ref": dispatch.model_ref,
            "dispatch_model": dispatch.model_id,
            "reasoning": spec.selection.reasoning,
            "turn_seq": turn_seq,
            "generation_spec_fingerprint": spec.fingerprint,
            "request_fingerprint": request_fingerprint,
            "registry_revision": dispatch.registry_revision,
            "correlation": dispatch.correlation,
            "continuation_fingerprint": continuation_presence,
        },
        runtime_intent=runtime_intent,
        model_tools=model_tools,
    )


def _successor(
    *,
    turn: ProviderTurnRequest,
    outcome: object,
    completed_calls: tuple[ToolCall, ...],
    observed_continuation: RuntimePresent[object] | RuntimeAbsent,
) -> Present[ProviderTurnContinuation] | Absent:
    if not isinstance(outcome, Succeeded):
        if completed_calls:
            raise ProviderGenerationDefect(
                origin="provider_stream",
                message="provider proposed tools without a successful model turn",
            )
        return Absent()
    content = outcome.response.content
    if isinstance(content, StructuredContent):
        if completed_calls:
            raise ProviderGenerationDefect(
                origin="provider_stream", message="strict provider terminal carried tool proposals"
            )
        return Absent()
    if not isinstance(content, TextContent):
        assert_never(content)
    if tuple(content.tool_calls) != completed_calls:
        raise ProviderGenerationDefect(
            origin="provider_stream",
            message="provider tool stream differs from its terminal response",
        )
    if not content.tool_calls:
        return Absent()
    if observed_continuation != outcome.response.continuation:
        raise ProviderGenerationDefect(
            origin="provider_stream",
            message="provider continuation event differs from its terminal response",
        )
    dispatch = turn.spec.resolved_dispatch_target
    if not isinstance(dispatch, ProviderDispatchTargetSnapshot):
        raise ProviderGenerationDefect(
            origin="plan", message="provider turn lost its provider dispatch target"
        )
    return Present(
        value=encode_provider_turn_continuation(
            spec=turn.spec,
            source_turn_seq=turn.turn_seq,
            target=turn.runtime_intent.target,
            codec_id=dispatch.continuation_codec,
            assistant_text=content.text,
            tool_calls=content.tool_calls,
            native_continuation=outcome.response.continuation,
        )
    )


def _correlation(outcome: StreamOutcome) -> Present[str] | Absent:
    request_id = outcome.meta.provider_request_id
    if isinstance(request_id, RuntimeAbsent):
        return Absent()
    if not request_id.value or len(request_id.value.encode("utf-8")) > 1_024:
        raise ProviderGenerationDefect(
            origin="provider_stream", message="provider correlation id is outside its bound"
        )
    return Present(value=request_id.value)


class _DeadlineCancelSignal:
    """One structured cancellation signal combining caller and frozen deadline."""

    __slots__ = ("_deadline_at", "_parent")

    def __init__(self, *, deadline_at: float, parent: CancelSignal) -> None:
        self._deadline_at = deadline_at
        self._parent = parent

    def is_set(self) -> bool:
        return time.monotonic() >= self._deadline_at or self._parent.is_set()

    async def wait(self) -> bool:
        remaining = max(0.0, self._deadline_at - time.monotonic())
        tasks = {
            asyncio.create_task(asyncio.sleep(remaining)),
            asyncio.create_task(self._parent.wait()),
        }
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            return True
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
