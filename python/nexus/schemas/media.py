"""Media, fragment, upload, reader-navigation and evidence wire models."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from nexus.db.models import MediaKind, ProcessingStatus
from nexus.db.models import TranscriptCoverage as MediaTranscriptCoverage
from nexus.db.models import TranscriptState as MediaTranscriptState
from nexus.schemas.client_mutation import ClientMutationUuidText
from nexus.schemas.collection_page import CollectionRevision
from nexus.schemas.consumption import PlayerDescriptor
from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.schemas.media_summary import MediaDurationOut, MediaProcessingStatus
from nexus.schemas.metadata_enrichment import MetadataEnrichmentView
from nexus.schemas.presence import Presence, Present
from nexus.schemas.publication_dates import PublicationDate
from nexus.schemas.source_issues import SourceIssue
from nexus.schemas.upload_failures import UploadTransportFailure, UploadVerificationFailureCode
from nexus.services.sealed_handles import UploadSessionHandle


class _Strict(BaseModel):
    """Base for every closed model on this wire: an unknown key is rejected."""

    model_config = ConfigDict(extra="forbid")


_CAMEL_CONFIG = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")

MediaSourceAttemptStatus = Literal["accepted", "queued", "running", "succeeded", "failed"]
MediaReadState = Literal["unread", "in_progress", "finished"]
TranscriptState = Literal[
    "not_requested", "queued", "running", "ready", "partial", "unavailable", "failed_provider"
]
TranscriptCoverage = Literal["none", "partial", "full"]


class CapabilitiesOut(BaseModel):
    can_read: bool
    can_highlight: bool
    can_quote: bool
    can_search: bool
    can_play: bool
    can_download_file: bool
    can_delete: bool = False
    can_retry: bool = False
    can_refresh_source: bool = False
    can_retry_metadata: bool = False
    can_repair_source: bool = False
    can_repair_search: bool = False
    can_edit_authors: bool = False
    can_read_embeds: bool = False


class PlaybackSourceOut(BaseModel):
    kind: Literal["external_audio", "external_video"]
    stream_url: str
    source_url: str
    provider: str | None
    provider_video_id: str | None
    watch_url: str | None
    embed_url: str | None


DocumentEmbedAggregateStatus = Literal[
    "unsupported", "empty", "resolving", "ready", "partial", "failed"
]
DocumentEmbedProvider = Literal[
    "youtube", "x", "substack", "vimeo", "spotify", "generic", "unknown"
]
DocumentEmbedKind = Literal["video", "post", "audio", "link_preview", "unknown"]
DocumentEmbedSourceShape = Literal[
    "iframe", "blockquote", "anchor", "video_tag", "provider_json", "unknown"
]
DocumentEmbedResolutionStatus = Literal["resolving", "resolved", "unsupported", "failed"]


class DocumentEmbedSummaryOut(BaseModel):
    status: DocumentEmbedAggregateStatus
    total_count: int = Field(ge=0)
    resolved_count: int = Field(ge=0)
    unsupported_count: int = Field(ge=0)
    failed_count: int = Field(ge=0)


class DocumentEmbedTextOut(BaseModel):
    kind: Literal["present", "absent"]
    value: str | None
    reason: Literal["not_in_source", "redacted", "not_applicable"] | None

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class DocumentEmbedUrlOut(BaseModel):
    status: Literal["present", "malformed", "absent"]
    value: str | None
    error_code: str | None
    reason: Literal["not_in_source", "not_applicable"] | None

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class DocumentEmbedProviderRefOut(BaseModel):
    kind: Literal["present", "absent"]
    value: str | None
    reason: Literal["unsupported_provider", "unparseable", "not_applicable"] | None

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class DocumentEmbedLocatorOut(BaseModel):
    kind: Literal["anchored", "unanchored"]
    fragment_id: UUID | None
    canonical_start_offset: int | None = Field(ge=0)
    canonical_end_offset: int | None = Field(ge=0)
    document_order_key: str
    placeholder_text: str

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class DocumentEmbedTargetOut(BaseModel):
    status: Literal[
        "exact",
        "container",
        "missing",
        "forbidden",
        "unanchorable",
        "stale",
        "unsupported",
        "partial",
    ]
    media_id: UUID | None
    resource_ref: str | None
    href: str | None
    kind: str | None
    title: str | None
    thumbnail_url: str | None
    playback: PlaybackSourceOut | None

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class DocumentEmbedDisplayActionOut(BaseModel):
    kind: Literal["open_child_media", "open_original", "retry_child", "refresh_parent"]
    label: str
    href: str | None
    disabled: bool = False

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class DocumentEmbedDisplayOut(BaseModel):
    mode: Literal["resolved", "pending", "unsupported", "failed"]
    label: str
    description: str
    actions: list[DocumentEmbedDisplayActionOut]

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class DocumentEmbedOut(BaseModel):
    id: UUID
    media_id: UUID
    fragment_id: UUID | None
    occurrence_key: str
    ordinal: int
    provider: DocumentEmbedProvider
    kind: DocumentEmbedKind
    source_shape: DocumentEmbedSourceShape
    resolution_status: DocumentEmbedResolutionStatus
    source_url: DocumentEmbedUrlOut
    canonical_url: DocumentEmbedUrlOut
    provider_target_ref: DocumentEmbedProviderRefOut
    title: DocumentEmbedTextOut
    description: DocumentEmbedTextOut
    thumbnail_url: DocumentEmbedUrlOut
    authored_text: DocumentEmbedTextOut
    locator: DocumentEmbedLocatorOut
    target: DocumentEmbedTargetOut
    error_code: DocumentEmbedTextOut
    display: DocumentEmbedDisplayOut

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class ListeningStateOut(BaseModel):
    position_ms: int = Field(ge=0)
    duration_ms: int | None = Field(ge=0)


class PodcastEpisodeChapterOut(BaseModel):
    chapter_idx: int = Field(ge=0)
    title: str
    t_start_ms: int = Field(ge=0)
    t_end_ms: int | None = Field(ge=0)
    url: str | None
    image_url: str | None


class SourceStageProgress(_Strict):
    kind: Literal["Stage"] = "Stage"
    stage: Literal["Validate", "Extract", "Finalize"]
    updated_at: datetime


class SourceCountedProgress(_Strict):
    kind: Literal["Counted"] = "Counted"
    stage: Literal["Extract"] = "Extract"
    completed: int = Field(ge=0)
    total: int = Field(gt=0)
    unit: Literal["Page", "Chapter"]
    updated_at: datetime


SourceProgress = Annotated[SourceStageProgress | SourceCountedProgress, Field(discriminator="kind")]


class MediaOut(BaseModel):
    """The media detail wire: snake_case throughout except ``playerDescriptor``.

    ``read_state`` / ``progress_fraction`` / ``progress_resettable`` and
    ``last_engaged_at`` are the viewer's derived consumption facts;
    ``player_descriptor`` is Present only for a podcast episode with playable
    audio. Routes serializing this model must dump ``by_alias=True``.
    """

    id: UUID
    kind: MediaKind
    title: str
    canonical_source_url: str | None
    provider: Presence[str]
    provider_id: Presence[str]
    requested_url: Presence[str]
    canonical_url: Presence[str]
    processing_status: MediaProcessingStatus
    source_progress: Presence[SourceProgress]
    transcript_state: MediaTranscriptState | None
    transcript_coverage: MediaTranscriptCoverage | None
    transcript_origin: Presence[Literal["Publisher", "Imported", "Generated"]]
    retrieval_status: str | None
    retrieval_status_reason: str | None
    failure_stage: str | None
    last_error_code: str | None
    playback_source: PlaybackSourceOut | None
    listening_state: ListeningStateOut | None
    chapters: list[PodcastEpisodeChapterOut]
    capabilities: CapabilitiesOut
    document_embed_summary: DocumentEmbedSummaryOut | None
    contributors: list[ContributorCreditOut]
    author_mode: Literal["automatic", "manual"] = "automatic"
    original_published_date: Presence[PublicationDate]
    edition_published_date: Presence[PublicationDate]
    edition_isbn: Presence[str]
    duration: Presence[MediaDurationOut]
    publisher: str | None
    language: str | None
    description: str | None
    description_html: str | None
    description_text: str | None
    metadata_enriched_at: datetime | None
    metadata_enrichment: MetadataEnrichmentView
    read_state: MediaReadState | None
    progress_fraction: float | None = Field(ge=0.0, le=1.0)
    progress_resettable: bool
    last_engaged_at: datetime | None
    player_descriptor: Presence[PlayerDescriptor] = Field(alias="playerDescriptor")
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class MediaProcessingSnapshotOut(BaseModel):
    """The complete data frame for media processing state and done events."""

    processing_status: MediaProcessingStatus
    source_progress: Presence[SourceProgress]
    last_error_code: str | None
    failure_stage: str | None
    retrieval_status: str | None
    retrieval_status_reason: str | None
    capabilities: CapabilitiesOut
    transcript_state: MediaTranscriptState | None
    transcript_coverage: MediaTranscriptCoverage | None
    updated_at: str


class MediaRemovedResult(BaseModel):
    model_config = _CAMEL_CONFIG

    kind: Literal["Removed"] = "Removed"
    removed_from_library_ids: list[UUID]
    remaining_reference_count: int = Field(ge=0)
    library_entries_collection_revision: CollectionRevision


class MediaHiddenResult(BaseModel):
    model_config = _CAMEL_CONFIG

    kind: Literal["Hidden"] = "Hidden"
    removed_from_library_ids: list[UUID]
    remaining_reference_count: int = Field(ge=0)
    library_entries_collection_revision: CollectionRevision


class MediaDeletingResult(BaseModel):
    model_config = _CAMEL_CONFIG

    kind: Literal["Deleting"] = "Deleting"


MediaDeleteResult = Annotated[
    MediaRemovedResult | MediaHiddenResult | MediaDeletingResult, Field(discriminator="kind")
]


class CreateUploadSessionRequest(_Strict):
    kind: Literal["Pdf", "Epub"]
    filename: str = Field(min_length=1, max_length=255)
    content_type: str
    size_bytes: int = Field(gt=0)
    library_ids: list[UUID] = Field(default_factory=list)


class RetryUploadSessionRequest(_Strict):
    filename: str = Field(min_length=1, max_length=255)
    content_type: str
    size_bytes: int = Field(gt=0)
    client_mutation_id: ClientMutationUuidText
    expected_generation: int = Field(ge=1)


class ConfirmUploadSessionRequest(_Strict):
    generation: int = Field(ge=1)


class _UploadTransportFailureBase(_Strict):
    generation: int = Field(ge=1)
    duration_ms: int = Field(ge=0)
    request_id: str = Field(min_length=1, max_length=255)


class UploadNetworkFailureRequest(_UploadTransportFailureBase):
    kind: Literal["Network"]


class UploadTimeoutFailureRequest(_UploadTransportFailureBase):
    kind: Literal["Timeout"]


class UploadHttpRejectedFailureRequest(_UploadTransportFailureBase):
    kind: Literal["HttpRejected"]
    status: int = Field(ge=100, le=599)


class UploadAbortedFailureRequest(_UploadTransportFailureBase):
    kind: Literal["Aborted"]


UploadTransportFailureRequest = Annotated[
    UploadNetworkFailureRequest
    | UploadTimeoutFailureRequest
    | UploadHttpRejectedFailureRequest
    | UploadAbortedFailureRequest,
    Field(discriminator="kind"),
]


class UploadRequiredHeaders(BaseModel):
    content_type: str = Field(alias="Content-Type")

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class UploadRequired(_Strict):
    kind: Literal["UploadRequired"] = "UploadRequired"
    session_handle: UploadSessionHandle
    generation: int = Field(ge=1)
    method: Literal["PUT"] = "PUT"
    upload_url: str
    required_headers: UploadRequiredHeaders
    expires_at: datetime
    idempotency_outcome: Literal["Created", "Reused"]


class Published(_Strict):
    kind: Literal["Published"] = "Published"
    session_handle: UploadSessionHandle
    media_id: UUID
    source_attempt_id: UUID
    idempotency_outcome: Literal["Created", "Reused"]


class VerificationFailed(_Strict):
    kind: Literal["VerificationFailed"] = "VerificationFailed"
    code: UploadVerificationFailureCode
    failed_at: datetime


class TransportFailed(_Strict):
    kind: Literal["TransportFailed"] = "TransportFailed"
    reason: UploadTransportFailure
    failed_at: datetime


class CapabilityExpired(_Strict):
    kind: Literal["CapabilityExpired"] = "CapabilityExpired"
    expired_at: datetime


UploadSessionFailure = Annotated[
    VerificationFailed | TransportFailed | CapabilityExpired, Field(discriminator="kind")
]


class UploadSessionCapabilities(_Strict):
    can_retry_upload: bool
    can_remove: bool


class NeedsAttention(_Strict):
    kind: Literal["NeedsAttention"] = "NeedsAttention"
    session_handle: UploadSessionHandle
    failure: UploadSessionFailure
    capabilities: UploadSessionCapabilities


UploadSessionResponse = Annotated[
    UploadRequired | Published | NeedsAttention, Field(discriminator="kind")
]


class RetrySourceRequest(_Strict):
    from_stage: Literal["source"]
    client_mutation_id: ClientMutationUuidText
    expected_attempt_id: UUID


class SourceRepairRequest(_Strict):
    """Requeue the exact dead job of one nonterminal source attempt."""

    kind: Literal["Source"]
    client_mutation_id: ClientMutationUuidText
    expected_attempt_id: UUID
    expected_job_id: UUID


class SearchRepairRequest(_Strict):
    """Requeue the exact dead reindex job of one content-index revision."""

    kind: Literal["Search"]
    client_mutation_id: ClientMutationUuidText
    expected_revision: int = Field(ge=0)
    expected_job_id: UUID


MediaRepairRequest = Annotated[
    SourceRepairRequest | SearchRepairRequest, Field(discriminator="kind")
]


class SourceRetryAdmission(_Strict):
    kind: Literal["SourceRetry"] = "SourceRetry"
    media_id: UUID
    source_attempt_id: UUID
    job_id: UUID


class SourceRepairAdmission(_Strict):
    kind: Literal["SourceRepair"] = "SourceRepair"
    media_id: UUID
    source_attempt_id: UUID
    job_id: UUID


class SearchRepairAdmission(_Strict):
    kind: Literal["SearchRepair"] = "SearchRepair"
    media_id: UUID
    revision: int = Field(ge=0)
    job_id: UUID


TranscriptRequestReason = Literal[
    "episode_open", "search", "highlight", "quote", "background_warming", "operator_requeue"
]


class TranscriptRequestRequest(_Strict):
    reason: TranscriptRequestReason = "episode_open"


class TranscriptRequestOut(BaseModel):
    media_id: str
    processing_status: MediaProcessingStatus
    transcript_state: TranscriptState
    transcript_coverage: TranscriptCoverage
    request_reason: TranscriptRequestReason
    request_enqueued: bool


class FromUrlRequest(BaseModel):
    url: str = Field(
        min_length=1,
        description="The URL to ingest. Must be an absolute http/https URL, including PDF, EPUB, article, or video URLs.",
    )
    library_ids: list[UUID] = Field(default_factory=list)


class FromUrlResponse(BaseModel):
    media_id: UUID
    source_attempt_id: UUID
    source_type: str
    source_attempt_status: MediaSourceAttemptStatus
    idempotency_outcome: Literal["created", "reused", "retrying", "refreshed"]
    processing_status: ProcessingStatus
    ingest_enqueued: bool


class MediaLibrariesRequest(BaseModel):
    library_ids: list[UUID] = Field(default_factory=list)


class MediaFileOut(_Strict):
    """A short-lived signed url of the media's file; ``expires_at`` is ISO 8601."""

    url: str
    expires_at: str


