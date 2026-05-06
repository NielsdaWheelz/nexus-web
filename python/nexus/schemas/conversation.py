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
    model_serializer,
    model_validator,
)

from nexus.schemas.context_memory import ConversationMemoryInspectionOut
from nexus.schemas.contributors import ContributorCreditOut

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
    "contributor",
]

MESSAGE_CONTEXT_KINDS = Literal["object_ref", "reader_selection"]

# Valid conversation scopes - must match conversations.scope_type
CONVERSATION_SCOPE_TYPES = Literal["general", "media", "library"]

# Valid highlight colors surfaced on context snapshots
HIGHLIGHT_COLORS = Literal["yellow", "green", "blue", "pink", "purple"]

# Valid assistant app-search result types - must match message_retrievals.result_type
APP_SEARCH_RESULT_TYPES = Literal[
    "page",
    "note_block",
    "media",
    "podcast",
    "content_chunk",
    "message",
    "contributor",
    "web_result",
]

# Valid assistant tool-call statuses - must match message_tool_calls.status
MESSAGE_TOOL_STATUSES = Literal["pending", "complete", "error"]
WEB_SEARCH_MODES = Literal["off", "auto", "required"]
WEB_SEARCH_RESULT_TYPES = Literal["web", "news", "mixed"]
CHAT_RUN_STATUSES = Literal["queued", "running", "complete", "error", "cancelled"]
BRANCH_ANCHOR_KINDS = Literal[
    "none",
    "assistant_message",
    "assistant_selection",
    "reader_context",
]
BRANCH_ANCHOR_OFFSET_STATUSES = Literal["mapped", "unmapped"]
CHAT_RUN_EVENT_TYPES = Literal["meta", "tool_call", "tool_result", "citation", "delta", "done"]
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
EVIDENCE_VERIFIER_STATUSES = Literal["verified", "failed"]


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

    model_config = ConfigDict(from_attributes=True)


class MessageOut(BaseModel):
    """Response schema for a message.

    Messages are immutable after creation (content immutable after status=complete).
    Messages are ordered by seq within a conversation.
    """

    id: UUID
    seq: int
    role: str  # "user" | "assistant" | "system"
    content: str
    parent_message_id: UUID | None = None
    branch_root_message_id: UUID | None = None
    branch_anchor_kind: BRANCH_ANCHOR_KINDS = "none"
    branch_anchor: dict[str, Any] = Field(default_factory=dict)
    contexts: list["MessageContextSnapshot"] = Field(default_factory=list)
    tool_calls: list["MessageToolCallOut"] = Field(default_factory=list)
    evidence_summary: "MessageEvidenceSummaryOut | None" = None
    claims: list["MessageClaimOut"] = Field(default_factory=list)
    claim_evidence: list["MessageClaimEvidenceOut"] = Field(default_factory=list)
    status: str  # "pending" | "complete" | "error"
    error_code: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


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
    context_ref: dict[str, Any]
    result_ref: dict[str, Any]
    deep_link: str | None = None
    score: float | None = None
    selected: bool
    source_title: str | None = None
    section_label: str | None = None
    exact_snippet: str | None = None
    snippet_prefix: str | None = None
    snippet_suffix: str | None = None
    locator: dict[str, Any] | None = None
    retrieval_status: EVIDENCE_RETRIEVAL_STATUSES = "retrieved"
    included_in_prompt: bool = False
    source_version: str | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class MessageEvidenceSummaryOut(BaseModel):
    """Final evidence status for one assistant message."""

    id: UUID
    message_id: UUID
    scope_type: CONVERSATION_SCOPE_TYPES
    scope_ref: dict[str, Any] | None = None
    retrieval_status: EVIDENCE_RETRIEVAL_STATUSES
    support_status: CLAIM_SUPPORT_STATUSES
    verifier_status: EVIDENCE_VERIFIER_STATUSES
    claim_count: int
    supported_claim_count: int
    unsupported_claim_count: int
    not_enough_evidence_count: int
    prompt_assembly_id: UUID | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class MessageClaimOut(BaseModel):
    """One persisted claim from an assistant answer."""

    id: UUID
    message_id: UUID
    ordinal: int
    claim_text: str
    answer_start_offset: int | None = None
    answer_end_offset: int | None = None
    claim_kind: str
    support_status: CLAIM_SUPPORT_STATUSES
    verifier_status: EVIDENCE_VERIFIER_STATUSES
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class MessageClaimEvidenceOut(BaseModel):
    """One persisted source snapshot for a claim."""

    id: UUID
    claim_id: UUID
    ordinal: int
    evidence_role: CLAIM_EVIDENCE_ROLES
    source_ref: dict[str, Any]
    retrieval_id: UUID | None = None
    evidence_span_id: UUID | None = None
    context_ref: dict[str, Any] | None = None
    result_ref: dict[str, Any] | None = None
    exact_snippet: str | None = None
    snippet_prefix: str | None = None
    snippet_suffix: str | None = None
    locator: dict[str, Any] | None = None
    deep_link: str | None = None
    score: float | None = None
    retrieval_status: EVIDENCE_RETRIEVAL_STATUSES
    selected: bool
    included_in_prompt: bool
    source_version: str | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class MessageToolCallOut(BaseModel):
    """Persisted assistant tool-call metadata linked to a message pair."""

    id: UUID
    conversation_id: UUID
    user_message_id: UUID
    assistant_message_id: UUID
    tool_name: str
    tool_call_index: int
    query_hash: str | None = None
    scope: str
    requested_types: list[str] = Field(default_factory=list)
    semantic: bool
    result_refs: list[dict[str, Any]] = Field(default_factory=list)
    selected_context_refs: list[dict[str, Any]] = Field(default_factory=list)
    provider_request_ids: list[str] = Field(default_factory=list)
    latency_ms: int | None = None
    status: MESSAGE_TOOL_STATUSES
    error_code: str | None = None
    created_at: datetime
    updated_at: datetime
    retrievals: list[MessageRetrievalOut] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class WebSearchOptions(BaseModel):
    """Explicit public-web search mode for chat runs."""

    mode: WEB_SEARCH_MODES
    freshness_days: int | None = Field(default=None, ge=1)
    allowed_domains: list[str] = Field(default_factory=list)
    blocked_domains: list[str] = Field(default_factory=list)

    model_config = ConfigDict(str_strip_whitespace=True)


