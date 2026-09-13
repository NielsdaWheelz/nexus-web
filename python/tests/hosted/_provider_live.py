from __future__ import annotations

import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import httpx
from provider_runtime import (
    Absent,
    CallOutcome,
    Credentials,
    EmbeddingCall,
    GenerateIntent,
    Incomplete,
    Present,
    PromptBlock,
    ProviderRuntime,
    ProviderTarget,
    ReasoningLevel,
    RuntimeStreamEvent,
    StreamStart,
    Succeeded,
    SystemMessage,
    TerminalEvent,
    TextOutput,
    UserMessage,
    estimate_cost,
)
from provider_runtime.registry import REGISTRY_REVISION, resolve_target
from provider_runtime.types import RetryPolicy

from nexus_test_control.provider_budget import PaidCallBudget

# Every release operation is a fixed, tiny request. The reservation is deliberately
# much larger than its configured output ceiling without recreating the retired
# Nexus provider-pricing/accounting path; terminal cost comes only from v2 CallMeta.
CONSERVATIVE_OPERATION_EXPOSURE_USD_MICROS = 10_000
SINGLE_ATTEMPT_RETRY = RetryPolicy(
    max_attempts=1,
    initial_delay_s=0,
    max_delay_s=0,
    jitter_s=0,
    deadline_s=Absent(),
)


@dataclass(frozen=True, slots=True)
class ChatResult:
    target: str
    status: str
    attempts: int
    usage: dict[str, int]
    estimated_cost_usd_micros: int
    conservative_exposure_usd_micros: int


class OneAttemptPerOperation:
    def __init__(self) -> None:
        self._active: str | None = None
        self.attempts: dict[str, int] = {}

    @contextmanager
    def operation(self, operation_id: str) -> Iterator[None]:
        if self._active is not None or operation_id in self.attempts:
            raise AssertionError(f"duplicate or overlapping provider operation: {operation_id}")
        self._active = operation_id
        self.attempts[operation_id] = 0
        try:
            yield
        finally:
            self._active = None

    async def on_request(self, _request: httpx.Request) -> None:
        if self._active is None:
            raise AssertionError("provider request escaped its declared operation")
        self.attempts[self._active] += 1
        if self.attempts[self._active] > 1:
            raise AssertionError(f"provider operation retried: {self._active}")


def provider_credentials_from_environment() -> Credentials:
    """Build the five product credentials once for the hosted runtime."""

    return Credentials(
        openai=os.environ["OPENAI_API_KEY"],
        anthropic=os.environ["ANTHROPIC_API_KEY"],
        gemini=os.environ["GEMINI_API_KEY"],
        moonshot=os.environ["MOONSHOT_API_KEY"],
        deepseek=os.environ["DEEPSEEK_API_KEY"],
        openrouter=None,
        xai=None,
    )


def single_attempt_runtime(
    credentials: Credentials,
    client: httpx.AsyncClient,
) -> ProviderRuntime:
    return ProviderRuntime(credentials, retry=SINGLE_ATTEMPT_RETRY, http_client=client)


def certification_intent(
    target: ProviderTarget,
    reasoning: ReasoningLevel,
    *,
    max_output_tokens: int,
) -> GenerateIntent:
    row = resolve_target(target)
    if max_output_tokens <= 0 or max_output_tokens > row.max_output_tokens:
        raise AssertionError(f"invalid hosted output ceiling for {row.ref!r}")
    return GenerateIntent(
        target=target,
        messages=(
            SystemMessage(blocks=(PromptBlock(text="Nexus release provider certification."),)),
            UserMessage(blocks=(PromptBlock(text="Reply with ok."),)),
        ),
        max_output_tokens=max_output_tokens,
        reasoning=reasoning,
        tools=(),
        tool_choice="none",
        output=TextOutput(),
    )


async def run_bounded_chat(
    runtime: ProviderRuntime,
    guard: OneAttemptPerOperation,
    budget: PaidCallBudget,
    intent: GenerateIntent,
    *,
    operation: str = "generate",
) -> tuple[CallOutcome, ChatResult]:
    """Dispatch one v2 intent under the shared attempt and terminal-cost oracle."""

    target = intent.target
    operation_id = f"{operation}:{target.provider}/{target.model}"
    budget.reserve(operation_id, CONSERVATIVE_OPERATION_EXPOSURE_USD_MICROS)
    with guard.operation(operation_id):
        outcome = await runtime.generate(intent)
    return outcome, terminal_result(outcome, intent, guard, budget, operation_id)


