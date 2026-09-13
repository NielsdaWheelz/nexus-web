import asyncio
import os
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from uuid import UUID, uuid4

import httpx
from provider_runtime import (
    AssistantMessage,
    CanonicalTool,
    GenerateIntent,
    Present,
    PromptBlock,
    ProviderCredential,
    ProviderRuntime,
    ProviderTarget,
    RuntimeStreamEvent,
    StreamStart,
    StructuredContent,
    Succeeded,
    SystemMessage,
    TerminalEvent,
    TextContent,
    TextOutput,
    ToolResultMessage,
    UserMessage,
)
from provider_runtime import CallOutcome as ProviderCallOutcome
from provider_runtime.registry import resolve_target
from provider_runtime.types import StrictJsonOutput
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.session import create_session_factory
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.llm_execution import (
    GenerationRequest,
    execute_generation,
    execute_generation_stream,
)
from nexus.services.llm_ledger import LlmCallOwner
from nexus.services.llm_profiles import PROFILES, LlmProfile
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from nexus_test_control.provider_budget import PaidCallBudget
from tests.hosted._provider_live import (
    CONSERVATIVE_OPERATION_EXPOSURE_USD_MICROS,
    ChatResult,
    OneAttemptPerOperation,
    atomic_evidence,
    base_evidence,
    certification_intent,
    embedding_call,
    provider_credentials_from_environment,
    single_attempt_runtime,
    terminal_result,
)

# Nine product chats + one OpenAI embedding + (two DeepSeek profiles × four
# DeepSeek AC4 dispatches: stream, strict JSON, tool turn, continuation turn).
CALL_LIMIT = 18
COST_LIMIT_USD = 0.18
MAX_OUTPUT_TOKENS = 256

_STRICT_REPLY_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {"ok": {"type": "boolean"}},
    "required": ["ok"],
    "additionalProperties": False,
}
_TEMPERATURE_TOOL = CanonicalTool(
    name="lookup_temperature",
    description="Return the current temperature for a city, in celsius.",
    parameters={
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"],
        "additionalProperties": False,
    },
)


