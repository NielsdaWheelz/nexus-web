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

import json
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Literal, cast
from uuid import UUID, uuid4

from provider_runtime import Incomplete, Refused, Succeeded
from pydantic import BaseModel, TypeAdapter
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import is_library_member
from nexus.config import get_settings
from nexus.db.models import ArtifactBuild
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import InvalidRequestError
from nexus.jobs.queue import JobExecutionContext, enqueue_unique_job, get_job
from nexus.logging import get_logger
from nexus.schemas.presence import Present, absent, present
from nexus.services import run_kit
from nexus.services.artifacts import coordination
from nexus.services.artifacts.bindings import BINDINGS, DossierBinding
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
    DossierBuildExecutionPhase,
    DossierBuildFailureCode,
    DossierGenerationInProgress,
    DossierSubjectLocator,
    FailedEventPayload,
    InvalidInstruction,
    InvalidSubjectLocator,
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
from nexus.services.llm_execution import ExecutionRuntime, GenerationRequest, execute_generation
from nexus.services.llm_ledger import LlmCallOwner
from nexus.services.llm_profiles import operation_profile
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.resource_graph.citations import (
    replace_citations_for_output,
    validate_generated_markdown_citations,
)
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.structured_synthesis import (
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
    "cancel_build",
    "create_build",
    "make_current",
    "on_subject_deleted",
    "read_head",
    "run_build",
]

_MAX_INSTRUCTION_CHARS = 4000
# The one provider step per build (single synthesis over the reduced inputs, B4).
_STEP_PATH = "synthesis"
_MANIFEST_ADAPTER: TypeAdapter[InputManifestV1] = TypeAdapter(InputManifestV1)


class _ProviderDefect(Exception):
    """A provider returned a terminal outcome that is not a modeled dossier
    failure (infra/transient exhaustion, plan rejection, unknown failure) — a
    defect, not an ``artifact_build_failures`` row (A7). Surfaces as Suspended."""


class _UncertainReplayDefect(Exception):
    """A billed provider step is ``Uncertain`` on replay and cannot be reconciled
    without a provider idempotency/reconciliation key — never auto-redispatched
    (A8). Defects for the operator; surfaces as Suspended."""


# ---------------------------------------------------------------------------
# Head read view (A9 shape). Engine-owned value; the route maps it to the
# ``DossierHeadOut`` wire schema (CP2-API) and derives coverage from the current
# revision's stored manifest.
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class DossierActiveBuildView:
    build_id: UUID
    handle: str
    execution: DossierBuildExecutionPhase


