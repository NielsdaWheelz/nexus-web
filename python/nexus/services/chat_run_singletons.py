"""Singleton chat resolution: (viewer, kind, target) -> conversation_id."""

from typing import Literal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import ChatSingleton, Library, Media
from nexus.services.conversations import create_conversation, get_message_count
from nexus.services.pinned_sources import auto_pin_singleton_target


def get_singleton_conversation_for_media(
    db: Session, viewer_id: UUID, media_id: UUID
) -> UUID | None:
    """Return the doc-chat singleton conversation id for this viewer + media, or None."""
    return db.execute(
        select(ChatSingleton.conversation_id).where(
            ChatSingleton.user_id == viewer_id,
            ChatSingleton.kind == "media",
            ChatSingleton.target_id == media_id,
        )
    ).scalar_one_or_none()


def get_singleton_conversation_for_library(
    db: Session, viewer_id: UUID, library_id: UUID
) -> UUID | None:
    """Return the library-chat singleton conversation id for this viewer + library, or None."""
    return db.execute(
        select(ChatSingleton.conversation_id).where(
            ChatSingleton.user_id == viewer_id,
            ChatSingleton.kind == "library",
            ChatSingleton.target_id == library_id,
        )
    ).scalar_one_or_none()


def get_singleton_state_for_media(
    db: Session, viewer_id: UUID, media_id: UUID
) -> tuple[UUID | None, int]:
    """Return (conversation_id, message_count) for the doc-chat singleton (§7.2).

    Returns (None, 0) when no singleton exists yet — singletons are lazily
    materialized on first POST /chat-runs (§4.7), not by this read path.
    """
    conversation_id = get_singleton_conversation_for_media(db, viewer_id, media_id)
    if conversation_id is None:
        return None, 0
    return conversation_id, get_message_count(db, conversation_id)


def get_singleton_state_for_library(
    db: Session, viewer_id: UUID, library_id: UUID
) -> tuple[UUID | None, int]:
    """Return (conversation_id, message_count) for the library-chat singleton (§7.3).

    Returns (None, 0) when no singleton exists yet — singletons are lazily
    materialized on first POST /chat-runs (§4.7), not by this read path.
    """
    conversation_id = get_singleton_conversation_for_library(db, viewer_id, library_id)
    if conversation_id is None:
        return None, 0
    return conversation_id, get_message_count(db, conversation_id)


def resolve_singleton_conversation(
    db: Session, viewer_id: UUID, kind: Literal["media", "library"], target_id: UUID
) -> UUID:
    """Return the singleton conversation id for this viewer + (kind, target), creating it lazily."""
    existing = db.execute(
        select(ChatSingleton.conversation_id).where(
            ChatSingleton.user_id == viewer_id,
            ChatSingleton.kind == kind,
            ChatSingleton.target_id == target_id,
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing
    conversation = create_conversation(db, viewer_id)
    db.add(
        ChatSingleton(
            user_id=viewer_id,
            kind=kind,
            target_id=target_id,
            conversation_id=conversation.id,
        )
    )
    if kind == "media":
        media = db.get(Media, target_id)
        title = media.title if media is not None else "Document"
    else:
        library = db.get(Library, target_id)
        title = library.name if library is not None else "Library"
    auto_pin_singleton_target(
        db,
        conversation_id=conversation.id,
        kind=kind,
        target_id=target_id,
        title=title,
    )
    db.flush()
    return conversation.id
