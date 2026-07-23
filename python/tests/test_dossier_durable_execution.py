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
import json
from collections.abc import Callable
from dataclasses import replace
from uuid import UUID, uuid4

import pytest
from provider_runtime import (
    Absent,
    CallMeta,
    PossiblyBillable,
    Present,
    ProviderTarget,
    Refused,
    ResponsePayload,
    StructuredContent,
    Succeeded,
    TokenUsage,
)
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.jobs.queue import (
    JobExecutionContext,
    RescheduleRequested,
    get_job,
)
from nexus.schemas.presence import absent as replay_absent
from nexus.schemas.presence import present as replay_present

# --- CANONICAL A19 targets (do not exist yet -> ImportError == the RED) -------
from nexus.services.artifacts import coordination
from nexus.services.artifacts import engine as artifact_engine
from nexus.services.artifacts.coordination import (  # noqa: E402
    AttachReconciledResult,
    Completed,
    Prepared,
    ProveNotDispatched,
    Uncertain,
)
from nexus.services.artifacts.dossier_types import (  # noqa: E402
    ArtifactBuildEventType,
    DossierBuildExecutionPhase,
    DossierBuildFailureCode,
    DossierGenerationInProgress,
    SubjectResource,
)
from nexus.services.artifacts.engine import (  # noqa: E402
    cancel_build,
    create_build,
    read_head,
    reconcile_uncertain_build,
    run_build,
)
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.library_governance import (
    remove_library_member,
    transfer_library_ownership,
)
from nexus.services.media_intelligence import current_content_fingerprint
from nexus.services.resource_graph.refs import ResourceRef
from tests.factories import (
    add_library_member,
    create_searchable_media_in_library,
    create_test_conversation,
    create_test_library,
    create_test_message,
)
from tests.utils.dossier_jobs import (
    claim_dossier_build_job,
    dead_letter_dossier_build_job,
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


class _SuccessfulRuntime:
    def __init__(
        self,
        *,
        with_citation: bool = True,
        on_generate: Callable[[], None] | None = None,
    ) -> None:
        self.calls = 0
        self.with_citation = with_citation
        self.on_generate = on_generate

    async def generate(self, intent, plan, credential):  # noqa: ANN001
        self.calls += 1
        if self.on_generate is not None:
            self.on_generate()
        payload = (
            {
                "content_md": "The conversation establishes a grounded claim. [1]",
                "citations": [{"ordinal": 1, "candidate_index": 0, "role": "supports"}],
            }
            if self.with_citation
            else {
                "content_md": "The conversation establishes a claim.",
                "citations": [],
            }
        )
        return Succeeded(
            meta=CallMeta(
                provider=intent.target.provider,
                model=intent.target.model,
                provider_request_id=Present("req-dossier-success"),
                upstream_provider=Absent(),
                usage=Present(
                    TokenUsage(
                        input_tokens=50,
                        output_tokens=25,
                        total_tokens=75,
                        reasoning_tokens=Absent(),
                        cache_read_input_tokens=Absent(),
                        cache_write_input_tokens=Absent(),
                    )
                ),
                attempt_trace=(),
                billability=PossiblyBillable(),
            ),
            response=ResponsePayload(
                content=StructuredContent(payload=payload, text=json.dumps(payload)),
                continuation=Absent(),
            ),
        )

    def stream(self, intent, plan, credential, *, cancel):  # noqa: ANN001, pragma: no cover
        raise NotImplementedError


class _RefusedRuntime:
    def __init__(self, *, on_generate: Callable[[], None] | None = None) -> None:
        self.calls = 0
        self.on_generate = on_generate

    async def generate(self, intent, plan, credential):  # noqa: ANN001
        self.calls += 1
        if self.on_generate is not None:
            self.on_generate()
        return Refused(
            meta=CallMeta(
                provider=intent.target.provider,
                model=intent.target.model,
                provider_request_id=Present("req-dossier-refused"),
                upstream_provider=Absent(),
                usage=Absent(),
                attempt_trace=(),
                billability=PossiblyBillable(),
            ),
            safe_detail="provider declined",
        )

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


def _library_with_ready_source(
    db: Session,
    *,
    owner_id: UUID,
    member_id: UUID,
) -> UUID:
    library_id = create_test_library(db, owner_id)
    add_library_member(db, library_id, member_id)
    media_id = create_searchable_media_in_library(
        db,
        owner_id,
        library_id,
        title="Shared source",
    )
    fingerprint = current_content_fingerprint(db, media_id=media_id)
    summary_id = db.execute(
        text("SELECT id FROM media_summaries WHERE media_id = :media_id"),
        {"media_id": media_id},
    ).scalar_one()
    span_id = db.execute(
        text(
            "SELECT id FROM evidence_spans "
            "WHERE owner_kind = 'media' AND owner_id = :media_id LIMIT 1"
        ),
        {"media_id": media_id},
    ).scalar_one()
    db.execute(
        text(
            "UPDATE media_summaries SET status = 'ready', "
            "content_fingerprint = :fingerprint, summary_md = 'Summary' "
            "WHERE id = :summary_id"
        ),
        {"fingerprint": fingerprint, "summary_id": summary_id},
    )
    db.execute(
        text(
            "INSERT INTO media_claims "
            "(media_id, summary_id, claim_text, evidence_span_id, ordinal) "
            "VALUES (:media_id, :summary_id, 'Grounded claim', :span_id, 0)"
        ),
        {
            "media_id": media_id,
            "summary_id": summary_id,
            "span_id": span_id,
        },
    )
    db.commit()
    return library_id


def _dead_uncertain_dossier_build(
    db: Session,
    *,
    idempotency_key: str,
) -> tuple[UUID, UUID]:
    user_id = _user(db)
    locator = _conversation_locator(db, user_id)
    ticket = create_build(
        db,
        locator=locator,
        requester_user_id=user_id,
        idempotency_key=idempotency_key,
        instruction=None,
    )
    claimed = claim_dossier_build_job(
        db,
        build_id=ticket.build_id,
        worker_id="w-corrupt-reconcile",
    )
    runtime = _RaisingRuntime()
    with pytest.raises(RuntimeError, match="simulated provider crash"):
        asyncio.run(
            run_build(
                db,
                build_id=ticket.build_id,
                ctx=JobExecutionContext(
                    job_id=claimed.id,
                    worker_id="w-corrupt-reconcile",
                    attempt_no=claimed.attempts,
                ),
                runtime=runtime,
            )
        )
    assert runtime.calls == 1
    db.execute(
        text(
            "UPDATE background_jobs SET status = 'dead', claimed_by = NULL, "
            "lease_expires_at = NULL, finished_at = now() WHERE id = :job_id"
        ),
        {"job_id": claimed.id},
    )
    db.commit()
    return ticket.build_id, claimed.id


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
    job = claim_dossier_build_job(
        db_session,
        build_id=ticket.build_id,
        worker_id="w1",
    )
    # Force lease expiry with retry budget remaining (attempts < max_attempts).
    db_session.execute(
        text(
            "UPDATE background_jobs SET max_attempts = GREATEST(max_attempts, 3), attempts = 1, "
            "lease_expires_at = now() - interval '1 hour' WHERE id = :j"
        ),
        {"j": job.id},
    )
    db_session.commit()
    reclaimed = claim_dossier_build_job(
        db_session,
        build_id=ticket.build_id,
        worker_id="w2",
    )
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
    job = claim_dossier_build_job(
        db_session,
        build_id=ticket.build_id,
        worker_id="w1",
    )
    # Exhaust the attempt budget with an expired lease -> dead-letter eligible.
    db_session.execute(
        text(
            "UPDATE background_jobs SET attempts = max_attempts, "
            "lease_expires_at = now() - interval '1 hour' WHERE id = :j"
        ),
        {"j": job.id},
    )
    db_session.commit()
    dead = dead_letter_dossier_build_job(db_session, build_id=ticket.build_id)
    assert dead.id == job.id and dead.status == "dead"

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
    job = claim_dossier_build_job(
        db_session,
        build_id=ticket.build_id,
        worker_id="w1",
    )
    db_session.execute(
        text(
            "UPDATE background_jobs SET attempts = max_attempts, "
            "lease_expires_at = now() - interval '1 hour' WHERE id = :j"
        ),
        {"j": job.id},
    )
    db_session.commit()
    dead_letter_dossier_build_job(db_session, build_id=ticket.build_id)

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
    first = _RaisingRuntime()
    claimed = claim_dossier_build_job(
        db_session,
        build_id=ticket.build_id,
        worker_id="w1",
    )
    ctx1 = JobExecutionContext(job_id=claimed.id, worker_id="w1", attempt_no=claimed.attempts)
    with pytest.raises(RuntimeError):
        asyncio.run(run_build(db_session, build_id=ticket.build_id, ctx=ctx1, runtime=first))
    assert first.calls == 1, "coordination commits Uncertain, then dispatches exactly once"

    # Replay: coordination sees Uncertain and (no provider idempotency) defects
    # WITHOUT re-dispatching the billed call.
    second = _RaisingRuntime()
    ctx2 = JobExecutionContext(job_id=claimed.id, worker_id="w1", attempt_no=claimed.attempts)
    with pytest.raises(RuntimeError):
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


def test_runtime_rejects_changed_replay_generation_identity(db_session: Session) -> None:
    uid = _user(db_session)
    loc = _conversation_locator(db_session, uid)
    ticket = create_build(
        db_session,
        locator=loc,
        requester_user_id=uid,
        idempotency_key="corrupt-runtime-generation",
        instruction=None,
    )
    claimed = claim_dossier_build_job(
        db_session,
        build_id=ticket.build_id,
        worker_id="w-corrupt-runtime-generation",
    )
    ctx = JobExecutionContext(
        job_id=claimed.id,
        worker_id="w-corrupt-runtime-generation",
        attempt_no=claimed.attempts,
    )
    first = _RaisingRuntime()
    with pytest.raises(RuntimeError, match="simulated provider crash"):
        asyncio.run(run_build(db_session, build_id=ticket.build_id, ctx=ctx, runtime=first))
    assert first.calls == 1

    job = get_job(db_session, claimed.id)
    assert job is not None
    payload = dict(job.payload)
    raw_states = dict(payload["coordination"])
    state = coordination.StepReplayState.model_validate(raw_states["synthesis"])
    raw_states["synthesis"] = state.model_copy(
        update={"generation_id": uuid4()}
    ).model_dump(mode="json")
    payload["coordination"] = raw_states
    db_session.execute(
        text("UPDATE background_jobs SET payload = CAST(:payload AS jsonb) WHERE id = :job_id"),
        {"payload": json.dumps(payload), "job_id": claimed.id},
    )
    db_session.commit()

    replay = _RaisingRuntime()
    with pytest.raises(AssertionError, match="replay generation identity changed"):
        asyncio.run(run_build(db_session, build_id=ticket.build_id, ctx=ctx, runtime=replay))
    assert replay.calls == 0


@pytest.mark.parametrize("target_change", ["provider", "model"])
def test_provider_target_is_part_of_replay_request_fingerprint(
    db_session: Session,
    monkeypatch,
    target_change: str,
) -> None:
    uid = _user(db_session)
    loc = _conversation_locator(db_session, uid)
    ticket = create_build(
        db_session,
        locator=loc,
        requester_user_id=uid,
        idempotency_key=f"changed-provider-target-{target_change}",
        instruction=None,
    )
    claimed = claim_dossier_build_job(
        db_session,
        build_id=ticket.build_id,
        worker_id=f"w-changed-provider-target-{target_change}",
    )
    ctx = JobExecutionContext(
        job_id=claimed.id,
        worker_id=f"w-changed-provider-target-{target_change}",
        attempt_no=claimed.attempts,
    )
    first = _RaisingRuntime()
    with pytest.raises(RuntimeError, match="simulated provider crash"):
        asyncio.run(run_build(db_session, build_id=ticket.build_id, ctx=ctx, runtime=first))
    assert first.calls == 1

    original_profile = artifact_engine.operation_profile("dossier_conversation")
    changed_target = (
        ProviderTarget(provider="anthropic", model="claude-sonnet-5")
        if target_change == "provider"
        else ProviderTarget(
            provider=original_profile.target.provider,
            model=f"{original_profile.target.model}-changed",
        )
    )
    changed_profile = replace(original_profile, target=changed_target)
    monkeypatch.setattr(
        artifact_engine,
        "operation_profile",
        lambda operation: changed_profile,
    )
    replay = _RaisingRuntime()

    asyncio.run(run_build(db_session, build_id=ticket.build_id, ctx=ctx, runtime=replay))

    assert replay.calls == 0
    assert db_session.execute(
        text(
            "SELECT failure_code FROM artifact_build_failures "
            "WHERE build_id = :build_id"
        ),
        {"build_id": ticket.build_id},
    ).scalar_one() == DossierBuildFailureCode.InputsChanged


@pytest.mark.parametrize(
    ("corruption", "expected_error"),
    [
        ("payload", "payload identity changed"),
        ("generation", "generation identity changed"),
        ("request", "no request fingerprint"),
        ("terminal", "already has a terminal result"),
    ],
)
def test_operator_reconcile_rejects_corrupt_replay_evidence(
    db_session: Session,
    corruption: str,
    expected_error: str,
) -> None:
    build_id, job_id = _dead_uncertain_dossier_build(
        db_session,
        idempotency_key=f"corrupt-reconcile-{corruption}",
    )
    job = get_job(db_session, job_id)
    assert job is not None
    payload = dict(job.payload)
    if corruption == "payload":
        payload["build_id"] = str(uuid4())
    else:
        raw_states = dict(payload["coordination"])
        state = coordination.StepReplayState.model_validate(raw_states["synthesis"])
        if corruption == "generation":
            state = state.model_copy(update={"generation_id": uuid4()})
        elif corruption == "request":
            state = state.model_copy(update={"request_fingerprint": replay_absent()})
        else:
            state = state.model_copy(
                update={"terminal_result": replay_present("{}")}
            )
        raw_states["synthesis"] = state.model_dump(mode="json")
        payload["coordination"] = raw_states
    db_session.execute(
        text("UPDATE background_jobs SET payload = CAST(:payload AS jsonb) WHERE id = :job_id"),
        {"payload": json.dumps(payload), "job_id": job_id},
    )
    db_session.commit()

    with pytest.raises(AssertionError, match=expected_error):
        reconcile_uncertain_build(
            db_session,
            build_id=build_id,
            resolution=ProveNotDispatched(),
        )


def test_success_is_cited_current_provenanced_and_replay_safe(db_session: Session) -> None:
    uid = _user(db_session)
    loc = _conversation_locator(db_session, uid)
    ticket = create_build(
        db_session,
        locator=loc,
        requester_user_id=uid,
        idempotency_key="success-1",
        instruction="Emphasize the settled claim.",
    )
    claimed = claim_dossier_build_job(
        db_session,
        build_id=ticket.build_id,
        worker_id="w-success",
    )
    ctx = JobExecutionContext(
        job_id=claimed.id,
        worker_id="w-success",
        attempt_no=claimed.attempts,
    )
    runtime = _SuccessfulRuntime()

    asyncio.run(run_build(db_session, build_id=ticket.build_id, ctx=ctx, runtime=runtime))

    revision = db_session.execute(
        text(
            "SELECT r.id, r.input_manifest, a.current_revision_id "
            "FROM artifact_revisions r "
            "JOIN artifact_builds b ON b.id = r.build_id "
            "JOIN artifacts a ON a.id = b.artifact_id "
            "WHERE r.build_id = :build_id"
        ),
        {"build_id": ticket.build_id},
    ).mappings().one()
    revision_id = UUID(str(revision["id"]))
    assert UUID(str(revision["current_revision_id"])) == revision_id
    assert revision["input_manifest"]["kind"] == "conversation"
    assert db_session.execute(
        text(
            "SELECT count(*) FROM resource_edges "
            "WHERE source_scheme = 'artifact_revision' AND source_id = :revision_id "
            "AND origin = 'citation'"
        ),
        {"revision_id": revision_id},
    ).scalar_one() >= 1
    ledger = db_session.execute(
        text(
            "SELECT owner_kind, owner_id, llm_operation, total_tokens "
            "FROM llm_calls WHERE owner_kind = 'artifact_build' AND owner_id = :build_id"
        ),
        {"build_id": ticket.build_id},
    ).one()
    assert ledger == ("artifact_build", ticket.build_id, "dossier_conversation", 75)
    assert [row[0] for row in db_session.execute(
        text(
            "SELECT event_type FROM artifact_build_events "
            "WHERE build_id = :build_id ORDER BY seq"
        ),
        {"build_id": ticket.build_id},
    )] == ["Started", "Succeeded"]
    head = read_head(db_session, locator=loc, requester_user_id=uid)
    assert head.current_revision_id == revision_id
    assert head.freshness == "current"
    assert runtime.calls == 1

    replay_runtime = _SuccessfulRuntime()
    asyncio.run(run_build(db_session, build_id=ticket.build_id, ctx=ctx, runtime=replay_runtime))
    assert replay_runtime.calls == 0
    assert db_session.execute(
        text("SELECT count(*) FROM artifact_revisions WHERE build_id = :build_id"),
        {"build_id": ticket.build_id},
    ).scalar_one() == 1


def test_provider_output_without_citations_fails_citation_validation(
    db_session: Session,
) -> None:
    uid = _user(db_session)
    loc = _conversation_locator(db_session, uid)
    ticket = create_build(
        db_session,
        locator=loc,
        requester_user_id=uid,
        idempotency_key="zero-citation",
        instruction=None,
    )
    claimed = claim_dossier_build_job(
        db_session,
        build_id=ticket.build_id,
        worker_id="w-zero-citation",
    )
    ctx = JobExecutionContext(
        job_id=claimed.id,
        worker_id="w-zero-citation",
        attempt_no=claimed.attempts,
    )
    runtime = _SuccessfulRuntime(with_citation=False)

    asyncio.run(run_build(db_session, build_id=ticket.build_id, ctx=ctx, runtime=runtime))

    assert runtime.calls == 1
    assert db_session.execute(
        text(
            "SELECT failure_code FROM artifact_build_failures "
            "WHERE build_id = :build_id"
        ),
        {"build_id": ticket.build_id},
    ).scalar_one() == DossierBuildFailureCode.CitationValidationFailed
    assert db_session.execute(
        text(
            "SELECT count(*) FROM artifact_revisions "
            "WHERE build_id = :build_id"
        ),
        {"build_id": ticket.build_id},
    ).scalar_one() == 0


def test_inputs_changed_precedes_invalid_generated_citations(
    db_session: Session,
) -> None:
    uid = _user(db_session)
    loc = _conversation_locator(db_session, uid)
    ticket = create_build(
        db_session,
        locator=loc,
        requester_user_id=uid,
        idempotency_key="zero-citation-input-change",
        instruction=None,
    )
    claimed = claim_dossier_build_job(
        db_session,
        build_id=ticket.build_id,
        worker_id="w-zero-citation-input-change",
    )
    runtime = _SuccessfulRuntime(
        with_citation=False,
        on_generate=lambda: create_test_message(
            db_session,
            loc.ref.id,
            seq=3,
            role="user",
            content="This changed while the provider was running.",
        ),
    )

    asyncio.run(
        run_build(
            db_session,
            build_id=ticket.build_id,
            ctx=JobExecutionContext(
                job_id=claimed.id,
                worker_id="w-zero-citation-input-change",
                attempt_no=claimed.attempts,
            ),
            runtime=runtime,
        )
    )

    assert db_session.execute(
        text(
            "SELECT failure_code FROM artifact_build_failures "
            "WHERE build_id = :build_id"
        ),
        {"build_id": ticket.build_id},
    ).scalar_one() == DossierBuildFailureCode.InputsChanged


def test_library_member_removed_during_dispatch_cannot_promote(
    db_session: Session,
) -> None:
    owner_id = _user(db_session)
    requester_id = _user(db_session)
    library_id = _library_with_ready_source(
        db_session,
        owner_id=owner_id,
        member_id=requester_id,
    )
    ticket = create_build(
        db_session,
        locator=SubjectResource(ref=ResourceRef(scheme="library", id=library_id)),
        requester_user_id=requester_id,
        idempotency_key="removed-member",
        instruction=None,
    )
    claimed = claim_dossier_build_job(
        db_session,
        build_id=ticket.build_id,
        worker_id="w-removed-member",
    )
    runtime = _SuccessfulRuntime(
        on_generate=lambda: remove_library_member(
            db_session,
            owner_id,
            library_id,
            requester_id,
        ),
    )

    asyncio.run(
        run_build(
            db_session,
            build_id=ticket.build_id,
            ctx=JobExecutionContext(
                job_id=claimed.id,
                worker_id="w-removed-member",
                attempt_no=claimed.attempts,
            ),
            runtime=runtime,
        )
    )

    assert db_session.execute(
        text(
            "SELECT failure_code FROM artifact_build_failures "
            "WHERE build_id = :build_id"
        ),
        {"build_id": ticket.build_id},
    ).scalar_one() == DossierBuildFailureCode.InputsChanged
    assert db_session.execute(
        text(
            "SELECT count(*) FROM artifact_revisions "
            "WHERE build_id = :build_id"
        ),
        {"build_id": ticket.build_id},
    ).scalar_one() == 0


def test_library_ownership_transfer_during_provider_refusal_is_inputs_changed(
    db_session: Session,
) -> None:
    owner_id = _user(db_session)
    new_owner_id = _user(db_session)
    library_id = _library_with_ready_source(
        db_session,
        owner_id=owner_id,
        member_id=new_owner_id,
    )
    ticket = create_build(
        db_session,
        locator=SubjectResource(ref=ResourceRef(scheme="library", id=library_id)),
        requester_user_id=owner_id,
        idempotency_key="ownership-transfer-refusal",
        instruction=None,
    )
    claimed = claim_dossier_build_job(
        db_session,
        build_id=ticket.build_id,
        worker_id="w-ownership-transfer",
    )
    runtime = _RefusedRuntime(
        on_generate=lambda: transfer_library_ownership(
            db_session,
            owner_id,
            library_id,
            new_owner_id,
        ),
    )

    asyncio.run(
        run_build(
            db_session,
            build_id=ticket.build_id,
            ctx=JobExecutionContext(
                job_id=claimed.id,
                worker_id="w-ownership-transfer",
                attempt_no=claimed.attempts,
            ),
            runtime=runtime,
        )
    )

    assert runtime.calls == 1
    assert db_session.execute(
        text(
            "SELECT failure_code FROM artifact_build_failures "
            "WHERE build_id = :build_id"
        ),
        {"build_id": ticket.build_id},
    ).scalar_one() == DossierBuildFailureCode.InputsChanged
    assert db_session.execute(
        text(
            "SELECT count(*) FROM artifact_revisions "
            "WHERE build_id = :build_id"
        ),
        {"build_id": ticket.build_id},
    ).scalar_one() == 0


@pytest.mark.parametrize("recovered_result", [False, True])
def test_operator_reconciles_uncertain_build_without_automatic_redispatch(
    db_session: Session,
    recovered_result: bool,
) -> None:
    uid = _user(db_session)
    locator = _conversation_locator(db_session, uid)
    ticket = create_build(
        db_session,
        locator=locator,
        requester_user_id=uid,
        idempotency_key=f"repair-{recovered_result}",
        instruction=None,
    )
    claimed = claim_dossier_build_job(
        db_session,
        build_id=ticket.build_id,
        worker_id="w-uncertain",
    )
    first_ctx = JobExecutionContext(
        job_id=claimed.id,
        worker_id="w-uncertain",
        attempt_no=claimed.attempts,
    )
    first = _RaisingRuntime()
    with pytest.raises(RuntimeError):
        asyncio.run(
            run_build(
                db_session,
                build_id=ticket.build_id,
                ctx=first_ctx,
                runtime=first,
            )
        )
    assert first.calls == 1
    db_session.execute(
        text(
            "UPDATE background_jobs SET status = 'dead', claimed_by = NULL, "
            "lease_expires_at = NULL, finished_at = now() WHERE id = :job_id"
        ),
        {"job_id": claimed.id},
    )
    db_session.commit()

    payload = {
        "content_md": "Recovered grounded result. [1]",
        "citations": [{"ordinal": 1, "candidate_index": 0, "role": "supports"}],
    }
    resolution = (
        AttachReconciledResult(terminal_result=json.dumps(payload))
        if recovered_result
        else ProveNotDispatched()
    )
    reconcile_uncertain_build(
        db_session,
        build_id=ticket.build_id,
        resolution=resolution,
    )
    repaired = claim_dossier_build_job(
        db_session,
        build_id=ticket.build_id,
        worker_id="w-repaired",
    )
    assert repaired.id == claimed.id
    replay_ctx = JobExecutionContext(
        job_id=repaired.id,
        worker_id="w-repaired",
        attempt_no=repaired.attempts,
    )
    replay = _SuccessfulRuntime()
    asyncio.run(
        run_build(
            db_session,
            build_id=ticket.build_id,
            ctx=replay_ctx,
            runtime=replay,
        )
    )
    assert replay.calls == (0 if recovered_result else 1)
    assert db_session.execute(
        text("SELECT count(*) FROM artifact_revisions WHERE build_id = :build_id"),
        {"build_id": ticket.build_id},
    ).scalar_one() == 1


@pytest.mark.parametrize("recovered_result", [False, True])
def test_reconciled_build_rejects_inputs_changed_since_original_request(
    db_session: Session,
    recovered_result: bool,
) -> None:
    uid = _user(db_session)
    locator = _conversation_locator(db_session, uid)
    ticket = create_build(
        db_session,
        locator=locator,
        requester_user_id=uid,
        idempotency_key=f"repair-changed-{recovered_result}",
        instruction=None,
    )
    claimed = claim_dossier_build_job(
        db_session,
        build_id=ticket.build_id,
        worker_id="w-uncertain-changed",
    )
    first = _RaisingRuntime()
    with pytest.raises(RuntimeError):
        asyncio.run(
            run_build(
                db_session,
                build_id=ticket.build_id,
                ctx=JobExecutionContext(
                    job_id=claimed.id,
                    worker_id="w-uncertain-changed",
                    attempt_no=claimed.attempts,
                ),
                runtime=first,
            )
        )
    assert first.calls == 1
    db_session.execute(
        text(
            "UPDATE background_jobs SET status = 'dead', claimed_by = NULL, "
            "lease_expires_at = NULL, finished_at = now() WHERE id = :job_id"
        ),
        {"job_id": claimed.id},
    )
    create_test_message(
        db_session,
        locator.ref.id,
        seq=3,
        role="user",
        content="A new branch input changes the original request.",
    )
    payload = {
        "content_md": "Recovered grounded result. [1]",
        "citations": [{"ordinal": 1, "candidate_index": 0, "role": "supports"}],
    }
    reconcile_uncertain_build(
        db_session,
        build_id=ticket.build_id,
        resolution=(
            AttachReconciledResult(terminal_result=json.dumps(payload))
            if recovered_result
            else ProveNotDispatched()
        ),
    )
    repaired = claim_dossier_build_job(
        db_session,
        build_id=ticket.build_id,
        worker_id="w-repaired-changed",
    )
    assert repaired.id == claimed.id
    replay = _SuccessfulRuntime()

    asyncio.run(
        run_build(
            db_session,
            build_id=ticket.build_id,
            ctx=JobExecutionContext(
                job_id=repaired.id,
                worker_id="w-repaired-changed",
                attempt_no=repaired.attempts,
            ),
            runtime=replay,
        )
    )

    assert replay.calls == 0
    assert db_session.execute(
        text(
            "SELECT failure_code FROM artifact_build_failures "
            "WHERE build_id = :build_id"
        ),
        {"build_id": ticket.build_id},
    ).scalar_one() == DossierBuildFailureCode.InputsChanged
    assert db_session.execute(
        text(
            "SELECT count(*) FROM artifact_revisions "
            "WHERE build_id = :build_id"
        ),
        {"build_id": ticket.build_id},
    ).scalar_one() == 0


def test_aggregate_waits_for_media_unit_then_completes_same_build(
    db_session: Session,
) -> None:
    uid = _user(db_session)
    library_id = create_test_library(db_session, uid)
    media_id = create_searchable_media_in_library(
        db_session,
        uid,
        library_id,
        title="Dependency",
    )
    locator = SubjectResource(ref=ResourceRef(scheme="library", id=library_id))
    ticket = create_build(
        db_session,
        locator=locator,
        requester_user_id=uid,
        idempotency_key="aggregate-dependency",
        instruction=None,
    )
    claimed = claim_dossier_build_job(
        db_session,
        build_id=ticket.build_id,
        worker_id="w-dependency",
    )
    ctx = JobExecutionContext(
        job_id=claimed.id,
        worker_id="w-dependency",
        attempt_no=claimed.attempts,
    )
    before_ready = _SuccessfulRuntime()
    result = asyncio.run(
        run_build(
            db_session,
            build_id=ticket.build_id,
            ctx=ctx,
            runtime=before_ready,
        )
    )
    assert isinstance(result, RescheduleRequested)
    assert before_ready.calls == 0
    assert db_session.execute(
        text(
            "SELECT count(*) FROM artifact_revisions WHERE build_id = :build_id"
        ),
        {"build_id": ticket.build_id},
    ).scalar_one() == 0
    assert db_session.execute(
        text(
            "SELECT count(*) FROM artifact_build_failures WHERE build_id = :build_id"
        ),
        {"build_id": ticket.build_id},
    ).scalar_one() == 0

    summary_id = db_session.execute(
        text("SELECT id FROM media_summaries WHERE media_id = :media_id"),
        {"media_id": media_id},
    ).scalar_one()
    fingerprint = db_session.execute(
        text(
            "SELECT content_fingerprint FROM media_summaries WHERE media_id = :media_id"
        ),
        {"media_id": media_id},
    ).scalar_one()
    span_id = db_session.execute(
        text(
            "SELECT id FROM evidence_spans "
            "WHERE owner_kind = 'media' AND owner_id = :media_id LIMIT 1"
        ),
        {"media_id": media_id},
    ).scalar_one()
    db_session.execute(
        text(
            "UPDATE media_summaries SET status = 'ready', summary_md = 'Abstract.', "
            "model_name = 'test-model', content_fingerprint = :fingerprint "
            "WHERE id = :summary_id"
        ),
        {"fingerprint": fingerprint, "summary_id": summary_id},
    )
    db_session.execute(
        text(
            "INSERT INTO media_claims "
            "(id, media_id, summary_id, claim_text, evidence_span_id, ordinal) "
            "VALUES (:id, :media_id, :summary_id, 'Grounded claim.', :span_id, 0)"
        ),
        {
            "id": uuid4(),
            "media_id": media_id,
            "summary_id": summary_id,
            "span_id": span_id,
        },
    )
    db_session.commit()

    after_ready = _SuccessfulRuntime()
    assert (
        asyncio.run(
            run_build(
                db_session,
                build_id=ticket.build_id,
                ctx=ctx,
                runtime=after_ready,
            )
        )
        is None
    )
    assert after_ready.calls == 1
    assert db_session.execute(
        text("SELECT count(*) FROM artifact_revisions WHERE build_id = :build_id"),
        {"build_id": ticket.build_id},
    ).scalar_one() == 1


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
