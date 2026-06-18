"""Conversation and Message Pydantic schemas.

Contains request and response models for conversation and message endpoints.

Message creation happens through durable chat runs.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    model_serializer,
    model_validator,
)

from nexus.llm_catalog import LLMKeyMode, ReasoningMode
from nexus.schemas.citation import CitationOut, CitationRole, CitationTargetRef
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.schemas.retrieval import RetrievalContextRef, RetrievalLocator, RetrievalResultRef
from nexus.schemas.search import SEARCH_RESULT_TYPES

# Valid sharing modes - must match DB constraint
SHARING_MODES = Literal["private", "library", "public"]

# Valid message roles - must match DB constraint
MESSAGE_ROLES = Literal["user", "assistant", "system"]

# Valid message statuses - must match DB constraint
MESSAGE_STATUSES = Literal["pending", "complete", "error", "cancelled"]

# Valid assistant tool-call statuses - must match message_tool_calls.status
MESSAGE_TOOL_STATUSES = Literal["pending", "running", "complete", "error", "cancelled"]
WEB_SEARCH_RESULT_TYPES = Literal["web", "news", "mixed"]
CHAT_RUN_STATUSES = Literal["queued", "running", "complete", "error", "cancelled"]
# Filter vocabulary for GET /chat-runs: the run statuses plus the synthetic
# "active" (non-terminal) filter. Owned once at the boundary; the service maps it.
CHAT_RUN_STATUS_FILTER = Literal["active", "queued", "running", "complete", "error", "cancelled"]
BRANCH_ANCHOR_KINDS = Literal[
    "none",
    "assistant_message",
    "assistant_selection",
]
BRANCH_ANCHOR_OFFSET_STATUSES = Literal["mapped", "unmapped"]
CHAT_RUN_EVENT_TYPES = Literal[
    "meta",
    "assistant_activity",
    "assistant_text_delta",
    "tool_call_start",
    "tool_call_delta",
    "tool_call_done",
    "tool_result",
    "citation_index",
    "context_ref_added",
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
CANDIDATE_INCLUDED_IN_PROMPT_SOURCES = Literal["candidate_ledger", "linked_retrieval"]


# =============================================================================
# Response Schemas
# =============================================================================


class ConversationOut(BaseModel):
    """Response schema for a conversation.

    Conversations are owned by exactly one user. Owner fields:
    - owner_user_id: UUID of the conversation owner
    - is_owner: viewer-local convenience flag
    """

    id: UUID
    title: str
    owner_user_id: UUID
    is_owner: bool
    sharing: str  # "private" | "library" | "public"
    message_count: int
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True, extra="forbid")


class MessageDocumentTextBlock(BaseModel):
    type: Literal["text"]
    format: Literal["plain", "markdown"]
    text: str

    model_config = ConfigDict(extra="forbid")


class MessageDocument(BaseModel):
    type: Literal["message_document"] = "message_document"
    blocks: list[MessageDocumentTextBlock] = Field(default_factory=list)

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
    # Citations rehydrated from the assistant message's citation edges (AC23/§5.2);
    # empty for user/system messages and assistants with no cited evidence.
    citations: list[CitationOut] = Field(default_factory=list)
    trust_trail: AssistantTrustTrailOut | None = None
    parent_message_id: UUID | None = None
    branch_root_message_id: UUID | None = None
    branch_anchor_kind: BRANCH_ANCHOR_KINDS = "none"
    branch_anchor: dict[str, Any] = Field(default_factory=dict)
    status: str  # "pending" | "complete" | "error" | "cancelled"
    error_code: str | None = None
    can_retry_response: bool = False
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True, extra="forbid")

    @model_validator(mode="after")
    def validate_trust_trail_role(self) -> MessageOut:
        if self.role == "assistant" and self.trust_trail is None:
            raise ValueError("assistant messages require trust_trail")
        if self.role != "assistant" and self.trust_trail is not None:
            raise ValueError("only assistant messages may carry trust_trail")
        return self


class MessageRetrievalOut(BaseModel):
    """Persisted app-search retrieval metadata for assistant tool calls."""

    id: UUID
    tool_call_id: UUID
    ordinal: int
    result_type: SEARCH_RESULT_TYPES
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
    created_at: datetime

    model_config = ConfigDict(from_attributes=True, extra="forbid")

    @model_validator(mode="after")
    def validate_ref_type_parity(self) -> MessageRetrievalOut:
        expected_context_type = (
            "media" if self.result_type in {"episode", "video"} else self.result_type
        )
        if self.context_ref.type != expected_context_type:
            raise ValueError("context_ref.type must match result_type")
        if self.result_ref.type != self.result_type:
            raise ValueError("result_ref.type must match result_type")
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


class ChatRunMetaSubjectPayload(BaseModel):
    requested_resource_ref: str
    resource_ref: str
    context_edge_id: UUID | None = None
    companions: list[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class ChatRunMetaEventPayload(BaseModel):
    """Strict SSE payload emitted when a durable run is created."""

    run_id: UUID
    conversation_id: UUID
    user_message_id: UUID
    assistant_message_id: UUID
    model_id: UUID
    provider: str = Field(min_length=1)
    chat_subject: ChatRunMetaSubjectPayload | None

    model_config = ConfigDict(extra="forbid")


class ChatRunAssistantActivityEventPayload(BaseModel):
    """Strict SSE payload for safe assistant activity state."""

    assistant_message_id: UUID
    phase: Literal[
        "queued",
        "thinking",
        "writing",
        "tool_calling",
        "waiting",
        "retrying",
        "cancelling",
    ]
    label: str | None = None
    provider_event_seq_start: int | None = Field(default=None, ge=0)
    provider_event_seq_end: int | None = Field(default=None, ge=0)

    model_config = ConfigDict(extra="forbid")


class ChatRunAssistantTextDeltaEventPayload(BaseModel):
    """Strict SSE payload for assistant text deltas."""

    assistant_message_id: UUID
    text: str = Field(min_length=1)
    provider_event_seq_start: int = Field(ge=0)
    provider_event_seq_end: int = Field(ge=0)

    model_config = ConfigDict(extra="forbid")


class ChatRunToolCallStartEventPayload(BaseModel):
    """Strict SSE payload for provider tool-call start."""

    tool_call_id: UUID | None = None
    assistant_message_id: UUID
    tool_name: str = Field(min_length=1)
    tool_call_index: int = Field(ge=0)
    provider_tool_call_id: str | None = Field(default=None, min_length=1)
    provider_event_seq_start: int = Field(ge=0)
    provider_event_seq_end: int = Field(ge=0)

    model_config = ConfigDict(extra="forbid")


class ChatRunToolCallDeltaEventPayload(BaseModel):
    """Strict SSE payload for render-only provider tool argument deltas."""

    tool_call_id: UUID | None = None
    assistant_message_id: UUID
    tool_name: str = Field(min_length=1)
    tool_call_index: int = Field(ge=0)
    provider_tool_call_id: str | None = Field(default=None, min_length=1)
    input_delta: str = Field(min_length=1)
    input_preview: str | None = Field(default=None, max_length=512)
    provider_event_seq_start: int = Field(ge=0)
    provider_event_seq_end: int = Field(ge=0)

    model_config = ConfigDict(extra="forbid")


class ChatRunToolCallDoneEventPayload(BaseModel):
    """Strict SSE payload for a complete provider tool call."""

    tool_call_id: UUID | None = None
    assistant_message_id: UUID
    tool_name: str = Field(min_length=1)
    tool_call_index: int = Field(ge=0)
    provider_tool_call_id: str | None = Field(default=None, min_length=1)
    input: dict[str, Any]
    provider_event_seq_start: int = Field(ge=0)
    provider_event_seq_end: int = Field(ge=0)

    model_config = ConfigDict(extra="forbid")


class ChatRunToolResultEventPayload(BaseModel):
    """Strict SSE payload for executed app/tool results."""

    tool_call_id: UUID | None = None
    assistant_message_id: UUID
    tool_name: str = Field(min_length=1)
    tool_call_index: int = Field(ge=0)
    status: MESSAGE_TOOL_STATUSES
    scope: str = Field(min_length=1)
    types: list[str]
    filters: dict[str, Any]
    error_code: str | None = None
    result_count: int | None = Field(default=None, ge=0)
    selected_count: int | None = Field(default=None, ge=0)
    latency_ms: int | None = Field(default=None, ge=0)
    provider_request_ids: list[str] = Field(default_factory=list)
    results: list[RetrievalResultRef] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class ChatRunDoneEventPayload(BaseModel):
    """Strict SSE payload emitted when a run reaches a terminal status."""

    status: Literal["complete", "error", "cancelled"]
    usage: dict[str, Any] | None = None
    error_code: str | None = None
    final_chars: int | None = Field(default=None, ge=0)
    last_provider_event_seq: int | None = Field(default=None, ge=0)
    cancelled: bool | None = None

    model_config = ConfigDict(extra="forbid")


class ChatRunCitationIndexItem(BaseModel):
    """One citation edge paired with the backend-built citation read model."""

    citation_edge_id: UUID
    citation: CitationOut

    model_config = ConfigDict(extra="forbid")


class ChatRunCitationIndexEventPayload(BaseModel):
    """Strict SSE payload carrying backend-built citation read models."""

    assistant_message_id: UUID
    citations: list[ChatRunCitationIndexItem]

    model_config = ConfigDict(extra="forbid")


class ChatRunContextRefAddedEventPayload(BaseModel):
    """Strict SSE payload for a citation-materialized context edge (ContextRefOut shape)."""

    id: UUID
    conversation_id: UUID
    resource_ref: str = Field(min_length=1)
    activation: ResourceActivationOut
    label: str
    summary: str
    missing: bool
    created_at: datetime
    citation_edge_id: UUID | None

    model_config = ConfigDict(extra="forbid")


def chat_run_event_payload_json(event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Validate strict chat-run SSE payloads before storage/replay."""

    if event_type == "meta":
        return ChatRunMetaEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "assistant_activity":
        return ChatRunAssistantActivityEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "assistant_text_delta":
        return ChatRunAssistantTextDeltaEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "tool_call_start":
        return ChatRunToolCallStartEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "tool_call_delta":
        return ChatRunToolCallDeltaEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "tool_call_done":
        return ChatRunToolCallDoneEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "tool_result":
        return ChatRunToolResultEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "citation_index":
        return ChatRunCitationIndexEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "context_ref_added":
        return ChatRunContextRefAddedEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "done":
        return ChatRunDoneEventPayload.model_validate(payload).model_dump(mode="json")
    raise ValueError("unknown chat-run event type")


