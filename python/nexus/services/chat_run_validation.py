"""Pre-phase validation for chat run creation: input, model, rate limits, branch parents."""

from __future__ import annotations

from uuid import UUID

from provider_runtime.errors import ModelCallError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_highlight
from nexus.config import get_settings
from nexus.db.models import Conversation, Highlight, Message, Model
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.llm_catalog import (
    chat_surface_capable,
    is_provider_enabled,
    require_catalog_model,
    require_model_capabilities,
)
from nexus.schemas.conversation import (
    MAX_MESSAGE_CONTENT_LENGTH,
    BranchAnchorRequest,
    ReaderSelectionRequest,
)
from nexus.services.api_key_resolver import (
    get_model_by_id,
    resolve_api_key,
)
from nexus.services.conversation_branches import branch_anchor_for_message
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.resource_graph.context import admits_resource_for_conversation_read
from nexus.services.resource_graph.refs import ResourceRef


def validate_pre_phase(
    db: Session,
    viewer_id: UUID,
    conversation_id: UUID,
    parent_message_id: UUID | None,
    branch_anchor: BranchAnchorRequest,
    chat_subject: ResourceRef | None,
    reader_selection: ReaderSelectionRequest | None,
    content: str,
    model_id: UUID,
    reasoning: str,
    key_mode: str,
    use_platform_key: bool,
) -> Model:
    if len(content) > MAX_MESSAGE_CONTENT_LENGTH:
        raise ApiError(
            ApiErrorCode.E_MESSAGE_TOO_LONG,
            f"Message exceeds {MAX_MESSAGE_CONTENT_LENGTH} character limit",
        )

    model = get_model_by_id(db, model_id)
    if model is None or not model.is_available:
        raise ApiError(ApiErrorCode.E_MODEL_NOT_AVAILABLE, "Model not found or not available")
    catalog_entry = require_catalog_model(model.provider, model.model_name)
    require_model_capabilities(model.provider, model.model_name)
    if not chat_surface_capable(model.provider, model.model_name):
        raise ApiError(ApiErrorCode.E_MODEL_NOT_AVAILABLE, "Model is not available for chat")
    if not is_provider_enabled(model.provider, get_settings()):
        raise ApiError(ApiErrorCode.E_MODEL_NOT_AVAILABLE, "Model provider is disabled")
    if reasoning not in catalog_entry.reasoning_modes:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Reasoning mode '{reasoning}' is not supported for {model.provider}/{model.model_name}",
        )

    try:
        resolve_api_key(db, viewer_id, model.provider, key_mode)
    except ModelCallError as exc:
        raise ApiError(ApiErrorCode.E_LLM_NO_KEY, str(exc.message)) from exc

    rate_limiter = get_rate_limiter()
    rate_limiter.check_rpm_limit(viewer_id)
    rate_limiter.check_concurrent_limit(viewer_id)
    if use_platform_key:
        rate_limiter.check_token_budget(viewer_id)
    _validate_parent_anchor_for_existing_conversation(
        db,
        viewer_id,
        conversation_id,
        parent_message_id,
        branch_anchor,
    )
    _validate_reader_selection(db, viewer_id, conversation_id, reader_selection, chat_subject)

    return model


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


def _validate_parent_anchor_for_existing_conversation(
    db: Session,
    viewer_id: UUID,
    conversation_id: UUID,
    parent_message_id: UUID | None,
    branch_anchor: BranchAnchorRequest,
) -> None:
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    parent = load_valid_parent_for_send(
        db,
        conversation_id=conversation_id,
        parent_message_id=parent_message_id,
    )
    branch_anchor_for_message(parent, branch_anchor)


def _validate_reader_selection(
    db: Session,
    viewer_id: UUID,
    conversation_id: UUID,
    reader_selection: ReaderSelectionRequest | None,
    chat_subject: ResourceRef | None = None,
) -> None:
    """Ensure the turn selection is backed by a visible attached highlight."""
    if reader_selection is None:
        return
    if not can_read_highlight(db, viewer_id, reader_selection.highlight_id):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Reader selection highlight not found")

    highlight = db.get(Highlight, reader_selection.highlight_id)
    if highlight is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Reader selection highlight not found")
    if highlight.anchor_media_id != reader_selection.media_id:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "reader_selection media_id must match the highlight anchor media",
        )

    highlight_ref = ResourceRef(scheme="highlight", id=reader_selection.highlight_id)
    if chat_subject == highlight_ref:
        return
    if not admits_resource_for_conversation_read(
        db, conversation_id=conversation_id, target=highlight_ref
    ):
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "reader_selection highlight must be attached as a conversation context ref",
        )
