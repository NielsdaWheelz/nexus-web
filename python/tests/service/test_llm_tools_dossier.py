"""Priority proof for the Idea Dossier's durable HostTable research plan."""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from llm_tools import (
    RecoveryRequired,
    WebSearchProvider,
    WebSearchRequest,
    WebSearchResponse,
    WebSearchResultItem,
    canonical_json_bytes,
)
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from nexus.config import clear_settings_cache
from nexus.db.models import (
    ArtifactBuildFailure,
    ArtifactIdeaSubject,
    Fragment,
    Media,
    MediaSourceAttempt,
    MediaSourceAttemptStatus,
    ProcessingStatus,
    SynthesisArtifact,
)
from nexus.db.session import create_session_factory
from nexus.errors import InvalidRequestError
from nexus.jobs.queue import (
    DEAD,
    PENDING,
    JobExecutionContext,
    JobRow,
    RescheduleRequested,
    claim_job,
    complete_job,
    fail_job,
    find_nonterminal_jobs_for_payload,
    get_job,
    reschedule_running_job,
)
from nexus.schemas.presence import Present, absent, present
from nexus.services.agent_tools.web_page_read import (
    dossier_web_search_items_from_tool_result,
)
from nexus.services.artifacts.coordination import DossierBuildRuntime
from nexus.services.artifacts.engine import (
    reconcile_uncertain_build,
    regenerate_artifact,
    run_build,
)
from nexus.services.artifacts.idea_identity import idea_key_from_selection
from nexus.services.artifacts.idea_seeds import find_or_create_idea_subject
from nexus.services.artifacts.research import (
    FrozenIdeaEvidence,
    collect_idea_evidence,
)
from nexus.services.artifacts.subject_policy import (
    ResolvedIdeaSubject,
    visible_persisted_subject,
)
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.codex_generation_contract import (
    GenerationCommand,
    GenerationFrame,
    GenerationHealth,
)
from nexus.services.durable_step_journal import (
    AttachReconciledResult,
    Completed,
    ProveNotDispatched,
    ToolExecutionSettlement,
    Uncertain,
    read_step_states,
    stable_generation_id,
)
from nexus.services.llm_execution import ExecutionRuntime
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from nexus.tasks.artifacts import compose_dossier_tool_runtime
from tests.testkit.unreachable_state import (
    make_failed_job_retryable,
    make_pending_job_due,
    remove_dossier_nexus_research_steps,
    replace_dead_dossier_step_tool_execution,
    set_pending_job_max_attempts,
)

_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_WEB_URL = "https://example.com/durable-dossier-evidence"


@dataclass(frozen=True, slots=True)
class _IdeaBuild:
    user_id: UUID
    idea_subject_id: UUID
    artifact_id: UUID
    build_id: UUID
    job_id: UUID


class _CancelledWebSearch:
    """A search adapter whose transport crossing is independent test evidence."""

    def __init__(self, *, cross_transport: bool) -> None:
        self.adapter_calls = 0
        self.transport_dispatches = 0
        self.cross_transport = cross_transport

    async def search(self, request: WebSearchRequest) -> WebSearchResponse:
        self.adapter_calls += 1
        if self.cross_transport:
            self.transport_dispatches += 1
        del request
        raise asyncio.CancelledError


class _SuccessfulWebSearch:
    def __init__(self) -> None:
        self.requests: list[WebSearchRequest] = []

    async def search(self, request: WebSearchRequest) -> WebSearchResponse:
        self.requests.append(request)
        request_id = f"dossier-search-{len(self.requests)}"
        return WebSearchResponse(
            results=(
                WebSearchResultItem(
                    result_ref=f"proof:{request_id}",
                    title="Durable Dossier evidence",
                    url=_WEB_URL,
                    display_url="example.com/durable-dossier-evidence",
                    snippet="A deterministic public result for accepted-source replay.",
                    extra_snippets=(),
                    published_at=None,
                    source_name="Example",
                    rank=1,
                    provider="brave",
                    provider_request_id=request_id,
                ),
            ),
            provider="brave",
            provider_request_id=request_id,
            retrieved_at="2026-08-17T12:00:00Z",
            attempts=1,
        )


class _NeverSearch:
    def __init__(self) -> None:
        self.calls = 0

    async def search(self, request: WebSearchRequest) -> WebSearchResponse:
        self.calls += 1
        raise AssertionError(f"Dossier automatically reissued a durable search: {request!r}")