class MessageRetrievalCandidateLedgerOut(BaseModel):
    """Retrieval candidate ledger row with honest prompt-inclusion status."""

    id: UUID
    tool_call_id: UUID
    retrieval_id: UUID | None = None
    ordinal: int
    result_type: SEARCH_RESULT_TYPES
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
    created_at: datetime

    model_config = ConfigDict(extra="forbid")


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

    model_config = ConfigDict(extra="forbid")


TRUST_TRAIL_VERSION = "assistant_trust_trail.v1"


class TrustPromptAssemblyOut(BaseModel):
    id: UUID
    cacheable_input_tokens_estimate: int
    prompt_block_manifest: dict[str, Any]
    max_context_tokens: int
    reserved_output_tokens: int
    reserved_reasoning_tokens: int
    input_budget_tokens: int
    estimated_input_tokens: int
    included_message_ids: list[str]
    included_retrieval_ids: list[str]
    included_context_refs: list[dict[str, Any]]
    dropped_items: list[dict[str, Any]]
    budget_breakdown: dict[str, Any]
    created_at: datetime

    model_config = ConfigDict(extra="forbid")


class TrustRunOut(BaseModel):
    run_id: UUID
    model_id: UUID
    provider: str
    model_name: str
    reasoning_mode: str | None = None
    key_mode: str | None = None
    status: Literal["pending", "running", "complete", "error", "cancelled"]
    usage: dict[str, Any] | None = None
    error_code: str | None = None
    final_chars: int | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None

    model_config = ConfigDict(extra="forbid")


