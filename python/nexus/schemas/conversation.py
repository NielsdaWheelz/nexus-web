"""Conversation and Message Pydantic schemas.

Contains request and response models for conversation and message endpoints.
These schemas are introduced in Slice 3 (Chat + Quote-to-Chat + Keyword Search).

Message creation happens through durable chat runs.
"""

from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_serializer,
    field_validator,
    model_serializer,
    model_validator,
)

from nexus.evidence_span_ids import trusted_evidence_span_ids
from nexus.schemas.context_memory import ConversationMemoryInspectionOut, SourceRef
from nexus.schemas.contributors import ContributorCreditOut
from nexus.schemas.retrieval import RetrievalContextRef, RetrievalLocator, RetrievalResultRef

# Valid sharing modes - must match DB constraint
SHARING_MODES = Literal["private", "library", "public"]

# Valid message roles - must match DB constraint
MESSAGE_ROLES = Literal["user", "assistant", "system"]

# Valid message statuses - must match DB constraint
MESSAGE_STATUSES = Literal["pending", "complete", "error"]

# Valid context object types - must match message_context_items.object_type
MESSAGE_CONTEXT_TYPES = Literal[
    "page",
    "note_block",
    "media",
    "highlight",
    "conversation",
    "message",
    "podcast",
    "content_chunk",
    "fragment",
    "contributor",
    "evidence_span",
    "artifact",
    "artifact_part",
]

MESSAGE_CONTEXT_KINDS = Literal["object_ref", "reader_selection"]


def _validate_distinct_evidence_span_id_fields(
    evidence_span_id: UUID | None,
    evidence_span_ids: list[UUID],
) -> None:
    if evidence_span_id is not None and evidence_span_id in evidence_span_ids:
        raise ValueError("evidence_span_id must not duplicate evidence_span_ids")


# Valid conversation scopes - must match conversations.scope_type
CONVERSATION_SCOPE_TYPES = Literal["general", "media", "library"]

# Valid highlight colors surfaced on context snapshots
HIGHLIGHT_COLORS = Literal["yellow", "green", "blue", "pink", "purple"]

# Valid assistant app-search result types - must match message_retrievals.result_type
APP_SEARCH_RESULT_TYPES = Literal[
    "page",
    "note_block",
    "highlight",
    "media",
    "podcast",
    "episode",
    "video",
    "content_chunk",
    "fragment",
    "message",
    "contributor",
    "evidence_span",
    "conversation",
    "artifact",
    "artifact_part",
    "web_result",
]

# Valid assistant tool-call statuses - must match message_tool_calls.status
MESSAGE_TOOL_STATUSES = Literal["pending", "running", "complete", "error", "cancelled"]
WEB_SEARCH_MODES = Literal["off", "auto", "required"]
WEB_SEARCH_RESULT_TYPES = Literal["web", "news", "mixed"]
MESSAGE_ARTIFACT_KINDS = Literal[
    "briefing_document",
    "study_guide",
    "faq",
    "timeline",
    "comparison_table",
    "extraction_table",
    "claim_table",
    "contradiction_report",
    "source_map",
    "concept_map",
    "outline",
    "flashcards",
    "quiz",
    "audio_overview_script",
    "audio_overview",
    "video_slide_overview_manifest",
    "bibliography",
    "citation_audit",
]
ARTIFACT_INTENT_KINDS = Literal[
    "off",
    "auto",
    "briefing_document",
    "study_guide",
    "faq",
    "timeline",
    "comparison_table",
    "extraction_table",
    "claim_table",
    "contradiction_report",
    "source_map",
    "concept_map",
    "outline",
    "flashcards",
    "quiz",
    "audio_overview_script",
    "audio_overview",
    "video_slide_overview_manifest",
    "bibliography",
    "citation_audit",
]
CHAT_RUN_STATUSES = Literal["queued", "running", "complete", "error", "cancelled"]
BRANCH_ANCHOR_KINDS = Literal[
    "none",
    "assistant_message",
    "assistant_selection",
    "reader_context",
]
BRANCH_ANCHOR_OFFSET_STATUSES = Literal["mapped", "unmapped"]
CHAT_RUN_EVENT_TYPES = Literal[
    "meta",
    "tool_call",
    "retrieval_result",
    "source_manifest_delta",
    "artifact_delta",
    "claim",
    "claim_evidence",
    "delta",
    "done",
]
EVIDENCE_RETRIEVAL_STATUSES = Literal[
    "attached_context",
    "retrieved",
    "selected",
    "included_in_prompt",
    "excluded_by_budget",
    "excluded_by_scope",
    "web_result",
]
CLAIM_SUPPORT_STATUSES = Literal[
    "supported",
    "partially_supported",
    "contradicted",
    "not_enough_evidence",
    "out_of_scope",
    "not_source_grounded",
]
CLAIM_EVIDENCE_ROLES = Literal["supports", "contradicts", "context", "scope_boundary"]
EVIDENCE_VERIFIER_STATUSES = Literal["llm_verified", "parse_failed", "failed"]
CANDIDATE_INCLUDED_IN_PROMPT_SOURCES = Literal["candidate_ledger", "linked_retrieval"]


class ConversationScopeRequest(BaseModel):
    """Client-selected durable conversation scope."""

    type: CONVERSATION_SCOPE_TYPES
    media_id: UUID | None = None
    library_id: UUID | None = None

    model_config = ConfigDict(str_strip_whitespace=True, extra="ignore")

    @model_validator(mode="after")
    def validate_scope_targets(self) -> "ConversationScopeRequest":
        if self.type == "general":
            if self.media_id is not None or self.library_id is not None:
                raise ValueError("general scope cannot include target ids")
            return self
        if self.type == "media":
            if self.media_id is None or self.library_id is not None:
                raise ValueError("media scope requires media_id only")
            return self
        if self.type == "library":
            if self.library_id is None or self.media_id is not None:
                raise ValueError("library scope requires library_id only")
            return self
        raise ValueError("invalid conversation scope")


class ConversationScopeOut(BaseModel):
    """Persisted scope metadata for a conversation."""

    type: CONVERSATION_SCOPE_TYPES
    media_id: UUID | None = None
    library_id: UUID | None = None
    title: str | None = None
    media_kind: str | None = None
    library_name: str | None = None
    contributors: list[ContributorCreditOut] = Field(default_factory=list)
    published_date: str | None = None
    publisher: str | None = None
    canonical_source_url: str | None = None
    entry_count: int | None = None
    media_kinds: list[str] = Field(default_factory=list)
    source_policy: str | None = None


# =============================================================================
# Response Schemas
# =============================================================================


class ConversationOut(BaseModel):
    """Response schema for a conversation.

    Conversations are owned by exactly one user. S4 additive fields:
    - owner_user_id: UUID of the conversation owner
    - is_owner: viewer-local convenience flag
    """

    id: UUID
    title: str
    owner_user_id: UUID
    is_owner: bool
    sharing: str  # "private" | "library" | "public"
    scope: ConversationScopeOut
    message_count: int
    memory: ConversationMemoryInspectionOut | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True, extra="forbid")