class ReaderNavigationFragmentOut(_Strict):
    """One unique canonical text unit in document order."""

    fragment_id: UUID
    fragment_idx: int = Field(ge=0, strict=True)
    char_count: int = Field(ge=0, strict=True)


class NavigationTextPointOut(_Strict):
    """An exact canonical codepoint boundary within one source fragment."""

    fragment_id: UUID
    offset: int = Field(ge=0, strict=True)


class NavigationTextRangeOut(_Strict):
    """A semantic extent, potentially spanning several canonical fragments."""

    start: NavigationTextPointOut
    end: NavigationTextPointOut


class ReaderNavigationSectionOut(_Strict):
    section_id: str
    label: str
    parent_section_id: Presence[str]
    target: NavigationTextPointOut
    anchor_id: Presence[str]
    extent: Presence[NavigationTextRangeOut]
    source: Literal["Publisher", "Heading", "Both", "InferredNumberedEntry"]


class ReaderNavigationTocNodeOut(_Strict):
    """A published destination, independently linked to a reading section."""

    id: str
    label: str
    target: Presence[NavigationTextPointOut]
    section_id: Presence[str]
    children: list["ReaderNavigationTocNodeOut"]


class ReaderNavigationLocationOut(_Strict):
    """A non-TOC reader navigation target."""

    id: str
    label: str
    target: Presence[NavigationTextPointOut]


