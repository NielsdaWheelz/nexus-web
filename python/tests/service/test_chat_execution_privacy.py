"""Priority proof: chat recovery state never exposes its private journal."""

from __future__ import annotations

from uuid import uuid4

import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from nexus.errors import NotFoundError
from nexus.jobs.queue import claim_job, fail_job, update_running_job_payload
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.chat_run_execution import chat_run_execution_phase
from nexus.services.chat_runs import get_chat_run
from nexus.services.durable_step_journal import DurableExecutionPhase
from tests.testkit.chat import create_entitled_chat


def test_suspended_chat_exposes_only_phase_and_masks_its_private_journal(
    engine: Engine,
) -> None:
    secret = "private prompt and provider output must never leave the journal"
    worker_id = "privacy-proof-worker"
    with Session(engine) as db:
        chat = create_entitled_chat(db, content="Show only the public execution phase.")
        for attempt in range(1, 4):
            claimed = claim_job(
                db,
                job_id=chat.job_id,
                worker_id=worker_id,
                lease_seconds=300,
                allowed_kinds=("chat_run",),
            )
            assert claimed is not None and claimed.attempts == attempt
            if attempt == 1:
                payload = {
                    **claimed.payload,
                    "coordination": {
                        "turn/0/generation": {
                            "request_fingerprint": "sensitive-fingerprint",
                            "terminal_result": secret,
                        }
                    },
                }
                assert update_running_job_payload(
                    db,
                    job_id=chat.job_id,
                    worker_id=worker_id,
                    attempt_no=attempt,
                    payload=payload,
                )
            transition = fail_job(
                db,
                job_id=chat.job_id,
                worker_id=worker_id,
                error_code="E_PRIVACY_PROOF",
                error_message="synthetic private recovery material",
                retry_delays_seconds=(0,),
            )
            assert transition == ("dead" if attempt == 3 else "failed")
            db.commit()

        response = get_chat_run(db, viewer_id=chat.user_id, run_id=chat.run_id)
        serialized = response.model_dump_json()
        phase = chat_run_execution_phase(db, run_id=chat.run_id)
        stranger = uuid4()
        ensure_user_and_default_library(db, stranger)
        with pytest.raises(NotFoundError):
            get_chat_run(db, viewer_id=stranger, run_id=chat.run_id)

    assert phase is DurableExecutionPhase.Suspended
    assert response.run.execution.model_dump(mode="json") == {
        "kind": "Present",
        "value": {"phase": "Suspended"},
    }
    for forbidden in (secret, "coordination", "request_fingerprint", "terminal_result"):
        assert forbidden not in serialized, (
            f"chat execution response disclosed journal field {forbidden!r}"
        )
