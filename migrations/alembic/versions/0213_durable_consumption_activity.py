"""Add durable capture identity and factual Consumption corrections.

Revision ID: 0213
Revises: 0212
Create Date: 2026-08-10
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0213"
down_revision: str | Sequence[str] | None = "0212"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "consumption_activity_spans",
        sa.Column("capture_key", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.execute("UPDATE consumption_activity_spans SET capture_key = gen_random_uuid()")
    op.alter_column("consumption_activity_spans", "capture_key", nullable=False)
    op.create_unique_constraint(
        "uq_consumption_activity_spans_user_capture_key",
        "consumption_activity_spans",
        ["user_id", "capture_key"],
    )

    op.create_table(
        "consumption_activity_adjustments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", name="fk_consumption_activity_adjustments_user"),
            nullable=False,
        ),
        sa.Column(
            "media_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("media.id", name="fk_consumption_activity_adjustments_media"),
            nullable=False,
        ),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("modality", sa.Text(), nullable=False),
        sa.Column("device_id", sa.Text(), nullable=True),
        sa.Column("occurred_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("duration_ms", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("retracted_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_consumption_activity_adjustments_user_occurred_id",
        "consumption_activity_adjustments",
        ["user_id", "occurred_at", "id"],
    )
    op.create_index(
        "ix_cons_activity_adj_user_media_device_time_id",
        "consumption_activity_adjustments",
        ["user_id", "media_id", "device_id", "occurred_at", "id"],
    )
    op.create_index(
        "ix_consumption_activity_adjustments_media_id",
        "consumption_activity_adjustments",
        ["media_id", "id"],
    )


def downgrade() -> None:
    raise NotImplementedError("0213 is a hard cutover migration and has no downgrade path")