def _reconciled_web_search_result(*, result_count: int = 1) -> str:
    request_id = "dossier-reconciled-search"
    return canonical_json_bytes(
        {
            "type": "Success",
            "value": {
                "results": [
                    {
                        "result_ref": f"proof:{request_id}-{rank}",
                        "title": f"Reconciled Dossier evidence {rank}",
                        "url": f"{_WEB_URL}?result={rank}",
                        "display_url": f"example.com/durable-dossier-evidence?result={rank}",
                        "snippet": "A recovered normalized result with exact usage.",
                        "extra_snippets": [],
                        "published_at": None,
                        "source_name": "Example",
                        "rank": rank,
                        "provider": "brave",
                        "provider_request_id": request_id,
                    }
                    for rank in range(1, result_count + 1)
                ],
                "provider": "brave",
                "provider_request_id": request_id,
                "observed_at": "2026-08-17T12:00:00Z",
                "evidence": {
                    "type": "web.search",
                    "provider": "brave",
                    "provider_request_id": request_id,
                },
            },
        }
    ).decode("utf-8")


def _create_idea_build(
    db: Session,
    *,
    title: str,
    max_attempts: int = 3,
) -> _IdeaBuild:
    user_id = uuid4()
    ensure_user_and_default_library(
        db,
        user_id,
        f"dossier-tool-replay-{user_id}@example.invalid",
    )
    grant_entitlement_override(
        db,
        user_id=user_id,
        plan_tier="ai_pro",
        transcription_quota_mode="unlimited",
        transcription_minutes_limit_monthly=None,
        expires_at=None,
        reason="Dossier tool replay proof",
        actor_label="nexus-test",
    )
    idea = find_or_create_idea_subject(
        db,
        user_id=user_id,
        idea_key=idea_key_from_selection(title, disambiguator=absent()),
        display_title=title,
    )
    artifact = SynthesisArtifact(
        subject_scheme="idea",
        subject_id=idea.id,
        audience_scheme="user",
        audience_id=str(user_id),
    )
    db.add(artifact)
    db.flush()
    db.commit()
    ticket = regenerate_artifact(
        db,
        artifact_id=artifact.id,
        requester_user_id=user_id,
        idempotency_key=f"dossier-tool-replay-{uuid4()}",
        instruction=None,
    )
    jobs = find_nonterminal_jobs_for_payload(
        db,
        kind="dossier_build",
        expected_payload_match={"build_id": str(ticket.build_id)},
    )
    assert len(jobs) == 1
    job_id = jobs[0].id
    set_pending_job_max_attempts(db, job_id=job_id, max_attempts=max_attempts)
    db.commit()
    return _IdeaBuild(
        user_id=user_id,
        idea_subject_id=idea.id,
        artifact_id=artifact.id,
        build_id=ticket.build_id,
        job_id=job_id,
    )


def _claim_build(
    db: Session,
    *,
    build: _IdeaBuild,
    worker_id: str,
) -> tuple[JobRow, JobExecutionContext]:
    claimed = claim_job(
        db,
        job_id=build.job_id,
        worker_id=worker_id,
        lease_seconds=300,
        heavy_kinds=("dossier_build",),
        allowed_kinds=("dossier_build",),
    )
    assert claimed is not None, f"Dossier job {build.job_id} was not claimable by {worker_id}"
    context = JobExecutionContext(
        job_id=claimed.id,
        worker_id=worker_id,
        attempt_no=claimed.attempts,
        resource_class="Heavy",
    )
    db.commit()
    return claimed, context


def _runtime(
    *,
    build: _IdeaBuild,
    job: JobRow,
    context: JobExecutionContext,
    web_search_provider: WebSearchProvider,
) -> DossierBuildRuntime:
    return DossierBuildRuntime(
        build_id=build.build_id,
        artifact_id=build.artifact_id,
        job=job,
        execution_context=context,
        llm_runtime=_NeverGenerationRuntime(),
        research_tool_operation=compose_dossier_tool_runtime(web_search_provider).operations[
            "idea_dossier_research"
        ],
    )


class _NeverGenerationRuntime(ExecutionRuntime):
    """This research-replay proof must settle before synthesis dispatch."""

    async def health(self) -> GenerationHealth:
        raise AssertionError("Dossier research replay reached generation health")

    async def stream(self, command: GenerationCommand) -> AsyncIterator[GenerationFrame]:
        del command
        raise AssertionError("Dossier research replay dispatched generation")
        if False:
            yield

    async def cancel(self, request_id: UUID) -> None:
        del request_id
        raise AssertionError("Dossier research replay cancelled generation")


