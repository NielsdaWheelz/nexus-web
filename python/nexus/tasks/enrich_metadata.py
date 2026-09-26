"""The durable metadata enrichment turn on the ``codex/metadata`` step.

One billed-once, tool-using generation per job: Prepared, then Uncertain
immediately before dispatch, then Completed with a normalized memo. A Completed
replay re-applies the memo's publication; an Uncertain replay is operator-owned.
Dispatch, the pre-dispatch terminal and publication all take the same locks in
the same order — generation owner, media, queue rows — because the retry route
and this worker run concurrently.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Literal, assert_never
from uuid import UUID

from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session, defer, sessionmaker

from nexus.auth.permissions import can_read_media
from nexus.db.models import ContentIndexState, FailureStage, Media, ProcessingStatus
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode, exception_error_detail
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    RescheduleRequested,
    get_job,
    lock_and_renew_running_job_claim,
    lock_jobs_for_payload,
)
from nexus.logging import get_logger
from nexus.schemas.presence import Present, present
from nexus.services import durable_step_journal as step_journal
from nexus.services.collection_revisions import (
    ENTRY_VISIBILITY_FAMILIES,
    bump_all_collection_families,
)
from nexus.services.contributor_writes import MediaTarget
from nexus.services.contributors import apply_observed_role_slices_in_current_transaction
from nexus.services.durable_step_journal import Completed, Prepared, StepReplayState, Uncertain
from nexus.services.generation_backend import BackendTerminal, BackendToolExecutor
from nexus.services.generation_spec import (
    FrozenToolScope,
    GenerationIntent,
    GenerationSpec,
    ImmutablePromptPayloadRef,
    JsonSchemaOutput,
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
    GenerationFailureCode,
    GenerationUncertain,
    JobGenerationJournal,
    StructuredTerminalCancelled,
    StructuredTerminalFailure,
    StructuredTerminalOutcome,
    StructuredTerminalSuccess,
    admit_job_generation,
    execute_generation,
    structured_terminal_outcome,
)
from nexus.services.llm_ledger import LlmCallOwner, lock_generation_owner_in_current_transaction
from nexus.services.media_processing_state import is_metadata_enrichment_eligible
from nexus.services.metadata_dispatch import METADATA_STEP_PATH
from nexus.services.metadata_enrichment import (
    MetadataEnrichmentOutput,
    build_enrichment_user_content,
    get_content_sample,
    merge_enrichment,
    metadata_enrichment_agent_definition,
    validate_structured_enrichment,
)
from nexus.services.reader_publication import (
    lock_publication_generation,
    read_publication_generation,
)
from nexus.services.tool_authority import DeferredGenerationToolExecutor
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task

logger = get_logger(__name__)

_MAX_ERROR_DETAIL_LENGTH = 1000
_LEASE_SECONDS = 300
_TASK = LlmTaskSpec(label="metadata_generation")

type _TerminalReason = Literal["source_changed", "media_not_found", "not_ready"]
# One publication outcome, with exactly one `status` discriminant. Its success
# value matches the rest of the media pipeline, not the queue row's own status.
type _JobResult = dict[str, str]


class _Memo(BaseModel):
    """The durable replay memo of one metadata turn and its publication."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    kind: Literal["success", "failed", "skipped"]
    enrichment: MetadataEnrichmentOutput | None = None
    error_code: str = ""
    error_detail: str = ""
    published: _JobResult | None = None


class _UncertainMetadataTurn(RuntimeError):
    """A billed-once native turn may have executed and cannot be redispatched."""

    error_code = ApiErrorCode.E_GENERATION_UNCERTAIN


class _PreDispatchTerminal(RuntimeError):
    """Domain state became inapplicable while the dispatch rows were locked."""

    def __init__(self, reason: _TerminalReason) -> None:
        super().__init__(reason)
        self.reason: _TerminalReason = reason


