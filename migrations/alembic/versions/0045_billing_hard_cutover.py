"""Add billing account state and Stripe webhook idempotency.

Revision ID: 0045
Revises: 0044
Create Date: 2026-04-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0045"
down_revision: str | None = "0044"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "billing_accounts",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("stripe_customer_id", sa.Text(), nullable=True),
        sa.Column("stripe_subscription_id", sa.Text(), nullable=True),
        sa.Column("stripe_price_id", sa.Text(), nullable=True),
        sa.Column("plan_tier", sa.Text(), nullable=False, server_default="free"),
        sa.Column("subscription_status", sa.Text(), nullable=True),
        sa.Column("current_period_start", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("current_period_end", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("cancel_at_period_end", sa.Boolean(), nullable=False, server_default="false"),
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
            "plan_tier IN ('free', 'plus', 'ai_plus', 'ai_pro')",
            name="ck_billing_accounts_plan_tier",
        ),
        sa.CheckConstraint(
            """
            subscription_status IS NULL OR subscription_status IN (
                'incomplete',
                'incomplete_expired',
                'trialing',
                'active',
                'past_due',
                'canceled',
                'unpaid',
                'paused'
            )
            """,
            name="ck_billing_accounts_subscription_status",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.UniqueConstraint("user_id", name="uq_billing_accounts_user_id"),
        sa.UniqueConstraint("stripe_customer_id", name="uq_billing_accounts_stripe_customer_id"),
        sa.UniqueConstraint(
            "stripe_subscription_id",
            name="uq_billing_accounts_stripe_subscription_id",
        ),
    )

    op.create_table(
        "stripe_webhook_events",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("stripe_event_id", sa.Text(), nullable=False),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column(
            "processed_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint("stripe_event_id", name="uq_stripe_webhook_events_stripe_event_id"),
    )

    op.drop_table("podcast_user_plans")


def downgrade() -> None:
    op.drop_table("stripe_webhook_events")
    op.drop_table("billing_accounts")
    op.create_table(
        "podcast_user_plans",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("plan_tier", sa.Text(), nullable=False),
        sa.Column("daily_transcription_minutes", sa.Integer(), nullable=True),
        sa.Column("initial_episode_window", sa.Integer(), nullable=False),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "plan_tier IN ('free', 'paid')",
            name="ck_podcast_user_plans_plan_tier",
        ),
        sa.CheckConstraint(
            "daily_transcription_minutes IS NULL OR daily_transcription_minutes >= 0",
            name="ck_podcast_user_plans_daily_minutes_non_negative",
        ),
        sa.CheckConstraint(
            "initial_episode_window >= 1",
            name="ck_podcast_user_plans_initial_episode_window_positive",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )
