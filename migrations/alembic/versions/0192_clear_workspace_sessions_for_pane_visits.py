"""Clear workspace sessions for the PaneVisit persistence hard cutover.

Revision ID: 0192
Revises: 0191
Create Date: 2026-07-23
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0192"
down_revision: str | None = "0191"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("DELETE FROM workspace_sessions")


def downgrade() -> None:
    raise RuntimeError(
        "0192 is a hard cutover migration and has no downgrade path: "
        "discarded workspace session JSON is unrecoverable"
    )