class MessageDocumentTextBlock(BaseModel):
    type: Literal["text"]
    format: Literal["plain", "markdown"]
    text: str

    model_config = ConfigDict(extra="forbid")


class MessageDocumentSourceManifestBlock(BaseModel):
    type: Literal["source_manifest"]
    assistant_message_id: UUID
    tool_call_id: UUID | None = None
    tool_name: Literal["app_search", "web_search"]
    tool_call_index: int = Field(ge=0)
    query_hash: str | None = None
    scope: str | None = None
    filters: dict[str, Any] = Field(default_factory=dict)
    requested_types: list[str] = Field(default_factory=list)
    candidate_count: int = Field(ge=0)
    result_count: int = Field(ge=0)
    selected_count: int = Field(ge=0)
    included_in_prompt_count: int = Field(ge=0)
    excluded_by_budget_count: int = Field(ge=0)
    excluded_by_scope_count: int = Field(ge=0)
    stale_count: int = Field(ge=0)
    unreadable_count: int = Field(ge=0)
    web_search_mode: WEB_SEARCH_MODES | None = None
    index_versions: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    latency_ms: int | None = Field(default=None, ge=0)
    status: MESSAGE_TOOL_STATUSES

    model_config = ConfigDict(extra="forbid")


class MessageDocumentRetrievalResultBlock(BaseModel):
    type: Literal["retrieval_result"]
    id: UUID | None = None
    tool_call_id: UUID | None = None
    tool_call_index: int | None = Field(default=None, ge=0)
    ordinal: int | None = Field(default=None, ge=0)
    result_type: APP_SEARCH_RESULT_TYPES
    source_id: str
    media_id: UUID | None = None
    evidence_span_id: UUID | None = None
    context_ref: RetrievalContextRef
    result_ref: RetrievalResultRef
    deep_link: str | None = None
    locator: RetrievalLocator | None = None
    score: float | None = None
    selected: bool
    source_title: str | None = None
    section_label: str | None = None
    exact_snippet: str | None = None
    snippet_prefix: str | None = None
    snippet_suffix: str | None = None
    retrieval_status: EVIDENCE_RETRIEVAL_STATUSES | None = None
    included_in_prompt: bool | None = None
    source_version: str | None = None
    created_at: datetime | None = None

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_ref_type_parity(self) -> "MessageDocumentRetrievalResultBlock":
        expected_context_type = (
            "media" if self.result_type in {"episode", "video"} else self.result_type
        )
        if self.context_ref.type != expected_context_type:
            raise ValueError("context_ref.type must match result_type")
        if self.result_ref.type != self.result_type:
            raise ValueError("result_ref.type must match result_type")
        result_source_version = getattr(self.result_ref, "source_version", None)
        if self.source_version != result_source_version:
            raise ValueError("source_version must match result_ref.source_version")
        result_locator = getattr(self.result_ref, "locator", None)
        if result_locator is None:
            if self.locator is not None:
                raise ValueError("locator must match result_ref.locator")
        elif self.locator is None or self.locator.model_dump(
            mode="json",
            exclude_none=True,
            exclude_defaults=True,
        ) != result_locator.model_dump(
            mode="json",
            exclude_none=True,
            exclude_defaults=True,
        ):
            raise ValueError("locator must match result_ref.locator")
        return self


class MessageDocumentVerificationSummaryBlock(BaseModel):
    type: Literal["verification_summary"]
    id: UUID
    message_id: UUID
    scope_type: CONVERSATION_SCOPE_TYPES
    scope_ref: dict[str, Any] | None = None
    retrieval_status: EVIDENCE_RETRIEVAL_STATUSES
    support_status: CLAIM_SUPPORT_STATUSES
    verifier_status: EVIDENCE_VERIFIER_STATUSES
    claim_count: int = Field(ge=0)
    supported_claim_count: int = Field(ge=0)
    unsupported_claim_count: int = Field(ge=0)
    not_enough_evidence_count: int = Field(ge=0)
    prompt_assembly_id: UUID | None = None
    verifier_run_id: UUID | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(extra="forbid")


class MessageDocumentCitationAuditBlock(BaseModel):
    type: Literal["citation_audit"]
    id: UUID
    message_id: UUID
    chat_run_id: UUID | None = None
    verifier_run_id: UUID | None = None
    supported_claim_count: int = Field(ge=0)
    supported_claims_with_valid_offsets_count: int = Field(ge=0)
    supported_claims_with_citation_count: int = Field(ge=0)
    missing_locator_count: int = Field(ge=0)
    missing_source_version_count: int = Field(ge=0)
    supported_claims_have_valid_offsets: bool
    supported_claims_have_citation_placement: bool
    claim_evidence_has_required_locators: bool
    claim_evidence_has_source_versions: bool
    details: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime

    model_config = ConfigDict(extra="forbid")


class MessageDocumentClaimBlock(BaseModel):
    type: Literal["claim"]
    claim_id: UUID
    message_id: UUID | None = None
    ordinal: int = Field(ge=0)
    claim_text: str
    answer_start_offset: int | None = Field(default=None, ge=0)
    answer_end_offset: int | None = Field(default=None, ge=0)
    claim_kind: Literal["answer", "insufficient_evidence"]
    support_status: CLAIM_SUPPORT_STATUSES
    unsupported_reason: str | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    verifier_status: EVIDENCE_VERIFIER_STATUSES
    created_at: datetime | None = None
    evidence_ids: list[UUID] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_offsets(self) -> "MessageDocumentClaimBlock":
        if (
            self.answer_start_offset is not None
            and self.answer_end_offset is not None
            and self.answer_end_offset <= self.answer_start_offset
        ):
            raise ValueError("answer_end_offset must be greater than answer_start_offset")
        return self


class MessageDocumentClaimEvidenceBlock(BaseModel):
    type: Literal["claim_evidence"]
    id: UUID
    claim_id: UUID
    ordinal: int = Field(ge=0)
    evidence_role: CLAIM_EVIDENCE_ROLES
    source_ref: SourceRef
    retrieval_id: UUID | None = None
    evidence_span_id: UUID | None = None
    context_ref: RetrievalContextRef | None = None
    result_ref: RetrievalResultRef | None = None
    exact_snippet: str | None = None
    snippet_prefix: str | None = None
    snippet_suffix: str | None = None
    locator: RetrievalLocator | None = None
    deep_link: str | None = None
    citation_label: str | None = None
    score: float | None = None
    retrieval_status: EVIDENCE_RETRIEVAL_STATUSES
    selected: bool
    included_in_prompt: bool
    source_version: str | None = None
    created_at: datetime

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_citable_evidence(self) -> "MessageDocumentClaimEvidenceBlock":
        if self.evidence_role in {"supports", "contradicts"}:
            if self.locator is None:
                raise ValueError("supporting claim evidence requires a locator")
            if self.source_version is None:
                raise ValueError("supporting claim evidence requires a source_version")
            if not isinstance(self.exact_snippet, str) or not self.exact_snippet.strip():
                raise ValueError("supporting claim evidence requires an exact_snippet")
        return self


