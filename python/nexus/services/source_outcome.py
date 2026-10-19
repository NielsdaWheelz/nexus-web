"""Native source facts and their one public job-result projection."""

from dataclasses import dataclass
from typing import Literal, TypedDict
from uuid import UUID

from nexus.services.contributor_taxonomy import ContributorObservationBatch, ObservedRoleSlices
from nexus.services.transcripts.request_reason import TranscriptRequestReason


class ContributorDiagnostic(TypedDict):
    code: str
    detail: str


class SourceDiagnostics(TypedDict, total=False):
    """Already-JSON operator details; never source lifecycle decision inputs."""

    status: Literal["success", "deduped", "skipped", "completed"]
    reason: Literal["not_extracting"]
    source_type: str
    canonical_url: str
    title: str | None
    fragment_id: str
    processing_status: str
    ingest_enqueued: bool
    idempotency_outcome: Literal["reused", "refreshed"]
    page_count: int
    fragment_count: int
    toc_node_count: int
    asset_count: int
    segment_count: int
    contributor_issues: list[ContributorDiagnostic]


type SourceContributorObservation = tuple[UUID, ObservedRoleSlices, str]


@dataclass(frozen=True, slots=True)
class SourceRunOutcome:
    """Publication effects: reindex only bodies whose searchable content changed."""

    diagnostics: SourceDiagnostics
    observations: tuple[SourceContributorObservation, ...] = ()
    superseded_by_media_id: UUID | None = None
    reindex_media: bool = True
    additional_reindex_media_ids: tuple[UUID, ...] = ()
    metadata_enrichment: bool | None = None
    transcript_request_reason: TranscriptRequestReason | None = None
    pdf_has_text: bool | None = None


def source_contributor_observations(
    *, media_id: UUID, observation: ContributorObservationBatch, source: str
) -> tuple[SourceContributorObservation, ...]:
    """An unobserved role slice never erases prior credits."""
    if isinstance(observation, ObservedRoleSlices):
        return ((media_id, observation, source),)
    return ()


def source_outcome_to_job_result(outcome: SourceRunOutcome) -> dict[str, object]:
    """Serialize the existing operator protocol, excluding every private fact."""
    result: dict[str, object] = dict(outcome.diagnostics)
    if outcome.superseded_by_media_id is not None:
        result["superseded_by_media_id"] = str(outcome.superseded_by_media_id)
    if outcome.metadata_enrichment is not None:
        result["metadata_enrichment"] = outcome.metadata_enrichment
    if outcome.transcript_request_reason is not None:
        result["transcript_request_reason"] = outcome.transcript_request_reason
    if outcome.pdf_has_text is not None:
        result["has_text"] = outcome.pdf_has_text
        if not outcome.pdf_has_text:
            result["warning_error_code"] = "E_PDF_TEXT_UNAVAILABLE"
    return result
