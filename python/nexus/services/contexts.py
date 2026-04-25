"""Message Context service layer.

Implements context insertion and conversation_media management for Slice 3, PR-02.

This module provides helpers for:
- Inserting message_context rows with ordinal ordering
- Resolving media_id from canonical typed context targets
- Transactionally upserting conversation_media
- Recomputing conversation_media (repair helper)

NO PUBLIC ROUTES use this directly. Chat runs use it while preparing user
message context rows.
"""

from collections.abc import Sequence
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from nexus.db.models import (
    Annotation,
    ConversationMedia,
    Highlight,
    Media,
    Message,
    MessageContext,
)
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.logging import get_logger
from nexus.schemas.conversation import MessageContextRef

logger = get_logger(__name__)


# =============================================================================
# Helper Functions
# =============================================================================


def _context_foreign_keys(
    context: MessageContextRef,
) -> tuple[UUID | None, UUID | None, UUID | None]:
    if context.type == "media":
        return context.id, None, None
    if context.type == "highlight":
        return None, context.id, None
    return None, None, context.id


def _resolve_typed_highlight_media_id(highlight: Highlight) -> UUID | None:
    """Resolve the media id for a canonical typed highlight."""
    if highlight.anchor_media_id is None:
        return None

    if highlight.anchor_kind == "fragment_offsets":
        fragment_anchor = highlight.fragment_anchor
        fragment = fragment_anchor.fragment if fragment_anchor is not None else None
        if fragment is not None and fragment.media_id == highlight.anchor_media_id:
            return highlight.anchor_media_id

    if highlight.anchor_kind == "pdf_page_geometry":
        pdf_anchor = highlight.pdf_anchor
        if pdf_anchor is not None and pdf_anchor.media_id == highlight.anchor_media_id:
            return highlight.anchor_media_id

    return None


def resolve_media_id_for_context(
    db: Session,
    context: MessageContextRef,
) -> UUID:
    """Resolve the media_id for a context target.

    Uses canonical typed anchors for highlight and annotation targets.

    Args:
        db: Database session.
        context: Canonical typed context target.

    Returns:
        The resolved media_id.

    Raises:
        NotFoundError: If the target doesn't exist.
    """
    if context.type == "media":
        media_id, _, _ = _context_foreign_keys(context)
        media = db.get(Media, media_id)
        if media is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        return media.id

    if context.type == "highlight":
        _, highlight_id, _ = _context_foreign_keys(context)
        highlight = db.get(Highlight, highlight_id)
        if highlight is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Highlight not found")
        media_id = _resolve_typed_highlight_media_id(highlight)
        if media_id is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Highlight not found")
        return media_id

    if context.type == "annotation":
        _, _, annotation_id = _context_foreign_keys(context)
        annotation = db.get(Annotation, annotation_id)
        if annotation is None or annotation.highlight is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Annotation not found")
        media_id = _resolve_typed_highlight_media_id(annotation.highlight)
        if media_id is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Annotation not found")
        return media_id

    raise AssertionError(f"Unsupported context type: {context.type}")


# =============================================================================
# Service Functions
# =============================================================================


def insert_context(
    db: Session,
    *,
    message_id: UUID,
    ordinal: int,
    context: MessageContextRef,
) -> MessageContext:
    """Insert a message_context row.

    Args:
        db: Database session.
        message_id: The message to attach context to.
        ordinal: Display order within message (0-indexed).
        context: Canonical typed context target.

    Returns:
        The created MessageContext.

    Raises:
        NotFoundError: If target doesn't exist.
    """
    media_id, highlight_id, annotation_id = _context_foreign_keys(context)

    # Resolve media_id for conversation_media update
    resolved_media_id = resolve_media_id_for_context(db, context)

    # Get conversation_id from message
    message = db.get(Message, message_id)
    if message is None:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")

    conversation_id = message.conversation_id

    # Create context
    created_context = MessageContext(
        message_id=message_id,
        ordinal=ordinal,
        target_type=context.type,
        media_id=media_id,
        highlight_id=highlight_id,
        annotation_id=annotation_id,
    )
    db.add(created_context)
    db.flush()

    # Upsert conversation_media
    upsert_conversation_media(db, conversation_id, resolved_media_id)

    return created_context


def insert_contexts_batch(
    db: Session,
    *,
    message_id: UUID,
    contexts: Sequence[MessageContextRef],
) -> list[MessageContext]:
    """Insert multiple message_context rows in a batch.

    Args:
        db: Database session.
        message_id: The message to attach contexts to.
        contexts: Ordered canonical typed context targets.

    Returns:
        List of created MessageContext objects.
    """
    return [
        insert_context(
            db=db,
            message_id=message_id,
            ordinal=ordinal,
            context=context,
        )
        for ordinal, context in enumerate(contexts)
    ]


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
    1. Bulk-loads message_context references and referenced highlights/annotations
    2. Resolves highlight/annotation media via side-effect-free typed-anchor logic
    3. Computes expected media set in Python
    4. Applies set-diff updates to conversation_media

    Args:
        db: Database session.
        conversation_id: The conversation to recompute.
    """
    current_media_result = db.execute(
        select(ConversationMedia.media_id).where(
            ConversationMedia.conversation_id == conversation_id
        )
    )
    current_media_ids = {row[0] for row in current_media_result.fetchall()}

    context_rows = (
        db.query(MessageContext)
        .join(Message, Message.id == MessageContext.message_id)
        .filter(Message.conversation_id == conversation_id)
        .all()
    )

    expected_media_ids: set[UUID] = set()
    for ctx in context_rows:
        resolved = _resolve_context_media_id(db, ctx)
        if resolved is not None:
            expected_media_ids.add(resolved)

    to_remove = current_media_ids - expected_media_ids
    if to_remove:
        db.execute(
            delete(ConversationMedia).where(
                ConversationMedia.conversation_id == conversation_id,
                ConversationMedia.media_id.in_(to_remove),
            )
        )

    to_add = expected_media_ids - current_media_ids
    for mid in to_add:
        conv_media = ConversationMedia(
            conversation_id=conversation_id,
            media_id=mid,
            last_message_at=datetime.now(UTC),
        )
        db.add(conv_media)

    db.flush()


def _resolve_context_media_id(db, ctx) -> UUID | None:
    """Resolve media_id for a single message_context row."""
    if ctx.target_type == "media" and ctx.media_id is not None:
        media = db.get(Media, ctx.media_id)
        return media.id if media else None

    if ctx.target_type == "highlight" and ctx.highlight_id is not None:
        highlight = db.get(Highlight, ctx.highlight_id)
        if highlight is None:
            return None
        return _resolve_typed_highlight_media_id(highlight)

    if ctx.target_type == "annotation" and ctx.annotation_id is not None:
        annotation = db.get(Annotation, ctx.annotation_id)
        if annotation is None:
            return None
        highlight = annotation.highlight
        if highlight is None:
            return None
        return _resolve_typed_highlight_media_id(highlight)

    return None


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
