"""Add internal billing entitlement overrides.

Revision ID: 0110
Revises: 0109
Create Date: 2026-05-25
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0110"
down_revision: str | None = "0109"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "billing_entitlement_overrides",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("plan_tier", sa.Text(), nullable=False),
        sa.Column(
            "platform_token_quota_mode",
            sa.Text(),
            nullable=False,
            server_default="plan",
        ),
        sa.Column("platform_token_limit_monthly", sa.Integer(), nullable=True),
        sa.Column(
            "transcription_quota_mode",
            sa.Text(),
            nullable=False,
            server_default="plan",
        ),
        sa.Column("transcription_minutes_limit_monthly", sa.Integer(), nullable=True),
        sa.Column("expires_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("updated_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_by_label", sa.Text(), nullable=True),
        sa.Column("updated_by_label", sa.Text(), nullable=True),
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
            "plan_tier IN ('plus', 'ai_plus', 'ai_pro')",
            name="ck_billing_entitlement_overrides_plan_tier",
        ),
        sa.CheckConstraint(
            "platform_token_quota_mode IN ('plan', 'custom', 'unlimited')",
            name="ck_billing_entitlement_overrides_platform_token_quota_mode",
        ),
        sa.CheckConstraint(
            """
            (
                platform_token_quota_mode = 'custom'
                AND platform_token_limit_monthly IS NOT NULL
                AND platform_token_limit_monthly >= 0
            )
            OR (
                platform_token_quota_mode <> 'custom'
                AND platform_token_limit_monthly IS NULL
            )
            """,
            name="ck_billing_entitlement_overrides_platform_token_limit",
        ),
        sa.CheckConstraint(
            "transcription_quota_mode IN ('plan', 'custom', 'unlimited')",
            name="ck_billing_entitlement_overrides_transcription_quota_mode",
        ),
        sa.CheckConstraint(
            """
            (
                transcription_quota_mode = 'custom'
                AND transcription_minutes_limit_monthly IS NOT NULL
                AND transcription_minutes_limit_monthly >= 0
            )
            OR (
                transcription_quota_mode <> 'custom'
                AND transcription_minutes_limit_monthly IS NULL
            )
            """,
            name="ck_billing_entitlement_overrides_transcription_limit",
        ),
        sa.CheckConstraint(
            "char_length(btrim(reason)) > 0",
            name="ck_billing_entitlement_overrides_reason_present",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["updated_by_user_id"], ["users.id"]),
        sa.UniqueConstraint("user_id", name="uq_billing_entitlement_overrides_user_id"),
    )

    op.create_table(
        "billing_entitlement_override_events",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("override_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("actor_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("actor_label", sa.Text(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("before_state", postgresql.JSONB(), nullable=True),
        sa.Column("after_state", postgresql.JSONB(), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "event_type IN ('created', 'updated', 'revoked')",
            name="ck_billing_entitlement_override_events_event_type",
        ),
        sa.CheckConstraint(
            "char_length(btrim(reason)) > 0",
            name="ck_billing_entitlement_override_events_reason_present",
        ),
        sa.ForeignKeyConstraint(["override_id"], ["billing_entitlement_overrides.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["actor_user_id"], ["users.id"]),
    )


def downgrade() -> None:
    op.drop_table("billing_entitlement_override_events")
    op.drop_table("billing_entitlement_overrides")
