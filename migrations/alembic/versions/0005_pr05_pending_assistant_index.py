"""PR-05: Add partial unique index for pending assistant uniqueness

Revision ID: 0005
Revises: 0004
Create Date: 2026-01-25

This migration adds a partial unique index to enforce that each conversation
can have at most one pending assistant message at a time.

Per PR-05 spec Section 5:
- Service-layer checks are brittle
- This turns the "at most one pending assistant per conversation" assumption
  into a physical invariant that survives refactors
- Violation raises IntegrityError → E_CONVERSATION_BUSY

Index definition:
CREATE UNIQUE INDEX uix_one_pending_assistant_per_conversation
ON messages (conversation_id)
WHERE role = 'assistant' AND status = 'pending';
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Create partial unique index to enforce at most one pending assistant per conversation
    # This provides physical enforcement of the invariant (defense in depth)
    op.execute(
        """
        CREATE UNIQUE INDEX uix_one_pending_assistant_per_conversation
        ON messages (conversation_id)
        WHERE role = 'assistant' AND status = 'pending'
        """
    )


def downgrade() -> None:
    op.drop_index("uix_one_pending_assistant_per_conversation", table_name="messages")
