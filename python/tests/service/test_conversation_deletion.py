"""Priority proof: conversation deletion revokes only its private chat journal."""

from __future__ import annotations

from uuid import uuid4

from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.jobs.queue import claim_job, enqueue_job, fail_job, update_running_job_payload
from nexus.services.conversations import delete_conversation
from tests.testkit.chat import create_entitled_chat


def test_conversation_delete_removes_its_dead_chat_journal_only(engine: Engine) -> None:
    worker_id = "conversation-delete-proof-worker"
    with Session(engine) as db:
        chat = create_entitled_chat(
            db,
            content="This prompt must disappear with its deleted conversation.",
        )
        for attempt in range(1, 4):
            claimed = claim_job(
                db,
                job_id=chat.job_id,
                worker_id=worker_id,
                lease_seconds=300,
                allowed_kinds=("chat_run",),
            )
            assert claimed is not None
            if attempt == 1:
                assert update_running_job_payload(
                    db,
                    job_id=chat.job_id,
                    worker_id=worker_id,
                    attempt_no=attempt,
                    payload={
                        **claimed.payload,
                        "coordination": {"generation": {"terminal_result": "private"}},
                    },
                )
            assert fail_job(
                db,
                job_id=chat.job_id,
                worker_id=worker_id,
                error_code="E_DELETE_PROOF",
                error_message="synthetic dead chat",
                retry_delays_seconds=(0,),
            ) == ("dead" if attempt == 3 else "failed")
            db.commit()

        unrelated = enqueue_job(
            db,
            kind="purge_expired_auth_handoff_codes",
            payload={"owner": "unrelated-delete-sentinel"},
            dedupe_key=f"delete-sentinel:{uuid4()}",
            max_attempts=1,
        )
        db.commit()
        delete_conversation(db, chat.user_id, chat.conversation_id)

    with Session(engine) as oracle:
        chat_job_count = oracle.execute(
            text("SELECT count(*) FROM background_jobs WHERE id = :job_id"),
            {"job_id": chat.job_id},
        ).scalar_one()
        unrelated_status = oracle.execute(
            text("SELECT status FROM background_jobs WHERE id = :job_id"),
            {"job_id": unrelated.id},
        ).scalar_one()

    assert chat_job_count == 0, "conversation deletion retained its private chat journal"
    assert unrelated_status == "pending", "conversation deletion crossed into unrelated work"
