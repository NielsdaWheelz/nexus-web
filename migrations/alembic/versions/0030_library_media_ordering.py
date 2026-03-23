"""Add library media ordering column for sortable playlists.

Revision ID: 0030
Revises: 0029
Create Date: 2026-03-22
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0030"
down_revision: str | None = "0029"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "library_media",
        sa.Column("position", sa.Integer(), nullable=True, server_default=sa.text("0")),
    )
    op.execute(
        """
        WITH ordered AS (
            SELECT
                library_id,
                media_id,
                ROW_NUMBER() OVER (
                    PARTITION BY library_id
                    ORDER BY created_at DESC, media_id DESC
                ) - 1 AS new_position
            FROM library_media
        )
        UPDATE library_media lm
        SET position = ordered.new_position
        FROM ordered
        WHERE lm.library_id = ordered.library_id
          AND lm.media_id = ordered.media_id
        """
    )
    op.alter_column(
        "library_media",
        "position",
        nullable=False,
        server_default=sa.text("0"),
    )
    op.create_check_constraint(
        "ck_library_media_position_non_negative",
        "library_media",
        "position >= 0",
    )
    op.create_index(
        "ix_library_media_library_position",
        "library_media",
        ["library_id", "position"],
    )


def downgrade() -> None:
    op.drop_index("ix_library_media_library_position", table_name="library_media")
    op.drop_constraint("ck_library_media_position_non_negative", "library_media")
    op.drop_column("library_media", "position")