def test_active_nexus_provider_surface_is_release_certified(engine: Engine) -> None:
    assert os.environ["NEXUS_PROVIDER_CERTIFICATION"] == "1"
    accepted_at = datetime.fromisoformat(
        os.environ["NEXUS_FABLE_RETENTION_ACCEPTED_AT"].replace("Z", "+00:00")
    )
    assert accepted_at.tzinfo is not None
    evidence_path = Path(os.environ["NEXUS_PROVIDER_CERTIFICATION_EVIDENCE_PATH"])
    evidence = base_evidence(call_limit=CALL_LIMIT, cost_limit_usd=COST_LIMIT_USD)
    atomic_evidence(evidence_path, evidence)
    user_id = uuid4()
    _provision_release_user(engine, user_id)
    session_factory = create_session_factory(engine)

    async def run() -> None:
        guard = OneAttemptPerOperation()
        budget = PaidCallBudget(
            call_limit=CALL_LIMIT,
            cost_limit_usd_micros=int(COST_LIMIT_USD * 1_000_000),
        )
        results: list[dict[str, object]] = []
        actual_cost_micros = 0
        async with httpx.AsyncClient(
            trust_env=False,
            event_hooks={"request": [guard.on_request]},
        ) as client:
            credentials = provider_credentials_from_environment()
            runtime = single_attempt_runtime(credentials, client)
            for provider_profile in PROFILES:
                try:
                    intent = _certification_intent(provider_profile)
                    outcome, result, generation_id = await _run_nexus_chat(
                        runtime,
                        guard,
                        budget,
                        session_factory,
                        user_id,
                        provider_profile,
                        intent,
                        operation="generate",
                    )
                    assert isinstance(outcome, Succeeded)
                    assert isinstance(outcome.response.content, TextContent)
                    assert outcome.response.content.text.strip()
                    actual_cost_micros += result.estimated_cost_usd_micros
                    ledger_outcome, charged_tokens = _assert_nexus_terminal(
                        engine, generation_id, outcome
                    )
                    _record_result(
                        results,
                        provider_profile.id,
                        "generate",
                        result,
                        generation_id=generation_id,
                        ledger_outcome=ledger_outcome,
                        charged_tokens=charged_tokens,
                    )
                finally:
                    _write_progress(
                        evidence_path, evidence, guard, results, actual_cost_micros, budget
                    )

            deepseek_profiles = tuple(
                provider_profile
                for provider_profile in PROFILES
                if provider_profile.target.provider == "deepseek"
            )
            assert tuple(provider_profile.id for provider_profile in deepseek_profiles) == (
                "deepseek-flash",
                "deepseek-pro",
            )
            for provider_profile in deepseek_profiles:
                try:
                    stream_outcome, stream_result, stream_generation_id = await _run_nexus_stream(
                        runtime,
                        guard,
                        budget,
                        session_factory,
                        user_id,
                        provider_profile,
                        _deepseek_intent(
                            provider_profile.target,
                            "Stream the word pong as a brief answer.",
                        ),
                    )
                    assert isinstance(stream_outcome, Succeeded)
                    assert isinstance(stream_outcome.response.content, TextContent)
                    assert stream_outcome.response.content.text.strip()
                    actual_cost_micros += stream_result.estimated_cost_usd_micros
                    ledger_outcome, charged_tokens = _assert_nexus_terminal(
                        engine, stream_generation_id, stream_outcome
                    )
                    _record_result(
                        results,
                        provider_profile.id,
                        "stream",
                        stream_result,
                        reasoning="high",
                        generation_id=stream_generation_id,
                        ledger_outcome=ledger_outcome,
                        charged_tokens=charged_tokens,
                    )

                    strict_outcome, strict_result, strict_generation_id = await _run_nexus_chat(
                        runtime,
                        guard,
                        budget,
                        session_factory,
                        user_id,
                        provider_profile,
                        _deepseek_intent(
                            provider_profile.target,
                            'Reply exactly with {"ok": true}.',
                            output=StrictJsonOutput(
                                name="ReleaseCertification", schema=_STRICT_REPLY_SCHEMA
                            ),
                        ),
                        operation="strict_json",
                    )
                    assert isinstance(strict_outcome, Succeeded)
                    assert isinstance(strict_outcome.response.content, StructuredContent)
                    assert strict_outcome.response.content.payload == {"ok": True}
                    actual_cost_micros += strict_result.estimated_cost_usd_micros
                    ledger_outcome, charged_tokens = _assert_nexus_terminal(
                        engine, strict_generation_id, strict_outcome
                    )
                    _record_result(
                        results,
                        provider_profile.id,
                        "strict_json",
                        strict_result,
                        reasoning="high",
                        generation_id=strict_generation_id,
                        ledger_outcome=ledger_outcome,
                        charged_tokens=charged_tokens,
                    )

                    continuation_owner_id = uuid4()
                    tool_intent = _deepseek_intent(
                        provider_profile.target,
                        (
                            "Call lookup_temperature exactly once for Paris. After receiving the tool "
                            "result, give the final temperature in one terse sentence."
                        ),
                        tools=(_TEMPERATURE_TOOL,),
                    )
                    first, first_result, first_generation_id = await _run_nexus_chat(
                        runtime,
                        guard,
                        budget,
                        session_factory,
                        user_id,
                        provider_profile,
                        tool_intent,
                        operation="thinking_tool_initial",
                        owner_id=continuation_owner_id,
                    )
                    assert isinstance(first, Succeeded)
                    assert isinstance(first.response.content, TextContent)
                    assert len(first.response.content.tool_calls) == 1
                    continuation = first.response.continuation
                    assert isinstance(continuation, Present)
                    reasoning_content = continuation.value.opaque_payload.get("reasoning_content")
                    assert isinstance(reasoning_content, str) and reasoning_content.strip()
                    tool_call = first.response.content.tool_calls[0]
                    assert tool_call.name == _TEMPERATURE_TOOL.name
                    actual_cost_micros += first_result.estimated_cost_usd_micros
                    ledger_outcome, charged_tokens = _assert_nexus_terminal(
                        engine, first_generation_id, first
                    )
                    _record_result(
                        results,
                        provider_profile.id,
                        "thinking_tool_initial",
                        first_result,
                        reasoning="high",
                        generation_id=first_generation_id,
                        ledger_outcome=ledger_outcome,
                        charged_tokens=charged_tokens,
                    )

                    second, second_result, second_generation_id = await _run_nexus_chat(
                        runtime,
                        guard,
                        budget,
                        session_factory,
                        user_id,
                        provider_profile,
                        replace(
                            tool_intent,
                            messages=(
                                *tool_intent.messages,
                                AssistantMessage(
                                    text=first.response.content.text,
                                    tool_calls=first.response.content.tool_calls,
                                    continuation=continuation,
                                ),
                                ToolResultMessage(
                                    call_id=tool_call.id,
                                    output='{"temperature_c": 21}',
                                    is_error=False,
                                ),
                            ),
                        ),
                        operation="thinking_tool_continuation",
                        owner_id=continuation_owner_id,
                    )
                    assert isinstance(second, Succeeded)
                    assert isinstance(second.response.content, TextContent)
                    assert second.response.content.text.strip()
                    assert not second.response.content.tool_calls
                    actual_cost_micros += second_result.estimated_cost_usd_micros
                    ledger_outcome, charged_tokens = _assert_nexus_terminal(
                        engine, second_generation_id, second
                    )
                    _assert_nexus_continuation_owner(
                        engine,
                        continuation_owner_id,
                        first_generation_id,
                        second_generation_id,
                    )
                    _record_result(
                        results,
                        provider_profile.id,
                        "thinking_tool_continuation",
                        second_result,
                        reasoning="high",
                        generation_id=second_generation_id,
                        ledger_outcome=ledger_outcome,
                        charged_tokens=charged_tokens,
                    )
                finally:
                    _write_progress(
                        evidence_path, evidence, guard, results, actual_cost_micros, budget
                    )

            embedding = embedding_call()
            embedding_id = f"embed:openai/{embedding.model}"
            budget.reserve(embedding_id, CONSERVATIVE_OPERATION_EXPOSURE_USD_MICROS)
            try:
                with guard.operation(embedding_id):
                    embedded = await runtime.embed(
                        embedding,
                        credential=ProviderCredential(
                            provider="openai", key=os.environ["OPENAI_API_KEY"]
                        ),
                    )
                assert guard.attempts[embedding_id] == 1
                assert len(embedded.embeddings) == 1 and embedded.embeddings[0]
                results.append(
                    {
                        "target": f"openai/{embedding.model}",
                        "operation": "embed",
                        "status": "succeeded",
                        "attempts": 1,
                        "usage": (
                            {
                                "input_tokens": embedded.usage.value.input_tokens,
                                "output_tokens": embedded.usage.value.output_tokens,
                            }
                            if isinstance(embedded.usage, Present)
                            else None
                        ),
                        "estimated_cost_usd_micros": None,
                        "conservative_exposure_usd_micros": CONSERVATIVE_OPERATION_EXPOSURE_USD_MICROS,
                    }
                )
            finally:
                _write_progress(evidence_path, evidence, guard, results, actual_cost_micros, budget)

        assert len(PROFILES) == 9
        assert sum(guard.attempts.values()) == CALL_LIMIT
        assert budget.admitted_calls == CALL_LIMIT
        assert budget.reserved_cost_usd_micros <= int(COST_LIMIT_USD * 1_000_000)
        assert actual_cost_micros == budget.actual_cost_usd_micros

    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=session_factory))
    try:
        asyncio.run(run())
    finally:
        set_rate_limiter(previous_limiter)


