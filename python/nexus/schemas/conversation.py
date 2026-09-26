"""Conversation, message, chat-run and trust-trail wire contracts.

Every model here is decoded key-exactly by ``apps/web/src/lib/conversations``
and ``apps/web/src/lib/api/sse``; fields and closed literal sets are frozen.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from llm_tools import ToolEffect
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_serializer,
    model_validator,
)

from nexus.schemas.chat_reader_selection import ReaderSelectionInput, ReaderSelectionOut
from nexus.schemas.citation import CitationOut, CitationRole, CitationTargetRef
from nexus.schemas.collection_page import CollectionRevision
from nexus.schemas.execution import ChatRunExecutionOut
from nexus.schemas.llm import ExpectedChatFailure, RunSelectionOut
from nexus.schemas.machine_authorship import MachineAuthorshipOut
from nexus.schemas.presence import Absent, Presence, Present, absent, present
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.schemas.retrieval import RetrievalContextRef, RetrievalLocator, RetrievalResultRef
from nexus.schemas.search_types import SEARCH_RESULT_TYPES
from nexus.services.generation_spec import GenerationSelectionSpec

MESSAGE_TOOL_STATUSES = Literal["pending", "running", "complete", "error", "cancelled"]
# ``historical_execution`` has no writer; the value stays because the database
# CHECK and the browser decoder still admit backfilled rows.
TOOL_RECORD_KINDS = Literal[
    "attached_context",
    "current_execution",
    "historical_execution",
]
TOOL_RESULT_KINDS = Literal[
    "attached_context",
    "mutation",
    "navigation",
    "retrieval",
]
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

MAX_MESSAGE_CONTENT_LENGTH = 20000
TRUST_TRAIL_VERSION = "assistant_trust_trail.v1"


class ConversationOut(BaseModel):
    id: UUID
    title: str
    owner_user_id: UUID
    is_owner: bool
    message_count: int
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True, extra="forbid")


class ConversationListItemOut(BaseModel):
    id: UUID
    title: str
    message_count: int
    updated_at: datetime

    model_config = ConfigDict(extra="forbid")


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
    id: UUID
    seq: int
    role: str  # "user" | "assistant"
    message_document: MessageDocument = Field(default_factory=MessageDocument)
    citations: list[CitationOut] = Field(default_factory=list)
    trust_trail: AssistantTrustTrailOut | None = None
    parent_message_id: UUID | None = None
    branch_root_message_id: UUID | None = None
    branch_anchor_kind: BRANCH_ANCHOR_KINDS = "none"
    branch_anchor: dict[str, Any] = Field(default_factory=dict)
    status: str  # "pending" | "complete" | "error" | "cancelled"
    can_rerun: bool = False
    reader_selection: Presence[ReaderSelectionOut] = Field(default_factory=absent)
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True, extra="forbid")

    @model_validator(mode="after")
    def validate_trust_trail_role(self) -> MessageOut:
        if self.role == "assistant" and self.trust_trail is None:
            raise ValueError("assistant messages require trust_trail")
        if self.role != "assistant" and self.trust_trail is not None:
            raise ValueError("only assistant messages may carry trust_trail")
        if self.role != "user" and not isinstance(self.reader_selection, Absent):
            raise ValueError("only user messages may carry a reader_selection")
        return self


class MessageDeleteOut(BaseModel):
    conversation_id: UUID = Field(alias="conversationId")
    conversation_deleted: bool = Field(alias="conversationDeleted")
    collection_revision: CollectionRevision = Field(alias="collectionRevision")

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class MessageRetrievalOut(BaseModel):
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


# =============================================================================
# SSE event payloads
# =============================================================================


class ChatRunMetaSubjectPayload(BaseModel):
    requested_resource_ref: str
    resource_ref: str
    context_edge_id: UUID | None = None
    companions: list[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


class ChatRunMetaEventPayload(BaseModel):
    run_id: UUID
    conversation_id: UUID
    user_message_id: UUID
    assistant_message_id: UUID
    run_selection: RunSelectionOut
    chat_subject: ChatRunMetaSubjectPayload | None

    model_config = ConfigDict(extra="forbid")


class ChatRunAssistantActivityEventPayload(BaseModel):
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
    assistant_message_id: UUID
    text: str = Field(min_length=1)
    provider_event_seq_start: int = Field(ge=0)
    provider_event_seq_end: int = Field(ge=0)

    model_config = ConfigDict(extra="forbid")


class ToolProjectionOut(BaseModel):
    """The one same-system tool projection shared by SSE, trust, and Undo."""

    record_kind: TOOL_RECORD_KINDS
    canonical_tool_id: str | None = Field(min_length=1, max_length=128)
    provider_wire_name: str | None = Field(min_length=1, max_length=128)
    effect: ToolEffect | None
    result_kind: TOOL_RESULT_KINDS
    activity_label: str = Field(min_length=1, max_length=150)
    error_type: str | None = Field(min_length=1, max_length=64)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_record_kind_shape(self) -> ToolProjectionOut:
        # ``record_kind`` is the union tag: an attached-context row carries no
        # tool identity, an execution row always carries one.
        if self.record_kind == "attached_context":
            if (
                self.canonical_tool_id is not None
                or self.provider_wire_name is not None
                or self.effect is not None
                or self.error_type is not None
            ):
                raise ValueError("tool projection populated a forbidden tagged field")
        elif self.canonical_tool_id is None or self.effect is None:
            raise ValueError("tool projection is missing a required tagged field")
        return self


class StoredToolProjection(ToolProjectionOut):
    """Strict durable tagged facts; replay/audit fields never cross the API."""

    canonical_input_sha256: str | None = Field(pattern=r"^[0-9a-f]{64}$")
    tool_contract_revision: str | None = Field(pattern=r"^[0-9a-f]{64}$")
    binding_policy_revision: str | None = Field(pattern=r"^[0-9a-f]{64}$")


def tool_projection_from_persisted_record(record: Any) -> ToolProjectionOut:
    """Derive public presentation only after the storage owner decoded a row."""

    from nexus.services.tool_runtime.declarations import CHAT_TOOL_DECLARATIONS_BY_ID

    record_kind: TOOL_RECORD_KINDS = record.record_kind
    if record_kind == "attached_context":
        return ToolProjectionOut(
            record_kind=record_kind,
            canonical_tool_id=None,
            provider_wire_name=None,
            effect=None,
            result_kind="attached_context",
            activity_label="Attached conversation context",
            error_type=None,
        )
    declaration = CHAT_TOOL_DECLARATIONS_BY_ID.get(record.canonical_tool_id)
    if declaration is None:
        raise AssertionError("decoded tool row has no presentation declaration")
    return ToolProjectionOut(
        record_kind=record_kind,
        canonical_tool_id=record.canonical_tool_id,
        provider_wire_name=record.provider_wire_name,
        effect=declaration.spec.effect,
        result_kind=declaration.result_kind,
        activity_label=declaration.activity_label,
        error_type=record.error_code if record_kind == "current_execution" else None,
    )


class ChatRunToolCallStartEventPayload(StoredToolProjection):
    tool_call_id: UUID | None = None
    assistant_message_id: UUID
    tool_call_index: int = Field(ge=0)
    provider_tool_call_id: str | None = Field(default=None, min_length=1)
    provider_event_seq_start: int = Field(ge=0)
    provider_event_seq_end: int = Field(ge=0)

    model_config = ConfigDict(extra="forbid")


class ChatRunToolCallDoneEventPayload(StoredToolProjection):
    tool_call_id: UUID | None = None
    assistant_message_id: UUID
    tool_call_index: int = Field(ge=0)
    provider_tool_call_id: str | None = Field(default=None, min_length=1)
    input: dict[str, Any]
    provider_event_seq_start: int = Field(ge=0)
    provider_event_seq_end: int = Field(ge=0)

    model_config = ConfigDict(extra="forbid")


class ChatRunToolResultEventPayload(StoredToolProjection):
    tool_call_id: UUID | None = None
    assistant_message_id: UUID
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

    @model_validator(mode="after")
    def validate_terminal_audit_identity(self) -> ChatRunToolResultEventPayload:
        audit = (
            self.canonical_input_sha256,
            self.tool_contract_revision,
            self.binding_policy_revision,
        )
        if self.record_kind == "current_execution" and any(value is None for value in audit):
            raise ValueError("current tool result is missing replay identity")
        if self.record_kind == "attached_context" and any(value is not None for value in audit):
            raise ValueError("non-executable tool result carries replay identity")
        return self


class ChatPublicationWarning(BaseModel):
    code: Literal["CitationsUnavailable"] = "CitationsUnavailable"

    model_config = ConfigDict(frozen=True, extra="forbid")


def chat_publication_warning_from_nullable(
    code: str | None,
) -> Absent | Present[ChatPublicationWarning]:
    if code is None:
        return absent()
    if code != "CitationsUnavailable":
        raise ValueError(f"unknown chat publication warning code: {code!r}")
    return present(ChatPublicationWarning(code=code))


class ChatRunDoneEventPayload(BaseModel):
    status: Literal["complete", "error", "cancelled"]
    error_code: Presence[str]
    support_id: Presence[str]
    publication_warning: Presence[ChatPublicationWarning]
    usage: dict[str, Any] | None
    final_chars: int | None = Field(ge=0)
    last_provider_event_seq: int | None = Field(ge=0)
    cancelled: bool

    model_config = ConfigDict(extra="forbid")


class ChatRunCitationIndexItem(BaseModel):
    citation_edge_id: UUID
    citation: CitationOut

    model_config = ConfigDict(extra="forbid")


class ChatRunCitationIndexEventPayload(BaseModel):
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


_EVENT_PAYLOAD_MODELS: dict[str, type[BaseModel]] = {
    "meta": ChatRunMetaEventPayload,
    "assistant_activity": ChatRunAssistantActivityEventPayload,
    "assistant_text_delta": ChatRunAssistantTextDeltaEventPayload,
    "tool_call_start": ChatRunToolCallStartEventPayload,
    "tool_call_done": ChatRunToolCallDoneEventPayload,
    "tool_result": ChatRunToolResultEventPayload,
    "citation_index": ChatRunCitationIndexEventPayload,
    "context_ref_added": ChatRunContextRefAddedEventPayload,
    "done": ChatRunDoneEventPayload,
}

# Replay/audit identity persisted on tool events; never crosses the SSE wire.
_PRIVATE_EVENT_FIELDS = frozenset(
    {
        "binding_policy_revision",
        "canonical_input_sha256",
        "error_code",
        "tool_contract_revision",
    }
)
_TOOL_EVENT_TYPES = frozenset({"tool_call_start", "tool_call_done", "tool_result"})


def chat_run_event_payload_json(event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Validate a strict chat-run SSE payload before storage (write path only)."""

    model = _EVENT_PAYLOAD_MODELS.get(event_type)
    if model is None:
        raise ValueError("unknown chat-run event type")
    return model.model_validate(payload).model_dump(mode="json")


