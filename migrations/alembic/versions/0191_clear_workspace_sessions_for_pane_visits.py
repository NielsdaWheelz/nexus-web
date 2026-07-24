"""Clear workspace sessions for the PaneVisit persistence hard cutover.

Revision ID: 0191
Revises: 0190
Create Date: 2026-07-23
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0191"
down_revision: str | None = "0190"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("DELETE FROM workspace_sessions")


def downgrade() -> None:
    raise RuntimeError(
        "0191 is a hard cutover migration and has no downgrade path: "
        "discarded workspace session JSON is unrecoverable"
    )
