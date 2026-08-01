"""Priority proof: ambiguous chat dispatch suspends until operator reconciliation."""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from uuid import UUID, uuid4

from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.services.chat_run_steps import ProveNotDispatched, reconcile_uncertain_chat_step
from nexus.services.chat_runs import get_chat_run
from nexus_test_control import services as test_services
from tests.testkit.chat import create_entitled_chat
from tests.testkit.unreachable_state import (
    make_failed_job_retryable,
    prioritize_job_for_worker_proof,
)
from tests.testkit.worker import (
    assert_production_worker,
    controller_run,
    kill_and_forget_worker,
    wait_for_job,
)

_REPO_ROOT = Path(__file__).resolve().parents[3]
_TEST_ENV = {"NEXUS_ENV": "test"}


def _external_chat_evidence(run_id: str) -> list[dict[str, object]]:
    path = _REPO_ROOT / "test-results" / "runs" / run_id / "external-durable-chat.jsonl"
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def _advance_failed_job(engine: Engine, job_id: UUID) -> None:
    with Session(engine) as db:
        make_failed_job_retryable(db, job_id=job_id)
        db.commit()


def test_uncertain_chat_dispatch_suspends_then_reconciles_the_same_job(
    engine: Engine,
) -> None:
    """A real worker must not redispatch an ambiguous billed generation."""
    run = controller_run()
    marker = f"Nexus durable ambiguity proof {uuid4()}"
    with Session(engine) as db:
        chat = create_entitled_chat(db, content=marker)
        prioritize_job_for_worker_proof(db, job_id=chat.job_id)
        db.commit()

    worker = test_services.start_python_process(
        _REPO_ROOT,
        _TEST_ENV,
        run,
        "worker-interactive",
    )
    try:
        assert_production_worker(worker, run)
        first_failure = wait_for_job(
            engine,
            chat.job_id,
            status="failed",
            attempts=1,
            timeout_seconds=45,
        )
        assert first_failure[4] is None
        assert _external_chat_evidence(run.run_id) == [
            {
                "chat_run_id": str(chat.run_id),
                "observed_phase": "Uncertain",
                "request_index": 1,
            }
        ], "the provider boundary did not observe the pre-dispatch Uncertain checkpoint"

        _advance_failed_job(engine, chat.job_id)
        wait_for_job(
            engine,
            chat.job_id,
            status="failed",
            attempts=2,
            timeout_seconds=45,
        )
        assert len(_external_chat_evidence(run.run_id)) == 1, (
            "an automatic retry redispatched the uncertain provider request"
        )

        _advance_failed_job(engine, chat.job_id)
        suspended_job = wait_for_job(
            engine,
            chat.job_id,
            status="dead",
            attempts=3,
            timeout_seconds=45,
        )
        assert len(_external_chat_evidence(run.run_id)) == 1, (
            "retry exhaustion redispatched the uncertain provider request"
        )
        assert suspended_job[4] is None

        with Session(engine) as db:
            suspended = get_chat_run(db, viewer_id=chat.user_id, run_id=chat.run_id)
            serialized = suspended.model_dump_json()
            journal = db.execute(
                text("SELECT payload FROM background_jobs WHERE id = :job_id"),
                {"job_id": chat.job_id},
            ).scalar_one()
            done_count = db.execute(
                text(
                    "SELECT count(*) FROM chat_run_events "
                    "WHERE run_id = :run_id AND event_type = 'done'"
                ),
                {"run_id": chat.run_id},
            ).scalar_one()

            assert suspended.run.execution.model_dump(mode="json") == {
                "kind": "Present",
                "value": {"phase": "Suspended"},
            }
            assert "coordination" not in serialized, (
                "execution advisory disclosed private journal material"
            )
            assert journal["coordination"]["turn/0/generation"]["dispatch_phase"] == ("Uncertain")
            assert done_count == 0, "suspension falsely emitted a terminal event"

            reconcile_uncertain_chat_step(
                db,
                run_id=chat.run_id,
                step_path="turn/0/generation",
                resolution=ProveNotDispatched(),
            )
            repaired = db.execute(
                text("SELECT id, status, attempts FROM background_jobs WHERE id = :job_id"),
                {"job_id": chat.job_id},
            ).one()
            assert repaired == (chat.job_id, "pending", 0), (
                "operator repair replaced the durable job instead of requeueing it"
            )

        terminal_job = wait_for_job(
            engine,
            chat.job_id,
            status="succeeded",
            attempts=1,
            timeout_seconds=45,
        )
        terminal_result = terminal_job[4]
        assert isinstance(terminal_result, Mapping), (
            f"terminal chat job has no published result: {terminal_job!r}"
        )
        assert terminal_result == {
            "kind": "Published",
            "run_id": str(chat.run_id),
            "message_id": terminal_result["message_id"],
            "citation_count": 0,
        }
        assert _external_chat_evidence(run.run_id) == [
            {
                "chat_run_id": str(chat.run_id),
                "observed_phase": "Uncertain",
                "request_index": 1,
            },
            {
                "chat_run_id": str(chat.run_id),
                "observed_phase": "Uncertain",
                "request_index": 2,
            },
        ], "only explicit operator repair may permit the second provider request"

        with Session(engine) as oracle:
            terminal = get_chat_run(
                oracle,
                viewer_id=chat.user_id,
                run_id=chat.run_id,
            )
            snapshot = oracle.execute(
                text(
                    """
                    SELECT
                        (SELECT count(*) FROM llm_calls
                         WHERE owner_kind = 'chat_run' AND owner_id = :run_id),
                        (SELECT count(*) FROM chat_run_events
                         WHERE run_id = :run_id AND event_type = 'done'),
                        (SELECT content FROM messages
                         WHERE id = (SELECT assistant_message_id FROM chat_runs
                                     WHERE id = :run_id)),
                        (SELECT payload FROM background_jobs WHERE id = :job_id)
                    """
                ),
                {"run_id": chat.run_id, "job_id": chat.job_id},
            ).one()

        assert terminal.run.status == "complete"
        assert terminal.run.execution.model_dump(mode="json") == {"kind": "Absent"}
        assert snapshot == (
            2,
            1,
            "The reconciled durable response was published exactly once.",
            {"run_id": str(chat.run_id)},
        ), f"reconciled chat did not converge exactly once: {snapshot!r}"
    finally:
        kill_and_forget_worker(worker)
