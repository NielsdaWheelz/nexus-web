"""Remove user-pinned navigation objects.

The application no longer exposes pinned navigation resources. Drop the
feature-owned table, including its ordering index and constraints, rather than
leaving unreachable user state behind.

Revision ID: 0185
Revises: 0184
Create Date: 2026-07-20
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0185"
down_revision: str | Sequence[str] | None = "0184"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_table("user_pinned_objects")


def downgrade() -> None:
    raise NotImplementedError(
        "0185 is a hard cutover migration and has no downgrade path: pinned"
        " navigation state was deliberately deleted and cannot be reconstructed."
    )
