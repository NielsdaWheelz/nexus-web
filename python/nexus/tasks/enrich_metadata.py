"""Durable metadata enrichment through the private Codex-personal host."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Literal, assert_never
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, RootModel
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import FailureStage, Media, ProcessingStatus
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode, exception_error_detail
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    RescheduleRequested,
    current_dead_job_for_payload,
    get_job,
    lock_and_renew_running_job_claim,
    lock_jobs_for_payload,
    replace_dead_job_payload,
    requeue_dead_job,
)
from nexus.logging import get_logger
from nexus.schemas.presence import Presence, Present, absent, present
from nexus.services.codex_generation_contract import (
    GenerationTerminal,
    NormalizedFailureCode,
    normalized_failure,
    retained_terminal_error_detail,
)
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_all_collection_families,
)
from nexus.services.contributors import (
    MediaTarget,
    apply_observed_role_slices_in_current_transaction,
)
from nexus.services.durable_step_journal import (
    Completed,
    Prepared,
    ProveNotDispatched,
    StepReplayState,
    Uncertain,
    checkpoint_step_state,
    decode_step_result,
    encode_step_result,
    payload_with_step_state,
    read_step_states,
    stable_generation_id,
)
from nexus.services.generation_intent import GenerationIntent, JsonSchemaOutput
from nexus.services.generation_spec import (
    GenerationSpec,
    ImmutablePromptPayloadRef,
    decode_generation_spec_document,
    generation_fact_digest,
)
from nexus.services.llm_execution import (
    AcceptedGenerationFailure,
    CompletedGeneration,
    EncodedGenerationTerminal,
    ExecutionRuntime,
    GenerationAdmissionInputsChanged,
    GenerationDispatchAborted,
    GenerationUncertain,
    GenerationUncertainResolution,
    JobGenerationJournal,
    admit_job_generation,
    codex_terminal_evidence,
    execute_generation,
    prove_uncertain_generation_not_dispatched_in_current_transaction,
)
from nexus.services.llm_ledger import (
    LlmCallOwner,
    lock_generation_owner_in_current_transaction,
)
from nexus.services.metadata_dispatch import METADATA_STEP_PATH
from nexus.services.metadata_enrichment import (
    MetadataEnrichmentOutput,
    build_enrichment_user_content,
    get_content_sample,
    merge_enrichment,
    metadata_enrichment_agent_definition,
    validate_structured_enrichment,
)
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task

logger = get_logger(__name__)

_MAX_ERROR_DETAIL_LENGTH = 1000
_LEASE_SECONDS = 300
_PRE_DISPATCH_SOURCE_CHANGED_DETAIL = "metadata request fingerprint changed before dispatch"
_PRE_DISPATCH_MEDIA_MISSING_DETAIL = "metadata media no longer exists before dispatch"
_PRE_DISPATCH_NOT_READY_DETAIL = "metadata media is no longer ready before dispatch"
_READY_STATES = frozenset(
    {
        ProcessingStatus.pending,
        ProcessingStatus.ready_for_reading,
    }
)
_COLLECTION_FAMILIES = (
    CollectionFamily.AuthorWorks,
    CollectionFamily.LibraryEntries,
    CollectionFamily.PodcastEpisodes,
    CollectionFamily.PodcastSubscriptions,
)
_METADATA_TASK_SPEC = LlmTaskSpec(label="metadata_generation")


class _ResultModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class _SuccessfulPublication(_ResultModel):
    """Strict queue result of one applied metadata publication."""

    kind: Literal["success"] = "success"
    fields: Annotated[tuple[str, ...], Field(min_length=1)]


class _FailedPublication(_ResultModel):
    """Strict queue result of one publication that recorded a media warning."""

    kind: Literal["failed"] = "failed"
    reason: str
    error_code: str


class _SkippedPublication(_ResultModel):
    """Strict queue result of one publication that found no applicable media."""

    kind: Literal["skipped"] = "skipped"
    reason: str


type _MetadataPublicationResult = Annotated[
    _SuccessfulPublication | _FailedPublication | _SkippedPublication,
    Field(discriminator="kind"),
]
type _PreDispatchTerminalReason = Literal["source_changed", "media_not_found", "not_ready"]


class _CompletedSuccess(_ResultModel):
    """Strict replay memo of one accepted metadata generation."""

    kind: Literal["success"] = "success"
    enrichment: MetadataEnrichmentOutput
    publication_result: Presence[_MetadataPublicationResult]


class _CompletedFailure(_ResultModel):
    """Strict replay memo of one metadata generation's bounded failure facts."""

    kind: Literal["failed"] = "failed"
    error_code: str
    error_detail: str
    publication_result: Presence[_MetadataPublicationResult]


