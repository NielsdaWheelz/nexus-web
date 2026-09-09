"""Host cancellation must preserve the provider's original paid terminal."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from typing import Literal

import pytest
from provider_runtime.registry import api_model_catalog
from provider_runtime.types import (
    Absent as RuntimeAbsent,
)
from provider_runtime.types import (
    AttemptRecord,
    CallMeta,
    Cancelled,
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
    TextDelta,
    TokenUsage,
)
from provider_runtime.types import (
    Present as RuntimePresent,
)
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import sessionmaker

from nexus.config import get_settings
from nexus.db.models import ChatRunEvent, LLMCall, LLMModelTurnContinuation
from nexus.jobs.queue import get_job
from nexus.services import generation_policy
from nexus.services.chat_runs import cancel_chat_run, execute_chat_run, get_chat_run
from nexus.services.generation_continuations import GenerationContinuationCipher
from nexus.services.generation_service import GenerationService
from nexus.services.llm_execution import ComposedExecutionRuntime
from nexus.services.llm_ledger import read_generation, read_model_turns
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from nexus.services.tool_authority import read_tool_positions
from tests.testkit.chat import create_entitled_chat
from tests.testkit.generation_catalog import CHAT_TEST_SELECTION, configured_chat_catalog_service
from tests.testkit.generation_tool_authority import controlled_tool_runtime
from tests.testkit.llm_tool_scenarios import claim_chat_tool_job
from tests.testkit.provider_generation import provider_generation_backend


@pytest.mark.parametrize("native_outcome", ["Succeeded", "Cancelled"])
def test_late_chat_cancellation_preserves_native_child_and_paid_usage(
    engine: Engine,
    committed_chat_state_isolation: None,
    native_outcome: Literal["Succeeded", "Cancelled"],
) -> None:
    del committed_chat_state_isolation
    asyncio.run(_prove_late_cancellation(engine, native_outcome))


async def _prove_late_cancellation(
    engine: Engine, native_outcome: Literal["Succeeded", "Cancelled"]
) -> None:
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    tools = controlled_tool_runtime({})
    catalog = configured_chat_catalog_service()
    snapshot = await catalog.read_chat()
    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=factory))
    try:
        with factory() as db:
            chat = await create_entitled_chat(
                db,
                content="Give a synthetic answer, then stop when cancellation wins.",
                catalog_definition_revision=snapshot.catalog.definition_revision,
                selection=CHAT_TEST_SELECTION,
                tool_authority="ReadOnly",
                catalog=catalog,
                tool_runtime=tools,
            )
            context = claim_chat_tool_job(db, job_id=chat.job_id, worker_id="late-cancel-proof")
            job = get_job(db, chat.job_id)
            assert job is not None
            db.commit()

            def cancel_after_native_terminal() -> None:
                with factory() as cancellation_db:
                    cancel_chat_run(
                        cancellation_db,
                        viewer_id=chat.user_id,
                        run_id=chat.run_id,
                        catalog_snapshot=snapshot,
                    )

            peer = _LateCancelPeer(native_outcome, cancel_after_native_terminal)
            runtime = ComposedExecutionRuntime(
                backend=provider_generation_backend(tools.operations["ChatRead"], peer),
                continuation_cipher=GenerationContinuationCipher(b"n" * 32),
                admission=GenerationService(
                    catalog=catalog, policy=generation_policy.GENERATION_POLICY, tools=tools
                ),
            )
            await execute_chat_run(
                db,
                run_id=chat.run_id,
                job=job,
                execution_context=context,
                session_factory=factory,
                runtime=runtime,
                settings=get_settings(),
            )
            generation_id = db.scalar(
                select(LLMCall.id).where(
                    LLMCall.owner_kind == "chat_run", LLMCall.owner_id == chat.run_id
                )
            )
            assert generation_id is not None
            children = read_model_turns(db, generation_id=generation_id)
            assert len(children) == 1
            child = children[0]
            assert child.terminal is not None
            assert child.terminal["kind"] == native_outcome, (
                "host cancellation replaced the original paid native terminal"
            )
            evidence = child.terminal["evidence"]
            assert isinstance(evidence, dict)
            meta = evidence["meta"]
            assert isinstance(meta, dict)
            assert meta["provider_request_id"] == {
                "kind": "Present",
                "value": "original-paid-terminal",
            }
            expected_usage = {
                "input_tokens": 100,
                "output_tokens": 10,
                "total_tokens": 110,
                "reasoning_tokens": {"kind": "Absent"},
                "cache_read_input_tokens": {"kind": "Absent"},
                "cache_write_input_tokens": {"kind": "Absent"},
            }
            assert child.usage == expected_usage
            assert child.billability == {"kind": "PossiblyBillable"}
            assert meta["usage"] == {"kind": "Present", "value": expected_usage}
            if native_outcome == "Succeeded":
                assert evidence["response"] == {
                    "content": {"text": "Original native answer.", "tool_calls": []}
                }
            else:
                assert set(evidence) == {"meta"}
            parent = read_generation(db, generation_id=generation_id)
            assert parent is not None and parent.outcome == "Cancelled"
            assert parent.terminal is not None
            assert parent.terminal["model_turn_terminal"] == child.terminal
            if native_outcome == "Succeeded":
                assert parent.terminal["orchestration_stop"] == "cancelled"
            else:
                assert "orchestration_stop" not in parent.terminal
            public = get_chat_run(
                db, viewer_id=chat.user_id, run_id=chat.run_id, catalog_snapshot=snapshot
            )
            assert public.run.status == "cancelled" and public.stream_state.terminal
            done = db.scalar(
                select(ChatRunEvent).where(
                    ChatRunEvent.run_id == chat.run_id, ChatRunEvent.event_type == "done"
                )
            )
            assert done is not None and done.payload["usage"]["total_tokens"] == 110
            assert read_tool_positions(db, generation_id=generation_id) == ()
            assert (
                db.scalar(
                    select(func.count())
                    .select_from(LLMModelTurnContinuation)
                    .where(LLMModelTurnContinuation.generation_id == generation_id)
                )
                == 0
            )
            await execute_chat_run(
                db,
                run_id=chat.run_id,
                job=job,
                execution_context=context,
                session_factory=factory,
                runtime=runtime,
                settings=get_settings(),
            )
            assert read_model_turns(db, generation_id=generation_id) == children
            assert peer.dispatches == 1
    finally:
        set_rate_limiter(previous_limiter)


class _LateCancelPeer:
    def __init__(
        self, outcome: Literal["Succeeded", "Cancelled"], cancel: Callable[[], None]
    ) -> None:
        self.outcome = outcome
        self.cancel = cancel
        self.dispatches = 0

    async def stream(
        self, intent: GenerateIntent, *, cancel: CancelSignal | None = None
    ) -> AsyncIterator[RuntimeStreamEvent]:
        del cancel
        self.dispatches += 1
        meta = CallMeta(
            provider=intent.target.provider,
            model=intent.target.model,
            provider_request_id=RuntimePresent("original-paid-terminal"),
            upstream_provider=RuntimeAbsent(),
            usage=RuntimePresent(
                TokenUsage(
                    input_tokens=100,
                    output_tokens=10,
                    total_tokens=110,
                    reasoning_tokens=RuntimeAbsent(),
                    cache_read_input_tokens=RuntimeAbsent(),
                    cache_write_input_tokens=RuntimeAbsent(),
                )
            ),
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
        native = (
            Succeeded(
                meta=meta,
                response=ResponsePayload(
                    content=TextContent(text="Original native answer.", tool_calls=()),
                    continuation=RuntimeAbsent(),
                ),
            )
            if self.outcome == "Succeeded"
            else Cancelled(meta=meta)
        )
        yield RuntimeStreamEvent(seq=1, event=StreamStart())
        yield RuntimeStreamEvent(seq=2, event=TextDelta(text="Original native answer."))
        yield RuntimeStreamEvent(seq=3, event=TerminalEvent(outcome=native))
        self.cancel()
