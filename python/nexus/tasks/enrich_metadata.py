"""One metadata generation for a frozen purpose, then claim-fenced publication.

Every attempt builds its input fresh and generates once; publication applies the
result only when the input it was asked about is still the current one. A worker
that dies mid-generation leaves its row ``interrupted`` and the retry generates
again. Publication takes the media lock before its exact queue claim.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import datetime
from typing import Any

from pydantic import TypeAdapter
from sqlalchemy import select, text
from sqlalchemy.orm import Session, defer

from nexus.auth.permissions import can_read_media
from nexus.db.models import Media
from nexus.db.retries import retry_serializable
from nexus.db.session import get_repeatable_read_db, get_session_factory
from nexus.jobs.queue import (
    JobExecutionContext,
    JobResult,
    TerminalJobFailure,
    finish_job,
    lock_running_job_claim,
)
from nexus.logging import get_logger
from nexus.schemas.metadata_enrichment import (
    AcceptedMetadataEnrichment,
    MetadataBibliographyCompletedOutcome,
    MetadataFailedOutcome,
    MetadataFailureCode,
    MetadataJobPayload,
    MetadataNoFindingsOutcome,
    MetadataOutcome,
    MetadataPurpose,
    MetadataTitleCompletedOutcome,
    TitleMetadataJobPayload,
)
from nexus.services.contributor_writes import MediaTarget
from nexus.services.contributors import (
    ContributorObservationRejected,
    apply_prepared_role_slices_in_current_transaction,
    prepare_observed_role_slices_in_current_transaction,
)
from nexus.services.generation.contract import (
    Failed,
    FailureCode,
    GenerationIntent,
    JsonSchemaOutput,
    Owner,
    Succeeded,
    Terminal,
    Tools,
)
from nexus.services.generation.run import generate
from nexus.services.generation.runtime import Runtime, run_generation_job
from nexus.services.media_processing_state import is_metadata_enrichment_eligible
from nexus.services.metadata_enrichment import (
    MetadataInputTooLarge,
    MetadataResearchInput,
    admitted_contributor_handles,
    build_metadata_research_input,
    merge_enrichment,
    metadata_enrichment_agent_definition,
    validate_structured_enrichment,
)
from nexus.services.metadata_operations import metadata_purpose
from nexus.services.reader_publication import (
    lock_publication_generation,
    replace_reader_document_title,
)
from nexus.services.x_titles import (
    AcceptedXTitle,
    XTitleInput,
    XTitleInputTooLarge,
    XTitleSourceRejected,
    accept_x_title,
    build_x_title_input,
    x_title_intent,
)

logger = get_logger(__name__)

type _JobResult = dict[str, object] | TerminalJobFailure
_PAYLOAD = TypeAdapter(MetadataJobPayload)

_FAILURE_CODES: dict[FailureCode, MetadataFailureCode] = {
    "auth": "authentication_failed",
    "quota": "quota_unavailable",
    "rate_limited": "model_unavailable",
    "timeout": "research_timeout",
    "output_limit": "output_limit",
    "content_filtered": "policy_violation",
    "context_too_large": "input_too_large",
    "invalid_output": "invalid_output",
    "policy_violation": "policy_violation",
    "runtime_unavailable": "model_unavailable",
    "interrupted": "worker_interrupted",
    "defect": "execution_failed",
}


def run_job(*, payload: Mapping[str, Any], context: JobExecutionContext) -> JobResult:
    """The ``enrich_metadata`` handler."""
    return enrich_metadata(
        _PAYLOAD.validate_json(json.dumps(dict(payload))),
        context=context,
    )


def enrich_metadata(
    payload: MetadataJobPayload,
    *,
    context: JobExecutionContext,
) -> _JobResult:
    """Build the input, generate once, publish; every failure settles the job."""
    media_uuid = payload.media_id
    requester_user_id = payload.requester_user_id
    logger.info(
        "enrich_metadata_started",
        media_id=str(media_uuid),
        request_id=payload.request_id,
        purpose=payload.purpose,
    )

    async def work(db: Session, runtime: Runtime) -> _JobResult:
        get_repeatable_read_db(db)
        media = db.get(Media, media_uuid, options=(defer(Media.plain_text),))
        if media is None or not can_read_media(db, requester_user_id, media_uuid):
            db.rollback()
            return _queue_only_failure(context, payload.purpose, "access_revoked")
        if (
            not is_metadata_enrichment_eligible(
                kind=media.kind, processing_status=media.processing_status
            )
            or metadata_purpose(media) != payload.purpose
        ):
            db.rollback()
            return _queue_only_failure(context, payload.purpose, "no_longer_eligible")
        owner = Owner("media_enrichment", media_uuid, requester_user_id, context)
        if isinstance(payload, TitleMetadataJobPayload):
            try:
                title_input = build_x_title_input(
                    db, media, source_attempt_id=payload.source_attempt_id
                )
            except XTitleSourceRejected as rejection:
                db.rollback()
                return _queue_only_failure(context, payload.purpose, rejection.code)
            except XTitleInputTooLarge:
                db.rollback()
                return _queue_only_failure(context, payload.purpose, "input_too_large")
            db.rollback()
            research = title_input
            terminal = await generate(
                runtime,
                owner=owner,
                operation="media_title",
                intent=x_title_intent(title_input),
                decode=lambda out: accept_x_title(out, source=title_input),
            )
        else:
            try:
                research = build_metadata_research_input(db, media)
            except MetadataInputTooLarge:
                db.rollback()
                return _queue_only_failure(context, payload.purpose, "input_too_large")
            db.rollback()
            intent = _intent(research.user_content)
            handles = admitted_contributor_handles(intent.input)
            terminal = await generate(
                runtime,
                owner=owner,
                operation="metadata_enrichment",
                intent=intent,
                decode=lambda out: validate_structured_enrichment(out, admitted_handles=handles),
                tools=Tools("MetadataResearch", frozenset({f"media:{media_uuid}"})),
            )
        with runtime.session_factory() as publication_db:
            return retry_serializable(
                publication_db,
                "metadata_enrichment.publish",
                lambda: _publish(publication_db, context, payload, research, terminal),
            )

    return run_generation_job("metadata_generation", context, work)


def _queue_only_failure(
    context: JobExecutionContext, purpose: MetadataPurpose, code: MetadataFailureCode
) -> _JobResult:
    with get_session_factory()() as db:

        def settle() -> _JobResult:
            completed_at = db.scalar(text("SELECT clock_timestamp()"))
            result = _settlement(
                MetadataFailedOutcome(purpose=purpose, completed_at=completed_at, reason=code)
            )
            if finish_job(db, context=context, result=result) is None:
                db.rollback()
                return {"status": "skipped", "reason": "claim_lost_before_publication"}
            db.commit()
            return result

        return retry_serializable(db, "metadata_enrichment.reject", settle)


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
        else f"metadata {outcome.purpose} failed: {outcome.reason}",
    )


def _publish(
    db: Session,
    context: JobExecutionContext,
    payload: MetadataJobPayload,
    research: MetadataResearchInput | XTitleInput,
    terminal: Terminal[AcceptedMetadataEnrichment] | Terminal[AcceptedXTitle],
) -> _JobResult:
    """The claim-fenced publication transaction; the queue stores its settlement."""
    media_id, requester_user_id = payload.media_id, payload.requester_user_id
    # Media row before queue rows: the retry lifecycle locks in that same order.
    media = db.scalar(
        select(Media).options(defer(Media.plain_text)).where(Media.id == media_id).with_for_update()
    )
    if lock_running_job_claim(db, context=context) is None:
        db.rollback()
        return {"status": "skipped", "reason": "claim_lost_before_publication"}

    def finish(outcome: MetadataOutcome) -> _JobResult:
        result = _settlement(outcome)
        if finish_job(db, context=context, result=result) is None:
            db.rollback()
            # justify-defect: the exact running claim is locked until this
            # transaction commits; publication cannot lose it halfway through.
            raise AssertionError("locked metadata claim disappeared during publication")
        db.commit()
        return result

    def failed(code: MetadataFailureCode) -> _JobResult:
        completed_at = db.scalar(text("SELECT clock_timestamp()"))
        return finish(
            MetadataFailedOutcome(purpose=payload.purpose, completed_at=completed_at, reason=code)
        )

    if media is None or not can_read_media(db, requester_user_id, media_id):
        return failed("access_revoked")
    if (
        not is_metadata_enrichment_eligible(
            kind=media.kind, processing_status=media.processing_status
        )
        or metadata_purpose(media) != payload.purpose
    ):
        return failed("no_longer_eligible")
    if isinstance(payload, TitleMetadataJobPayload):
        # justify-defect: the frozen payload chooses this attempt's input contract.
        if not isinstance(research, XTitleInput):
            raise AssertionError("title job requires title input")
        try:
            current = build_x_title_input(db, media, source_attempt_id=payload.source_attempt_id)
        except XTitleSourceRejected as rejection:
            return failed(rejection.code)
        except XTitleInputTooLarge:
            return failed("stale_input")
        if current.fingerprint != research.fingerprint:
            return failed("stale_input")
    if isinstance(terminal, Failed):
        return failed(_FAILURE_CODES[terminal.code])
    if not isinstance(terminal, Succeeded):
        return failed("cancelled")
    if isinstance(payload, TitleMetadataJobPayload):
        # justify-defect: the title generation decoder returns only AcceptedXTitle.
        if not isinstance(terminal.value, AcceptedXTitle):
            raise AssertionError("title job requires accepted title output")
        changed_title = terminal.value.title != media.title
        if changed_title and not replace_reader_document_title(
            db, media=media, title=terminal.value.title
        ):
            # justify-defect: captured x evidence and a readable source publish together.
            raise AssertionError("x title publication requires its reader publication")
        completed_at = _stamp_success(db, media)
        return finish(
            MetadataTitleCompletedOutcome(
                purpose="title",
                completed_at=completed_at,
                changed_fields=["title"] if changed_title else [],
                disposition=terminal.value.disposition,
            )
        )
    # justify-defect: bibliographic input and output follow the frozen purpose.
    if not isinstance(research, MetadataResearchInput) or not isinstance(
        terminal.value, AcceptedMetadataEnrichment
    ):
        raise AssertionError("bibliography job requires bibliographic input and output")
    lock_publication_generation(db, media_id=media_id)
    try:
        current = build_metadata_research_input(db, media)
    except MetadataInputTooLarge:
        # The admitted input fit; enlarged current facts invalidate that input.
        return failed("stale_input")
    if current.fingerprint != research.fingerprint:
        return failed("stale_input")
    enrichment = terminal.value
    if not enrichment.has_findings:
        return finish(
            MetadataNoFindingsOutcome(
                purpose="bibliography", completed_at=db.scalar(text("SELECT clock_timestamp()"))
            )
        )
    try:
        prepared_credits = prepare_observed_role_slices_in_current_transaction(
            db,
            target=MediaTarget(media.id),
            observation=enrichment.contributor_observation(),
            source="metadata_enrichment",
        )
    except ContributorObservationRejected:
        return failed("invalid_output")
    # All domain rejection precedes every proposed write. Unexpected writer
    # failures roll back this whole serializable attempt.
    changed = merge_enrichment(db, media, enrichment)
    credit_result = apply_prepared_role_slices_in_current_transaction(db, prepared=prepared_credits)
    if credit_result.changed:
        changed.append("contributors")
    completed_at = _stamp_success(db, media)
    return finish(
        MetadataBibliographyCompletedOutcome(
            purpose="bibliography",
            completed_at=completed_at,
            changed_fields=changed,
            unresolved_fields=list(enrichment.unresolved_fields),
            retained_manual_authors=credit_result.retained_manual_authors,
        )
    )


def _stamp_success(db: Session, media: Media) -> datetime:
    completed_at = db.execute(
        text(
            "SELECT greatest(clock_timestamp(), CAST(:previous AS timestamptz) + interval '1 microsecond')"
        ),
        {"previous": media.metadata_enriched_at},
    ).scalar_one()
    media.metadata_enriched_at = completed_at
    media.updated_at = completed_at
    return completed_at
