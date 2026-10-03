"""The durable metadata enrichment turn on the ``codex/metadata`` step.

One billed-once, tool-using generation per job: Prepared, then Uncertain
immediately before dispatch, then Completed with a normalized memo. A Completed
replay publishes its pending memo or returns its stored publication outcome;
Uncertain permits local settlement only with the original native seal or
positive non-submission proof.
Dispatch and pre-dispatch closure take generation-owner, media, then queue locks.
Publication takes the media lock before its exact queue claim; a Completed memo
needs no dispatch-owner advisory lock. Admission uses that same media→queue order.
"""

from __future__ import annotations

import json
from typing import Literal, assert_never
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session, defer, sessionmaker

from nexus.auth.permissions import can_read_media
from nexus.db.models import ContentIndexState, Media, PodcastEpisode
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode, exception_error_detail
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    TerminalJobFailure,
    get_job,
    lock_and_renew_running_job_claim,
    lock_jobs_for_payload,
)
from nexus.logging import get_logger
from nexus.schemas.llm import OperatorActionRequired, TemporarilyUnavailable
from nexus.schemas.metadata_enrichment import (
    MetadataAcceptedMemo,
    MetadataCompletedOutcome,
    MetadataFailedMemo,
    MetadataFailedOutcome,
    MetadataFailureCode,
    MetadataMemo,
    MetadataNoFindingsOutcome,
    MetadataOutcome,
)
from nexus.schemas.presence import Present, absent, present
from nexus.services import durable_step_journal as step_journal
from nexus.services.collection_revisions import (
    ENTRY_VISIBILITY_FAMILIES,
    bump_all_collection_families,
)
from nexus.services.contributor_writes import MediaTarget
from nexus.services.contributors import (
    ContributorObservationRejected,
    apply_prepared_role_slices_in_current_transaction,
    prepare_observed_role_slices_in_current_transaction,
)
from nexus.services.durable_step_journal import Completed, Prepared, StepReplayState, Uncertain
from nexus.services.generation_spec import (
    GenerationIntent,
    GenerationSpec,
    ImmutablePromptPayloadRef,
    JsonSchemaOutput,
    decode_generation_spec_document,
    generation_fact_digest,
)
from nexus.services.generation_terminal import (
    GenerationTerminal,
    normalized_failure,
)
from nexus.services.llm_execution import (
    CompletedGeneration,
    EncodedGenerationTerminal,
    ExecutionRuntime,
    GenerationAdmissionInputsChanged,
    GenerationDispatchAborted,
    GenerationFailureCode,
    GenerationUncertain,
    JobGenerationJournal,
    admit_job_generation,
    codex_terminal_evidence,
    execute_generation,
    generation_has_local_recovery,
)
from nexus.services.llm_ledger import LlmCallOwner, lock_generation_owner_in_current_transaction
from nexus.services.media_processing_state import is_metadata_enrichment_eligible
from nexus.services.metadata_enrichment import (
    MetadataInputTooLarge,
    MetadataInvalidOutput,
    admitted_contributor_handles,
    build_enrichment_user_content,
    get_content_sample,
    merge_enrichment,
    metadata_enrichment_agent_definition,
    validate_structured_enrichment,
)
from nexus.services.metadata_operations import (
    METADATA_STEP_PATH,
    MetadataRetryableFailure,
    decode_metadata_memo,
)
from nexus.services.reader_publication import (
    lock_publication_generation,
    read_publication_generation,
)
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task

logger = get_logger(__name__)

_LEASE_SECONDS = 300
_TASK = LlmTaskSpec(label="metadata_generation")
type _TerminalReason = Literal["source_changed", "media_not_found", "not_ready"]
type _JobResult = dict[str, object] | TerminalJobFailure


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
) -> _JobResult:
    """Classify owned failures without losing uncertainty or retrying a paid call."""
    from nexus.services.generation_admission import (
        GenerationConfigurationDefect,
        GenerationOperationUnavailable,
    )
    from nexus.services.generation_catalog import GenerationCatalogRefreshError

    try:
        return _enrich_metadata(
            media_id, request_id, requester_user_id=requester_user_id, context=context
        )
    except MetadataInputTooLarge:
        return _queue_only_failure("input_too_large")
    except (
        GenerationCatalogRefreshError,
        GenerationOperationUnavailable,
        GenerationConfigurationDefect,
    ) as error:
        # The exact journal is authoritative about whether external I/O was armed.
        with get_session_factory()() as db:
            job = get_job(db, context.job_id)
            state = step_journal.read_step_states(job).get(METADATA_STEP_PATH) if job else None
        if state is not None and state.dispatch_phase is Uncertain:
            raise _UncertainMetadataTurn("metadata execution remains unresolved") from error
        if isinstance(error, GenerationConfigurationDefect):
            return _queue_only_failure("configuration_error")
        code: MetadataFailureCode = "catalog_unavailable"
        if isinstance(error, GenerationOperationUnavailable):
            code = "model_unavailable"
            if isinstance(error.reason, (OperatorActionRequired, TemporarilyUnavailable)):
                readiness_codes: dict[str, MetadataFailureCode] = {
                    "catalog_refresh_failed": "catalog_unavailable",
                    "codex_host_unavailable": "model_unavailable",
                    "credential_unavailable": "authentication_failed",
                    "required_tool_unavailable": "configuration_error",
                }
                code = readiness_codes[error.reason.code]
                if isinstance(error.reason, OperatorActionRequired):
                    return _queue_only_failure(code)
        raise MetadataRetryableFailure(code) from error


