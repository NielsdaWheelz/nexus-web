"""ProviderRuntime adapter for one frozen Nexus generation model turn."""

from __future__ import annotations

import asyncio
import hashlib
import time
from collections.abc import AsyncGenerator, AsyncIterator, Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Protocol, assert_never
from uuid import UUID

import httpx
from provider_runtime import (
    AssistantMessage,
    ProviderTarget,
    SystemMessage,
    ToolResultMessage,
    UserMessage,
)
from provider_runtime import (
    GenerateIntent as RuntimeGenerateIntent,
)
from provider_runtime import (
    TextOutput as RuntimeTextOutput,
)
from provider_runtime.types import (
    Absent as RuntimeAbsent,
)
from provider_runtime.types import (
    Cancelled,
    CancelSignal,
    CodecStreamEvent,
    ContinuationDelta,
    Failed,
    Incomplete,
    PromptBlock,
    RuntimeStreamEvent,
    StreamStart,
    StrictJsonOutput,
    StructuredContent,
    Succeeded,
    TerminalEvent,
    TextContent,
    TextDelta,
    TokenUsage,
    ToolCall,
    ToolCallDelta,
    ToolCallDone,
    ToolCallStart,
    UsageEvent,
    canonical_json_bytes,
    freeze_json_object,
)
from provider_runtime.types import (
    Present as RuntimePresent,
)

