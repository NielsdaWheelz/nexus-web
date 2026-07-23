"""CP1 RED contract tests — Dossier durable execution & liveness (T6).

Test-first for the hard cutover. Imports CANONICAL A19 identifiers that do NOT
exist yet -> COLLECTION-time ImportError == the intended RED. Goes green,
without edits, once CP2 lands the engine + coordination on the Postgres job
queue substrate per CONTRACTS.md A8 (durable execution) and B4 (durable-op
reuse map).

Substrate reuse (all REAL, exist today): nexus.jobs.queue lease reclaim
(Recovering), dead_letter_expired_job (Suspended), JobExecutionContext.
NET-NEW pinned surface under test: coordination Prepared/Uncertain/Completed,
DossierBuildExecutionPhase advisory, and the "uncertain never auto-redispatches"
defect. The uncertain/replay test exercises the highest-risk coordination
surface (see module RETURN notes for integrator-owned assumptions).
"""

from __future__ import annotations

import asyncio
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.jobs.queue import (
    JobExecutionContext,
    claim_next_job,
    dead_letter_expired_job,
)
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.resource_graph.refs import ResourceRef
from tests.factories import create_test_conversation, create_test_message

# --- CANONICAL A19 targets (do not exist yet -> ImportError == the RED) -------
from nexus.services.artifacts.coordination import (  # noqa: E402
    Completed,
    Prepared,
    Uncertain,
)
from nexus.services.artifacts.dossier_types import (  # noqa: E402
    ArtifactBuildEventType,
    DossierBuildExecutionPhase,
    DossierGenerationInProgress,
    SubjectResource,
)
from nexus.services.artifacts.engine import (  # noqa: E402
    cancel_build,
    create_build,
    read_head,
    run_build,
)

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _engine_session_factory(monkeypatch, db_session):
    from tests.utils.db import task_session_factory

    monkeypatch.setattr(
        "nexus.services.artifacts.engine.get_session_factory",
        lambda: task_session_factory(db_session),
        raising=False,
    )


@pytest.fixture(autouse=True)
def _rate_limiter(db_session):
    from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
    from tests.utils.db import task_session_factory

    previous = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=task_session_factory(db_session)))
    yield
    set_rate_limiter(previous)


@pytest.fixture(autouse=True)
def _platform_keys(monkeypatch):
    """A driven provider dispatch resolves a platform credential; set both keys so
    whichever provider the `balanced` dossier profile targets is satisfied."""
    from nexus.config import clear_settings_cache

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-platform-openai")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-platform")
    clear_settings_cache()
    yield
    clear_settings_cache()


class _RaisingRuntime:
    """Simulates a crash *at* dispatch: coordination commits Uncertain immediately
    before the network call, then the call raises. Counts dispatches."""

    def __init__(self) -> None:
        self.calls = 0

    async def generate(self, intent, plan, credential):  # noqa: ANN001
        self.calls += 1
        raise RuntimeError("simulated provider crash mid-dispatch")

    def stream(self, intent, plan, credential, *, cancel):  # noqa: ANN001, pragma: no cover
        raise NotImplementedError


def _user(db: Session) -> UUID:
    uid = uuid4()
    ensure_user_and_default_library(db, uid)
    grant_entitlement_override(
        db,
        user_id=uid,
        plan_tier="ai_pro",
        platform_token_quota_mode="unlimited",
        platform_token_limit_monthly=None,
        transcription_quota_mode="unlimited",
        transcription_minutes_limit_monthly=None,
        expires_at=None,
        reason="dossier durable-exec test",
        actor_label="test",
    )
    return uid


def _conversation_locator(db: Session, uid: UUID) -> SubjectResource:
    conv = create_test_conversation(db, uid)
    create_test_message(db, conv, seq=1, role="user", content="Discuss the core claim in depth.")
    create_test_message(db, conv, seq=2, role="assistant", content="A substantive settled reply.")
    return SubjectResource(ref=ResourceRef(scheme="conversation", id=conv))