def _provision_release_user(engine: Engine, user_id: UUID) -> None:
    with Session(engine) as db:
        ensure_user_and_default_library(
            db,
            user_id,
            f"provider-certification-{user_id}@example.invalid",
        )
        grant_entitlement_override(
            db,
            user_id=user_id,
            plan_tier="ai_pro",
            platform_token_quota_mode="unlimited",
            platform_token_limit_monthly=None,
            transcription_quota_mode="unlimited",
            transcription_minutes_limit_monthly=None,
            expires_at=None,
            reason="protected provider release certification",
            actor_label="nexus-test-control",
        )
        db.commit()


def _certification_intent(provider_profile: LlmProfile) -> GenerateIntent:
    return certification_intent(
        provider_profile.target,
        provider_profile.default_reasoning_option_id,
        max_output_tokens=MAX_OUTPUT_TOKENS,
    )


async def _run_nexus_chat(
    runtime: ProviderRuntime,
    guard: OneAttemptPerOperation,
    budget: PaidCallBudget,
    session_factory: sessionmaker[Session],
    user_id: UUID,
    provider_profile: LlmProfile,
    intent: GenerateIntent,
    *,
    operation: str,
    owner_id: UUID | None = None,
) -> tuple[ProviderCallOutcome, ChatResult, UUID]:
    """Dispatch one paid call through Nexus admission, ledger, and settlement."""
    operation_id = f"{operation}:{intent.target.provider}/{intent.target.model}"
    budget.reserve(operation_id, CONSERVATIVE_OPERATION_EXPOSURE_USD_MICROS)
    generation_id = uuid4()
    request = GenerationRequest(
        generation_id=generation_id,
        owner=LlmCallOwner(
            kind="chat_run",
            id=owner_id or uuid4(),
            user_id=user_id,
        ),
        operation="chat",
        profile=provider_profile,
        reasoning=intent.reasoning,
        intent=intent,
    )
    with guard.operation(operation_id):
        executed = await execute_generation(
            request,
            session_factory=session_factory,
            runtime=runtime,
        )
    return (
        executed.outcome,
        terminal_result(executed.outcome, intent, guard, budget, operation_id),
        generation_id,
    )


