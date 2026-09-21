"""The one dossier build lifecycle.

A stable ``artifacts`` head keyed by ``(subject_scheme, subject_id,
audience_scheme, audience_id)``, one ``artifact_builds`` attempt per press, and
exactly one terminal child per attempt: an immutable ``artifact_revisions``
success, an ``artifact_build_failures`` modeled failure, or an
``artifact_build_cancellations`` cancellation. The head row is the only
serialization point — every mutation takes it ``FOR UPDATE`` first — and
active-ness derives from the absence of a terminal child.

This module carries no subject branches: identity, authorization, inputs and
freshness come from the binding table in :mod:`.subjects`.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, cast
from uuid import UUID, uuid4

from pydantic import TypeAdapter
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.errors import TransactionRestart
from nexus.db.models import ArtifactBuild
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.jobs.queue import (
    SUCCEEDED,
    JobExecutionContext,
    JobRow,
    RescheduleRequested,
    ScheduleAt,
    enqueue_unique_job,
    get_job,
    lock_job,
    lock_running_job_claim,
    revoke_jobs_by_dedupe_keys,
    running_job_claim_is_current,
)
from nexus.schemas.llm import CapacityPaused
from nexus.schemas.presence import absent, present
from nexus.services import durable_step_journal as step_journal
from nexus.services import run_kit
from nexus.services.artifacts import subjects
from nexus.services.artifacts.collect import (
    AggregateDependenciesPending,
    Collected,
    DossierInputTooLarge,
    PublishableDossier,
)
from nexus.services.artifacts.coordination import (
    DossierBuildRuntime,
    DossierResearchPending,
    ResearchLeaseLost,
)
from nexus.services.artifacts.dossier_types import (
    ArtifactBuildEventType,
    AudienceLibrary,
    AudienceScope,
    AudienceUser,
    BuildNotActive,
    BuildTicket,
    CancelledEventPayload,
    DossierBuildFailureCode,
    DossierGenerationInProgress,
    DossierIdeaUnresolved,
    FailedEventPayload,
    InvalidInstruction,
    InvalidSubjectLocator,
    ProgressEventPayload,
    RevisionNotFound,
    StartedEventPayload,
    SucceededEventPayload,
)
from nexus.services.artifacts.generation import (
    SYNTHESIS_STEP_PATH,
    DispatchRequired,
    GenerationCancelled,
    GenerationFailure,
    GenerationInputsChanged,
    GenerationResult,
    GenerationUncertainOnReplay,
    SynthesisStep,
    build_synthesis_step,
)
from nexus.services.artifacts.idea import (
    InvalidIdeaText,
    delete_artifact_idea_rows_before_head,
    delete_idea_subject_after_head,
    find_or_create_idea_subject,
    highlight_selection,
    idea_key_for_selection,
    normalize_idea_display,
    record_idea_resolution,
    register_idea_seed,
)
from nexus.services.artifacts.manifests import InputManifestV1
from nexus.services.artifacts.research import ResearchInputsChanged
from nexus.services.artifacts.subjects import Subject, SubjectBinding
from nexus.services.generation_spec import GenerationHistory, read_generation_history
from nexus.services.llm_execution import (
    CancellationSignal,
    GenerationAdmissionInputsChanged,
    GenerationDispatchAborted,
    GenerationUncertain,
    cancel_prepared_generation_without_dispatch_in_current_transaction,
    execute_generation,
    read_capacity_pauses,
)
from nexus.services.llm_ledger import (
    LlmCallOwner,
    lock_generation_owner_in_current_transaction,
    read_latest_generation_for_owner,
)
from nexus.services.resource_graph.citations import replace_citations_for_output
from nexus.services.resource_graph.refs import RESOURCE_SCHEMES, ResourceRef, ResourceScheme
from nexus.services.tool_authority import read_tool_positions

_MAX_INSTRUCTION_CHARS = 4000
_JOB_KIND = "dossier_build"
_CANCEL_POLL_INTERVAL_SECONDS = 0.25
_MANIFEST_ADAPTER: TypeAdapter[InputManifestV1] = TypeAdapter(InputManifestV1)


class _UncertainReplayDefect(RuntimeError):
    """An accepted generation is ``Uncertain`` and cannot be reconciled without
    owner-admissible terminal evidence. Never auto-redispatched; it surfaces as
    Suspended for an operator."""


# ---------------------------------------------------------------------------
# Read views. The route maps these to the wire schemas.
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AdmittedGeneration:
    spec: GenerationHistory
    tool_positions: int


@dataclass(frozen=True, slots=True)
class ActiveBuildView:
    handle: str
    requester_user_id: UUID | None
    instruction: str | None
    created_at: datetime
    execution: step_journal.DurableExecutionPhase
    admitted_generation: AdmittedGeneration | None
    capacity_pause: CapacityPaused | None


@dataclass(frozen=True, slots=True)
class BuildFailed:
    code: DossierBuildFailureCode
    detail: str | None


@dataclass(frozen=True, slots=True)
class BuildCancelled:
    actor_user_id: UUID | None
    at: datetime


@dataclass(frozen=True, slots=True)
class UnsuccessfulBuildView:
    handle: str
    requester_user_id: UUID | None
    instruction: str | None
    created_at: datetime
    admitted_generation: AdmittedGeneration | None
    outcome: BuildFailed | BuildCancelled


@dataclass(frozen=True, slots=True)
class DossierHeadView:
    artifact_id: UUID | None
    subject: Subject
    subject_scheme: str
    subject_id: UUID
    current_revision_id: UUID | None
    freshness: Literal["Current", "Stale"] | None
    active_build: ActiveBuildView | None
    latest_unsuccessful_build: UnsuccessfulBuildView | None
    revision_count: int


@dataclass(frozen=True, slots=True)
class ArtifactActionFacts:
    """Set-based action facts for an Artifact head or immutable revision."""

    has_active_build: bool
    is_current_revision: bool | None


@dataclass(frozen=True, slots=True)
class ArtifactActionCandidate:
    """Audience-visible lifecycle facts plus the subject still needing authz."""

    facts: ArtifactActionFacts
    subject_ref: ResourceRef | None


def artifact_action_candidates(
    db: Session,
    *,
    viewer_id: UUID,
    artifact_ids: Sequence[UUID],
    revision_ids: Sequence[UUID],
) -> tuple[dict[UUID, ArtifactActionCandidate], dict[UUID, ArtifactActionCandidate]]:
    """Read audience-visible Artifact lifecycle candidates in two bounded queries.

    Resource-subject visibility stays with each subject domain; the snapshot
    composition owner resolves those refs in bounded scheme batches, and every
    mutating command re-resolves and reauthorizes.
    """
    ordered_artifact_ids = list(dict.fromkeys(artifact_ids))
    ordered_revision_ids = list(dict.fromkeys(revision_ids))
    audience = subjects.audience_visible_sql("artifact")
    params = {"viewer_id": viewer_id, "viewer_id_text": str(viewer_id)}
    artifacts: dict[UUID, ArtifactActionCandidate] = {}
    revisions: dict[UUID, ArtifactActionCandidate] = {}
    if ordered_artifact_ids:
        rows = db.execute(
            text(
                f"""
                SELECT artifact.id, artifact.subject_scheme, artifact.subject_id,
                       EXISTS(
                           SELECT 1 FROM artifact_builds build
                           WHERE build.artifact_id = artifact.id
                             AND {_no_terminal_child_sql("build")}
                       ) AS has_active_build
                FROM artifacts artifact
                WHERE artifact.id = ANY(:artifact_ids) AND {audience}
                """
            ),
            {"artifact_ids": ordered_artifact_ids, **params},
        ).mappings()
        artifacts = {
            UUID(str(row["id"])): ArtifactActionCandidate(
                facts=ArtifactActionFacts(
                    has_active_build=bool(row["has_active_build"]),
                    is_current_revision=None,
                ),
                subject_ref=_action_subject_ref(row),
            )
            for row in rows
        }
    if ordered_revision_ids:
        rows = db.execute(
            text(
                f"""
                SELECT revision.id, artifact.subject_scheme, artifact.subject_id,
                       artifact.current_revision_id = revision.id AS is_current
                FROM artifact_revisions revision
                JOIN artifact_builds build ON build.id = revision.build_id
                JOIN artifacts artifact ON artifact.id = build.artifact_id
                WHERE revision.id = ANY(:revision_ids) AND {audience}
                """
            ),
            {"revision_ids": ordered_revision_ids, **params},
        ).mappings()
        revisions = {
            UUID(str(row["id"])): ArtifactActionCandidate(
                facts=ArtifactActionFacts(
                    has_active_build=False,
                    is_current_revision=bool(row["is_current"]),
                ),
                subject_ref=_action_subject_ref(row),
            )
            for row in rows
        }
    return artifacts, revisions


def _action_subject_ref(row: Any) -> ResourceRef | None:
    scheme = str(row["subject_scheme"])
    if scheme == "idea":
        return None
    if scheme not in RESOURCE_SCHEMES:
        raise AssertionError(f"unknown Artifact subject scheme: {scheme!r}")
    return ResourceRef(scheme=cast("ResourceScheme", scheme), id=UUID(str(row["subject_id"])))


# ---------------------------------------------------------------------------
# Build commands: the sole head/build minter.
# ---------------------------------------------------------------------------


def start_build(
    db: Session,
    *,
    subject_scheme: str,
    subject_handle: str,
    requester_user_id: UUID,
    idempotency_key: str,
    instruction: str | None,
) -> BuildTicket:
    """Generate for a locator-addressed subject, creating its head on first press."""
    binding = subjects.binding_for(subject_scheme)
    if binding is None or subject_scheme == "idea":
        raise InvalidSubjectLocator()
    clean_instruction = _validate_instruction(instruction)

    def op() -> BuildTicket:
        subject = binding.resolve(db, subject_handle, requester_user_id)
        audience = subjects.audience_for(subject, requester_user_id)
        scheme, subject_id = subjects.subject_key(subject)
        artifact_id = _ensure_head_locked(db, scheme, subject_id, audience)
        ticket = _ensure_build_locked(
            db,
            artifact_id=artifact_id,
            requester_user_id=requester_user_id,
            instruction=clean_instruction,
            idempotency_key=idempotency_key,
        )
        db.commit()
        return ticket

    return retry_serializable(db, "start_build", op)


def start_artifact_build(
    db: Session,
    *,
    artifact_id: UUID,
    requester_user_id: UUID,
    idempotency_key: str,
    instruction: str | None,
) -> BuildTicket:
    """Generate again for an existing, already-authorized head."""
    clean_instruction = _validate_instruction(instruction)

    def op() -> BuildTicket:
        _lock_head(db, artifact_id)
        _visible_head(db, artifact_id=artifact_id, viewer_id=requester_user_id)
        ticket = _ensure_build_locked(
            db,
            artifact_id=artifact_id,
            requester_user_id=requester_user_id,
            instruction=clean_instruction,
            idempotency_key=idempotency_key,
        )
        db.commit()
        return ticket

    return retry_serializable(db, "start_artifact_build", op)


@dataclass(frozen=True, slots=True)
class LearnOutcome:
    kind: Literal["Opened", "BuildAccepted"]
    artifact_id: UUID
    build_id: UUID | None


def learn_idea(
    db: Session,
    *,
    highlight_id: UUID,
    requester_user_id: UUID,
    idempotency_key: str,
) -> LearnOutcome:
    """Map one highlight to its Idea, seed the Idea head, and start at most one build.

    The highlight's selected text canonicalizes to exactly one Idea identity, so
    learning the same phrase twice reaches the same head; the resolution row and
    the seed pair carry their own idempotency. One press's build key is the
    caller's, so a transport retry replays it while a later press after a
    terminal build starts the next one.
    """

    def op() -> LearnOutcome:
        exact = highlight_selection(db, user_id=requester_user_id, highlight_id=highlight_id)
        try:
            idea_key = idea_key_for_selection(exact)
            display_title = normalize_idea_display(exact)
        except InvalidIdeaText as exc:
            raise DossierIdeaUnresolved() from exc
        idea = find_or_create_idea_subject(
            db,
            user_id=requester_user_id,
            idea_key=idea_key,
            display_title=display_title,
        )
        record_idea_resolution(
            db,
            user_id=requester_user_id,
            highlight_id=highlight_id,
            idea_subject_id=idea.id,
        )
        artifact_id = _ensure_head_locked(
            db, "idea", idea.id, AudienceUser(user_id=requester_user_id)
        )
        register_idea_seed(db, artifact_id=artifact_id, highlight_id=highlight_id)
        current_revision_id = db.execute(
            text("SELECT current_revision_id FROM artifacts WHERE id = :id"),
            {"id": artifact_id},
        ).scalar_one()
        if current_revision_id is not None or _has_active_build(db, artifact_id):
            db.commit()
            return LearnOutcome(kind="Opened", artifact_id=artifact_id, build_id=None)
        ticket = _ensure_build_locked(
            db,
            artifact_id=artifact_id,
            requester_user_id=requester_user_id,
            instruction=None,
            idempotency_key=f"learn:{idempotency_key}",
        )
        db.commit()
        return LearnOutcome(kind="BuildAccepted", artifact_id=artifact_id, build_id=ticket.build_id)

    return retry_serializable(db, "learn_idea", op)


def _ensure_build_locked(
    db: Session,
    *,
    artifact_id: UUID,
    requester_user_id: UUID,
    instruction: str | None,
    idempotency_key: str,
) -> BuildTicket:
    """Insert one build, its ``Started`` event and its job under the head lock."""
    existing = db.execute(
        text("SELECT id FROM artifact_builds WHERE artifact_id = :h AND idempotency_key = :k"),
        {"h": artifact_id, "k": idempotency_key},
    ).scalar_one_or_none()
    if existing is not None:
        build_id = UUID(str(existing))
        return BuildTicket(
            artifact_id=artifact_id, build_id=build_id, handle=str(build_id), created=False
        )
    if _has_active_build(db, artifact_id):
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
                    "h": artifact_id,
                    "req": requester_user_id,
                    "ins": instruction,
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
            build_handle=str(build_id),
            artifact_ref=ResourceRef(scheme="artifact", id=artifact_id).uri,
        ).model_dump(mode="json"),
    )
    enqueue_unique_job(
        db,
        kind=_JOB_KIND,
        dedupe_key=_dispatch_key(build_id),
        payload={"build_id": str(build_id), "coordination": {}},
        max_attempts=3,
    )
    return BuildTicket(
        artifact_id=artifact_id, build_id=build_id, handle=str(build_id), created=True
    )


# ---------------------------------------------------------------------------
# run_build: collect -> generate -> materialise -> publish.
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _InputRecheck:
    binding: SubjectBinding
    subject: Subject
    audience: AudienceScope
    collected: Collected
    requester_user_id: UUID


async def run_build(
    db: Session,
    *,
    build_id: UUID,
    ctx: JobExecutionContext,
    runtime: DossierBuildRuntime,
) -> RescheduleRequested | None:
    """Run one build attempt.

    Replay-safe: a no-op once the build, its head or its requester is gone, or
    once a terminal child exists. Never holds a transaction across a network
    call, and never publishes without rechecking the inputs under the head lock.
    """
    build = db.get(ArtifactBuild, build_id)
    if build is None or build.requester_user_id is None:
        return None
    if _existing_terminal_child(db, build_id) is not None:
        return None
    head = _head_row(db, build.artifact_id)
    job = get_job(db, ctx.job_id)
    if head is None or job is None:
        return None
    if job.kind != _JOB_KIND or job.dedupe_key != _dispatch_key(build_id):
        raise AssertionError(f"job {job.id} does not own dossier build {build_id}")
    binding = subjects.binding_for(head.subject_scheme)
    if binding is None:
        raise AssertionError(f"no binding for subject scheme {head.subject_scheme!r}")
    requester_user_id = build.requester_user_id
    instruction = build.instruction
    audience = _audience_from_head(head)
    subject = subjects.visible_persisted_subject(
        db,
        subject_scheme=head.subject_scheme,
        subject_id=head.subject_id,
        audience_scheme=head.audience_scheme,
        audience_id=head.audience_id,
        viewer_id=requester_user_id,
    )
    if subject is None:
        db.commit()
        _terminal_failure(
            db,
            build_id=build_id,
            code=DossierBuildFailureCode.InputsChanged,
            detail="subject or audience is no longer visible",
            ctx=ctx,
        )
        return None

    db.commit()
    try:
        try:
            collected = await binding.collect(db, subject, audience, runtime)
        except DossierResearchPending as exc:
            db.commit()
            return RescheduleRequested(schedule=ScheduleAt(exc.available_at))
        except ResearchLeaseLost:
            db.rollback()
            return None
        except AggregateDependenciesPending:
            db.commit()
            return RescheduleRequested(
                schedule=ScheduleAt(datetime.now(UTC) + timedelta(seconds=5))
            )
        except ResearchInputsChanged:
            db.commit()
            _terminal_failure(
                db,
                build_id=build_id,
                code=DossierBuildFailureCode.InputsChanged,
                detail="a frozen research source changed during collection",
                ctx=ctx,
            )
            return None
        except DossierInputTooLarge:
            db.commit()
            _terminal_failure(
                db,
                build_id=build_id,
                code=DossierBuildFailureCode.ContextTooLarge,
                detail="subject input exceeds the binding budget",
                ctx=ctx,
            )
            return None

        empty = _pre_dispatch_failure(collected)
        if empty is not None:
            db.commit()
            _terminal_failure(db, build_id=build_id, code=empty, detail=None, ctx=ctx)
            return None

        recheck = _InputRecheck(
            binding=binding,
            subject=subject,
            audience=audience,
            collected=collected,
            requester_user_id=requester_user_id,
        )
        if not _attempt_can_write(db, build_id=build_id, ctx=ctx):
            db.rollback()
            return None
        if not _inputs_are_current(db, recheck):
            db.commit()
            _terminal_failure(
                db,
                build_id=build_id,
                code=DossierBuildFailureCode.InputsChanged,
                detail="inputs changed before generation dispatch",
                ctx=ctx,
            )
            return None

        document = await _run_synthesis(
            db,
            build_id=build_id,
            step=build_synthesis_step(
                build_id=build_id,
                operation=binding.operation,
                system_prompt=binding.system_prompt,
                collected=collected,
                instruction=instruction,
            ),
            runtime=runtime,
            recheck=recheck,
        )
        if document is None or isinstance(document, RescheduleRequested):
            return document
        db.commit()
        _success_terminal(
            db,
            build_id=build_id,
            creator_user_id=requester_user_id,
            recheck=recheck,
            document=document,
            manifest=collected.manifest,
            ctx=ctx,
        )
        return None
    finally:
        if db.in_transaction():
            db.rollback()


def _pre_dispatch_failure(collected: Collected) -> DossierBuildFailureCode | None:
    if not collected.candidates:
        return DossierBuildFailureCode.NoSourceMaterial
    if collected.dependency_failed:
        return DossierBuildFailureCode.DependencyProjectionFailed
    return None


async def _run_synthesis(
    db: Session,
    *,
    build_id: UUID,
    step: SynthesisStep,
    runtime: DossierBuildRuntime,
    recheck: _InputRecheck,
) -> PublishableDossier | RescheduleRequested | None:
    """Run or replay the build's one durable generation."""
    ctx = runtime.execution_context
    try:
        replay = step.replay(runtime)
    except GenerationInputsChanged:
        _terminal_failure(
            db,
            build_id=build_id,
            code=DossierBuildFailureCode.InputsChanged,
            detail="inputs changed since generation was prepared",
            ctx=ctx,
            recheck=recheck,
        )
        return None
    except GenerationUncertainOnReplay as error:
        raise _UncertainReplayDefect(str(error)) from error
    if not isinstance(replay, DispatchRequired):
        return _consume(db, build_id=build_id, result=replay, ctx=ctx, recheck=recheck)
    if not _attempt_can_write(db, build_id=build_id, ctx=ctx):
        db.rollback()
        return None

    def lock_dispatch(dispatch_db: Session) -> JobRow | None:
        return _lock_dispatch(dispatch_db, build_id=build_id, ctx=ctx, recheck=recheck)

    try:
        admission = await step.admit(
            runtime,
            requester_user_id=recheck.requester_user_id,
            lock_dispatch=lock_dispatch,
        )
    except GenerationAdmissionInputsChanged:
        db.rollback()
        _terminal_failure(
            db,
            build_id=build_id,
            code=DossierBuildFailureCode.InputsChanged,
            detail="inputs changed while the generation admission was frozen",
            ctx=ctx,
            recheck=recheck,
        )
        return None
    except GenerationDispatchAborted:
        db.rollback()
        return None
    if not _refresh_job(db, runtime):
        return None
    if not _append_progress(db, build_id=build_id, ctx=ctx):
        return None

    cancel_signal = asyncio.Event()
    watcher = asyncio.create_task(
        _watch_build_publishable(build_id=build_id, ctx=ctx, cancel_signal=cancel_signal)
    )
    try:
        execution_result = await execute_generation(
            admission.request,
            session_factory=get_session_factory(),
            runtime=runtime.llm_runtime,
            encode_terminal=step.encode_terminal,
            encode_failure=step.encode_failure,
            cancel_signal=cast("CancellationSignal", cancel_signal),
            before_terminal=admission.before_terminal,
        )
    except GenerationDispatchAborted:
        _terminal_failure(
            db,
            build_id=build_id,
            code=DossierBuildFailureCode.InputsChanged,
            detail="generation dispatch was fenced before host acceptance",
            ctx=ctx,
            recheck=recheck,
        )
        return None
    except GenerationUncertain as error:
        raise _UncertainReplayDefect(str(error)) from error
    finally:
        await admission.close()
        watcher.cancel()
        await asyncio.gather(watcher, return_exceptions=True)

    if isinstance(execution_result, RescheduleRequested):
        return execution_result
    if not _refresh_job(db, runtime):
        return None
    return _consume(
        db,
        build_id=build_id,
        result=step.decode_result(execution_result.terminal_result),
        ctx=ctx,
        recheck=recheck,
    )