def chat_run_public_event_payload(event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Strip the replay/audit facts from one stored payload on the read path."""

    if event_type not in _TOOL_EVENT_TYPES:
        return payload
    return {key: value for key, value in payload.items() if key not in _PRIVATE_EVENT_FIELDS}


# =============================================================================
# Trust trail read model
# =============================================================================


class TrustPromptAssemblyOut(BaseModel):
    reserved_output_tokens: int
    input_budget_tokens: int
    estimated_input_tokens: int
    included_message_ids: list[str]
    included_retrieval_ids: list[str]
    included_context_refs: list[dict[str, Any]]
    dropped_items: list[dict[str, Any]]

    model_config = ConfigDict(extra="forbid")


class TrustRunOut(BaseModel):
    run_id: UUID
    run_selection: RunSelectionOut
    status: Literal["pending", "running", "complete", "error", "cancelled"]
    usage: dict[str, Any] | None = None
    error_code: str | None = None
    support_id: Presence[str]
    publication_warning: Presence[ChatPublicationWarning]
    failure: ExpectedChatFailure | None = None
    execution: Presence[ChatRunExecutionOut]
    final_chars: int | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None

    model_config = ConfigDict(extra="forbid")


class TrustRetrievalOut(MessageRetrievalOut):
    citation_candidate_ordinal: Presence[int]
    cited_edge_id: UUID | None = None
    citation_number: int | None = None
    citation_role: CitationRole | None = None
    included_in_prompt_source: Literal["retrieval", "prompt_assembly", "none"] = "retrieval"


class TrustToolCallOut(ToolProjectionOut):
    id: UUID
    tool_call_index: int
    status: MESSAGE_TOOL_STATUSES
    scope: str
    requested_types: list[str]
    latency_ms: int | None = None
    result_count: int
    selected_count: int
    provider_request_ids: list[str]
    result_refs: list[dict[str, Any]]
    selected_context_refs: list[dict[str, Any]]
    machine_authorships: list[MachineAuthorshipOut] = Field(default_factory=list)
    reverted_at: datetime | None = None
    retrievals: list[TrustRetrievalOut] = Field(default_factory=list)
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
    activation: ResourceActivationOut
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


class PageInfo(BaseModel):
    """Manual-paging cursor envelope for the two retained conversation modes."""

    next_cursor: str | None = None


# =============================================================================
# Branch / fork wire models
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


# =============================================================================
# Chat-run admission
# =============================================================================


class NewChatDestination(BaseModel):
    """Create a fresh conversation atomically with this send — no pre-create."""

    kind: Literal["New"] = "New"

    model_config = ConfigDict(extra="forbid")


class EmptyInsertion(BaseModel):
    """Insert the first root message into a still-empty conversation.

    Exists only because the retained generic resource-context picker creates a
    context-bearing conversation before its first message; the server locks and
    linearizes it against concurrent message creation.
    """

    kind: Literal["Empty"] = "Empty"

    model_config = ConfigDict(extra="forbid")


class ReplyInsertion(BaseModel):
    kind: Literal["Reply"]
    parent_message_id: UUID
    branch_anchor: BranchAnchorRequest = Field(default_factory=NoBranchAnchorRequest)

    model_config = ConfigDict(extra="forbid")


ChatInsertion = Annotated[
    EmptyInsertion | ReplyInsertion,
    Field(discriminator="kind"),
]


class ExistingChatDestination(BaseModel):
    kind: Literal["Existing"]
    conversation_id: UUID
    insertion: ChatInsertion

    model_config = ConfigDict(extra="forbid")


ChatDestination = Annotated[
    NewChatDestination | ExistingChatDestination,
    Field(discriminator="kind"),
]


ChatAdmissionRejectionCode = Literal[
    "E_RATE_LIMITED",
    "E_MESSAGE_TOO_LONG",
    "E_CATALOG_DEFINITION_STALE",
    "E_INVALID_GENERATION_SELECTION",
    "E_GENERATION_SELECTION_UNAVAILABLE",
    "E_INVALID_REQUEST",
    "E_BRANCH_PATH_INVALID",
    "E_BRANCH_ANCHOR_INVALID",
    "E_FORBIDDEN",
    "E_NOT_FOUND",
    "E_CONVERSATION_NOT_FOUND",
    "E_MESSAGE_NOT_FOUND",
    "E_READER_SELECTION_STALE",
    "E_READER_SELECTION_NOT_FOUND",
    "E_READER_SELECTION_FORBIDDEN",
    "E_READER_SELECTION_GEOMETRY_ONLY",
    "E_READER_SELECTION_TOO_LARGE",
    "E_CONVERSATION_NO_LONGER_EMPTY",
    "E_BILLING_REQUIRED",
    "E_GENERATION_CONTEXT_TOO_LARGE",
]


class ChatAdmissionRejection(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    code: ChatAdmissionRejectionCode


class AcceptedChatAdmission(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["Accepted"] = "Accepted"
    conversation_id: UUID
    run_id: UUID
    assistant_message_id: UUID


class RejectedChatAdmission(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["Rejected"] = "Rejected"
    reason: ChatAdmissionRejection


class ChatAdmissionReceipt(BaseModel):
    """Immutable committed send decision, independent of run presentation."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    idempotency_key: str = Field(min_length=1, max_length=128)
    outcome: Annotated[AcceptedChatAdmission | RejectedChatAdmission, Field(discriminator="kind")]

    @field_validator("idempotency_key")
    @classmethod
    def _normalized_key(cls, value: str) -> str:
        if value != value.strip():
            raise ValueError("receipt idempotency key must already be normalized")
        return value


class ChatRunCreateRequest(BaseModel):
    """Request schema for creating a durable chat run.

    The reader quote is a durable ``ReaderSelectionKey`` plus a compare-on-send
    ``revision`` only — the server derives subject/companion/exact/locator from
    the locked Highlight and never accepts client quote text.
    """

    destination: ChatDestination
    content: str
    catalog_definition_revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    selection: GenerationSelectionSpec
    reader_selection: Presence[ReaderSelectionInput]

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid", strict=True)

    @model_validator(mode="after")
    def _content_not_blank(self) -> ChatRunCreateRequest:
        if not self.content.strip():
            raise ValueError("content cannot be blank")
        return self


class ChatRunRepeatRequest(BaseModel):
    """Exact selection for rerun/regenerate."""

    catalog_definition_revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    selection: GenerationSelectionSpec

    model_config = ConfigDict(extra="forbid", strict=True)


class ChatRunOut(BaseModel):
    id: UUID
    status: CHAT_RUN_STATUSES
    conversation_id: UUID
    user_message_id: UUID
    assistant_message_id: UUID
    run_selection: RunSelectionOut
    support_id: Presence[str]
    publication_warning: Presence[ChatPublicationWarning]
    failure: ExpectedChatFailure | None = None
    execution: Presence[ChatRunExecutionOut]
    started_at: datetime | None = None
    completed_at: datetime | None = None
    error_code: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True, extra="forbid")


