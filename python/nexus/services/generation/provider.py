"""One provider API generation on the kernel's ``run_generation`` loop, held in memory.

The kernel owns loop order: proposals equal continuation calls, a stop is
checked between tool calls, and a stop is never a synthetic provider terminal.
The lifecycle hooks it calls to make turns durable record nothing here: this
host is transient, as kernel ADR 0012 states for native turns; a dead process
loses the generation and its caller reruns or fails it.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import aclosing
from typing import TYPE_CHECKING, Any, cast

import httpx
from llm_agent_kernel.generation import (
    GenerationCompleted,
    GenerationContinuation,
    GenerationObservation,
    GenerationProposal,
    GenerationTerminal,
    GenerationToolCall,
    GenerationToolResult,
    GenerationTurn,
    run_generation,
)
from provider_runtime import (
    ContinueGeneration,
    GenerateIntent,
    PromptBlock,
    ProviderTarget,
    SystemMessage,
    ToolResultMessage,
    UserMessage,
)
from provider_runtime import TextOutput as RuntimeTextOutput
from provider_runtime.tool_adapter import (
    CanonicalToolCall,
    RejectedToolArguments,
    ToolCallResolution,
    ToolPublication,
    lower_tools,
)
from provider_runtime.types import (
    Cancelled,
    CancelSignal,
    ContinuationArtifact,
    ContinuationTooLarge,
    Failed,
    Incomplete,
    InvalidStructuredOutput,
    InvalidToolArguments,
    ProviderContextTooLarge,
    ProviderRateLimit,
    ProviderRequest,
    ProviderTimeout,
    StreamOutcome,
    Succeeded,
    TerminalEvent,
    TextContent,
    ToolCall,
    ToolCallDone,
    TransientExhausted,
)
from provider_runtime.types import Present as RuntimePresent
from provider_runtime.types import TextDelta as RuntimeTextDelta

from nexus.config import Settings
from nexus.services.generation.contract import (
    FailureCode,
    GenerationIntent,
    GenerationUsage,
    OnEvent,
    RouteResult,
    TextDelta,
    ToolCalling,
    usage_of,
)
from nexus.services.generation.policy import PROVIDER_MAX_TURNS

if TYPE_CHECKING:
    from provider_runtime import ProviderRuntime

    from nexus.services.generation.catalog import ProviderTarget as RowTarget
    from nexus.services.tool_authority import GenerationToolExecutor
    from nexus.services.tool_runtime.catalog import FrozenToolOperation

type _Turn = GenerationTurn[ProviderRequest]
type _Frame = (
    GenerationObservation[TextDelta]
    | GenerationProposal[ToolCallResolution, ToolCalling]
    | GenerationTerminal[StreamOutcome, ContinuationArtifact, ToolCallResolution]
)


def build_provider_runtime(settings: Settings, client: httpx.AsyncClient) -> ProviderRuntime | None:
    """Wire the configured operator keys once; settings already refused a missing one."""

    from provider_runtime import Credentials, ProviderRuntime

    keys = {
        "openai": settings.openai_generation_api_key,
        "anthropic": settings.anthropic_generation_api_key,
        "gemini": settings.gemini_generation_api_key,
        "deepseek": settings.deepseek_generation_api_key,
        "xai": settings.xai_generation_api_key,
    }
    configured = settings.generation_api_provider_list
    if not configured:
        return None
    credentials: dict[str, Any] = {
        provider: cast(Any, keys[provider]).get_secret_value() for provider in configured
    }
    return ProviderRuntime(Credentials(**credentials), http_client=client)


async def run_provider(
    runtime: ProviderRuntime,
    *,
    target: RowTarget,
    reasoning: str,
    intent: GenerationIntent,
    max_output_tokens: int,
    operation: FrozenToolOperation,
    executor: GenerationToolExecutor,
    stopped: asyncio.Event,
    on_event: OnEvent,
) -> RouteResult:
    publication = lower_tools(ToolPublication(plan=operation.plan, revealed_targets=()))
    loop = _Loop(runtime, publication.decode_tool_call, executor, on_event)
    start = GenerateIntent(
        target=ProviderTarget(provider=target.provider, model=target.model_id),
        messages=(
            SystemMessage(blocks=(PromptBlock(intent.instructions),)),
            UserMessage(blocks=(PromptBlock(intent.input),)),
        ),
        max_output_tokens=max_output_tokens,
        reasoning=reasoning,
        tools=publication.tools,
        tool_choice="auto",
        output=RuntimeTextOutput(),
        provider_options={},
    )
    result = await run_generation(
        start=GenerationTurn[ProviderRequest](1, start),
        driver=loop,
        lifecycle=loop,
        tools=loop,
        observer=loop,
        cancellation=stopped,
        max_turns=PROVIDER_MAX_TURNS,
    )
    evidence: dict[str, Any] = {"turns": len(loop.texts), "provider_request_ids": loop.request_ids}
    if not isinstance(result, GenerationCompleted):
        if result.reason == "turn_limit":
            detail = f"stopped at its {PROVIDER_MAX_TURNS}-turn limit"
            return RouteResult("failed", None, loop.usage, "output_limit", detail, evidence)
        return RouteResult("cancelled", None, loop.usage, None, "", evidence)
    outcome = cast(StreamOutcome, result.terminal)
    if isinstance(outcome, Succeeded):
        content = outcome.response.content
        if not isinstance(content, TextContent) or content.text != "".join(loop.texts[-1]):
            raise AssertionError("the final provider turn differs from its streamed text")
        output = "".join("".join(turn) for turn in loop.texts)
        return RouteResult("succeeded", output, loop.usage, None, "", evidence)
    if isinstance(outcome, Cancelled):
        return RouteResult("cancelled", None, loop.usage, None, "", evidence)
    code, detail = _failure(outcome)
    return RouteResult("failed", None, loop.usage, code, detail, evidence)


def _failure(outcome: Incomplete | Failed) -> tuple[FailureCode, str]:
    if isinstance(outcome, Incomplete):
        if outcome.reason == "max_output_tokens":
            return "output_limit", "the provider stopped at its output limit"
        return "content_filtered", f"the provider filtered the answer ({outcome.status})"
    failure = outcome.failure
    if isinstance(failure, ProviderContextTooLarge):
        return "context_too_large", "the provider refused the context as too large"
    if isinstance(failure, ContinuationTooLarge):
        return "output_limit", "the tool turn exceeds its continuation bound"
    if isinstance(failure, InvalidToolArguments | InvalidStructuredOutput):
        return "invalid_output", failure.safe_detail
    assert isinstance(failure, TransientExhausted)
    cause = failure.cause
    detail = f"{type(cause).__name__} after {failure.attempts} attempts"
    if isinstance(cause, ProviderRateLimit):
        return "rate_limited", detail
    if isinstance(cause, ProviderTimeout):
        return "timeout", detail
    return "runtime_unavailable", detail


class _Loop:
    """Driver, tools and observer of one generation; a lifecycle that holds nothing."""

    def __init__(
        self,
        runtime: ProviderRuntime,
        decode: Callable[[ToolCall], ToolCallResolution],
        executor: GenerationToolExecutor,
        on_event: OnEvent,
    ) -> None:
        self._runtime = runtime
        self._decode = decode
        self._executor = executor
        self._on_event = on_event
        self.texts: list[list[str]] = []
        self.usage: GenerationUsage | None = None
        self.request_ids: list[str] = []

    async def stream(
        self, turn: _Turn, *, arm: Callable[[], Awaitable[None]], cancellation: CancelSignal
    ) -> AsyncGenerator[_Frame]:
        await arm()
        text: list[str] = []
        self.texts.append(text)
        calls: list[ToolCall] = []
        sequence = 0
        source = cast(AsyncGenerator[Any], self._runtime.stream(turn.request, cancel=cancellation))
        async with aclosing(source):
            async for envelope in source:
                event = envelope.event
                sequence += 1
                if isinstance(event, RuntimeTextDelta):
                    text.append(event.text)
                    yield GenerationObservation(sequence, TextDelta(event.text))
                elif isinstance(event, ToolCallDone):
                    calls.append(event.tool_call)
                elif isinstance(event, TerminalEvent):
                    outcome = event.outcome
                    proposals = tuple(
                        GenerationToolCall(call.id, self._decode(call)) for call in calls
                    )
                    if not isinstance(outcome, Succeeded) or not proposals:
                        yield GenerationTerminal(sequence, outcome)
                        return
                    continuation = outcome.response.continuation
                    if not isinstance(continuation, RuntimePresent):
                        raise AssertionError("a tool-calling provider turn has no continuation")
                    for proposal in proposals:
                        sequence += 1
                        yield GenerationProposal(
                            sequence, proposal, ToolCalling(_name(proposal.payload))
                        )
                    yield GenerationTerminal(
                        sequence + 1,
                        outcome,
                        GenerationContinuation(turn.ordinal, continuation.value, proposals),
                    )
                    return

    def successor(
        self,
        continuation: GenerationContinuation[ContinuationArtifact, ToolCallResolution],
        results: tuple[GenerationToolResult[ToolResultMessage], ...],
    ) -> _Turn:
        return GenerationTurn(
            continuation.source_ordinal + 1,
            ContinueGeneration(
                continuation=continuation.payload,
                tool_results=tuple(result.payload for result in results),
            ),
        )

    async def arm(self, turn: _Turn) -> None:
        del turn

    async def record_terminal(self, turn: _Turn, terminal: object) -> None:
        del turn, terminal

    async def resolve_terminal[T](self, turn: _Turn, terminal: T) -> T:
        del turn
        return terminal

    async def open(self, continuation: object) -> None:
        del continuation

    async def execute(
        self, source_ordinal: int, call: GenerationToolCall[ToolCallResolution]
    ) -> GenerationToolResult[ToolResultMessage]:
        await self._on_event(ToolCalling(_name(call.payload)))
        output = await self._executor.execute(call.payload, turn=source_ordinal)
        return GenerationToolResult(
            call.call_id, ToolResultMessage(output.call_id, output.output, output.is_error)
        )

    async def observe(self, event: object) -> None:
        if isinstance(event, TextDelta):
            await self._on_event(event)
        elif isinstance(event, Succeeded | Incomplete | Cancelled | Failed):
            if isinstance(event.meta.usage, RuntimePresent):
                usage = usage_of(event.meta.usage.value)
                self.usage = usage if self.usage is None else self.usage.plus(usage)
            if isinstance(event.meta.provider_request_id, RuntimePresent):
                self.request_ids.append(event.meta.provider_request_id.value)


def _name(resolution: ToolCallResolution) -> str:
    if isinstance(resolution, CanonicalToolCall | RejectedToolArguments):
        return str(resolution.tool_id)
    return resolution.raw_name