class _CompletedSkip(_ResultModel):
    """Strict replay memo of work made inapplicable before native dispatch."""

    kind: Literal["skipped"] = "skipped"
    publication_result: Present[_SkippedPublication]


type _CompletedMetadataResult = Annotated[
    _CompletedSuccess | _CompletedFailure | _CompletedSkip,
    Field(discriminator="kind"),
]


class _CompletedMetadataResultEnvelope(RootModel[_CompletedMetadataResult]):
    model_config = ConfigDict(frozen=True)


class _UncertainMetadataTurn(RuntimeError):
    """A billed-once native turn may have executed and cannot be redispatched."""

    error_code = ApiErrorCode.E_GENERATION_UNCERTAIN


class _PreDispatchMetadataTerminal(RuntimeError):
    """Domain state became inapplicable while the dispatch rows were locked."""

    def __init__(self, reason: _PreDispatchTerminalReason) -> None:
        super().__init__(reason)
        self.reason: _PreDispatchTerminalReason = reason


def reconcile_uncertain_metadata_generation(
    db: Session,
    *,
    media_id: UUID,
    resolution: GenerationUncertainResolution,
) -> None:
    """Return one suspended metadata generation to Prepared and requeue it.

    The metadata job persists a request fingerprint but intentionally never
    stores its source-derived prompt.  That is enough to prove no dispatch
    against the ledger start, but not enough to reconstruct an exact command
    after mutable media facts may have changed; attachment is therefore
    rejected rather than re-reading those facts.
    """

    if not isinstance(resolution, ProveNotDispatched):
        raise ValueError(
            "metadata generation attachment requires an exact durable command, which is absent"
        )

    def op() -> None:
        owner = LlmCallOwner(kind="media_enrichment", id=media_id)
        # Canonical order: owner advisory lock, domain row, then suspended job.
        lock_generation_owner_in_current_transaction(db, owner)
        db.scalar(select(Media).where(Media.id == media_id).with_for_update())
        job = current_dead_job_for_payload(
            db,
            kind="enrich_metadata",
            expected_payload_match={"media_id": str(media_id)},
        )
        if job is None:
            raise ValueError("metadata media has no suspended generation job")
        state = read_step_states(job).get(METADATA_STEP_PATH)
        if state is None or state.dispatch_phase is not Uncertain:
            raise ValueError("metadata generation is not uncertain")
        generation_id = stable_generation_id(job.id, METADATA_STEP_PATH)
        request_fingerprint = _persisted_request_fingerprint(
            state,
            generation_id=generation_id,
        )
        next_state = prove_uncertain_generation_not_dispatched_in_current_transaction(
            db,
            owner=owner,
            state=state,
        )
        if next_state.request_fingerprint != present(request_fingerprint):
            raise AssertionError("metadata reconciliation changed request identity")
        payload = payload_with_step_state(
            job.payload,
            step_path=METADATA_STEP_PATH,
            state=next_state,
        )
        if not replace_dead_job_payload(db, job_id=job.id, payload=payload):
            raise AssertionError("suspended metadata job changed while locked")
        if not requeue_dead_job(db, job_id=job.id):
            raise AssertionError("suspended metadata job could not be requeued")
        db.commit()

    retry_serializable(db, "reconcile_uncertain_metadata_generation", op)


def _metadata_generation_intent(*, input: str) -> GenerationIntent:
    instructions, output_schema = metadata_enrichment_agent_definition()
    return GenerationIntent(
        instructions=instructions,
        input=input,
        output=JsonSchemaOutput.model_validate(
            {
                "kind": "JsonSchema",
                "name": "media_metadata_enrichment",
                "schema": output_schema,
                "strict": True,
            }
        ),
    )


