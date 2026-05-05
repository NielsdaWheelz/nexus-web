"""Message context item service."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import delete, or_, select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import (
    ConversationMedia,
    Highlight,
    Media,
    Message,
    MessageContextItem,
    NoteBlock,
    ObjectLink,
)
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.conversation import MessageContextRef
from nexus.schemas.notes import ObjectRef
from nexus.services.object_refs import hydrate_object_ref


def _highlight_media_id(highlight: Highlight) -> UUID | None:
    if highlight.anchor_media_id is None:
        return None
    if highlight.anchor_kind == "fragment_offsets":
        anchor = highlight.fragment_anchor
        fragment = anchor.fragment if anchor is not None else None
        if fragment is not None and fragment.media_id == highlight.anchor_media_id:
            return highlight.anchor_media_id
    if highlight.anchor_kind == "pdf_page_geometry":
        anchor = highlight.pdf_anchor
        if anchor is not None and anchor.media_id == highlight.anchor_media_id:
            return highlight.anchor_media_id
    return None


def resolve_media_id_for_context(db: Session, context: MessageContextRef) -> UUID | None:
    if context.type == "media":
        media = db.get(Media, context.id)
        if media is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        return media.id

    if context.type == "highlight":
        highlight = db.get(Highlight, context.id)
        if highlight is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Highlight not found")
        media_id = _highlight_media_id(highlight)
        if media_id is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Highlight not found")
        return media_id

    if context.type == "content_chunk":
        row = db.execute(
            text("SELECT media_id FROM content_chunks WHERE id = :id"),
            {"id": context.id},
        ).fetchone()
        if row is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Content chunk not found")
        return row[0]

    if context.type == "note_block":
        block = db.get(NoteBlock, context.id)
        if block is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Note block not found")
        media_link = db.scalar(
            select(ObjectLink).where(
                or_(
                    (
                        (ObjectLink.a_type == "note_block")
                        & (ObjectLink.a_id == context.id)
                        & (ObjectLink.b_type == "media")
                    ),
                    (
                        (ObjectLink.a_type == "media")
                        & (ObjectLink.b_type == "note_block")
                        & (ObjectLink.b_id == context.id)
                    ),
                )
            )
        )
        if media_link is not None:
            return media_link.b_id if media_link.a_type == "note_block" else media_link.a_id
        highlight_link = db.scalar(
            select(ObjectLink).where(
                or_(
                    (
                        (ObjectLink.a_type == "note_block")
                        & (ObjectLink.a_id == context.id)
                        & (ObjectLink.b_type == "highlight")
                    ),
                    (
                        (ObjectLink.a_type == "highlight")
                        & (ObjectLink.b_type == "note_block")
                        & (ObjectLink.b_id == context.id)
                    ),
                )
            )
        )
        if highlight_link is not None:
            highlight_id = (
                highlight_link.b_id
                if highlight_link.a_type == "note_block"
                else highlight_link.a_id
            )
            highlight = db.get(Highlight, highlight_id)
            if highlight is None:
                raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Highlight not found")
            return _highlight_media_id(highlight)
        return None

    return None


def insert_context(
    db: Session,
    *,
    message_id: UUID,
    ordinal: int,
    context: MessageContextRef,
) -> MessageContextItem:
    message = db.get(Message, message_id)
    if message is None:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")

    hydrated = hydrate_object_ref(
        db,
        message.conversation.owner_user_id,
        ObjectRef(object_type=context.type, object_id=context.id),
    )
    media_id = resolve_media_id_for_context(db, context)
    if media_id is not None and not can_read_media(
        db, message.conversation.owner_user_id, media_id
    ):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Context not found")

    context_snapshot = hydrated.model_dump(mode="json", by_alias=True)
    if context.type == "content_chunk" and context.evidence_span_ids:
        context_snapshot["evidence_span_ids"] = [
            str(span_id) for span_id in context.evidence_span_ids
        ]

    row = MessageContextItem(
        message_id=message_id,
        user_id=message.conversation.owner_user_id,
        ordinal=ordinal,
        object_type=context.type,
        object_id=context.id,
        context_snapshot_json=context_snapshot,
    )
    db.add(row)
    db.flush()

    context_order_key = f"{ordinal + 1:010d}"
    existing_link = db.scalar(
        select(ObjectLink).where(
            ObjectLink.user_id == message.conversation.owner_user_id,
            ObjectLink.relation_type == "used_as_context",
            or_(
                (
                    (ObjectLink.a_type == "message")
                    & (ObjectLink.a_id == message_id)
                    & (ObjectLink.b_type == context.type)
                    & (ObjectLink.b_id == context.id)
                ),
                (
                    (ObjectLink.a_type == context.type)
                    & (ObjectLink.a_id == context.id)
                    & (ObjectLink.b_type == "message")
                    & (ObjectLink.b_id == message_id)
                ),
            ),
            ObjectLink.a_locator_json.is_(None),
            ObjectLink.b_locator_json.is_(None),
        )
    )
    if existing_link is None:
        db.add(
            ObjectLink(
                user_id=message.conversation.owner_user_id,
                relation_type="used_as_context",
                a_type="message",
                a_id=message_id,
                b_type=context.type,
                b_id=context.id,
                a_order_key=context_order_key,
                b_order_key=None,
                a_locator_json=None,
                b_locator_json=None,
                metadata_json={},
            )
        )
    elif existing_link.a_type == "message" and existing_link.a_id == message_id:
        if existing_link.a_order_key is None:
            existing_link.a_order_key = context_order_key
    elif existing_link.b_order_key is None:
        existing_link.b_order_key = context_order_key

    if media_id is not None:
        upsert_conversation_media(db, message.conversation_id, media_id)
    return row


def insert_contexts_batch(
    db: Session,
    *,
    message_id: UUID,
    contexts: Sequence[MessageContextRef],
) -> list[MessageContextItem]:
    return [
        insert_context(db=db, message_id=message_id, ordinal=ordinal, context=context)
        for ordinal, context in enumerate(contexts)
    ]


def upsert_conversation_media(
    db: Session,
    conversation_id: UUID,
    media_id: UUID,
) -> ConversationMedia:
    now = datetime.now(UTC)
    existing = db.scalar(
        select(ConversationMedia).where(
            ConversationMedia.conversation_id == conversation_id,
            ConversationMedia.media_id == media_id,
        )
    )
    if existing is not None:
        existing.last_message_at = now
        db.flush()
        return existing

    row = ConversationMedia(
        conversation_id=conversation_id,
        media_id=media_id,
        last_message_at=now,
    )
    db.add(row)
    db.flush()
    return row


def recompute_conversation_media(db: Session, conversation_id: UUID) -> None:
    current_media_ids = {
        row[0]
        for row in db.execute(
            select(ConversationMedia.media_id).where(
                ConversationMedia.conversation_id == conversation_id
            )
        ).fetchall()
    }

    context_rows = (
        db.execute(
            select(MessageContextItem)
            .join(Message, Message.id == MessageContextItem.message_id)
            .where(Message.conversation_id == conversation_id)
        )
        .scalars()
        .all()
    )

    expected_media_ids: set[UUID] = set()
    for row in context_rows:
        media_id = resolve_media_id_for_context(
            db,
            MessageContextRef.model_validate({"type": row.object_type, "id": row.object_id}),
        )
        if media_id is not None:
            expected_media_ids.add(media_id)

    to_remove = current_media_ids - expected_media_ids
    if to_remove:
        db.execute(
            delete(ConversationMedia).where(
                ConversationMedia.conversation_id == conversation_id,
                ConversationMedia.media_id.in_(to_remove),
            )
        )

    for media_id in expected_media_ids - current_media_ids:
        db.add(
            ConversationMedia(
                conversation_id=conversation_id,
                media_id=media_id,
                last_message_at=datetime.now(UTC),
            )
        )
    db.flush()


def get_conversation_media(db: Session, conversation_id: UUID) -> list[ConversationMedia]:
    return list(
        db.scalars(
            select(ConversationMedia).where(ConversationMedia.conversation_id == conversation_id)
        )
    )
