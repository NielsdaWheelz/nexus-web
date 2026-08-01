from __future__ import annotations

import json
import os
import struct
import wave
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, replace
from decimal import ROUND_HALF_UP, Decimal
from io import BytesIO
from pathlib import Path

import httpx
from provider_runtime import (
    CATALOG,
    CATALOG_REVISION,
    Absent,
    Dynamic,
    EmbeddingCall,
    FinalizedProviderCall,
    GenerateIntent,
    GlobalScope,
    Incomplete,
    PlanRejected,
    Present,
    PromptBlock,
    ProviderCredential,
    ProviderRuntime,
    ProviderTarget,
    RetryPolicy,
    Stable,
    Succeeded,
    SystemMessage,
    TextOutput,
    TranscriptionCall,
    UserMessage,
    cost_from_accounting,
    plan_generate,
)

from nexus_test_control.provider_budget import PaidCallBudget

USD_MICROS = Decimal(1_000_000)


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


def single_attempt_plan(
    target: ProviderTarget,
    reasoning: str,
    *,
    max_output_tokens: int,
) -> FinalizedProviderCall:
    intent = GenerateIntent(
        target=target,
        messages=(
            SystemMessage(
                blocks=(
                    PromptBlock(
                        "Nexus release provider certification.",
                        Stable(GlobalScope()),
                    ),
                )
            ),
            UserMessage(blocks=(PromptBlock("Reply with ok.", Dynamic()),)),
        ),
        max_output_tokens=max_output_tokens,
        reasoning=reasoning,  # type: ignore[arg-type]  # runtime validates the catalog-owned level.
        tools=(),
        tool_choice="none",
        output=TextOutput(),
    )
    plan = plan_generate(intent)
    if isinstance(plan, PlanRejected):
        raise AssertionError(f"tiny certification request was rejected: {plan.failure}")
    return replace(
        plan,
        retry_policy=RetryPolicy(
            max_attempts=1,
            initial_delay_s=0,
            max_delay_s=0,
            jitter_s=0,
            deadline_s=Absent(),
        ),
    )


async def certify_chat(
    runtime: ProviderRuntime,
    guard: OneAttemptPerOperation,
    budget: PaidCallBudget,
    target: ProviderTarget,
    reasoning: str,
    key: str,
    *,
    max_output_tokens: int,
) -> ChatResult:
    plan = single_attempt_plan(target, reasoning, max_output_tokens=max_output_tokens)
    operation_id = f"generate:{target.provider}/{target.model}"
    budget.reserve(operation_id, plan.accounting.maximum_cost_estimate_usd_micros)
    with guard.operation(operation_id):
        outcome = await runtime.generate(
            plan,
            credential=ProviderCredential(provider=target.provider, key=key),
        )
    assert len(outcome.meta.attempt_trace) == 1
    assert guard.attempts[operation_id] == 1
    assert outcome.meta.provider == target.provider
    assert outcome.meta.model == target.model
    contract = CATALOG.chat_contract(target)
    if contract.provider_request_id_available:
        assert isinstance(outcome.meta.provider_request_id, Present)
        assert outcome.meta.provider_request_id.value
    else:
        assert isinstance(outcome.meta.provider_request_id, Absent)
    assert isinstance(outcome.meta.usage, Present)
    usage = outcome.meta.usage.value
    if isinstance(outcome, Succeeded):
        status = "succeeded"
    else:
        assert isinstance(outcome, Incomplete)
        assert outcome.reason == "max_output_tokens"
        status = "incomplete_max_output_tokens"
    cost = cost_from_accounting(plan.accounting, usage)
    budget.settle(operation_id, cost.total_cost_usd_micros)
    return ChatResult(
        target=f"{target.provider}/{target.model}",
        status=status,
        attempts=1,
        usage={
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
            "total_tokens": usage.total_tokens,
        },
        estimated_cost_usd_micros=cost.total_cost_usd_micros,
        conservative_exposure_usd_micros=plan.accounting.maximum_cost_estimate_usd_micros,
    )


def non_generation_cost_usd_micros(
    input_tokens: int,
    output_tokens: int,
    input_rate: int,
    output_rate: int,
) -> int:
    value = (
        Decimal(input_tokens) * Decimal(input_rate) + Decimal(output_tokens) * Decimal(output_rate)
    ) / USD_MICROS
    return int(value.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def usage_counts(usage: object) -> tuple[int, int]:
    if not isinstance(usage, Present):
        raise AssertionError("provider operation did not return usage")
    return usage.value.input_tokens, usage.value.output_tokens


def silent_wav() -> bytes:
    output = BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(8_000)
        wav.writeframes(struct.pack("<" + "h" * 800, *([0] * 800)))
    return output.getvalue()


def atomic_evidence(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def base_evidence(*, call_limit: int, cost_limit_usd: float) -> dict[str, object]:
    return {
        "version": 1,
        "run_id": os.environ["NEXUS_TEST_RUN_ID"],
        "runtime_revision": os.environ["NEXUS_PROVIDER_RUNTIME_REVISION"],
        "catalog_revision": CATALOG_REVISION,
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
    contract = CATALOG.embeddings[0]
    return EmbeddingCall(
        model=contract.target.model,
        inputs=("nexus release provider certification",),
        dimensions=Absent(),
    )


def transcription_call() -> TranscriptionCall:
    contract = CATALOG.transcriptions[0]
    return TranscriptionCall(
        model=contract.target.model,
        filename="silence.wav",
        content=silent_wav(),
        media_type="audio/wav",
    )
