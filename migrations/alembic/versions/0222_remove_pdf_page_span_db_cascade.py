"""Make PDF page-span deletion an explicit application responsibility.

Revision ID: 0222
Revises: 0221
Create Date: 2026-08-25
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0222"
down_revision: str | Sequence[str] | None = "0221"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_CONSTRAINT = "pdf_page_text_spans_media_id_fkey"


def upgrade() -> None:
    op.drop_constraint(
        _CONSTRAINT,
        "pdf_page_text_spans",
        type_="foreignkey",
    )
    op.create_foreign_key(
        _CONSTRAINT,
        "pdf_page_text_spans",
        "media",
        ["media_id"],
        ["id"],
    )


def downgrade() -> None:
    raise NotImplementedError("0222 is an irreversible explicit-deletion hard cutover")