class MessageDocumentArtifactPart(BaseModel):
    id: UUID | str | None = None
    artifact_id: UUID | str | None = None
    ordinal: int | None = Field(default=None, ge=0)
    part_key: str | None = None
    part_type: str | None = None
    text: str | None = None
    source_version: str
    locator: RetrievalLocator
    source_ref: SourceRef | None = None
    source_refs: list[SourceRef] = Field(default_factory=list)
    context_ref: RetrievalContextRef | None = None
    result_ref: RetrievalResultRef | None = None
    evidence_span_id: UUID | None = None
    evidence_span_ids: list[UUID] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime | None = None

    model_config = ConfigDict(extra="forbid")


class MessageDocumentArtifactPreviewBlock(BaseModel):
    type: Literal["artifact_preview"]
    artifact_id: UUID | str | None = None
    durable_artifact_id: UUID | str | None = None
    artifact_key: str | None = None
    artifact_version: int | None = Field(default=None, ge=1)
    supersedes_artifact_id: UUID | str | None = None
    artifact_kind: MESSAGE_ARTIFACT_KINDS | None = None
    title: str | None = None
    status: Literal["streaming", "complete", "error"] | None = None
    delta: str | None = None
    parts: list[MessageDocumentArtifactPart] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


MessageDocumentBlock = Annotated[
    MessageDocumentTextBlock
    | MessageDocumentSourceManifestBlock
    | MessageDocumentRetrievalResultBlock
    | MessageDocumentVerificationSummaryBlock
    | MessageDocumentCitationAuditBlock
    | MessageDocumentClaimBlock
    | MessageDocumentClaimEvidenceBlock
    | MessageDocumentArtifactPreviewBlock,
    Field(discriminator="type"),
]


class MessageDocument(BaseModel):
    type: Literal["message_document"] = "message_document"
    version: Literal[1] = 1
    blocks: list[MessageDocumentBlock] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class MessageOut(BaseModel):
    """Response schema for a message.

    Message text and evidence render from message_document blocks.
    Messages are ordered by seq within a conversation.
    """

    id: UUID
    seq: int
    role: str  # "user" | "assistant" | "system"
    message_document: MessageDocument = Field(default_factory=MessageDocument)
    parent_message_id: UUID | None = None
    branch_root_message_id: UUID | None = None
    branch_anchor_kind: BRANCH_ANCHOR_KINDS = "none"
    branch_anchor: dict[str, Any] = Field(default_factory=dict)
    contexts: list["MessageContextSnapshotOut"] = Field(default_factory=list)
    status: str  # "pending" | "complete" | "error"
    error_code: str | None = None
    can_retry_response: bool = False
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True, extra="forbid")


class MessageRetrievalOut(BaseModel):
    """Persisted app-search retrieval metadata for assistant tool calls."""

    id: UUID
    tool_call_id: UUID
    ordinal: int
    result_type: APP_SEARCH_RESULT_TYPES
    source_id: str
    media_id: UUID | None = None
    evidence_span_id: UUID | None = None
    scope: str
    context_ref: RetrievalContextRef
    result_ref: RetrievalResultRef
    deep_link: str | None = None
    score: float | None = None
    selected: bool
    source_title: str | None = None
    section_label: str | None = None
    exact_snippet: str | None = None
    snippet_prefix: str | None = None
    snippet_suffix: str | None = None
    locator: RetrievalLocator | None = None
    retrieval_status: EVIDENCE_RETRIEVAL_STATUSES = "retrieved"
    included_in_prompt: bool = False
    source_version: str | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True, extra="forbid")

    @model_validator(mode="after")
    def validate_ref_type_parity(self) -> "MessageRetrievalOut":
        expected_context_type = (
            "media" if self.result_type in {"episode", "video"} else self.result_type
        )
        if self.context_ref.type != expected_context_type:
            raise ValueError("context_ref.type must match result_type")
        if self.result_ref.type != self.result_type:
            raise ValueError("result_ref.type must match result_type")
        result_source_version = getattr(self.result_ref, "source_version", None)
        if self.source_version != result_source_version:
            raise ValueError("source_version must match result_ref.source_version")
        result_locator = getattr(self.result_ref, "locator", None)
        if result_locator is None:
            if self.locator is not None:
                raise ValueError("locator must match result_ref.locator")
        elif self.locator is None or self.locator.model_dump(
            mode="json",
            exclude_none=True,
            exclude_defaults=True,
        ) != result_locator.model_dump(
            mode="json",
            exclude_none=True,
            exclude_defaults=True,
        ):
            raise ValueError("locator must match result_ref.locator")
        return self


class ChatRunClaimEventPayload(BaseModel):
    """Strict SSE payload for a finalized assistant claim."""

    id: UUID
    message_id: UUID
    ordinal: int = Field(ge=0)
    claim_text: str = Field(min_length=1)
    answer_start_offset: int | None = Field(default=None, ge=0)
    answer_end_offset: int | None = Field(default=None, ge=0)
    claim_kind: Literal["answer", "insufficient_evidence"]
    support_status: CLAIM_SUPPORT_STATUSES
    unsupported_reason: str | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    verifier_status: EVIDENCE_VERIFIER_STATUSES
    verifier_run_id: UUID
    created_at: datetime

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_offsets(self) -> "ChatRunClaimEventPayload":
        if (
            self.answer_start_offset is not None
            and self.answer_end_offset is not None
            and self.answer_end_offset <= self.answer_start_offset
        ):
            raise ValueError("answer_end_offset must be greater than answer_start_offset")
        if self.support_status in {
            "not_enough_evidence",
            "out_of_scope",
            "not_source_grounded",
        } and not (self.unsupported_reason and self.unsupported_reason.strip()):
            raise ValueError("unsupported claims require unsupported_reason")
        return self


class ChatRunClaimEvidenceEventPayload(BaseModel):
    """Strict SSE payload for one source snapshot attached to a claim."""

    id: UUID
    claim_id: UUID
    ordinal: int = Field(ge=0)
    evidence_role: CLAIM_EVIDENCE_ROLES
    source_ref: SourceRef
    retrieval_id: UUID | None = None
    evidence_span_id: UUID | None = None
    context_ref: RetrievalContextRef | None = None
    result_ref: RetrievalResultRef | None = None
    exact_snippet: str | None = None
    snippet_prefix: str | None = None
    snippet_suffix: str | None = None
    locator: RetrievalLocator | None = None
    deep_link: str | None = None
    score: float | None = None
    retrieval_status: EVIDENCE_RETRIEVAL_STATUSES
    selected: bool
    included_in_prompt: bool
    source_version: str | None = Field(default=None, min_length=1)
    created_at: datetime

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_citable_evidence(self) -> "ChatRunClaimEvidenceEventPayload":
        if self.evidence_role in {"supports", "contradicts"}:
            if self.locator is None:
                raise ValueError("supporting claim evidence requires a locator")
            if self.source_version is None:
                raise ValueError("supporting claim evidence requires a source_version")
            if not isinstance(self.exact_snippet, str) or not self.exact_snippet.strip():
                raise ValueError("supporting claim evidence requires an exact_snippet")
        return self


