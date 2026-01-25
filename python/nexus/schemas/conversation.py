"""Conversation and Message Pydantic schemas.

Contains request and response models for conversation and message endpoints.
These schemas are introduced in Slice 3 (Chat + Quote-to-Chat + Keyword Search).

Note: Per PR-02, only CRUD operations are exposed. Message creation (send)
is deferred to PR-05.
"""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

# Valid sharing modes - must match DB constraint
SHARING_MODES = Literal["private", "library", "public"]

# Valid message roles - must match DB constraint
MESSAGE_ROLES = Literal["user", "assistant", "system"]

# Valid message statuses - must match DB constraint
MESSAGE_STATUSES = Literal["pending", "complete", "error"]


# =============================================================================
# Response Schemas
# =============================================================================


class ConversationOut(BaseModel):
    """Response schema for a conversation.

    Conversations are owned by exactly one user. In PR-02, only the owner
    can view their conversations (sharing deferred to S4).
    """

    id: UUID
    sharing: str  # "private" | "library" | "public"
    message_count: int
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
    status: str  # "pending" | "complete" | "error"
    error_code: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


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
# PR-05: Send Message Schemas
# =============================================================================


# Valid key modes for LLM calls
KEY_MODES = Literal["auto", "byok_only", "platform_only"]

# Max content length
MAX_MESSAGE_CONTENT_LENGTH = 20000
MAX_CONTEXTS = 10


class ContextItem(BaseModel):
    """A context item to include with a message.

    Context items reference objects (media, highlights, annotations) whose
    content will be included in the LLM prompt.
    """

    type: Literal["media", "highlight", "annotation"]
    id: UUID


class SendMessageRequest(BaseModel):
    """Request schema for sending a message.

    Per PR-05 spec:
    - content: max 20,000 chars
    - contexts: max 10 items
    - model_id: must exist and be available to user
    - key_mode: auto | byok_only | platform_only
    """

    content: str
    model_id: UUID
    key_mode: KEY_MODES = "auto"
    contexts: list[ContextItem] = []

    model_config = ConfigDict(str_strip_whitespace=True)


class SendMessageResponse(BaseModel):
    """Response schema for send message.

    Returns the conversation (created if new), user message, and assistant message.
    """

    conversation: ConversationOut
    user_message: MessageOut
    assistant_message: MessageOut


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

    status: str  # "complete" | "error"
    usage: dict | None = None
    error_code: str | None = None
