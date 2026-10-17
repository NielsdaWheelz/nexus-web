"""Reset device layouts for the strict workspace visit title-hint contract.

Revision ID: 0287
Revises: 0286

Only disposable workspace sessions are removed. Content, ownership, credentials
and consumption remain. Wire revision 2 refuses old clients before they can
write the former shape again. Stop writers before applying this hard cutover.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0287"
down_revision: str | Sequence[str] | None = "0286"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("DELETE FROM workspace_sessions")


def downgrade() -> None:
    raise NotImplementedError("0287 is irreversible; restore the pre-release backup")
