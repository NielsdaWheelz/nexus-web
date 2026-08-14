"""Durable metadata enrichment through the private Codex-personal host."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Literal, Self, assert_never
from uuid import UUID

from pydantic import BaseModel, ConfigDict, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import get_settings
from nexus.db.models import FailureStage, Media, ProcessingStatus
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode, exception_error_detail
from nexus.jobs.queue import (
    JobExecutionContext,
    RescheduleRequested,
    get_job,
    lock_and_renew_running_job_claim,
    lock_jobs_for_payload,
    update_running_job_payload,
)
from nexus.logging import get_logger
from nexus.schemas.presence import Present, absent, present
from nexus.services.agent_turn_ledger import (
    AgentTurnOwner,
    AgentTurnStart,
    AgentTurnTerminal,
    complete_turn_in_current_transaction,
    start_turn,
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
    payload_with_step_state,
    read_step_states,
    stable_generation_id,
)
from nexus.services.metadata_dispatch import try_enqueue_metadata_enrichment
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

_STEP_PATH = "codex/metadata"
_MAX_ERROR_DETAIL_LENGTH = 1000
_LEASE_SECONDS = 300
_CAPACITY_WAIT_DELAYS_SECONDS = (30, 60, 120, 300)
_MAX_CAPACITY_WAIT_INDEX = len(_CAPACITY_WAIT_DELAYS_SECONDS)
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


class _MetadataPublicationResult(BaseModel):
    """Strict, exact queue result persisted with publication."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    status: Literal["success", "failed", "skipped"]
    fields: tuple[str, ...] | None = None
    reason: str | None = None
    error_code: str | None = None
    backend: Literal["codex"] | None = None
    transport: Literal["sdk"] | None = None
    auth_profile: Literal["codex-personal"] | None = None
    model: Literal["gpt-5.6-luna"] | None = None

    @model_validator(mode="after")
    def _valid_result(self) -> Self:
        if self.status == "success":
            if not self.fields or None in (
                self.backend,
                self.transport,
                self.auth_profile,
                self.model,
            ):
                raise ValueError("successful publication requires fields and execution facts")
            if self.reason is not None or self.error_code is not None:
                raise ValueError("successful publication cannot carry failure facts")
        elif self.status == "failed":
            if not self.reason or not self.error_code:
                raise ValueError("failed publication requires reason and error code")
            if self.fields is not None or any(
                value is not None
                for value in (self.backend, self.transport, self.auth_profile, self.model)
            ):
                raise ValueError("failed publication cannot carry success facts")
        elif not self.reason or any(
            value is not None
            for value in (
                self.fields,
                self.error_code,
                self.backend,
                self.transport,
                self.auth_profile,
                self.model,
            )
        ):
            raise ValueError("skipped publication requires only a reason")
        return self