class TrustRetrievalOut(MessageRetrievalOut):
    cited_edge_id: UUID | None = None
    citation_number: int | None = None
    citation_role: CitationRole | None = None
    included_in_prompt_source: Literal[
        "retrieval", "candidate_ledger", "prompt_assembly", "none"
    ] = "retrieval"


class TrustToolCallOut(BaseModel):
    id: UUID
    tool_name: str
    tool_call_index: int
    status: MESSAGE_TOOL_STATUSES
    scope: str
    requested_types: list[str]
    query_hash: str | None = None
    latency_ms: int | None = None
    result_count: int
    selected_count: int
    error_code: str | None = None
    provider_request_ids: list[str]
    result_refs: list[dict[str, Any]]
    selected_context_refs: list[dict[str, Any]]
    retrievals: list[TrustRetrievalOut] = Field(default_factory=list)
    candidate_ledgers: list[MessageRetrievalCandidateLedgerOut] = Field(default_factory=list)
    rerank_ledgers: list[MessageRerankLedgerOut] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(extra="forbid")


class TrustCitationOut(BaseModel):
    citation_edge_id: UUID
    ordinal: int
    role: CitationRole
    target_ref: CitationTargetRef
    retrieval_id: UUID | None = None
    tool_call_id: UUID | None = None
    citation: CitationOut

    model_config = ConfigDict(extra="forbid")


