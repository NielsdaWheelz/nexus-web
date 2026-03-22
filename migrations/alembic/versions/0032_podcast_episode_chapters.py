"""Add podcast episode chapter persistence table.

Revision ID: 0032
Revises: 0031
Create Date: 2026-03-22
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0032"
down_revision: str | None = "0031"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "podcast_episode_chapters",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "media_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("media.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("chapter_idx", sa.Integer(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("t_start_ms", sa.Integer(), nullable=False),
        sa.Column("t_end_ms", sa.Integer(), nullable=True),
        sa.Column("url", sa.Text(), nullable=True),
        sa.Column("image_url", sa.Text(), nullable=True),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "media_id",
            "chapter_idx",
            name="uq_podcast_episode_chapters_media_idx",
        ),
        sa.CheckConstraint(
            "chapter_idx >= 0",
            name="ck_podcast_episode_chapters_idx_non_negative",
        ),
        sa.CheckConstraint(
            "t_start_ms >= 0",
            name="ck_podcast_episode_chapters_start_non_negative",
        ),
        sa.CheckConstraint(
            "t_end_ms IS NULL OR t_end_ms >= t_start_ms",
            name="ck_podcast_episode_chapters_end_not_before_start",
        ),
        sa.CheckConstraint(
            "source IN ('rss_podcasting20', 'rss_podlove', 'embedded_mp4', 'embedded_id3')",
            name="ck_podcast_episode_chapters_source",
        ),
    )
    op.create_index(
        "ix_podcast_episode_chapters_media_t_start_ms",
        "podcast_episode_chapters",
        ["media_id", "t_start_ms"],
    )


def downgrade() -> None:
    op.drop_index("ix_podcast_episode_chapters_media_t_start_ms", table_name="podcast_episode_chapters")
    op.drop_table("podcast_episode_chapters")
