"""The generic Universal Dossier engine (CP2-ENGINE).

One press for every eligible subject: a stable ``artifacts`` head keyed by
``(subject_scheme, subject_id, audience_scheme, audience_id)``, one
``artifact_builds`` attempt per generation, and exactly one terminal child per
build (an immutable ``artifact_revisions`` success, an ``artifact_build_failures``
modeled failure, or an ``artifact_build_cancellations`` cancellation). The head
row is the SOLE db-domain serialization point; the individual ``artifact_build``
is the durable-op conflict/replay identity.

This module contains ZERO subject-scheme branches. Every scheme-specific decision
is delegated to the per-scheme :class:`SubjectPolicy` (identity / authz / audience
/ citation ownership) and :class:`DossierBinding` (collection / reduction /
citation materialization / manifest / freshness). Lifecycle rules 1-10 and the
durable Prepared/Uncertain/Completed coordination are owned here (CONTRACTS A6/A8,
B1a). SOLE creator of heads/builds/terminal children.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import AsyncGenerator, Callable, Sequence
from contextlib import suppress
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from time import monotonic
from typing import Literal, assert_never, cast
from uuid import UUID, uuid4

from provider_runtime import (
    Cancelled,
    CancelSignal,
    ContinuationDelta,
    Incomplete,
    RuntimeStreamEvent,
    StreamStart,
    Succeeded,
    TerminalEvent,
    TextDelta,
    UsageEvent,
)
from pydantic import BaseModel, TypeAdapter
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import is_library_member
from nexus.config import get_settings
from nexus.db.models import ArtifactBuild
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.jobs.queue import (
    JobExecutionContext,
    RescheduleRequested,
    enqueue_unique_job,
    get_job,
    requeue_dead_job,
    revoke_jobs_by_dedupe_keys,
    running_job_claim_is_current,
)
from nexus.logging import get_logger
from nexus.schemas.presence import Present, absent, present
from nexus.services import run_kit
from nexus.services.artifacts import coordination
from nexus.services.artifacts.bindings import BINDINGS, DossierBinding
from nexus.services.artifacts.bindings._shared import AggregateDependenciesPending
from nexus.services.artifacts.bindings.base import DossierInputTooLarge
from nexus.services.artifacts.definition import DOSSIER_DEFINITION
from nexus.services.artifacts.dossier_types import (
    ArtifactBuildEventType,
    AudienceLibrary,
    AudienceScope,
    AudienceUser,
    BuildNotActive,
    BuildTicket,
    CancelledEventPayload,
    ContributorSubjectWire,
    DeltaEventPayload,
    DossierBuildExecutionPhase,
    DossierBuildFailureCode,
    DossierGenerationInProgress,
    DossierSubjectLocator,
    FailedEventPayload,
    InvalidInstruction,
    InvalidSubjectLocator,
    ProgressEventPayload,
    ResourceSubjectWire,
    RevisionNotFound,
    RevisionNotOwnedByHead,
    StartedEventPayload,
    SubjectResource,
    SucceededEventPayload,
)
from nexus.services.artifacts.handles import seal_artifact_build
from nexus.services.artifacts.manifests import InputManifestV1
from nexus.services.artifacts.subject_policy import (
    SUBJECT_POLICIES,
    ResolvedSubject,
    SubjectPolicy,
)
from nexus.services.llm_execution import (
    ExecutionRuntime,
    GenerationRequest,
    execute_generation_stream,
)
from nexus.services.llm_ledger import LlmCallOwner
from nexus.services.llm_profiles import operation_profile
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.resource_graph.citations import (
    rehome_citations_for_output,
    replace_citations_for_output,
    validate_generated_markdown_citations,
)
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.structured_synthesis import (
    StrictJsonStringFieldProjector,
    StructuredSynthesisError,
    build_synthesis_intent,
    decode_structured_synthesis,
    outcome_failure_facts,
)

logger = get_logger(__name__)

# Re-export: CP1 imports ``BuildTicket`` from ``engine`` (it is owned by
# ``dossier_types``). The create outcome value the engine returns.
__all__ = [
    "BuildTicket",
    "DossierHeadView",
    "assert_build_viewer",
    "build_execution_phase",
    "cancel_build",
    "create_build",
    "lock_cleanup_heads_in_order",
    "make_current",
    "on_audience_visibility_changed",
    "on_subject_audience_removed",
    "on_subject_deleted",
    "on_user_deleted",
    "read_head",
    "reconcile_uncertain_build",
    "run_build",
]

_MAX_INSTRUCTION_CHARS = 4000
# The one provider step per build (single synthesis over the reduced inputs, B4).
_STEP_PATH = "synthesis"
_VISIBLE_SYNTHESIS_FIELD = "content_md"
_DELTA_EVENT_MAX_CHARS = 512
_DELTA_EVENT_FLUSH_INTERVAL_SECONDS = 0.2
_CANCEL_POLL_INTERVAL_SECONDS = 0.25
_MANIFEST_ADAPTER: TypeAdapter[InputManifestV1] = TypeAdapter(InputManifestV1)


class _ProviderDefect(Exception):
    """A provider returned a terminal outcome that is not a modeled dossier
    failure (infra/transient exhaustion, plan rejection, unknown failure) — a
    defect, not an ``artifact_build_failures`` row (A7). Surfaces as Suspended."""


class _UncertainReplayDefect(RuntimeError):
    """A billed provider step is ``Uncertain`` on replay and cannot be reconciled
    without a provider idempotency/reconciliation key — never auto-redispatched
    (A8). Defects for the operator; surfaces as Suspended."""


@dataclass(frozen=True, slots=True)
class _TerminalInputRecheck:
    resolved: ResolvedSubject
    audience: AudienceScope
    policy: SubjectPolicy
    binding: DossierBinding
    witness: object
    requester_user_id: UUID


type _StreamStopReason = Literal["inactive", "inputs_changed"]
type _StreamEventWriteResult = Literal["written", "inactive", "inputs_changed"]


@dataclass(slots=True)
class _StreamGuard:
    cancel_signal: asyncio.Event
    stop_reason: _StreamStopReason | None = None


def reconcile_uncertain_build(
    db: Session,
    *,
    build_id: UUID,
    resolution: coordination.UncertainStepResolution,
) -> None:
    """Repair one suspended uncertain provider step, then requeue the same build.

    The operator must either prove that dispatch never occurred or attach the
    provider's recovered normalized result. The latter is validated against the
    subject binding before it is checkpointed. This transition never dispatches.
    """

    def op() -> None:
        head_id = _lock_head_id_for_build(db, build_id)
        if head_id is None or _existing_terminal_child(db, build_id) is not None:
            raise BuildNotActive()
        head = _head_row(db, head_id)
        if head is None:
            raise BuildNotActive()
        binding = BINDINGS.get(head.subject_scheme)
        if binding is None:
            raise AssertionError(f"no binding for subject scheme {head.subject_scheme!r}")
        row = (
            db.execute(
                text(
                    "SELECT id, payload FROM background_jobs "
                    "WHERE kind = :kind AND dedupe_key = :key AND status = 'dead' "
                    "FOR UPDATE"
                ),
                {"kind": DOSSIER_DEFINITION.job_kind, "key": _dispatch_key(build_id)},
            )
            .mappings()
            .one_or_none()
        )
        if row is None:
            raise BuildNotActive()
        payload = dict(row["payload"])
        if str(payload.get("build_id")) != str(build_id):
            raise AssertionError("dead dossier job payload identity changed")
        raw_states = dict(payload.get("coordination") or {})
        raw_state = raw_states.get(_STEP_PATH)
        if raw_state is None:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Build has no uncertain provider step to reconcile",
            )
        state = coordination.StepReplayState.model_validate(raw_state)
        if state.dispatch_phase is not coordination.Uncertain:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Build provider step is not uncertain",
            )
        if state.generation_id != coordination.stable_generation_id(build_id, _STEP_PATH):
            raise AssertionError("dead dossier replay generation identity changed")
        if not isinstance(state.request_fingerprint, Present):
            raise AssertionError("uncertain dossier step has no request fingerprint")
        if isinstance(state.terminal_result, Present):
            raise AssertionError("uncertain dossier step already has a terminal result")
        if isinstance(resolution, coordination.AttachReconciledResult):
            normalized = binding.schema.model_validate_json(resolution.terminal_result)
            next_state = state.model_copy(
                update={
                    "dispatch_phase": coordination.Completed,
                    "terminal_result": present(normalized.model_dump_json()),
                }
            )
        elif isinstance(resolution, coordination.ProveNotDispatched):
            next_state = state.model_copy(
                update={
                    "dispatch_phase": coordination.Prepared,
                    "terminal_result": absent(),
                }
            )
        else:
            assert_never(resolution)
        raw_states[_STEP_PATH] = next_state.model_dump(mode="json")
        payload["coordination"] = raw_states
        db.execute(
            text("UPDATE background_jobs SET payload = CAST(:payload AS jsonb) WHERE id = :job_id"),
            {"payload": json.dumps(payload), "job_id": row["id"]},
        )
        if not requeue_dead_job(db, job_id=UUID(str(row["id"]))):
            raise AssertionError("locked dead dossier job could not be requeued")
        db.commit()

    retry_serializable(db, "reconcile_uncertain_build", op)


# ---------------------------------------------------------------------------
# Head read view (A9 shape). Engine-owned value; the route maps it to the
# ``DossierHeadOut`` wire schema (CP2-API) and derives coverage from the current
# revision's stored manifest.
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class DossierActiveBuildView:
    build_id: UUID
    handle: str
    requester_user_id: UUID | None
    instruction: str | None
    created_at: datetime
    execution: DossierBuildExecutionPhase


@dataclass(frozen=True, slots=True)
class DossierUnsuccessfulBuildView:
    build_id: UUID
    handle: str
    requester_user_id: UUID | None
    instruction: str | None
    created_at: datetime
    outcome: Literal["failed", "cancelled"]
    failure_code: DossierBuildFailureCode | None
    failure_detail: str | None
    failure_support: dict[str, object] | None
    cancellation_actor_user_id: UUID | None
    cancelled_at: datetime | None


@dataclass(frozen=True, slots=True)
class DossierHeadView:
    """The generic head read (A9): current revision + freshness + active build
    execution advisory + latest unsuccessful build + revision count. No historical
    revision body; coverage is derived by the route from the stored manifest."""

    artifact_id: UUID | None
    subject_scheme: str
    subject_id: UUID
    audience_scheme: str
    audience_id: str
    current_revision_id: UUID | None
    freshness: Literal["current", "stale"] | None
    active_build: DossierActiveBuildView | None
    latest_unsuccessful_build: DossierUnsuccessfulBuildView | None
    revision_count: int


# ---------------------------------------------------------------------------
# create_build (RULES 1-2) — the sole head/build minter.
# ---------------------------------------------------------------------------


def create_build(
    db: Session,
    *,
    locator: DossierSubjectLocator,
    requester_user_id: UUID,
    idempotency_key: str,
    instruction: str | None,
) -> BuildTicket:
    """Resolve the subject + derive the audience (server-side, 404-masked), ensure
    the head (SERIALIZABLE insert-on-absence), then either return the existing
    build for a reused idempotency key (rule 1), reject a different key while a
    build is active (rule 2), or insert a new build + enqueue its ``dossier_build``
    job. The durable-op conflict key is the ``build_id`` (never the head key)."""
    policy = _policy_for_locator(locator)
    clean_instruction = _validate_instruction(instruction)

    def op() -> BuildTicket:
        # Resolve/authorize/derive inside the SERIALIZABLE attempt so the subject
        # reads share the head-mutation snapshot (and so no read-tx opens before the
        # retry envelope can set the isolation level).
        resolved = policy.resolve_locator(db, locator, requester_user_id)
        policy.authorize_generate(db, resolved, requester_user_id)
        audience = policy.derive_audience(resolved, requester_user_id)
        head_id = _ensure_head_locked(db, resolved.scheme, resolved.subject_id, audience)
        existing = db.execute(
            text("SELECT id FROM artifact_builds WHERE artifact_id = :h AND idempotency_key = :k"),
            {"h": head_id, "k": idempotency_key},
        ).scalar_one_or_none()
        if existing is not None:  # RULE 1: same key -> the original build
            build_id = UUID(str(existing))
            db.commit()
            return BuildTicket(
                artifact_id=head_id,
                build_id=build_id,
                handle=seal_artifact_build(build_id),
                created=False,
            )
        if _has_active_build(db, head_id):  # RULE 2: different key while active
            db.rollback()
            raise DossierGenerationInProgress()
        build_id = UUID(
            str(
                db.execute(
                    text(
                        "INSERT INTO artifact_builds "
                        "(artifact_id, requester_user_id, instruction, idempotency_key) "
                        "VALUES (:h, :req, :ins, :k) RETURNING id"
                    ),
                    {
                        "h": head_id,
                        "req": requester_user_id,
                        "ins": clean_instruction,
                        "k": idempotency_key,
                    },
                ).scalar_one()
            )
        )
        _append_build_event(
            db,
            build_id=build_id,
            event_type=ArtifactBuildEventType.Started,
            payload=StartedEventPayload(
                build_handle=seal_artifact_build(build_id),
                artifact_ref=ResourceRef(scheme="artifact", id=head_id).uri,
                subject_locator=_locator_wire(locator),
            ).model_dump(mode="json"),
        )
        enqueue_unique_job(
            db,
            kind=DOSSIER_DEFINITION.job_kind,
            dedupe_key=_dispatch_key(build_id),
            payload={"build_id": str(build_id)},
            max_attempts=3,
        )
        db.commit()
        return BuildTicket(
            artifact_id=head_id,
            build_id=build_id,
            handle=seal_artifact_build(build_id),
            created=True,
        )

    return retry_serializable(db, "create_build", op)


# ---------------------------------------------------------------------------
# run_build — the durable job body (collect -> reduce[coordination] -> terminal).
# ---------------------------------------------------------------------------


async def run_build(
    db: Session,
    *,
    build_id: UUID,
    ctx: JobExecutionContext,
    runtime: ExecutionRuntime,
) -> RescheduleRequested | None:
    """Run one build attempt: collect audience-visible inputs, run the single
    coordinated synthesis step (Prepared -> commit Uncertain -> dispatch -> commit
    Completed, never a network call inside a db txn), validate citations, and apply
    the rule-7 success terminal (or a rule-8 modeled failure). Replay-safe: a no-op
    when the build/head is gone (rule 10) or already terminal."""
    build = db.get(ArtifactBuild, build_id)
    if build is None:
        return  # subject deleted / build purged (rule 10)
    if _existing_terminal_child(db, build_id) is not None:
        return  # replay no-op: a terminal child already exists (rules 3-5)
    head = _head_row(db, build.artifact_id)
    if head is None:
        return  # head purged (rule 10)
    job = get_job(db, ctx.job_id)
    if job is None:
        return
    if (
        job.kind != DOSSIER_DEFINITION.job_kind
        or job.dedupe_key != _dispatch_key(build_id)
        or str(job.payload.get("build_id")) != str(build_id)
    ):
        raise AssertionError(f"job {job.id} does not own dossier build {build_id}")
    policy = SUBJECT_POLICIES.get(head.subject_scheme)
    binding = BINDINGS.get(head.subject_scheme)
    if policy is None or binding is None:
        # justify-defect: a persisted build whose subject scheme is not wired to a
        # policy + binding is an integrator misconfiguration, not a runtime state.
        raise AssertionError(f"no policy/binding for subject scheme {head.subject_scheme!r}")
    # Capture plain values before any commit expires the ORM object.
    requester_user_id = build.requester_user_id
    instruction = build.instruction
    if requester_user_id is None:
        return  # requester deleted: no billing identity to run against
    resolved = ResolvedSubject(
        scheme=head.subject_scheme,
        subject_id=head.subject_id,
        ref=ResourceRef(scheme=cast("ResourceScheme", head.subject_scheme), id=head.subject_id),
    )
    audience = _audience_from_head(head)
    requester = policy.requester_billing(resolved, requester_user_id)
    try:
        policy.authorize_generate(db, resolved, requester_user_id)
    except NotFoundError:
        db.commit()
        _terminal_failure(
            db,
            build_id=build_id,
            code=DossierBuildFailureCode.InputsChanged,
            detail="subject or audience is no longer visible",
            support=None,
            ctx=ctx,
        )
        return

    rate_limiter = get_rate_limiter()
    rate_limiter.acquire_inflight_slot(requester)
    try:
        try:
            collected = await binding.collect(db, resolved, audience, runtime)
        except AggregateDependenciesPending:
            db.commit()
            return RescheduleRequested(
                available_at=datetime.now(UTC) + timedelta(seconds=5),
            )
        except DossierInputTooLarge:
            db.commit()
            _terminal_failure(
                db,
                build_id=build_id,
                code=DossierBuildFailureCode.ContextTooLarge,
                detail="subject input exceeds the binding budget",
                support=None,
                ctx=ctx,
            )
            return None
        pre_dispatch = binding.empty_failure(collected)
        if pre_dispatch is not None:  # RULE 8 (pre-dispatch, A7 precedence 1-2)
            db.commit()
            _terminal_failure(
                db,
                build_id=build_id,
                code=pre_dispatch,
                detail=None,
                support=None,
                ctx=ctx,
            )
            return
        witness = binding.validation_witness(db, resolved, audience, collected)
        if not _attempt_can_write(db, build_id=build_id, ctx=ctx):
            db.rollback()
            return
        try:
            policy.authorize_generate(db, resolved, requester_user_id)
            witness_is_current = binding.recheck_witness(db, resolved, audience, witness)
        except NotFoundError:
            witness_is_current = False
        if not witness_is_current:
            db.commit()
            _terminal_failure(
                db,
                build_id=build_id,
                code=DossierBuildFailureCode.InputsChanged,
                detail="inputs changed before provider dispatch",
                support=None,
                ctx=ctx,
            )
            return

        input_recheck = _TerminalInputRecheck(
            resolved=resolved,
            audience=audience,
            policy=policy,
            binding=binding,
            witness=witness,
            requester_user_id=requester_user_id,
        )
        decoded = await _run_synthesis_step(
            db,
            ctx=ctx,
            job=job,
            build_id=build_id,
            instruction=instruction,
            binding=binding,
            collected=collected,
            requester=requester,
            runtime=runtime,
            active=lambda: _attempt_can_write(db, build_id=build_id, ctx=ctx),
            input_recheck=input_recheck,
        )
        if decoded is None:
            return  # the step already terminalized the build (failure) or lost its lease

        content_md, citations = binding.materialize(collected, decoded, witness)
        if len(citations) < DOSSIER_DEFINITION.min_materialized_citations:
            # Inputs offered usable candidates, but the generated result selected
            # none. This is a generated-output contract violation, not the
            # pre-dispatch NoSourceMaterial state.
            db.commit()
            _terminal_failure(
                db,
                build_id=build_id,
                code=DossierBuildFailureCode.CitationValidationFailed,
                detail=None,
                support=None,
                ctx=ctx,
                input_recheck=input_recheck,
            )
            return
        try:
            validate_generated_markdown_citations(content_md, citations)
        except InvalidRequestError as exc:
            db.commit()
            _terminal_failure(
                db,
                build_id=build_id,
                code=DossierBuildFailureCode.CitationValidationFailed,
                detail=exc.message,
                support=None,
                ctx=ctx,
                input_recheck=input_recheck,
            )
            return
        manifest = binding.input_manifest(collected)
        db.commit()
        _success_terminal(
            db,
            build_id=build_id,
            creator_user_id=requester_user_id,
            resolved=resolved,
            audience=audience,
            policy=policy,
            binding=binding,
            content_md=content_md,
            citations=citations,
            manifest=manifest,
            witness=witness,
            ctx=ctx,
        )
    finally:
        rate_limiter.release_inflight_slot(requester)


async def _run_synthesis_step(
    db: Session,
    *,
    ctx: JobExecutionContext,
    job,  # noqa: ANN001 - queue.JobRow (avoid importing the private view name)
    build_id: UUID,
    instruction: str | None,
    binding: DossierBinding,
    collected: object,
    requester: UUID,
    runtime: ExecutionRuntime,
    active: Callable[[], bool],
    input_recheck: _TerminalInputRecheck,
) -> BaseModel | None:
    """Run (or replay) the single coordinated provider step and return the decoded
    output. Returns ``None`` when the step wrote a terminal failure or lost its
    lease (the caller returns). Raises a defect on an uncertain-replay."""
    gen_id = coordination.stable_generation_id(build_id, _STEP_PATH)
    profile = operation_profile(binding.llm_operation)
    user_content = binding.build_user_content(collected, instruction)
    intent = replace(
        build_synthesis_intent(
            profile=profile,
            system_prompt=binding.system_prompt,
            user_content=user_content,
            max_output_tokens=binding.max_output_tokens,
            schema=binding.schema,
        ),
        reasoning=binding.reasoning,
    )
    request_fingerprint = hashlib.sha256(
        json.dumps(
            {
                "operation": str(binding.llm_operation),
                "provider": str(profile.target.provider),
                "model": str(profile.target.model),
                "system_prompt": binding.system_prompt,
                "user_content": user_content,
                "max_output_tokens": binding.max_output_tokens,
                "reasoning": str(binding.reasoning),
                "schema": binding.schema.model_json_schema(),
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    states = coordination.read_step_states(job)
    st = states.get(_STEP_PATH)
    if st is not None:
        if st.generation_id != gen_id:
            raise AssertionError("dossier synthesis replay generation identity changed")
        if not isinstance(st.request_fingerprint, Present):
            raise AssertionError(f"{st.dispatch_phase} synthesis step has no request fingerprint")
        if st.request_fingerprint.value != request_fingerprint:
            _terminal_failure(
                db,
                build_id=build_id,
                code=DossierBuildFailureCode.InputsChanged,
                detail="inputs changed since the provider request was prepared",
                support=None,
                ctx=ctx,
                input_recheck=input_recheck,
            )
            return None
        if st.dispatch_phase in (coordination.Prepared, coordination.Uncertain) and isinstance(
            st.terminal_result, Present
        ):
            raise AssertionError(
                f"{st.dispatch_phase} synthesis step already has a terminal result"
            )
    if st is not None and st.dispatch_phase is coordination.Completed:
        if not isinstance(st.terminal_result, Present):
            # justify-defect: a Completed step must carry its memoized result.
            raise AssertionError("Completed synthesis step has no memoized result")
        return binding.schema.model_validate_json(st.terminal_result.value)
    if st is not None and st.dispatch_phase is coordination.Uncertain:
        raise _UncertainReplayDefect(f"build {build_id} synthesis step is uncertain on replay")

    # Prepared / absent: commit Uncertain immediately before the network dispatch.
    prepared = coordination.StepReplayState(
        generation_id=gen_id,
        dispatch_phase=coordination.Prepared,
        request_fingerprint=present(request_fingerprint),
        terminal_result=absent(),
    )
    if st is None:
        if not active():
            db.rollback()
            return None
        if not coordination.checkpoint_step_state(
            db,
            ctx=ctx,
            job=job,
            step_path=_STEP_PATH,
            state=prepared,
        ):
            db.rollback()
            return None
        db.commit()
        job = get_job(db, ctx.job_id)
        if job is None:
            return None
    elif st.dispatch_phase is coordination.Prepared:
        pass
    else:
        raise AssertionError(f"unknown synthesis dispatch phase {st.dispatch_phase!r}")

    projector = StrictJsonStringFieldProjector(field=_VISIBLE_SYNTHESIS_FIELD)
    pending_delta = ""
    last_delta_flush = monotonic()
    projection_error: StructuredSynthesisError | None = None
    terminal_outcome: object | None = None
    guard = _StreamGuard(cancel_signal=asyncio.Event())
    request = GenerationRequest(
        owner=LlmCallOwner(kind="artifact_build", id=build_id, user_id=requester),
        operation=binding.llm_operation,
        profile=profile,
        reasoning=binding.reasoning,
        intent=intent,
    )
    progress_result = _append_guarded_stream_event(
        db,
        build_id=build_id,
        ctx=ctx,
        input_recheck=input_recheck,
        event_type=ArtifactBuildEventType.Progress,
        payload=ProgressEventPayload(
            phase="synthesis",
            message="Generating dossier",
        ).model_dump(mode="json"),
        idempotent_once=True,
    )
    if progress_result == "inputs_changed":
        _terminal_failure(
            db,
            build_id=build_id,
            code=DossierBuildFailureCode.InputsChanged,
            detail="inputs changed before provider dispatch",
            support=None,
            ctx=ctx,
            input_recheck=input_recheck,
        )
        return None
    if progress_result == "inactive":
        return None

    stream = execute_generation_stream(
        request,
        session_factory=get_session_factory(),
        runtime=runtime,
        settings=get_settings(),
        cancel=cast(CancelSignal, guard.cancel_signal),
    )

    def flush_deltas(*, force: bool) -> _StreamEventWriteResult:
        nonlocal last_delta_flush, pending_delta
        while len(pending_delta) >= _DELTA_EVENT_MAX_CHARS or (force and pending_delta):
            appended_text = pending_delta[:_DELTA_EVENT_MAX_CHARS]
            pending_delta = pending_delta[len(appended_text) :]
            result = _append_guarded_stream_event(
                db,
                build_id=build_id,
                ctx=ctx,
                input_recheck=input_recheck,
                event_type=ArtifactBuildEventType.Delta,
                payload=DeltaEventPayload(appended_text=appended_text).model_dump(mode="json"),
            )
            if result != "written":
                guard.stop_reason = result
                guard.cancel_signal.set()
                return result
            last_delta_flush = monotonic()
        return "written"

    try:
        if not active():
            db.rollback()
            return None
        landed = coordination.checkpoint_step_state(
            db,
            ctx=ctx,
            job=job,
            step_path=_STEP_PATH,
            state=coordination.StepReplayState(
                generation_id=gen_id,
                dispatch_phase=coordination.Uncertain,
                request_fingerprint=present(request_fingerprint),
                terminal_result=absent(),
            ),
        )
        if not landed:
            db.rollback()
            return None  # lease lost mid-checkpoint; a reclaim redoes Prepared
        # A8: this is immediately before the first stream iteration/dispatch.
        # All fallible domain setup and the replay-idempotent Progress append
        # completed while the step was still provably Prepared.
        db.commit()
        cancel_watcher = asyncio.create_task(
            _watch_stream_guard(
                build_id=build_id,
                ctx=ctx,
                input_recheck=input_recheck,
                guard=guard,
            )
        )
        try:
            async for envelope in stream:
                event = envelope.event
                if isinstance(event, StreamStart):
                    continue
                if isinstance(event, TextDelta):
                    if projection_error is None:
                        try:
                            pending_delta += projector.feed(event.text)
                        except StructuredSynthesisError as exc:
                            projection_error = exc
                    if (
                        projection_error is None
                        and guard.stop_reason is None
                        and flush_deltas(
                            force=(
                                monotonic() - last_delta_flush
                                >= _DELTA_EVENT_FLUSH_INTERVAL_SECONDS
                            )
                        )
                        != "written"
                    ):
                        continue
                    continue
                if isinstance(event, (ContinuationDelta, UsageEvent)):
                    continue
                if isinstance(event, TerminalEvent):
                    if terminal_outcome is not None:
                        raise AssertionError("dossier provider stream emitted two terminals")
                    terminal_outcome = event.outcome
                    continue
                # justify-defect: a strict-JSON synthesis has tools=() and
                # tool_choice="none"; any tool event violates the finalized plan.
                raise AssertionError(f"unexpected dossier stream event {type(event).__name__}")
        finally:
            cancel_watcher.cancel()
            try:
                with suppress(asyncio.CancelledError):
                    await cancel_watcher
            finally:
                await cast(AsyncGenerator[RuntimeStreamEvent, None], stream).aclose()
    except ApiError as exc:
        if exc.code == ApiErrorCode.E_BILLING_REQUIRED:
            code = DossierBuildFailureCode.EntitlementDenied
        elif exc.code == ApiErrorCode.E_TOKEN_BUDGET_EXCEEDED:
            code = DossierBuildFailureCode.BudgetExceeded
        else:
            raise
        _terminal_failure(
            db,
            build_id=build_id,
            code=code,
            detail=exc.message,
            support=None,
            ctx=ctx,
            input_recheck=input_recheck,
        )
        return None

    if guard.stop_reason == "inputs_changed":
        _terminal_failure(
            db,
            build_id=build_id,
            code=DossierBuildFailureCode.InputsChanged,
            detail="inputs changed during provider dispatch",
            support=None,
            ctx=ctx,
            input_recheck=input_recheck,
        )
        return None
    if guard.stop_reason == "inactive":
        return None
    if terminal_outcome is None:
        # justify-defect: execute_generation_stream guarantees one terminal event
        # before normal iterator exhaustion.
        raise AssertionError("dossier provider stream ended without a terminal event")
    if isinstance(terminal_outcome, Cancelled):
        return None
    if not isinstance(terminal_outcome, Succeeded):
        if isinstance(terminal_outcome, Incomplete):
            code = (
                DossierBuildFailureCode.ProviderRefused
                if terminal_outcome.status == "refused"
                else DossierBuildFailureCode.ProviderIncomplete
            )
        else:
            failure_code, detail = outcome_failure_facts(terminal_outcome)
            if failure_code == "context_too_large":
                code = DossierBuildFailureCode.ContextTooLarge
            elif failure_code == "invalid_tool_arguments":
                code = DossierBuildFailureCode.SchemaRepairExhausted
            else:
                raise _ProviderDefect(
                    f"non-modeled provider outcome {type(terminal_outcome).__name__}:{failure_code}"
                )
            _terminal_failure(
                db,
                build_id=build_id,
                code=code,
                detail=detail,
                support=None,
                ctx=ctx,
                input_recheck=input_recheck,
            )
            return None
        _, detail = outcome_failure_facts(terminal_outcome)
        logger.warning("dossier.provider_failure", build_id=str(build_id), failure_code=code.value)
        _terminal_failure(
            db,
            build_id=build_id,
            code=code,
            detail=detail,
            support=None,
            ctx=ctx,
            input_recheck=input_recheck,
        )
        return None

    try:
        decoded = decode_structured_synthesis(terminal_outcome, schema=binding.schema)
        expected_visible = getattr(decoded, _VISIBLE_SYNTHESIS_FIELD, None)
        if not isinstance(expected_visible, str):
            raise StructuredSynthesisError(
                f"dossier schema has no string {_VISIBLE_SYNTHESIS_FIELD!r} field"
            )
        if projection_error is not None:
            raise projection_error
        projector.finish(expected=expected_visible)
    except StructuredSynthesisError as exc:
        _terminal_failure(
            db,
            build_id=build_id,
            code=DossierBuildFailureCode.SchemaRepairExhausted,
            detail=str(exc),
            support=None,
            ctx=ctx,
            input_recheck=input_recheck,
        )
        return None
    final_flush = flush_deltas(force=True)
    if final_flush == "inputs_changed":
        _terminal_failure(
            db,
            build_id=build_id,
            code=DossierBuildFailureCode.InputsChanged,
            detail="inputs changed before streamed output completed",
            support=None,
            ctx=ctx,
            input_recheck=input_recheck,
        )
        return None
    if final_flush == "inactive":
        return None

    # Commit Completed with the normalized (decoded) result AFTER a clean decode, so
    # a decode failure fails the build rather than memoizing an unusable outcome.
    fresh_job = get_job(db, ctx.job_id) or job
    landed = coordination.checkpoint_step_state(
        db,
        ctx=ctx,
        job=fresh_job,
        step_path=_STEP_PATH,
        state=coordination.StepReplayState(
            generation_id=gen_id,
            dispatch_phase=coordination.Completed,
            request_fingerprint=present(request_fingerprint),
            terminal_result=present(decoded.model_dump_json()),
        ),
    )
    if not landed:
        db.rollback()
        return None
    db.commit()
    return decoded


# ---------------------------------------------------------------------------
# Terminal mutations (RULES 7-8) — each locks the head, checks child existence.
# ---------------------------------------------------------------------------


def _success_terminal(
    db: Session,
    *,
    build_id: UUID,
    creator_user_id: UUID,
    resolved: ResolvedSubject,
    audience: AudienceScope,
    policy: SubjectPolicy,
    binding: DossierBinding,
    content_md: str,
    citations: list,
    manifest: InputManifestV1,
    witness: object,
    ctx: JobExecutionContext,
) -> None:
    """RULE 7: lock the head, return any existing terminal child, else cheaply
    recheck the witness under the lock (mismatch -> InputsChanged, paid output stays
    in provenance only), then insert the revision + citation edges + Succeeded event
    and repoint the head — atomically."""
    manifest_json = manifest.model_dump(mode="json")

    def op() -> None:
        head_id = _lock_head_id_for_build(db, build_id)
        if head_id is None:
            db.rollback()
            return  # head purged (rule 10)
        if _existing_terminal_child(db, build_id) is not None:
            db.rollback()
            return  # RULES 3-5: first committed terminal wins
        if not _running_claim_is_current(db, ctx):
            db.rollback()
            return
        if not _terminal_inputs_are_current(
            db,
            _TerminalInputRecheck(
                resolved=resolved,
                audience=audience,
                policy=policy,
                binding=binding,
                witness=witness,
                requester_user_id=creator_user_id,
            ),
        ):
            db.execute(
                text(
                    "INSERT INTO artifact_build_failures (build_id, failure_code, detail) "
                    "VALUES (:b, :code, :detail)"
                ),
                {
                    "b": build_id,
                    "code": DossierBuildFailureCode.InputsChanged.value,
                    "detail": "inputs changed between collection and terminal recheck",
                },
            )
            _append_build_event(
                db,
                build_id=build_id,
                event_type=ArtifactBuildEventType.Failed,
                payload=FailedEventPayload(
                    failure_code=DossierBuildFailureCode.InputsChanged,
                    detail=present("inputs changed between collection and terminal recheck"),
                    support=absent(),
                ).model_dump(mode="json"),
            )
            db.commit()
            return
        citation_owner = policy.citation_owner(db, resolved, audience)
        revision_id = uuid4()
        db.execute(
            text(
                "INSERT INTO artifact_revisions "
                "(id, build_id, content_md, input_manifest, citation_owner_user_id, "
                " creator_user_id, promoted_at) "
                "VALUES (:id, :b, :c, CAST(:manifest AS jsonb), :owner, :creator, now())"
            ),
            {
                "id": revision_id,
                "b": build_id,
                "c": content_md,
                "manifest": json.dumps(manifest_json),
                "owner": citation_owner,
                "creator": creator_user_id,
            },
        )
        replace_citations_for_output(
            db,
            viewer_id=citation_owner,
            source=ResourceRef(scheme="artifact_revision", id=revision_id),
            citations=citations,
        )
        _append_build_event(
            db,
            build_id=build_id,
            event_type=ArtifactBuildEventType.Succeeded,
            payload=SucceededEventPayload(
                artifact_revision_ref=ResourceRef(scheme="artifact_revision", id=revision_id).uri
            ).model_dump(mode="json"),
        )
        db.execute(
            text("UPDATE artifacts SET current_revision_id = :r, updated_at = now() WHERE id = :h"),
            {"r": revision_id, "h": head_id},
        )
        db.commit()

    retry_serializable(db, "_success_terminal", op)


def _terminal_failure(
    db: Session,
    *,
    build_id: UUID,
    code: DossierBuildFailureCode,
    detail: str | None,
    support: dict | None,
    ctx: JobExecutionContext | None = None,
    input_recheck: _TerminalInputRecheck | None = None,
) -> None:
    """RULE 8: lock the head, return any existing terminal child, else insert the
    modeled failure child + Failed event under the lock."""

    def op() -> None:
        head_id = _lock_head_id_for_build(db, build_id)
        if head_id is None:
            db.rollback()
            return  # head purged (rule 10)
        if _existing_terminal_child(db, build_id) is not None:
            db.rollback()
            return  # RULES 3-5: first committed terminal wins
        if ctx is not None and not _running_claim_is_current(db, ctx):
            db.rollback()
            return
        effective_code = code
        effective_detail = detail
        effective_support = support
        if input_recheck is not None and not _terminal_inputs_are_current(
            db,
            input_recheck,
        ):
            effective_code = DossierBuildFailureCode.InputsChanged
            effective_detail = "inputs changed between collection and terminal recheck"
            effective_support = None
        db.execute(
            text(
                "INSERT INTO artifact_build_failures (build_id, failure_code, detail, support) "
                "VALUES (:b, :code, :detail, CAST(:support AS jsonb))"
            ),
            {
                "b": build_id,
                "code": effective_code.value,
                "detail": effective_detail,
                "support": (
                    json.dumps(effective_support) if effective_support is not None else None
                ),
            },
        )
        _append_build_event(
            db,
            build_id=build_id,
            event_type=ArtifactBuildEventType.Failed,
            payload=FailedEventPayload(
                failure_code=effective_code,
                detail=(present(effective_detail) if effective_detail is not None else absent()),
                support=(present(effective_support) if effective_support is not None else absent()),
            ).model_dump(mode="json"),
        )
        db.commit()

    retry_serializable(db, "_terminal_failure", op)


def _terminal_inputs_are_current(
    db: Session,
    recheck: _TerminalInputRecheck,
) -> bool:
    try:
        recheck.policy.authorize_generate(
            db,
            recheck.resolved,
            recheck.requester_user_id,
        )
        return recheck.binding.recheck_witness(
            db,
            recheck.resolved,
            recheck.audience,
            recheck.witness,
        )
    except NotFoundError:
        return False


def _append_guarded_stream_event(
    db: Session,
    *,
    build_id: UUID,
    ctx: JobExecutionContext,
    input_recheck: _TerminalInputRecheck,
    event_type: ArtifactBuildEventType,
    payload: dict,
    idempotent_once: bool = False,
) -> _StreamEventWriteResult:
    """Append one live-stream event in its own short fenced transaction."""

    def op() -> _StreamEventWriteResult:
        if _lock_head_id_for_build(db, build_id) is None:
            db.rollback()
            return "inactive"
        if _existing_terminal_child(db, build_id) is not None or not _running_claim_is_current(
            db, ctx
        ):
            db.rollback()
            return "inactive"
        if not _stream_visibility_is_current(db, input_recheck):
            db.rollback()
            return "inputs_changed"
        if (
            idempotent_once
            and db.execute(
                text(
                    "SELECT EXISTS("
                    "SELECT 1 FROM artifact_build_events "
                    "WHERE build_id = :build_id AND event_type = :event_type"
                    ")"
                ),
                {
                    "build_id": build_id,
                    "event_type": event_type.value,
                },
            ).scalar_one()
        ):
            db.commit()
            return "written"
        _append_build_event(
            db,
            build_id=build_id,
            event_type=event_type,
            payload=payload,
        )
        db.commit()
        return "written"

    return retry_serializable(db, "_append_guarded_stream_event", op)


def _stream_guard_status(
    db: Session,
    *,
    build_id: UUID,
    ctx: JobExecutionContext,
    input_recheck: _TerminalInputRecheck,
) -> _StreamStopReason | None:
    """Read the live head/terminal/lease/input fence from a watcher session."""
    build_is_visible = bool(
        db.execute(
            text(
                "SELECT EXISTS("
                "SELECT 1 FROM artifacts a "
                "JOIN artifact_builds b ON b.artifact_id = a.id "
                "WHERE b.id = :build_id"
                ")"
            ),
            {"build_id": build_id},
        ).scalar_one()
    )
    if (
        not build_is_visible
        or _existing_terminal_child(db, build_id) is not None
        or not _running_claim_is_current(db, ctx)
    ):
        return "inactive"
    if not _stream_visibility_is_current(db, input_recheck):
        return "inputs_changed"
    return None


def _stream_visibility_is_current(
    db: Session,
    recheck: _TerminalInputRecheck,
) -> bool:
    """Cheap live-stream fence; full witness hashing is terminal-only."""
    try:
        recheck.policy.authorize_generate(
            db,
            recheck.resolved,
            recheck.requester_user_id,
        )
    except NotFoundError:
        return False
    return True


async def _watch_stream_guard(
    *,
    build_id: UUID,
    ctx: JobExecutionContext,
    input_recheck: _TerminalInputRecheck,
    guard: _StreamGuard,
) -> None:
    """Cancel a provider stream when its build can no longer publish.

    A fresh session is opened for every poll so a long-lived worker transaction
    cannot hide a committed cancellation, subject/audience visibility loss, or
    lease loss. The potentially aggregate binding witness is intentionally
    rechecked only before dispatch and at terminal promotion/failure.
    """
    session_factory = get_session_factory()
    while not guard.cancel_signal.is_set():
        with session_factory() as watch_db:
            reason = _stream_guard_status(
                watch_db,
                build_id=build_id,
                ctx=ctx,
                input_recheck=input_recheck,
            )
            watch_db.rollback()
        if reason is not None:
            guard.stop_reason = reason
            guard.cancel_signal.set()
            return
        try:
            await asyncio.wait_for(
                guard.cancel_signal.wait(),
                timeout=_CANCEL_POLL_INTERVAL_SECONDS,
            )
        except TimeoutError:
            pass


# ---------------------------------------------------------------------------
# cancel_build (RULE 8) / make_current (RULE 9).
# ---------------------------------------------------------------------------


def cancel_build(db: Session, *, build_id: UUID, actor_user_id: UUID) -> None:
    """RULE 8 cancel symmetry: lock the head; a succeeded/failed build raises
    ``BuildNotActive``; an already-cancelled build is an idempotent no-op; else
    insert the cancellation child + Cancelled event. Cancelling A immediately
    permits a new build B (the conflict key is the build, not the head)."""

    def op() -> None:
        head_id = _lock_head_id_for_build(db, build_id)
        if head_id is None:
            db.rollback()
            raise BuildNotActive()
        head = _head_row(db, head_id)
        if head is None or not _authorize_audience(
            db,
            audience_scheme=head.audience_scheme,
            audience_id=head.audience_id,
            viewer_id=actor_user_id,
        ):
            db.rollback()
            raise NotFoundError(ApiErrorCode.E_DOSSIER_NOT_FOUND, "Dossier build not found")
        try:
            _authorize_subject_read(
                db,
                subject_scheme=head.subject_scheme,
                subject_id=head.subject_id,
                viewer_id=actor_user_id,
            )
        except NotFoundError:
            db.rollback()
            raise NotFoundError(
                ApiErrorCode.E_DOSSIER_NOT_FOUND,
                "Dossier build not found",
            ) from None
        existing = _existing_terminal_child(db, build_id)
        if existing in ("revision", "failure"):
            db.rollback()
            raise BuildNotActive()
        if existing == "cancellation":
            db.rollback()
            return  # RULE 4: repeating the winning terminal mutation is a no-op
        db.execute(
            text(
                "INSERT INTO artifact_build_cancellations (build_id, actor_user_id) VALUES (:b, :a)"
            ),
            {"b": build_id, "a": actor_user_id},
        )
        _append_build_event(
            db,
            build_id=build_id,
            event_type=ArtifactBuildEventType.Cancelled,
            payload=CancelledEventPayload(
                actor=present(actor_user_id), at=datetime.now(UTC)
            ).model_dump(mode="json"),
        )
        db.commit()

    retry_serializable(db, "cancel_build", op)


def assert_build_viewer(db: Session, *, build_id: UUID, viewer_id: UUID) -> None:
    """404-masked authorization for build reads, cancellation, and streaming."""
    row = (
        db.execute(
            text(
                "SELECT a.subject_scheme, a.subject_id, "
                "a.audience_scheme, a.audience_id "
                "FROM artifact_builds b "
                "JOIN artifacts a ON a.id = b.artifact_id "
                "WHERE b.id = :build_id"
            ),
            {"build_id": build_id},
        )
        .mappings()
        .first()
    )
    if row is None or not _authorize_audience(
        db,
        audience_scheme=str(row["audience_scheme"]),
        audience_id=str(row["audience_id"]),
        viewer_id=viewer_id,
    ):
        raise NotFoundError(ApiErrorCode.E_DOSSIER_NOT_FOUND, "Dossier build not found")
    try:
        _authorize_subject_read(
            db,
            subject_scheme=str(row["subject_scheme"]),
            subject_id=UUID(str(row["subject_id"])),
            viewer_id=viewer_id,
        )
    except NotFoundError:
        raise NotFoundError(
            ApiErrorCode.E_DOSSIER_NOT_FOUND,
            "Dossier build not found",
        ) from None


def build_execution_phase(
    db: Session, *, build_id: UUID, viewer_id: UUID
) -> DossierBuildExecutionPhase:
    """Return the fresh unsequenced queue/coordination advisory for one build."""
    assert_build_viewer(db, build_id=build_id, viewer_id=viewer_id)
    return _execution_phase(_job_state(db, build_id))


def make_current(db: Session, *, revision_id: UUID, actor_user_id: UUID) -> None:
    """RULE 9: lock the head, authorize the actor against the head's audience, and
    repoint ``current_revision_id`` — never mutating the revision body."""

    def op() -> None:
        row = (
            db.execute(
                text(
                    "SELECT b.artifact_id, a.subject_scheme, a.subject_id, "
                    "a.audience_scheme, a.audience_id "
                    "FROM artifact_revisions r "
                    "JOIN artifact_builds b ON b.id = r.build_id "
                    "JOIN artifacts a ON a.id = b.artifact_id "
                    "WHERE r.id = :rid"
                ),
                {"rid": revision_id},
            )
            .mappings()
            .first()
        )
        if row is None:
            db.rollback()
            raise RevisionNotFound()
        head_id = UUID(str(row["artifact_id"]))
        db.execute(text("SELECT id FROM artifacts WHERE id = :h FOR UPDATE"), {"h": head_id})
        if not _authorize_audience(
            db,
            audience_scheme=str(row["audience_scheme"]),
            audience_id=str(row["audience_id"]),
            viewer_id=actor_user_id,
        ):
            db.rollback()
            raise RevisionNotOwnedByHead()
        try:
            _authorize_subject_read(
                db,
                subject_scheme=str(row["subject_scheme"]),
                subject_id=UUID(str(row["subject_id"])),
                viewer_id=actor_user_id,
            )
        except NotFoundError:
            db.rollback()
            raise RevisionNotOwnedByHead() from None
        db.execute(
            text("UPDATE artifacts SET current_revision_id = :r, updated_at = now() WHERE id = :h"),
            {"r": revision_id, "h": head_id},
        )
        db.commit()

    retry_serializable(db, "make_current", op)


# ---------------------------------------------------------------------------
# read_head (A9) — generic head read + queue/coordination execution advisory.
# ---------------------------------------------------------------------------


def read_head(
    db: Session, *, locator: DossierSubjectLocator, requester_user_id: UUID
) -> DossierHeadView:
    """The generic head read: current revision + freshness + active-build execution
    advisory + latest unsuccessful build + revision count (404-masked). A build with
    more than one terminal child is a defect (rule 6)."""
    policy = _policy_for_locator(locator)
    resolved = policy.resolve_locator(db, locator, requester_user_id)
    policy.authorize_read(db, resolved, requester_user_id)
    audience = policy.derive_audience(resolved, requester_user_id)

    head = (
        db.execute(
            text(
                "SELECT id, current_revision_id FROM artifacts "
                "WHERE subject_scheme = :s AND subject_id = :sid "
                "AND audience_scheme = :asch AND audience_id = :aid"
            ),
            {
                "s": resolved.scheme,
                "sid": resolved.subject_id,
                "asch": audience.scheme,
                "aid": str(audience.audience_id),
            },
        )
        .mappings()
        .first()
    )
    empty = DossierHeadView(
        artifact_id=None,
        subject_scheme=resolved.scheme,
        subject_id=resolved.subject_id,
        audience_scheme=audience.scheme,
        audience_id=str(audience.audience_id),
        current_revision_id=None,
        freshness=None,
        active_build=None,
        latest_unsuccessful_build=None,
        revision_count=0,
    )
    if head is None:
        return empty
    head_id = UUID(str(head["id"]))
    current_revision_id = (
        UUID(str(head["current_revision_id"])) if head["current_revision_id"] is not None else None
    )

    builds = (
        db.execute(
            text(
                "SELECT b.id, b.requester_user_id, b.instruction, b.created_at, "
                "(SELECT count(*) FROM artifact_revisions r WHERE r.build_id = b.id) AS rev, "
                "(SELECT count(*) FROM artifact_build_failures f WHERE f.build_id = b.id) AS fail, "
                "(SELECT count(*) FROM artifact_build_cancellations c WHERE c.build_id = b.id) "
                "  AS canc, "
                "f.failure_code, f.detail AS failure_detail, f.support AS failure_support, "
                "c.actor_user_id AS cancellation_actor_user_id, c.created_at AS cancelled_at "
                "FROM artifact_builds b "
                "LEFT JOIN artifact_build_failures f ON f.build_id = b.id "
                "LEFT JOIN artifact_build_cancellations c ON c.build_id = b.id "
                "WHERE b.artifact_id = :h "
                "ORDER BY b.created_at DESC, b.id DESC"
            ),
            {"h": head_id},
        )
        .mappings()
        .all()
    )
    active: DossierActiveBuildView | None = None
    latest_unsuccessful: DossierUnsuccessfulBuildView | None = None
    revision_count = 0
    newer_success_seen = False
    for b in builds:
        rev, fail, canc = int(b["rev"]), int(b["fail"]), int(b["canc"])
        if rev + fail + canc > 1:
            # justify-defect: RULE 6 — persisted conflicting terminal children.
            raise AssertionError(f"build {b['id']} has conflicting terminal children")
        revision_count += rev
        build_id = UUID(str(b["id"]))
        if rev + fail + canc == 0:
            if active is None:
                active = DossierActiveBuildView(
                    build_id=build_id,
                    handle=seal_artifact_build(build_id),
                    requester_user_id=(
                        UUID(str(b["requester_user_id"]))
                        if b["requester_user_id"] is not None
                        else None
                    ),
                    instruction=(str(b["instruction"]) if b["instruction"] is not None else None),
                    created_at=b["created_at"],
                    execution=_execution_phase(_job_state(db, build_id)),
                )
        elif rev:
            # Builds are newest-first. Once a successful revision is reached,
            # every remaining failure/cancellation is older and therefore not
            # the subject's latest unsuccessful outcome.
            newer_success_seen = True
        elif (fail or canc) and latest_unsuccessful is None and not newer_success_seen:
            latest_unsuccessful = DossierUnsuccessfulBuildView(
                build_id=build_id,
                handle=seal_artifact_build(build_id),
                requester_user_id=(
                    UUID(str(b["requester_user_id"]))
                    if b["requester_user_id"] is not None
                    else None
                ),
                instruction=str(b["instruction"]) if b["instruction"] is not None else None,
                created_at=b["created_at"],
                outcome="failed" if fail else "cancelled",
                failure_code=(DossierBuildFailureCode(str(b["failure_code"])) if fail else None),
                failure_detail=(
                    str(b["failure_detail"]) if b["failure_detail"] is not None else None
                ),
                failure_support=(
                    dict(b["failure_support"]) if isinstance(b["failure_support"], dict) else None
                ),
                cancellation_actor_user_id=(
                    UUID(str(b["cancellation_actor_user_id"]))
                    if b["cancellation_actor_user_id"] is not None
                    else None
                ),
                cancelled_at=b["cancelled_at"],
            )

    freshness = _freshness(
        db,
        binding=BINDINGS.get(resolved.scheme),
        resolved=resolved,
        audience=audience,
        current_revision_id=current_revision_id,
    )
    return DossierHeadView(
        artifact_id=head_id,
        subject_scheme=resolved.scheme,
        subject_id=resolved.subject_id,
        audience_scheme=audience.scheme,
        audience_id=str(audience.audience_id),
        current_revision_id=current_revision_id,
        freshness=freshness,
        active_build=active,
        latest_unsuccessful_build=latest_unsuccessful,
        revision_count=revision_count,
    )


# ---------------------------------------------------------------------------
# on_subject_deleted (RULE 10 / A16) — FK-safe head + build + child cleanup.
# ---------------------------------------------------------------------------


def lock_cleanup_heads_in_order(
    db: Session,
    *,
    subject_refs: Sequence[ResourceRef] = (),
    audiences: Sequence[AudienceScope] = (),
) -> list[UUID]:
    """Prelock one composing cleanup's complete head union in canonical UUID order.

    A teardown that will invoke more than one subject/audience cleanup must call
    this once before invoking any individual cleanup helper. Otherwise two
    transactions can each hold a head from one subset and then deadlock while
    their later audience-wide sweeps acquire the overlapping union in a
    different order.

    The caller owns the transaction and must keep it open through every nested
    Dossier cleanup. Re-locking one of these rows later in the same transaction
    is harmless; acquiring a head outside the declared union is not.
    """
    subject_keys = list(
        {
            (ref.scheme, ref.id): {"scheme": ref.scheme, "id": str(ref.id)} for ref in subject_refs
        }.values()
    )
    audience_keys = list(
        {
            (audience.scheme, str(audience.audience_id)): {
                "scheme": audience.scheme,
                "id": str(audience.audience_id),
            }
            for audience in audiences
        }.values()
    )
    if not subject_keys and not audience_keys:
        return []
    return [
        UUID(str(head_id))
        for head_id in db.execute(
            text(
                """
                WITH subject_keys AS (
                    SELECT key.scheme, key.id
                    FROM jsonb_to_recordset(CAST(:subject_keys AS jsonb))
                        AS key(scheme text, id uuid)
                ),
                audience_keys AS (
                    SELECT key.scheme, key.id
                    FROM jsonb_to_recordset(CAST(:audience_keys AS jsonb))
                        AS key(scheme text, id text)
                )
                SELECT artifact.id
                FROM artifacts artifact
                WHERE EXISTS (
                    SELECT 1
                    FROM subject_keys key
                    WHERE key.scheme = artifact.subject_scheme
                      AND key.id = artifact.subject_id
                )
                   OR EXISTS (
                    SELECT 1
                    FROM audience_keys key
                    WHERE key.scheme = artifact.audience_scheme
                      AND key.id = artifact.audience_id
                )
                ORDER BY artifact.id
                FOR UPDATE OF artifact
                """
            ),
            {
                "subject_keys": json.dumps(subject_keys),
                "audience_keys": json.dumps(audience_keys),
            },
        ).scalars()
    ]


def on_subject_deleted(db: Session, subject_ref: ResourceRef) -> None:
    """Purge every head (all audiences) + its builds + terminal children + events +
    citation edges for a deleted subject, in FK-safe order under the head lock. The
    caller owns the transaction (no commit here). Cleanup wins over a late worker
    promote: the build rows are gone, so ``run_build`` no-ops (rule 10)."""
    head_ids = [
        UUID(str(r[0]))
        for r in db.execute(
            text(
                "SELECT id FROM artifacts "
                "WHERE subject_scheme = :s AND subject_id = :sid "
                "ORDER BY id FOR UPDATE"
            ),
            {"s": subject_ref.scheme, "sid": subject_ref.id},
        )
    ]
    if not head_ids:
        return
    _delete_heads(db, head_ids)


def on_subject_audience_removed(
    db: Session,
    *,
    subject_ref: ResourceRef,
    audience: AudienceScope,
) -> None:
    """Purge one subject/audience head after that audience loses visibility."""
    head_ids = [
        UUID(str(row[0]))
        for row in db.execute(
            text(
                "SELECT id FROM artifacts "
                "WHERE subject_scheme = :subject_scheme AND subject_id = :subject_id "
                "AND audience_scheme = :audience_scheme AND audience_id = :audience_id "
                "FOR UPDATE"
            ),
            {
                "subject_scheme": subject_ref.scheme,
                "subject_id": subject_ref.id,
                "audience_scheme": audience.scheme,
                "audience_id": str(audience.audience_id),
            },
        )
    ]
    if head_ids:
        _delete_heads(db, head_ids)


def on_audience_visibility_changed(db: Session, *, audience: AudienceScope) -> None:
    """Purge User-audience heads whose subjects are no longer visible.

    Visibility-loss owners call this after their authoritative mutation. Shared
    Library heads are unaffected because they are keyed to the Library audience.
    """
    if not isinstance(audience, AudienceUser):
        return
    rows = list(
        db.execute(
            text(
                "SELECT id, subject_scheme, subject_id FROM artifacts "
                "WHERE audience_scheme = 'user' AND audience_id = :audience_id "
                "ORDER BY id FOR UPDATE"
            ),
            {"audience_id": str(audience.user_id)},
        ).mappings()
    )
    lost: list[UUID] = []
    for row in rows:
        scheme = str(row["subject_scheme"])
        policy = SUBJECT_POLICIES.get(scheme)
        if policy is None:
            raise AssertionError(f"no policy for persisted subject scheme {scheme!r}")
        subject_id = UUID(str(row["subject_id"]))
        resolved = ResolvedSubject(
            scheme=scheme,
            subject_id=subject_id,
            ref=ResourceRef(scheme=cast("ResourceScheme", scheme), id=subject_id),
        )
        try:
            policy.authorize_read(db, resolved, audience.user_id)
        except NotFoundError:
            lost.append(UUID(str(row["id"])))
    if lost:
        _delete_heads(db, lost)


def on_user_deleted(db: Session, *, user_id: UUID) -> None:
    """Apply the Dossier-owned part of explicit User teardown.

    User-audience history is purged. Surviving Library-audience history keeps
    its content, rehomes citation graph ownership to the Library's current
    owner, redacts attribution, and cancels active builds requested by the
    departing user. The caller owns the surrounding User-deletion transaction.
    """
    owned_library = db.execute(
        text("SELECT id FROM libraries WHERE owner_user_id = :user_id LIMIT 1"),
        {"user_id": user_id},
    ).scalar_one_or_none()
    if owned_library is not None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Transfer or delete owned libraries before deleting the user",
        )

    # User teardown composes private-head deletion, shared-build cancellation,
    # citation re-homing, and attribution redaction. Lock the complete set of
    # heads those mutations can touch once, before any subset cleanup, using the
    # same global UUID order as every other composing cleanup.
    db.execute(
        text(
            """
            SELECT artifact.id
            FROM artifacts artifact
            WHERE (
                artifact.audience_scheme = 'user'
                AND artifact.audience_id = :user_id_text
            )
               OR EXISTS (
                SELECT 1
                FROM artifact_builds build
                WHERE build.artifact_id = artifact.id
                  AND build.requester_user_id = :user_id
            )
               OR EXISTS (
                SELECT 1
                FROM artifact_builds build
                JOIN artifact_revisions revision ON revision.build_id = build.id
                WHERE build.artifact_id = artifact.id
                  AND (
                    revision.citation_owner_user_id = :user_id
                    OR revision.creator_user_id = :user_id
                  )
            )
               OR EXISTS (
                SELECT 1
                FROM artifact_builds build
                JOIN artifact_build_cancellations cancellation
                  ON cancellation.build_id = build.id
                WHERE build.artifact_id = artifact.id
                  AND cancellation.actor_user_id = :user_id
            )
            ORDER BY artifact.id
            FOR UPDATE OF artifact
            """
        ),
        {"user_id": user_id, "user_id_text": str(user_id)},
    ).all()

    private_head_ids = [
        UUID(str(row[0]))
        for row in db.execute(
            text(
                "SELECT id FROM artifacts "
                "WHERE audience_scheme = 'user' AND audience_id = :user_id "
                "ORDER BY id"
            ),
            {"user_id": str(user_id)},
        )
    ]
    if private_head_ids:
        _delete_heads(db, private_head_ids)

    shared_heads = list(
        db.execute(
            text(
                "SELECT a.id "
                "FROM artifacts a "
                "WHERE a.audience_scheme = 'library' "
                "AND EXISTS ("
                "  SELECT 1 FROM artifact_builds b "
                "  WHERE b.artifact_id = a.id AND b.requester_user_id = :user_id"
                ") ORDER BY a.id"
            ),
            {"user_id": user_id},
        ).scalars()
    )
    for head_id in shared_heads:
        active_build_ids = [
            UUID(str(row[0]))
            for row in db.execute(
                text(
                    "SELECT b.id FROM artifact_builds b "
                    "WHERE b.artifact_id = :head_id AND b.requester_user_id = :user_id "
                    "AND NOT EXISTS (SELECT 1 FROM artifact_revisions r WHERE r.build_id = b.id) "
                    "AND NOT EXISTS ("
                    "  SELECT 1 FROM artifact_build_failures f WHERE f.build_id = b.id"
                    ") AND NOT EXISTS ("
                    "  SELECT 1 FROM artifact_build_cancellations c WHERE c.build_id = b.id"
                    ") ORDER BY b.created_at, b.id"
                ),
                {"head_id": head_id, "user_id": user_id},
            )
        ]
        for build_id in active_build_ids:
            db.execute(
                text(
                    "INSERT INTO artifact_build_cancellations (build_id, actor_user_id) "
                    "VALUES (:build_id, NULL)"
                ),
                {"build_id": build_id},
            )
            _append_build_event(
                db,
                build_id=build_id,
                event_type=ArtifactBuildEventType.Cancelled,
                payload=CancelledEventPayload(
                    actor=absent(),
                    at=datetime.now(UTC),
                ).model_dump(mode="json"),
            )
            revoke_jobs_by_dedupe_keys(
                db,
                kind=DOSSIER_DEFINITION.job_kind,
                dedupe_keys=[_dispatch_key(build_id)],
            )

    revision_owners = list(
        db.execute(
            text(
                "SELECT r.id AS revision_id, l.owner_user_id AS new_owner_id "
                "FROM artifact_revisions r "
                "JOIN artifact_builds b ON b.id = r.build_id "
                "JOIN artifacts a ON a.id = b.artifact_id "
                "JOIN libraries l ON l.id = a.audience_id::uuid "
                "WHERE a.audience_scheme = 'library' "
                "AND r.citation_owner_user_id = :user_id "
                "ORDER BY r.id"
            ),
            {"user_id": user_id},
        ).mappings()
    )
    for row in revision_owners:
        revision_id = UUID(str(row["revision_id"]))
        new_owner_id = UUID(str(row["new_owner_id"]))
        rehome_citations_for_output(
            db,
            source=ResourceRef(scheme="artifact_revision", id=revision_id),
            new_owner_user_id=new_owner_id,
        )
        db.execute(
            text(
                "UPDATE artifact_revisions SET citation_owner_user_id = :new_owner_id "
                "WHERE id = :revision_id"
            ),
            {"new_owner_id": new_owner_id, "revision_id": revision_id},
        )

    cancelled_build_ids = [
        UUID(str(row[0]))
        for row in db.execute(
            text(
                "SELECT build_id FROM artifact_build_cancellations WHERE actor_user_id = :user_id"
            ),
            {"user_id": user_id},
        )
    ]
    if cancelled_build_ids:
        db.execute(
            text(
                "UPDATE artifact_build_events "
                "SET payload = jsonb_set(payload, '{actor}', '{\"kind\":\"Absent\"}'::jsonb) "
                "WHERE build_id = ANY(:build_ids) AND event_type = 'Cancelled'"
            ),
            {"build_ids": cancelled_build_ids},
        )
    db.execute(
        text("UPDATE artifact_builds SET requester_user_id = NULL WHERE requester_user_id = :u"),
        {"u": user_id},
    )
    db.execute(
        text("UPDATE artifact_revisions SET creator_user_id = NULL WHERE creator_user_id = :u"),
        {"u": user_id},
    )
    db.execute(
        text(
            "UPDATE artifact_build_cancellations SET actor_user_id = NULL WHERE actor_user_id = :u"
        ),
        {"u": user_id},
    )


def _delete_heads(db: Session, head_ids: list[UUID]) -> None:
    from nexus.services.resource_graph.cleanup import delete_edges_for_deleted_resource

    build_ids = [
        UUID(str(r[0]))
        for r in db.execute(
            text("SELECT id FROM artifact_builds WHERE artifact_id = ANY(:ids)"),
            {"ids": head_ids},
        )
    ]
    revision_ids = (
        [
            UUID(str(r[0]))
            for r in db.execute(
                text("SELECT id FROM artifact_revisions WHERE build_id = ANY(:ids)"),
                {"ids": build_ids},
            )
        ]
        if build_ids
        else []
    )
    if build_ids:
        revoke_jobs_by_dedupe_keys(
            db,
            kind=DOSSIER_DEFINITION.job_kind,
            dedupe_keys=[_dispatch_key(build_id) for build_id in build_ids],
        )
    # Clear the circular head pointer before deleting revisions.
    db.execute(
        text("UPDATE artifacts SET current_revision_id = NULL WHERE id = ANY(:ids)"),
        {"ids": head_ids},
    )
    # Resource-graph cleanup for each head + revision ref.
    for head_id in head_ids:
        delete_edges_for_deleted_resource(db, ref=ResourceRef(scheme="artifact", id=head_id))
    for revision_id in revision_ids:
        delete_edges_for_deleted_resource(
            db, ref=ResourceRef(scheme="artifact_revision", id=revision_id)
        )
    if build_ids:
        db.execute(
            text("DELETE FROM artifact_build_events WHERE build_id = ANY(:ids)"),
            {"ids": build_ids},
        )
        db.execute(
            text("DELETE FROM artifact_revisions WHERE build_id = ANY(:ids)"),
            {"ids": build_ids},
        )
        db.execute(
            text("DELETE FROM artifact_build_failures WHERE build_id = ANY(:ids)"),
            {"ids": build_ids},
        )
        db.execute(
            text("DELETE FROM artifact_build_cancellations WHERE build_id = ANY(:ids)"),
            {"ids": build_ids},
        )
        db.execute(text("DELETE FROM artifact_builds WHERE id = ANY(:ids)"), {"ids": build_ids})
    db.execute(text("DELETE FROM artifacts WHERE id = ANY(:ids)"), {"ids": head_ids})


# ---------------------------------------------------------------------------
# Internal helpers.
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _HeadRow:
    id: UUID
    subject_scheme: str
    subject_id: UUID
    audience_scheme: str
    audience_id: str
    current_revision_id: UUID | None


@dataclass(frozen=True, slots=True)
class _JobState:
    status: str
    attempts: int


def _policy_for_locator(locator: DossierSubjectLocator) -> SubjectPolicy:
    scheme = _subject_scheme(locator)
    policy = SUBJECT_POLICIES.get(scheme)
    if policy is None:
        raise InvalidSubjectLocator(f"{scheme!r} is not an eligible dossier subject")
    return policy


def _subject_scheme(locator: DossierSubjectLocator) -> str:
    if isinstance(locator, SubjectResource):
        return locator.ref.scheme
    return "contributor"


def _locator_wire(locator: DossierSubjectLocator) -> ResourceSubjectWire | ContributorSubjectWire:
    if isinstance(locator, SubjectResource):
        return ResourceSubjectWire(ref=locator.ref.uri)
    return ContributorSubjectWire(handle=str(locator.handle))


def _validate_instruction(instruction: str | None) -> str | None:
    if instruction is None:
        return None
    stripped = instruction.strip()
    if not stripped:
        return None
    if len(stripped) > _MAX_INSTRUCTION_CHARS:
        raise InvalidInstruction("Instruction is too long")
    return stripped


def _dispatch_key(build_id: UUID) -> str:
    return f"{DOSSIER_DEFINITION.dispatch_dedupe_prefix}:{build_id}"


def _running_claim_is_current(db: Session, ctx: JobExecutionContext) -> bool:
    return running_job_claim_is_current(
        db,
        job_id=ctx.job_id,
        worker_id=ctx.worker_id,
        attempt_no=ctx.attempt_no,
    )


def _attempt_can_write(db: Session, *, build_id: UUID, ctx: JobExecutionContext) -> bool:
    return _running_claim_is_current(db, ctx) and _existing_terminal_child(db, build_id) is None


def _ensure_head_locked(
    db: Session, subject_scheme: str, subject_id: UUID, audience: AudienceScope
) -> UUID:
    """Return the locked head id for the 4-column key, inserting it on absence.

    The head row is the sole db-domain serialization point (A6). The row is held
    ``FOR UPDATE`` on return via either the select or its own insert."""
    key = {
        "s": subject_scheme,
        "sid": subject_id,
        "asch": audience.scheme,
        "aid": str(audience.audience_id),
    }
    existing = db.execute(
        text(
            "SELECT id FROM artifacts "
            "WHERE subject_scheme = :s AND subject_id = :sid "
            "AND audience_scheme = :asch AND audience_id = :aid FOR UPDATE"
        ),
        key,
    ).scalar_one_or_none()
    if existing is not None:
        head_id = UUID(str(existing))
        db.execute(text("UPDATE artifacts SET updated_at = now() WHERE id = :id"), {"id": head_id})
        return head_id
    return UUID(
        str(
            db.execute(
                text(
                    "INSERT INTO artifacts "
                    "(subject_scheme, subject_id, audience_scheme, audience_id) "
                    "VALUES (:s, :sid, :asch, :aid) RETURNING id"
                ),
                key,
            ).scalar_one()
        )
    )


def _has_active_build(db: Session, head_id: UUID) -> bool:
    return bool(
        db.execute(
            text(
                "SELECT EXISTS(SELECT 1 FROM artifact_builds b WHERE b.artifact_id = :h "
                "AND NOT EXISTS(SELECT 1 FROM artifact_revisions r WHERE r.build_id = b.id) "
                "AND NOT EXISTS(SELECT 1 FROM artifact_build_failures f WHERE f.build_id = b.id) "
                "AND NOT EXISTS(SELECT 1 FROM artifact_build_cancellations c WHERE c.build_id = b.id)"
                ")"
            ),
            {"h": head_id},
        ).scalar_one()
    )


def _existing_terminal_child(
    db: Session, build_id: UUID
) -> Literal["revision", "failure", "cancellation"] | None:
    """The build's single terminal child kind, or ``None`` when still active.

    More than one terminal child is a persisted defect (RULE 6)."""
    counts = (
        db.execute(
            text(
                "SELECT "
                "(SELECT count(*) FROM artifact_revisions WHERE build_id = :b) AS rev, "
                "(SELECT count(*) FROM artifact_build_failures WHERE build_id = :b) AS fail, "
                "(SELECT count(*) FROM artifact_build_cancellations WHERE build_id = :b) AS canc"
            ),
            {"b": build_id},
        )
        .mappings()
        .one()
    )
    rev, fail, canc = int(counts["rev"]), int(counts["fail"]), int(counts["canc"])
    if rev + fail + canc > 1:
        # justify-defect: RULE 6 — persisted conflicting terminal children.
        raise AssertionError(f"build {build_id} has conflicting terminal children")
    if rev:
        return "revision"
    if fail:
        return "failure"
    if canc:
        return "cancellation"
    return None


def _lock_head_id_for_build(db: Session, build_id: UUID) -> UUID | None:
    """Lock and return the head id owning ``build_id`` (``None`` when purged)."""
    row = db.execute(
        text(
            "SELECT a.id FROM artifacts a "
            "JOIN artifact_builds b ON b.artifact_id = a.id "
            "WHERE b.id = :b FOR UPDATE OF a"
        ),
        {"b": build_id},
    ).scalar_one_or_none()
    return UUID(str(row)) if row is not None else None


def _head_row(db: Session, artifact_id: UUID) -> _HeadRow | None:
    row = (
        db.execute(
            text(
                "SELECT id, subject_scheme, subject_id, audience_scheme, audience_id, "
                "current_revision_id FROM artifacts WHERE id = :id"
            ),
            {"id": artifact_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        return None
    return _HeadRow(
        id=UUID(str(row["id"])),
        subject_scheme=str(row["subject_scheme"]),
        subject_id=UUID(str(row["subject_id"])),
        audience_scheme=str(row["audience_scheme"]),
        audience_id=str(row["audience_id"]),
        current_revision_id=(
            UUID(str(row["current_revision_id"]))
            if row["current_revision_id"] is not None
            else None
        ),
    )


def _audience_from_head(head: _HeadRow) -> AudienceScope:
    if head.audience_scheme == "user":
        return AudienceUser(user_id=UUID(head.audience_id))
    if head.audience_scheme == "library":
        return AudienceLibrary(library_id=UUID(head.audience_id))
    # justify-defect: the head audience_scheme is a closed two-value column.
    raise AssertionError(f"unknown audience scheme {head.audience_scheme!r}")


def _authorize_audience(
    db: Session, *, audience_scheme: str, audience_id: str, viewer_id: UUID
) -> bool:
    if audience_scheme == "user":
        return UUID(audience_id) == viewer_id
    if audience_scheme == "library":
        return is_library_member(db, viewer_id, UUID(audience_id))
    return False


def _authorize_subject_read(
    db: Session,
    *,
    subject_scheme: str,
    subject_id: UUID,
    viewer_id: UUID,
) -> None:
    policy = SUBJECT_POLICIES.get(subject_scheme)
    if policy is None:
        raise AssertionError(f"no policy for persisted subject scheme {subject_scheme!r}")
    policy.authorize_read(
        db,
        ResolvedSubject(
            scheme=subject_scheme,
            subject_id=subject_id,
            ref=ResourceRef(
                scheme=cast("ResourceScheme", subject_scheme),
                id=subject_id,
            ),
        ),
        viewer_id,
    )


def _job_state(db: Session, build_id: UUID) -> _JobState | None:
    row = (
        db.execute(
            text("SELECT status, attempts FROM background_jobs WHERE dedupe_key = :k"),
            {"k": _dispatch_key(build_id)},
        )
        .mappings()
        .first()
    )
    return _JobState(status=str(row["status"]), attempts=int(row["attempts"])) if row else None


def _execution_phase(job: _JobState | None) -> DossierBuildExecutionPhase:
    """Derive the unsequenced execution advisory from queue/coordination state (A8).

    Not persisted; never advances the cursor; cannot legalize a second Generate."""
    if job is None:
        return DossierBuildExecutionPhase.Queued
    if job.status == "dead":
        return DossierBuildExecutionPhase.Suspended
    if job.status == "running":
        # A reclaimed attempt (attempts incremented past the first) is Recovering.
        return (
            DossierBuildExecutionPhase.Recovering
            if job.attempts >= 2
            else DossierBuildExecutionPhase.Running
        )
    if job.status == "failed":
        return DossierBuildExecutionPhase.Recovering  # errored, a retry is pending
    return DossierBuildExecutionPhase.Queued  # pending / succeeded / unknown


def _freshness(
    db: Session,
    *,
    binding: DossierBinding | None,
    resolved: ResolvedSubject,
    audience: AudienceScope,
    current_revision_id: UUID | None,
) -> Literal["current", "stale"] | None:
    """Compare the current revision's stored manifest to the live inputs (no LLM)."""
    if current_revision_id is None or binding is None:
        return None
    stored_raw = db.execute(
        text("SELECT input_manifest FROM artifact_revisions WHERE id = :r"),
        {"r": current_revision_id},
    ).scalar_one_or_none()
    if stored_raw is None:
        return None
    stored = _MANIFEST_ADAPTER.validate_python(stored_raw)
    try:
        live = binding.live_manifest(db, resolved, audience)
    except DossierInputTooLarge:
        return "stale"
    return "current" if binding.manifests_equal(stored, live) else "stale"


def _append_build_event(
    db: Session,
    *,
    build_id: UUID,
    event_type: ArtifactBuildEventType,
    payload: dict,
) -> None:
    """Append one strict build event under the caller-held head lock (the seq is
    allocated + inserted together, so no writer collides — A5 §673)."""
    build_orm = db.get(ArtifactBuild, build_id)
    if build_orm is None:
        # justify-defect: an event append targets a build the caller just locked.
        raise AssertionError(f"cannot append event for missing build {build_id}")
    run_kit.append_event(
        db,
        stream=run_kit.artifact_build_stream(build_orm),
        event_type=event_type.value,
        payload=payload,
    )