class ChatRunMetaEventPayload(BaseModel):
    """Strict SSE payload emitted when a durable run is created."""

    run_id: UUID
    conversation_id: UUID
    user_message_id: UUID
    assistant_message_id: UUID
    model_id: UUID
    provider: str = Field(min_length=1)

    model_config = ConfigDict(extra="forbid")


class ChatRunToolCallEventPayload(BaseModel):
    """Strict SSE payload for a started or updated assistant tool call."""

    tool_call_id: UUID | None = None
    assistant_message_id: UUID
    tool_name: Literal["app_search", "web_search"]
    tool_call_index: int = Field(ge=0)
    status: MESSAGE_TOOL_STATUSES
    scope: str = Field(min_length=1)
    types: list[str]
    semantic: bool
    filters: dict[str, Any]
    freshness_days: int | None = Field(default=None, ge=0)
    allowed_domains: list[str] = Field(default_factory=list)
    blocked_domains: list[str] = Field(default_factory=list)
    error_code: str | None = None

    model_config = ConfigDict(extra="forbid")


class ChatRunRetrievalResultEventPayload(BaseModel):
    """Strict SSE payload for app/web retrieval results."""

    tool_call_id: UUID | None = None
    assistant_message_id: UUID
    tool_name: Literal["app_search", "web_search"]
    tool_call_index: int = Field(ge=0)
    status: MESSAGE_TOOL_STATUSES
    error_code: str | None = None
    result_count: int = Field(ge=0)
    selected_count: int = Field(ge=0)
    latency_ms: int | None = Field(default=None, ge=0)
    filters: dict[str, Any]
    results: list[RetrievalResultRef] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class ChatRunSourceManifestDeltaEventPayload(BaseModel):
    """Strict SSE payload for the visible source-manifest ledger."""

    assistant_message_id: UUID
    tool_call_id: UUID | None = None
    tool_name: Literal["app_search", "web_search"]
    tool_call_index: int = Field(ge=0)
    query_hash: str | None = None
    scope: str = Field(min_length=1)
    filters: dict[str, Any]
    requested_types: list[str]
    candidate_count: int = Field(ge=0)
    result_count: int = Field(ge=0)
    selected_count: int = Field(ge=0)
    included_in_prompt_count: int = Field(ge=0)
    excluded_by_budget_count: int = Field(ge=0)
    excluded_by_scope_count: int = Field(ge=0)
    stale_count: int = Field(ge=0)
    unreadable_count: int = Field(ge=0)
    web_search_mode: WEB_SEARCH_MODES | None = None
    index_versions: list[str]
    metadata: dict[str, Any] = Field(default_factory=dict)
    latency_ms: int | None = Field(default=None, ge=0)
    status: MESSAGE_TOOL_STATUSES

    model_config = ConfigDict(extra="forbid")


class ChatRunArtifactDeltaPartPayload(BaseModel):
    """Strict artifact part preview carried by artifact_delta events."""

    id: str | None = Field(default=None, min_length=1)
    artifact_id: UUID | str | None = None
    ordinal: int | None = Field(default=None, ge=0)
    part_key: str | None = Field(default=None, min_length=1)
    part_type: str | None = Field(default=None, min_length=1)
    text: str | None = None
    source_version: str = Field(min_length=1)
    locator: RetrievalLocator
    source_ref: SourceRef | None = None
    source_refs: list[SourceRef] = Field(default_factory=list)
    context_ref: RetrievalContextRef | None = None
    result_ref: RetrievalResultRef | None = None
    evidence_span_id: UUID | None = None
    evidence_span_ids: list[UUID] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(extra="forbid")

    @field_validator("evidence_span_ids")
    @classmethod
    def validate_evidence_span_ids(cls, value: list[UUID]) -> list[UUID]:
        return trusted_evidence_span_ids(value)

    @model_validator(mode="after")
    def validate_evidence_refs(self) -> "ChatRunArtifactDeltaPartPayload":
        _validate_distinct_evidence_span_id_fields(
            self.evidence_span_id,
            self.evidence_span_ids,
        )
        if (
            self.source_ref is not None
            or self.source_refs
            or self.context_ref is not None
            or self.result_ref is not None
            or self.evidence_span_id is not None
            or self.evidence_span_ids
            or self.metadata.get("support_state") == "not_source_grounded"
        ):
            return self
        raise ValueError(
            "artifact_delta parts require evidence refs or support_state=not_source_grounded"
        )


class ChatRunArtifactDeltaEventPayload(BaseModel):
    """Strict SSE payload for generated artifact previews."""

    artifact_id: str = Field(min_length=1)
    durable_artifact_id: UUID | str | None = None
    artifact_key: str | None = Field(default=None, min_length=1)
    artifact_version: int | None = Field(default=None, ge=1)
    supersedes_artifact_id: UUID | str | None = None
    artifact_kind: MESSAGE_ARTIFACT_KINDS | None = None
    title: str | None = None
    status: Literal["streaming", "complete", "error"] | None = None
    delta: str | None = None
    parts: list[ChatRunArtifactDeltaPartPayload] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class ChatRunDeltaEventPayload(BaseModel):
    """Strict SSE payload for assistant text deltas."""

    delta: str = Field(min_length=1)

    model_config = ConfigDict(extra="forbid")


class ChatRunDoneEventPayload(BaseModel):
    """Strict SSE payload emitted when a run reaches a terminal status."""

    status: Literal["complete", "error", "cancelled"]
    usage: dict[str, Any] | None = None
    error_code: str | None = None
    final_chars: int | None = Field(default=None, ge=0)

    model_config = ConfigDict(extra="forbid")