def _failed_result(*, error_code: ApiErrorCode, detail: str) -> _CompletedFailure:
    return _CompletedFailure(
        error_code=error_code.value,
        error_detail=detail[:_MAX_ERROR_DETAIL_LENGTH],
        publication_result=absent(),
    )


def _job_result(result: _MetadataPublicationResult) -> dict[str, object]:
    """Serialize one publication outcome as a status-keyed job result.

    Every handler return routes through here, so exactly one discriminant
    (``status``) ever appears in ``background_jobs.result``. Its success value
    is ``"success"``, matching the rest of the media pipeline
    (``media_source_ingest``, the pdf/epub lifecycles, ``web_article_ingest``,
    ``youtube_video_ingest``) -- not the queue row's own ``succeeded`` status.
    """
    match result:
        case _SuccessfulPublication():
            return {
                "status": "success",
                "fields": list(result.fields),
            }
        case _FailedPublication():
            return {
                "status": "failed",
                "reason": result.reason,
                "error_code": result.error_code,
            }
        case _SkippedPublication():
            return {"status": "skipped", "reason": result.reason}
        case _ as unreachable:
            assert_never(unreachable)


def _record_metadata_failure(media: Media, error_code: str, error_message: str) -> None:
    if media.processing_status == ProcessingStatus.failed:
        return
    media.failure_stage = FailureStage.metadata
    media.last_error_code = error_code
    media.last_error_message = error_message[:_MAX_ERROR_DETAIL_LENGTH]
    media.updated_at = datetime.now(UTC)


