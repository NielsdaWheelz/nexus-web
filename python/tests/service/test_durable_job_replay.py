"""Priority proof: an expired worker lease replays through the real worker safely."""

from __future__ import annotations

import json
import os
import signal
import socket
import time
from collections.abc import Mapping
from pathlib import Path
from uuid import UUID, uuid4

from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, User
from nexus.db.session import create_session_factory
from nexus.jobs.queue import claim_job, complete_job, enqueue_job
from nexus.jobs.registry import get_default_registry
from nexus.jobs.worker import JobWorker
from nexus.services.auth_handoff_codes import create_auth_handoff_code
from nexus.services.chat_run_steps import ProveNotDispatched, reconcile_uncertain_chat_step
from nexus.services.chat_runs import get_chat_run
from nexus.services.note_indexing import enqueue_note_reindex
from nexus_test_control import services as test_services
from nexus_test_control.model import Resource, ResourceKind
from nexus_test_control.runtime import (
    forget_cleaned,
    process_resource_identity,
)
from tests.testkit.chat import create_entitled_chat
from tests.testkit.unreachable_state import (
    expire_claim_and_handoff_code,
    expire_job_claim,
    make_failed_job_retryable,
)

_KIND = "purge_expired_auth_handoff_codes"
_REPO_ROOT = Path(__file__).resolve().parents[3]
_TEST_ENV = {"NEXUS_ENV": "test"}


def _controller_run() -> test_services.TestRun:
    run_id = os.environ.get("NEXUS_TEST_RUN_ID")
    database_url = os.environ.get("DATABASE_URL")
    bucket = os.environ.get("R2_BUCKET")
    assert run_id and database_url and bucket, (
        "worker-process proof requires its controller-owned service run"
    )
    return test_services.TestRun(
        run_id=run_id,
        database_url=database_url,
        migration_database_url=None,
        bucket=bucket,
        supabase=test_services.ensure_services(_REPO_ROOT, _TEST_ENV),
    )


def _wait_for_job(
    engine: Engine,
    job_id: UUID,
    *,
    status: str,
    attempts: int,
    minimum_lease_seconds: float | None = None,
    timeout_seconds: float = 30,
) -> tuple[object, ...]:
    deadline = time.monotonic() + timeout_seconds
    observed: tuple[object, ...] | None = None
    while time.monotonic() < deadline:
        with engine.connect() as oracle:
            row = oracle.execute(
                text(
                    """
                    SELECT status,
                           attempts,
                           claimed_by,
                           lease_expires_at,
                           result,
                           EXTRACT(EPOCH FROM lease_expires_at - now()) AS lease_seconds
                    FROM background_jobs
                    WHERE id = :job_id
                    """
                ),
                {"job_id": job_id},
            ).one()
        observed = tuple(row[:5])
        if (
            row.status == status
            and row.attempts == attempts
            and (
                minimum_lease_seconds is None
                or float(row.lease_seconds or 0) >= minimum_lease_seconds
            )
        ):
            return observed
    raise AssertionError(
        f"job {job_id} did not reach {status=} and {attempts=}; last row: {observed!r}"
    )


def _external_chat_evidence(run_id: str) -> list[dict[str, object]]:
    path = _REPO_ROOT / "test-results" / "runs" / run_id / "external-durable-chat.jsonl"
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def _advance_failed_job(engine: Engine, job_id: UUID) -> None:
    with Session(engine) as db:
        make_failed_job_retryable(db, job_id=job_id)
        db.commit()


def _index_snapshot(engine: Engine, note_block_id: UUID) -> tuple[object, ...]:
    with engine.connect() as oracle:
        row = oracle.execute(
            text(
                """
                SELECT
                    (SELECT status FROM content_index_states
                     WHERE owner_kind = 'note_block' AND owner_id = :owner_id),
                    (SELECT COUNT(*) FROM content_blocks
                     WHERE owner_kind = 'note_block' AND owner_id = :owner_id),
                    (SELECT COUNT(*) FROM evidence_spans
                     WHERE owner_kind = 'note_block' AND owner_id = :owner_id),
                    (SELECT COUNT(*) FROM content_chunks
                     WHERE owner_kind = 'note_block' AND owner_id = :owner_id),
                    (SELECT COUNT(*) FROM content_embeddings ce
                     JOIN content_chunks cc ON cc.id = ce.chunk_id
                     WHERE cc.owner_kind = 'note_block' AND cc.owner_id = :owner_id)
                """
            ),
            {"owner_id": note_block_id},
        ).one()
    return tuple(row)


