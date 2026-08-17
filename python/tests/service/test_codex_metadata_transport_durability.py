"""Priority proof for accepted native-agent transport loss."""

from __future__ import annotations

import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from nexus.db.models import AgentTurn
from nexus.errors import ApiErrorCode, ConflictError
from nexus.jobs.queue import get_job
from nexus.services.durable_step_journal import Uncertain, decode_step_states
from nexus.services.metadata_dispatch import METADATA_STEP_PATH
from nexus.services.metadata_lifecycle import retry_metadata_for_viewer
from tests.testkit.codex_metadata import (
    audit_requests,
    scripted_codex_host,
    seed_media_job,
    start_worker,
)
from tests.testkit.worker import controller_run, kill_and_forget_process, wait_for_job


def test_postaccept_disconnect_stays_incomplete_and_never_redispatches(
    engine: Engine,
) -> None:
    """Risk: transport loss after acceptance is mistaken for a safe retry."""
    run = controller_run()
    seeded = seed_media_job(engine)

    with scripted_codex_host(run, "accepted_disconnect") as host:
        worker = start_worker(run, host.socket_path)
        try:
            wait_for_job(engine, seeded.job_id, status="dead", attempts=2)
        finally:
            kill_and_forget_process(worker)
        assert len(audit_requests(host.audit_path)) == 1

    with Session(engine) as db:
        job = get_job(db, seeded.job_id)
        assert job is not None
        state = decode_step_states(job.payload)[METADATA_STEP_PATH]
        assert state.dispatch_phase is Uncertain
        turn = db.get(AgentTurn, state.generation_id)
        assert turn is not None
        assert turn.outcome is None
        assert turn.completed_at is None
        assert turn.session_ref is None

    with Session(engine) as db, pytest.raises(ConflictError) as raised:
        retry_metadata_for_viewer(db, seeded.user_id, seeded.media_id)
    assert raised.value.code is ApiErrorCode.E_RETRY_NOT_ALLOWED
    assert "unresolved native-agent turn" in raised.value.message
