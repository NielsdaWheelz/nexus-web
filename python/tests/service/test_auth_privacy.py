"""Priority proof: authentication failures redact credentials and private rows stay masked."""

from __future__ import annotations

from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, NotFoundError
from nexus.jobs.queue import claim_job, fail_job, update_running_job_payload
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.chat_run_execution import chat_run_execution_phase
from nexus.services.chat_runs import get_chat_run
from nexus.services.conversations import create_conversation, get_conversation
from nexus.services.durable_step_journal import DurableExecutionPhase
from tests.testkit.auth import UserRecord
from tests.testkit.chat import create_entitled_chat


def test_invalid_token_is_redacted_and_private_conversation_existence_is_masked(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    invalid_token = "nexus-invalid-private-token"
    response = authenticated_client.get(
        "/conversations",
        headers={"Authorization": f"Bearer {invalid_token}"},
    )
    assert response.status_code == 401, (
        f"invalid credential reached an authenticated collection: {response.text}"
    )
    assert invalid_token not in response.text, "authentication response disclosed the bearer token"

    private = create_conversation(db_session, test_user.id)
    other_user_id = uuid4()
    ensure_user_and_default_library(
        db_session,
        other_user_id,
        f"privacy-proof-{other_user_id}@example.invalid",
    )

    with pytest.raises(NotFoundError) as hidden:
        get_conversation(db_session, other_user_id, private.id)
    assert hidden.value.code == ApiErrorCode.E_CONVERSATION_NOT_FOUND
    assert "not found" in hidden.value.message.casefold(), (
        f"private conversation denial leaked a distinct existence signal: {hidden.value!r}"
    )


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
