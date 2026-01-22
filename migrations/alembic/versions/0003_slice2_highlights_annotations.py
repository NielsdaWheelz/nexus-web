"""Slice 2 schema - highlights and annotations tables

Revision ID: 0003
Revises: 0002
Create Date: 2026-01-22

This migration adds persistent storage for highlights and annotations
as defined in Slice 2 (Web Articles + Highlights).

Key changes:
- Create highlights table with offset-based anchoring to fragments
- Create annotations table with 0..1 relationship to highlights
- Add CHECK constraints for valid offsets and colors
- Add unique index preventing duplicate highlight spans per user
- Add unique constraint enforcing one annotation per highlight

Note: annotations.user_id is intentionally omitted. Ownership is derived
via highlights.user_id to avoid ownership drift.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ==========================================================================
    # Step 1: Create highlights table
    # ==========================================================================
    op.create_table(
        "highlights",
        sa.Column(
            "id",
            sa.UUID(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            sa.UUID(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "fragment_id",
            sa.UUID(),
            sa.ForeignKey("fragments.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("start_offset", sa.Integer(), nullable=False),
        sa.Column("end_offset", sa.Integer(), nullable=False),
        sa.Column("color", sa.Text(), nullable=False),
        sa.Column("exact", sa.Text(), nullable=False),
        sa.Column("prefix", sa.Text(), nullable=False),
        sa.Column("suffix", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )

    # ==========================================================================
    # Step 2: Add CHECK constraints for highlights (names must match exactly)
    # ==========================================================================

    # Offset validation: start must be >= 0, end must be > start
    op.create_check_constraint(
        "ck_highlights_offsets_valid",
        "highlights",
        "start_offset >= 0 AND end_offset > start_offset",
    )

    # Color validation: must be one of the allowed palette colors
    op.create_check_constraint(
        "ck_highlights_color",
        "highlights",
        "color IN ('yellow','green','blue','pink','purple')",
    )

    # ==========================================================================
    # Step 3: Create unique index preventing duplicate spans per user
    # ==========================================================================
    op.create_index(
        "uix_highlights_user_fragment_offsets",
        "highlights",
        ["user_id", "fragment_id", "start_offset", "end_offset"],
        unique=True,
    )

    # ==========================================================================
    # Step 4: Create annotations table
    # ==========================================================================
    op.create_table(
        "annotations",
        sa.Column(
            "id",
            sa.UUID(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "highlight_id",
            sa.UUID(),
            sa.ForeignKey("highlights.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )

    # ==========================================================================
    # Step 5: Add unique constraint enforcing one annotation per highlight
    # ==========================================================================
    op.create_unique_constraint(
        "uix_annotations_one_per_highlight",
        "annotations",
        ["highlight_id"],
    )


def downgrade() -> None:
    # ==========================================================================
    # Step 1: Drop annotations table (includes unique constraint)
    # ==========================================================================
    op.drop_table("annotations")

    # ==========================================================================
    # Step 2: Drop highlights constraints and index
    # ==========================================================================
    op.drop_index("uix_highlights_user_fragment_offsets", table_name="highlights")
    op.drop_constraint("ck_highlights_color", "highlights", type_="check")
    op.drop_constraint("ck_highlights_offsets_valid", "highlights", type_="check")

    # ==========================================================================
    # Step 3: Drop highlights table
    # ==========================================================================
    op.drop_table("highlights")