class MediaNavigationOut(_Strict):
    media_id: UUID
    kind: Literal["epub", "web_article"]
    generation: int = Field(ge=1, strict=True)
    source_issues: list[SourceIssue]
    fragments: list[ReaderNavigationFragmentOut]
    sections: list[ReaderNavigationSectionOut]
    toc_nodes: list[ReaderNavigationTocNodeOut]
    landmarks: list[ReaderNavigationLocationOut]
    page_list: list[ReaderNavigationLocationOut]

    @model_validator(mode="after")
    def validate_destinations(self) -> "MediaNavigationOut":
        fragments = {fragment.fragment_id: fragment.char_count for fragment in self.fragments}
        if len(fragments) != len(self.fragments):
            raise ValueError("Reader navigation fragment identities are duplicated")
        if [fragment.fragment_idx for fragment in self.fragments] != list(
            range(len(self.fragments))
        ):
            raise ValueError("Reader navigation fragments are not in canonical order")
        sections = {section.section_id: section.target for section in self.sections}
        if len(sections) != len(self.sections):
            raise ValueError("Reader navigation section identities are duplicated")

        def valid_point(point: NavigationTextPointOut) -> bool:
            count = fragments.get(point.fragment_id)
            return count is not None and point.offset <= count

        for section in self.sections:
            if not valid_point(section.target):
                raise ValueError("Reader section target is outside published fragments")
        pending = list(self.toc_nodes)
        while pending:
            node = pending.pop()
            pending.extend(node.children)
            if isinstance(node.target, Present) and not valid_point(node.target.value):
                raise ValueError("Reader contents target is outside published fragments")
            if isinstance(node.section_id, Present) and (
                not isinstance(node.target, Present)
                or sections.get(node.section_id.value) != node.target.value
            ):
                raise ValueError("Reader contents section linkage disagrees with its target")
        return self
