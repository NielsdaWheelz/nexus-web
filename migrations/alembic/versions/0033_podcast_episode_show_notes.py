"""Add show-notes persistence columns for podcast episodes.

Revision ID: 0033
Revises: 0032
Create Date: 2026-03-22
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0033"
down_revision: str | None = "0032"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("podcast_episodes", sa.Column("description_html", sa.Text(), nullable=True))
    op.add_column("podcast_episodes", sa.Column("description_text", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("podcast_episodes", "description_text")
    op.drop_column("podcast_episodes", "description_html")