def _consume(
    db: Session,
    *,
    build_id: UUID,
    result: GenerationResult,
    ctx: JobExecutionContext,
    recheck: _InputRecheck,
) -> PublishableDossier | None:
    if isinstance(result, PublishableDossier):
        return result
    if isinstance(result, GenerationFailure):
        _terminal_failure(
            db,
            build_id=build_id,
            code=result.code,
            detail=result.detail,
            ctx=ctx,
            recheck=recheck,
        )
        return None
    _terminal_failure(
        db,
        build_id=build_id,
        code=DossierBuildFailureCode.RuntimeUnavailable,
        detail="generation was cancelled without a Dossier cancellation",
        ctx=ctx,
        recheck=recheck,
    )
    return None


def _refresh_job(db: Session, runtime: DossierBuildRuntime) -> bool:
    """Refresh the job snapshot written by the shared generation transaction."""
    try:
        runtime.refresh_job(db)
    except ResearchLeaseLost:
        return False
    return True


def _lock_dispatch(
    db: Session,
    *,
    build_id: UUID,
    ctx: JobExecutionContext,
    recheck: _InputRecheck,
) -> JobRow | None:
    """Lock and revalidate the exact active owner immediately before dispatch."""
    if _lock_head_id_for_build(db, build_id) is None:
        return None
    if _existing_terminal_child(db, build_id) is not None:
        return None
    try:
        recheck.binding.authorize(db, recheck.subject, recheck.requester_user_id)
    except NotFoundError:
        return None
    job = lock_job(db, ctx.job_id)
    if job is None or job.kind != _JOB_KIND or job.dedupe_key != _dispatch_key(build_id):
        return None
    return job


