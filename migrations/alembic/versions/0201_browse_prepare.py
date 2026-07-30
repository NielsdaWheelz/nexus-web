"""Prepare Podcast acquisition storage for the Browse hard cutover.

Revision ID: 0201
Revises: 0200
Create Date: 2026-07-29
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0201"
down_revision: str | Sequence[str] | None = "0200"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "podcast_subscriptions",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_unique_constraint(
        "uq_podcast_subscriptions_id",
        "podcast_subscriptions",
        ["id"],
    )

    op.create_unique_constraint(
        "uq_podcast_episodes_podcast_media",
        "podcast_episodes",
        ["podcast_id", "media_id"],
    )
    op.create_table(
        "podcast_episode_identities",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("podcast_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("scheme", sa.Text(), nullable=False),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column("episode_media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_podcast_episode_identities"),
        sa.UniqueConstraint(
            "podcast_id",
            "scheme",
            "value",
            name="uq_podcast_episode_identities_alias",
        ),
        sa.ForeignKeyConstraint(
            ["podcast_id"],
            ["podcasts.id"],
            name="fk_podcast_episode_identities_podcast",
        ),
        sa.ForeignKeyConstraint(
            ["podcast_id", "episode_media_id"],
            ["podcast_episodes.podcast_id", "podcast_episodes.media_id"],
            name="fk_podcast_episode_identities_episode",
        ),
    )
    op.create_index(
        "ix_podcast_episode_identities_episode_media_id",
        "podcast_episode_identities",
        ["episode_media_id"],
    )

    op.create_table(
        "podcast_subscription_backfills",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("subscription_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("cutoff_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("step_no", sa.BigInteger(), nullable=False),
        sa.Column("cursor", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("processed_count", sa.BigInteger(), nullable=False),
        sa.Column("added_count", sa.BigInteger(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("source_limited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column("error_detail", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_podcast_subscription_backfills"),
        sa.UniqueConstraint(
            "subscription_id",
            name="uq_podcast_subscription_backfills_subscription",
        ),
        sa.ForeignKeyConstraint(
            ["subscription_id"],
            ["podcast_subscriptions.id"],
            name="fk_podcast_subscription_backfills_subscription",
        ),
    )

    op.add_column(
        "media_transcript_states",
        sa.Column("transcript_origin", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    raise RuntimeError("Hard cutover: 0201 is not reversible")
