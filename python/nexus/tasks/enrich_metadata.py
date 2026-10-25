"""The ``enrich_metadata`` job: one generation for its frozen purpose, then its fenced
publication (I9).

A bibliography job researches the media's facts; a title job names an X post/thread from the
captured source attempt its payload freezes. Each attempt builds its input fresh and
generates once; a retry after a dead worker generates again. Publication takes the media
lock, then its exact queue claim, re-checks access, eligibility, the purpose and the input
fingerprint, and commits the facts, the strictly later ``metadata_enriched_at`` and the
outcome together.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
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
    TerminalJobFailure,
    finish_job,
    lock_running_job_claim,
)
from nexus.schemas.metadata_enrichment import (
    METADATA_FIELDS,
    BibliographyMetadataJobPayload,
    MetadataBibliographyCompletedOutcome,
    MetadataFailedOutcome,
    MetadataFailureCode,
    MetadataFindings,
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
from nexus.services.metadata_enrichment import (
    MetadataInputTooLarge,
    MetadataResearchInput,
    accept_findings,
    build_metadata_research_input,
    contributor_observation,
    merge_findings,
    research_intent_definition,
    unresolved_fields,
)
from nexus.services.metadata_operations import is_metadata_enrichment_eligible, metadata_purpose
from nexus.services.reader_publication import (
    lock_publication_generation,
    replace_reader_document_title,
)
from nexus.services.suggestion_changes import record_input_change
from nexus.services.x_titles import (
    AcceptedXTitle,
    XTitleInput,
    XTitleInputTooLarge,
    XTitleSourceRejected,
    accept_x_title,
    build_x_title_input,
    x_title_intent,
)

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
type _Settled = dict[str, object] | TerminalJobFailure
_CLAIM_LOST: _Settled = {"status": "skipped", "reason": "claim_lost_before_publication"}


def _now(db: Session) -> Any:
    return db.scalar(text("SELECT clock_timestamp()"))


def _settlement(outcome: MetadataOutcome) -> _Settled:
    """Completed succeeds; no findings and failures dead-letter with the outcome kept."""
    result = outcome.model_dump(mode="json")
    if outcome.status == "completed":
        return result
    reason = "no_findings" if outcome.status == "no_findings" else outcome.reason
    return TerminalJobFailure(
        result_payload=result,
        error_code=f"E_METADATA_{reason.upper()}",
        error_message="no metadata found"
        if outcome.status == "no_findings"
        else f"metadata {outcome.purpose} failed: {reason}",
    )


def _refusal(
    db: Session, media: Media | None, payload: MetadataJobPayload
) -> MetadataFailureCode | None:
    if media is None or not can_read_media(db, payload.requester_user_id, media.id):
        return "access_revoked"
    if isinstance(payload, BibliographyMetadataJobPayload):
        from nexus.services.media_parts import part_definition_version

        if payload.part_definition_version != part_definition_version(db, media_id=media.id):
            return "stale_input"
    if not is_metadata_enrichment_eligible(
        kind=media.kind,
        provider=media.provider,
        provider_id=media.provider_id,
        processing_status=media.processing_status,
    ) or payload.purpose != metadata_purpose(
        provider=media.provider, provider_id=media.provider_id, kind=media.kind
    ):
        return "no_longer_eligible"
    return None


def _input(
    db: Session, media: Media, payload: MetadataJobPayload
) -> MetadataResearchInput | XTitleInput | MetadataFailureCode:
    """What this job's purpose asks about, as it stands now."""
    if isinstance(payload, TitleMetadataJobPayload):
        try:
            return build_x_title_input(db, media)
        except XTitleSourceRejected as rejection:
            return rejection.code
        except XTitleInputTooLarge:
            return "input_too_large"
    try:
        return build_metadata_research_input(db, media)
    except MetadataInputTooLarge:
        return "input_too_large"


def _research(
    db: Session, job: MetadataJobPayload
) -> MetadataResearchInput | XTitleInput | MetadataFailureCode:
    media = db.get(Media, job.media_id, options=(defer(Media.plain_text),))
    if (refusal := _refusal(db, media, job)) is not None:
        return refusal
    assert media is not None  # _refusal answers access_revoked for a missing media
    return _input(db, media, job)


def _stale(
    db: Session,
    media: Media,
    job: MetadataJobPayload,
    research: MetadataResearchInput | XTitleInput,
) -> MetadataFailureCode | None:
    current = _input(db, media, job)
    if current == "input_too_large":
        return "stale_input"  # the admitted input fit; the current facts do not
    if isinstance(current, str):
        return current
    return None if current.fingerprint == research.fingerprint else "stale_input"


def run_job(*, payload: Mapping[str, Any], context: JobExecutionContext) -> _Settled:
    job = _PAYLOAD.validate_json(json.dumps(dict(payload)))
    media_id, requester = job.media_id, job.requester_user_id

    async def work(db: Session, runtime: Runtime) -> _Settled:
        get_repeatable_read_db(db)
        research = _research(db, job)
        db.rollback()
        if isinstance(research, str):
            return _settle_refusal(context, job.purpose, research)
        owner = Owner("media_enrichment", media_id, requester, context)
        if isinstance(research, XTitleInput):
            title_input = research
            terminal: Terminal[MetadataFindings] | Terminal[AcceptedXTitle] = await generate(
                runtime,
                owner=owner,
                operation="media_title",
                intent=x_title_intent(title_input),
                decode=lambda out: accept_x_title(out, source=title_input),
            )
        else:
            handles = research.handles
            instructions, schema = research_intent_definition()
            terminal = await generate(
                runtime,
                owner=owner,
                operation="metadata_enrichment",
                intent=GenerationIntent(
                    instructions=instructions,
                    input=research.user_content,
                    output=JsonSchemaOutput(
                        kind="JsonSchema",
                        name="media_metadata_enrichment",
                        schema=schema,
                        strict=True,
                    ),
                ),
                decode=lambda out: accept_findings(out, handles=handles),
                tools=Tools("MetadataResearch", frozenset({f"media:{media_id}"})),
            )
        with runtime.session_factory() as publication:
            return retry_serializable(
                publication,
                "metadata_enrichment.publish",
                lambda: _publish(publication, context, job, research, terminal),
            )

    return run_generation_job("metadata_generation", context, work)


