"""Chat recovery retains original paid child usage and retires cancelled continuations."""

from __future__ import annotations

import asyncio
import json
from typing import Literal, cast

import pytest
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import sessionmaker

from nexus.config import get_settings
from nexus.db.models import ChatPromptAssembly, ChatRun, ChatRunEvent, LLMModelTurnContinuation
from nexus.jobs.queue import get_job
from nexus.services import generation_policy
from nexus.services.chat_run_event_store import mark_running
from nexus.services.chat_run_steps import ChatStepRuntime
from nexus.services.chat_runs import (
    cancel_chat_run,
    execute_chat_run,
    get_chat_run,
)
from nexus.services.generation_continuations import GenerationContinuationCipher
from nexus.services.generation_events import BackendEvent, BackendTerminal
from nexus.services.generation_intent import GenerationIntent
from nexus.services.generation_service import GenerationService
from nexus.services.generation_spec import (
    decode_generation_spec_document,
)
from nexus.services.llm_execution import (
    ComposedExecutionRuntime,
    EncodedGenerationTerminal,
    GenerationExecutionRequest,
    GenerationFailureCode,
    GenerationUncertain,
    JobGenerationJournal,
    execute_generation,
)
from nexus.services.llm_ledger import (
    LlmCallOwner,
    read_generation,
    read_model_turns,
)
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from nexus.services.tool_authority import (
    compose_deferred_generation_tool_executor,
    read_tool_positions,
)
from tests.testkit.chat import create_entitled_chat
from tests.testkit.generation_catalog import CHAT_TEST_SELECTION, configured_chat_catalog_service
from tests.testkit.generation_tool_authority import controlled_tool_runtime
from tests.testkit.llm_tool_scenarios import claim_chat_tool_job
from tests.testkit.provider_generation import tool_decision_generation_backend
from tests.testkit.unreachable_state import expire_job_claim


@pytest.mark.parametrize("reason", ["cancelled", "turn_limit"])
def test_resumed_chat_stop_publishes_original_paid_usage_and_retires_continuation(
    request: pytest.FixtureRequest, reason: Literal["cancelled", "turn_limit"]
) -> None:
    """Chat recovery must retain earlier paid usage and close pending successor authority."""
    request.getfixturevalue("committed_chat_state_isolation")
    engine = cast(Engine, request.getfixturevalue("engine"))
    asyncio.run(_prove_resumed_chat_stop(engine, reason))


