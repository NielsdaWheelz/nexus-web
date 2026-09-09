"""Real PostgreSQL proof that tool database waits yield the provider loop."""

from __future__ import annotations

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from uuid import uuid4

from llm_tools import HandlerSuccess, ToolId
from sqlalchemy import Engine, text
from sqlalchemy.orm import sessionmaker

from nexus.jobs.queue import JobExecutionContext, claim_job, enqueue_job
from nexus.services.generation_spec import FrozenToolScope
from nexus.services.llm_ledger import (
    GenerationStart,
    LlmCallOwner,
    generation_spec_document,
    start_generation_in_current_transaction,
)
from nexus.services.tool_authority import compose_generation_tool_executor
from nexus.services.tool_runtime.declarations import NexusSearchSuccess
from tests.testkit.generation_tool_authority import (
    controlled_tool_runtime,
    generation_tool_spec,
    search_arguments,
)
from tests.testkit.unreachable_state import delete_jobs_by_ids


def test_tool_database_wait_keeps_the_provider_event_loop_live(
    engine: Engine,
    committed_chat_state_isolation: None,
) -> None:
    """A DB lock must not block cancellation and provider work on the same loop."""

    del committed_chat_state_isolation

    async def search(value: Any, context: Any) -> HandlerSuccess[NexusSearchSuccess]:
        del value, context
        return HandlerSuccess(NexusSearchSuccess(matches=[], total_candidates=0), 0)

    operation = controlled_tool_runtime({"nexus.search": search}).operations["LibraryDossierRead"]
    generation_id = uuid4()
    owner = LlmCallOwner(kind="artifact_build", id=uuid4())
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as db:
        job = enqueue_job(db, kind="generation_tool_scheduling_proof", max_attempts=1)
        claimed = claim_job(
            db,
            job_id=job.id,
            worker_id="tool-database-scheduling-proof",
            lease_seconds=300,
            heavy_kinds=(),
        )
        assert claimed is not None
        job_context = JobExecutionContext(
            job_id=job.id,
            worker_id="tool-database-scheduling-proof",
            attempt_no=claimed.attempts,
            resource_class="Light",
        )
        start_generation_in_current_transaction(
            db,
            GenerationStart(
                generation_id=generation_id,
                owner=owner,
                spec=generation_spec_document(
                    generation_tool_spec(
                        operation=operation,
                        scope=FrozenToolScope(admitted_refs=("library:proof",), predicates=()),
                    )
                ),
            ),
        )
        db.commit()
    locked = threading.Event()
    release = threading.Event()

    def hold_generation_lock() -> bool:
        # The lock holder creates, uses and closes its connection on one thread.
        with factory() as db, db.begin():
            db.execute(
                text("SELECT id FROM llm_calls WHERE id = :id FOR UPDATE"),
                {"id": generation_id},
            ).one()
            locked.set()
            # A watchdog prevents an unfixed blocking implementation from hanging
            # the suite. Completion requires the loop callback, never the watchdog.
            return release.wait(timeout=5.0)

    async def prove() -> None:
        executor = await compose_generation_tool_executor(
            session_factory=factory,
            user_id=uuid4(),
            owner=owner,
            generation_id=generation_id,
            job_context=job_context,
            operation=operation,
        )
        with ThreadPoolExecutor(max_workers=1) as lock_owner:
            holder = lock_owner.submit(hold_generation_lock)
            try:
                assert await asyncio.to_thread(locked.wait, 5.0), "lock holder did not start"
                asyncio.get_running_loop().call_soon(release.set)
                result = await executor.execute_canonical(
                    transport_kind="ProviderApi",
                    model_turn_seq=1,
                    transport_call_id="provider-scheduling-proof",
                    provider_wire_name="nexus__search",
                    tool_id=ToolId("nexus.search"),
                    arguments=search_arguments("event loop liveness"),
                )
                assert holder.result(), (
                    "tool database I/O blocked the provider event loop until the lock watchdog"
                )
                assert result.position is not None
                assert result.position.replay_status == "Completed"
                assert not result.model_output.is_error
            finally:
                release.set()

    try:
        asyncio.run(prove())
    finally:
        with factory() as db:
            delete_jobs_by_ids(db, job_ids=(job.id,))
            db.commit()
