"""Forget every saved workspace layout: the persisted shape changes.

Revision ID: 0267
Revises: 0266

The api now validates the saved session with one pydantic model (panes as one
ordered array, the inspector embedded in its pane, a null width meaning the
reader column). No old-shape row passes it, and there is no compatibility
reader, so every device's next load would read its row as absent anyway. Deleting
them makes the cut explicit: each device's first load after deploy shows one
Lectern pane (or its deep link) and writes a new-shape row within a second.

Downgrade is a no-op: the rows cannot be restored, and the old code reads an
empty table as "no saved session".
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0267"
down_revision: str | Sequence[str] | None = "0266"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("DELETE FROM workspace_sessions")


def downgrade() -> None:
    pass
