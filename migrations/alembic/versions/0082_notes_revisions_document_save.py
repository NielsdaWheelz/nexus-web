"""Notes revisions and document save.

Revision ID: 0082
Revises: 0081
Create Date: 2026-05-08
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0082"
down_revision: str | None = "0081"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "pages",
        sa.Column("revision", sa.Integer(), nullable=False, server_default=sa.text("1")),
    )
    op.add_column(
        "note_blocks",
        sa.Column("revision", sa.Integer(), nullable=False, server_default=sa.text("1")),
    )
    op.execute(
        "ALTER TABLE pages ADD CONSTRAINT ck_pages_revision_positive "
        "CHECK (revision >= 1) NOT VALID"
    )
    op.execute("ALTER TABLE pages VALIDATE CONSTRAINT ck_pages_revision_positive")
    op.execute(
        "ALTER TABLE note_blocks ADD CONSTRAINT ck_note_blocks_revision_positive "
        "CHECK (revision >= 1) NOT VALID"
    )
    op.execute("ALTER TABLE note_blocks VALIDATE CONSTRAINT ck_note_blocks_revision_positive")


def downgrade() -> None:
    op.drop_constraint("ck_note_blocks_revision_positive", "note_blocks", type_="check")
    op.drop_constraint("ck_pages_revision_positive", "pages", type_="check")
    op.drop_column("note_blocks", "revision")
    op.drop_column("pages", "revision")
