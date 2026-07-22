"""Pre-phase validation for chat run creation: input, profile, rate limits, branch parents.

Reader-selection identity is not validated here: the send derives and locks the
Highlight inside the create transaction (after the idempotency replay check), so
a pre-phase selection check would run before replay and could reject a valid
replay whose live source has since changed.
"""

from __future__ import annotations

from uuid import UUID

from provider_runtime import ReasoningLevel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from nexus.db.models import Conversation, Message
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.conversation import (
    MAX_MESSAGE_CONTENT_LENGTH,
    ChatDestination,
    ExistingChatDestination,
    ReplyInsertion,
)
from nexus.services.conversation_branches import branch_anchor_for_message
from nexus.services.llm_profiles import LlmProfile
from nexus.services.llm_profiles import profile as lookup_profile
from nexus.services.llm_profiles import reasoning_level as lookup_reasoning_level
from nexus.services.rate_limit import get_rate_limiter


def validate_pre_phase(
    db: Session,
    viewer_id: UUID,
    *,
    destination: ChatDestination,
    content: str,
    profile_id: str,
    reasoning_option_id: str,
) -> tuple[LlmProfile, ReasoningLevel]:
    resolved = validate_model_pre_phase(
        db,
        viewer_id=viewer_id,
        content=content,
        profile_id=profile_id,
        reasoning_option_id=reasoning_option_id,
    )
    if isinstance(destination, ExistingChatDestination):
        _validate_existing_destination(db, viewer_id, destination)
    return resolved


def validate_model_pre_phase(
    db: Session,
    *,
    viewer_id: UUID,
    content: str,
    profile_id: str,
    reasoning_option_id: str,
) -> tuple[LlmProfile, ReasoningLevel]:
    if len(content) > MAX_MESSAGE_CONTENT_LENGTH:
        raise ApiError(
            ApiErrorCode.E_MESSAGE_TOO_LONG,
            f"Message exceeds {MAX_MESSAGE_CONTENT_LENGTH} character limit",
        )

    profile = lookup_profile(profile_id)
    if profile is None:
        raise ApiError(ApiErrorCode.E_MODEL_NOT_AVAILABLE, "Profile not found or not available")
    reasoning = lookup_reasoning_level(profile, reasoning_option_id)
    if reasoning is None:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Reasoning option '{reasoning_option_id}' is not supported for profile '{profile_id}'",
        )

    rate_limiter = get_rate_limiter()
    rate_limiter.check_rpm_limit(viewer_id)
    rate_limiter.check_concurrent_limit(viewer_id)
    rate_limiter.check_token_budget(viewer_id)
    return profile, reasoning


def load_valid_parent_for_send(
    db: Session,
    *,
    conversation_id: UUID,
    parent_message_id: UUID | None,
) -> Message | None:
    if parent_message_id is None:
        message_count = db.scalar(
            select(func.count())
            .select_from(Message)
            .where(Message.conversation_id == conversation_id)
        )
        if message_count:
            raise ApiError(
                ApiErrorCode.E_BRANCH_PATH_INVALID,
                "Existing conversations require parent_message_id",
            )
        return None
    parent = db.get(Message, parent_message_id)
    if parent is None or parent.conversation_id != conversation_id:
        raise ApiError(ApiErrorCode.E_BRANCH_PATH_INVALID, "Parent message not found")
    if parent.role != "assistant" or parent.status != "complete":
        raise ApiError(
            ApiErrorCode.E_BRANCH_PATH_INVALID,
            "parent_message_id must point to a complete assistant message",
        )
    return parent


def _validate_existing_destination(
    db: Session,
    viewer_id: UUID,
    destination: ExistingChatDestination,
) -> None:
    conversation = db.get(Conversation, destination.conversation_id)
    if conversation is None or conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    if isinstance(destination.insertion, ReplyInsertion):
        parent = load_valid_parent_for_send(
            db,
            conversation_id=destination.conversation_id,
            parent_message_id=destination.insertion.parent_message_id,
        )
        branch_anchor_for_message(parent, destination.insertion.branch_anchor)