def _append_progress(db: Session, *, build_id: UUID, ctx: JobExecutionContext) -> bool:
    """Append the build's single ``Progress`` event in its own fenced transaction."""

    def op() -> bool:
        if _lock_head_id_for_build(db, build_id) is None or not _attempt_can_write(
            db, build_id=build_id, ctx=ctx
        ):
            db.rollback()
            return False
        already = db.execute(
            text(
                "SELECT EXISTS(SELECT 1 FROM artifact_build_events "
                "WHERE build_id = :build_id AND event_type = 'Progress')"
            ),
            {"build_id": build_id},
        ).scalar_one()
        if not already:
            _append_build_event(
                db,
                build_id=build_id,
                event_type=ArtifactBuildEventType.Progress,
                payload=ProgressEventPayload(
                    phase=SYNTHESIS_STEP_PATH, message="Generating dossier"
                ).model_dump(mode="json"),
            )
        db.commit()
        return True

    return retry_serializable(db, "_append_progress", op)


async def _watch_build_publishable(
    *,
    build_id: UUID,
    ctx: JobExecutionContext,
    cancel_signal: asyncio.Event,
) -> None:
    """Stop the in-flight model stream once the build can no longer publish.

    A fresh session per poll, so a long-lived worker transaction cannot hide a
    committed cancellation, a purge, or a lost lease.
    """
    session_factory = get_session_factory()
    while not cancel_signal.is_set():
        with session_factory() as watch_db:
            alive = bool(
                watch_db.execute(
                    text(
                        "SELECT EXISTS(SELECT 1 FROM artifacts a "
                        "JOIN artifact_builds b ON b.artifact_id = a.id WHERE b.id = :build_id)"
                    ),
                    {"build_id": build_id},
                ).scalar_one()
            ) and _attempt_can_write(watch_db, build_id=build_id, ctx=ctx)
            watch_db.rollback()
        if not alive:
            cancel_signal.set()
            return
        try:
            await asyncio.wait_for(cancel_signal.wait(), timeout=_CANCEL_POLL_INTERVAL_SECONDS)
        except TimeoutError:
            pass


