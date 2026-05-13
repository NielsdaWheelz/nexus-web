"""Schemas for conversation memory, state snapshots, and prompt assembly ledgers."""

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

SOURCE_REF_TYPES = Literal[
    "message",
    "message_context",
    "message_retrieval",
    "app_context_ref",
    "web_result",
]

MEMORY_ITEM_KINDS = Literal[
    "goal",
    "constraint",
    "decision",
    "correction",
    "open_question",
    "task",
    "assistant_commitment",
    "user_preference",
    "source_claim",
]

MEMORY_STATUSES = Literal["active", "superseded", "invalid"]
MEMORY_INVALID_REASONS = Literal[
    "prompt_version_changed",
    "source_deleted",
    "source_permission_changed",
    "source_stale",
    "validation_failed",
]
MEMORY_EVIDENCE_ROLES = Literal["supports", "contradicts", "supersedes", "context"]


class SourceRefLocation(BaseModel):
    """Optional precise location metadata for a source reference."""

    page: int | None = Field(default=None, ge=1)
    fragment_id: UUID | None = None
    t_start_ms: int | None = Field(default=None, ge=0)
    start_offset: int | None = Field(default=None, ge=0)
    end_offset: int | None = Field(default=None, ge=0)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_offsets(self) -> "SourceRefLocation":
        if (
            self.start_offset is not None
            and self.end_offset is not None
            and self.end_offset < self.start_offset
        ):
            raise ValueError("end_offset must be greater than or equal to start_offset")
        return self


class SourceRef(BaseModel):
    """Resolvable source pointer shared by memory, snapshots, and lookup."""

    type: SOURCE_REF_TYPES
    id: str = Field(min_length=1, max_length=256)
    label: str | None = Field(default=None, max_length=256)
    conversation_id: UUID | None = None
    message_id: UUID | None = None
    message_seq: int | None = Field(default=None, ge=1)
    tool_call_id: UUID | None = None
    retrieval_id: UUID | None = None
    context_ref: dict[str, Any] | None = None
    result_ref: dict[str, Any] | None = None
    media_id: UUID | None = None
    deep_link: str | None = Field(default=None, max_length=2048)
    location: SourceRefLocation | None = None
    source_version: str | None = Field(default=None, min_length=1, max_length=256)

    model_config = ConfigDict(extra="forbid")


class ConversationMemoryItemSourceOut(BaseModel):
    """Persisted source reference attached to a memory item."""

    id: UUID
    memory_item_id: UUID
    ordinal: int = Field(ge=0)
    source_ref: SourceRef
    evidence_role: MEMORY_EVIDENCE_ROLES
    created_at: datetime

    model_config = ConfigDict(from_attributes=True, extra="forbid")


class ConversationMemoryItemOut(BaseModel):
    """Durable typed memory item returned to services or UI."""

    id: UUID
    conversation_id: UUID
    kind: MEMORY_ITEM_KINDS
    status: MEMORY_STATUSES
    body: str = Field(min_length=1, max_length=4000)
    source_required: bool
    confidence: float = Field(ge=0, le=1)
    valid_from_seq: int | None = Field(default=None, ge=1)
    valid_through_seq: int | None = Field(default=None, ge=1)
    supersedes_id: UUID | None = None
    created_by_message_id: UUID | None = None
    prompt_version: str = Field(min_length=1, max_length=128)
    memory_version: int = Field(ge=1)
    invalid_reason: MEMORY_INVALID_REASONS | None = None
    created_at: datetime
    updated_at: datetime
    sources: list[ConversationMemoryItemSourceOut] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True, extra="forbid")

    @model_validator(mode="after")
    def validate_ranges_and_status(self) -> "ConversationMemoryItemOut":
        if (
            self.valid_from_seq is not None
            and self.valid_through_seq is not None
            and self.valid_from_seq > self.valid_through_seq
        ):
            raise ValueError("valid_from_seq must be less than or equal to valid_through_seq")
        if self.kind == "source_claim" and not self.source_required:
            raise ValueError("source_claim memory items require source_required")
        if self.status == "invalid":
            if self.invalid_reason is None:
                raise ValueError("invalid memory items require invalid_reason")
            return self
        if self.invalid_reason is not None:
            raise ValueError("invalid_reason is only allowed for invalid memory items")
        return self


class ConversationStateSnapshotOut(BaseModel):
    """Compact auditable state snapshot for older conversation turns."""

    id: UUID
    conversation_id: UUID
    covered_through_seq: int = Field(ge=1)
    state_text: str = Field(min_length=1, max_length=20000)
    state_json: dict[str, Any] = Field(default_factory=dict)
    source_refs: list[SourceRef] = Field(default_factory=list)
    memory_item_ids: list[UUID] = Field(default_factory=list)
    prompt_version: str = Field(min_length=1, max_length=128)
    snapshot_version: int = Field(ge=1)
    status: MEMORY_STATUSES
    invalid_reason: MEMORY_INVALID_REASONS | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True, extra="forbid")

    @model_validator(mode="after")
    def validate_status(self) -> "ConversationStateSnapshotOut":
        if self.status == "invalid":
            if self.invalid_reason is None:
                raise ValueError("invalid snapshots require invalid_reason")
            return self
        if self.invalid_reason is not None:
            raise ValueError("invalid_reason is only allowed for invalid snapshots")
        return self


class ChatPromptAssemblyOut(BaseModel):
    """Persisted prompt assembly ledger row."""

    id: UUID
    chat_run_id: UUID
    conversation_id: UUID
    assistant_message_id: UUID
    model_id: UUID
    prompt_version: str = Field(min_length=1, max_length=128)
    prompt_plan_version: str = Field(min_length=1, max_length=128)
    assembler_version: str = Field(min_length=1, max_length=128)
    stable_prefix_hash: str = Field(min_length=1, max_length=128)
    cacheable_input_tokens_estimate: int = Field(ge=0)
    prompt_block_manifest: dict[str, Any] = Field(default_factory=dict)
    provider_request_hash: str = Field(min_length=1, max_length=128)
    snapshot_id: UUID | None = None
    max_context_tokens: int = Field(gt=0)
    reserved_output_tokens: int = Field(ge=0)
    reserved_reasoning_tokens: int = Field(ge=0)
    input_budget_tokens: int = Field(ge=0)
    estimated_input_tokens: int = Field(ge=0)
    included_message_ids: list[UUID] = Field(default_factory=list)
    included_memory_item_ids: list[UUID] = Field(default_factory=list)
    included_retrieval_ids: list[UUID] = Field(default_factory=list)
    included_context_refs: list[dict[str, Any]] = Field(default_factory=list)
    dropped_items: list[dict[str, Any]] = Field(default_factory=list)
    budget_breakdown: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime

    model_config = ConfigDict(from_attributes=True, extra="forbid")

    @model_validator(mode="after")
    def validate_budget(self) -> "ChatPromptAssemblyOut":
        reserved_tokens = self.reserved_output_tokens + self.reserved_reasoning_tokens
        if self.input_budget_tokens + reserved_tokens > self.max_context_tokens:
            raise ValueError("input and reserved token budgets exceed max_context_tokens")
        if self.estimated_input_tokens > self.input_budget_tokens:
            raise ValueError("estimated_input_tokens exceeds input_budget_tokens")
        return self


class ConversationMemoryInspectionOut(BaseModel):
    """Conversation memory state exposed on conversation reads."""

    state_snapshot: ConversationStateSnapshotOut | None = None
    memory_items: list[ConversationMemoryItemOut] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")