def _plan_snapshot(job: JobRow) -> dict[str, object]:
    candidates: list[dict[str, object]] = []
    for state in read_step_states(job).values():
        if state.dispatch_phase is not Completed or not isinstance(state.terminal_result, Present):
            continue
        try:
            decoded = json.loads(state.terminal_result.value)
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(decoded, dict) and decoded.get("type") == "Success":
            decoded = decoded.get("value")
        if isinstance(decoded, dict) and decoded.get("profile_id") == "idea_dossier_research":
            candidates.append(decoded)
    assert len(candidates) == 1, (
        "the existing durable-step journal must contain exactly one complete HostTable plan "
        f"snapshot before Web search; found {len(candidates)}"
    )
    return candidates[0]


def _assert_exact_host_plan(snapshot: dict[str, object]) -> None:
    assert set(snapshot) == {
        "exposure",
        "grants",
        "plan_id",
        "plan_revision",
        "profile_id",
        "profile_revision",
        "run_limits",
    }
    assert snapshot["plan_id"] == "idea_dossier_research"
    assert snapshot["profile_id"] == "idea_dossier_research"
    assert snapshot["exposure"] == {"type": "HostTable"}
    assert snapshot["run_limits"] == {
        "max_calls": 3,
        "max_elapsed_seconds": 60.0,
        "max_external_attempts": 6,
        "max_in_flight": 1,
        "max_input_bytes": 12_288,
        "max_output_bytes": 98_304,
    }
    assert isinstance(snapshot["profile_revision"], str) and _SHA256.fullmatch(
        snapshot["profile_revision"]
    )
    assert isinstance(snapshot["plan_revision"], str) and _SHA256.fullmatch(
        snapshot["plan_revision"]
    )
    grants = snapshot["grants"]
    assert isinstance(grants, list) and len(grants) == 1
    grant = grants[0]
    assert isinstance(grant, dict)
    assert set(grant) == {
        "binding_policy_revision",
        "id",
        "limits",
        "replay_policy",
        "tool_contract_revision",
    }
    assert grant["id"] == "web.search"
    assert grant["limits"] == {
        "deadline_seconds": 15.0,
        "max_attempts": 2,
        "max_input_bytes": 4_096,
        "max_output_bytes": 32_768,
    }
    assert grant["replay_policy"] == "BilledOnce"
    assert isinstance(grant["tool_contract_revision"], str) and _SHA256.fullmatch(
        grant["tool_contract_revision"]
    )
    assert isinstance(grant["binding_policy_revision"], str) and _SHA256.fullmatch(
        grant["binding_policy_revision"]
    )


def _mark_accepted_page_ready(db: Session, *, build: _IdeaBuild) -> UUID:
    attempts = list(
        db.scalars(
            select(MediaSourceAttempt).where(
                MediaSourceAttempt.created_by_user_id == build.user_id,
                MediaSourceAttempt.source_payload["ingest_purpose"].astext == "artifact_research",
            )
        )
    )
    assert len(attempts) == 1, (
        f"accepted-source replay expected one attempt for build {build.build_id}, "
        f"found {len(attempts)}"
    )
    attempt = attempts[0]
    media = db.get(Media, attempt.media_id)
    assert media is not None
    # The ingest worker is outside this proof. Materialize its exact successful
    # dependency state so the Dossier owner can prove readiness/read replay.
    media.title = "Durable Dossier evidence"
    media.processing_status = ProcessingStatus.ready_for_reading
    if not db.scalar(select(Fragment.id).where(Fragment.media_id == media.id)):
        db.add(
            Fragment(
                id=uuid4(),
                media_id=media.id,
                idx=0,
                canonical_text="A durable accepted Web Article used exactly once.",
                html_sanitized="<p>A durable accepted Web Article used exactly once.</p>",
            )
        )
    now = datetime.now(UTC)
    attempt.status = MediaSourceAttemptStatus.succeeded.value
    attempt.run_count = max(1, attempt.run_count)
    attempt.started_at = attempt.started_at or now
    attempt.finished_at = now
    attempt.updated_at = now
    db.commit()
    return attempt.id


def _resolved_idea(db: Session, *, build: _IdeaBuild) -> ResolvedIdeaSubject:
    resolved = visible_persisted_subject(
        db,
        subject_scheme="idea",
        subject_id=build.idea_subject_id,
        audience_scheme="user",
        audience_id=str(build.user_id),
        viewer_id=build.user_id,
    )
    assert isinstance(resolved, ResolvedIdeaSubject)
    return resolved


