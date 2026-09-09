"""Real Chat admission and job reclaim around accepted paid model decisions."""

from dataclasses import dataclass
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import ChatPromptAssembly, ChatRun
from nexus.jobs.queue import JobExecutionContext, JobRow, get_job
from nexus.services.chat_run_event_store import mark_running
from nexus.services.chat_run_steps import ChatStepRuntime
from nexus.services.generation_catalog import GenerationCatalogService
from nexus.services.generation_events import BackendEvent, BackendTerminal
from nexus.services.generation_intent import GenerationIntent
from nexus.services.generation_spec import decode_generation_spec_document
from nexus.services.llm_execution import (
    EncodedGenerationTerminal,
    ExecutionRuntime,
    GenerationExecutionRequest,
    GenerationFailureCode,
    GenerationUncertain,
    JobGenerationJournal,
    execute_generation,
)
from nexus.services.llm_ledger import LlmCallOwner, read_model_turns
from nexus.services.tool_authority import compose_deferred_generation_tool_executor
from nexus.services.tool_runtime.composition import ComposedToolRuntime
from tests.testkit.chat import EntitledChat, create_entitled_chat
from tests.testkit.generation_catalog import CHAT_TEST_SELECTION
from tests.testkit.llm_tool_scenarios import claim_chat_tool_job
from tests.testkit.unreachable_state import expire_job_claim


@dataclass(frozen=True)
class RecoverableChat:
    chat: EntitledChat
    generation_id: UUID
    context: JobExecutionContext
    job: JobRow


async def create_recoverable_chat(
    db: Session,
    *,
    catalog: GenerationCatalogService,
    tools: ComposedToolRuntime,
    runtime: ExecutionRuntime,
    accepted_children: int,
) -> RecoverableChat:
    """Crash at the observer boundary after durable acceptance, then reclaim the real job."""

    async def crash_after_acceptance(event: BackendEvent) -> None:
        if isinstance(event, BackendTerminal) and event.child_seq == accepted_children:
            raise RuntimeError("worker lost after the accepted paid decision")

    def unexpected_final(terminal: BackendTerminal) -> EncodedGenerationTerminal:
        raise AssertionError(f"tool-decision fixture became final: {terminal}")

    def unexpected_stop(code: GenerationFailureCode, detail: str) -> str:
        raise AssertionError(f"tool-decision fixture stopped before its crash: {code} {detail}")

    snapshot = await catalog.read_chat()
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
    prompt = db.scalar(select(ChatPromptAssembly).where(ChatPromptAssembly.chat_run_id == run.id))
    assert prompt is not None
    intent = GenerationIntent.model_validate(prompt.generation_intent)
    steps = ChatStepRuntime(
        db, run_id=run.id, job=job, execution_context=context, llm_runtime=runtime
    )
    state = steps.prepare("generation/1", spec.fingerprint)
    owner = LlmCallOwner(kind="chat_run", id=run.id)
    factory = sessionmaker(bind=db.get_bind(), expire_on_commit=False)
    with pytest.raises(GenerationUncertain, match="failed after durable dispatch"):
        await execute_generation(
            GenerationExecutionRequest(
                owner=owner,
                generation_id=state.generation_id,
                spec=spec,
                intent=intent,
                journal=JobGenerationJournal(
                    context=context, step_path="generation/1", lock_dispatch=steps.lock_dispatch
                ),
                tool_executor=compose_deferred_generation_tool_executor(
                    session_factory=factory,
                    user_id=chat.user_id,
                    owner=owner,
                    generation_id=state.generation_id,
                    job_context=context,
                    operation=tools.operations["ChatRead"],
                ),
            ),
            session_factory=factory,
            runtime=runtime,
            encode_terminal=unexpected_final,
            encode_failure=unexpected_stop,
            observe_event=crash_after_acceptance,
        )
    children = read_model_turns(db, generation_id=state.generation_id)
    assert len(children) == accepted_children and all(
        child.terminal is not None for child in children
    )
    expire_job_claim(db, job_id=chat.job_id)
    db.commit()
    retry_context = claim_chat_tool_job(db, job_id=chat.job_id, worker_id="recovered-chat-worker")
    assert retry_context.attempt_no == 2
    retry_job = get_job(db, chat.job_id)
    assert retry_job is not None
    db.commit()
    return RecoverableChat(chat, state.generation_id, retry_context, retry_job)
