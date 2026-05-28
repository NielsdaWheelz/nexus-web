"""Conversation pinned sources: persistent scope (media / library / reader_selection)."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_conversation
from nexus.db.models import Conversation, ConversationPinnedSource
from nexus.errors import ApiErrorCode, ForbiddenError, NotFoundError
from nexus.schemas.conversation import (
    AddPinnedSourceRequest,
    ConversationPinnedSourceOut,
)


def _require_owner(db: Session, viewer_id: UUID, conversation_id: UUID) -> Conversation:
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or not can_read_conversation(db, viewer_id, conversation_id):
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    if conversation.owner_user_id != viewer_id:
        raise ForbiddenError(ApiErrorCode.E_OWNER_REQUIRED, "Owner required")
    return conversation


def _to_out(row: ConversationPinnedSource) -> ConversationPinnedSourceOut:
    return ConversationPinnedSourceOut(
        id=row.id,
        ordinal=row.ordinal,
        kind=row.kind,  # type: ignore[arg-type]
        target_id=row.target_id,
        locator=row.locator_json,  # type: ignore[arg-type]
        source_version=row.source_version,
        exact=row.exact,
        title=row.title,
        created_at=row.created_at,
    )


def list_pinned_sources(
    db: Session, *, viewer_id: UUID, conversation_id: UUID
) -> list[ConversationPinnedSourceOut]:
    _require_owner(db, viewer_id, conversation_id)
    rows = (
        db.execute(
            select(ConversationPinnedSource)
            .where(ConversationPinnedSource.conversation_id == conversation_id)
            .order_by(ConversationPinnedSource.ordinal.asc())
        )
        .scalars()
        .all()
    )
    return [_to_out(r) for r in rows]


def add_pinned_source(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    request: AddPinnedSourceRequest,
) -> ConversationPinnedSourceOut:
    _require_owner(db, viewer_id, conversation_id)
    next_ordinal = db.execute(
        select(func.coalesce(func.max(ConversationPinnedSource.ordinal), 0) + 1).where(
            ConversationPinnedSource.conversation_id == conversation_id
        )
    ).scalar_one()
    row = ConversationPinnedSource(
        conversation_id=conversation_id,
        ordinal=next_ordinal,
        kind=request.kind,
        target_id=request.target_id,
        locator_json=request.locator.model_dump(mode="json") if request.locator else None,
        source_version=request.source_version,
        exact=request.exact,
        title=request.title,
    )
    db.add(row)
    db.flush()
    db.commit()
    db.refresh(row)
    return _to_out(row)


def remove_pinned_source(
    db: Session, *, viewer_id: UUID, conversation_id: UUID, ordinal: int
) -> None:
    _require_owner(db, viewer_id, conversation_id)
    row = db.execute(
        select(ConversationPinnedSource).where(
            ConversationPinnedSource.conversation_id == conversation_id,
            ConversationPinnedSource.ordinal == ordinal,
        )
    ).scalar_one_or_none()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Pinned source not found")
    db.delete(row)
    db.commit()


def auto_pin_singleton_target(
    db: Session,
    *,
    conversation_id: UUID,
    kind: str,
    target_id: UUID,
    title: str,
) -> None:
    """Add a media/library pin for a singleton conversation if none exists."""
    existing = db.execute(
        select(ConversationPinnedSource.id).where(
            ConversationPinnedSource.conversation_id == conversation_id,
            ConversationPinnedSource.kind == kind,
            ConversationPinnedSource.target_id == target_id,
        )
    ).first()
    if existing is not None:
        return
    next_ordinal = db.execute(
        select(func.coalesce(func.max(ConversationPinnedSource.ordinal), 0) + 1).where(
            ConversationPinnedSource.conversation_id == conversation_id
        )
    ).scalar_one()
    db.add(
        ConversationPinnedSource(
            conversation_id=conversation_id,
            ordinal=next_ordinal,
            kind=kind,
            target_id=target_id,
            title=title,
        )
    )
    db.flush()


def copy_pinned_sources(
    db: Session, *, source_conversation_id: UUID, target_conversation_id: UUID
) -> None:
    """Copy all pinned sources from source to target conversation (used by fork)."""
    rows = (
        db.execute(
            select(ConversationPinnedSource)
            .where(ConversationPinnedSource.conversation_id == source_conversation_id)
            .order_by(ConversationPinnedSource.ordinal.asc())
        )
        .scalars()
        .all()
    )
    for row in rows:
        db.add(
            ConversationPinnedSource(
                conversation_id=target_conversation_id,
                ordinal=row.ordinal,
                kind=row.kind,
                target_id=row.target_id,
                locator_json=row.locator_json,
                source_version=row.source_version,
                exact=row.exact,
                title=row.title,
            )
        )
    db.flush()
