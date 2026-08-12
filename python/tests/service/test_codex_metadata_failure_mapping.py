"""Durable public-boundary proof for native metadata failure mapping."""

from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from nexus.db.models import AgentTurn, Media
from nexus.errors import ApiErrorCode
from tests.service.test_codex_metadata_enrichment import (
    _audit_requests,
    _host,
    _seed_media_job,
    _start_worker,
)
from tests.testkit.worker import controller_run, kill_and_forget_process, wait_for_job


def test_native_timeout_persists_as_a_distinct_metadata_failure(engine: Engine) -> None:
    """Risk: a typed native failure is collapsed into a generic runtime outcome."""
    run = controller_run()
    seeded = _seed_media_job(engine)

    with _host(run, "timeout") as host:
        worker = _start_worker(run, host.socket_path)
        try:
            terminal = wait_for_job(engine, seeded.job_id, status="succeeded", attempts=1)
        finally:
            kill_and_forget_process(worker)

        assert len(_audit_requests(host.audit_path)) == 1

    expected_code = ApiErrorCode.E_METADATA_AGENT_TIMEOUT.value
    assert terminal[4] == {
        "status": "failed",
        "reason": "agent_terminal",
        "error_code": expected_code,
    }, f"native turn_timeout must persist as E_METADATA_AGENT_TIMEOUT; observed {terminal[4]!r}"

    with Session(engine) as db:
        media = db.get(Media, seeded.media_id)
        turn = db.scalar(
            select(AgentTurn).where(
                AgentTurn.owner_kind == "media_enrichment",
                AgentTurn.owner_id == seeded.media_id,
            )
        )

    assert media is not None
    assert media.last_error_code == expected_code
    assert turn is not None
    assert turn.outcome == "failed"
    assert turn.error_code == "turn_timeout"
