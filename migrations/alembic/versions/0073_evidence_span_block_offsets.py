"""Allow evidence spans across block-local offsets.

Revision ID: 0073
Revises: 0072
Create Date: 2026-05-03
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0073"
down_revision: str | None = "0072"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint("ck_evidence_spans_offsets", "evidence_spans", type_="check")
    op.create_check_constraint(
        "ck_evidence_spans_offsets",
        "evidence_spans",
        "start_block_id <> end_block_id OR end_block_offset >= start_block_offset",
    )


def downgrade() -> None:
    op.drop_constraint("ck_evidence_spans_offsets", "evidence_spans", type_="check")
    op.create_check_constraint(
        "ck_evidence_spans_offsets",
        "evidence_spans",
        "end_block_offset >= start_block_offset",
    )
