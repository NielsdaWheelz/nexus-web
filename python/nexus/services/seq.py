"""Atomic message-sequence assignment for one conversation."""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, NotFoundError


def assign_next_message_seq(db: Session, conversation_id: UUID) -> int:
    """Claim the next message seq; must run inside an existing transaction."""
    seq = db.execute(
        text("""
            UPDATE conversations
            SET next_seq = next_seq + 1, updated_at = now()
            WHERE id = :conversation_id
            RETURNING next_seq - 1
        """),
        {"conversation_id": conversation_id},
    ).scalar_one_or_none()
    if seq is None:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    return int(seq)
