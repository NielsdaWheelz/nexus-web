"""Persist PDF page labels and page geometry.

Revision ID: 0074
Revises: 0073
Create Date: 2026-05-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0074"
down_revision: str | None = "0073"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("pdf_page_text_spans", sa.Column("page_label", sa.Text(), nullable=True))
    op.add_column("pdf_page_text_spans", sa.Column("page_width", sa.Float(), nullable=True))
    op.add_column("pdf_page_text_spans", sa.Column("page_height", sa.Float(), nullable=True))
    op.add_column(
        "pdf_page_text_spans",
        sa.Column("page_rotation_degrees", sa.Integer(), nullable=True),
    )
    op.create_check_constraint(
        "ck_ppts_page_width",
        "pdf_page_text_spans",
        "page_width IS NULL OR page_width > 0",
    )
    op.create_check_constraint(
        "ck_ppts_page_height",
        "pdf_page_text_spans",
        "page_height IS NULL OR page_height > 0",
    )
    op.create_check_constraint(
        "ck_ppts_page_rotation",
        "pdf_page_text_spans",
        "page_rotation_degrees IS NULL OR page_rotation_degrees >= 0",
    )


def downgrade() -> None:
    op.drop_constraint("ck_ppts_page_rotation", "pdf_page_text_spans", type_="check")
    op.drop_constraint("ck_ppts_page_height", "pdf_page_text_spans", type_="check")
    op.drop_constraint("ck_ppts_page_width", "pdf_page_text_spans", type_="check")
    op.drop_column("pdf_page_text_spans", "page_rotation_degrees")
    op.drop_column("pdf_page_text_spans", "page_height")
    op.drop_column("pdf_page_text_spans", "page_width")
    op.drop_column("pdf_page_text_spans", "page_label")