class PageInfo(BaseModel):
    """Pagination information for list responses."""

    next_cursor: str | None = None


class ConversationListResponse(BaseModel):
    """Response for listing conversations with pagination."""

    data: list[ConversationOut]
    page: PageInfo


class MessageListResponse(BaseModel):
    """Response for listing messages with pagination."""

    data: list[MessageOut]
    page: PageInfo


# =============================================================================
# Request Schemas
# =============================================================================


# Note: CreateConversationRequest is empty in PR-02 (no body required).
# POST /conversations creates an empty private conversation.
# This is intentional per the spec.


# =============================================================================
# Chat-run request schemas
# =============================================================================


# Valid key modes for LLM calls
KEY_MODES = Literal["auto", "byok_only", "platform_only"]
REASONING_MODES = Literal["default", "none", "minimal", "low", "medium", "high", "max"]

# Max content length
MAX_MESSAGE_CONTENT_LENGTH = 20000
MAX_CONTEXTS = 10


class MessageContextRef(BaseModel):
    """Canonical typed object reference for chat-run inputs."""

    kind: Literal["object_ref"] = "object_ref"
    type: MESSAGE_CONTEXT_TYPES
    id: UUID
    evidence_span_ids: list[UUID] = Field(default_factory=list)

    model_config = ConfigDict(extra="ignore")


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
    locator: dict[str, Any]

    model_config = ConfigDict(extra="ignore")

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


class BranchAnchorOut(BaseModel):
    kind: BRANCH_ANCHOR_KINDS
    data: dict[str, Any] = Field(default_factory=dict)


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
    locator: dict[str, Any] | None = None
    title: str | None = None
    route: str | None = None

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
        return serialized


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


class StreamMetaEvent(BaseModel):
    """SSE meta event at stream start."""

    conversation_id: UUID
    user_message_id: UUID
    assistant_message_id: UUID
    model_id: UUID
    provider: str


class StreamDeltaEvent(BaseModel):
    """SSE delta event with incremental content."""

    delta: str


class StreamDoneEvent(BaseModel):
    """SSE done event at stream end."""

    status: str  # "complete" | "error" | "cancelled"
    usage: dict | None = None
    error_code: str | None = None
    final_chars: int | None = None


class StreamCitationEvent(BaseModel):
    """SSE citation event emitted when a tool selects a web citation."""

    assistant_message_id: UUID
    tool_name: str
    tool_call_index: int
    title: str
    url: str
    display_url: str
    source_name: str | None = None
    snippet: str | None = None
    provider: str | None = None


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
