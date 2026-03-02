"""Slice 7 PR-03 — transcript timing invariants

Revision ID: 0013
Revises: 0012
Create Date: 2026-03-02
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Drop legacy rows that violate the stricter invariant to keep migration
    # forward-only and guarantee all post-migration transcript fragments satisfy
    # t_start_ms < t_end_ms.
    op.execute(
        """
        DELETE FROM fragments
        WHERE t_start_ms IS NOT NULL
          AND t_end_ms IS NOT NULL
          AND t_end_ms <= t_start_ms
        """
    )

    op.drop_constraint("ck_fragments_time_offsets_valid", "fragments", type_="check")
    op.create_check_constraint(
        "ck_fragments_time_offsets_valid",
        "fragments",
        "(t_start_ms IS NULL OR t_start_ms >= 0) "
        "AND (t_end_ms IS NULL OR t_end_ms >= 0) "
        "AND (t_start_ms IS NULL OR t_end_ms > t_start_ms)",
    )


def downgrade() -> None:
    op.drop_constraint("ck_fragments_time_offsets_valid", "fragments", type_="check")
    op.create_check_constraint(
        "ck_fragments_time_offsets_valid",
        "fragments",
        "(t_start_ms IS NULL OR t_start_ms >= 0) "
        "AND (t_end_ms IS NULL OR t_end_ms >= 0) "
        "AND (t_start_ms IS NULL OR t_end_ms >= t_start_ms)",
    )