# ---------------------------------------------------------------------------
# Terminal writes. Each locks the head and yields to the first committed child.
# ---------------------------------------------------------------------------


def _success_terminal(
    db: Session,
    *,
    build_id: UUID,
    creator_user_id: UUID,
    recheck: _InputRecheck,
    document: PublishableDossier,
    manifest: InputManifestV1,
    ctx: JobExecutionContext,
) -> None:
    """Publish the revision, its citation edges and the head repoint atomically.

    Under the head lock the inputs are rechecked once more: a mismatch writes
    ``InputsChanged`` and the already-paid output survives only in the ledger.
    """
    manifest_json = json.dumps(manifest.model_dump(mode="json"))

    def op() -> None:
        head_id = _lock_head_id_for_build(db, build_id)
        if head_id is None or _existing_terminal_child(db, build_id) is not None:
            db.rollback()
            return
        if not _running_claim_is_current(db, ctx):
            db.rollback()
            return
        if not _inputs_are_current(db, recheck):
            _insert_failure(
                db,
                build_id=build_id,
                code=DossierBuildFailureCode.InputsChanged,
                detail="inputs changed between collection and terminal recheck",
            )
            db.commit()
            return
        citation_owner = subjects.citation_owner(db, recheck.audience)
        revision_id = uuid4()
        db.execute(
            text(
                "INSERT INTO artifact_revisions "
                "(id, build_id, content_html, content_text, input_manifest, "
                " citation_owner_user_id, creator_user_id, promoted_at) "
                "VALUES (:id, :b, :html, :text, CAST(:manifest AS jsonb), "
                " :owner, :creator, now())"
            ),
            {
                "id": revision_id,
                "b": build_id,
                "html": document.content_html,
                "text": document.content_text,
                "manifest": manifest_json,
                "owner": citation_owner,
                "creator": creator_user_id,
            },
        )
        replace_citations_for_output(
            db,
            viewer_id=citation_owner,
            source=ResourceRef(scheme="artifact_revision", id=revision_id),
            citations=document.citations,
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
    ctx: JobExecutionContext | None = None,
    recheck: _InputRecheck | None = None,
) -> None:
    """Write the modeled failure child and its ``Failed`` event under the head lock."""

    def op() -> None:
        owner = LlmCallOwner(kind="artifact_build", id=build_id)
        lock_generation_owner_in_current_transaction(db, owner)
        if _lock_head_id_for_build(db, build_id) is None:
            db.rollback()
            return
        if not _close_prepared_generation(db, owner=owner, build_id=build_id, ctx=ctx):
            db.rollback()
            return
        if _existing_terminal_child(db, build_id) is not None:
            db.commit()
            return
        effective_code, effective_detail = code, detail
        if recheck is not None and not _inputs_are_current(db, recheck):
            effective_code = DossierBuildFailureCode.InputsChanged
            effective_detail = "inputs changed between collection and terminal recheck"
        _insert_failure(db, build_id=build_id, code=effective_code, detail=effective_detail)
        db.commit()

    retry_serializable(db, "_terminal_failure", op)


