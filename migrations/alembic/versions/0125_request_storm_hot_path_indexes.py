"""Add hot-path indexes for request storm recovery.

Revision ID: 0125
Revises: 0124
Create Date: 2026-05-31
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0125"
down_revision: str | None = "0124"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index(
        "ix_library_entries_library_order",
        "library_entries",
        ["library_id", "position", sa.text("created_at DESC"), sa.text("id DESC")],
    )
    op.create_index(
        "ix_workspace_sessions_user_updated",
        "workspace_sessions",
        ["user_id", sa.text("updated_at DESC"), sa.text("id DESC")],
    )
    op.create_index(
        "ix_user_pinned_objects_active_order",
        "user_pinned_objects",
        ["user_id", "surface_key", "order_key", "created_at", "id"],
        postgresql_where=sa.text("deleted_at IS NULL"),
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0125 is not reversible")
