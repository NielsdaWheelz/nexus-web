"""Drop the write-only external provider event ledger.

Revision ID: 0233
Revises: 0232
Create Date: 2026-09-18
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0233"
down_revision: str | Sequence[str] | None = "0232"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_table("external_provider_events")


def downgrade() -> None:
    raise NotImplementedError("0233 is an irreversible dead-schema hard cutover")