def _queue_only_failure(code: MetadataFailureCode) -> TerminalJobFailure:
    with get_session_factory()() as db:
        completed_at = db.scalar(text("SELECT clock_timestamp()"))
    outcome = MetadataFailedOutcome(completed_at=completed_at, reason=code)
    return TerminalJobFailure(
        result_payload=outcome.model_dump(mode="json"),
        error_code=f"E_METADATA_{code.upper()}",
        error_message=f"metadata research failed: {code}",
    )


def _enrich_metadata(
    media_id: str,
    request_id: str | None,
    *,
    requester_user_id: UUID,
    context: JobExecutionContext,
) -> _JobResult:
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
        if state is not None and state.dispatch_phase is Completed and request_fingerprint:
            stored = state.terminal_result
            if not isinstance(stored, Present):
                raise AssertionError("Completed metadata step has no terminal result")
            db.commit()
            return _publish(factory, context, media_uuid, request_fingerprint)

        if state is not None and state.dispatch_phase is Uncertain:
            if not generation_has_local_recovery(db, state):
                db.commit()
                raise _UncertainMetadataTurn(
                    f"metadata job {context.job_id} has an unresolved generation"
                )
            # Recover the original turn before inspecting mutable domain facts.
            # Its Completed memo still has to pass the publication fence.
            frozen_spec, intent = _frozen_admission(job)
        else:
            frozen_spec = None if state is None else _frozen_admission(job)[0]

            def unusable(reason: _TerminalReason) -> _JobResult:
                db.commit()
                if request_fingerprint is None:
                    return _queue_only_failure(_domain_reason(reason))
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

    async def execute(_db: Session, runtime: ExecutionRuntime) -> CompletedGeneration:
        from nexus.services import generation_policy

        nonlocal request_fingerprint

        if frozen_spec is None:
            revision = generation_policy.operation_revision("metadata_enrichment")
            prompt_payload_ref = ImmutablePromptPayloadRef(
                owner_kind="media_enrichment",
                owner_id=str(media_uuid),
                revision=revision,
                payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
            )
        else:
            revision = frozen_spec.prompt_template_revision
            prompt_payload_ref = frozen_spec.prompt_payload_ref
        request = await admit_job_generation(
            owner=owner,
            user_id=requester_user_id,
            generation_id=generation_id,
            operation="metadata_enrichment",
            intent=intent,
            prompt_template_revision=revision,
            prompt_payload_ref=prompt_payload_ref,
            journal=journal,
            session_factory=factory,
            runtime=runtime,
        )
        request_fingerprint = request.spec.fingerprint
        return await execute_generation(
            request,
            session_factory=factory,
            runtime=runtime,
            encode_terminal=lambda terminal: _encode_terminal(
                codex_terminal_evidence(terminal),
                admitted_handles=admitted_contributor_handles(request.intent.input),
            ),
            encode_failure=_encode_failure,
        )

    try:
        run_llm_task(_TASK, execute)
    except _PreDispatchTerminal as exc:
        if request_fingerprint is None:
            return _queue_only_failure(_domain_reason(exc.reason))
        return terminalize(exc.reason, request_fingerprint)
    except GenerationDispatchAborted:
        return {"status": "skipped", "reason": "claim_lost_before_dispatch"}
    except GenerationAdmissionInputsChanged as error:
        if request_fingerprint is None:
            raise AssertionError("changed metadata admission has no frozen fingerprint") from error
        return terminalize("source_changed", request_fingerprint)
    except GenerationUncertain as exc:
        raise _UncertainMetadataTurn(exception_error_detail(exc)) from exc

    if request_fingerprint is None:
        raise AssertionError("completed metadata dispatch has no frozen fingerprint")
    return _publish(
        factory,
        context,
        media_uuid,
        request_fingerprint,
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
    rss_metadata_fingerprint = (
        db.execute(
            select(PodcastEpisode.rss_metadata_fingerprint).where(
                PodcastEpisode.media_id == media.id
            )
        )
        .one()
        .rss_metadata_fingerprint
        if media.kind == "podcast_episode"
        else None
    )
    admission_facts = json.dumps(
        {
            "requester_user_id": str(requester_user_id),
            "reader_generation": read_publication_generation(db, media_id=media.id),
            "index_revision": index.revision if index is not None else None,
            "index_status": index.status if index is not None else None,
            "index_updated_at": index.updated_at.isoformat() if index is not None else None,
            "rss_metadata_fingerprint": rss_metadata_fingerprint,
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

        outcome = MetadataFailedOutcome(
            completed_at=db.scalar(text("SELECT clock_timestamp()")), reason=_domain_reason(reason)
        )
        memo = MetadataFailedMemo(
            reason=outcome.reason, published=Present[MetadataOutcome](value=outcome)
        )

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
        return _settlement(outcome)


def _domain_reason(reason: _TerminalReason) -> MetadataFailureCode:
    mapping: dict[_TerminalReason, MetadataFailureCode] = {
        "source_changed": "stale_input",
        "media_not_found": "access_revoked",
        "not_ready": "no_longer_eligible",
    }
    return mapping[reason]


def _encode_terminal(
    terminal: GenerationTerminal, *, admitted_handles: frozenset[str]
) -> EncodedGenerationTerminal:
    # Domain rejection must not rewrite a successful provider terminal.
    return EncodedGenerationTerminal(
        terminal_result=step_journal.encode_step_result(
            _normalize_terminal(terminal, admitted_handles=admitted_handles)
        ),
        accepted_failure=None,
    )


def _encode_failure(code: GenerationFailureCode, detail: str) -> str:
    return step_journal.encode_step_result(
        MetadataFailedMemo(reason=_failure_code(code), published=absent())
    )


def _normalize_terminal(
    terminal: GenerationTerminal, *, admitted_handles: frozenset[str]
) -> MetadataMemo:
    if terminal.status == "cancelled":
        return MetadataFailedMemo(reason="cancelled", published=absent())
    if terminal.status == "failed":
        if terminal.failure is None:
            raise AssertionError("failed generation terminal has no typed failure")
        return MetadataFailedMemo(
            reason=_failure_code(normalized_failure(terminal.failure.kind)), published=absent()
        )
    try:
        accepted = validate_structured_enrichment(
            terminal.structured_output, admitted_handles=admitted_handles
        )
    except MetadataInvalidOutput:
        return MetadataFailedMemo(reason="invalid_output", published=absent())
    return MetadataAcceptedMemo(enrichment=accepted, published=absent())


def _failure_code(kind: GenerationFailureCode) -> MetadataFailureCode:
    match kind:
        case "cancelled":
            return "cancelled"
        case "quota":
            return "quota_unavailable"
        case "timeout":
            return "research_timeout"
        case "invalid_output":
            return "invalid_output"
        case "output_limit" | "turn_limit":
            return "output_limit"
        case "context_too_large":
            return "input_too_large"
        case "auth":
            return "authentication_failed"
        case "runtime_unavailable" | "capacity_unavailable":
            return "model_unavailable"
        case "policy_violation":
            return "policy_violation"
        case _ as unreachable:
            assert_never(unreachable)


def _settlement(outcome: MetadataOutcome) -> _JobResult:
    result = outcome.model_dump(mode="json")
    if outcome.status == "completed":
        return result
    code = (
        "E_METADATA_NO_FINDINGS"
        if outcome.status == "no_findings"
        else f"E_METADATA_{outcome.reason.upper()}"
    )
    return TerminalJobFailure(
        result_payload=result,
        error_code=code,
        error_message="no metadata found"
        if outcome.status == "no_findings"
        else f"metadata research failed: {outcome.reason}",
    )


def _publish(
    factory: sessionmaker[Session],
    context: JobExecutionContext,
    media_id: UUID,
    request_fingerprint: str,
) -> _JobResult:
    """The claim-fenced publication transaction, with its serialization retry."""
    db = factory()
    try:
        return retry_serializable(
            db,
            "metadata_enrichment.publish",
            lambda: _publish_in_tx(db, context, media_id, request_fingerprint),
        )
    finally:
        db.close()


def _publish_in_tx(
    db: Session,
    context: JobExecutionContext,
    media_id: UUID,
    request_fingerprint: str,
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
    state = step_journal.read_step_states(job).get(METADATA_STEP_PATH)
    if (
        state is None
        or state.dispatch_phase is not Completed
        or not isinstance(state.terminal_result, Present)
    ):
        raise AssertionError("metadata publication requires the completed memo")
    memo = decode_metadata_memo(state.terminal_result.value)
    if isinstance(memo.published, Present):
        db.commit()
        return _settlement(memo.published.value)

    def failed(code: MetadataFailureCode) -> _JobResult:
        return _finish(
            db,
            context,
            memo,
            MetadataFailedOutcome(
                completed_at=db.scalar(text("SELECT clock_timestamp()")), reason=code
            ),
        )

    requester_user_id = UUID(str(job.payload["requester_user_id"]))
    if media is None or not can_read_media(db, requester_user_id, media_id):
        return failed("access_revoked")
    if not is_metadata_enrichment_eligible(
        kind=media.kind, processing_status=media.processing_status
    ):
        return failed("no_longer_eligible")
    if memo.status == "failed":
        return failed(memo.reason)

    lock_publication_generation(db, media_id=media_id)
    frozen_spec, frozen_intent = _frozen_admission(job)
    try:
        current = _intent(_user_content(db, media, requester_user_id=requester_user_id))
    except MetadataInputTooLarge:
        # The admitted input fit; enlarged current facts invalidate that input.
        return failed("stale_input")
    if frozen_spec.fingerprint != request_fingerprint or frozen_intent != current:
        return failed("stale_input")
    if not memo.enrichment.has_findings:
        return _finish(
            db,
            context,
            memo,
            MetadataNoFindingsOutcome(completed_at=db.scalar(text("SELECT clock_timestamp()"))),
        )

    try:
        prepared_credits = prepare_observed_role_slices_in_current_transaction(
            db,
            target=MediaTarget(media.id),
            observation=memo.enrichment.contributor_observation(),
            source="metadata_enrichment",
        )
    except ContributorObservationRejected:
        return failed("invalid_output")
    # All domain rejection precedes every proposed write. Unexpected writer
    # failures roll back this whole serializable attempt and replay its memo.
    changed = merge_enrichment(db, media, memo.enrichment)
    credit_result = apply_prepared_role_slices_in_current_transaction(db, prepared=prepared_credits)
    if credit_result.changed:
        changed.append("contributors")
    completed_at = db.scalar(
        text(
            "SELECT greatest(clock_timestamp(), CAST(:previous AS timestamptz) + interval '1 microsecond')"
        ),
        {"previous": media.metadata_enriched_at},
    )
    media.metadata_enriched_at = completed_at
    media.updated_at = completed_at
    if changed:
        bump_all_collection_families(db, families=ENTRY_VISIBILITY_FAMILIES)
    outcome = MetadataCompletedOutcome(
        completed_at=completed_at,
        changed_fields=changed,
        unresolved_fields=list(memo.enrichment.unresolved_fields),
        retained_manual_authors=credit_result.retained_manual_authors,
    )
    return _finish(db, context, memo, outcome)


def _finish(
    db: Session, context: JobExecutionContext, memo: MetadataMemo, published: MetadataOutcome
) -> _JobResult:
    """Checkpoint publication atomically with all accepted metadata facts."""
    job = get_job(db, context.job_id)
    if job is None:
        raise AssertionError("metadata job disappeared at publication")
    current = step_journal.read_step_states(job).get(METADATA_STEP_PATH)
    if current is None or current.dispatch_phase is not Completed:
        raise AssertionError("metadata publication requires the completed checkpoint")
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
                step_journal.encode_step_result(
                    memo.model_copy(update={"published": Present[MetadataOutcome](value=published)})
                )
            ),
        ),
    ):
        raise _UncertainMetadataTurn("metadata job lost its claim before publication")
    db.commit()
    return _settlement(published)


def _frozen_admission(job: JobRow) -> tuple[GenerationSpec, GenerationIntent]:
    admissions = job.payload.get("generation_admissions")
    raw = admissions.get(METADATA_STEP_PATH) if isinstance(admissions, dict) else None
    if not isinstance(raw, dict) or set(raw) != {"spec", "intent"}:
        raise AssertionError("metadata job has no exact frozen generation admission")
    return decode_generation_spec_document(raw["spec"]), GenerationIntent.model_validate(
        raw["intent"]
    )
