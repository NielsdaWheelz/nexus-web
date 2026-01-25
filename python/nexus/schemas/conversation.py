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
