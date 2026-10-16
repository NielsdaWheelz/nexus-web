"""Chat wire: reader quotes, conversations, messages, sends, run events, the trust trail.

Every event model is both the stored ``chat_run_events.payload`` and the SSE frame.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, ClassVar, Literal
from uuid import UUID

from llm_tools import ToolEffect
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from nexus.jobs.queue import DurableExecutionPhase
from nexus.schemas.assistant_writes import CreatedRefOut, MachineAuthorshipOut
from nexus.schemas.citation import CitationOut
from nexus.schemas.llm import ExpectedChatFailure, GenerationSelection, RunSelectionOut
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.schemas.retrieval import MediaRetrievalLocator
from nexus.services.tools.contract import ERROR_TYPES

MAX_MESSAGE_CONTENT_LENGTH = 20_000
MAX_QUOTE_EXACT = 20_000
MAX_QUOTE_AFFIX = 1_000
MAX_QUOTE_SOURCE = 1_000
EXECUTION_ADVISORY_EVENT_TYPE = "ExecutionAdvisory"
ToolStatus = Literal["running", "complete", "error", "cancelled"]


class Wire(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Out(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)


# Reader quotes


class ReaderSelectionKey(Wire):
    model_config = ConfigDict(extra="forbid", frozen=True)

    media_id: UUID
    highlight_id: UUID


class ReaderSelectionSnapshot(Wire):
    """The immutable quote on a user turn; its revision is the sha256 of this JSON."""

    key: ReaderSelectionKey
    source_label: str = Field(min_length=1, max_length=MAX_QUOTE_SOURCE)
    exact: str = Field(min_length=1, max_length=MAX_QUOTE_EXACT)
    prefix: str = Field(default="", max_length=MAX_QUOTE_AFFIX)
    suffix: str = Field(default="", max_length=MAX_QUOTE_AFFIX)
    locator: MediaRetrievalLocator


class ReaderSelectionOut(ReaderSelectionSnapshot):
    activation: ResourceActivationOut


Revision = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]


class ReaderSelectionPreview(ReaderSelectionOut):
    revision: Revision


class ReaderSelectionInput(Wire):
    """A send's quote: the durable key plus the compare-on-send revision, never text."""

    key: ReaderSelectionKey
    revision: Revision


# Conversations and messages


class ConversationOut(Wire):
    id: UUID
    title: str
    branch_revision: int = Field(ge=0)


class ConversationListItemOut(Wire):
    id: UUID
    title: str
    message_count: int
    updated_at: datetime


class CreateConversationRequest(Wire):
    initial_context_refs: list[str] | None = None


class MessageOut(Wire):
    """One saved message. ``branch_anchor`` is ``{"kind": ..., **anchor}``."""

    id: UUID
    seq: int
    role: Literal["user", "assistant"]
    content: str
    status: Literal["pending", "complete", "error", "cancelled"]
    parent_message_id: UUID | None
    branch_anchor: dict[str, Any]
    fork_title: str | None
    reader_selection: ReaderSelectionOut | None
    citations: list[CitationOut]
    trust_trail: AssistantTrustTrailOut | None
    can_rerun: bool
    created_at: datetime
    updated_at: datetime


class MessageDeleteOut(Wire):
    model_config = ConfigDict(extra="forbid")

    conversation_id: UUID
    conversation_deleted: bool


class ConversationTreeOut(Wire):
    """Every message once, in seq order, and the active leaf."""

    conversation: ConversationOut
    messages: list[MessageOut]
    active_leaf_message_id: UUID | None


class SetActivePathRequest(Wire):
    active_leaf_message_id: UUID
    expected_revision: int = Field(ge=0)


class ForkTitleRequest(Wire):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    title: str | None = Field(default=None, min_length=1, max_length=120)


# Sends


class NoBranchAnchorRequest(Wire):
    kind: Literal["none"] = "none"


class AssistantMessageBranchAnchorRequest(Wire):
    kind: Literal["assistant_message"]
    message_id: UUID


class AssistantSelectionBranchAnchorRequest(Wire):
    """Selected answer text; the browser never maps it to offsets."""

    kind: Literal["assistant_selection"]
    message_id: UUID
    exact: str = Field(min_length=1, max_length=MAX_QUOTE_EXACT, pattern=r"\S")
    prefix: str | None = Field(default=None, max_length=MAX_QUOTE_AFFIX)
    suffix: str | None = Field(default=None, max_length=MAX_QUOTE_AFFIX)
    offset_status: Literal["unmapped"]
    client_selection_id: str = Field(min_length=1, max_length=128)


BranchAnchorRequest = Annotated[
    NoBranchAnchorRequest
    | AssistantMessageBranchAnchorRequest
    | AssistantSelectionBranchAnchorRequest,
    Field(discriminator="kind"),
]


class NewChatDestination(Wire):
    """A fresh conversation created atomically with this send."""

    kind: Literal["New"] = "New"


class EmptyInsertion(Wire):
    """The first turn of a context-bearing chat made by ``POST /conversations``."""

    kind: Literal["Empty"] = "Empty"


class ReplyInsertion(Wire):
    kind: Literal["Reply"]
    parent_message_id: UUID
    branch_anchor: BranchAnchorRequest = Field(default_factory=NoBranchAnchorRequest)