async def _run_nexus_stream(
    runtime: ProviderRuntime,
    guard: OneAttemptPerOperation,
    budget: PaidCallBudget,
    session_factory: sessionmaker[Session],
    user_id: UUID,
    provider_profile: LlmProfile,
    intent: GenerateIntent,
) -> tuple[ProviderCallOutcome, ChatResult, UUID]:
    """Consume one provider stream through Nexus terminal settlement."""
    operation_id = f"stream:{intent.target.provider}/{intent.target.model}"
    budget.reserve(operation_id, CONSERVATIVE_OPERATION_EXPOSURE_USD_MICROS)
    generation_id = uuid4()
    request = GenerationRequest(
        generation_id=generation_id,
        owner=LlmCallOwner(kind="chat_run", id=uuid4(), user_id=user_id),
        operation="chat",
        profile=provider_profile,
        reasoning=intent.reasoning,
        intent=intent,
    )
    events: list[RuntimeStreamEvent] = []
    with guard.operation(operation_id):
        async for event in execute_generation_stream(
            request,
            session_factory=session_factory,
            runtime=runtime,
            cancel=asyncio.Event(),
        ):
            events.append(event)
    assert events and isinstance(events[0].event, StreamStart)
    assert all(event.seq == index for index, event in enumerate(events, start=1))
    terminals = [event.event for event in events if isinstance(event.event, TerminalEvent)]
    assert len(terminals) == 1 and isinstance(events[-1].event, TerminalEvent)
    outcome = terminals[0].outcome
    return outcome, terminal_result(outcome, intent, guard, budget, operation_id), generation_id