def enrich_metadata(
    media_id: str,
    request_id: str | None,
    *,
    requester_user_id: UUID,
    context: JobExecutionContext,
) -> _JobResult | RescheduleRequested:
    """Run or replay the one billed-once ``codex/metadata`` step."""
    media_uuid = UUID(media_id)
    factory = get_session_factory()
    generation_id = step_journal.stable_generation_id(context.job_id, METADATA_STEP_PATH)
    logger.info("enrich_metadata_started", media_id=media_id, request_id=request_id)

    def terminalize(reason: _TerminalReason, fingerprint: str) -> _JobResult:
        return _terminalize_prepared(
            factory,
            context=context,
            media_id=media_uuid,
            generation_id=generation_id,
            request_fingerprint=fingerprint,
            observed_reason=reason,
        )

    with factory() as db:
        job = get_job(db, context.job_id)
        if job is None:
            raise AssertionError(f"metadata job {context.job_id} disappeared")
        state = step_journal.read_step_states(job).get(METADATA_STEP_PATH)
        request_fingerprint = None if state is None else _request_fingerprint(state)
        if state is not None and state.dispatch_phase is Uncertain:
            db.commit()
            raise _UncertainMetadataTurn(
                f"metadata job {context.job_id} has an unresolved generation"
            )
        if state is not None and state.dispatch_phase is Completed and request_fingerprint:
            stored = state.terminal_result
            if not isinstance(stored, Present):
                raise AssertionError("Completed metadata step has no terminal result")
            memo = step_journal.decode_step_result(stored.value, _Memo)
            db.commit()
            return _publish(factory, context, media_uuid, request_fingerprint, memo)

        def unusable(reason: _TerminalReason) -> _JobResult:
            db.commit()
            if request_fingerprint is None:
                return {"status": "skipped", "reason": reason}
            return terminalize(reason, request_fingerprint)

        media = db.get(Media, media_uuid, options=(defer(Media.plain_text),))
        if media is None or not can_read_media(db, requester_user_id, media_uuid):
            return unusable("media_not_found")
        if not is_metadata_enrichment_eligible(
            kind=media.kind, processing_status=media.processing_status
        ):
            return unusable("not_ready")

        intent = _intent(_user_content(db, media, requester_user_id=requester_user_id))
        db.commit()

    owner = LlmCallOwner(kind="media_enrichment", id=media_uuid)

    def lock_dispatch(db: Session) -> JobRow | None:
        """Media then queue rows, after the shared owner advisory lock."""
        locked_media = db.scalar(
            select(Media)
            .options(defer(Media.plain_text))
            .where(Media.id == media_uuid)
            .with_for_update()
        )
        jobs = lock_jobs_for_payload(
            db, kind="enrich_metadata", expected_payload_match={"media_id": str(media_uuid)}
        )
        _refuse_other_uncertain_turn(jobs, context=context, media_id=media_uuid)
        if locked_media is None or not can_read_media(db, requester_user_id, media_uuid):
            raise _PreDispatchTerminal("media_not_found")
        if not is_metadata_enrichment_eligible(
            kind=locked_media.kind, processing_status=locked_media.processing_status
        ):
            raise _PreDispatchTerminal("not_ready")
        lock_publication_generation(db, media_id=media_uuid)
        locked = _intent(_user_content(db, locked_media, requester_user_id=requester_user_id))
        if locked != intent:
            raise _PreDispatchTerminal("source_changed")
        return next((candidate for candidate in jobs if candidate.id == context.job_id), None)

    journal = JobGenerationJournal(
        context=context, step_path=METADATA_STEP_PATH, lock_dispatch=lock_dispatch
    )

    async def execute(
        _db: Session, runtime: ExecutionRuntime
    ) -> CompletedGeneration | RescheduleRequested:
        from nexus.services import generation_policy

        nonlocal request_fingerprint

        def provider_executor(spec: GenerationSpec) -> BackendToolExecutor:
            operation = runtime.admission.model_tool_operation(spec)
            if operation is None:
                raise AssertionError("metadata lost its frozen tool operation")
            return DeferredGenerationToolExecutor(
                session_factory=factory,
                user_id=requester_user_id,
                owner=owner,
                generation_id=generation_id,
                job_context=context,
                operation=operation,
            )

        revision = generation_policy.operation_revision("metadata_enrichment")
        request = await admit_job_generation(
            owner=owner,
            generation_id=generation_id,
            operation="metadata_enrichment",
            intent=intent,
            prompt_template_revision=revision,
            prompt_payload_ref=ImmutablePromptPayloadRef(
                owner_kind="media_enrichment",
                owner_id=str(media_uuid),
                revision=revision,
                payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
            ),
            journal=journal,
            session_factory=factory,
            runtime=runtime,
            scope=FrozenToolScope(admitted_refs=(f"media:{media_uuid}",), predicates=()),
            tool_executor_factory=provider_executor,
        )
        request_fingerprint = request.spec.fingerprint
        return await execute_generation(
            request,
            session_factory=factory,
            runtime=runtime,
            encode_terminal=_encode_terminal,
            encode_failure=_encode_failure,
        )

    try:
        result = run_llm_task(_TASK, execute)
    except _PreDispatchTerminal as exc:
        if request_fingerprint is None:
            return {"status": "skipped", "reason": exc.reason}
        return terminalize(exc.reason, request_fingerprint)
    except GenerationDispatchAborted:
        return {"status": "skipped", "reason": "claim_lost_before_dispatch"}
    except GenerationAdmissionInputsChanged as error:
        if request_fingerprint is None:
            raise AssertionError("changed metadata admission has no frozen fingerprint") from error
        return terminalize("source_changed", request_fingerprint)
    except GenerationUncertain as exc:
        raise _UncertainMetadataTurn(exception_error_detail(exc)) from exc

    if isinstance(result, RescheduleRequested):
        return result
    if request_fingerprint is None:
        raise AssertionError("completed metadata dispatch has no frozen fingerprint")
    return _publish(
        factory,
        context,
        media_uuid,
        request_fingerprint,
        step_journal.decode_step_result(result.terminal_result, _Memo),
    )