def _insert_failure(
    db: Session,
    *,
    build_id: UUID,
    code: DossierBuildFailureCode,
    detail: str | None,
) -> None:
    db.execute(
        text(
            "INSERT INTO artifact_build_failures (build_id, failure_code, detail) "
            "VALUES (:b, :code, :detail)"
        ),
        {"b": build_id, "code": code.value, "detail": detail},
    )
    _append_build_event(
        db,
        build_id=build_id,
        event_type=ArtifactBuildEventType.Failed,
        payload=FailedEventPayload(
            failure_code=code,
            detail=present(detail) if detail is not None else absent(),
        ).model_dump(mode="json"),
    )


def _inputs_are_current(db: Session, recheck: _InputRecheck) -> bool:
    try:
        recheck.binding.authorize(db, recheck.subject, recheck.requester_user_id)
    except NotFoundError:
        return False
    return recheck.binding.recheck(db, recheck.subject, recheck.audience, recheck.collected)


def _close_prepared_generation(
    db: Session,
    *,
    owner: LlmCallOwner,
    build_id: UUID,
    ctx: JobExecutionContext | None,
) -> bool:
    """Close the one prepared generation before its owner becomes terminal.

    ``Uncertain`` is intentionally untouched: only a dispatch proven not
    accepted may be closed by an owner-side cancellation. ``False`` means the
    supplied worker attempt lost its claim and no terminal write is allowed.
    """
    if ctx is not None:
        if not lock_running_job_claim(db, context=ctx):
            return False
        job = get_job(db, ctx.job_id)
    else:
        job_id = db.execute(
            text(
                "SELECT id FROM background_jobs "
                "WHERE kind = :kind AND dedupe_key = :dedupe_key FOR UPDATE"
            ),
            {"kind": _JOB_KIND, "dedupe_key": _dispatch_key(build_id)},
        ).scalar_one_or_none()
        job = None if job_id is None else lock_job(db, UUID(str(job_id)))
    if job is None:
        return ctx is None
    if job.kind != _JOB_KIND or job.dedupe_key != _dispatch_key(build_id):
        raise AssertionError(f"job {job.id} does not own dossier build {build_id}")
    state = step_journal.read_step_states(job).get(SYNTHESIS_STEP_PATH)
    if state is None or state.dispatch_phase is not step_journal.Prepared:
        return True
    completed = cancel_prepared_generation_without_dispatch_in_current_transaction(
        db,
        owner=owner,
        state=state,
        terminal_result=GenerationCancelled().model_dump_json(),
    )
    db.execute(
        text("UPDATE background_jobs SET payload = CAST(:payload AS jsonb) WHERE id = :job_id"),
        {
            "payload": json.dumps(
                step_journal.payload_with_step_state(
                    job.payload, step_path=SYNTHESIS_STEP_PATH, state=completed
                )
            ),
            "job_id": job.id,
        },
    )
    return True


def cancel_build(db: Session, *, build_id: UUID, actor_user_id: UUID) -> None:
    """Cancel an active build; a succeeded or failed build raises ``BuildNotActive``.

    Cancelling an already-cancelled build is a no-op, and cancelling one build
    immediately permits the next Generate — the conflict key is the build.
    """

    def op() -> bool:
        owner = LlmCallOwner(kind="artifact_build", id=build_id)
        lock_generation_owner_in_current_transaction(db, owner)
        head_id = _lock_head_id_for_build(db, build_id)
        if head_id is None:
            db.rollback()
            raise BuildNotActive()
        try:
            _visible_head(db, artifact_id=head_id, viewer_id=actor_user_id)
        except NotFoundError:
            db.rollback()
            raise NotFoundError(
                ApiErrorCode.E_DOSSIER_NOT_FOUND, "Dossier build not found"
            ) from None
        if not _close_prepared_generation(db, owner=owner, build_id=build_id, ctx=None):
            raise AssertionError("unfenced dossier cancellation lost queue ownership")
        existing = _existing_terminal_child(db, build_id)
        if existing in ("revision", "failure"):
            db.commit()
            return False
        if existing == "cancellation":
            db.commit()
            return True
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
        return True

    if not retry_serializable(db, "cancel_build", op):
        raise BuildNotActive()


def make_current(db: Session, *, revision_id: UUID, actor_user_id: UUID) -> None:
    """Repoint the head at an older revision without mutating any revision."""

    def op() -> None:
        artifact_id = db.execute(
            text(
                "SELECT b.artifact_id FROM artifact_revisions r "
                "JOIN artifact_builds b ON b.id = r.build_id WHERE r.id = :rid"
            ),
            {"rid": revision_id},
        ).scalar_one_or_none()
        if artifact_id is None:
            db.rollback()
            raise RevisionNotFound()
        head_id = UUID(str(artifact_id))
        _lock_head(db, head_id)
        try:
            _visible_head(db, artifact_id=head_id, viewer_id=actor_user_id)
        except NotFoundError:
            db.rollback()
            raise RevisionNotFound() from None
        db.execute(
            text("UPDATE artifacts SET current_revision_id = :r, updated_at = now() WHERE id = :h"),
            {"r": revision_id, "h": head_id},
        )
        db.commit()

    retry_serializable(db, "make_current", op)


# ---------------------------------------------------------------------------
# Head and build reads.
# ---------------------------------------------------------------------------


def read_head(
    db: Session,
    *,
    subject_scheme: str,
    subject_handle: str,
    requester_user_id: UUID,
) -> DossierHeadView:
    """Read a locator-addressed subject's dossier; never inserts a head."""
    binding = subjects.binding_for(subject_scheme)
    if binding is None or subject_scheme == "idea":
        raise InvalidSubjectLocator()
    subject = binding.resolve(db, subject_handle, requester_user_id)
    audience = subjects.audience_for(subject, requester_user_id)
    scheme, subject_id = subjects.subject_key(subject)
    head = db.execute(
        text(
            "SELECT id, current_revision_id FROM artifacts "
            "WHERE subject_scheme = :s AND subject_id = :sid "
            "AND audience_scheme = :asch AND audience_id = :aid"
        ),
        {
            "s": scheme,
            "sid": subject_id,
            "asch": audience.scheme,
            "aid": str(audience.audience_id),
        },
    ).first()
    if head is None:
        return DossierHeadView(
            artifact_id=None,
            subject=subject,
            subject_scheme=scheme,
            subject_id=subject_id,
            current_revision_id=None,
            freshness=None,
            active_build=None,
            latest_unsuccessful_build=None,
            revision_count=0,
        )
    return _head_snapshot(
        db,
        binding=binding,
        subject=subject,
        audience=audience,
        head_id=UUID(str(head[0])),
        current_revision_id=(UUID(str(head[1])) if head[1] is not None else None),
    )