def _wait_for_index_checkpoint(
    engine: Engine,
    note_block_id: UUID,
    *,
    timeout_seconds: float = 30,
) -> tuple[object, ...]:
    deadline = time.monotonic() + timeout_seconds
    observed: tuple[object, ...] | None = None
    while time.monotonic() < deadline:
        observed = _index_snapshot(engine, note_block_id)
        if observed == ("ready", 1, 1, 1, 1):
            return observed
    raise AssertionError(
        f"note index checkpoint did not commit exactly once; last snapshot: {observed!r}"
    )


def _assert_production_worker(
    process: test_services.StartedProcess,
    run: test_services.TestRun,
) -> None:
    process_root = Path("/proc") / str(process.process_group_id)
    command = tuple(
        part.decode("utf-8")
        for part in (process_root / "cmdline").read_bytes().split(b"\0")
        if part
    )
    environment = dict(
        part.decode("utf-8").split("=", 1)
        for part in (process_root / "environ").read_bytes().split(b"\0")
        if b"=" in part
    )
    assert command[-2:] == ("-m", "apps.worker.main"), (
        f"controller did not launch the production worker entrypoint: {command!r}"
    )
    assert environment.get("WORKER_LANE") == process.role.removeprefix("worker-")
    assert environment.get("DATABASE_URL") == run.database_url
    assert environment.get("NEXUS_TEST_RUN_ID") == run.run_id


def _kill_and_forget_worker(process: test_services.StartedProcess) -> None:
    os.killpg(process.process_group_id, signal.SIGKILL)
    waited_pid, wait_status = os.waitpid(process.process_group_id, 0)
    assert waited_pid == process.process_group_id
    assert os.waitstatus_to_exitcode(wait_status) == -signal.SIGKILL
    forget_cleaned(
        _REPO_ROOT,
        _TEST_ENV,
        process.run_id,
        Resource(
            ResourceKind.PROCESS,
            process_resource_identity(process.run_id, process.role),
        ),
    )


def test_expired_claim_replays_once_and_fences_the_crashed_worker(engine: Engine) -> None:
    user_id = uuid4()
    with Session(engine) as db:
        db.add(User(id=user_id, email=f"replay-proof-{user_id}@example.invalid"))
        db.commit()
        create_auth_handoff_code(
            db,
            user_id,
            access_token="synthetic-access-token",
            refresh_token="synthetic-refresh-token",
            challenge="a" * 64,
        )
        job = enqueue_job(
            db,
            kind=_KIND,
            payload={"request_id": "durable-replay-proof"},
            max_attempts=3,
        )
        db.commit()
        crashed_claim = claim_job(
            db,
            job_id=job.id,
            worker_id="crashed-worker",
            lease_seconds=300,
            allowed_kinds=(_KIND,),
        )
        assert crashed_claim is not None, "synthetic crashed worker did not acquire its job"
        expire_claim_and_handoff_code(db, job_id=job.id, user_id=user_id)
        db.commit()

    definition = get_default_registry()[_KIND]
    worker = JobWorker(
        session_factory=create_session_factory(engine),
        worker_id="recovery-worker",
        registry={_KIND: definition},
        allowed_kinds=(_KIND,),
    )
    assert worker.run_once() is True, "recovery worker did not replay the expired claim"

    with Session(engine) as oracle:
        row = oracle.execute(
            text(
                """
                SELECT status, attempts, claimed_by, lease_expires_at, result
                FROM background_jobs
                WHERE id = :job_id
                """
            ),
            {"job_id": job.id},
        ).one()
        remaining_codes = oracle.execute(
            text("SELECT COUNT(*) FROM auth_handoff_codes WHERE user_id = :user_id"),
            {"user_id": user_id},
        ).scalar_one()
        stale_completion = complete_job(
            oracle,
            job_id=job.id,
            worker_id="crashed-worker",
            result_payload={"deleted_count": 999},
        )

    assert row == ("succeeded", 2, None, None, {"deleted_count": 1}), (
        f"replayed job did not converge to one successful terminal result: {row!r}"
    )
    assert remaining_codes == 0, f"replayed purge left {remaining_codes} expired code(s)"
    assert stale_completion is False, "expired claimant mutated the recovered terminal job"


