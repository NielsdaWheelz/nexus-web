"""Durable metadata enrichment through the private Codex-personal host."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Annotated, Literal, assert_never
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, RootModel
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import get_settings
from nexus.db.models import FailureStage, Media, ProcessingStatus
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode, exception_error_detail
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    RescheduleRequested,
    ScheduleAfter,
    get_job,
    lock_and_renew_running_job_claim,
    lock_jobs_for_payload,
    update_running_job_payload,
)
from nexus.logging import get_logger
from nexus.schemas.presence import Presence, Present, absent, present
from nexus.services.agent_turn_ledger import (
    AgentTurnOwner,
    AgentTurnStart,
    AgentTurnTerminal,
    complete_turn_if_started_in_current_transaction,
    complete_turn_in_current_transaction,
    lock_turn_owner_in_current_transaction,
    start_turn_in_current_transaction,
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
    StepReplayState,
    Uncertain,
    checkpoint_step_state,
    decode_step_result,
    encode_step_result,
    payload_with_step_state,
    read_step_states,
    stable_generation_id,
)
from nexus.services.metadata_dispatch import (
    METADATA_STEP_PATH,
    try_enqueue_metadata_enrichment,
)
from nexus.services.metadata_enrichment import (
    MetadataEnrichmentOutput,
    build_enrichment_user_content,
    get_content_sample,
    merge_enrichment,
    validate_structured_enrichment,
)
from nexus.services.native_agent_client import (
    CodexAgentClient,
    NativeAgentCapacityUnavailable,
    NativeAgentProtocolDefect,
    NativeAgentRequestRejected,
    NativeAgentTransportAmbiguous,
    NativeAgentUnavailable,
)
from nexus.services.native_agent_contract import (
    NativeAgentFailureKind,
    NativeAgentTerminal,
    NativeAgentUsage,
)
from nexus.services.native_agent_operations import (
    build_metadata_enrichment_command,
    metadata_enrichment_operation_facts,
    native_agent_request_fingerprint,
)

logger = get_logger(__name__)

_MAX_ERROR_DETAIL_LENGTH = 1000
_LEASE_SECONDS = 300
_CAPACITY_WAIT_DELAYS_SECONDS = (30, 60, 120, 300)
_MAX_CAPACITY_WAIT_INDEX = len(_CAPACITY_WAIT_DELAYS_SECONDS)
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


class _ResultModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class _SuccessfulPublication(_ResultModel):
    """Strict queue result of one applied metadata publication."""

    kind: Literal["success"] = "success"
    fields: Annotated[tuple[str, ...], Field(min_length=1)]
    backend: Literal["codex"]
    transport: Literal["sdk"]
    auth_profile: Literal["codex-personal"]
    model: Literal["gpt-5.6-luna"]


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
    """Strict replay memo of one accepted native metadata turn."""

    kind: Literal["success"] = "success"
    enrichment: MetadataEnrichmentOutput
    publication_result: Presence[_MetadataPublicationResult]


class _CompletedFailure(_ResultModel):
    """Strict replay memo of one native metadata turn's bounded failure facts."""

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

    error_code = ApiErrorCode.E_METADATA_AGENT_UNCERTAIN


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
                "backend": result.backend,
                "transport": result.transport,
                "auth_profile": result.auth_profile,
                "model": result.model,
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