def read_artifact_head(
    db: Session,
    *,
    artifact_id: UUID,
    requester_user_id: UUID,
) -> DossierHeadView:
    """Read one existing head by ref with audience and subject authorization."""
    head, subject = _visible_head(db, artifact_id=artifact_id, viewer_id=requester_user_id)
    binding = subjects.binding_for(head.subject_scheme)
    if binding is None:
        raise AssertionError(f"no binding for subject scheme {head.subject_scheme!r}")
    return _head_snapshot(
        db,
        binding=binding,
        subject=subject,
        audience=_audience_from_head(head),
        head_id=artifact_id,
        current_revision_id=head.current_revision_id,
    )


def artifact_subject_scheme(db: Session, *, artifact_id: UUID, requester_user_id: UUID) -> str:
    """The head's subject scheme, 404-masked — the cheap read before a regenerate."""
    head, _ = _visible_head(db, artifact_id=artifact_id, viewer_id=requester_user_id)
    return head.subject_scheme


def _head_snapshot(
    db: Session,
    *,
    binding: SubjectBinding,
    subject: Subject,
    audience: AudienceScope,
    head_id: UUID,
    current_revision_id: UUID | None,
) -> DossierHeadView:
    builds = (
        db.execute(
            text(
                "SELECT b.id, b.requester_user_id, b.instruction, b.created_at, "
                "(SELECT count(*) FROM artifact_revisions r WHERE r.build_id = b.id) AS rev, "
                "(SELECT count(*) FROM artifact_build_failures f WHERE f.build_id = b.id) AS fail, "
                "(SELECT count(*) FROM artifact_build_cancellations c WHERE c.build_id = b.id) "
                "  AS canc, "
                "f.failure_code, f.detail AS failure_detail, "
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
    active: ActiveBuildView | None = None
    latest_unsuccessful: UnsuccessfulBuildView | None = None
    revision_count = 0
    newer_success_seen = False
    for row in builds:
        rev, fail, canc = int(row["rev"]), int(row["fail"]), int(row["canc"])
        if rev + fail + canc > 1:
            raise AssertionError(f"build {row['id']} has conflicting terminal children")
        revision_count += rev
        build_id = UUID(str(row["id"]))
        requester = _optional_uuid(row["requester_user_id"])
        instruction = str(row["instruction"]) if row["instruction"] is not None else None
        if rev + fail + canc == 0:
            if active is None:
                job = _job_state(db, build_id)
                active = ActiveBuildView(
                    handle=str(build_id),
                    requester_user_id=requester,
                    instruction=instruction,
                    created_at=row["created_at"],
                    execution=_execution_phase(job),
                    admitted_generation=_admitted_generation(db, build_id),
                    capacity_pause=_capacity_pause(job),
                )
        elif rev:
            # Builds are newest first: every remaining failure is older than
            # this success and is therefore not the latest unsuccessful outcome.
            newer_success_seen = True
        elif latest_unsuccessful is None and not newer_success_seen:
            latest_unsuccessful = UnsuccessfulBuildView(
                handle=str(build_id),
                requester_user_id=requester,
                instruction=instruction,
                created_at=row["created_at"],
                admitted_generation=_admitted_generation(db, build_id),
                outcome=(
                    BuildFailed(
                        code=DossierBuildFailureCode(str(row["failure_code"])),
                        detail=(
                            str(row["failure_detail"])
                            if row["failure_detail"] is not None
                            else None
                        ),
                    )
                    if fail
                    else BuildCancelled(
                        actor_user_id=_optional_uuid(row["cancellation_actor_user_id"]),
                        at=row["cancelled_at"],
                    )
                ),
            )

    scheme, subject_id = subjects.subject_key(subject)
    return DossierHeadView(
        artifact_id=head_id,
        subject=subject,
        subject_scheme=scheme,
        subject_id=subject_id,
        current_revision_id=current_revision_id,
        freshness=_freshness(
            db,
            binding=binding,
            subject=subject,
            audience=audience,
            current_revision_id=current_revision_id,
        ),
        active_build=active,
        latest_unsuccessful_build=latest_unsuccessful,
        revision_count=revision_count,
    )


def assert_build_viewer(db: Session, *, build_id: UUID, viewer_id: UUID) -> None:
    """404-masked authorization for build reads, cancellation, and streaming."""
    artifact_id = db.execute(
        text("SELECT artifact_id FROM artifact_builds WHERE id = :build_id"),
        {"build_id": build_id},
    ).scalar_one_or_none()
    if artifact_id is None:
        raise NotFoundError(ApiErrorCode.E_DOSSIER_NOT_FOUND, "Dossier build not found")
    try:
        _visible_head(db, artifact_id=UUID(str(artifact_id)), viewer_id=viewer_id)
    except NotFoundError:
        raise NotFoundError(ApiErrorCode.E_DOSSIER_NOT_FOUND, "Dossier build not found") from None


def build_execution_phase(
    db: Session, *, build_id: UUID, viewer_id: UUID
) -> step_journal.DurableExecutionPhase:
    """The fresh unsequenced queue advisory for one build."""
    assert_build_viewer(db, build_id=build_id, viewer_id=viewer_id)
    return _execution_phase(_job_state(db, build_id))


# ---------------------------------------------------------------------------
# Teardown.
# ---------------------------------------------------------------------------


def lock_cleanup_heads_in_order(
    db: Session,
    *,
    subject_refs: Sequence[ResourceRef] = (),
    audiences: Sequence[AudienceScope] = (),
) -> list[UUID]:
    """Stabilize one composing cleanup's complete generation/head lock set.

    A teardown that invokes more than one subject/audience cleanup calls this
    once first: it acquires every discovered generation owner, then the
    canonical head union, then the queue jobs. Otherwise two transactions can
    each hold a head from one subset and deadlock on the overlap. The caller
    owns the transaction and keeps it open through every nested cleanup.
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
    head_ids = [
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
                    SELECT 1 FROM subject_keys key
                    WHERE key.scheme = artifact.subject_scheme
                      AND key.id = artifact.subject_id
                )
                   OR EXISTS (
                    SELECT 1 FROM audience_keys key
                    WHERE key.scheme = artifact.audience_scheme
                      AND key.id = artifact.audience_id
                )
                ORDER BY artifact.id
                """
            ),
            {
                "subject_keys": json.dumps(subject_keys),
                "audience_keys": json.dumps(audience_keys),
            },
        ).scalars()
    ]
    return _lock_heads_in_order(db, head_ids)


