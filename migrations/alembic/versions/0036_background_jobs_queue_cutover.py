"""Add durable Postgres background_jobs queue table.

Revision ID: 0036
Revises: 0035
Create Date: 2026-03-23
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0036"
down_revision: str | None = "0035"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "background_jobs",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column(
            "payload",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("status", sa.Text(), nullable=False, server_default=sa.text("'pending'")),
        sa.Column("priority", sa.Integer(), nullable=False, server_default=sa.text("100")),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("max_attempts", sa.Integer(), nullable=False, server_default=sa.text("3")),
        sa.Column(
            "available_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("lease_expires_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("claimed_by", sa.Text(), nullable=True),
        sa.Column("dedupe_key", sa.Text(), nullable=True),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column(
            "result",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column("started_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("finished_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'running', 'succeeded', 'failed', 'dead')",
            name="ck_background_jobs_status",
        ),
        sa.CheckConstraint("attempts >= 0", name="ck_background_jobs_attempts_non_negative"),
        sa.CheckConstraint("max_attempts >= 1", name="ck_background_jobs_max_attempts_positive"),
    )

    op.create_index(
        "idx_background_jobs_status_available_priority_created",
        "background_jobs",
        ["status", "available_at", "priority", "created_at"],
    )
    op.create_index(
        "idx_background_jobs_kind_status_available",
        "background_jobs",
        ["kind", "status", "available_at"],
    )
    op.create_index(
        "idx_background_jobs_dedupe_key_unique",
        "background_jobs",
        ["dedupe_key"],
        unique=True,
        postgresql_where=sa.text("dedupe_key IS NOT NULL"),
    )
    op.create_index(
        "idx_background_jobs_lease_expires_at",
        "background_jobs",
        ["lease_expires_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_background_jobs_lease_expires_at", table_name="background_jobs")
    op.drop_index("idx_background_jobs_dedupe_key_unique", table_name="background_jobs")
    op.drop_index("idx_background_jobs_kind_status_available", table_name="background_jobs")
    op.drop_index(
        "idx_background_jobs_status_available_priority_created",
        table_name="background_jobs",
    )
    op.drop_table("background_jobs")

