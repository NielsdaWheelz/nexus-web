"""Shared runtime stops preserve paid child truth and close the durable owner once."""

from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from typing import Literal, cast
from uuid import uuid4

import pytest
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import sessionmaker

from nexus.db.models import LLMModelTurnContinuation
from nexus.jobs.queue import JobExecutionContext, claim_job, enqueue_job, get_job
from nexus.schemas.presence import Present
from nexus.services import generation_policy
from nexus.services.durable_step_journal import Completed, Uncertain
from nexus.services.generation_continuations import GenerationContinuationCipher
from nexus.services.generation_events import BackendEvent, BackendTerminal
from nexus.services.generation_intent import GenerationIntent, TextOutput
from nexus.services.generation_service import GenerationService
from nexus.services.generation_spec import (
    FrozenToolScope,
    ImmutablePromptPayloadRef,
    generation_fact_digest,
)
from nexus.services.llm_execution import (
    CompletedGeneration,
    ComposedExecutionRuntime,
    EncodedGenerationTerminal,
    GenerationExecutionRequest,
    GenerationFailureCode,
    JobGenerationJournal,
    execute_generation,
)
from nexus.services.llm_ledger import (
    LlmCallOwner,
    ModelTurnRecord,
    read_generation,
    read_model_turns,
)
from nexus.services.tool_authority import (
    compose_deferred_generation_tool_executor,
    read_tool_positions,
)
from tests.testkit.generation_catalog import CHAT_TEST_SELECTION, configured_chat_catalog_service
from tests.testkit.generation_tool_authority import controlled_tool_runtime
from tests.testkit.provider_generation import tool_decision_generation_backend
from tests.testkit.unreachable_state import delete_jobs_by_ids, expire_job_claim


@pytest.mark.parametrize("reason", ["cancelled", "turn_limit"])
def test_stopped_parent_retains_paid_child_and_cannot_resume_its_successor(
    request: pytest.FixtureRequest,
    reason: Literal["cancelled", "turn_limit"],
) -> None:
    """Money/durable work: a stopped successor must never publish native success or redispatch."""
    request.getfixturevalue("committed_chat_state_isolation")
    engine = cast(Engine, request.getfixturevalue("engine"))
    asyncio.run(_prove_stopped_generation(engine, reason))