@dataclass(frozen=True, slots=True)
class DossierUnsuccessfulBuildView:
    build_id: UUID
    handle: str
    outcome: Literal["failed", "cancelled"]
    failure_code: DossierBuildFailureCode | None


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
) -> None:
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

    rate_limiter = get_rate_limiter()
    rate_limiter.acquire_inflight_slot(requester)
    try:
        collected = await binding.collect(db, resolved, audience, runtime)
        pre_dispatch = binding.empty_failure(collected)
        if pre_dispatch is not None:  # RULE 8 (pre-dispatch, A7 precedence 1-2)
            db.commit()
            _terminal_failure(db, build_id=build_id, code=pre_dispatch, detail=None, support=None)
            return
        witness = binding.validation_witness(db, resolved, audience, collected)

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
        )
        if decoded is None:
            return  # the step already terminalized the build (failure) or lost its lease

        content_md, citations = binding.materialize(collected, decoded, witness)
        if len(citations) < DOSSIER_DEFINITION.min_materialized_citations:
            # Zero materialized citations fail the build (A10) — a separate count
            # guard; the parity validator below is unchanged.
            db.commit()
            _terminal_failure(
                db,
                build_id=build_id,
                code=DossierBuildFailureCode.NoSourceMaterial,
                detail=None,
                support=None,
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
) -> BaseModel | None:
    """Run (or replay) the single coordinated provider step and return the decoded
    output. Returns ``None`` when the step wrote a terminal failure or lost its
    lease (the caller returns). Raises a defect on an uncertain-replay."""
    states = coordination.read_step_states(job)
    st = states.get(_STEP_PATH)
    if st is not None and st.dispatch_phase is coordination.Completed:
        if not isinstance(st.terminal_result, Present):
            # justify-defect: a Completed step must carry its memoized result.
            raise AssertionError("Completed synthesis step has no memoized result")
        return binding.schema.model_validate_json(st.terminal_result.value)
    if st is not None and st.dispatch_phase is coordination.Uncertain:
        raise _UncertainReplayDefect(f"build {build_id} synthesis step is uncertain on replay")

    # Prepared / absent: commit Uncertain immediately before the network dispatch.
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
    landed = coordination.checkpoint_step_state(
        db,
        ctx=ctx,
        job=job,
        step_path=_STEP_PATH,
        state=coordination.StepReplayState(
            generation_id=gen_id,
            dispatch_phase=coordination.Uncertain,
            request_fingerprint=absent(),
            terminal_result=absent(),
        ),
    )
    if not landed:
        return None  # lease lost mid-checkpoint; a reclaim (Recovering) redoes it
    db.commit()  # persist Uncertain BEFORE dispatch (A8: never redispatch after a crash)

    call = await execute_generation(
        GenerationRequest(
            owner=LlmCallOwner(kind="artifact_build", id=build_id, user_id=requester),
            operation=binding.llm_operation,
            profile=profile,
            reasoning=binding.reasoning,
            intent=intent,
        ),
        session_factory=get_session_factory(),
        runtime=runtime,
        settings=get_settings(),
    )
    outcome = call.outcome
    if not isinstance(outcome, Succeeded):
        if isinstance(outcome, Refused):
            code = DossierBuildFailureCode.ProviderRefused
        elif isinstance(outcome, Incomplete):
            code = DossierBuildFailureCode.ProviderIncomplete
        else:
            # Cancelled / Failed (infra/transient exhaustion, plan rejection,
            # unknown provider failure) are defects, not modeled failures (A7).
            # SEAM: CP3 refines plan-rejection Failed into BudgetExceeded /
            # ContextTooLarge / EntitlementDenied by inspecting outcome.failure.
            raise _ProviderDefect(f"non-modeled provider outcome {type(outcome).__name__}")
        _, detail = outcome_failure_facts(outcome)
        logger.warning("dossier.provider_failure", build_id=str(build_id), failure_code=code.value)
        _terminal_failure(db, build_id=build_id, code=code, detail=detail, support=None)
        return None

    try:
        decoded = decode_structured_synthesis(outcome, schema=binding.schema)
    except StructuredSynthesisError as exc:
        _terminal_failure(
            db,
            build_id=build_id,
            code=DossierBuildFailureCode.SchemaRepairExhausted,
            detail=str(exc),
            support=None,
        )
        return None

    # Commit Completed with the normalized (decoded) result AFTER a clean decode, so
    # a decode failure fails the build rather than memoizing an unusable outcome.
    fresh_job = get_job(db, ctx.job_id) or job
    coordination.checkpoint_step_state(
        db,
        ctx=ctx,
        job=fresh_job,
        step_path=_STEP_PATH,
        state=coordination.StepReplayState(
            generation_id=gen_id,
            dispatch_phase=coordination.Completed,
            request_fingerprint=absent(),
            terminal_result=present(decoded.model_dump_json()),
        ),
    )
    db.commit()
    return decoded


# ---------------------------------------------------------------------------
# Terminal mutations (RULES 7-8) — each locks the head, checks child existence.
# ---------------------------------------------------------------------------