def _job_id_for_build(db: Session, build_id: UUID) -> UUID:
    row = db.execute(
        text("SELECT id FROM background_jobs WHERE dedupe_key = :k"),
        {"k": f"dossier_build:{build_id}"},
    ).scalar_one()
    return UUID(str(row))


# --- Coordination replay states are the pinned NET-NEW surface ---------------


def test_coordination_replay_states_are_distinct() -> None:
    """B4: coordination.py owns the per-step Prepared|Uncertain|Completed machine."""
    assert Prepared is not Uncertain
    assert Uncertain is not Completed
    assert Prepared is not Completed


def test_execution_phase_advisory_enum_is_closed() -> None:
    assert {p.value for p in DossierBuildExecutionPhase} == {
        "Queued",
        "Running",
        "Recovering",
        "Suspended",
    }


# --- Recovering: lease expiry below attempt budget reclaims the SAME build ----


def test_lease_expiry_below_budget_recovers_same_build(db_session: Session) -> None:
    uid = _user(db_session)
    loc = _conversation_locator(db_session, uid)
    ticket = create_build(
        db_session, locator=loc, requester_user_id=uid, idempotency_key="k-1", instruction=None
    )
    job = claim_next_job(
        db_session, worker_id="w1", lease_seconds=600, allowed_kinds=["dossier_build"]
    )
    assert job is not None
    # Force lease expiry with retry budget remaining (attempts < max_attempts).
    db_session.execute(
        text(
            "UPDATE background_jobs SET max_attempts = GREATEST(max_attempts, 3), attempts = 1, "
            "lease_expires_at = now() - interval '1 hour' WHERE id = :j"
        ),
        {"j": job.id},
    )
    db_session.commit()
    reclaimed = claim_next_job(
        db_session, worker_id="w2", lease_seconds=600, allowed_kinds=["dossier_build"]
    )
    assert reclaimed is not None
    assert reclaimed.id == job.id, "lease expiry reclaims the SAME job/build (Recovering)"
    assert reclaimed.status == "running"
    assert reclaimed.attempts == 2
    head = read_head(db_session, locator=loc, requester_user_id=uid)
    assert head.active_build.execution == DossierBuildExecutionPhase.Recovering


# --- Suspended: dead-letter leaves a suspended prefix, no synth Failed --------


def test_dead_letter_suspends_without_synthesizing_failed(db_session: Session) -> None:
    uid = _user(db_session)
    loc = _conversation_locator(db_session, uid)
    ticket = create_build(
        db_session, locator=loc, requester_user_id=uid, idempotency_key="k-1", instruction=None
    )
    job = claim_next_job(
        db_session, worker_id="w1", lease_seconds=600, allowed_kinds=["dossier_build"]
    )
    assert job is not None
    # Exhaust the attempt budget with an expired lease -> dead-letter eligible.
    db_session.execute(
        text(
            "UPDATE background_jobs SET attempts = max_attempts, "
            "lease_expires_at = now() - interval '1 hour' WHERE id = :j"
        ),
        {"j": job.id},
    )
    db_session.commit()
    dead = dead_letter_expired_job(db_session, allowed_kinds=["dossier_build"])
    assert dead is not None and dead.id == job.id and dead.status == "dead"

    # No modeled failure child is synthesized from queue exhaustion (A8).
    fails = db_session.execute(
        text("SELECT count(*) FROM artifact_build_failures WHERE build_id = :b"),
        {"b": ticket.build_id},
    ).scalar_one()
    assert fails == 0
    head = read_head(db_session, locator=loc, requester_user_id=uid)
    assert head.active_build.execution == DossierBuildExecutionPhase.Suspended
    # A suspended build does NOT unlock a second Generate.
    with pytest.raises(DossierGenerationInProgress):
        create_build(
            db_session, locator=loc, requester_user_id=uid, idempotency_key="k-2", instruction=None
        )