def on_subject_deleted(db: Session, subject_ref: ResourceRef) -> None:
    """Purge every head for a deleted subject, in FK-safe order under the lock.

    The caller owns the transaction and its retry. Cleanup wins over a late
    worker promote: the build rows are gone, so ``run_build`` no-ops.
    """
    head_ids = [
        UUID(str(row[0]))
        for row in db.execute(
            text(
                "SELECT id FROM artifacts "
                "WHERE subject_scheme = :s AND subject_id = :sid ORDER BY id"
            ),
            {"s": subject_ref.scheme, "sid": subject_ref.id},
        )
    ]
    locked = _lock_heads_in_order(db, head_ids)
    if locked:
        _delete_heads(db, locked)


def on_audience_visibility_changed(db: Session, *, audience: AudienceScope) -> None:
    """Purge the user's own heads whose subjects they can no longer see.

    Shared Library heads are untouched: they are keyed to the Library audience.
    """
    if not isinstance(audience, AudienceUser):
        return
    rows = list(
        db.execute(
            text(
                "SELECT id, subject_scheme, subject_id FROM artifacts "
                "WHERE audience_scheme = 'user' AND audience_id = :audience_id ORDER BY id"
            ),
            {"audience_id": str(audience.user_id)},
        ).mappings()
    )
    lost = [
        UUID(str(row["id"]))
        for row in rows
        if subjects.visible_persisted_subject(
            db,
            subject_scheme=str(row["subject_scheme"]),
            subject_id=UUID(str(row["subject_id"])),
            audience_scheme="user",
            audience_id=str(audience.user_id),
            viewer_id=audience.user_id,
        )
        is None
    ]
    locked = _lock_heads_in_order(db, lost)
    if locked:
        _delete_heads(db, locked)


def _lock_heads_in_order(db: Session, head_ids: Sequence[UUID]) -> list[UUID]:
    """Lock one exact teardown set: generation owners, then heads, then jobs.

    The caller's repository transaction retry is the only retry boundary, so a
    concurrent build change raises ``TransactionRestart`` and the whole owning
    mutation reacquires the complete set in global order.
    """
    requested = sorted(set(head_ids))
    if not requested:
        return []
    candidate_head_ids = [
        UUID(str(head_id))
        for head_id in db.execute(
            text("SELECT id FROM artifacts WHERE id = ANY(:head_ids) ORDER BY id"),
            {"head_ids": requested},
        ).scalars()
    ]
    candidate_build_ids = _build_ids_for_heads(db, candidate_head_ids)
    for build_id in candidate_build_ids:
        lock_generation_owner_in_current_transaction(
            db, LlmCallOwner(kind="artifact_build", id=build_id)
        )
    locked_head_ids = [
        UUID(str(head_id))
        for head_id in db.execute(
            text("SELECT id FROM artifacts WHERE id = ANY(:head_ids) ORDER BY id FOR UPDATE"),
            {"head_ids": candidate_head_ids},
        ).scalars()
    ]
    if locked_head_ids != candidate_head_ids:
        raise TransactionRestart("Dossier cleanup head set changed")
    locked_build_ids = _build_ids_for_heads(db, locked_head_ids)
    if locked_build_ids != candidate_build_ids:
        raise TransactionRestart("Dossier cleanup build set changed")
    _lock_jobs_for_builds(db, locked_build_ids)
    return locked_head_ids


def _build_ids_for_heads(db: Session, head_ids: Sequence[UUID]) -> list[UUID]:
    if not head_ids:
        return []
    return [
        UUID(str(build_id))
        for build_id in db.execute(
            text("SELECT id FROM artifact_builds WHERE artifact_id = ANY(:head_ids) ORDER BY id"),
            {"head_ids": list(head_ids)},
        ).scalars()
    ]


def _lock_jobs_for_builds(db: Session, build_ids: Sequence[UUID]) -> dict[UUID, JobRow]:
    if not build_ids:
        return {}
    job_ids = [
        UUID(str(job_id))
        for job_id in db.execute(
            text(
                "SELECT id FROM background_jobs "
                "WHERE kind = :kind AND dedupe_key = ANY(:dedupe_keys) ORDER BY id FOR UPDATE"
            ),
            {
                "kind": _JOB_KIND,
                "dedupe_keys": [_dispatch_key(build_id) for build_id in build_ids],
            },
        ).scalars()
    ]
    jobs: dict[UUID, JobRow] = {}
    for job_id in job_ids:
        job = lock_job(db, job_id)
        if job is None:
            raise AssertionError(f"locked Dossier job {job_id} disappeared")
        build_id = UUID(str(job.payload.get("build_id")))
        jobs[build_id] = job
    return jobs


