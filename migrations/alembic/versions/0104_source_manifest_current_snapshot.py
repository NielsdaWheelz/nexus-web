"""Make source manifests current snapshots.

Revision ID: 0104
Revises: 0103
Create Date: 2026-05-15
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0104"
down_revision: str | None = "0103"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        DELETE FROM source_manifests older
        USING source_manifests newer
        WHERE older.chat_run_id = newer.chat_run_id
          AND older.tool_call_index = newer.tool_call_index
          AND (
              older.created_at < newer.created_at
              OR (older.created_at = newer.created_at AND older.id < newer.id)
          )
        """
    )
    op.create_unique_constraint(
        "uix_source_manifests_run_tool_call_index",
        "source_manifests",
        ["chat_run_id", "tool_call_index"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uix_source_manifests_run_tool_call_index",
        "source_manifests",
        type_="unique",
    )