class TrustContextRefAddedOut(BaseModel):
    chat_run_event_seq: int
    id: UUID
    conversation_id: UUID
    resource_ref: str
    label: str
    summary: str
    missing: bool
    created_at: datetime
    citation_edge_id: UUID | None = None

    model_config = ConfigDict(extra="forbid")


class TrustIntegrityNoticeOut(BaseModel):
    code: str
    message: str

    model_config = ConfigDict(extra="forbid")


class AssistantTrustTrailOut(BaseModel):
    schema_version: Literal["assistant_trust_trail.v1"] = TRUST_TRAIL_VERSION
    assistant_message_id: UUID
    conversation_id: UUID
    chat_run_id: UUID | None = None
    status: Literal["pending", "running", "complete", "error", "cancelled"]
    run: TrustRunOut | None = None
    prompt: TrustPromptAssemblyOut | None = None
    tool_calls: list[TrustToolCallOut] = Field(default_factory=list)
    citations: list[TrustCitationOut] = Field(default_factory=list)
    context_refs_added: list[TrustContextRefAddedOut] = Field(default_factory=list)
    integrity_notices: list[TrustIntegrityNoticeOut] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(extra="forbid")


MessageOut.model_rebuild()


# Max content length
MAX_MESSAGE_CONTENT_LENGTH = 20000


class PageInfo(BaseModel):
    """Pagination information for list responses."""

    next_cursor: str | None = None


class MessagePageInfo(BaseModel):
    """Pagination information for selected-path message windows."""

    next_cursor: str | None = None
    before_cursor: str | None = None


# =============================================================================
# Request Schemas
# =============================================================================


# Note: conversation creation has no request body.
# POST /conversations creates an empty private conversation.


# =============================================================================
# Chat-run request schemas
# =============================================================================


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
    def validate_selection_anchor(self) -> AssistantSelectionBranchAnchorRequest:
        if not self.exact.strip():
            raise ValueError("assistant_selection exact quote cannot be blank")
        return self


