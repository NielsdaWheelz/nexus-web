"""Persist revisioned Empty reader-cursor tombstones.

Revision ID: 0195
Revises: 0194
Create Date: 2026-07-24
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0195"
down_revision: str | Sequence[str] | None = "0194"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE reader_media_state ALTER COLUMN locator DROP NOT NULL")


def downgrade() -> None:
    raise RuntimeError(
        "0195 is a hard cutover migration; revisioned Empty reader cursors have no downgrade path"
    )