class ExistingChatDestination(Wire):
    kind: Literal["Existing"]
    conversation_id: UUID
    expected_revision: int = Field(ge=0)
    insertion: Annotated[EmptyInsertion | ReplyInsertion, Field(discriminator="kind")]


class ChatRunCreateRequest(Wire):
    """The quote is a key plus a compare-on-send revision; the server snapshots the text."""

    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)

    destination: Annotated[
        NewChatDestination | ExistingChatDestination, Field(discriminator="kind")
    ]
    content: str = Field(min_length=1)
    selection: GenerationSelection
    reader_selection: ReaderSelectionInput | None


class ChatRunRepeatRequest(Wire):
    model_config = ConfigDict(extra="forbid", strict=True)

    selection: GenerationSelection
    expected_revision: int = Field(ge=0)


RejectionCode = Literal[
    "E_CONVERSATION_CHANGED",
    "E_MESSAGE_TOO_LONG",
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
    "E_GENERATION_CONTEXT_TOO_LARGE",
]


class ChatAdmissionRejection(Wire):
    code: RejectionCode


class AcceptedChatAdmission(Wire):
    kind: Literal["Accepted"] = "Accepted"
    conversation_id: UUID
    run_id: UUID
    assistant_message_id: UUID


class RejectedChatAdmission(Wire):
    kind: Literal["Rejected"] = "Rejected"
    reason: ChatAdmissionRejection


class ChatAdmissionReceipt(Wire):
    """The decision for one run id: an acceptance answers every resend; a rejection is
    not stored (a resend decides again)."""

    idempotency_key: str = Field(min_length=1, max_length=128)
    outcome: Annotated[AcceptedChatAdmission | RejectedChatAdmission, Field(discriminator="kind")]


# Runs


class ChatPublicationWarning(Wire):
    code: Literal["CitationsUnavailable"] = "CitationsUnavailable"


class ChatRunExecutionOut(Wire):
    """The live run's queue phase and stop intent, in one observation."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    phase: DurableExecutionPhase
    cancel_requested: bool


class ChatRunResponse(Wire):
    conversation: ConversationOut
    user_message: MessageOut
    assistant_message: MessageOut


# Run events


class ChatRunAssistantTextDeltaEventPayload(Wire):
    event_type: ClassVar[str] = "assistant_text_delta"

    text: str = Field(min_length=1)


class ToolProjectionOut(Wire):
    """What the tool frames and the trust trail say about a call's tool."""

    canonical_tool_id: str = Field(min_length=1, max_length=128)
    effect: ToolEffect
    result_kind: Literal["mutation", "navigation", "retrieval"]
    activity_label: str = Field(min_length=1, max_length=150)
    error_type: str | None = Field(
        min_length=1, max_length=64, json_schema_extra={"enum": [*ERROR_TYPES, None]}
    )


class ChatRunToolCallStartEventOut(ToolProjectionOut):
    event_type: ClassVar[str] = "tool_call_start"

    tool_call_id: UUID
    tool_call_index: int = Field(ge=1)


class ChatRunToolCallDoneEventOut(ChatRunToolCallStartEventOut):
    event_type: ClassVar[str] = "tool_call_done"

    input: dict[str, Any]


class ChatRunToolResultEventOut(ChatRunToolCallStartEventOut):
    event_type: ClassVar[str] = "tool_result"

    status: ToolStatus


class ChatRunContextRefAddedEventPayload(Wire):
    """A resource a published citation added to the chat's context."""

    event_type: ClassVar[str] = "context_ref_added"

    id: UUID
    resource_ref: str = Field(min_length=1)
    label: str
    missing: bool


class ChatRunDoneEventPayload(Wire):
    """The run's one terminal frame; the browser then re-reads the saved answer."""

    event_type: ClassVar[str] = "done"

    status: Literal["complete", "error", "cancelled"]
    usage: dict[str, Any] | None


# The trust trail


class TrustRunOut(Out):
    run_id: UUID
    run_selection: RunSelectionOut
    status: Literal["pending", "running", "complete", "error", "cancelled"]
    usage: dict[str, Any] | None = None
    error_code: str | None = None
    support_id: str | None
    publication_warning: ChatPublicationWarning | None
    failure: ExpectedChatFailure | None = None
    execution: ChatRunExecutionOut | None


class TrustRetrievalOut(Out):
    id: UUID
    source_id: str
    source_title: str | None
    selected: bool
    included_in_prompt: bool
    cited_edge_id: UUID | None


class TrustToolCallOut(ToolProjectionOut):
    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)

    id: UUID
    tool_call_index: int
    status: ToolStatus
    created_refs: list[CreatedRefOut]
    machine_authorships: list[MachineAuthorshipOut]
    reverted_at: datetime | None
    retrievals: list[TrustRetrievalOut]


class TrustCitationOut(Out):
    citation_edge_id: UUID
    ordinal: int
    citation: CitationOut


class TrustContextRefAddedOut(ChatRunContextRefAddedEventPayload):
    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)

    chat_run_event_seq: int


class AssistantTrustTrailOut(Out):
    conversation_id: UUID
    run: TrustRunOut | None = None
    attached: list[TrustRetrievalOut] = Field(default_factory=list)  # the turn's context
    tool_calls: list[TrustToolCallOut] = Field(default_factory=list)
    citations: list[TrustCitationOut] = Field(default_factory=list)
    context_refs_added: list[TrustContextRefAddedOut] = Field(default_factory=list)


MessageOut.model_rebuild()
