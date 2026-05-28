"""Conversation and Message Pydantic schemas.

Contains request and response models for conversation and message endpoints.

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
from nexus.schemas.context_memory import ConversationMemoryInspectionOut
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
]

MESSAGE_CONTEXT_KINDS = Literal["object_ref", "reader_selection"]


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
    "web_result",
]

# Valid assistant tool-call statuses - must match message_tool_calls.status
MESSAGE_TOOL_STATUSES = Literal["pending", "running", "complete", "error", "cancelled"]
WEB_SEARCH_RESULT_TYPES = Literal["web", "news", "mixed"]
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
    "citation_index",
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
CANDIDATE_INCLUDED_IN_PROMPT_SOURCES = Literal["candidate_ledger", "linked_retrieval"]


# =============================================================================
# Response Schemas
# =============================================================================


class ConversationSingletonOut(BaseModel):
    """Pinned-target metadata for a singleton conversation."""

    kind: Literal["media", "library"]
    target_id: UUID
    target_title: str

    model_config = ConfigDict(extra="forbid")


PINNED_SOURCE_KINDS = Literal["media", "library", "reader_selection"]


class ConversationPinnedSourceOut(BaseModel):
    """Persistent source scope for a conversation."""

    id: UUID
    ordinal: int = Field(ge=0)
    kind: PINNED_SOURCE_KINDS
    target_id: UUID | None = None
    locator: RetrievalLocator | None = None
    source_version: str | None = None
    exact: str | None = None
    title: str
    created_at: datetime

    model_config = ConfigDict(extra="forbid")


class AddPinnedSourceRequest(BaseModel):
    """Request to add a pinned source to a conversation."""

    kind: PINNED_SOURCE_KINDS
    target_id: UUID | None = None
    locator: RetrievalLocator | None = None
    source_version: str | None = None
    exact: str | None = None
    title: str = Field(min_length=1, max_length=200)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def _validate_kind_fields(self) -> "AddPinnedSourceRequest":
        if self.kind in ("media", "library"):
            if self.target_id is None:
                raise ValueError(f"target_id required for kind={self.kind}")
        else:
            if self.target_id is not None:
                raise ValueError("target_id must be null for reader_selection")
            if self.locator is None or self.exact is None or self.source_version is None:
                raise ValueError(
                    "reader_selection requires locator + exact + source_version",
                )
        return self


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
    singleton: ConversationSingletonOut | None = None
    pinned_sources: list[ConversationPinnedSourceOut] = Field(default_factory=list)
    message_count: int
    memory: ConversationMemoryInspectionOut | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True, extra="forbid")


class ConversationReferenceOut(BaseModel):
    """Reader-pane row for a non-singleton conversation referencing a media.

    Used by GET /api/chat-references/media/{media_id} (§7.4). The `is_singleton`
    field is always false: the underlying query excludes the viewer's singleton
    for the requested media. The field is kept in the response shape so the
    client renders this list with the same row component as other chat-tab
    lists where singleton rows may appear.
    """

    id: UUID
    title: str | None
    first_user_message_excerpt: str
    message_count: int
    updated_at: datetime
    is_singleton: bool

    model_config = ConfigDict(extra="forbid")


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


MessageDocumentBlock = Annotated[
    MessageDocumentTextBlock
    | MessageDocumentSourceManifestBlock
    | MessageDocumentRetrievalResultBlock,
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
    index_versions: list[str]
    metadata: dict[str, Any] = Field(default_factory=dict)
    latency_ms: int | None = Field(default=None, ge=0)
    status: MESSAGE_TOOL_STATUSES

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


class ChatRunCitationIndexEntry(BaseModel):
    n: int = Field(ge=1)
    retrieval_id: UUID
    tool_call_id: UUID

    model_config = ConfigDict(extra="forbid")


class ChatRunCitationIndexEventPayload(BaseModel):
    """Strict SSE payload mapping citation `[N]` markers to retrievals."""

    assistant_message_id: UUID
    entries: list[ChatRunCitationIndexEntry]

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
    if event_type == "citation_index":
        return ChatRunCitationIndexEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "delta":
        return ChatRunDeltaEventPayload.model_validate(payload).model_dump(mode="json")
    if event_type == "done":
        return ChatRunDoneEventPayload.model_validate(payload).model_dump(mode="json")
    raise ValueError("unknown chat-run event type")


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


class MessageRetrievalCandidateLedgerListResponse(BaseModel):
    data: list[MessageRetrievalCandidateLedgerOut]

    model_config = ConfigDict(extra="forbid")


class MessageRerankLedgerListResponse(BaseModel):
    data: list[MessageRerankLedgerOut]

    model_config = ConfigDict(extra="forbid")


class PageInfo(BaseModel):
    """Pagination information for list responses."""

    next_cursor: str | None = None


# =============================================================================
# Request Schemas
# =============================================================================


# Note: conversation creation has no request body.
# POST /conversations creates an empty private conversation.


# =============================================================================
# Chat-run request schemas
# =============================================================================


class MessageContextRef(BaseModel):
    """Canonical typed object reference for chat-run inputs."""

    kind: Literal["object_ref"] = "object_ref"
    type: MESSAGE_CONTEXT_TYPES
    id: UUID
    evidence_span_ids: list[UUID] = Field(default_factory=list)
    source_version: str | None = Field(default=None, min_length=1, max_length=256)
    locator: RetrievalLocator | None = None

    model_config = ConfigDict(extra="forbid")

    @field_validator("evidence_span_ids")
    @classmethod
    def validate_evidence_span_ids(cls, value: list[UUID]) -> list[UUID]:
        return trusted_evidence_span_ids(value)


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


MessageContextSnapshotOut = MessageContextSnapshot


class SingletonTarget(BaseModel):
    """Pinned singleton conversation target supplied by the client."""

    kind: Literal["media", "library"]
    target_id: UUID

    model_config = ConfigDict(extra="forbid")


class ReaderContextHint(BaseModel):
    """Optional model-prompt hint identifying the doc/library the viewer is reading."""

    media_id: UUID | None = None
    library_id: UUID | None = None

    model_config = ConfigDict(extra="forbid")


class ChatRunCreateRequest(BaseModel):
    """Request schema for creating a durable chat run."""

    conversation_id: UUID | None = None
    singleton: SingletonTarget | None = None
    parent_message_id: UUID | None = None
    branch_anchor: BranchAnchorRequest = Field(default_factory=NoBranchAnchorRequest)
    content: str
    model_id: UUID
    reasoning: REASONING_MODES = "default"
    key_mode: KEY_MODES = "auto"
    contexts: list[ChatContextInput] = Field(default_factory=list)
    reader_context: ReaderContextHint | None = None

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    @model_validator(mode="after")
    def validate_conversation_or_singleton(self) -> "ChatRunCreateRequest":
        if (self.conversation_id is None) == (self.singleton is None):
            raise ValueError("exactly one of conversation_id or singleton must be set")
        return self


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

    @model_validator(mode="after")
    def validate_payload(self) -> "ChatRunEventOut":
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