def test_cancel_terminalizes_suspended_and_permits_new_generate(db_session: Session) -> None:
    uid = _user(db_session)
    loc = _conversation_locator(db_session, uid)
    ticket = create_build(
        db_session, locator=loc, requester_user_id=uid, idempotency_key="k-1", instruction=None
    )
    job = claim_next_job(
        db_session, worker_id="w1", lease_seconds=600, allowed_kinds=["dossier_build"]
    )
    assert job is not None
    db_session.execute(
        text(
            "UPDATE background_jobs SET attempts = max_attempts, "
            "lease_expires_at = now() - interval '1 hour' WHERE id = :j"
        ),
        {"j": job.id},
    )
    db_session.commit()
    dead_letter_expired_job(db_session, allowed_kinds=["dossier_build"])

    cancel_build(db_session, build_id=ticket.build_id, actor_user_id=uid)  # explicit abandon
    canc = db_session.execute(
        text("SELECT count(*) FROM artifact_build_cancellations WHERE build_id = :b"),
        {"b": ticket.build_id},
    ).scalar_one()
    assert canc == 1
    nxt = create_build(
        db_session, locator=loc, requester_user_id=uid, idempotency_key="k-2", instruction=None
    )
    assert nxt.created is True and nxt.build_id != ticket.build_id


# --- Uncertain: never auto-redispatches a billed call; defects for operator ---


def test_uncertain_dispatch_never_auto_redispatches(db_session: Session) -> None:
    uid = _user(db_session)
    loc = _conversation_locator(db_session, uid)
    ticket = create_build(
        db_session, locator=loc, requester_user_id=uid, idempotency_key="k-1", instruction=None
    )
    job_id = _job_id_for_build(db_session, ticket.build_id)

    first = _RaisingRuntime()
    claimed = claim_next_job(
        db_session, worker_id="w1", lease_seconds=600, allowed_kinds=["dossier_build"]
    )
    assert claimed is not None and claimed.id == job_id
    ctx1 = JobExecutionContext(job_id=job_id, worker_id="w1", attempt_no=claimed.attempts)
    with pytest.raises(BaseException):
        asyncio.run(run_build(db_session, build_id=ticket.build_id, ctx=ctx1, runtime=first))
    assert first.calls == 1, "coordination commits Uncertain, then dispatches exactly once"

    # Replay: coordination sees Uncertain and (no provider idempotency) defects
    # WITHOUT re-dispatching the billed call.
    second = _RaisingRuntime()
    ctx2 = JobExecutionContext(job_id=job_id, worker_id="w1", attempt_no=claimed.attempts)
    with pytest.raises(BaseException):
        asyncio.run(run_build(db_session, build_id=ticket.build_id, ctx=ctx2, runtime=second))
    assert second.calls == 0, "an uncertain billed call is never automatically repeated"

    # A defect is NOT softened into a modeled Failed child (suspended prefix stays).
    fails = db_session.execute(
        text("SELECT count(*) FROM artifact_build_failures WHERE build_id = :b"),
        {"b": ticket.build_id},
    ).scalar_one()
    rev = db_session.execute(
        text("SELECT count(*) FROM artifact_revisions WHERE build_id = :b"),
        {"b": ticket.build_id},
    ).scalar_one()
    assert fails == 0 and rev == 0


# --- ExecutionAdvisory is unsequenced and not persisted ----------------------


def test_execution_advisory_is_not_persisted_as_a_build_event(db_session: Session) -> None:
    uid = _user(db_session)
    loc = _conversation_locator(db_session, uid)
    ticket = create_build(
        db_session, locator=loc, requester_user_id=uid, idempotency_key="k-1", instruction=None
    )
    head = read_head(db_session, locator=loc, requester_user_id=uid)
    assert head.active_build is not None
    assert isinstance(head.active_build.execution, DossierBuildExecutionPhase)
    # The advisory phase never lands as a persisted event_type (it does not
    # advance the cursor); every persisted event is a real ArtifactBuildEventType.
    persisted = list(
        db_session.execute(
            text("SELECT event_type FROM artifact_build_events WHERE build_id = :b"),
            {"b": ticket.build_id},
        ).scalars()
    )
    valid = {e.value for e in ArtifactBuildEventType}
    assert all(t in valid for t in persisted)
    assert not (valid & {p.value for p in DossierBuildExecutionPhase})