def enrich_metadata(
    media_id: str,
    request_id: str | None,
    *,
    context: JobExecutionContext,
) -> dict[str, object] | RescheduleRequested:
    """Run or replay the one billed-once ``codex/metadata`` step."""
    media_uuid = UUID(media_id)
    factory = get_session_factory()
    logger.info("enrich_metadata_started", media_id=media_id, request_id=request_id)

    with factory() as db:
        job = get_job(db, context.job_id)
        if job is None:
            # justify-defect: the worker holds this claimed row; only unpruned
            # terminal transitions could remove it mid-attempt.
            raise AssertionError(f"metadata job {context.job_id} disappeared")
        generation_id = stable_generation_id(context.job_id, METADATA_STEP_PATH)
        state = read_step_states(job).get(METADATA_STEP_PATH)
        request_fingerprint: str | None = None
        if state is not None:
            request_fingerprint = _persisted_request_fingerprint(
                state,
                generation_id=generation_id,
            )
            if state.dispatch_phase is Completed:
                if not isinstance(state.terminal_result, Present):
                    # justify-defect: StepReplayState's own validator forbids a
                    # Completed phase without a terminal result.
                    raise AssertionError("Completed metadata step has no terminal result")
                completed = decode_step_result(
                    state.terminal_result.value,
                    _CompletedMetadataResultEnvelope,
                ).root
                db.commit()
                return _publish_completed(
                    factory,
                    context=context,
                    media_id=media_uuid,
                    request_fingerprint=request_fingerprint,
                    completed=completed,
                )
            if state.dispatch_phase is Uncertain:
                db.commit()
                raise _UncertainMetadataTurn(
                    f"metadata job {context.job_id} has an unresolved generation"
                )
            if state.dispatch_phase is not Prepared:
                # justify-defect: DispatchPhase is a closed three-member enum
                # and the two other phases returned above.
                raise AssertionError(f"unknown metadata dispatch phase {state.dispatch_phase!r}")

        media = db.get(Media, media_uuid)
        if media is None:
            db.commit()
            if state is not None:
                if request_fingerprint is None:
                    # justify-defect: every Prepared checkpoint has the request
                    # fingerprint required to terminalize its optional turn.
                    raise AssertionError("Prepared metadata step has no request fingerprint")
                return _complete_pre_dispatch_terminal(
                    factory,
                    context=context,
                    media_id=media_uuid,
                    generation_id=generation_id,
                    request_fingerprint=request_fingerprint,
                    observed_reason="media_not_found",
                )
            return _job_result(_SkippedPublication(reason="media_not_found"))
        if media.processing_status not in _READY_STATES:
            db.commit()
            if state is not None:
                if request_fingerprint is None:
                    # justify-defect: every Prepared checkpoint has the request
                    # fingerprint required to terminalize its optional turn.
                    raise AssertionError("Prepared metadata step has no request fingerprint")
                return _complete_pre_dispatch_terminal(
                    factory,
                    context=context,
                    media_id=media_uuid,
                    generation_id=generation_id,
                    request_fingerprint=request_fingerprint,
                    observed_reason="not_ready",
                )
            return _job_result(_SkippedPublication(reason="not_ready"))

        user_content = build_enrichment_user_content(
            db,
            media,
            get_content_sample(db, media),
        )
        intent = _metadata_generation_intent(input=user_content)
        db.commit()

    owner = LlmCallOwner(kind="media_enrichment", id=media_uuid)

    def lock_dispatch(db: Session) -> JobRow | None:
        """Lock metadata domain rows after the shared owner advisory lock."""

        locked_media = db.scalar(select(Media).where(Media.id == media_uuid).with_for_update())
        jobs = lock_jobs_for_payload(
            db,
            kind="enrich_metadata",
            expected_payload_match={"media_id": str(media_uuid)},
        )
        locked_job = next(
            (candidate for candidate in jobs if candidate.id == context.job_id),
            None,
        )
        if locked_job is None:
            raise AssertionError(f"metadata job {context.job_id} disappeared before dispatch")
        if any(
            candidate.id != context.job_id
            and (other_state := read_step_states(candidate).get(METADATA_STEP_PATH)) is not None
            and other_state.dispatch_phase is Uncertain
            for candidate in jobs
        ):
            raise _UncertainMetadataTurn(f"media {media_uuid} already has an unresolved generation")
        if locked_media is None:
            raise _PreDispatchMetadataTerminal("media_not_found")
        if locked_media.processing_status not in _READY_STATES:
            raise _PreDispatchMetadataTerminal("not_ready")
        locked_content = build_enrichment_user_content(
            db,
            locked_media,
            get_content_sample(db, locked_media),
        )
        locked_intent = _metadata_generation_intent(input=locked_content)
        if locked_intent != intent:
            raise _PreDispatchMetadataTerminal("source_changed")
        return locked_job

    journal = JobGenerationJournal(
        context=context,
        step_path=METADATA_STEP_PATH,
        lock_dispatch=lock_dispatch,
    )

    async def execute(
        _db: Session,
        runtime: ExecutionRuntime,
    ) -> CompletedGeneration | RescheduleRequested:
        from nexus.services import generation_policy

        nonlocal request_fingerprint
        execution_request = await admit_job_generation(
            owner=owner,
            generation_id=generation_id,
            operation="metadata_enrichment",
            intent=intent,
            prompt_template_revision=generation_policy.operation_revision("metadata_enrichment"),
            prompt_payload_ref=ImmutablePromptPayloadRef(
                owner_kind="media_enrichment",
                owner_id=str(media_uuid),
                revision=generation_policy.operation_revision("metadata_enrichment"),
                payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
            ),
            journal=journal,
            session_factory=factory,
            runtime=runtime,
        )
        request_fingerprint = execution_request.spec.fingerprint
        return await execute_generation(
            execution_request,
            session_factory=factory,
            runtime=runtime,
            encode_terminal=lambda terminal: _encode_metadata_terminal(
                codex_terminal_evidence(terminal)
            ),
            encode_preaccept_failure=_encode_metadata_preaccept_failure,
        )

    try:
        execution_result = run_llm_task(_METADATA_TASK_SPEC, execute)
    except _PreDispatchMetadataTerminal as exc:
        if request_fingerprint is None:
            return _job_result(_SkippedPublication(reason=exc.reason))
        return _complete_pre_dispatch_terminal(
            factory,
            context=context,
            media_id=media_uuid,
            generation_id=generation_id,
            request_fingerprint=request_fingerprint,
            observed_reason=exc.reason,
        )
    except GenerationDispatchAborted:
        return _job_result(_SkippedPublication(reason="claim_lost_before_dispatch"))
    except GenerationAdmissionInputsChanged as error:
        if request_fingerprint is None:
            raise AssertionError("changed metadata admission has no frozen fingerprint") from error
        return _complete_pre_dispatch_terminal(
            factory,
            context=context,
            media_id=media_uuid,
            generation_id=generation_id,
            request_fingerprint=request_fingerprint,
            observed_reason="source_changed",
        )
    except GenerationUncertain as exc:
        raise _UncertainMetadataTurn(exception_error_detail(exc)) from exc

    if isinstance(execution_result, RescheduleRequested):
        return execution_result
    if request_fingerprint is None:
        raise AssertionError("completed metadata dispatch has no frozen fingerprint")
    completed = decode_step_result(
        execution_result.terminal_result,
        _CompletedMetadataResultEnvelope,
    ).root
    return _publish_completed(
        factory,
        context=context,
        media_id=media_uuid,
        request_fingerprint=request_fingerprint,
        completed=completed,
    )


