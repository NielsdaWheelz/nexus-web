"""One metadata enrichment: a research generation, then its claim-fenced publication.

Every attempt builds its input fresh and generates once; publication applies the
result only when the input it was asked about is still the current one. A worker
that dies mid-generation leaves its row ``interrupted`` and the retry generates
again. Publication takes the media lock before its exact queue claim.
"""

from __future__ import annotations

import json
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session, defer

from nexus.auth.permissions import can_read_media
from nexus.db.models import ContentIndexState, Media, PodcastEpisode
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.jobs.queue import (
    JobExecutionContext,
    TerminalJobFailure,
    lock_and_renew_running_job_claim,
)
from nexus.logging import get_logger
from nexus.schemas.metadata_enrichment import (
    AcceptedMetadataEnrichment,
    MetadataCompletedOutcome,
    MetadataFailedOutcome,
    MetadataFailureCode,
    MetadataNoFindingsOutcome,
    MetadataOutcome,
)
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
    admitted_contributor_handles,
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

logger = get_logger(__name__)

_LEASE_SECONDS = 300
type _JobResult = dict[str, object] | TerminalJobFailure

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


def enrich_metadata(
    media_id: str,
    request_id: str | None,
    *,
    requester_user_id: UUID,
    context: JobExecutionContext,
) -> _JobResult:
    """Build the input, generate once, publish; every failure settles the job."""
    media_uuid = UUID(media_id)
    logger.info("enrich_metadata_started", media_id=media_id, request_id=request_id)

    async def work(db: Session, runtime: Runtime) -> _JobResult:
        media = db.get(Media, media_uuid, options=(defer(Media.plain_text),))
        if media is None or not can_read_media(db, requester_user_id, media_uuid):
            return _queue_only_failure("access_revoked")
        if not is_metadata_enrichment_eligible(
            kind=media.kind, processing_status=media.processing_status
        ):
            return _queue_only_failure("no_longer_eligible")
        try:
            intent = _intent(_user_content(db, media, requester_user_id=requester_user_id))
        except MetadataInputTooLarge:
            return _queue_only_failure("input_too_large")
        db.commit()
        handles = admitted_contributor_handles(intent.input)
        terminal = await generate(
            runtime,
            owner=Owner("media_enrichment", media_uuid, requester_user_id, context),
            operation="metadata_enrichment",
            intent=intent,
            decode=lambda out: validate_structured_enrichment(out, admitted_handles=handles),
            tools=Tools("MetadataResearch", frozenset({f"media:{media_uuid}"})),
        )
        return retry_serializable(
            db,
            "metadata_enrichment.publish",
            lambda: _publish(db, context, media_uuid, requester_user_id, intent, terminal),
        )

    return run_generation_job("metadata_generation", context, work)


def _queue_only_failure(code: MetadataFailureCode) -> _JobResult:
    with get_session_factory()() as db:
        completed_at = db.scalar(text("SELECT clock_timestamp()"))
    return _settlement(MetadataFailedOutcome(completed_at=completed_at, reason=code))


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
    db: Session,
    context: JobExecutionContext,
    media_id: UUID,
    requester_user_id: UUID,
    intent: GenerationIntent,
    terminal: Terminal[AcceptedMetadataEnrichment],
) -> _JobResult:
    """The claim-fenced publication transaction; the queue stores its settlement."""
    # Media row before queue rows: the retry lifecycle locks in that same order.
    media = db.scalar(
        select(Media).options(defer(Media.plain_text)).where(Media.id == media_id).with_for_update()
    )
    if lock_and_renew_running_job_claim(db, context=context, lease_seconds=_LEASE_SECONDS) is None:
        db.rollback()
        return {"status": "skipped", "reason": "claim_lost_before_publication"}

    def finish(outcome: MetadataOutcome) -> _JobResult:
        db.commit()
        return _settlement(outcome)

    def failed(code: MetadataFailureCode) -> _JobResult:
        completed_at = db.scalar(text("SELECT clock_timestamp()"))
        return finish(MetadataFailedOutcome(completed_at=completed_at, reason=code))

    if media is None or not can_read_media(db, requester_user_id, media_id):
        return failed("access_revoked")
    if not is_metadata_enrichment_eligible(
        kind=media.kind, processing_status=media.processing_status
    ):
        return failed("no_longer_eligible")
    if isinstance(terminal, Failed):
        return failed(_FAILURE_CODES[terminal.code])
    if not isinstance(terminal, Succeeded):
        return failed("cancelled")
    lock_publication_generation(db, media_id=media_id)
    try:
        current = _intent(_user_content(db, media, requester_user_id=requester_user_id))
    except MetadataInputTooLarge:
        # The admitted input fit; enlarged current facts invalidate that input.
        return failed("stale_input")
    if current != intent:
        return failed("stale_input")
    enrichment = terminal.value
    if not enrichment.has_findings:
        return finish(
            MetadataNoFindingsOutcome(completed_at=db.scalar(text("SELECT clock_timestamp()")))
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
    return finish(
        MetadataCompletedOutcome(
            completed_at=completed_at,
            changed_fields=changed,
            unresolved_fields=list(enrichment.unresolved_fields),
            retained_manual_authors=credit_result.retained_manual_authors,
        )
    )
