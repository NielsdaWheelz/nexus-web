"""The account librarian: immutable turns, live references and operational receipts."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, ClassVar, Literal
from uuid import UUID

from llm_tools import ToolEffect
from pydantic import BaseModel, ConfigDict, Field

from nexus.jobs.queue import DurableExecutionPhase
from nexus.schemas.assistant_writes import CreatedRefOut, MachineAuthorshipOut
from nexus.schemas.collection_order import OrderRevision
from nexus.schemas.live_reference import LiveReference, RetrievalTarget
from nexus.schemas.llm import GenerationSelection, RunSelectionOut
from nexus.schemas.resource_items import ResourceItemOut
from nexus.services.tools.contract import ERROR_TYPES

MAX_MESSAGE_CONTENT_LENGTH = 20_000
EXECUTION_ADVISORY_EVENT_TYPE = "ExecutionAdvisory"
ToolStatus = Literal["running", "complete", "error", "cancelled"]


class Wire(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Out(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)


class AttachmentOut(Out):
    reference: LiveReference
    item: ResourceItemOut | None
    location_available: bool


class ChatCitationOut(Out):
    id: UUID
    ordinal: int = Field(ge=1)
    target: RetrievalTarget
    item: ResourceItemOut | None
    location_available: bool


class ChatFailureOut(Out):
    code: Literal[
        "cancelled",
        "context_too_large",
        "invalid_output",
        "incomplete",
        "assistant_unavailable",
        "operator_defect",
    ]


class MessageOut(Wire):
    id: UUID
    seq: OrderRevision
    role: Literal["user", "assistant"]
    content: str
    status: Literal["pending", "complete", "error", "cancelled"]
    attachments: list[AttachmentOut]
    citations: list[ChatCitationOut]
    trust_trail: AssistantTrustTrailOut | None
    created_at: datetime
    updated_at: datetime


class ChatRunCreateRequest(Wire):
    model_config = ConfigDict(extra="forbid", strict=True)

    content: str = Field(min_length=1, pattern=r"\S")
    selection: GenerationSelection
    attachments: list[LiveReference] = Field(max_length=16)
    expected_deletion_revision: OrderRevision


class ChatRunRetryRequest(Wire):
    model_config = ConfigDict(extra="forbid", strict=True)

    selection: GenerationSelection
    expected_deletion_revision: OrderRevision


RejectionCode = Literal[
    "E_CHAT_CREATION_STALE",
    "E_MESSAGE_TOO_LONG",
    "E_INVALID_GENERATION_SELECTION",
    "E_GENERATION_SELECTION_UNAVAILABLE",
    "E_INVALID_REQUEST",
    "E_FORBIDDEN",
    "E_NOT_FOUND",
    "E_MESSAGE_NOT_FOUND",
    "E_RETRY_NOT_ALLOWED",
]


class ChatAdmissionRejection(Wire):
    code: RejectionCode


class AcceptedChatAdmission(Wire):
    kind: Literal["Accepted"] = "Accepted"
    run_id: UUID
    user_message_id: UUID
    assistant_message_id: UUID


class RejectedChatAdmission(Wire):
    kind: Literal["Rejected"] = "Rejected"
    reason: ChatAdmissionRejection


class ChatAdmissionReceipt(Wire):
    outcome: Annotated[AcceptedChatAdmission | RejectedChatAdmission, Field(discriminator="kind")]


class ChatPublicationWarning(Wire):
    code: Literal["CitationsUnavailable"] = "CitationsUnavailable"


class ChatRunExecutionOut(Wire):
    model_config = ConfigDict(extra="forbid", frozen=True)

    phase: DurableExecutionPhase
    cancel_requested: bool


class ChatRunResponse(Wire):
    run_id: UUID
    user_message: MessageOut
    assistant_message: MessageOut
    retry_of_run_id: UUID | None
    execution: ChatRunExecutionOut | None
    can_cancel: bool
    can_retry: bool
    can_delete: bool


class TimelineOut(Wire):
    items: list[ChatRunResponse]
    before_seq: OrderRevision | None
    after_seq: OrderRevision | None


class ChatRunAssistantTextDeltaEventPayload(Wire):
    event_type: ClassVar[str] = "assistant_text_delta"

    text: str = Field(min_length=1)


class ChatRunToolCallStartEventPayload(Wire):
    """Only lifecycle identity is stored here; the call owns its arguments."""

    event_type: ClassVar[str] = "tool_call_start"

    tool_call_id: UUID
    tool_call_index: int = Field(ge=1)


class ChatRunToolResultEventPayload(ChatRunToolCallStartEventPayload):
    event_type: ClassVar[str] = "tool_result"

    status: ToolStatus
    error_type: str | None


class ResourceActivityTargetOut(Out):
    kind: Literal["resource"] = "resource"
    item: ResourceItemOut


class ExternalActivityTargetOut(Out):
    kind: Literal["external"] = "external"
    href: str = Field(min_length=1, max_length=4096)


ActivityTargetOut = Annotated[
    ResourceActivityTargetOut | ExternalActivityTargetOut, Field(discriminator="kind")
]


class ToolActivityOut(Out):
    verb: str
    subject: str | None = Field(max_length=2048)
    target: ActivityTargetOut | None
    detail: str | None = Field(max_length=2000)
    outcome: str | None = Field(max_length=160)


class ToolProjectionOut(Out):
    """One semantic projection shared by saved calls and stage-specific frames."""

    canonical_tool_id: str = Field(min_length=1, max_length=128)
    effect: ToolEffect
    result_kind: Literal["mutation", "navigation", "retrieval"]
    activity: ToolActivityOut
    error_type: str | None = Field(
        min_length=1, max_length=64, json_schema_extra={"enum": [*ERROR_TYPES, None]}
    )


class TrustRetrievalOut(Out):
    id: UUID
    target: RetrievalTarget
    item: ResourceItemOut | None
    location_available: bool


class ChatRunToolCallStartEventOut(ToolProjectionOut):
    event_type: ClassVar[str] = "tool_call_start"

    tool_call_id: UUID
    tool_call_index: int = Field(ge=1)


class ChatRunToolResultEventOut(ChatRunToolCallStartEventOut):
    event_type: ClassVar[str] = "tool_result"

    status: ToolStatus
    retrievals: list[TrustRetrievalOut]
    created_refs: list[CreatedRefOut]


class ChatRunDoneEventPayload(Wire):
    """The run's one terminal frame; the browser then re-reads the saved answer."""

    event_type: ClassVar[str] = "done"

    status: Literal["complete", "error", "cancelled"]


# The trust trail


class TrustRunOut(Out):
    run_id: UUID
    run_selection: RunSelectionOut
    status: Literal["queued", "running", "complete", "error", "cancelled"]
    support_id: str | None
    publication_warning: ChatPublicationWarning | None
    failure: ChatFailureOut | None
    execution: ChatRunExecutionOut | None


class TrustToolCallOut(ToolProjectionOut):
    undo_allowed: bool
    id: UUID
    tool_call_index: int
    status: ToolStatus
    created_refs: list[CreatedRefOut]
    machine_authorships: list[MachineAuthorshipOut]
    reverted_at: datetime | None
    retrievals: list[TrustRetrievalOut]


class AssistantTrustTrailOut(Out):
    """An answer's admitted run, current source identities and operational actions."""

    run: TrustRunOut
    context: list[ResourceItemOut]
    tool_calls: list[TrustToolCallOut]


MessageOut.model_rebuild()