async def _prove_stopped_generation(
    engine: Engine, reason: Literal["cancelled", "turn_limit"]
) -> None:
    tools = controlled_tool_runtime({})
    operation = tools.operations["ChatRead"]
    catalog = configured_chat_catalog_service()
    admission = GenerationService(
        catalog=catalog, policy=generation_policy.GENERATION_POLICY, tools=tools
    )
    intent = GenerationIntent(
        instructions="Use the admitted tools before answering.",
        input="A bounded stop must retain the original paid tool decision.",
        output=TextOutput(),
    )
    generation_id, user_id = uuid4(), uuid4()
    owner = LlmCallOwner(kind="chat_run", id=uuid4())
    spec = await admission.freeze_chat(
        catalog_definition_revision=(
            await catalog.read_for_admission()
        ).catalog.definition_revision,
        selection=CHAT_TEST_SELECTION,
        tool_authority="ReadOnly",
        scope=FrozenToolScope(admitted_refs=("library:stop-proof",), predicates=()),
        intent=intent,
        prompt_template_revision="shared-stop.prompt.v1",
        prompt_payload_ref=ImmutablePromptPayloadRef(
            owner_kind="chat_run",
            owner_id=str(owner.id),
            revision="shared-stop.prompt.v1",
            payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
        ),
    )
    backend, peer = tool_decision_generation_backend(operation)
    runtime = ComposedExecutionRuntime(
        backend=backend,
        continuation_cipher=GenerationContinuationCipher(b"k" * 32),
        admission=admission,
    )
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as db:
        job = enqueue_job(db, kind="shared_generation_stop_proof", max_attempts=2)
        claimed = claim_job(
            db, job_id=job.id, worker_id="stop-worker", lease_seconds=300, heavy_kinds=()
        )
        assert claimed is not None
        db.commit()
    context = JobExecutionContext(
        job_id=job.id, worker_id="stop-worker", attempt_no=claimed.attempts, resource_class="Light"
    )
    journal = JobGenerationJournal(
        context=context, step_path="generation", lock_dispatch=lambda db: get_job(db, job.id)
    )
    with factory() as db:
        journal.prepare_admission(db, generation_id=generation_id, spec=spec, intent=intent)
        db.commit()
    execution = GenerationExecutionRequest(
        owner=owner,
        generation_id=generation_id,
        spec=spec,
        intent=intent,
        journal=journal,
        tool_executor=compose_deferred_generation_tool_executor(
            session_factory=factory,
            user_id=user_id,
            owner=owner,
            generation_id=generation_id,
            job_context=context,
            operation=operation,
        ),
    )
    cancellation = asyncio.Event()
    accepted_children: tuple[ModelTurnRecord, ...] = ()

    async def observe(event: BackendEvent) -> None:
        nonlocal accepted_children
        if isinstance(event, BackendTerminal):
            with factory() as db:
                accepted_children = read_model_turns(db, generation_id=generation_id)
                state = journal.read(db)
                assert state is not None and state.dispatch_phase is Uncertain
                assert accepted_children[-1].terminal is not None
            if reason == "cancelled":
                cancellation.set()

    try:
        result = await execute_generation(
            execution,
            session_factory=factory,
            runtime=runtime,
            encode_terminal=_unexpected_final,
            encode_failure=_encode_stop,
            observe_event=observe,
            cancel_signal=cancellation,
        )
        expected_result = (
            '{"kind":"Cancelled"}'
            if reason == "cancelled"
            else '{"code":"turn_limit","kind":"Failed"}'
        )
        assert isinstance(result, CompletedGeneration)
        assert (result.terminal_result, result.terminal, result.replayed) == (
            expected_result,
            None,
            False,
        )
        expected_children = (
            1 if reason == "cancelled" else operation.profile.run_limits.max_calls + 1
        )
        assert len(accepted_children) == expected_children
        with factory() as db:
            parent = read_generation(db, generation_id=generation_id)
            children = read_model_turns(db, generation_id=generation_id)
            state = journal.read(db)
            positions = read_tool_positions(db, generation_id=generation_id)
            pending = db.scalar(
                select(func.count())
                .select_from(LLMModelTurnContinuation)
                .where(LLMModelTurnContinuation.generation_id == generation_id)
            )
        assert parent is not None
        assert parent.outcome == ("Cancelled" if reason == "cancelled" else "Failed"), (
            "stopped generation did not commit its explicit non-success parent outcome"
        )
        assert parent.terminal is not None and parent.terminal["orchestration_stop"] == reason
        assert children == accepted_children, "stopping replaced original paid child evidence"
        assert all(
            child.terminal is not None and child.terminal["kind"] == "Succeeded"
            for child in children
        )
        assert all(
            child.usage is not None
            and child.usage["input_tokens"] == 100
            and child.usage["output_tokens"] == 10
            for child in children
        )
        assert all(child.billability == {"kind": "PossiblyBillable"} for child in children)
        assert state is not None and state.dispatch_phase is Completed
        assert (
            isinstance(state.terminal_result, Present)
            and state.terminal_result.value == expected_result
        )
        assert pending == 0, "stopped owner retained executable successor authority"
        assert len(positions) == expected_children - 1
        assert all(position.replay_status == "Completed" for position in positions)

        with factory() as db:
            expire_job_claim(db, job_id=job.id)
            db.commit()
            reclaimed = claim_job(
                db, job_id=job.id, worker_id="retry-worker", lease_seconds=300, heavy_kinds=()
            )
            assert reclaimed is not None and reclaimed.attempts == 2
            db.commit()
        retry_context = JobExecutionContext(
            job_id=job.id,
            worker_id="retry-worker",
            attempt_no=reclaimed.attempts,
            resource_class="Light",
        )
        retry = replace(
            execution,
            journal=JobGenerationJournal(
                context=retry_context,
                step_path="generation",
                lock_dispatch=lambda db: get_job(db, job.id),
            ),
            tool_executor=compose_deferred_generation_tool_executor(
                session_factory=factory,
                user_id=user_id,
                owner=owner,
                generation_id=generation_id,
                job_context=retry_context,
                operation=operation,
            ),
        )
        replay = await execute_generation(
            retry,
            session_factory=factory,
            runtime=runtime,
            encode_terminal=_unexpected_final,
            encode_failure=_encode_stop,
        )
        assert isinstance(replay, CompletedGeneration)
        assert (replay.terminal_result, replay.terminal, replay.replayed) == (
            expected_result,
            None,
            True,
        )
        assert peer.dispatches == expected_children, "retry paid for another model decision"
        with factory() as db:
            assert read_model_turns(db, generation_id=generation_id) == children
            assert read_tool_positions(db, generation_id=generation_id) == positions
    finally:
        with factory() as db:
            delete_jobs_by_ids(db, job_ids=(job.id,))
            db.commit()


def _unexpected_final(terminal: BackendTerminal) -> EncodedGenerationTerminal:
    raise AssertionError(f"a pending tool continuation became native final success: {terminal}")


def _encode_stop(code: GenerationFailureCode, detail: str) -> str:
    del detail
    if code == "cancelled":
        return json.dumps({"kind": "Cancelled"}, sort_keys=True, separators=(",", ":"))
    assert code == "turn_limit", f"unexpected stop before the shared loop limit: {code}"
    return json.dumps({"kind": "Failed", "code": code}, sort_keys=True, separators=(",", ":"))