def _complete_pre_dispatch_terminal(
    factory: sessionmaker[Session],
    *,
    context: JobExecutionContext,
    media_id: UUID,
    generation_id: UUID,
    request_fingerprint: str,
    observed_reason: _PreDispatchTerminalReason,
) -> dict[str, object]:
    """Atomically finish one Prepared retry that became inapplicable."""
    with factory() as db:
        owner = LlmCallOwner(kind="media_enrichment", id=media_id)
        # One canonical order across dispatch, retry, publication, and this
        # early terminal: ledger owner -> media -> queue rows. The ledger's
        # completion acquisition below is therefore a reentrant no-op.
        lock_generation_owner_in_current_transaction(db, owner)
        media = db.scalar(select(Media).where(Media.id == media_id).with_for_update())
        jobs = lock_jobs_for_payload(
            db,
            kind="enrich_metadata",
            expected_payload_match={"media_id": str(media_id)},
        )
        job = next((candidate for candidate in jobs if candidate.id == context.job_id), None)
        if job is None:
            # justify-defect: the claimed row's payload cannot change between
            # the Prepared observation and this terminal transaction.
            raise AssertionError(
                f"metadata job {context.job_id} disappeared before pre-dispatch terminal"
            )
        if any(
            candidate.id != context.job_id
            and (other_state := read_step_states(candidate).get(METADATA_STEP_PATH)) is not None
            and other_state.dispatch_phase is Uncertain
            for candidate in jobs
        ):
            raise _UncertainMetadataTurn(f"media {media_id} already has an unresolved generation")
        result = _stage_pre_dispatch_terminal(
            db,
            owner=owner,
            context=context,
            job=job,
            media=media,
            generation_id=generation_id,
            request_fingerprint=request_fingerprint,
            observed_reason=observed_reason,
        )
        db.commit()
        return _job_result(result)


def _stage_pre_dispatch_terminal(
    db: Session,
    *,
    owner: LlmCallOwner,
    context: JobExecutionContext,
    job: JobRow,
    media: Media | None,
    generation_id: UUID,
    request_fingerprint: str,
    observed_reason: _PreDispatchTerminalReason,
) -> _MetadataPublicationResult:
    """Stage audit, domain publication, and replay result in one transaction."""
    current = read_step_states(job).get(METADATA_STEP_PATH)
    if current is None or current.dispatch_phase is not Prepared:
        # justify-defect: only a lease-owned Prepared step may become a known
        # pre-dispatch terminal.
        raise AssertionError("metadata pre-dispatch terminal requires the Prepared checkpoint")
    if _persisted_request_fingerprint(current, generation_id=generation_id) != request_fingerprint:
        # justify-defect: a replay-stable generation cannot change identity
        # while its owner and queue rows are locked.
        raise AssertionError("metadata pre-dispatch terminal request fingerprint changed")

    reason: _PreDispatchTerminalReason
    if media is None:
        reason = "media_not_found"
    elif media.processing_status not in _READY_STATES:
        reason = "not_ready"
    else:
        reason = observed_reason

    match reason:
        case "source_changed":
            code = ApiErrorCode.E_GENERATION_SOURCE_CHANGED.value
            result: _MetadataPublicationResult = _FailedPublication(
                reason="source_changed",
                error_code=code,
            )
            completed: _CompletedMetadataResult = _CompletedFailure(
                error_code=code,
                error_detail=_PRE_DISPATCH_SOURCE_CHANGED_DETAIL,
                publication_result=Present[_MetadataPublicationResult](value=result),
            )
            if media is None:
                # justify-defect: reason resolution above selects
                # media_not_found before source_changed.
                raise AssertionError("source-changed terminal has no media")
            _record_metadata_failure(media, code, _PRE_DISPATCH_SOURCE_CHANGED_DETAIL)
            bump_all_collection_families(db, families=_COLLECTION_FAMILIES)
        case "media_not_found":
            result = _SkippedPublication(reason="media_not_found")
            completed = _CompletedSkip(
                publication_result=Present[_SkippedPublication](value=result),
            )
        case "not_ready":
            result = _SkippedPublication(reason="not_ready")
            completed = _CompletedSkip(
                publication_result=Present[_SkippedPublication](value=result),
            )
        case _ as unreachable:
            assert_never(unreachable)

    # Prepared is now strictly pre-admission: parent/child rows and Uncertain
    # land atomically, so this known terminal cannot coexist with a model call.
    if not checkpoint_step_state(
        db,
        ctx=context,
        job=job,
        step_path=METADATA_STEP_PATH,
        state=StepReplayState(
            generation_id=generation_id,
            dispatch_phase=Completed,
            request_fingerprint=present(request_fingerprint),
            terminal_result=present(encode_step_result(completed)),
        ),
    ):
        db.rollback()
        raise _UncertainMetadataTurn(
            f"metadata job {context.job_id} lost its claim before pre-dispatch terminal"
        )
    return result