def _success_terminal(
    db: Session,
    *,
    build_id: UUID,
    creator_user_id: UUID | None,
    resolved: ResolvedSubject,
    audience: AudienceScope,
    policy: SubjectPolicy,
    binding: DossierBinding,
    content_md: str,
    citations: list,
    manifest: InputManifestV1,
    witness: object,
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
        if not binding.recheck_witness(db, resolved, audience, witness):
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
        citation_owner = policy.citation_owner(resolved, audience)
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
        db.execute(
            text(
                "INSERT INTO artifact_build_failures (build_id, failure_code, detail, support) "
                "VALUES (:b, :code, :detail, CAST(:support AS jsonb))"
            ),
            {
                "b": build_id,
                "code": code.value,
                "detail": detail,
                "support": json.dumps(support) if support is not None else None,
            },
        )
        _append_build_event(
            db,
            build_id=build_id,
            event_type=ArtifactBuildEventType.Failed,
            payload=FailedEventPayload(
                failure_code=code,
                detail=present(detail) if detail is not None else absent(),
                support=present(support) if support is not None else absent(),
            ).model_dump(mode="json"),
        )
        db.commit()

    retry_serializable(db, "_terminal_failure", op)


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


def make_current(db: Session, *, revision_id: UUID, actor_user_id: UUID) -> None:
    """RULE 9: lock the head, authorize the actor against the head's audience, and
    repoint ``current_revision_id`` — never mutating the revision body."""

    def op() -> None:
        row = (
            db.execute(
                text(
                    "SELECT b.artifact_id, a.audience_scheme, a.audience_id "
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
                "SELECT b.id, "
                "(SELECT count(*) FROM artifact_revisions r WHERE r.build_id = b.id) AS rev, "
                "(SELECT count(*) FROM artifact_build_failures f WHERE f.build_id = b.id) AS fail, "
                "(SELECT count(*) FROM artifact_build_cancellations c WHERE c.build_id = b.id) "
                "  AS canc "
                "FROM artifact_builds b WHERE b.artifact_id = :h "
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
                    execution=_execution_phase(_job_state(db, build_id)),
                )
        elif (fail or canc) and latest_unsuccessful is None:
            latest_unsuccessful = DossierUnsuccessfulBuildView(
                build_id=build_id,
                handle=seal_artifact_build(build_id),
                outcome="failed" if fail else "cancelled",
                failure_code=_failure_code(db, build_id) if fail else None,
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


def on_subject_deleted(db: Session, subject_ref: ResourceRef) -> None:
    """Purge every head (all audiences) + its builds + terminal children + events +
    citation edges for a deleted subject, in FK-safe order under the head lock. The
    caller owns the transaction (no commit here). Cleanup wins over a late worker
    promote: the build rows are gone, so ``run_build`` no-ops (rule 10)."""
    from nexus.services.resource_graph.cleanup import delete_edges_for_deleted_resource

    head_ids = [
        UUID(str(r[0]))
        for r in db.execute(
            text(
                "SELECT id FROM artifacts "
                "WHERE subject_scheme = :s AND subject_id = :sid FOR UPDATE"
            ),
            {"s": subject_ref.scheme, "sid": subject_ref.id},
        )
    ]
    if not head_ids:
        return
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
    inserted = db.execute(
        text(
            "INSERT INTO artifacts (subject_scheme, subject_id, audience_scheme, audience_id) "
            "VALUES (:s, :sid, :asch, :aid) "
            "ON CONFLICT (subject_scheme, subject_id, audience_scheme, audience_id) "
            "DO NOTHING RETURNING id"
        ),
        key,
    ).scalar_one_or_none()
    if inserted is not None:
        return UUID(str(inserted))
    # Lost the insert race to a concurrent committer; the row now exists — lock it.
    return UUID(
        str(
            db.execute(
                text(
                    "SELECT id FROM artifacts "
                    "WHERE subject_scheme = :s AND subject_id = :sid "
                    "AND audience_scheme = :asch AND audience_id = :aid FOR UPDATE"
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


def _failure_code(db: Session, build_id: UUID) -> DossierBuildFailureCode | None:
    code = db.execute(
        text("SELECT failure_code FROM artifact_build_failures WHERE build_id = :b"),
        {"b": build_id},
    ).scalar_one_or_none()
    return DossierBuildFailureCode(str(code)) if code is not None else None


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
    live = binding.live_manifest(db, resolved, audience)
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
