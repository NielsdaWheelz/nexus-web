"""Sequence assignment helper for message ordering.

Provides atomic sequence number assignment for messages within a conversation
using PostgreSQL row-level locking (FOR UPDATE) to ensure strict ordering
without race conditions.

Per S3 spec:
- Each conversation has a `next_seq` counter (starts at 1)
- Seq assignment locks the conversation row, reads next_seq, increments it
- The returned seq is the one to use for the new message
- Must be called within an existing transaction context
"""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.logging import get_logger

logger = get_logger(__name__)


def assign_next_message_seq(db: Session, conversation_id: UUID) -> int:
    """Atomically assign the next message sequence number for a conversation.

    This function MUST be called within an existing transaction context.
    It does NOT open or commit its own transaction.

    The function:
    1. Locks the conversation row with FOR UPDATE
    2. Reads the current next_seq value
    3. Increments next_seq in the database
    4. Returns the original next_seq value (for use in the new message)

    Args:
        db: Database session (must be in a transaction)
        conversation_id: UUID of the conversation to assign seq for

    Returns:
        The sequence number to use for the new message

    Raises:
        ValueError: If the conversation does not exist
    """
    # Step 1: Lock the conversation row and read current next_seq
    result = db.execute(
        text("""
            SELECT next_seq
            FROM conversations
            WHERE id = :conversation_id
            FOR UPDATE
        """),
        {"conversation_id": conversation_id},
    )
    row = result.fetchone()

    if row is None:
        raise ValueError(f"Conversation {conversation_id} not found")

    current_seq = row[0]

    # Step 2: Increment next_seq in the database
    db.execute(
        text("""
            UPDATE conversations
            SET next_seq = next_seq + 1, updated_at = now()
            WHERE id = :conversation_id
        """),
        {"conversation_id": conversation_id},
    )

    # Step 3: Return the original next_seq (the one we're assigning)
    logger.debug(
        "assigned_message_seq",
        conversation_id=str(conversation_id),
        seq=current_seq,
    )

    return current_seq