def test_owned_worker_replays_committed_note_index_after_process_death(
    engine: Engine,
) -> None:
    run = _controller_run()
    user_id = uuid4()
    note_block_id = uuid4()
    body = "A durable worker replay must converge to one persisted index."
    with Session(engine) as db:
        db.add(User(id=user_id, email=f"worker-replay-{user_id}@example.invalid"))
        db.flush()
        db.add(
            NoteBlock(
                id=note_block_id,
                user_id=user_id,
                body_pm_json={
                    "type": "doc",
                    "content": [
                        {
                            "type": "paragraph",
                            "content": [{"type": "text", "text": body}],
                        }
                    ],
                },
                body_text=body,
            )
        )
        db.flush()
        job_id = enqueue_note_reindex(db, note_block_id=note_block_id, reason="note_edit")
        db.commit()

    note_lock = engine.connect()
    note_transaction = note_lock.begin()
    job_lock = None
    job_transaction = None
    try:
        note_lock.execute(text("LOCK TABLE note_blocks IN ACCESS EXCLUSIVE MODE"))
        crashed = test_services.start_python_process(
            _REPO_ROOT, _TEST_ENV, run, "worker-background"
        )

        claimed = _wait_for_job(
            engine,
            job_id,
            status="running",
            attempts=1,
            minimum_lease_seconds=600,
        )
        _assert_production_worker(crashed, run)
        assert claimed[2] == f"{socket.gethostname()}:{crashed.process_group_id}", (
            f"job was not claimed by the controller-owned production worker: {claimed!r}"
        )

        job_lock = engine.connect()
        job_transaction = job_lock.begin()
        locked_job_id = job_lock.execute(
            text("SELECT id FROM background_jobs WHERE id = :job_id FOR UPDATE"),
            {"job_id": job_id},
        ).scalar_one()
        assert locked_job_id == job_id

        note_transaction.rollback()
        note_lock.close()
        checkpoint = _wait_for_index_checkpoint(engine, note_block_id)
        assert checkpoint == ("ready", 1, 1, 1, 1)
        still_running = _wait_for_job(engine, job_id, status="running", attempts=1)
        assert still_running[4] is None, (
            f"queue terminal result committed despite the held queue row: {still_running!r}"
        )

        _kill_and_forget_worker(crashed)
        job_transaction.rollback()
        job_lock.close()
        job_transaction = None
        job_lock = None

        with Session(engine) as db:
            expire_job_claim(db, job_id=job_id)
            db.commit()

        recovered = test_services.start_python_process(
            _REPO_ROOT, _TEST_ENV, run, "worker-background"
        )
        terminal = _wait_for_job(engine, job_id, status="succeeded", attempts=2)
        _assert_production_worker(recovered, run)

        assert terminal == (
            "succeeded",
            2,
            None,
            None,
            {
                "owner": {"kind": "note_block", "id": str(note_block_id)},
                "status": "ready",
                "chunk_count": 1,
            },
        ), f"restarted production worker did not converge exactly: {terminal!r}"
        assert _index_snapshot(engine, note_block_id) == ("ready", 1, 1, 1, 1), (
            "replay duplicated or lost the committed note index materialization"
        )
    finally:
        if note_transaction.is_active:
            note_transaction.rollback()
        note_lock.close()
        if job_transaction is not None and job_transaction.is_active:
            job_transaction.rollback()
        if job_lock is not None:
            job_lock.close()


def test_uncertain_chat_dispatch_suspends_then_reconciles_the_same_job(
    engine: Engine,
) -> None:
    """A real worker must not redispatch an ambiguous billed generation."""
    run = _controller_run()
    marker = f"Nexus durable ambiguity proof {uuid4()}"
    with Session(engine) as db:
        chat = create_entitled_chat(db, content=marker)

    worker = test_services.start_python_process(
        _REPO_ROOT,
        _TEST_ENV,
        run,
        "worker-interactive",
    )
    try:
        _assert_production_worker(worker, run)
        first_failure = _wait_for_job(
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
        _wait_for_job(
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
        suspended_job = _wait_for_job(
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

        terminal_job = _wait_for_job(
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
        _kill_and_forget_worker(worker)