async def run_bounded_stream(
    runtime: ProviderRuntime,
    guard: OneAttemptPerOperation,
    budget: PaidCallBudget,
    intent: GenerateIntent,
) -> tuple[CallOutcome, ChatResult]:
    """Consume one v2 stream through its terminal evidence under the shared guard."""

    target = intent.target
    operation_id = f"stream:{target.provider}/{target.model}"
    budget.reserve(operation_id, CONSERVATIVE_OPERATION_EXPOSURE_USD_MICROS)
    events: list[RuntimeStreamEvent] = []
    with guard.operation(operation_id):
        async for event in runtime.stream(intent):
            events.append(event)
    assert events, "live stream produced no runtime envelopes"
    assert isinstance(events[0].event, StreamStart), "live stream did not begin with StreamStart"
    assert all(event.seq == index for index, event in enumerate(events, start=1))
    terminals = [event.event for event in events if isinstance(event.event, TerminalEvent)]
    assert len(terminals) == 1 and isinstance(events[-1].event, TerminalEvent), (
        "live stream did not end with exactly one TerminalEvent"
    )
    outcome = terminals[0].outcome
    return outcome, terminal_result(outcome, intent, guard, budget, operation_id)


def terminal_result(
    outcome: CallOutcome,
    intent: GenerateIntent,
    guard: OneAttemptPerOperation,
    budget: PaidCallBudget,
    operation_id: str,
) -> ChatResult:
    """Validate one terminal v2 outcome and settle only its provider-owned estimate."""

    target = intent.target
    row = resolve_target(target)
    assert len(outcome.meta.attempt_trace) == 1
    assert guard.attempts[operation_id] == 1
    assert outcome.meta.provider == target.provider
    assert outcome.meta.model == target.model
    assert outcome.meta.registry_revision == REGISTRY_REVISION
    if row.correlation == "none":
        assert isinstance(outcome.meta.provider_request_id, Absent)
    else:
        assert isinstance(outcome.meta.provider_request_id, Present)
        assert outcome.meta.provider_request_id.value
    assert isinstance(outcome.meta.usage, Present)
    usage = outcome.meta.usage.value
    if isinstance(outcome, Succeeded):
        status = "succeeded"
    else:
        assert isinstance(outcome, Incomplete)
        assert outcome.reason == "max_output_tokens"
        status = "incomplete_max_output_tokens"

    estimated_cost = estimate_cost(outcome.meta)
    assert isinstance(estimated_cost, Present), (
        "live product target lacks terminal v2 cost evidence"
    )
    budget.settle(operation_id, estimated_cost.value.amount_usd_micros)
    return ChatResult(
        target=f"{target.provider}/{target.model}",
        status=status,
        attempts=1,
        usage={
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
            "total_tokens": usage.total_tokens,
        },
        estimated_cost_usd_micros=estimated_cost.value.amount_usd_micros,
        conservative_exposure_usd_micros=CONSERVATIVE_OPERATION_EXPOSURE_USD_MICROS,
    )


async def certify_chat(
    runtime: ProviderRuntime,
    guard: OneAttemptPerOperation,
    budget: PaidCallBudget,
    target: ProviderTarget,
    reasoning: ReasoningLevel,
    *,
    max_output_tokens: int,
) -> ChatResult:
    intent = certification_intent(target, reasoning, max_output_tokens=max_output_tokens)
    _, result = await run_bounded_chat(runtime, guard, budget, intent)
    return result


def atomic_evidence(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def base_evidence(*, call_limit: int, cost_limit_usd: float) -> dict[str, object]:
    return {
        "version": 2,
        "run_id": os.environ["NEXUS_TEST_RUN_ID"],
        "runtime_revision": os.environ["NEXUS_PROVIDER_RUNTIME_REVISION"],
        "registry_revision": REGISTRY_REVISION,
        "limits": {
            "provider_calls": call_limit,
            "estimated_cost_usd": cost_limit_usd,
        },
        "provider_calls": 0,
        "estimated_cost_usd": 0.0,
        "conservative_exposure_usd": 0.0,
        "results": [],
    }


def embedding_call() -> EmbeddingCall:
    return EmbeddingCall(
        model="text-embedding-3-small",
        inputs=("nexus release provider certification",),
        dimensions=Absent(),
    )
