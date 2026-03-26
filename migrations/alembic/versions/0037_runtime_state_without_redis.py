"""Add Postgres-backed runtime state tables.

Revision ID: 0037
Revises: 0036
Create Date: 2026-03-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0037"
down_revision: str | None = "0036"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "stream_token_jti_claims",
        sa.Column("jti", sa.Text(), primary_key=True, nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("expires_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index(
        "idx_stream_token_jti_claims_expires_at",
        "stream_token_jti_claims",
        ["expires_at"],
    )

    op.create_table(
        "stream_liveness_markers",
        sa.Column("assistant_message_id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("expires_at", sa.TIMESTAMP(timezone=True), nullable=False),
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
        sa.ForeignKeyConstraint(
            ["assistant_message_id"],
            ["messages.id"],
            ondelete="CASCADE",
        ),
    )
    op.create_index(
        "idx_stream_liveness_markers_expires_at",
        "stream_liveness_markers",
        ["expires_at"],
    )

    op.create_table(
        "rate_limit_request_log",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True, nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "requested_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index(
        "idx_rate_limit_request_log_user_requested_at",
        "rate_limit_request_log",
        ["user_id", "requested_at"],
    )

    op.create_table(
        "rate_limit_inflight",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "inflight_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint("inflight_count >= 0", name="ck_rate_limit_inflight_non_negative"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )

    op.create_table(
        "token_budget_daily_usage",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("usage_date", sa.Date(), nullable=False),
        sa.Column("spent_tokens", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("reserved_tokens", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.PrimaryKeyConstraint("user_id", "usage_date", name="pk_token_budget_daily_usage"),
        sa.CheckConstraint("spent_tokens >= 0", name="ck_token_budget_daily_spent_non_negative"),
        sa.CheckConstraint(
            "reserved_tokens >= 0",
            name="ck_token_budget_daily_reserved_non_negative",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )

    op.create_table(
        "token_budget_charges",
        sa.Column("message_id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("usage_date", sa.Date(), nullable=False),
        sa.Column("charged_tokens", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint("charged_tokens >= 0", name="ck_token_budget_charged_non_negative"),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index(
        "idx_token_budget_charges_user_usage_date",
        "token_budget_charges",
        ["user_id", "usage_date"],
    )

    op.create_table(
        "token_budget_reservations",
        sa.Column("reservation_id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("usage_date", sa.Date(), nullable=False),
        sa.Column("reserved_tokens", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint("reserved_tokens > 0", name="ck_token_budget_reserved_positive"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index(
        "idx_token_budget_reservations_user_usage_date",
        "token_budget_reservations",
        ["user_id", "usage_date"],
    )
    op.create_index(
        "idx_token_budget_reservations_expires_at",
        "token_budget_reservations",
        ["expires_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "idx_token_budget_reservations_expires_at",
        table_name="token_budget_reservations",
    )
    op.drop_index(
        "idx_token_budget_reservations_user_usage_date",
        table_name="token_budget_reservations",
    )
    op.drop_table("token_budget_reservations")

    op.drop_index(
        "idx_token_budget_charges_user_usage_date",
        table_name="token_budget_charges",
    )
    op.drop_table("token_budget_charges")

    op.drop_table("token_budget_daily_usage")
    op.drop_table("rate_limit_inflight")

    op.drop_index(
        "idx_rate_limit_request_log_user_requested_at",
        table_name="rate_limit_request_log",
    )
    op.drop_table("rate_limit_request_log")

    op.drop_index(
        "idx_stream_liveness_markers_expires_at",
        table_name="stream_liveness_markers",
    )
    op.drop_table("stream_liveness_markers")

    op.drop_index(
        "idx_stream_token_jti_claims_expires_at",
        table_name="stream_token_jti_claims",
    )
    op.drop_table("stream_token_jti_claims")

