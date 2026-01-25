"""Message Context service layer.

Implements context insertion and conversation_media management for Slice 3, PR-02.

This module provides helpers for:
- Inserting message_context rows with ordinal ordering
- Validating target_type ↔ FK consistency
- Computing media_id from context targets
- Transactionally upserting conversation_media
- Recomputing conversation_media (repair helper)

NO PUBLIC ROUTES use this in PR-02. Used by send-message (PR-05) and tested via
service-layer tests only.
"""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import delete, select, text
from sqlalchemy.orm import Session

from nexus.db.models import (
    Annotation,
    ConversationMedia,
    Highlight,
    Media,
    Message,
    MessageContext,
)
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.logging import get_logger

logger = get_logger(__name__)


# =============================================================================
# Context Target Types
# =============================================================================


VALID_TARGET_TYPES = {"media", "highlight", "annotation"}


# =============================================================================
# Helper Functions
# =============================================================================


def validate_target_type(target_type: str, context_data: dict) -> None:
    """Validate that target_type matches the non-null FK column.

    Args:
        target_type: The declared target type.
        context_data: Dict with keys media_id, highlight_id, annotation_id.

    Raises:
        ApiError(E_INVALID_REQUEST): If target_type doesn't match the FK column.
    """
    if target_type not in VALID_TARGET_TYPES:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, f"Invalid target_type: {target_type}")

    # Count non-null FKs
    non_null_count = sum(
        1 for key in ["media_id", "highlight_id", "annotation_id"] if context_data.get(key)
    )

    if non_null_count != 1:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Exactly one of media_id, highlight_id, annotation_id must be set",
        )

    # Validate target_type matches the non-null FK
    if target_type == "media" and not context_data.get("media_id"):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "target_type='media' requires media_id")
    if target_type == "highlight" and not context_data.get("highlight_id"):
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST, "target_type='highlight' requires highlight_id"
        )
    if target_type == "annotation" and not context_data.get("annotation_id"):
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST, "target_type='annotation' requires annotation_id"
        )


def resolve_media_id_for_context(
    db: Session,
    target_type: str,
    media_id: UUID | None,
    highlight_id: UUID | None,
    annotation_id: UUID | None,
) -> UUID | None:
    """Resolve the media_id for a context target.

    Args:
        db: Database session.
        target_type: The type of context target.
        media_id: Direct media reference (if target_type='media').
        highlight_id: Highlight reference (if target_type='highlight').
        annotation_id: Annotation reference (if target_type='annotation').

    Returns:
        The resolved media_id, or None if target doesn't exist.

    Raises:
        NotFoundError: If the target doesn't exist.
    """
    if target_type == "media":
        # Direct media reference
        media = db.get(Media, media_id)
        if media is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        return media.id

    elif target_type == "highlight":
        # Highlight → fragment.media_id
        highlight = db.get(Highlight, highlight_id)
        if highlight is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Highlight not found")
        return highlight.fragment.media_id

    elif target_type == "annotation":
        # Annotation → highlight.fragment.media_id
        annotation = db.get(Annotation, annotation_id)
        if annotation is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Annotation not found")
        return annotation.highlight.fragment.media_id

    return None


# =============================================================================
# Service Functions
# =============================================================================


def insert_context(
    db: Session,
    message_id: UUID,
    ordinal: int,
    target_type: str,
    media_id: UUID | None = None,
    highlight_id: UUID | None = None,
    annotation_id: UUID | None = None,
) -> MessageContext:
    """Insert a message_context row.

    Args:
        db: Database session.
        message_id: The message to attach context to.
        ordinal: Display order within message (0-indexed).
        target_type: Type of context target.
        media_id: Media ID (if target_type='media').
        highlight_id: Highlight ID (if target_type='highlight').
        annotation_id: Annotation ID (if target_type='annotation').

    Returns:
        The created MessageContext.

    Raises:
        ApiError(E_INVALID_REQUEST): If target_type doesn't match FK.
        NotFoundError: If target doesn't exist.
    """
    # Validate target_type matches FK
    context_data = {
        "media_id": media_id,
        "highlight_id": highlight_id,
        "annotation_id": annotation_id,
    }
    validate_target_type(target_type, context_data)

    # Resolve media_id for conversation_media update
    resolved_media_id = resolve_media_id_for_context(
        db, target_type, media_id, highlight_id, annotation_id
    )

    # Get conversation_id from message
    message = db.get(Message, message_id)
    if message is None:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")

    conversation_id = message.conversation_id

    # Create context
    context = MessageContext(
        message_id=message_id,
        ordinal=ordinal,
        target_type=target_type,
        media_id=media_id,
        highlight_id=highlight_id,
        annotation_id=annotation_id,
    )
    db.add(context)
    db.flush()

    # Upsert conversation_media
    if resolved_media_id:
        upsert_conversation_media(db, conversation_id, resolved_media_id)

    return context


