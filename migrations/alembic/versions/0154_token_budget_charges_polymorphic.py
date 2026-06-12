"""Make token budget charges polymorphic.

Revision ID: 0154
Revises: 0153
Create Date: 2026-06-12

The provider-runtime hard cutover applies the platform-token budget envelope to
chat and background generation owners. Charge idempotency is keyed by the
surface reservation id, not by a chat message row.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0154"
down_revision: str | Sequence[str] | None = "0153"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE token_budget_charges
            DROP CONSTRAINT IF EXISTS token_budget_charges_message_id_fkey
    """)
    op.execute("""
        ALTER TABLE token_budget_charges
            RENAME COLUMN message_id TO reservation_id
    """)


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0154 is not reversible")