def _capacity_wait_index(payload: dict[str, object]) -> int:
    """Decode the hard-cut metadata capacity state with no compatibility default."""
    try:
        value = payload["capacity_wait_index"]
    except KeyError as exc:
        # justify-defect: every enqueue and reschedule writes the wait index, so
        # a payload without it is hard-cut corruption, not a legacy shape.
        raise AssertionError("metadata job has no capacity_wait_index") from exc
    # justify-defect: the only writers store a bounded non-negative int.
    if type(value) is not int or not 0 <= value <= _MAX_CAPACITY_WAIT_INDEX:
        raise AssertionError("metadata job has an invalid capacity_wait_index")
    return value


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
        capacity_wait_index = _capacity_wait_index(job.payload)
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
                    f"metadata job {context.job_id} has an unresolved native-agent turn"
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
        command = build_metadata_enrichment_command(
            request_id=generation_id,
            input=user_content,
        )
        reconstructed_fingerprint = native_agent_request_fingerprint(command)
        if state is None:
            request_fingerprint = reconstructed_fingerprint
            prepared = StepReplayState(
                generation_id=generation_id,
                dispatch_phase=Prepared,
                request_fingerprint=present(request_fingerprint),
                terminal_result=absent(),
            )
            if not checkpoint_step_state(
                db,
                ctx=context,
                job=job,
                step_path=METADATA_STEP_PATH,
                state=prepared,
            ):
                db.rollback()
                return _job_result(_SkippedPublication(reason="claim_lost_before_prepare"))
            db.commit()
        elif request_fingerprint is None:
            # justify-defect: the Prepared branch above decoded the persisted
            # request fingerprint before reconstructing the current command.
            raise AssertionError("Prepared metadata step has no request fingerprint")
        elif reconstructed_fingerprint != request_fingerprint:
            # The request fingerprint drifted while the job sat Prepared: it
            # covers the catalog revision, prompt, schema, policy, and timeout
            # as well as media facts (e.g. a reindex landed during a capacity
            # wait). No accepted native turn ran, so this is the same known terminal as
            # publication-time drift: record the metadata warning and complete
            # the queue work. A prior pre-accept refusal may have started an
            # audit row, but no accepted native turn ran.
            db.commit()
            return _complete_pre_dispatch_terminal(
                factory,
                context=context,
                media_id=media_uuid,
                generation_id=generation_id,
                request_fingerprint=request_fingerprint,
                observed_reason="source_changed",
            )
        if request_fingerprint is None:
            # justify-defect: every surviving branch above either set the
            # fingerprint or returned; pyright cannot see that exhaustively.
            raise AssertionError("metadata dispatch has no request fingerprint")

    with factory() as db:
        # Lock-ordering rule (see lock_turn_owner_in_current_transaction): the
        # ledger's advisory owner lock comes FIRST in every transaction that
        # will take it, ahead of the media row and the queue rows locked below.
        # The terminal checkpoint takes it before its own job row for the same
        # reason; without one designed order these two transactions would
        # deadlock AB-BA. pg_advisory_xact_lock is reentrant, so the inner
        # acquisition inside start_turn_in_current_transaction stays.
        turn_owner = AgentTurnOwner(kind="media_enrichment", id=media_uuid)
        lock_turn_owner_in_current_transaction(db, turn_owner)
        media = db.scalar(select(Media).where(Media.id == media_uuid).with_for_update())
        jobs = lock_jobs_for_payload(
            db,
            kind="enrich_metadata",
            expected_payload_match={"media_id": str(media_uuid)},
        )
        job = next((candidate for candidate in jobs if candidate.id == context.job_id), None)
        if job is None:
            # justify-defect: the claimed row matched this payload one
            # transaction ago and terminal transitions never rewrite payloads.
            raise AssertionError(f"metadata job {context.job_id} disappeared before dispatch")
        if any(
            candidate.id != context.job_id
            and (other_state := read_step_states(candidate).get(METADATA_STEP_PATH)) is not None
            and other_state.dispatch_phase is Uncertain
            for candidate in jobs
        ):
            raise _UncertainMetadataTurn(
                f"media {media_uuid} already has an unresolved native-agent turn"
            )
        current = read_step_states(job).get(METADATA_STEP_PATH)
        if current is None or current.dispatch_phase is not Prepared:
            # justify-defect: this attempt durably committed Prepared before
            # entering the dispatch transaction.
            raise AssertionError("metadata dispatch requires the Prepared checkpoint")
        if media is None:
            result = _stage_pre_dispatch_terminal(
                db,
                context=context,
                job=job,
                media=None,
                generation_id=generation_id,
                request_fingerprint=request_fingerprint,
                observed_reason="media_not_found",
            )
            db.commit()
            return _job_result(result)
        if media.processing_status not in _READY_STATES:
            result = _stage_pre_dispatch_terminal(
                db,
                context=context,
                job=job,
                media=media,
                generation_id=generation_id,
                request_fingerprint=request_fingerprint,
                observed_reason="not_ready",
            )
            db.commit()
            return _job_result(result)
        facts = metadata_enrichment_operation_facts()
        # The start row and the Uncertain checkpoint commit atomically: an
        # incomplete ledger row can exist only if dispatch was actually armed.
        start_turn_in_current_transaction(
            db,
            AgentTurnStart(
                id=generation_id,
                owner=turn_owner,
                operation=facts.operation,
                operation_revision=facts.revision,
                backend=facts.backend,
                transport=facts.transport,
                auth_profile=facts.auth_profile,
                model_name=facts.model,
                requested_reasoning=facts.reasoning,
                request_fingerprint=request_fingerprint,
                policy_fingerprint=facts.policy_fingerprint,
                output_schema_fingerprint=facts.output_schema_fingerprint,
            ),
        )
        if not checkpoint_step_state(
            db,
            ctx=context,
            job=job,
            step_path=METADATA_STEP_PATH,
            state=StepReplayState(
                generation_id=generation_id,
                dispatch_phase=Uncertain,
                request_fingerprint=present(request_fingerprint),
                terminal_result=absent(),
            ),
        ):
            db.rollback()
            return _job_result(_SkippedPublication(reason="claim_lost_before_dispatch"))
        db.commit()

    with factory() as db:
        committed_job = get_job(db, context.job_id)
        if committed_job is None:
            # justify-defect: the Uncertain checkpoint just committed on this
            # exact claimed row.
            raise AssertionError(f"metadata job {context.job_id} disappeared before host I/O")
        committed = read_step_states(committed_job).get(METADATA_STEP_PATH)
        if (
            committed is None
            or committed.generation_id != generation_id
            or committed.dispatch_phase is not Uncertain
            or not isinstance(committed.request_fingerprint, Present)
            or committed.request_fingerprint.value != request_fingerprint
        ):
            # justify-defect: dispatching a billed turn without its durable
            # Uncertain checkpoint would break the billed-once guarantee.
            raise AssertionError(
                "the Uncertain checkpoint was not durably committed before native dispatch"
            )
        db.commit()

    try:
        terminal = asyncio.run(CodexAgentClient(get_settings().codex_agent_socket).turn(command))
    except NativeAgentCapacityUnavailable as exc:
        if capacity_wait_index < _MAX_CAPACITY_WAIT_INDEX:
            return _reschedule_preaccept_capacity_wait(
                factory,
                context=context,
                generation_id=generation_id,
                request_fingerprint=request_fingerprint,
                capacity_wait_index=capacity_wait_index,
            )
        completed = _failed_result(
            error_code=ApiErrorCode.E_METADATA_AGENT_CAPACITY_UNAVAILABLE,
            detail=exception_error_detail(exc),
        )
        audit_terminal = _preaccept_terminal(
            code="capacity_unavailable",
            detail=completed.error_detail or "native-agent capacity unavailable",
        )
    except NativeAgentTransportAmbiguous as exc:
        raise _UncertainMetadataTurn(exception_error_detail(exc)) from exc
    except NativeAgentProtocolDefect as exc:
        raise _UncertainMetadataTurn(exception_error_detail(exc)) from exc
    except NativeAgentUnavailable as exc:
        completed = _failed_result(
            error_code=ApiErrorCode.E_METADATA_AGENT_HOST_UNAVAILABLE,
            detail=exception_error_detail(exc),
        )
        audit_terminal = _preaccept_terminal(
            code="host_unavailable",
            detail=completed.error_detail or "native-agent host unavailable",
        )
    except NativeAgentRequestRejected as exc:
        completed = _failed_result(
            error_code=ApiErrorCode.E_METADATA_AGENT_HOST_REJECTED,
            detail=exception_error_detail(exc),
        )
        audit_terminal = _preaccept_terminal(
            code="request_rejected",
            detail=completed.error_detail or "native-agent request rejected",
        )
    else:
        completed, audit_terminal = _normalize_terminal(terminal)

    _checkpoint_completed(
        factory,
        context=context,
        generation_id=generation_id,
        request_fingerprint=request_fingerprint,
        completed=completed,
        terminal=audit_terminal,
    )
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
        owner = AgentTurnOwner(kind="media_enrichment", id=media_id)
        # One canonical order across dispatch, retry, publication, and this
        # early terminal: ledger owner -> media -> queue rows. The ledger's
        # completion acquisition below is therefore a reentrant no-op.
        lock_turn_owner_in_current_transaction(db, owner)
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
            raise _UncertainMetadataTurn(
                f"media {media_id} already has an unresolved native-agent turn"
            )
        result = _stage_pre_dispatch_terminal(
            db,
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
            code = ApiErrorCode.E_METADATA_AGENT_SOURCE_CHANGED.value
            result: _MetadataPublicationResult = _FailedPublication(
                reason="source_changed",
                error_code=code,
            )
            completed: _CompletedMetadataResult = _CompletedFailure(
                error_code=code,
                error_detail=_PRE_DISPATCH_SOURCE_CHANGED_DETAIL,
                publication_result=Present[_MetadataPublicationResult](value=result),
            )
            terminal = _preaccept_terminal(
                code="source_changed",
                detail=_PRE_DISPATCH_SOURCE_CHANGED_DETAIL,
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
            terminal = _preaccept_terminal(
                code="media_not_found",
                detail=_PRE_DISPATCH_MEDIA_MISSING_DETAIL,
            )
        case "not_ready":
            result = _SkippedPublication(reason="not_ready")
            completed = _CompletedSkip(
                publication_result=Present[_SkippedPublication](value=result),
            )
            terminal = _preaccept_terminal(
                code="not_ready",
                detail=_PRE_DISPATCH_NOT_READY_DETAIL,
            )
        case _ as unreachable:
            assert_never(unreachable)

    complete_turn_if_started_in_current_transaction(db, generation_id, terminal)
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


def _reschedule_preaccept_capacity_wait(
    factory: sessionmaker[Session],
    *,
    context: JobExecutionContext,
    generation_id: UUID,
    request_fingerprint: str,
    capacity_wait_index: int,
) -> RescheduleRequested:
    """Restore Prepared durably before asking the queue to release this attempt."""
    delay_seconds = _CAPACITY_WAIT_DELAYS_SECONDS[capacity_wait_index]
    next_wait_index = capacity_wait_index + 1
    with factory() as db:
        job = get_job(db, context.job_id)
        if job is None:
            # justify-defect: the worker holds this claimed row; only unpruned
            # terminal transitions could remove it mid-attempt.
            raise AssertionError(f"metadata job {context.job_id} disappeared at capacity wait")
        # justify-defect: only this claimed attempt advances the wait index.
        if _capacity_wait_index(job.payload) != capacity_wait_index:
            raise AssertionError("metadata capacity wait index changed during dispatch")
        current = read_step_states(job).get(METADATA_STEP_PATH)
        if current is None or current.dispatch_phase is not Uncertain:
            # justify-defect: a pre-accept capacity rejection can only follow
            # this attempt's own committed Uncertain checkpoint.
            raise AssertionError("metadata capacity wait requires the Uncertain checkpoint")
        if (
            _persisted_request_fingerprint(current, generation_id=generation_id)
            != request_fingerprint
        ):
            # justify-defect: only this claimed attempt rewrites its own
            # persisted fingerprint.
            raise AssertionError("metadata capacity wait request fingerprint changed")

        prepared = StepReplayState(
            generation_id=generation_id,
            dispatch_phase=Prepared,
            request_fingerprint=present(request_fingerprint),
            terminal_result=absent(),
        )
        payload = payload_with_step_state(
            {**job.payload, "capacity_wait_index": next_wait_index},
            step_path=METADATA_STEP_PATH,
            state=prepared,
        )
        if not update_running_job_payload(
            db,
            job_id=context.job_id,
            worker_id=context.worker_id,
            attempt_no=context.attempt_no,
            payload=payload,
        ):
            db.rollback()
            raise _UncertainMetadataTurn(
                f"metadata job {context.job_id} lost its claim during capacity wait"
            )
        db.commit()

    return RescheduleRequested(schedule=ScheduleAfter(delay_seconds), payload=payload)


def _normalize_terminal(
    terminal: NativeAgentTerminal,
) -> tuple[_CompletedMetadataResult, AgentTurnTerminal]:
    usage = terminal.usage
    session_ref = terminal.session_ref.model_dump(mode="json") if terminal.session_ref else None
    usage_facts = _usage_facts(usage)

    match terminal.status:
        case "succeeded":
            validated = validate_structured_enrichment(terminal.structured_output)
            if validated is None:
                completed = _failed_result(
                    error_code=ApiErrorCode.E_METADATA_AGENT_INVALID_OUTPUT,
                    detail="native agent returned metadata outside the domain output contract",
                )
                return completed, AgentTurnTerminal(
                    outcome="failed",
                    session_ref=session_ref,
                    error_code="output_schema_violation",
                    error_detail=completed.error_detail,
                    **usage_facts,
                    sdk_version=terminal.sdk_version,
                    runtime_version=terminal.runtime_version,
                )
            if not validated.model_dump(exclude_none=True):
                completed = _failed_result(
                    error_code=ApiErrorCode.E_METADATA_NO_FIELDS,
                    detail="native agent returned no confident metadata fields",
                )
            else:
                completed = _CompletedSuccess(
                    enrichment=validated,
                    publication_result=absent(),
                )
            return completed, AgentTurnTerminal(
                outcome="succeeded",
                session_ref=session_ref,
                error_code=None,
                error_detail=None,
                **usage_facts,
                sdk_version=terminal.sdk_version,
                runtime_version=terminal.runtime_version,
            )
        case "cancelled":
            return _failed_result(
                error_code=ApiErrorCode.E_METADATA_AGENT_CANCELLED,
                detail="native metadata turn was cancelled",
            ), AgentTurnTerminal(
                outcome="cancelled",
                session_ref=session_ref,
                error_code=None,
                error_detail=None,
                **usage_facts,
                sdk_version=terminal.sdk_version,
                runtime_version=terminal.runtime_version,
            )
        case "failed":
            if terminal.failure is None:
                # justify-defect: the wire contract's own validator requires a
                # typed failure on every failed terminal.
                raise AssertionError("failed native-agent terminal has no typed failure")
            domain_code = _failure_code(terminal.failure.kind)
            detail = terminal.diagnostics[0]
            completed = _failed_result(error_code=domain_code, detail=detail)
            return completed, AgentTurnTerminal(
                outcome="failed",
                session_ref=session_ref,
                error_code=terminal.failure.kind,
                error_detail=completed.error_detail,
                **usage_facts,
                sdk_version=terminal.sdk_version,
                runtime_version=terminal.runtime_version,
            )
        case _ as unreachable:
            assert_never(unreachable)


def _failure_code(kind: NativeAgentFailureKind) -> ApiErrorCode:
    match kind:
        case "quota_exhausted":
            return ApiErrorCode.E_METADATA_AGENT_QUOTA_EXHAUSTED
        case "turn_timeout" | "output_limit_exceeded":
            return ApiErrorCode.E_METADATA_AGENT_TIMEOUT
        case "output_schema_violation":
            return ApiErrorCode.E_METADATA_AGENT_INVALID_OUTPUT
        case "credential_unavailable" | "credential_rejected":
            return ApiErrorCode.E_METADATA_AGENT_AUTH_UNAVAILABLE
        case "executable_unavailable" | "sdk_unavailable" | "session_unavailable":
            return ApiErrorCode.E_METADATA_AGENT_HOST_UNAVAILABLE
        case "invalid_request":
            return ApiErrorCode.E_METADATA_AGENT_HOST_REJECTED
        case "policy_violation" | "approval_unanswered":
            return ApiErrorCode.E_METADATA_AGENT_POLICY_VIOLATION
        case "backend_failed" | "runtime_defect":
            return ApiErrorCode.E_METADATA_AGENT_RUNTIME_FAILED
        case _ as unreachable:
            assert_never(unreachable)


def _usage_facts(usage: NativeAgentUsage | None) -> dict[str, int | None]:
    if usage is None:
        return {
            "input_tokens": None,
            "output_tokens": None,
            "total_tokens": None,
            "reasoning_tokens": None,
            "cache_read_input_tokens": None,
            "cache_write_input_tokens": None,
        }
    return {
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "total_tokens": usage.total_tokens,
        "reasoning_tokens": usage.reasoning_tokens,
        "cache_read_input_tokens": usage.cache_read_input_tokens,
        "cache_write_input_tokens": usage.cache_write_input_tokens,
    }


def _preaccept_terminal(*, code: str, detail: str) -> AgentTurnTerminal:
    return AgentTurnTerminal(
        outcome="failed",
        session_ref=None,
        error_code=code,
        error_detail=detail,
        input_tokens=None,
        output_tokens=None,
        total_tokens=None,
        reasoning_tokens=None,
        cache_read_input_tokens=None,
        cache_write_input_tokens=None,
        sdk_version=None,
        runtime_version=None,
    )


def _checkpoint_completed(
    factory: sessionmaker[Session],
    *,
    context: JobExecutionContext,
    generation_id: UUID,
    request_fingerprint: str,
    completed: _CompletedMetadataResult,
    terminal: AgentTurnTerminal,
) -> None:
    with factory() as db:
        job = get_job(db, context.job_id)
        if job is None:
            # justify-defect: the worker holds this claimed row; only unpruned
            # terminal transitions could remove it mid-attempt.
            raise AssertionError(f"metadata job {context.job_id} disappeared at terminal")
        current = read_step_states(job).get(METADATA_STEP_PATH)
        if current is None or current.dispatch_phase is not Uncertain:
            # justify-defect: a native terminal can only land on this
            # attempt's own committed Uncertain checkpoint.
            raise AssertionError("metadata terminal requires the Uncertain checkpoint")
        complete_turn_in_current_transaction(db, generation_id, terminal)
        landed = checkpoint_step_state(
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
        )
        if not landed:
            db.rollback()
            raise _UncertainMetadataTurn(
                f"metadata job {context.job_id} lost its claim before terminal checkpoint"
            )
        db.commit()


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

    enrichment = completed.enrichment.model_dump(exclude_none=True)

    current_content = build_enrichment_user_content(
        db,
        media,
        get_content_sample(db, media),
    )
    current_command = build_metadata_enrichment_command(
        request_id=stable_generation_id(context.job_id, METADATA_STEP_PATH),
        input=current_content,
    )
    if native_agent_request_fingerprint(current_command) != request_fingerprint:
        code = ApiErrorCode.E_METADATA_AGENT_SOURCE_CHANGED.value
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

    merge_result = merge_enrichment(db, media, enrichment)
    if not merge_result.accepted_fields:
        code = ApiErrorCode.E_METADATA_NO_FIELDS.value
        detail = "native agent returned no applicable metadata fields"
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
    facts = metadata_enrichment_operation_facts()
    return _SuccessfulPublication(
        fields=tuple(fields),
        backend=facts.backend,
        transport=facts.transport,
        auth_profile=facts.auth_profile,
        model=facts.model,
    )


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


def dispatch_enrich_metadata(media_id: str, request_id: str | None) -> None:
    """Best-effort enqueue after source extraction commits."""
    db = get_session_factory()()
    try:
        try_enqueue_metadata_enrichment(db, media_id=media_id, request_id=request_id)
        db.commit()
    except Exception:
        db.rollback()
        logger.warning("enrich_metadata_dispatch_failed", media_id=media_id)
    finally:
        db.close()