from nexus.config import GenerationApiProvider, Settings
from nexus.schemas.presence import Absent, Present
from nexus.services.generation_intent import (
    GenerationIntent,
    JsonSchemaOutput,
    TextOutput,
    validate_intent_bounds,
)
from nexus.services.generation_selection import ProviderApiSelection
from nexus.services.generation_spec import (
    GenerationSpec,
    ProviderDispatchTargetSnapshot,
    StrictJsonOutputSnapshot,
    TextOutputSnapshot,
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


class ProviderGenerationRuntime(Protocol):
    """The exact ProviderRuntime stream surface consumed by this adapter."""

    def stream(
        self,
        intent: RuntimeGenerateIntent,
        *,
        cancel: CancelSignal | None = None,
    ) -> AsyncIterator[RuntimeStreamEvent]: ...


@dataclass(frozen=True, slots=True)
class ProviderTurnRequest:
    """One independently ledgered/billable ProviderRuntime call."""

    generation_id: UUID
    turn_seq: int
    spec: GenerationSpec
    request_fingerprint: str
    route_request_identity: Mapping[str, object]
    runtime_intent: RuntimeGenerateIntent = field(repr=False)
    model_tools: ProviderModelTools | None = field(repr=False)
    continuation_fingerprint: str | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if self.turn_seq < 1:
            raise ValueError("provider model turn sequence must be positive")
        if len(self.request_fingerprint) != 64:
            raise ValueError("provider model turn request fingerprint must be SHA-256")


@dataclass(frozen=True, slots=True)
class ProviderGenerationWiring:
    """Composition-owned optional endpoint seam; production supplies ``None``."""

    endpoint_overrides: Mapping[GenerationApiProvider, str] | None

    def __post_init__(self) -> None:
        if self.endpoint_overrides is not None:
            object.__setattr__(
                self,
                "endpoint_overrides",
                MappingProxyType(dict(self.endpoint_overrides)),
            )


class ProviderGenerationBackend:
    """Lower and stream exact frozen ProviderApi turns without domain calls."""

    __slots__ = ("_runtime",)

    def __init__(self, runtime: ProviderGenerationRuntime) -> None:
        self._runtime = runtime

    def prepare_initial_turn(
        self,
        *,
        generation_id: UUID,
        spec: GenerationSpec,
        intent: GenerationIntent,
        model_tools: ProviderModelTools | None,
    ) -> ProviderTurnRequest:
        target, selection = _validate_frozen_request(spec, intent, model_tools)
        runtime_intent = RuntimeGenerateIntent(
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
        )
        return _turn_request(
            generation_id=generation_id,
            turn_seq=1,
            spec=spec,
            runtime_intent=runtime_intent,
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
        target, selection = _validate_frozen_request(spec, intent, model_tools)
        decoded = decode_provider_turn_continuation(
            canonical_continuation,
            spec=spec,
            expected_source_turn_seq=source_turn_seq,
            target=target,
            codec_id=_provider_dispatch(spec).continuation_codec,
        )
        expected_ids = tuple(call.id for call in decoded.tool_calls)
        actual_ids = tuple(result.provider_call_id for result in tool_results)
        if actual_ids != expected_ids:
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
        runtime_intent = RuntimeGenerateIntent(
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
        )
        return _turn_request(
            generation_id=generation_id,
            turn_seq=source_turn_seq + 1,
            spec=spec,
            runtime_intent=runtime_intent,
            model_tools=model_tools,
            continuation_fingerprint=provider_turn_continuation_fingerprint(canonical_continuation),
            tool_results=tool_results,
        )

    async def stream_turn(
        self,
        turn: ProviderTurnRequest,
        *,
        cancel: CancelSignal | None = None,
    ) -> AsyncGenerator[ProviderGenerationEvent]:
        """Stream one bounded call; tool proposals publish only after success."""

        bounds = turn.spec.bounds
        deadline = _DeadlineCancelSignal(
            deadline_at=time.monotonic() + bounds.transport_deadline_seconds,
            parent=cancel,
        )
        source = self._runtime.stream(turn.runtime_intent, cancel=deadline)
        expected_provider_seq = 1
        frames = 0
        stream_bytes = 0
        completed_calls: list[tuple[int, ToolCall]] = []
        observed_continuation = RuntimeAbsent()
        last_observed_usage: TokenUsage | None = None
        terminal_seen = False
        try:
            async for envelope in source:
                if terminal_seen:
                    raise ProviderGenerationDefect(
                        origin="provider_stream",
                        message="ProviderRuntime emitted an event after terminal",
                    )
                if envelope.seq != expected_provider_seq:
                    raise ProviderGenerationDefect(
                        origin="provider_stream",
                        message="ProviderRuntime stream sequence is not contiguous",
                    )
                expected_provider_seq += 1
                frames += 1
                frame_bytes = _runtime_event_size(envelope.event)
                stream_bytes += frame_bytes
                if (
                    frames > bounds.stream.max_frames
                    or frame_bytes > bounds.stream.max_frame_bytes
                    or stream_bytes > bounds.stream.max_stream_bytes
                ):
                    raise ProviderGenerationDefect(
                        origin="provider_stream",
                        message="ProviderRuntime stream exceeded its frozen GenerationSpec bounds",
                    )
                event = envelope.event
                match event:
                    case StreamStart():
                        pass
                    case TextDelta(text=text):
                        yield ProviderTextDelta(
                            turn_seq=turn.turn_seq,
                            provider_seq=envelope.seq,
                            text=text,
                        )
                    case UsageEvent(usage=usage):
                        last_observed_usage = usage
                        yield ProviderUsageObserved(
                            turn_seq=turn.turn_seq,
                            provider_seq=envelope.seq,
                            usage=usage,
                        )
                    case ToolCallStart() | ToolCallDelta():
                        pass
                    case ToolCallDone(tool_call=tool_call):
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
                        _validate_terminal(turn, outcome)
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
                                    message="tool-bearing provider terminal lacks frozen model tools",
                                )
                            for provider_seq, call in completed_calls:
                                yield ProviderToolProposed(
                                    turn_seq=turn.turn_seq,
                                    provider_seq=provider_seq,
                                    proposal=turn.model_tools.publication.decode_tool_call(call),
                                )
                        if (
                            isinstance(outcome.meta.usage, RuntimePresent)
                            and outcome.meta.usage.value != last_observed_usage
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
        finally:
            if isinstance(source, AsyncGenerator):
                await source.aclose()
        if not terminal_seen:
            raise ProviderGenerationDefect(
                origin="provider_stream",
                message="ProviderRuntime stream ended without its terminal truth",
            )


def build_provider_generation_backend(
    settings: Settings,
    client: httpx.AsyncClient,
    *,
    wiring: ProviderGenerationWiring,
) -> ProviderGenerationBackend:
    """Wire credentials and explicit endpoints once at the process boundary."""

    from provider_runtime import Credentials, ProviderRuntime

    endpoint_overrides = wiring.endpoint_overrides
    if endpoint_overrides is not None and set(endpoint_overrides) != set(
        settings.generation_api_provider_list
    ):
        raise ValueError("provider endpoint overrides must name exactly configured providers")
    runtime = ProviderRuntime(
        Credentials(
            **{
                provider: credential.get_secret_value()
                for provider, credential in provider_generation_credentials(settings).items()
            }
        ),
        http_client=client,
        endpoint_overrides=endpoint_overrides,
    )
    return ProviderGenerationBackend(runtime)


def _validate_frozen_request(
    spec: GenerationSpec,
    intent: GenerationIntent,
    model_tools: ProviderModelTools | None,
) -> tuple[ProviderTarget, ProviderApiSelection]:
    if not isinstance(spec.selection, ProviderApiSelection):
        raise ProviderGenerationDefect(
            origin="plan",
            message="provider backend received a non-ProviderApi GenerationSpec",
        )
    dispatch = _provider_dispatch(spec)
    if spec.selection.model_ref != dispatch.model_ref or spec.provider_registry_revision != Present(
        value=dispatch.registry_revision
    ):
        raise ProviderGenerationDefect(
            origin="plan",
            message="provider selection differs from its frozen dispatch target",
        )
    if (
        hashlib.sha256(intent.instructions.encode("utf-8")).hexdigest()
        != (spec.instructions_digest)
        or hashlib.sha256(intent.input.encode("utf-8")).hexdigest() != spec.input_digest
    ):
        raise ProviderGenerationDefect(
            origin="intent",
            message="provider intent differs from the frozen prompt identity",
        )
    validate_intent_bounds(
        intent,
        instructions_max_bytes=spec.bounds.instructions_max_bytes,
        input_max_bytes=spec.bounds.input_max_bytes,
    )
    if isinstance(spec.model_tool_plan_snapshot, Present):
        if model_tools is None or model_tools.snapshot != spec.model_tool_plan_snapshot.value:
            raise ProviderGenerationDefect(
                origin="plan",
                message="provider tool publication differs from the frozen GenerationSpec",
            )
    elif not isinstance(spec.model_tool_plan_snapshot, Absent) or model_tools is not None:
        raise ProviderGenerationDefect(
            origin="plan",
            message="NoModelTools provider turn received a tool publication",
        )
    runtime_output = _runtime_output(intent)
    if isinstance(spec.output_contract, TextOutputSnapshot):
        if not isinstance(runtime_output, RuntimeTextOutput):
            raise ProviderGenerationDefect(
                origin="intent",
                message="provider output differs from the frozen Text contract",
            )
    elif isinstance(spec.output_contract, StrictJsonOutputSnapshot):
        if not isinstance(runtime_output, StrictJsonOutput) or (
            runtime_output.name != spec.output_contract.name
            or dict(runtime_output.schema) != spec.output_contract.json_schema
        ):
            raise ProviderGenerationDefect(
                origin="intent",
                message="provider output differs from the frozen strict contract",
            )
        if model_tools is not None:
            raise ProviderGenerationDefect(
                origin="plan",
                message="ProviderRuntime does not support strict output and tools in one call",
            )
    else:
        assert_never(spec.output_contract)
    return ProviderTarget(provider=dispatch.provider, model=dispatch.model_id), spec.selection


def _provider_dispatch(spec: GenerationSpec) -> ProviderDispatchTargetSnapshot:
    dispatch = spec.resolved_dispatch_target
    if not isinstance(dispatch, ProviderDispatchTargetSnapshot):
        raise ProviderGenerationDefect(
            origin="plan",
            message="provider backend received a non-provider dispatch target",
        )
    return dispatch


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
    runtime_intent: RuntimeGenerateIntent,
    model_tools: ProviderModelTools | None,
    continuation_fingerprint: str | None,
    tool_results: tuple[ProviderToolResult, ...],
) -> ProviderTurnRequest:
    dispatch = _provider_dispatch(spec)
    request_facts = {
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
        "continuation_fingerprint": (
            {"kind": "Present", "value": continuation_fingerprint}
            if continuation_fingerprint is not None
            else {"kind": "Absent"}
        ),
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
    request_fingerprint = _hash(canonical)
    route_request_identity = freeze_json_object(
        {
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
            "continuation_fingerprint": request_facts["continuation_fingerprint"],
        },
        context="provider route request identity",
    )
    return ProviderTurnRequest(
        generation_id=generation_id,
        turn_seq=turn_seq,
        spec=spec,
        request_fingerprint=request_fingerprint,
        route_request_identity=route_request_identity,
        runtime_intent=runtime_intent,
        model_tools=model_tools,
        continuation_fingerprint=continuation_fingerprint,
    )


def _validate_terminal(turn: ProviderTurnRequest, outcome: object) -> None:
    if not isinstance(outcome, Succeeded | Incomplete | Cancelled | Failed):
        raise ProviderGenerationDefect(
            origin="provider_stream",
            message="ProviderRuntime emitted a terminal outside its closed stream union",
        )
    dispatch = _provider_dispatch(turn.spec)
    if (
        outcome.meta.provider != dispatch.provider
        or outcome.meta.model != dispatch.model_id
        or outcome.meta.registry_revision != dispatch.registry_revision
    ):
        raise ProviderGenerationDefect(
            origin="provider_stream",
            message="ProviderRuntime terminal identity differs from the frozen dispatch target",
        )
    if dispatch.correlation == "none" and not isinstance(
        outcome.meta.provider_request_id, RuntimeAbsent
    ):
        raise ProviderGenerationDefect(
            origin="provider_stream",
            message="provider emitted correlation despite a frozen none contract",
        )
    if dispatch.correlation != "none" and not isinstance(
        outcome.meta.provider_request_id, RuntimePresent
    ):
        raise ProviderGenerationDefect(
            origin="provider_stream",
            message="provider omitted its frozen correlation evidence",
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
                origin="provider_stream",
                message="strict provider terminal carried tool proposals",
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
    dispatch = _provider_dispatch(turn.spec)
    successor = encode_provider_turn_continuation(
        spec=turn.spec,
        source_turn_seq=turn.turn_seq,
        target=turn.runtime_intent.target,
        codec_id=dispatch.continuation_codec,
        assistant_text=content.text,
        tool_calls=content.tool_calls,
        native_continuation=outcome.response.continuation,
    )
    return Present(value=successor)


def _correlation(outcome: object) -> Present[str] | Absent:
    if not isinstance(outcome, Succeeded | Incomplete | Cancelled | Failed):
        raise TypeError("provider terminal outcome is not closed")
    request_id = outcome.meta.provider_request_id
    if isinstance(request_id, RuntimePresent):
        if not request_id.value or len(request_id.value.encode("utf-8")) > 1_024:
            raise ProviderGenerationDefect(
                origin="provider_stream",
                message="provider correlation id is outside its bound",
            )
        return Present(value=request_id.value)
    if isinstance(request_id, RuntimeAbsent):
        return Absent()
    assert_never(request_id)


def _runtime_event_size(event: CodecStreamEvent) -> int:
    match event:
        case StreamStart():
            return 0
        case TextDelta(text=text):
            return len(text.encode("utf-8"))
        case ToolCallStart(call_id=call_id, name=name):
            return len(call_id.encode("utf-8")) + len(name.encode("utf-8"))
        case ToolCallDelta(call_id=call_id, arguments_delta=arguments):
            return len(call_id.encode("utf-8")) + len(arguments.encode("utf-8"))
        case ToolCallDone(tool_call=call):
            return _tool_call_size(call)
        case ContinuationDelta(artifact=artifact):
            from provider_runtime.continuation import encode_continuation

            return len(encode_continuation(artifact))
        case UsageEvent(usage=usage):
            return len(repr(usage).encode("utf-8"))
        case TerminalEvent(outcome=outcome):
            size = 4_096 + len(repr(outcome.meta).encode("utf-8"))
            if isinstance(outcome, Succeeded):
                content = outcome.response.content
                if isinstance(content, TextContent):
                    size += len(content.text.encode("utf-8")) + sum(
                        _tool_call_size(call) for call in content.tool_calls
                    )
                elif isinstance(content, StructuredContent):
                    size += len(content.text.encode("utf-8")) + len(
                        canonical_json_bytes(
                            freeze_json_object(
                                content.payload, context="structured provider output"
                            )
                        )
                    )
                else:
                    assert_never(content)
            else:
                size += len(repr(outcome).encode("utf-8"))
            return size
        case other:
            assert_never(other)


def _tool_call_size(call: ToolCall) -> int:
    return (
        len(call.id.encode("utf-8"))
        + len(call.name.encode("utf-8"))
        + len(
            canonical_json_bytes(
                freeze_json_object(call.arguments, context="provider tool-call arguments")
            )
        )
    )


class _DeadlineCancelSignal:
    """One structured cancellation signal combining caller and frozen deadline."""

    __slots__ = ("_deadline_at", "_parent")

    def __init__(self, *, deadline_at: float, parent: CancelSignal | None) -> None:
        self._deadline_at = deadline_at
        self._parent = parent

    def is_set(self) -> bool:
        return time.monotonic() >= self._deadline_at or (
            self._parent is not None and self._parent.is_set()
        )

    async def wait(self) -> bool:
        remaining = max(0.0, self._deadline_at - time.monotonic())
        if self._parent is None:
            await asyncio.sleep(remaining)
            return True
        deadline_task = asyncio.create_task(asyncio.sleep(remaining))
        parent_task = asyncio.create_task(self._parent.wait())
        tasks = {deadline_task, parent_task}
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            return True
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)


def _hash(value: bytes) -> str:
    return hashlib.sha256(b"nexus.provider-request.v1\0" + value).hexdigest()


__all__ = [
    "ProviderGenerationBackend",
    "ProviderGenerationRuntime",
    "ProviderGenerationWiring",
    "ProviderTurnRequest",
    "build_provider_generation_backend",
]