def _normalize_terminal(
    terminal: GenerationTerminal,
) -> _CompletedMetadataResult:
    match terminal.status:
        case "succeeded":
            validated = validate_structured_enrichment(terminal.structured_output)
            if validated is None:
                return _failed_result(
                    error_code=ApiErrorCode.E_GENERATION_INVALID_OUTPUT,
                    detail="generation returned metadata outside the domain output contract",
                )
            if not validated.model_dump(exclude_none=True):
                return _failed_result(
                    error_code=ApiErrorCode.E_GENERATION_INVALID_OUTPUT,
                    detail="generation returned no confident metadata fields",
                )
            return _CompletedSuccess(
                enrichment=validated,
                publication_result=absent(),
            )
        case "cancelled":
            return _failed_result(
                error_code=ApiErrorCode.E_GENERATION_CANCELLED,
                detail="metadata generation was cancelled",
            )
        case "failed":
            if terminal.failure is None:
                # justify-defect: the wire contract's own validator requires a
                # typed failure on every failed terminal.
                raise AssertionError("failed generation terminal has no typed failure")
            domain_code = _failure_code(normalized_failure(terminal.failure.kind))
            detail = retained_terminal_error_detail(terminal)
            if detail is None:
                raise AssertionError("failed generation terminal has no retained detail")
            return _failed_result(error_code=domain_code, detail=detail)
        case _ as unreachable:
            assert_never(unreachable)


def _failure_code(kind: NormalizedFailureCode) -> ApiErrorCode:
    match kind:
        case "quota":
            return ApiErrorCode.E_GENERATION_QUOTA
        case "timeout":
            return ApiErrorCode.E_GENERATION_TIMEOUT
        case "invalid_output":
            return ApiErrorCode.E_GENERATION_INVALID_OUTPUT
        case "output_limit":
            return ApiErrorCode.E_GENERATION_OUTPUT_LIMIT
        case "context_too_large":
            return ApiErrorCode.E_GENERATION_CONTEXT_TOO_LARGE
        case "auth":
            return ApiErrorCode.E_GENERATION_AUTH
        case "runtime_unavailable":
            return ApiErrorCode.E_GENERATION_RUNTIME_UNAVAILABLE
        case "policy_violation":
            return ApiErrorCode.E_GENERATION_POLICY_VIOLATION
        case "capacity_unavailable":
            return ApiErrorCode.E_GENERATION_CAPACITY_UNAVAILABLE
        case _ as unreachable:
            assert_never(unreachable)