def _intent(user_content: str) -> GenerationIntent:
    instructions, output_schema = metadata_enrichment_agent_definition()
    return GenerationIntent(
        instructions=instructions,
        input=user_content,
        output=JsonSchemaOutput.model_validate(
            {
                "kind": "JsonSchema",
                "name": "media_metadata_enrichment",
                "schema": output_schema,
                "strict": True,
            }
        ),
    )


def _user_content(db: Session, media: Media, *, requester_user_id: UUID) -> str:
    """Bind the local reads to the same source generation as the sample."""
    index = db.execute(
        select(ContentIndexState.revision, ContentIndexState.status, ContentIndexState.updated_at)
        .where(ContentIndexState.owner_kind == "media", ContentIndexState.owner_id == media.id)
        .with_for_update()
    ).one_or_none()
    admission_facts = json.dumps(
        {
            "requester_user_id": str(requester_user_id),
            "reader_generation": read_publication_generation(db, media_id=media.id),
            "index_revision": index.revision if index is not None else None,
            "index_status": index.status if index is not None else None,
            "index_updated_at": index.updated_at.isoformat() if index is not None else None,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return build_enrichment_user_content(
        db, media, get_content_sample(db, media), admission_facts=admission_facts
    )


def _request_fingerprint(state: StepReplayState) -> str:
    if not isinstance(state.request_fingerprint, Present):
        raise AssertionError("metadata replay state has no request fingerprint")
    return state.request_fingerprint.value


def _refuse_other_uncertain_turn(
    jobs: list[JobRow], *, context: JobExecutionContext, media_id: UUID
) -> None:
    if any(
        candidate.id != context.job_id
        and (other := step_journal.read_step_states(candidate).get(METADATA_STEP_PATH)) is not None
        and other.dispatch_phase is Uncertain
        for candidate in jobs
    ):
        raise _UncertainMetadataTurn(f"media {media_id} already has an unresolved generation")


def _terminalize_prepared(
    factory: sessionmaker[Session],
    *,
    context: JobExecutionContext,
    media_id: UUID,
    generation_id: UUID,
    request_fingerprint: str,
    observed_reason: _TerminalReason,
) -> _JobResult:
    """Atomically finish one Prepared turn that became inapplicable."""
    with factory() as db:
        owner = LlmCallOwner(kind="media_enrichment", id=media_id)
        lock_generation_owner_in_current_transaction(db, owner)
        media = db.scalar(
            select(Media)
            .options(defer(Media.plain_text))
            .where(Media.id == media_id)
            .with_for_update()
        )
        jobs = lock_jobs_for_payload(
            db, kind="enrich_metadata", expected_payload_match={"media_id": str(media_id)}
        )
        _refuse_other_uncertain_turn(jobs, context=context, media_id=media_id)
        job = next((candidate for candidate in jobs if candidate.id == context.job_id), None)
        if job is None:
            raise AssertionError(f"metadata job {context.job_id} disappeared before its terminal")

        current = step_journal.read_step_states(job).get(METADATA_STEP_PATH)
        if current is None or current.dispatch_phase is not Prepared:
            raise AssertionError("metadata pre-dispatch terminal requires the Prepared checkpoint")

        requester_user_id = UUID(str(job.payload["requester_user_id"]))
        reason = observed_reason
        if media is None or not can_read_media(db, requester_user_id, media.id):
            reason = "media_not_found"
        elif not is_metadata_enrichment_eligible(
            kind=media.kind, processing_status=media.processing_status
        ):
            reason = "not_ready"

        if reason == "source_changed" and media is not None:
            code = ApiErrorCode.E_GENERATION_SOURCE_CHANGED.value
            detail = "metadata request fingerprint changed before dispatch"
            published: _JobResult = {
                "status": "failed",
                "reason": "source_changed",
                "error_code": code,
            }
            memo = _Memo(kind="failed", error_code=code, error_detail=detail, published=published)
            _record_metadata_failure(media, code, detail)
            bump_all_collection_families(db, families=ENTRY_VISIBILITY_FAMILIES)
        else:
            published = {"status": "skipped", "reason": reason}
            memo = _Memo(kind="skipped", published=published)

        # Prepared is strictly pre-admission — parent rows and Uncertain land
        # atomically — so this known terminal cannot coexist with a model call.
        if not step_journal.checkpoint_step_state(
            db,
            ctx=context,
            job=job,
            step_path=METADATA_STEP_PATH,
            state=StepReplayState(
                generation_id=generation_id,
                dispatch_phase=Completed,
                request_fingerprint=present(request_fingerprint),
                terminal_result=present(step_journal.encode_step_result(memo)),
            ),
        ):
            db.rollback()
            raise _UncertainMetadataTurn(
                f"metadata job {context.job_id} lost its claim before its terminal"
            )
        db.commit()
        return published


def _encode_terminal(terminal: BackendTerminal) -> EncodedGenerationTerminal:
    outcome = structured_terminal_outcome(terminal)
    memo = _normalize_terminal(outcome)
    return EncodedGenerationTerminal(
        terminal_result=step_journal.encode_step_result(memo),
        accepted_failure=(
            AcceptedGenerationFailure(code="invalid_output", detail=memo.error_detail)
            if isinstance(outcome, StructuredTerminalSuccess) and memo.kind == "failed"
            else None
        ),
    )


def _encode_failure(code: GenerationFailureCode, detail: str) -> str:
    return step_journal.encode_step_result(_failed_memo(_failure_code(code), detail))


def _normalize_terminal(outcome: StructuredTerminalOutcome) -> _Memo:
    if isinstance(outcome, StructuredTerminalCancelled):
        return _failed_memo(
            ApiErrorCode.E_GENERATION_CANCELLED, "metadata generation was cancelled"
        )
    if isinstance(outcome, StructuredTerminalFailure):
        return _failed_memo(_failure_code(outcome.code), outcome.detail)
    if not isinstance(outcome, StructuredTerminalSuccess):
        assert_never(outcome)
    validated = validate_structured_enrichment(outcome.payload)
    if validated is None:
        return _failed_memo(
            ApiErrorCode.E_GENERATION_INVALID_OUTPUT,
            "generation returned metadata outside the domain output contract",
        )
    return _Memo(kind="success", enrichment=validated)


def _failed_memo(error_code: ApiErrorCode, detail: str) -> _Memo:
    return _Memo(
        kind="failed", error_code=error_code.value, error_detail=detail[:_MAX_ERROR_DETAIL_LENGTH]
    )


def _failure_code(kind: GenerationFailureCode) -> ApiErrorCode:
    match kind:
        case "cancelled":
            return ApiErrorCode.E_GENERATION_CANCELLED
        case "quota":
            return ApiErrorCode.E_GENERATION_QUOTA
        case "timeout":
            return ApiErrorCode.E_GENERATION_TIMEOUT
        case "invalid_output":
            return ApiErrorCode.E_GENERATION_INVALID_OUTPUT
        case "output_limit" | "turn_limit":
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


def _publish(
    factory: sessionmaker[Session],
    context: JobExecutionContext,
    media_id: UUID,
    request_fingerprint: str,
    memo: _Memo,
) -> _JobResult:
    """The claim-fenced publication transaction, with its serialization retry."""
    db = factory()
    try:
        return retry_serializable(
            db,
            "metadata_enrichment.publish",
            lambda: _publish_in_tx(db, context, media_id, request_fingerprint, memo),
        )
    finally:
        db.close()


def _publish_in_tx(
    db: Session,
    context: JobExecutionContext,
    media_id: UUID,
    request_fingerprint: str,
    memo: _Memo,
) -> _JobResult:
    # Media row before queue rows: dispatch and the retry lifecycle lock in that
    # same order, and the opposite order deadlocks.
    media = db.scalar(
        select(Media).options(defer(Media.plain_text)).where(Media.id == media_id).with_for_update()
    )
    if lock_and_renew_running_job_claim(db, context=context, lease_seconds=_LEASE_SECONDS) is None:
        db.rollback()
        return {"status": "skipped", "reason": "claim_lost_before_publication"}
    job = get_job(db, context.job_id)
    if job is None:
        raise AssertionError("metadata job disappeared after renewing its claim")
    if memo.published is not None:
        db.commit()
        return memo.published

    requester_user_id = UUID(str(job.payload["requester_user_id"]))
    if media is None or not can_read_media(db, requester_user_id, media_id):
        return _finish(db, context, memo, {"status": "skipped", "reason": "media_not_found"})
    if not is_metadata_enrichment_eligible(
        kind=media.kind, processing_status=media.processing_status
    ):
        return _finish(db, context, memo, {"status": "skipped", "reason": "not_ready"})

    if memo.kind == "failed":
        # Idempotent: an identical recorded failure is not rewritten.
        if not (
            media.failure_stage == FailureStage.metadata
            and media.last_error_code == memo.error_code
            and media.last_error_message == memo.error_detail
        ):
            _record_metadata_failure(media, memo.error_code, memo.error_detail)
            bump_all_collection_families(db, families=ENTRY_VISIBILITY_FAMILIES)
        return _finish(
            db,
            context,
            memo,
            {"status": "failed", "reason": "agent_terminal", "error_code": memo.error_code},
        )
    if memo.enrichment is None:
        raise AssertionError("accepted metadata memo has no enrichment")

    lock_publication_generation(db, media_id=media_id)
    frozen_spec, frozen_intent = _frozen_admission(job)
    current = _intent(_user_content(db, media, requester_user_id=requester_user_id))
    if frozen_spec.fingerprint != request_fingerprint or frozen_intent != current:
        code = ApiErrorCode.E_GENERATION_SOURCE_CHANGED.value
        _record_metadata_failure(media, code, "media facts changed before metadata publication")
        bump_all_collection_families(db, families=ENTRY_VISIBILITY_FAMILIES)
        return _finish(
            db, context, memo, {"status": "failed", "reason": "source_changed", "error_code": code}
        )

    apply_observed_role_slices_in_current_transaction(
        db,
        target=MediaTarget(media.id),
        observation=merge_enrichment(db, media, memo.enrichment),
        source="metadata_enrichment",
    )
    if media.failure_stage == FailureStage.metadata:
        media.failure_stage = None
        media.last_error_code = None
        media.last_error_message = None
    bump_all_collection_families(db, families=ENTRY_VISIBILITY_FAMILIES)
    published = _finish(db, context, memo, {"status": "success"})
    logger.info("enrich_metadata_completed", media_id=str(media_id))
    return published


def _finish(
    db: Session, context: JobExecutionContext, memo: _Memo, published: _JobResult
) -> _JobResult:
    """Checkpoint the published memo under the same claim, then commit."""
    job = get_job(db, context.job_id)
    if job is None:
        raise AssertionError(f"metadata job {context.job_id} disappeared at publication")
    current = step_journal.read_step_states(job).get(METADATA_STEP_PATH)
    if current is None or current.dispatch_phase is not Completed:
        raise AssertionError("metadata publication requires the Completed checkpoint")
    if not step_journal.checkpoint_step_state(
        db,
        ctx=context,
        job=job,
        step_path=METADATA_STEP_PATH,
        state=StepReplayState(
            generation_id=current.generation_id,
            dispatch_phase=Completed,
            request_fingerprint=current.request_fingerprint,
            terminal_result=present(
                step_journal.encode_step_result(memo.model_copy(update={"published": published}))
            ),
        ),
    ):
        raise _UncertainMetadataTurn(
            f"metadata job {context.job_id} lost its claim before publication"
        )
    db.commit()
    return published


def _record_metadata_failure(media: Media, error_code: str, error_message: str) -> None:
    if media.processing_status == ProcessingStatus.failed:
        return
    media.failure_stage = FailureStage.metadata
    media.last_error_code = error_code
    media.last_error_message = error_message[:_MAX_ERROR_DETAIL_LENGTH]
    media.updated_at = datetime.now(UTC)


def _frozen_admission(job: JobRow) -> tuple[GenerationSpec, GenerationIntent]:
    admissions = job.payload.get("generation_admissions")
    raw = admissions.get(METADATA_STEP_PATH) if isinstance(admissions, dict) else None
    if not isinstance(raw, dict) or set(raw) != {"spec", "intent"}:
        raise AssertionError("metadata job has no exact frozen generation admission")
    return decode_generation_spec_document(raw["spec"]), GenerationIntent.model_validate(
        raw["intent"]
    )
