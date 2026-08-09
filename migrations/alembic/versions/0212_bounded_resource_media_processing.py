"""Add bounded media-processing capacity and source progress.

Revision ID: 0212
Revises: 0211
Create Date: 2026-08-07
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0212"
down_revision: str | Sequence[str] | None = "0211"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "background_job_capacity_leases",
        sa.Column("resource_class", sa.Text(), primary_key=True, nullable=False),
        sa.Column(
            "job_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("background_jobs.id"),
            nullable=True,
        ),
        sa.Column("worker_id", sa.Text(), nullable=True),
        sa.Column("attempt_no", sa.Integer(), nullable=True),
        sa.Column("lease_expires_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.execute(
        """
        INSERT INTO background_job_capacity_leases (resource_class)
        VALUES ('Heavy')
        """
    )

    op.add_column(
        "media_source_attempts",
        sa.Column("processing_stage", sa.Text(), nullable=True),
    )
    op.add_column(
        "media_source_attempts",
        sa.Column(
            "progress_completed",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )
    op.add_column(
        "media_source_attempts",
        sa.Column("progress_total", sa.Integer(), nullable=True),
    )
    op.add_column(
        "media_source_attempts",
        sa.Column("progress_unit", sa.Text(), nullable=True),
    )
    op.add_column(
        "media_source_attempts",
        sa.Column("progress_updated_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )


def downgrade() -> None:
    raise NotImplementedError(
        "0212 is a hard cutover migration and has no downgrade path"
    )