def _delete_heads(db: Session, head_ids: list[UUID]) -> None:
    from nexus.services.resource_graph.cleanup import delete_edges_for_deleted_resource

    build_ids = _build_ids_for_heads(db, head_ids)
    for build_id, job in _lock_jobs_for_builds(db, build_ids).items():
        state = step_journal.read_step_states(job).get(SYNTHESIS_STEP_PATH)
        if state is not None and state.dispatch_phase is step_journal.Uncertain:
            raise GenerationUncertain(
                f"cannot purge uncertain Dossier generation for build {build_id}"
            )
    for build_id in build_ids:
        if not _close_prepared_generation(
            db,
            owner=LlmCallOwner(kind="artifact_build", id=build_id),
            build_id=build_id,
            ctx=None,
        ):
            raise AssertionError("Dossier purge lost queue ownership")

    idea_subject_ids = [
        idea_subject_id
        for head_id in head_ids
        if (idea_subject_id := delete_artifact_idea_rows_before_head(db, artifact_id=head_id))
        is not None
    ]
    revision_ids = (
        [
            UUID(str(row[0]))
            for row in db.execute(
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
            kind=_JOB_KIND,
            dedupe_keys=[_dispatch_key(build_id) for build_id in build_ids],
        )
    # Clear the circular head pointer before deleting revisions.
    db.execute(
        text("UPDATE artifacts SET current_revision_id = NULL WHERE id = ANY(:ids)"),
        {"ids": head_ids},
    )
    for head_id in head_ids:
        delete_edges_for_deleted_resource(db, ref=ResourceRef(scheme="artifact", id=head_id))
    for revision_id in revision_ids:
        delete_edges_for_deleted_resource(
            db, ref=ResourceRef(scheme="artifact_revision", id=revision_id)
        )
    if build_ids:
        for table in (
            "artifact_build_events",
            "artifact_revisions",
            "artifact_build_failures",
            "artifact_build_cancellations",
        ):
            db.execute(text(f"DELETE FROM {table} WHERE build_id = ANY(:ids)"), {"ids": build_ids})
        db.execute(text("DELETE FROM artifact_builds WHERE id = ANY(:ids)"), {"ids": build_ids})
    db.execute(text("DELETE FROM artifacts WHERE id = ANY(:ids)"), {"ids": head_ids})
    for idea_subject_id in idea_subject_ids:
        delete_idea_subject_after_head(db, idea_subject_id=idea_subject_id)


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
    error_code: str | None
    payload: dict[str, object]


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
    return f"dossier_build:{build_id}"


def _running_claim_is_current(db: Session, ctx: JobExecutionContext) -> bool:
    return running_job_claim_is_current(
        db, job_id=ctx.job_id, worker_id=ctx.worker_id, attempt_no=ctx.attempt_no
    )


def _attempt_can_write(db: Session, *, build_id: UUID, ctx: JobExecutionContext) -> bool:
    return _running_claim_is_current(db, ctx) and _existing_terminal_child(db, build_id) is None


def _ensure_head_locked(
    db: Session, subject_scheme: str, subject_id: UUID, audience: AudienceScope
) -> UUID:
    """The locked head id for this key, inserting the head on first press."""
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


def _lock_head(db: Session, artifact_id: UUID) -> None:
    locked = db.execute(
        text("SELECT id FROM artifacts WHERE id = :id FOR UPDATE"), {"id": artifact_id}
    ).scalar_one_or_none()
    if locked is None:
        raise NotFoundError(ApiErrorCode.E_DOSSIER_NOT_FOUND, "Dossier not found")


def _visible_head(db: Session, *, artifact_id: UUID, viewer_id: UUID) -> tuple[_HeadRow, Subject]:
    """The head row and its resolved subject, 404-masked for this viewer."""
    head = _head_row(db, artifact_id)
    if head is None:
        raise NotFoundError(ApiErrorCode.E_DOSSIER_NOT_FOUND, "Dossier not found")
    subject = subjects.visible_persisted_subject(
        db,
        subject_scheme=head.subject_scheme,
        subject_id=head.subject_id,
        audience_scheme=head.audience_scheme,
        audience_id=head.audience_id,
        viewer_id=viewer_id,
    )
    if subject is None:
        raise NotFoundError(ApiErrorCode.E_DOSSIER_NOT_FOUND, "Dossier not found")
    return head, subject


def _no_terminal_child_sql(build_alias: str) -> str:
    """A build with no terminal child is the active one: there is no status column."""
    return " AND ".join(
        f"NOT EXISTS(SELECT 1 FROM {table} WHERE build_id = {build_alias}.id)"
        for table in (
            "artifact_revisions",
            "artifact_build_failures",
            "artifact_build_cancellations",
        )
    )


def _has_active_build(db: Session, head_id: UUID) -> bool:
    return bool(
        db.execute(
            text(
                "SELECT EXISTS(SELECT 1 FROM artifact_builds b "
                f"WHERE b.artifact_id = :h AND {_no_terminal_child_sql('b')})"
            ),
            {"h": head_id},
        ).scalar_one()
    )


def _existing_terminal_child(
    db: Session, build_id: UUID
) -> Literal["revision", "failure", "cancellation"] | None:
    """The build's single terminal child kind, or ``None`` while it is active."""
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
        raise AssertionError(f"build {build_id} has conflicting terminal children")
    if rev:
        return "revision"
    if fail:
        return "failure"
    if canc:
        return "cancellation"
    return None


def _lock_head_id_for_build(db: Session, build_id: UUID) -> UUID | None:
    """Lock and return the head owning ``build_id`` (``None`` once purged)."""
    row = db.execute(
        text(
            "SELECT a.id FROM artifacts a JOIN artifact_builds b ON b.artifact_id = a.id "
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
        current_revision_id=_optional_uuid(row["current_revision_id"]),
    )


def _audience_from_head(head: _HeadRow) -> AudienceScope:
    if head.audience_scheme == "library":
        return AudienceLibrary(library_id=UUID(head.audience_id))
    return AudienceUser(user_id=UUID(head.audience_id))


def _job_state(db: Session, build_id: UUID) -> _JobState | None:
    row = (
        db.execute(
            text(
                "SELECT status, attempts, error_code, payload "
                "FROM background_jobs WHERE dedupe_key = :k"
            ),
            {"k": _dispatch_key(build_id)},
        )
        .mappings()
        .first()
    )
    if row is None:
        return None
    return _JobState(
        status=str(row["status"]),
        attempts=int(row["attempts"]),
        error_code=(str(row["error_code"]) if row["error_code"] is not None else None),
        payload=row["payload"],
    )


def _capacity_pause(job: _JobState | None) -> CapacityPaused | None:
    """The one durable pre-admission pause parked on an active build's job."""
    if job is None or job.status == SUCCEEDED:
        return None
    return read_capacity_pauses(job.payload).get(SYNTHESIS_STEP_PATH)


def _admitted_generation(db: Session, build_id: UUID) -> AdmittedGeneration | None:
    """The build's latest admitted ledger generation, read without mutation."""
    record = read_latest_generation_for_owner(
        db, owner=LlmCallOwner(kind="artifact_build", id=build_id)
    )
    if record is None:
        return None
    return AdmittedGeneration(
        spec=read_generation_history(record.spec),
        tool_positions=len(read_tool_positions(db, generation_id=record.id)),
    )


def _execution_phase(job: _JobState | None) -> step_journal.DurableExecutionPhase:
    """Derive the unsequenced execution advisory from live queue state.

    A build may be observed before its enqueue lands, and a succeeded queue row
    may still be visible before the terminal child is read; both correlations
    are the dossier's, every other queue semantic is the shared kernel's.
    """
    if job is None or job.status == SUCCEEDED:
        return step_journal.DurableExecutionPhase.Queued
    return step_journal.project_execution_phase(
        job_status=job.status, attempts=job.attempts, error_code=job.error_code
    )


def _freshness(
    db: Session,
    *,
    binding: SubjectBinding,
    subject: Subject,
    audience: AudienceScope,
    current_revision_id: UUID | None,
) -> Literal["Current", "Stale"] | None:
    """Compare the current revision's stored manifest to the live inputs (no LLM)."""
    if current_revision_id is None:
        return None
    stored_raw = db.execute(
        text("SELECT input_manifest FROM artifact_revisions WHERE id = :r"),
        {"r": current_revision_id},
    ).scalar_one_or_none()
    if stored_raw is None:
        return None
    stored = _MANIFEST_ADAPTER.validate_python(stored_raw)
    try:
        live = binding.live_manifest(db, subject, audience)
    except DossierInputTooLarge:
        return "Stale"
    return "Current" if stored == live else "Stale"


def _append_build_event(
    db: Session,
    *,
    build_id: UUID,
    event_type: ArtifactBuildEventType,
    payload: dict,
) -> None:
    """Append one strict build event under the caller-held head lock.

    The sequence is allocated and inserted together, so no writer collides and
    the SSE client can resume from ``Last-Event-ID`` without losing a frame.
    """
    build = db.get(ArtifactBuild, build_id)
    if build is None:
        raise AssertionError(f"cannot append event for missing build {build_id}")
    run_kit.append_event(db, parent=build, event_type=event_type.value, payload=payload)


def _optional_uuid(value: object) -> UUID | None:
    return UUID(str(value)) if value is not None else None