def _encode_metadata_terminal(terminal: GenerationTerminal) -> EncodedGenerationTerminal:
    completed = _normalize_terminal(terminal)
    accepted_failure = (
        AcceptedGenerationFailure(
            code="invalid_output",
            detail=completed.error_detail,
        )
        if terminal.status == "succeeded" and isinstance(completed, _CompletedFailure)
        else None
    )
    return EncodedGenerationTerminal(
        terminal_result=encode_step_result(completed),
        accepted_failure=accepted_failure,
    )


def _encode_metadata_preaccept_failure(
    code: NormalizedFailureCode,
    detail: str,
) -> str:
    return encode_step_result(_failed_result(error_code=_failure_code(code), detail=detail))


def _publish_completed(
    factory: sessionmaker[Session],
    *,
    context: JobExecutionContext,
    media_id: UUID,
    request_fingerprint: str,
    completed: _CompletedMetadataResult,
) -> dict[str, object]:
    db = factory()
    try:
        return retry_serializable(
            db,
            "metadata_enrichment.publish",
            lambda: _publish_completed_transaction(
                db,
                context=context,
                media_id=media_id,
                request_fingerprint=request_fingerprint,
                completed=completed,
            ),
        )
    finally:
        db.close()


def _publish_completed_transaction(
    db: Session,
    *,
    context: JobExecutionContext,
    media_id: UUID,
    request_fingerprint: str,
    completed: _CompletedMetadataResult,
) -> dict[str, object]:
    # Media row before queue rows: dispatch and the manual-retry lifecycle
    # both lock media first and job rows second, so publication must follow
    # the same canonical order or the two sides deadlock.
    media = db.scalar(select(Media).where(Media.id == media_id).with_for_update())
    if (
        lock_and_renew_running_job_claim(
            db,
            context=context,
            lease_seconds=_LEASE_SECONDS,
        )
        is None
    ):
        db.rollback()
        return _job_result(_SkippedPublication(reason="claim_lost_before_publication"))
    job = get_job(db, context.job_id)
    if job is None:
        raise AssertionError("metadata job disappeared after renewing its claim")

    if isinstance(completed.publication_result, Present):
        db.commit()
        return _job_result(completed.publication_result.value)
    if isinstance(completed, _CompletedSkip):
        # justify-defect: _CompletedSkip's schema requires a Present published
        # result, so the common replay branch above must always consume it.
        raise AssertionError("completed metadata skip has no published result")

    if media is None:
        return _commit_publication_result(
            db,
            context=context,
            completed=completed,
            result=_SkippedPublication(reason="media_not_found"),
        )
    if media.processing_status not in _READY_STATES:
        return _commit_publication_result(
            db,
            context=context,
            completed=completed,
            result=_SkippedPublication(reason="not_ready"),
        )

    if isinstance(completed, _CompletedFailure):
        if not (
            media.failure_stage == FailureStage.metadata
            and media.last_error_code == completed.error_code
            and media.last_error_message == completed.error_detail
        ):
            _record_metadata_failure(media, completed.error_code, completed.error_detail)
            bump_all_collection_families(db, families=_COLLECTION_FAMILIES)
        return _commit_publication_result(
            db,
            context=context,
            completed=completed,
            result=_FailedPublication(
                reason="agent_terminal",
                error_code=completed.error_code,
            ),
        )

    current_content = build_enrichment_user_content(
        db,
        media,
        get_content_sample(db, media),
    )
    frozen_spec, frozen_intent = _metadata_admission_from_job(job)
    current_intent = _metadata_generation_intent(input=current_content)
    if frozen_spec.fingerprint != request_fingerprint or frozen_intent != current_intent:
        code = ApiErrorCode.E_GENERATION_SOURCE_CHANGED.value
        detail = "media facts changed before metadata publication"
        _record_metadata_failure(media, code, detail)
        bump_all_collection_families(db, families=_COLLECTION_FAMILIES)
        return _commit_publication_result(
            db,
            context=context,
            completed=completed,
            result=_FailedPublication(
                reason="source_changed",
                error_code=code,
            ),
        )

    merge_result = merge_enrichment(db, media, completed.enrichment)
    if not merge_result.accepted_fields:
        code = ApiErrorCode.E_GENERATION_INVALID_OUTPUT.value
        detail = "generation returned no applicable metadata fields"
        _record_metadata_failure(media, code, detail)
        bump_all_collection_families(db, families=_COLLECTION_FAMILIES)
        return _commit_publication_result(
            db,
            context=context,
            completed=completed,
            result=_FailedPublication(
                reason="no_applicable_fields",
                error_code=code,
            ),
        )

    apply_observed_role_slices_in_current_transaction(
        db,
        target=MediaTarget(media.id),
        observation=merge_result.author_observation,
        source="metadata_enrichment",
    )
    if media.failure_stage == FailureStage.metadata:
        media.failure_stage = None
        media.last_error_code = None
        media.last_error_message = None
    bump_all_collection_families(db, families=_COLLECTION_FAMILIES)
    result = _success_result(merge_result.accepted_fields)
    persisted = _commit_publication_result(
        db,
        context=context,
        completed=completed,
        result=result,
    )
    logger.info(
        "enrich_metadata_completed",
        media_id=str(media.id),
        fields_enriched=list(merge_result.accepted_fields),
    )
    return persisted


