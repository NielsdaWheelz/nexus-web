"""Priority proof: uncertain billed chat steps require explicit reconciliation."""

from __future__ import annotations

from typing import cast
from uuid import UUID, uuid4

import pytest
from pydantic import SecretStr
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.jobs.queue import JobExecutionContext, claim_job, fail_job
from nexus.services.chat_run_steps import (
    ChatStepRuntime,
    ProveNotDispatched,
    UncertainChatStep,
    reconcile_uncertain_chat_step,
)
from nexus.services.codex_generation_contract import (
    ChatOperation,
    GenerationCommand,
    request_fingerprint,
)
from nexus.services.durable_step_journal import ReplayPolicy, stable_generation_id
from nexus.services.generation_intent import BearerToolGrant, GenerationIntent, TextOutput
from nexus.services.generation_policy import (
    POLICY_FINGERPRINT,
    POLICY_REVISION,
    operation_revision,
)
from nexus.services.llm_execution import ExecutionRuntime
from nexus.services.llm_ledger import (
    GenerationStart,
    LlmCallOwner,
    start_generation_in_current_transaction,
)
from tests.testkit.chat import create_entitled_chat
from tests.testkit.unreachable_state import make_failed_job_retryable

pytestmark = pytest.mark.usefixtures("committed_chat_state_isolation")


def _claim_chat(db: Session, job_id: UUID, worker_id: str):
    claimed = claim_job(
        db,
        job_id=job_id,
        worker_id=worker_id,
        lease_seconds=300,
        heavy_kinds=(),
        allowed_kinds=("chat_run",),
    )
    assert claimed is not None
    return claimed


def test_uncertain_chat_dispatch_suspends_then_reconciles_the_same_job(
    engine: Engine,
) -> None:
    """The committed checkpoint, not a provider fake, prevents redispatch."""
    path = "generation/1"
    with Session(engine) as db:
        chat = create_entitled_chat(db, content=f"Durable checkpoint proof {uuid4()}")
        claimed = _claim_chat(db, chat.job_id, "checkpoint-worker")
        steps = ChatStepRuntime(
            db,
            run_id=chat.run_id,
            job=claimed,
            execution_context=JobExecutionContext(
                job_id=claimed.id,
                worker_id="checkpoint-worker",
                attempt_no=claimed.attempts,
                resource_class="Light",
            ),
            llm_runtime=cast(ExecutionRuntime, object()),
        )
        generation_id = stable_generation_id(chat.run_id, path)
        command = GenerationCommand(
            request_id=generation_id,
            operation=ChatOperation(
                revision=operation_revision("chat", profile="balanced"),
                profile="balanced",
            ),
            policy_revision=POLICY_REVISION,
            policy_fingerprint=POLICY_FINGERPRINT,
            intent=GenerationIntent(
                instructions="Return one answer.",
                input="Durable reconciliation proof.",
                output=TextOutput(),
            ),
            tool_grant=BearerToolGrant(token=SecretStr("test-only-grant")),
        )
        steps.prepare(path, request_fingerprint(command))
        start_generation_in_current_transaction(
            db,
            GenerationStart(
                owner=LlmCallOwner(kind="chat_run", id=chat.run_id),
                command=command,
                streaming=True,
            ),
        )
        steps.mark_uncertain(path)

        persisted_phase = db.execute(
            text(
                "SELECT payload #>> '{coordination,generation/1,dispatch_phase}' "
                "FROM background_jobs WHERE id = :job_id"
            ),
            {"job_id": chat.job_id},
        ).scalar_one()
        assert persisted_phase == "Uncertain", (
            "the Uncertain checkpoint was not durably committed before dispatch"
        )
        with pytest.raises(UncertainChatStep):
            steps.read(path, ReplayPolicy.BilledOnce)

        assert (
            fail_job(
                db,
                job_id=chat.job_id,
                worker_id="checkpoint-worker",
                error_code="E_WORKER_INTERRUPTED",
                error_message="ambiguous external outcome",
                retry_delays_seconds=(0, 0),
            )
            == "failed"
        )
        for attempt in (2, 3):
            make_failed_job_retryable(db, job_id=chat.job_id)
            next_worker = f"checkpoint-worker-{attempt}"
            retried = _claim_chat(db, chat.job_id, next_worker)
            retry_steps = ChatStepRuntime(
                db,
                run_id=chat.run_id,
                job=retried,
                execution_context=JobExecutionContext(
                    job_id=retried.id,
                    worker_id=next_worker,
                    attempt_no=retried.attempts,
                    resource_class="Light",
                ),
                llm_runtime=cast(ExecutionRuntime, object()),
            )
            with pytest.raises(UncertainChatStep):
                retry_steps.read(path, ReplayPolicy.BilledOnce)
            terminal = fail_job(
                db,
                job_id=chat.job_id,
                worker_id=next_worker,
                error_code="E_WORKER_INTERRUPTED",
                error_message="ambiguous external outcome",
                retry_delays_seconds=(0, 0),
            )
        assert terminal == "dead"

        reconcile_uncertain_chat_step(
            db,
            run_id=chat.run_id,
            step_path=path,
            resolution=ProveNotDispatched(),
        )
        repaired = db.execute(
            text(
                "SELECT status, attempts, payload #>> "
                "'{coordination,generation/1,dispatch_phase}' "
                "FROM background_jobs WHERE id = :job_id"
            ),
            {"job_id": chat.job_id},
        ).one()
        assert repaired == ("pending", 0, "Prepared")
