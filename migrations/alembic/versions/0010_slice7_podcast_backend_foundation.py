"""Slice 7 PR-01 — podcast backend foundation

Revision ID: 0010
Revises: 0009
Create Date: 2026-03-02

Adds podcast discovery/subscription persistence, quota ledger + plan overrides,
global episode identity mappings, transcription-work tracking, and transcript
segment timing metadata on fragments.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # Fragment transcript timing metadata
    # ------------------------------------------------------------------
    op.add_column("fragments", sa.Column("t_start_ms", sa.BigInteger(), nullable=True))
    op.add_column("fragments", sa.Column("t_end_ms", sa.BigInteger(), nullable=True))
    op.add_column("fragments", sa.Column("speaker_label", sa.Text(), nullable=True))
    op.create_check_constraint(
        "ck_fragments_time_offsets_paired_null",
        "fragments",
        "(t_start_ms IS NULL AND t_end_ms IS NULL) "
        "OR (t_start_ms IS NOT NULL AND t_end_ms IS NOT NULL)",
    )
    op.create_check_constraint(
        "ck_fragments_time_offsets_valid",
        "fragments",
        "(t_start_ms IS NULL OR t_start_ms >= 0) "
        "AND (t_end_ms IS NULL OR t_end_ms >= 0) "
        "AND (t_start_ms IS NULL OR t_end_ms >= t_start_ms)",
    )
    op.create_index(
        "ix_fragments_media_t_start_idx",
        "fragments",
        ["media_id", "t_start_ms", "idx"],
    )

    # ------------------------------------------------------------------
    # Podcasts: global discovery metadata
    # ------------------------------------------------------------------
    op.create_table(
        "podcasts",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("provider_podcast_id", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("author", sa.Text(), nullable=True),
        sa.Column("feed_url", sa.Text(), nullable=False),
        sa.Column("website_url", sa.Text(), nullable=True),
        sa.Column("image_url", sa.Text(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
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
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "provider",
            "provider_podcast_id",
            name="uq_podcasts_provider_provider_podcast_id",
        ),
        sa.UniqueConstraint("feed_url", name="uq_podcasts_feed_url"),
    )

    op.create_table(
        "podcast_subscriptions",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("podcast_id", sa.UUID(), nullable=False),
        sa.Column("status", sa.Text(), server_default="active", nullable=False),
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
        sa.CheckConstraint(
            "status IN ('active', 'unsubscribed')",
            name="ck_podcast_subscriptions_status",
        ),
        sa.ForeignKeyConstraint(["podcast_id"], ["podcasts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "podcast_id"),
    )

    op.create_table(
        "podcast_episodes",
        sa.Column("media_id", sa.UUID(), nullable=False),
        sa.Column("podcast_id", sa.UUID(), nullable=False),
        sa.Column("provider_episode_id", sa.Text(), nullable=False),
        sa.Column("guid", sa.Text(), nullable=True),
        sa.Column("fallback_identity", sa.Text(), nullable=False),
        sa.Column("published_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("duration_seconds", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "duration_seconds IS NULL OR duration_seconds > 0",
            name="ck_podcast_episodes_duration_positive",
        ),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["podcast_id"], ["podcasts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("media_id"),
        sa.UniqueConstraint(
            "podcast_id",
            "provider_episode_id",
            name="uq_podcast_episodes_podcast_provider_episode_id",
        ),
        sa.UniqueConstraint(
            "podcast_id",
            "fallback_identity",
            name="uq_podcast_episodes_podcast_fallback_identity",
        ),
    )
    op.create_index(
        "uq_podcast_episodes_podcast_guid_not_null",
        "podcast_episodes",
        ["podcast_id", "guid"],
        unique=True,
        postgresql_where=sa.text("guid IS NOT NULL"),
    )

    op.create_table(
        "podcast_transcription_jobs",
        sa.Column("media_id", sa.UUID(), nullable=False),
        sa.Column("requested_by_user_id", sa.UUID(), nullable=True),
        sa.Column("status", sa.Text(), server_default="pending", nullable=False),
        sa.Column("error_code", sa.Text(), nullable=True),
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
        sa.CheckConstraint(
            "status IN ('pending', 'completed', 'failed')",
            name="ck_podcast_transcription_jobs_status",
        ),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["requested_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("media_id"),
    )

    op.create_table(
        "podcast_user_plans",
        sa.Column("user_id", sa.UUID(), nullable=False),
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

    op.create_table(
        "podcast_transcription_usage_daily",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("usage_date", sa.Date(), nullable=False),
        sa.Column("minutes_used", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "minutes_used >= 0",
            name="ck_podcast_transcription_usage_daily_minutes_non_negative",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "usage_date"),
    )


def downgrade() -> None:
    op.drop_table("podcast_transcription_usage_daily")
    op.drop_table("podcast_user_plans")
    op.drop_table("podcast_transcription_jobs")
    op.drop_index("uq_podcast_episodes_podcast_guid_not_null", table_name="podcast_episodes")
    op.drop_table("podcast_episodes")
    op.drop_table("podcast_subscriptions")
    op.drop_table("podcasts")

    op.drop_index("ix_fragments_media_t_start_idx", table_name="fragments")
    op.drop_constraint("ck_fragments_time_offsets_valid", "fragments", type_="check")
    op.drop_constraint("ck_fragments_time_offsets_paired_null", "fragments", type_="check")
    op.drop_column("fragments", "speaker_label")
    op.drop_column("fragments", "t_end_ms")
    op.drop_column("fragments", "t_start_ms")