def _assert_nexus_terminal(
    engine: Engine,
    generation_id: UUID,
    outcome: ProviderCallOutcome,
) -> tuple[str, int]:
    """Prove Nexus atomically published one terminal ledger row and one charge."""
    assert isinstance(outcome.meta.usage, Present)
    assert isinstance(outcome, Succeeded), "release certification requires a successful terminal"
    expected_outcome = "succeeded"
    with Session(engine) as db:
        ledger = db.execute(
            text(
                """
                SELECT outcome, registry_revision, total_tokens
                FROM llm_calls
                WHERE id = :generation_id
                """
            ),
            {"generation_id": generation_id},
        ).one()
        charges = db.execute(
            text(
                """
                SELECT charged_tokens
                FROM token_budget_charges
                WHERE reservation_id = :generation_id
                """
            ),
            {"generation_id": generation_id},
        ).all()
        reservation_count = db.scalar(
            text(
                """
                SELECT COUNT(*)
                FROM token_budget_reservations
                WHERE reservation_id = :generation_id
                """
            ),
            {"generation_id": generation_id},
        )
    expected_tokens = outcome.meta.usage.value.total_tokens
    assert ledger == (expected_outcome, outcome.meta.registry_revision, expected_tokens)
    assert charges == [(expected_tokens,)]
    assert reservation_count == 0
    return expected_outcome, expected_tokens


def _assert_nexus_continuation_owner(
    engine: Engine,
    owner_id: UUID,
    first_generation_id: UUID,
    second_generation_id: UUID,
) -> None:
    """Prove tool continuation stayed in one ordered Nexus chat owner."""
    with Session(engine) as db:
        rows = db.execute(
            text(
                """
                SELECT id, call_seq, outcome
                FROM llm_calls
                WHERE owner_kind = 'chat_run' AND owner_id = :owner_id
                ORDER BY call_seq
                """
            ),
            {"owner_id": owner_id},
        ).all()
    assert rows == [
        (first_generation_id, 1, "succeeded"),
        (second_generation_id, 2, "succeeded"),
    ]


def _deepseek_intent(
    target: ProviderTarget,
    user: str,
    *,
    output: TextOutput | StrictJsonOutput | None = None,
    tools: tuple[CanonicalTool, ...] = (),
) -> GenerateIntent:
    row = resolve_target(target)
    assert row.provider == "deepseek"
    assert row.streaming and row.tools and row.structured == "json_mode"
    return GenerateIntent(
        target=target,
        messages=(
            SystemMessage(blocks=(PromptBlock(text="Nexus DeepSeek release certification."),)),
            UserMessage(blocks=(PromptBlock(text=user),)),
        ),
        max_output_tokens=MAX_OUTPUT_TOKENS,
        reasoning="high",
        tools=tools,
        tool_choice="auto" if tools else "none",
        output=TextOutput() if output is None else output,
    )


def _record_result(
    results: list[dict[str, object]],
    profile_id: str,
    operation: str,
    result: ChatResult,
    *,
    generation_id: UUID,
    ledger_outcome: str,
    charged_tokens: int,
    reasoning: str | None = None,
) -> None:
    record: dict[str, object] = {
        "profile_id": profile_id,
        "target": result.target,
        "operation": operation,
        "status": result.status,
        "attempts": result.attempts,
        "usage": result.usage,
        "estimated_cost_usd_micros": result.estimated_cost_usd_micros,
        "nexus_generation_id": str(generation_id),
        "nexus_ledger_outcome": ledger_outcome,
        "nexus_charged_tokens": charged_tokens,
    }
    if reasoning is not None:
        record["reasoning"] = reasoning
    results.append(record)


def _write_progress(
    path: Path,
    evidence: dict[str, object],
    guard: OneAttemptPerOperation,
    results: list[dict[str, object]],
    actual_cost_micros: int,
    budget: PaidCallBudget,
) -> None:
    evidence["provider_calls"] = sum(guard.attempts.values())
    evidence["estimated_cost_usd"] = actual_cost_micros / 1_000_000
    evidence["conservative_exposure_usd"] = budget.reserved_cost_usd_micros / 1_000_000
    evidence["results"] = results
    atomic_evidence(path, evidence)