class ChatRunStreamActivityOut(BaseModel):
    phase: Literal[
        "queued", "thinking", "writing", "tool_calling", "waiting", "retrying", "cancelling"
    ]
    label: str | None = None

    model_config = ConfigDict(extra="forbid")


class ChatRunStreamToolCallOut(ToolProjectionOut):
    id: UUID | None = None
    assistant_message_id: UUID
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
    input_preview: str | None = None

    model_config = ConfigDict(extra="forbid")


class ChatRunStreamStateOut(BaseModel):
    """Materialized cursor state for reconnecting a chat stream."""

    status: Literal["queued", "running", "complete", "error", "cancelled"]
    last_event_seq: int = Field(ge=0)
    folded_event_seq: int = Field(ge=0)
    assistant_current_text: str
    tool_calls: list[ChatRunStreamToolCallOut] = Field(default_factory=list)
    activity: ChatRunStreamActivityOut | None = None
    reconnectable: bool
    terminal: bool

    model_config = ConfigDict(extra="forbid")


class ChatRunResponse(BaseModel):
    run: ChatRunOut
    conversation: ConversationOut
    user_message: MessageOut
    assistant_message: MessageOut
    stream_state: ChatRunStreamStateOut


class ChatRunEventOut(BaseModel):
    """One persisted replay event, with its private audit fields stripped."""

    seq: int
    event_type: CHAT_RUN_EVENT_TYPES
    payload: dict[str, Any]
    created_at: datetime

    @model_validator(mode="after")
    def strip_private_payload_fields(self) -> ChatRunEventOut:
        self.payload = chat_run_public_event_payload(self.event_type, self.payload)
        return self