def test_dossier_freezes_host_plan_and_does_not_automatically_reissue_uncertain_search(
    engine: Engine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Protect paid research, accepted sources, and readiness across worker replay."""

    monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "dossier-tool-replay-test-key")
    clear_settings_cache()
    session_factory = create_session_factory(engine)
    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=session_factory))
    try:
        with Session(engine, expire_on_commit=False) as db:
            crossed = _create_idea_build(db, title="Crossed paid search", max_attempts=2)
            crossed_job, crossed_context = _claim_build(
                db,
                build=crossed,
                worker_id="dossier-crossed-first",
            )
            crossed_provider = _CancelledWebSearch(cross_transport=True)
            with pytest.raises(asyncio.CancelledError):
                asyncio.run(
                    run_build(
                        db,
                        build_id=crossed.build_id,
                        ctx=crossed_context,
                        runtime=_runtime(
                            build=crossed,
                            job=crossed_job,
                            context=crossed_context,
                            web_search_provider=crossed_provider,
                        ),
                    )
                )
            assert (crossed_provider.adapter_calls, crossed_provider.transport_dispatches) == (1, 1)
            crossed_persisted = get_job(db, crossed.job_id)
            assert crossed_persisted is not None
            crossed_states = read_step_states(crossed_persisted)
            assert crossed_states["research/web-search/0"].dispatch_phase is Uncertain
            assert crossed_states["research/web-search/0"].generation_id == stable_generation_id(
                crossed.build_id,
                "research/web-search/0",
            )
            assert (
                fail_job(
                    db,
                    job_id=crossed.job_id,
                    worker_id=crossed_context.worker_id,
                    error_code="E_WORKER_INTERRUPTED",
                    error_message="paid search may have crossed the provider boundary",
                    retry_delays_seconds=(0,),
                )
                == "failed"
            )
            db.commit()
            make_failed_job_retryable(db, job_id=crossed.job_id)
            db.commit()
            crossed_retry_job, crossed_retry_context = _claim_build(
                db,
                build=crossed,
                worker_id="dossier-crossed-second",
            )
            forbidden_retry = _NeverSearch()
            with pytest.raises(RecoveryRequired, match="uncertain outcome"):
                asyncio.run(
                    run_build(
                        db,
                        build_id=crossed.build_id,
                        ctx=crossed_retry_context,
                        runtime=_runtime(
                            build=crossed,
                            job=crossed_retry_job,
                            context=crossed_retry_context,
                            web_search_provider=forbidden_retry,
                        ),
                    )
                )
            assert forbidden_retry.calls == 0
            _assert_exact_host_plan(_plan_snapshot(crossed_retry_job))
            assert (
                fail_job(
                    db,
                    job_id=crossed.job_id,
                    worker_id=crossed_retry_context.worker_id,
                    error_code="E_RECONCILIATION_REQUIRED",
                    error_message="operator evidence is required",
                    retry_delays_seconds=(0,),
                )
                == "dead"
            )
            db.commit()
            crossed_dead = get_job(db, crossed.job_id)
            assert crossed_dead is not None and crossed_dead.status == DEAD
            original_execution = read_step_states(crossed_dead)[
                "research/web-search/0"
            ].tool_execution
            assert isinstance(original_execution, Present)
            wrong_execution = original_execution.value.model_copy(
                update={
                    "identity": original_execution.value.identity.model_copy(
                        update={"policy_revision": "f" * 64}
                    )
                }
            )
            assert (
                replace_dead_dossier_step_tool_execution(
                    db,
                    job_id=crossed.job_id,
                    step_path="research/web-search/0",
                    tool_execution=present(wrong_execution),
                )
                == original_execution
            )
            db.commit()
            with pytest.raises(AssertionError, match="differs from frozen web.search authority"):
                reconcile_uncertain_build(
                    db,
                    build_id=crossed.build_id,
                    resolution=ProveNotDispatched(),
                )
            db.rollback()
            replace_dead_dossier_step_tool_execution(
                db,
                job_id=crossed.job_id,
                step_path="research/web-search/0",
                tool_execution=original_execution,
            )
            db.commit()
            replace_dead_dossier_step_tool_execution(
                db,
                job_id=crossed.job_id,
                step_path="research/web-search/0",
                tool_execution=absent(),
            )
            db.commit()
            with pytest.raises(AssertionError, match="lacks bound tool metadata"):
                reconcile_uncertain_build(
                    db,
                    build_id=crossed.build_id,
                    resolution=ProveNotDispatched(),
                )
            db.rollback()
            replace_dead_dossier_step_tool_execution(
                db,
                job_id=crossed.job_id,
                step_path="research/web-search/0",
                tool_execution=original_execution,
            )
            db.commit()
            overwide_result = _reconciled_web_search_result(result_count=7)
            with pytest.raises(InvalidRequestError, match="result or settlement is invalid"):
                reconcile_uncertain_build(
                    db,
                    build_id=crossed.build_id,
                    resolution=AttachReconciledResult(
                        terminal_result=overwide_result,
                        tool_settlement=present(
                            ToolExecutionSettlement(
                                actual_attempts=1,
                                actual_output_bytes=len(overwide_result.encode("utf-8")),
                            )
                        ),
                    ),
                )
            db.rollback()
            rejected_job = get_job(db, crossed.job_id)
            assert rejected_job is not None and rejected_job.status == DEAD
            assert (
                read_step_states(rejected_job)["research/web-search/0"].dispatch_phase is Uncertain
            )
            reconciled_result = _reconciled_web_search_result()
            reconcile_uncertain_build(
                db,
                build_id=crossed.build_id,
                resolution=AttachReconciledResult(
                    terminal_result=reconciled_result,
                    tool_settlement=present(
                        ToolExecutionSettlement(
                            actual_attempts=1,
                            actual_output_bytes=len(reconciled_result.encode("utf-8")),
                        )
                    ),
                ),
            )
            reconciled_job = get_job(db, crossed.job_id)
            assert reconciled_job is not None and reconciled_job.status == PENDING
            reconciled_state = read_step_states(reconciled_job)["research/web-search/0"]
            assert reconciled_state.dispatch_phase is Completed
            assert reconciled_state.terminal_result == present(reconciled_result)
            assert isinstance(reconciled_state.tool_execution, Present)
            assert reconciled_state.tool_execution.value.settlement == present(
                ToolExecutionSettlement(
                    actual_attempts=1,
                    actual_output_bytes=len(reconciled_result.encode("utf-8")),
                )
            )
            assert not isinstance(
                reconciled_state.tool_execution.value.dispatch_claim,
                Present,
            )
            assert forbidden_retry.calls == 0

            replay = _create_idea_build(db, title="Replayable research plan", max_attempts=1)
            replay_job, replay_context = _claim_build(
                db,
                build=replay,
                worker_id="dossier-pre-boundary-first",
            )
            pre_boundary = _CancelledWebSearch(cross_transport=False)
            with pytest.raises(asyncio.CancelledError):
                asyncio.run(
                    run_build(
                        db,
                        build_id=replay.build_id,
                        ctx=replay_context,
                        runtime=_runtime(
                            build=replay,
                            job=replay_job,
                            context=replay_context,
                            web_search_provider=pre_boundary,
                        ),
                    )
                )
            assert (pre_boundary.adapter_calls, pre_boundary.transport_dispatches) == (1, 0)
            assert (
                fail_job(
                    db,
                    job_id=replay.job_id,
                    worker_id=replay_context.worker_id,
                    error_code="E_WORKER_INTERRUPTED",
                    error_message="search adapter proved zero transport dispatch",
                    retry_delays_seconds=(0,),
                )
                == "dead"
            )
            db.commit()
            reconcile_uncertain_build(
                db,
                build_id=replay.build_id,
                resolution=ProveNotDispatched(),
            )
            repaired_job = get_job(db, replay.job_id)
            assert repaired_job is not None
            assert (
                read_step_states(repaired_job)["research/web-search/0"].dispatch_phase.name
                == "Prepared"
            )
            replay_job, replay_context = _claim_build(
                db,
                build=replay,
                worker_id="dossier-pre-boundary-second",
            )
            successful_provider = _SuccessfulWebSearch()
            pending = asyncio.run(
                run_build(
                    db,
                    build_id=replay.build_id,
                    ctx=replay_context,
                    runtime=_runtime(
                        build=replay,
                        job=replay_job,
                        context=replay_context,
                        web_search_provider=successful_provider,
                    ),
                )
            )
            assert isinstance(pending, RescheduleRequested)
            assert len(successful_provider.requests) == 3
            pending_job = get_job(db, replay.job_id)
            assert pending_job is not None
            pending_states = read_step_states(pending_job)
            for index in range(3):
                path = f"research/web-search/{index}"
                assert pending_states[path].dispatch_phase is Completed
                assert pending_states[path].generation_id == stable_generation_id(
                    replay.build_id,
                    path,
                )
            _assert_exact_host_plan(_plan_snapshot(pending_job))
            search_receipts_before = tuple(
                pending_states[f"research/web-search/{index}"].terminal_result for index in range(3)
            )
            first_search_receipt = search_receipts_before[0]
            assert isinstance(first_search_receipt, Present)
            with pytest.raises(AssertionError, match="not canonical JSON"):
                dossier_web_search_items_from_tool_result(
                    json.dumps(json.loads(first_search_receipt.value), indent=2),
                    build_id=replay.build_id,
                )
            malformed_success = json.loads(first_search_receipt.value)
            malformed_success["value"]["results"][0]["rank"] = "1"
            with pytest.raises(AssertionError, match="Success is malformed"):
                dossier_web_search_items_from_tool_result(
                    json.dumps(malformed_success, sort_keys=True, separators=(",", ":")),
                    build_id=replay.build_id,
                )
            accept_before = pending_states["research/page-accept/0"]
            accepted_attempt_id = _mark_accepted_page_ready(db, build=replay)
            assert reschedule_running_job(
                db,
                job_id=replay.job_id,
                worker_id=replay_context.worker_id,
                attempt_no=replay_context.attempt_no,
                schedule=pending.schedule,
                payload=pending.payload,
            )
            db.commit()
            make_pending_job_due(db, job_id=replay.job_id)
            db.commit()
            ready_job, ready_context = _claim_build(
                db,
                build=replay,
                worker_id="dossier-ready-replay",
            )
            resolved = _resolved_idea(db, build=replay)
            replay_provider = _NeverSearch()
            ready_runtime = _runtime(
                build=replay,
                job=ready_job,
                context=ready_context,
                web_search_provider=replay_provider,
            )
            evidence = asyncio.run(
                collect_idea_evidence(db, resolved=resolved, runtime=ready_runtime)
            )
            assert isinstance(evidence, FrozenIdeaEvidence)
            assert len([source for source in evidence.sources if source.role == "web"]) == 1
            first_replay_states = read_step_states(ready_runtime.job)
            assert (
                tuple(
                    first_replay_states[f"research/web-search/{index}"].terminal_result
                    for index in range(3)
                )
                == search_receipts_before
            )
            assert first_replay_states["research/page-accept/0"] == accept_before
            assert first_replay_states["research/page-ready/0"].dispatch_phase is Completed
            assert first_replay_states["research/page-read/0"].dispatch_phase is Completed
            assert replay_provider.calls == 0

            evidence_replay = asyncio.run(
                collect_idea_evidence(db, resolved=resolved, runtime=ready_runtime)
            )
            assert evidence_replay == evidence
            assert replay_provider.calls == 0
            accepted_ids = tuple(
                db.scalars(
                    select(MediaSourceAttempt.id).where(
                        MediaSourceAttempt.created_by_user_id == replay.user_id,
                        MediaSourceAttempt.source_payload["ingest_purpose"].astext
                        == "artifact_research",
                    )
                )
            )
            assert accepted_ids == (accepted_attempt_id,), (
                "replaying the accepted-source/readiness chain created a second source attempt"
            )

            remove_dossier_nexus_research_steps(db, job_id=replay.job_id)
            db.commit()
            changed_job = get_job(db, replay.job_id)
            assert changed_job is not None
            assert "research/web-search/0" in read_step_states(changed_job)
            idea_row = db.get(ArtifactIdeaSubject, replay.idea_subject_id)
            assert idea_row is not None
            idea_row.display_title = "Changed occupied research invocation"
            db.commit()
            changed_runtime = _runtime(
                build=replay,
                job=changed_job,
                context=ready_context,
                web_search_provider=replay_provider,
            )
            assert (
                asyncio.run(
                    run_build(
                        db,
                        build_id=replay.build_id,
                        ctx=ready_context,
                        runtime=changed_runtime,
                    )
                )
                is None
            )
            failure = db.scalar(
                select(ArtifactBuildFailure).where(ArtifactBuildFailure.build_id == replay.build_id)
            )
            assert failure is not None and failure.failure_code == "InputsChanged"
            assert replay_provider.calls == 0
            assert complete_job(
                db,
                job_id=replay.job_id,
                worker_id=ready_context.worker_id,
                result_payload={"status": "modeled_failure"},
            )
            db.commit()
    finally:
        set_rate_limiter(previous_limiter)
        clear_settings_cache()
