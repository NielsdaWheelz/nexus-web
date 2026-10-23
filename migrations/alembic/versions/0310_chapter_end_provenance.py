"""Record whether a publisher chapter end was observed absent.

Revision ID: 0310
Revises: 0309

Data effects: retain every chapter id, index, title and supplied start/end. Existing
null ends remain unverified: false never infers their lost source provenance. Only
subsequent feed observations may confirm absence and permit a derived next start.
No source data is converted or discarded.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0310"
down_revision: str | Sequence[str] | None = "0309"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "podcast_episode_chapters",
        sa.Column(
            "end_absence_confirmed",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    raise NotImplementedError("0310 is irreversible; restore the pre-release backup")