def _settle_refusal(
    context: JobExecutionContext, purpose: MetadataPurpose, code: MetadataFailureCode
) -> _Settled:
    with get_session_factory()() as db:

        def settle() -> _Settled:
            result = _settlement(
                MetadataFailedOutcome(purpose=purpose, completed_at=_now(db), reason=code)
            )
            if finish_job(db, context=context, result=result) is None:
                return _CLAIM_LOST
            return result

        return retry_serializable(db, "metadata_enrichment.reject", settle)


def _publish(
    db: Session,
    context: JobExecutionContext,
    job: MetadataJobPayload,
    research: MetadataResearchInput | XTitleInput,
    terminal: Terminal[MetadataFindings] | Terminal[AcceptedXTitle],
) -> _Settled:
    # The complete source family precedes publication/definition/set and claim.
    from nexus.db.models import MediaPart
    from nexus.services.library_entries import lock_media_rows_in_order
    from nexus.services.media_parts import advance_part_definition, lock_source_parts

    lock_media_rows_in_order(db, [job.media_id])
    part = db.get(MediaPart, job.media_id)
    if part is not None:
        lock_source_parts(db, part.source_media_id)
    media = db.scalar(
        select(Media)
        .options(defer(Media.plain_text))
        .where(Media.id == job.media_id)
        .with_for_update()
    )
    if lock_running_job_claim(db, context=context) is None:
        return _CLAIM_LOST

    def finish(outcome: MetadataOutcome) -> _Settled:
        result = _settlement(outcome)
        finish_job(db, context=context, result=result)  # the claim is locked: it cannot vanish
        if (
            isinstance(
                outcome, MetadataBibliographyCompletedOutcome | MetadataTitleCompletedOutcome
            )
            and outcome.changed_fields
        ):
            record_input_change(db, owners=(f"media:{job.media_id}",))
        return result

    def failed(code: MetadataFailureCode) -> _Settled:
        return finish(
            MetadataFailedOutcome(purpose=job.purpose, completed_at=_now(db), reason=code)
        )

    if (refusal := _refusal(db, media, job)) is not None:
        return failed(refusal)
    assert media is not None  # _refusal answers access_revoked for a missing media
    # A title's captured source is checked before its generation's outcome.
    if (
        isinstance(job, TitleMetadataJobPayload)
        and (code := _stale(db, media, job, research)) is not None
    ):
        return failed(code)
    if isinstance(terminal, Failed):
        return failed(_FAILURE_CODES[terminal.code])
    if not isinstance(terminal, Succeeded):
        return failed("cancelled")
    if isinstance(terminal.value, AcceptedXTitle):
        title = terminal.value
        changed_title = title.title != media.title
        # justify-defect: captured x evidence and its readable source publish together.
        if changed_title and not replace_reader_document_title(db, media=media, title=title.title):
            raise AssertionError("x title publication requires its reader publication")
        return finish(
            MetadataTitleCompletedOutcome(
                purpose="title",
                completed_at=_stamp(db, media),
                changed_fields=["title"] if changed_title else [],
                disposition=title.disposition,
            )
        )
    lock_publication_generation(db, media_id=media.id)
    if (code := _stale(db, media, job, research)) is not None:
        return failed(code)
    findings = terminal.value
    unresolved = unresolved_fields(findings)
    if len(unresolved) == len(METADATA_FIELDS):
        return finish(MetadataNoFindingsOutcome(purpose="bibliography", completed_at=_now(db)))
    try:
        credits = prepare_observed_role_slices_in_current_transaction(
            db,
            target=MediaTarget(media.id),
            observation=contributor_observation(findings),
            source="metadata_enrichment",
        )
    except ContributorObservationRejected:
        return failed("invalid_output")
    # Every rejection precedes every write; a writer failure rolls back the whole attempt.
    changed = merge_findings(db, media, findings)
    if apply_prepared_role_slices_in_current_transaction(db, prepared=credits):
        changed.append("contributors")
    if changed:
        advance_part_definition(db, media_id=media.id)
    return finish(
        MetadataBibliographyCompletedOutcome(
            purpose="bibliography",
            completed_at=_stamp(db, media),
            changed_fields=changed,
            unresolved_fields=unresolved,
        )
    )


def _stamp(db: Session, media: Media) -> Any:
    """A success's ``metadata_enriched_at``: strictly later than the last one."""
    completed_at = db.scalar(
        text(
            "SELECT greatest(clock_timestamp(),"
            " CAST(:previous AS timestamptz) + interval '1 microsecond')"
        ),
        {"previous": media.metadata_enriched_at},
    )
    media.metadata_enriched_at = completed_at
    media.updated_at = completed_at
    return completed_at