async def _prove_resumed_chat_stop(
    engine: Engine, reason: Literal["cancelled", "turn_limit"]
) -> None:
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    tools = controlled_tool_runtime({})
    operation = tools.operations["ChatRead"]
    catalog = configured_chat_catalog_service()
    snapshot = await catalog.read_chat()
    backend, peer = tool_decision_generation_backend(operation)
    runtime = ComposedExecutionRuntime(
        backend=backend,
        continuation_cipher=GenerationContinuationCipher(b"c" * 32),
        admission=GenerationService(
            catalog=catalog, policy=generation_policy.GENERATION_POLICY, tools=tools
        ),
    )
    expected_children = 1 if reason == "cancelled" else operation.profile.run_limits.max_calls + 1

    async def crash_after_acceptance(event: BackendEvent) -> None:
        if isinstance(event, BackendTerminal) and event.child_seq == expected_children:
            raise RuntimeError("worker lost after the accepted paid decision")

    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=factory))
    try:
        with factory() as db:
            chat = await create_entitled_chat(
                db,
                content="Recover the original paid work exactly once.",
                catalog_definition_revision=snapshot.catalog.definition_revision,
                selection=CHAT_TEST_SELECTION,
                tool_authority="ReadOnly",
                catalog=catalog,
                tool_runtime=tools,
            )
            context = claim_chat_tool_job(db, job_id=chat.job_id, worker_id="crashed-chat-worker")
            job = get_job(db, chat.job_id)
            assert job is not None
            mark_running(db, chat.run_id)
            run = db.get(ChatRun, chat.run_id)
            assert run is not None
            spec = decode_generation_spec_document(run.generation_spec)
            prompt = db.scalar(
                select(ChatPromptAssembly).where(ChatPromptAssembly.chat_run_id == run.id)
            )
            assert prompt is not None
            intent = GenerationIntent.model_validate(prompt.generation_intent)
            steps = ChatStepRuntime(
                db, run_id=run.id, job=job, execution_context=context, llm_runtime=runtime
            )
            state = steps.prepare("generation/1", spec.fingerprint)
            owner = LlmCallOwner(kind="chat_run", id=run.id)
            with pytest.raises(GenerationUncertain, match="failed after durable dispatch"):
                await execute_generation(
                    GenerationExecutionRequest(
                        owner=owner,
                        generation_id=state.generation_id,
                        spec=spec,
                        intent=intent,
                        journal=JobGenerationJournal(
                            context=context,
                            step_path="generation/1",
                            lock_dispatch=steps.lock_dispatch,
                        ),
                        tool_executor=compose_deferred_generation_tool_executor(
                            session_factory=factory,
                            user_id=chat.user_id,
                            owner=owner,
                            generation_id=state.generation_id,
                            job_context=context,
                            operation=operation,
                        ),
                    ),
                    session_factory=factory,
                    runtime=runtime,
                    encode_terminal=_unexpected_final,
                    encode_failure=_encode_stop,
                    observe_event=crash_after_acceptance,
                )
            before = read_model_turns(db, generation_id=state.generation_id)
            assert len(before) == expected_children and all(
                child.terminal is not None for child in before
            )
            positions = read_tool_positions(db, generation_id=state.generation_id)
            expire_job_claim(db, job_id=chat.job_id)
            db.commit()
            retry_context = claim_chat_tool_job(
                db, job_id=chat.job_id, worker_id="recovered-chat-worker"
            )
            assert retry_context.attempt_no == 2
            retry_job = get_job(db, chat.job_id)
            assert retry_job is not None
            db.commit()
            if reason == "cancelled":
                cancel_chat_run(
                    db, viewer_id=chat.user_id, run_id=chat.run_id, catalog_snapshot=snapshot
                )
            await execute_chat_run(
                db,
                run_id=chat.run_id,
                job=retry_job,
                execution_context=retry_context,
                session_factory=factory,
                runtime=runtime,
                settings=get_settings(),
            )
            public = get_chat_run(
                db, viewer_id=chat.user_id, run_id=chat.run_id, catalog_snapshot=snapshot
            )
            assert public.run.status == ("cancelled" if reason == "cancelled" else "error")
            assert public.stream_state.terminal
            done = db.scalar(
                select(ChatRunEvent).where(
                    ChatRunEvent.run_id == chat.run_id, ChatRunEvent.event_type == "done"
                )
            )
            assert done is not None
            assert done.payload["usage"] == {
                "input_tokens": 100 * expected_children,
                "output_tokens": 10 * expected_children,
                "total_tokens": 110 * expected_children,
                "reasoning_tokens": None,
                "cache_read_input_tokens": None,
                "cache_write_input_tokens": None,
            }, "resumed Chat discarded or double-counted original paid child usage"
            parent = read_generation(db, generation_id=state.generation_id)
            assert parent is not None and parent.terminal is not None
            assert parent.terminal["orchestration_stop"] == reason
            assert read_model_turns(db, generation_id=state.generation_id) == before
            assert read_tool_positions(db, generation_id=state.generation_id) == positions
            assert (
                db.scalar(
                    select(func.count())
                    .select_from(LLMModelTurnContinuation)
                    .where(LLMModelTurnContinuation.generation_id == state.generation_id)
                )
                == 0
            ), "cancelled Chat recovery left executable successor authority"
            assert peer.dispatches == expected_children, "Chat recovery paid for another model call"
            await execute_chat_run(
                db,
                run_id=chat.run_id,
                job=retry_job,
                execution_context=retry_context,
                session_factory=factory,
                runtime=runtime,
                settings=get_settings(),
            )
            assert peer.dispatches == expected_children
            assert (
                db.scalar(
                    select(func.count())
                    .select_from(ChatRunEvent)
                    .where(ChatRunEvent.run_id == chat.run_id, ChatRunEvent.event_type == "done")
                )
                == 1
            )
    finally:
        set_rate_limiter(previous_limiter)


def _unexpected_final(terminal: BackendTerminal) -> EncodedGenerationTerminal:
    raise AssertionError(f"a pending tool continuation became native final success: {terminal}")


def _encode_stop(code: GenerationFailureCode, detail: str) -> str:
    del detail
    if code == "cancelled":
        return json.dumps({"kind": "Cancelled"}, sort_keys=True, separators=(",", ":"))
    assert code == "turn_limit", f"unexpected stop before the shared loop limit: {code}"
    return json.dumps({"kind": "Failed", "code": code}, sort_keys=True, separators=(",", ":"))