def _commit_publication_result(
    db: Session,
    *,
    context: JobExecutionContext,
    completed: _CompletedMetadataResult,
    result: _MetadataPublicationResult,
) -> dict[str, object]:
    _checkpoint_published(
        db,
        context=context,
        completed=completed,
        publication_result=result,
    )
    db.commit()
    return _job_result(result)


def _checkpoint_published(
    db: Session,
    *,
    context: JobExecutionContext,
    completed: _CompletedMetadataResult,
    publication_result: _MetadataPublicationResult,
) -> None:
    job = get_job(db, context.job_id)
    if job is None:
        # justify-defect: the worker holds this claimed row; only unpruned
        # terminal transitions could remove it mid-attempt.
        raise AssertionError(f"metadata job {context.job_id} disappeared at publication")
    current = read_step_states(job).get(METADATA_STEP_PATH)
    if current is None or current.dispatch_phase is not Completed:
        # justify-defect: publication replays only from a durably Completed
        # step; no path un-completes a step.
        raise AssertionError("metadata publication requires the Completed checkpoint")
    # Parametrize the present variant with the full result union so the memo's
    # serializer sees the exact declared field type.
    published = completed.model_copy(
        update={
            "publication_result": Present[_MetadataPublicationResult](value=publication_result),
        }
    )
    if not checkpoint_step_state(
        db,
        ctx=context,
        job=job,
        step_path=METADATA_STEP_PATH,
        state=StepReplayState(
            generation_id=current.generation_id,
            dispatch_phase=Completed,
            request_fingerprint=current.request_fingerprint,
            terminal_result=present(encode_step_result(published)),
        ),
    ):
        raise _UncertainMetadataTurn(
            f"metadata job {context.job_id} lost its claim before publication"
        )


def _success_result(fields: tuple[str, ...] | list[str]) -> _SuccessfulPublication:
    return _SuccessfulPublication(fields=tuple(fields))


def _metadata_admission_from_job(job: JobRow) -> tuple[GenerationSpec, GenerationIntent]:
    raw_admissions = job.payload.get("generation_admissions")
    if not isinstance(raw_admissions, dict):
        raise AssertionError("metadata job has no frozen generation admissions")
    raw = raw_admissions.get(METADATA_STEP_PATH)
    if not isinstance(raw, dict) or set(raw) != {"spec", "intent"}:
        raise AssertionError("metadata job has no exact frozen generation admission")
    spec = decode_generation_spec_document(raw["spec"])
    raw_intent = raw["intent"]
    if not isinstance(raw_intent, dict):
        raise AssertionError("metadata generation intent is not an object")
    return spec, GenerationIntent.model_validate(raw_intent)


def _persisted_request_fingerprint(
    state: StepReplayState,
    *,
    generation_id: UUID,
) -> str:
    # justify-defect: the generation id is a pure function of job id and step
    # path, so a persisted mismatch is corruption.
    if state.generation_id != generation_id:
        raise AssertionError("metadata generation identity changed on replay")
    if not isinstance(state.request_fingerprint, Present):
        # justify-defect: every checkpoint writer persists the fingerprint
        # (StepReplayState's validator requires it).
        raise AssertionError("metadata replay state has no request fingerprint")
    return state.request_fingerprint.value