BranchAnchorRequest = Annotated[
    NoBranchAnchorRequest
    | AssistantMessageBranchAnchorRequest
    | AssistantSelectionBranchAnchorRequest,
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
    def validate_title(self) -> RenameBranchRequest:
        if self.title is not None and not self.title.strip():
            raise ValueError("title cannot be blank")
        return self


class ReaderSelectionRequest(BaseModel):
    """The exact passage the viewer is asking about — a bind-only turn anchor.

    Resolves pronouns ("this", "the quote"); the durable turn identity is stored
    as media/highlight ids and is never itself cited. The citable attachment is
    the `highlight:` reference.
    """

    exact: str = Field(..., min_length=1, max_length=20000)
    prefix: str | None = Field(default=None, max_length=1000)
    suffix: str | None = Field(default=None, max_length=1000)
    media_id: UUID
    highlight_id: UUID

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def _exact_not_blank(self) -> ReaderSelectionRequest:
        if not self.exact.strip():
            raise ValueError("reader_selection exact quote cannot be blank")
        return self


class ChatSubjectRequest(BaseModel):
    resource_ref: str = Field(..., min_length=1)

    model_config = ConfigDict(extra="forbid")


class ChatRunCreateRequest(BaseModel):
    """Request schema for creating a durable chat run."""

    conversation_id: UUID
    parent_message_id: UUID | None = None
    branch_anchor: BranchAnchorRequest = Field(default_factory=NoBranchAnchorRequest)
    content: str
    model_id: UUID
    reasoning: ReasoningMode
    key_mode: LLMKeyMode
    chat_subject: ChatSubjectRequest | None = None
    reader_selection: ReaderSelectionRequest | None = None

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


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
    cancel_requested_at: datetime | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    error_code: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ChatRunStreamActivityOut(BaseModel):
    phase: Literal[
        "queued", "thinking", "writing", "tool_calling", "waiting", "retrying", "cancelling"
    ]
    label: str | None = None

    model_config = ConfigDict(extra="forbid")


class ChatRunStreamToolCallOut(BaseModel):
    id: UUID | None = None
    assistant_message_id: UUID
    tool_name: str
    tool_call_index: int = Field(ge=0)
    status: MESSAGE_TOOL_STATUSES = "running"
    scope: str = "provider_tool"
    requested_types: list[str] = Field(default_factory=list)
    result_refs: list[dict[str, Any]] = Field(default_factory=list)
    selected_context_refs: list[dict[str, Any]] = Field(default_factory=list)
    provider_request_ids: list[str] = Field(default_factory=list)
    result_count: int = 0
    selected_count: int = 0
    retrievals: list[TrustRetrievalOut] = Field(default_factory=list)
    candidate_ledgers: list[MessageRetrievalCandidateLedgerOut] = Field(default_factory=list)
    rerank_ledgers: list[MessageRerankLedgerOut] = Field(default_factory=list)
    input_preview: str | None = None

    model_config = ConfigDict(extra="forbid")


class ChatRunStreamStateOut(BaseModel):
    """Materialized cursor state for reconnecting a chat stream."""

    status: Literal["queued", "running", "complete", "error", "cancelled", "interrupted"]
    last_event_seq: int = Field(ge=0)
    folded_event_seq: int = Field(ge=0)
    assistant_current_text: str
    tool_calls: list[ChatRunStreamToolCallOut] = Field(default_factory=list)
    activity: ChatRunStreamActivityOut | None = None
    reconnectable: bool
    terminal: bool

    model_config = ConfigDict(extra="forbid")


class ChatRunResponse(BaseModel):
    """Response schema for create/read chat-run endpoints."""

    run: ChatRunOut
    conversation: ConversationOut
    user_message: MessageOut
    assistant_message: MessageOut
    stream_state: ChatRunStreamStateOut


class ChatRunEventOut(BaseModel):
    """Persisted stream event for a chat run."""

    seq: int
    event_type: CHAT_RUN_EVENT_TYPES
    payload: dict[str, Any]
    created_at: datetime

    @model_validator(mode="after")
    def validate_payload(self) -> ChatRunEventOut:
        self.payload = chat_run_event_payload_json(self.event_type, self.payload)
        return self


# =============================================================================
# Conversation Share Schemas
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