def insert_contexts_batch(
    db: Session,
    message_id: UUID,
    contexts: list[dict],
) -> list[MessageContext]:
    """Insert multiple message_context rows in a batch.

    Args:
        db: Database session.
        message_id: The message to attach contexts to.
        contexts: List of context dicts with keys:
            - ordinal: int
            - target_type: str
            - media_id: UUID | None
            - highlight_id: UUID | None
            - annotation_id: UUID | None

    Returns:
        List of created MessageContext objects.
    """
    results = []
    for ctx in contexts:
        result = insert_context(
            db=db,
            message_id=message_id,
            ordinal=ctx["ordinal"],
            target_type=ctx["target_type"],
            media_id=ctx.get("media_id"),
            highlight_id=ctx.get("highlight_id"),
            annotation_id=ctx.get("annotation_id"),
        )
        results.append(result)
    return results


def upsert_conversation_media(
    db: Session,
    conversation_id: UUID,
    media_id: UUID,
) -> ConversationMedia:
    """Upsert a conversation_media row.

    Creates the row if it doesn't exist, or updates last_message_at if it does.

    Args:
        db: Database session.
        conversation_id: The conversation.
        media_id: The media.

    Returns:
        The ConversationMedia object.
    """
    now = datetime.now(UTC)

    # Try to get existing
    existing = db.scalar(
        select(ConversationMedia).where(
            ConversationMedia.conversation_id == conversation_id,
            ConversationMedia.media_id == media_id,
        )
    )

    if existing:
        # Update last_message_at
        existing.last_message_at = now
        db.flush()
        return existing
    else:
        # Create new
        conv_media = ConversationMedia(
            conversation_id=conversation_id,
            media_id=media_id,
            last_message_at=now,
        )
        db.add(conv_media)
        db.flush()
        return conv_media


def recompute_conversation_media(db: Session, conversation_id: UUID) -> None:
    """Recompute conversation_media from message_context.

    Idempotent repair helper. Safe to call anytime.

    This function:
    1. Finds all media_ids referenced by message_contexts in this conversation
    2. Removes conversation_media rows for media no longer referenced
    3. Adds conversation_media rows for newly referenced media

    Args:
        db: Database session.
        conversation_id: The conversation to recompute.
    """
    # Get all media_ids currently in conversation_media
    current_media_result = db.execute(
        text("""
            SELECT media_id FROM conversation_media
            WHERE conversation_id = :conv_id
        """),
        {"conv_id": conversation_id},
    )
    current_media_ids = {row[0] for row in current_media_result.fetchall()}

    # Get all media_ids that should be in conversation_media
    # (from message_context, resolving highlight/annotation to their media)
    expected_result = db.execute(
        text("""
            SELECT DISTINCT
                COALESCE(
                    mc.media_id,
                    (SELECT f.media_id FROM fragments f
                     JOIN highlights h ON h.fragment_id = f.id
                     WHERE h.id = mc.highlight_id),
                    (SELECT f.media_id FROM fragments f
                     JOIN highlights h ON h.fragment_id = f.id
                     JOIN annotations a ON a.highlight_id = h.id
                     WHERE a.id = mc.annotation_id)
                ) as resolved_media_id
            FROM message_contexts mc
            JOIN messages m ON m.id = mc.message_id
            WHERE m.conversation_id = :conv_id
        """),
        {"conv_id": conversation_id},
    )
    expected_media_ids = {row[0] for row in expected_result.fetchall() if row[0] is not None}

    # Remove stale entries
    to_remove = current_media_ids - expected_media_ids
    if to_remove:
        db.execute(
            delete(ConversationMedia).where(
                ConversationMedia.conversation_id == conversation_id,
                ConversationMedia.media_id.in_(to_remove),
            )
        )

    # Add missing entries
    to_add = expected_media_ids - current_media_ids
    for media_id in to_add:
        conv_media = ConversationMedia(
            conversation_id=conversation_id,
            media_id=media_id,
            last_message_at=datetime.now(UTC),
        )
        db.add(conv_media)

    db.flush()


def get_conversation_media(db: Session, conversation_id: UUID) -> list[ConversationMedia]:
    """Get all conversation_media rows for a conversation.

    Args:
        db: Database session.
        conversation_id: The conversation.

    Returns:
        List of ConversationMedia objects.
    """
    result = db.scalars(
        select(ConversationMedia).where(ConversationMedia.conversation_id == conversation_id)
    )
    return list(result)
