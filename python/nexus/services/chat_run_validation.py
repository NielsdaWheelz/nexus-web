"""Pre-phase validation for chat run creation: input, model, rate limits, scope, branch parents."""

from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID

from llm_calling.errors import LLMError
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_highlight, can_read_media
from nexus.db.models import Conversation, Media, Message, Model
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.conversation import (
    MAX_CONTEXTS,
    MAX_MESSAGE_CONTENT_LENGTH,
    BranchAnchorRequest,
    ContextItem,
    ConversationScopeRequest,
)
from nexus.schemas.notes import ObjectRef
from nexus.services.api_key_resolver import (
    get_model_by_id,
    is_provider_enabled,
    resolve_api_key,
)
from nexus.services.contexts import validate_content_chunk_evidence_span_ids
from nexus.services.conversation_branches import branch_anchor_for_message
from nexus.services.conversations import authorize_conversation_scope
from nexus.services.models import get_model_catalog_metadata
from nexus.services.object_refs import hydrate_object_ref
from nexus.services.rate_limit import get_rate_limiter


def validate_pre_phase(
    db: Session,
    viewer_id: UUID,
    conversation_id: UUID | None,
    conversation_scope: ConversationScopeRequest | None,
    parent_message_id: UUID | None,
    branch_anchor: BranchAnchorRequest,
    content: str,
    model_id: UUID,
    reasoning: str,
    key_mode: str,
    contexts: Sequence[ContextItem],
    use_platform_key: bool,
) -> Model:
    if len(content) > MAX_MESSAGE_CONTENT_LENGTH:
        raise ApiError(
            ApiErrorCode.E_MESSAGE_TOO_LONG,
            f"Message exceeds {MAX_MESSAGE_CONTENT_LENGTH} character limit",
        )
    if len(contexts) > MAX_CONTEXTS:
        raise ApiError(
            ApiErrorCode.E_CONTEXT_TOO_LARGE,
            f"Maximum {MAX_CONTEXTS} context items allowed",
        )

    model = get_model_by_id(db, model_id)
    if model is None or not model.is_available:
        raise ApiError(ApiErrorCode.E_MODEL_NOT_AVAILABLE, "Model not found or not available")
    metadata = get_model_catalog_metadata(model.provider, model.model_name)
    if metadata is None:
        raise ApiError(ApiErrorCode.E_MODEL_NOT_AVAILABLE, "Model is outside the curated catalog")
    if not is_provider_enabled(model.provider):
        raise ApiError(ApiErrorCode.E_MODEL_NOT_AVAILABLE, "Model provider is disabled")
    _, _, _, reasoning_modes = metadata
    if reasoning not in reasoning_modes:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Reasoning mode '{reasoning}' is not supported for {model.provider}/{model.model_name}",
        )

    try:
        resolve_api_key(db, viewer_id, model.provider, key_mode)
    except LLMError as exc:
        raise ApiError(ApiErrorCode.E_LLM_NO_KEY, str(exc.message)) from exc

    for ctx in contexts:
        _validate_context_visibility(db, viewer_id, ctx)

    rate_limiter = get_rate_limiter()
    rate_limiter.check_rpm_limit(viewer_id)
    rate_limiter.check_concurrent_limit(viewer_id)
    if use_platform_key:
        rate_limiter.check_token_budget(viewer_id)
    if conversation_id is not None:
        _validate_parent_anchor_for_existing_conversation(
            db,
            viewer_id,
            conversation_id,
            parent_message_id,
            branch_anchor,
        )
    elif conversation_scope is not None:
        if parent_message_id is not None or branch_anchor.kind != "none":
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                "conversation_scope sends cannot include a branch parent",
            )
        authorize_conversation_scope(db, viewer_id, conversation_scope)

    return model


def load_valid_parent_for_send(
    db: Session,
    *,
    conversation_id: UUID,
    parent_message_id: UUID | None,
) -> Message | None:
    if parent_message_id is None:
        raise ApiError(
            ApiErrorCode.E_BRANCH_PATH_INVALID,
            "Existing conversations require parent_message_id",
        )
    parent = db.get(Message, parent_message_id)
    if parent is None or parent.conversation_id != conversation_id:
        raise ApiError(ApiErrorCode.E_BRANCH_PATH_INVALID, "Parent message not found")
    if parent.role != "assistant" or parent.status != "complete":
        raise ApiError(
            ApiErrorCode.E_BRANCH_PATH_INVALID,
            "parent_message_id must point to a complete assistant message",
        )
    return parent


def _validate_context_visibility(db: Session, viewer_id: UUID, ctx: ContextItem) -> None:
    if ctx.kind == "reader_selection":
        media = db.get(Media, ctx.media_id)
        if media is None or not can_read_media(db, viewer_id, ctx.media_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")
        return

    if ctx.type == "media":
        media = db.get(Media, ctx.id)
        if media is None or not can_read_media(db, viewer_id, ctx.id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")
        return

    if ctx.type == "highlight":
        if not can_read_highlight(db, viewer_id, ctx.id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")
        return

    hydrate_object_ref(db, viewer_id, ObjectRef(object_type=ctx.type, object_id=ctx.id))
    if ctx.type == "content_chunk" and ctx.evidence_span_ids:
        validate_content_chunk_evidence_span_ids(db, ctx.id, ctx.evidence_span_ids)


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