class _CompletedMetadataResult(BaseModel):
    """Strict replay memo owned by the metadata step."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    status: Literal["success", "failed"]
    enrichment: MetadataEnrichmentOutput | None
    error_code: str | None
    error_detail: str | None
    publication_result: _MetadataPublicationResult | None = None

    @model_validator(mode="after")
    def _valid_result(self) -> Self:
        if self.status == "success":
            if self.enrichment is None:
                raise ValueError("successful metadata result requires enrichment")
            if self.error_code is not None or self.error_detail is not None:
                raise ValueError("successful metadata result cannot carry failure facts")
        elif self.enrichment is not None or not self.error_code or not self.error_detail:
            raise ValueError("failed metadata result requires only bounded failure facts")
        return self


class _UncertainMetadataTurn(RuntimeError):
    """A billed-once native turn may have executed and cannot be redispatched."""

    error_code = ApiErrorCode.E_METADATA_AGENT_UNCERTAIN


def _failed_result(*, error_code: ApiErrorCode, detail: str) -> _CompletedMetadataResult:
    return _CompletedMetadataResult(
        status="failed",
        enrichment=None,
        error_code=error_code.value,
        error_detail=detail[:_MAX_ERROR_DETAIL_LENGTH],
        publication_result=None,
    )


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
        raise AssertionError("metadata job has no capacity_wait_index") from exc
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
            raise AssertionError(f"metadata job {context.job_id} disappeared")
        capacity_wait_index = _capacity_wait_index(job.payload)
        generation_id = stable_generation_id(context.job_id, _STEP_PATH)
        state = read_step_states(job).get(_STEP_PATH)
        request_fingerprint: str | None = None
        if state is not None:
            request_fingerprint = _persisted_request_fingerprint(
                state,
                generation_id=generation_id,
            )
            if state.dispatch_phase is Completed:
                if not isinstance(state.terminal_result, Present):
                    raise AssertionError("Completed metadata step has no terminal result")
                completed = decode_step_result(
                    state.terminal_result.value,
                    _CompletedMetadataResult,
                )
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
                raise AssertionError(f"unknown metadata dispatch phase {state.dispatch_phase!r}")

        media = db.get(Media, media_uuid)
        if media is None:
            db.commit()
            return {"status": "skipped", "reason": "media_not_found"}
        if media.processing_status not in _READY_STATES:
            db.commit()
            return {"status": "skipped", "reason": "not_ready"}

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
                step_path=_STEP_PATH,
                state=prepared,
            ):
                db.rollback()
                return {"status": "skipped", "reason": "claim_lost_before_prepare"}
            db.commit()
        elif reconstructed_fingerprint != request_fingerprint:
            raise AssertionError("metadata request fingerprint changed before dispatch")
        if request_fingerprint is None:
            raise AssertionError("metadata dispatch has no request fingerprint")

    with factory() as db:
        media = db.scalar(select(Media).where(Media.id == media_uuid).with_for_update())
        if media is None:
            db.commit()
            return {"status": "skipped", "reason": "media_not_found"}
        jobs = lock_jobs_for_payload(
            db,
            kind="enrich_metadata",
            expected_payload_match={"media_id": str(media_uuid)},
        )
        job = next((candidate for candidate in jobs if candidate.id == context.job_id), None)
        if job is None:
            raise AssertionError(f"metadata job {context.job_id} disappeared before dispatch")
        if any(
            candidate.id != context.job_id
            and (other_state := read_step_states(candidate).get(_STEP_PATH)) is not None
            and other_state.dispatch_phase is Uncertain
            for candidate in jobs
        ):
            raise _UncertainMetadataTurn(
                f"media {media_uuid} already has an unresolved native-agent turn"
            )
        current = read_step_states(job).get(_STEP_PATH)
        if current is None or current.dispatch_phase is not Prepared:
            raise AssertionError("metadata dispatch requires the Prepared checkpoint")
        facts = metadata_enrichment_operation_facts()
        start_turn(
            factory,
            AgentTurnStart(
                id=generation_id,
                owner=AgentTurnOwner(kind="media_enrichment", id=media_uuid),
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
            step_path=_STEP_PATH,
            state=StepReplayState(
                generation_id=generation_id,
                dispatch_phase=Uncertain,
                request_fingerprint=present(request_fingerprint),
                terminal_result=absent(),
            ),
        ):
            db.rollback()
            return {"status": "skipped", "reason": "claim_lost_before_dispatch"}
        db.commit()

    with factory() as db:
        committed_job = get_job(db, context.job_id)
        if committed_job is None:
            raise AssertionError(f"metadata job {context.job_id} disappeared before host I/O")
        committed = read_step_states(committed_job).get(_STEP_PATH)
        if (
            committed is None
            or committed.generation_id != generation_id
            or committed.dispatch_phase is not Uncertain
            or not isinstance(committed.request_fingerprint, Present)
            or committed.request_fingerprint.value != request_fingerprint
        ):
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
            raise AssertionError(f"metadata job {context.job_id} disappeared at capacity wait")
        if _capacity_wait_index(job.payload) != capacity_wait_index:
            raise AssertionError("metadata capacity wait index changed during dispatch")
        current = read_step_states(job).get(_STEP_PATH)
        if current is None or current.dispatch_phase is not Uncertain:
            raise AssertionError("metadata capacity wait requires the Uncertain checkpoint")
        if (
            _persisted_request_fingerprint(current, generation_id=generation_id)
            != request_fingerprint
        ):
            raise AssertionError("metadata capacity wait request fingerprint changed")

        prepared = StepReplayState(
            generation_id=generation_id,
            dispatch_phase=Prepared,
            request_fingerprint=present(request_fingerprint),
            terminal_result=absent(),
        )
        payload = payload_with_step_state(
            {**job.payload, "capacity_wait_index": next_wait_index},
            step_path=_STEP_PATH,
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

    return RescheduleRequested(delay_seconds=delay_seconds, payload=payload)


def _normalize_terminal(
    terminal: NativeAgentTerminal,
) -> tuple[_CompletedMetadataResult, AgentTurnTerminal]:
    usage = terminal.usage
    session_ref = terminal.session_ref.model_dump(mode="json") if terminal.session_ref else None
    usage_facts = _usage_facts(usage)

    if terminal.status == "succeeded":
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
        if not validated:
            completed = _failed_result(
                error_code=ApiErrorCode.E_METADATA_NO_FIELDS,
                detail="native agent returned no confident metadata fields",
            )
        else:
            completed = _CompletedMetadataResult(
                status="success",
                enrichment=MetadataEnrichmentOutput.model_validate(terminal.structured_output),
                error_code=None,
                error_detail=None,
                publication_result=None,
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

    if terminal.status == "cancelled":
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

    if terminal.failure is None:
        raise AssertionError("failed native-agent terminal has no typed failure")
    domain_code = _failure_code(terminal.failure.kind)
    detail = terminal.diagnostics[0] if terminal.diagnostics else terminal.failure.kind
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
            raise AssertionError(f"metadata job {context.job_id} disappeared at terminal")
        current = read_step_states(job).get(_STEP_PATH)
        if current is None or current.dispatch_phase is not Uncertain:
            raise AssertionError("metadata terminal requires the Uncertain checkpoint")
        complete_turn_in_current_transaction(db, generation_id, terminal)
        landed = checkpoint_step_state(
            db,
            ctx=context,
            job=job,
            step_path=_STEP_PATH,
            state=StepReplayState(
                generation_id=generation_id,
                dispatch_phase=Completed,
                request_fingerprint=present(request_fingerprint),
                terminal_result=present(completed.model_dump_json()),
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
    if (
        lock_and_renew_running_job_claim(
            db,
            context=context,
            lease_seconds=_LEASE_SECONDS,
        )
        is None
    ):
        db.rollback()
        return {"status": "skipped", "reason": "claim_lost_before_publication"}

    if completed.publication_result is not None:
        db.commit()
        return completed.publication_result.model_dump(mode="json", exclude_none=True)

    media = db.scalar(select(Media).where(Media.id == media_id).with_for_update())
    if media is None:
        return _commit_publication_result(
            db,
            context=context,
            completed=completed,
            result=_MetadataPublicationResult(status="skipped", reason="media_not_found"),
        )
    if media.processing_status not in _READY_STATES:
        return _commit_publication_result(
            db,
            context=context,
            completed=completed,
            result=_MetadataPublicationResult(status="skipped", reason="not_ready"),
        )

    if completed.status == "failed":
        if completed.error_code is None or completed.error_detail is None:
            raise AssertionError("failed metadata replay result has incomplete facts")
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
            result=_MetadataPublicationResult(
                status="failed",
                reason="agent_terminal",
                error_code=completed.error_code,
            ),
        )

    if completed.enrichment is None:
        raise AssertionError("successful metadata replay result has no enrichment")
    enrichment = completed.enrichment.model_dump(exclude_none=True)

    current_content = build_enrichment_user_content(
        db,
        media,
        get_content_sample(db, media),
    )
    current_command = build_metadata_enrichment_command(
        request_id=stable_generation_id(context.job_id, _STEP_PATH),
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
            result=_MetadataPublicationResult(
                status="failed",
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
            result=_MetadataPublicationResult(
                status="failed",
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
    return result.model_dump(mode="json", exclude_none=True)


def _checkpoint_published(
    db: Session,
    *,
    context: JobExecutionContext,
    completed: _CompletedMetadataResult,
    publication_result: _MetadataPublicationResult,
) -> None:
    job = get_job(db, context.job_id)
    if job is None:
        raise AssertionError(f"metadata job {context.job_id} disappeared at publication")
    current = read_step_states(job).get(_STEP_PATH)
    if current is None or current.dispatch_phase is not Completed:
        raise AssertionError("metadata publication requires the Completed checkpoint")
    published = completed.model_copy(update={"publication_result": publication_result})
    if not checkpoint_step_state(
        db,
        ctx=context,
        job=job,
        step_path=_STEP_PATH,
        state=StepReplayState(
            generation_id=current.generation_id,
            dispatch_phase=Completed,
            request_fingerprint=current.request_fingerprint,
            terminal_result=present(published.model_dump_json()),
        ),
    ):
        raise _UncertainMetadataTurn(
            f"metadata job {context.job_id} lost its claim before publication"
        )


def _success_result(fields: tuple[str, ...] | list[str]) -> _MetadataPublicationResult:
    facts = metadata_enrichment_operation_facts()
    return _MetadataPublicationResult(
        status="success",
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
    if state.generation_id != generation_id:
        raise AssertionError("metadata generation identity changed on replay")
    if not isinstance(state.request_fingerprint, Present):
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