def chat_run_event_payload_json(event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Validate strict chat-run SSE payloads before storage/replay."""

    if event_type == "meta":
        return ChatRunMetaEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "tool_call":
        return ChatRunToolCallEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "retrieval_result":
        return ChatRunRetrievalResultEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "source_manifest_delta":
        return ChatRunSourceManifestDeltaEventPayload.model_validate(payload).model_dump(
            mode="json"
        )
    if event_type == "artifact_delta":
        return ChatRunArtifactDeltaEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "claim":
        return ChatRunClaimEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "claim_evidence":
        return ChatRunClaimEvidenceEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "delta":
        return ChatRunDeltaEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "done":
        return ChatRunDoneEventPayload.model_validate(payload).model_dump(mode="json")
    raise ValueError("unknown chat-run event type")


class MessageArtifactPartOut(BaseModel):
    """Ordered generated artifact part with optional evidence refs."""

    id: UUID
    artifact_id: UUID
    ordinal: int
    part_key: str | None = None
    part_type: str | None = None
    text: str | None = None
    source_version: str
    locator: RetrievalLocator
    source_ref: SourceRef | None = None
    context_ref: RetrievalContextRef | None = None
    result_ref: RetrievalResultRef | None = None
    evidence_span_id: UUID | None = None
    evidence_span_ids: list[UUID] = Field(default_factory=list)
    source_refs: list[SourceRef] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime

    model_config = ConfigDict(extra="forbid")


class MessageArtifactOut(BaseModel):
    """Durable generated artifact preview for one assistant message."""

    id: UUID
    conversation_id: UUID
    message_id: UUID
    chat_run_id: UUID | None = None
    artifact_key: str
    artifact_version: int
    supersedes_artifact_id: UUID | None = None
    artifact_kind: MESSAGE_ARTIFACT_KINDS
    title: str | None = None
    status: Literal["streaming", "complete", "error"]
    preview_text: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    parts: list[MessageArtifactPartOut] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(extra="forbid")


class MessageArtifactPartCreateRequest(BaseModel):
    """Create one durable artifact part with explicit provenance."""

    part_key: str | None = Field(default=None, min_length=1, max_length=128)
    part_type: str | None = Field(default=None, min_length=1, max_length=128)
    text: str | None = Field(default=None, max_length=20000)
    source_ref: SourceRef | None = None
    context_ref: RetrievalContextRef | None = None
    result_ref: RetrievalResultRef | None = None
    evidence_span_id: UUID | None = None
    evidence_span_ids: list[UUID] = Field(default_factory=list)
    source_refs: list[SourceRef] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    @field_validator("evidence_span_ids")
    @classmethod
    def validate_evidence_span_ids(cls, value: list[UUID]) -> list[UUID]:
        return trusted_evidence_span_ids(value)

    @model_validator(mode="after")
    def validate_evidence(self) -> "MessageArtifactPartCreateRequest":
        _validate_distinct_evidence_span_id_fields(
            self.evidence_span_id,
            self.evidence_span_ids,
        )
        if (
            self.source_ref is not None
            or self.context_ref is not None
            or self.result_ref is not None
            or self.evidence_span_id is not None
            or self.evidence_span_ids
            or self.source_refs
            or self.metadata.get("support_state") == "not_source_grounded"
        ):
            return self
        raise ValueError(
            "artifact parts require evidence refs or support_state=not_source_grounded"
        )


class MessageArtifactCreateRequest(BaseModel):
    """Create a durable generated artifact for an existing assistant message."""

    message_id: UUID
    artifact_key: str = Field(..., min_length=1, max_length=128)
    artifact_kind: MESSAGE_ARTIFACT_KINDS
    title: str | None = Field(default=None, min_length=1, max_length=500)
    status: Literal["streaming", "complete", "error"] = "complete"
    preview_text: str | None = Field(default=None, max_length=20000)
    metadata: dict[str, Any] = Field(default_factory=dict)
    parts: list[MessageArtifactPartCreateRequest] = Field(default_factory=list)

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class AssistantVerifierRunOut(BaseModel):
    """Append-only verifier run ledger for one assistant message."""

    id: UUID
    message_id: UUID
    chat_run_id: UUID | None = None
    prompt_assembly_id: UUID | None = None
    verifier_name: str
    verifier_version: str
    verifier_status: EVIDENCE_VERIFIER_STATUSES
    support_status: CLAIM_SUPPORT_STATUSES
    claim_count: int
    supported_claim_count: int
    unsupported_claim_count: int
    not_enough_evidence_count: int
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class MessageRetrievalCandidateLedgerOut(BaseModel):
    """Retrieval candidate ledger row with honest prompt-inclusion status."""

    id: UUID
    tool_call_id: UUID
    retrieval_id: UUID | None = None
    ordinal: int
    result_type: APP_SEARCH_RESULT_TYPES
    source_id: str
    score: float | None = None
    selected: bool
    included_in_prompt: bool
    ledger_included_in_prompt: bool
    linked_retrieval_included_in_prompt: bool | None = None
    included_in_prompt_source: CANDIDATE_INCLUDED_IN_PROMPT_SOURCES
    included_in_prompt_reconciled: bool
    selection_status: str
    selection_reason: str
    result_ref: RetrievalResultRef
    locator: RetrievalLocator | None = None
    source_version: str | None = None
    created_at: datetime


class MessageRerankLedgerOut(BaseModel):
    """Selection/rerank pass ledger for one retrieval tool call."""

    id: UUID
    tool_call_id: UUID
    strategy: str
    input_count: int
    selected_count: int
    budget_chars: int | None = None
    selected_chars: int
    status: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


# Valid key modes for LLM calls
KEY_MODES = Literal["auto", "byok_only", "platform_only"]
REASONING_MODES = Literal["default", "none", "minimal", "low", "medium", "high", "max"]

# Max content length
MAX_MESSAGE_CONTENT_LENGTH = 20000
MAX_CONTEXTS = 10


class WebSearchOptions(BaseModel):
    """Explicit public-web search mode for chat runs."""

    mode: WEB_SEARCH_MODES
    freshness_days: int | None = Field(default=None, ge=1)
    allowed_domains: list[str] = Field(default_factory=list)
    blocked_domains: list[str] = Field(default_factory=list)

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class ArtifactIntentOptions(BaseModel):
    """Explicit generated-artifact intent for chat runs."""

    kind: ARTIFACT_INTENT_KINDS

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class MessageArtifactCitationEntryOut(BaseModel):
    """Citation manifest entry for one exported artifact part."""

    artifact_part_id: UUID
    ordinal: int
    part_key: str | None = None
    part_type: str | None = None
    source_version: str
    locator: RetrievalLocator
    source_ref: SourceRef | None = None
    context_ref: RetrievalContextRef | None = None
    result_ref: RetrievalResultRef | None = None
    evidence_span_id: UUID | None = None
    evidence_span_ids: list[UUID] = Field(default_factory=list)
    source_refs: list[SourceRef] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(extra="forbid")


class MessageArtifactCitationManifestOut(BaseModel):
    """Source manifest for an exported generated artifact."""

    artifact_id: UUID
    message_id: UUID
    conversation_id: UUID
    entries: list[MessageArtifactCitationEntryOut] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class MessageArtifactExportOut(BaseModel):
    """Strict export payload for a durable message artifact."""

    export_id: UUID
    format: Literal["markdown", "json", "html", "pdf", "csv"]
    artifact: MessageArtifactOut
    artifact_version: int
    citation_manifest: MessageArtifactCitationManifestOut
    content_sha256: str
    manifest_sha256: str
    exported_at: datetime
    content: str | dict[str, Any]

    model_config = ConfigDict(extra="forbid")


class MessageArtifactExportLedgerOut(BaseModel):
    """Append-only export ledger metadata for a durable message artifact."""

    id: UUID
    conversation_id: UUID
    message_id: UUID
    artifact_id: UUID
    viewer_user_id: UUID
    format: Literal["markdown", "json", "html", "pdf", "csv"]
    artifact_version: int
    content_sha256: str
    manifest_sha256: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime

    model_config = ConfigDict(extra="forbid")


class MessageArtifactPartProvenance(BaseModel):
    """Strict provenance for artifact and artifact-part ask context."""

    type: Literal["artifact", "artifact_part"]
    artifact_id: UUID
    artifact_kind: MESSAGE_ARTIFACT_KINDS | None = None
    message_id: UUID | None = None
    conversation_id: UUID | None = None
    artifact_key: str | None = None
    artifact_version: int | None = Field(default=None, ge=1)
    artifact_title: str | None = None
    artifact_part_id: UUID | None = None
    ordinal: int | None = None
    part_key: str | None = None
    part_type: str | None = None
    text: str | None = None
    source_version: str | None = None
    locator: RetrievalLocator | None = None
    source_ref: SourceRef | None = None
    context_ref: RetrievalContextRef | None = None
    result_ref: RetrievalResultRef | None = None
    evidence_span_id: UUID | None = None
    evidence_span_ids: list[UUID] = Field(default_factory=list)
    source_refs: list[SourceRef] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(extra="forbid")

    @field_validator("evidence_span_ids")
    @classmethod
    def validate_evidence_span_ids(cls, value: list[UUID]) -> list[UUID]:
        return trusted_evidence_span_ids(value)

    @model_validator(mode="after")
    def validate_artifact_part(self) -> "MessageArtifactPartProvenance":
        _validate_distinct_evidence_span_id_fields(
            self.evidence_span_id,
            self.evidence_span_ids,
        )
        if self.type == "artifact":
            return self
        if self.artifact_part_id is None or self.source_version is None or self.locator is None:
            raise ValueError(
                "artifact_part provenance requires artifact_part_id, source_version, and locator"
            )
        if self.locator.type != "artifact_part_ref":
            raise ValueError("artifact_part provenance locator must be artifact_part_ref")
        return self


def _validate_artifact_context_invariants(
    *,
    context_type: MESSAGE_CONTEXT_TYPES,
    context_id: UUID,
    artifact_id: UUID | None,
    artifact_key: str | None,
    artifact_version: int | None,
    source_version: str | None,
    locator: RetrievalLocator | None,
    provenance: MessageArtifactPartProvenance | None,
    missing_fields_message: str,
    artifact_message_prefix: str,
    provenance_message_prefix: str,
) -> None:
    if context_type == "artifact":
        if artifact_id is not None and artifact_id != context_id:
            raise ValueError(f"{artifact_message_prefix} artifact_id must match id")
        if provenance is None:
            return
        if provenance.type != "artifact":
            raise ValueError(f"{artifact_message_prefix} provenance must be artifact")
        if provenance.artifact_id != context_id:
            raise ValueError(f"{artifact_message_prefix} provenance artifact_id must match id")
        if (
            artifact_key is not None
            and provenance.artifact_key is not None
            and provenance.artifact_key != artifact_key
        ):
            raise ValueError(f"{artifact_message_prefix} provenance artifact_key must match")
        if (
            artifact_version is not None
            and provenance.artifact_version is not None
            and provenance.artifact_version != artifact_version
        ):
            raise ValueError(f"{artifact_message_prefix} provenance artifact_version must match")
        return

    if context_type != "artifact_part":
        return
    if artifact_id is None or source_version is None or locator is None:
        raise ValueError(missing_fields_message)
    if locator.type != "artifact_part_ref":
        raise ValueError(f"{provenance_message_prefix} locator must be artifact_part_ref")
    if provenance is None:
        raise ValueError(f"{provenance_message_prefix} require artifact_part_provenance")
    if provenance.type != "artifact_part":
        raise ValueError(f"{provenance_message_prefix} provenance must be artifact_part")
    if provenance.artifact_id != artifact_id:
        raise ValueError(f"{provenance_message_prefix} provenance artifact_id must match")
    if provenance.artifact_part_id != context_id:
        raise ValueError(f"{provenance_message_prefix} provenance artifact_part_id must match")
    if (
        artifact_key is not None
        and provenance.artifact_key is not None
        and provenance.artifact_key != artifact_key
    ):
        raise ValueError(f"{provenance_message_prefix} provenance artifact_key must match")
    if (
        artifact_version is not None
        and provenance.artifact_version is not None
        and provenance.artifact_version != artifact_version
    ):
        raise ValueError(f"{provenance_message_prefix} provenance artifact_version must match")
    if provenance.source_version != source_version:
        raise ValueError(f"{provenance_message_prefix} provenance source_version must match")
    if provenance.locator != locator:
        raise ValueError(f"{provenance_message_prefix} provenance locator must match")


class MessageArtifactAskRequest(BaseModel):
    """Create an artifact ask chat-run creation payload."""

    content: str = Field(..., min_length=1, max_length=MAX_MESSAGE_CONTENT_LENGTH)
    artifact_part_id: UUID | None = None
    model_id: UUID
    reasoning: REASONING_MODES = "default"
    key_mode: KEY_MODES = "auto"
    web_search: WebSearchOptions = Field(default_factory=lambda: WebSearchOptions(mode="off"))

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class AssistantVerifierRunListResponse(BaseModel):
    data: list[AssistantVerifierRunOut]

    model_config = ConfigDict(extra="forbid")


class MessageRetrievalCandidateLedgerListResponse(BaseModel):
    data: list[MessageRetrievalCandidateLedgerOut]

    model_config = ConfigDict(extra="forbid")


class MessageRerankLedgerListResponse(BaseModel):
    data: list[MessageRerankLedgerOut]

    model_config = ConfigDict(extra="forbid")


class MessageArtifactListResponse(BaseModel):
    data: list[MessageArtifactOut]

    model_config = ConfigDict(extra="forbid")


class MessageArtifactResponse(BaseModel):
    data: MessageArtifactOut

    model_config = ConfigDict(extra="forbid")


class MessageArtifactExportLedgerListResponse(BaseModel):
    data: list[MessageArtifactExportLedgerOut]

    model_config = ConfigDict(extra="forbid")


class MessageArtifactAskResponse(BaseModel):
    data: "ChatRunCreateRequest"

    model_config = ConfigDict(extra="forbid")


class PageInfo(BaseModel):
    """Pagination information for list responses."""

    next_cursor: str | None = None


# =============================================================================
# Request Schemas
# =============================================================================


# Note: CreateConversationRequest is empty in PR-02 (no body required).
# POST /conversations creates an empty private conversation.
# This is intentional per the spec.


# =============================================================================
# Chat-run request schemas
# =============================================================================


class MessageContextRef(BaseModel):
    """Canonical typed object reference for chat-run inputs."""

    kind: Literal["object_ref"] = "object_ref"
    type: MESSAGE_CONTEXT_TYPES
    id: UUID
    evidence_span_ids: list[UUID] = Field(default_factory=list)
    artifact_id: UUID | None = None
    artifact_key: str | None = Field(default=None, min_length=1, max_length=128)
    artifact_version: int | None = Field(default=None, ge=1)
    source_version: str | None = Field(default=None, min_length=1, max_length=256)
    locator: RetrievalLocator | None = None
    artifact_part_provenance: MessageArtifactPartProvenance | None = None

    model_config = ConfigDict(extra="forbid")

    @field_validator("evidence_span_ids")
    @classmethod
    def validate_evidence_span_ids(cls, value: list[UUID]) -> list[UUID]:
        return trusted_evidence_span_ids(value)

    @model_validator(mode="after")
    def validate_artifact_part_provenance(self) -> "MessageContextRef":
        _validate_artifact_context_invariants(
            context_type=self.type,
            context_id=self.id,
            artifact_id=self.artifact_id,
            artifact_key=self.artifact_key,
            artifact_version=self.artifact_version,
            source_version=self.source_version,
            locator=self.locator,
            provenance=self.artifact_part_provenance,
            missing_fields_message=(
                "artifact_part contexts require artifact_id, source_version, and locator"
            ),
            artifact_message_prefix="artifact contexts",
            provenance_message_prefix="artifact_part contexts",
        )
        return self


class ReaderSelectionContext(BaseModel):
    """Transient reader quote selection attached to a chat-run input."""

    kind: Literal["reader_selection"]
    client_context_id: UUID
    media_id: UUID
    media_kind: str = Field(..., min_length=1, max_length=80)
    media_title: str = Field(..., min_length=1, max_length=500)
    exact: str = Field(..., min_length=1, max_length=20000)
    prefix: str | None = Field(default=None, max_length=1000)
    suffix: str | None = Field(default=None, max_length=1000)
    locator: RetrievalLocator
    source_version: str = Field(min_length=1, max_length=256)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_reader_selection(self) -> "ReaderSelectionContext":
        if not self.media_kind.strip():
            raise ValueError("reader_selection media_kind cannot be blank")
        if not self.media_title.strip():
            raise ValueError("reader_selection media_title cannot be blank")
        if not self.exact.strip():
            raise ValueError("reader_selection exact quote cannot be blank")
        if not self.locator:
            raise ValueError("reader_selection locator must be a non-empty object")
        return self


ChatContextInput = Annotated[
    MessageContextRef | ReaderSelectionContext,
    Field(discriminator="kind"),
]

ContextItem = ChatContextInput


class NoBranchAnchorRequest(BaseModel):
    kind: Literal["none"] = "none"

    model_config = ConfigDict(extra="forbid")


class AssistantMessageBranchAnchorRequest(BaseModel):
    kind: Literal["assistant_message"]
    message_id: UUID

    model_config = ConfigDict(extra="forbid")


class AssistantSelectionBranchAnchorRequest(BaseModel):
    kind: Literal["assistant_selection"]
    message_id: UUID
    exact: str = Field(..., min_length=1, max_length=20000)
    prefix: str | None = Field(default=None, max_length=1000)
    suffix: str | None = Field(default=None, max_length=1000)
    offset_status: BRANCH_ANCHOR_OFFSET_STATUSES
    start_offset: int | None = None
    end_offset: int | None = None
    client_selection_id: str = Field(..., min_length=1, max_length=128)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_selection_anchor(self) -> "AssistantSelectionBranchAnchorRequest":
        if not self.exact.strip():
            raise ValueError("assistant_selection exact quote cannot be blank")
        return self


class ReaderContextBranchAnchorRequest(BaseModel):
    kind: Literal["reader_context"]

    model_config = ConfigDict(extra="forbid")


BranchAnchorRequest = Annotated[
    NoBranchAnchorRequest
    | AssistantMessageBranchAnchorRequest
    | AssistantSelectionBranchAnchorRequest
    | ReaderContextBranchAnchorRequest,
    Field(discriminator="kind"),
]


class ForkOptionOut(BaseModel):
    id: UUID
    parent_message_id: UUID
    user_message_id: UUID
    assistant_message_id: UUID | None = None
    leaf_message_id: UUID
    title: str | None = None
    preview: str
    branch_anchor_kind: BRANCH_ANCHOR_KINDS
    branch_anchor_preview: str | None = None
    status: Literal["complete", "pending", "error", "cancelled"]
    message_count: int
    created_at: datetime
    updated_at: datetime
    active: bool


class BranchGraphNodeOut(BaseModel):
    id: UUID
    message_id: UUID
    parent_message_id: UUID | None = None
    leaf_message_id: UUID
    role: Literal["user", "assistant"]
    depth: int
    row: int
    title: str | None = None
    preview: str
    branch_anchor_preview: str | None = None
    status: Literal["complete", "pending", "error", "cancelled"]
    message_count: int
    child_count: int
    active_path: bool
    leaf: bool
    created_at: datetime


class BranchGraphEdgeOut(BaseModel):
    from_message_id: UUID
    to: UUID

    @model_serializer(mode="plain")
    def serialize_edge(self) -> dict[str, UUID]:
        return {"from": self.from_message_id, "to": self.to}


class BranchGraphOut(BaseModel):
    nodes: list[BranchGraphNodeOut] = Field(default_factory=list)
    edges: list[BranchGraphEdgeOut] = Field(default_factory=list)
    root_message_id: UUID | None = None


class ConversationTreeOut(BaseModel):
    conversation: ConversationOut
    selected_path: list[MessageOut]
    active_leaf_message_id: UUID | None = None
    fork_options_by_parent_id: dict[str, list[ForkOptionOut]] = Field(default_factory=dict)
    path_cache_by_leaf_id: dict[str, list[MessageOut]] = Field(default_factory=dict)
    branch_graph: BranchGraphOut = Field(default_factory=BranchGraphOut)
    page: dict[str, str | None] = Field(default_factory=lambda: {"before_cursor": None})


class ConversationForksOut(BaseModel):
    forks: list[ForkOptionOut]


class SetActivePathRequest(BaseModel):
    active_leaf_message_id: UUID


class RenameBranchRequest(BaseModel):
    title: str | None = Field(default=None, max_length=120)

    model_config = ConfigDict(str_strip_whitespace=True)

    @model_validator(mode="after")
    def validate_title(self) -> "RenameBranchRequest":
        if self.title is not None and not self.title.strip():
            raise ValueError("title cannot be blank")
        return self


class MessageContextSnapshot(BaseModel):
    """Hydrated message-context snapshot returned on message reads."""

    kind: MESSAGE_CONTEXT_KINDS = "object_ref"
    type: MESSAGE_CONTEXT_TYPES | None = None
    id: UUID | None = None
    evidence_span_ids: list[UUID] = Field(default_factory=list)
    client_context_id: UUID | None = None
    color: HIGHLIGHT_COLORS | None = None
    preview: str | None = None
    exact: str | None = None
    prefix: str | None = None
    suffix: str | None = None
    media_id: UUID | None = None
    source_media_id: UUID | None = None
    media_title: str | None = None
    media_kind: str | None = None
    locator: RetrievalLocator | None = None
    source_version: str | None = None
    title: str | None = None
    route: str | None = None

    @model_validator(mode="after")
    def validate_hydrated_snapshot(self) -> "MessageContextSnapshot":
        if self.kind == "object_ref":
            missing: list[str] = []
            if self.type is None:
                missing.append("type")
            if self.id is None:
                missing.append("id")
            if self.title is None or not self.title.strip():
                missing.append("title")
            if missing:
                raise ValueError(
                    "object_ref message context snapshots require " + ", ".join(missing)
                )
            return self

        missing = []
        if self.client_context_id is None:
            missing.append("client_context_id")
        if self.media_id is None:
            missing.append("media_id")
        if self.source_media_id is None:
            missing.append("source_media_id")
        if self.media_title is None or not self.media_title.strip():
            missing.append("media_title")
        if self.media_kind is None or not self.media_kind.strip():
            missing.append("media_kind")
        if self.exact is None or not self.exact.strip():
            missing.append("exact")
        if self.locator is None:
            missing.append("locator")
        if self.source_version is None or not self.source_version.strip():
            missing.append("source_version")
        if missing:
            raise ValueError(
                "reader_selection message context snapshots require " + ", ".join(missing)
            )
        return self

    @field_serializer("id", when_used="json")
    def serialize_context_id(self, value: UUID | None) -> str | None:
        if value is None:
            return None
        if self.type == "contributor" and self.route:
            prefix = "/authors/"
            if self.route.startswith(prefix):
                handle = self.route[len(prefix) :].split("/", 1)[0].strip()
                if handle:
                    return handle
        return str(value)

    @model_serializer(mode="wrap")
    def serialize_snapshot(self, handler: Any) -> dict[str, Any]:
        data = handler(self)
        serialized = {key: value for key, value in data.items() if value is not None}
        if (
            serialized.get("kind") == "reader_selection"
            and serialized.get("evidence_span_ids") == []
        ):
            serialized.pop("evidence_span_ids")
        if isinstance(serialized.get("locator"), dict):
            serialized["locator"] = {
                key: value for key, value in serialized["locator"].items() if value is not None
            }
        return serialized


class MessageArtifactContextSnapshot(MessageContextSnapshot):
    artifact_id: UUID
    artifact_key: str = Field(min_length=1, max_length=128)
    artifact_version: int = Field(ge=1)
    artifact_part_provenance: MessageArtifactPartProvenance

    @model_validator(mode="after")
    def validate_artifact_provenance(self) -> "MessageArtifactContextSnapshot":
        if self.kind != "object_ref" or self.type != "artifact" or self.id is None:
            raise ValueError("artifact message context snapshots require object_ref artifact id")
        _validate_artifact_context_invariants(
            context_type=self.type,
            context_id=self.id,
            artifact_id=self.artifact_id,
            artifact_key=self.artifact_key,
            artifact_version=self.artifact_version,
            source_version=self.source_version,
            locator=self.locator,
            provenance=self.artifact_part_provenance,
            missing_fields_message=(
                "artifact_part message context snapshots require "
                "artifact_id, source_version, and locator"
            ),
            artifact_message_prefix="artifact message context snapshots",
            provenance_message_prefix="artifact_part message context snapshots",
        )
        return self


class MessageArtifactPartContextSnapshot(MessageContextSnapshot):
    artifact_id: UUID
    artifact_key: str | None = Field(default=None, min_length=1, max_length=128)
    artifact_version: int | None = Field(default=None, ge=1)
    artifact_part_provenance: MessageArtifactPartProvenance

    @model_validator(mode="after")
    def validate_artifact_part_provenance(self) -> "MessageArtifactPartContextSnapshot":
        if self.kind != "object_ref" or self.type != "artifact_part" or self.id is None:
            raise ValueError(
                "artifact_part message context snapshots require object_ref artifact_part id"
            )
        _validate_artifact_context_invariants(
            context_type=self.type,
            context_id=self.id,
            artifact_id=self.artifact_id,
            artifact_key=self.artifact_key,
            artifact_version=self.artifact_version,
            source_version=self.source_version,
            locator=self.locator,
            provenance=self.artifact_part_provenance,
            missing_fields_message=(
                "artifact_part message context snapshots require "
                "artifact_id, source_version, and locator"
            ),
            artifact_message_prefix="artifact message context snapshots",
            provenance_message_prefix="artifact_part message context snapshots",
        )
        return self


MessageContextSnapshotOut = (
    MessageArtifactContextSnapshot | MessageArtifactPartContextSnapshot | MessageContextSnapshot
)


class ChatRunCreateRequest(BaseModel):
    """Request schema for creating a durable chat run."""

    conversation_id: UUID | None = None
    conversation_scope: ConversationScopeRequest | None = None
    parent_message_id: UUID | None = None
    branch_anchor: BranchAnchorRequest = Field(default_factory=NoBranchAnchorRequest)
    content: str
    model_id: UUID
    reasoning: REASONING_MODES = "default"
    key_mode: KEY_MODES = "auto"
    contexts: list[ChatContextInput] = Field(default_factory=list)
    web_search: WebSearchOptions
    artifact_intent: ArtifactIntentOptions

    model_config = ConfigDict(str_strip_whitespace=True)


class ChatRunOut(BaseModel):
    """Response schema for a durable chat run."""

    id: UUID
    status: CHAT_RUN_STATUSES
    conversation_id: UUID
    user_message_id: UUID
    assistant_message_id: UUID
    model_id: UUID
    reasoning: str
    key_mode: str
    artifact_intent: ArtifactIntentOptions
    cancel_requested_at: datetime | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    error_code: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ChatRunResponse(BaseModel):
    """Response schema for create/read chat-run endpoints."""

    run: ChatRunOut
    conversation: ConversationOut
    user_message: MessageOut
    assistant_message: MessageOut


class ChatRunEventOut(BaseModel):
    """Persisted stream event for a chat run."""

    seq: int
    event_type: CHAT_RUN_EVENT_TYPES
    payload: dict[str, Any]
    created_at: datetime

    @model_validator(mode="after")
    def validate_payload(self) -> "ChatRunEventOut":
        self.payload = chat_run_event_payload_json(self.event_type, self.payload)
        return self


# =============================================================================
# S4 PR-06: Conversation Share Schemas
# =============================================================================


class SetConversationSharesRequest(BaseModel):
    """Request schema for PUT /conversations/{id}/shares.

    Replaces all share targets atomically. Duplicate library_ids are deduped.
    """

    sharing: Literal["library"]
    library_ids: list[UUID]


class ConversationShareTargetOut(BaseModel):
    """A single share target in a conversation share list."""

    library_id: UUID
    created_at: datetime


class ConversationSharesOut(BaseModel):
    """Response schema for GET/PUT /conversations/{id}/shares."""

    conversation_id: UUID
    sharing: str
    shares: list[ConversationShareTargetOut]
