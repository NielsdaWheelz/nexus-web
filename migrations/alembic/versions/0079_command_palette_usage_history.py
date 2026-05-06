"""Command palette usage history.

Revision ID: 0079
Revises: 0078
Create Date: 2026-05-06
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0079"
down_revision: str | None = "0078"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "command_palette_usages",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("query_normalized", sa.Text(), nullable=False),
        sa.Column("target_key", sa.Text(), nullable=False),
        sa.Column("target_kind", sa.Text(), nullable=False),
        sa.Column("target_href", sa.Text(), nullable=True),
        sa.Column("title_snapshot", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("use_count", sa.Integer(), nullable=False, server_default=sa.text("1")),
        sa.Column("visit_timestamps", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "last_used_at",
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
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint(
            "user_id",
            "query_normalized",
            "target_key",
            name="uq_command_palette_usages_user_query_target",
        ),
        sa.CheckConstraint("use_count >= 1", name="ck_command_palette_usages_use_count"),
        sa.CheckConstraint(
            "target_kind IN ('href', 'action', 'prefill')",
            name="ck_command_palette_usages_target_kind",
        ),
        sa.CheckConstraint(
            "source IN ('static', 'workspace', 'recent', 'oracle', 'search', 'ai')",
            name="ck_command_palette_usages_source",
        ),
        sa.CheckConstraint(
            "(target_kind = 'href' AND target_href IS NOT NULL) OR "
            "(target_kind <> 'href' AND target_href IS NULL)",
            name="ck_command_palette_usages_target_href",
        ),
    )
    op.execute(
        """
        CREATE INDEX ix_command_palette_usages_user_last_used_at_id
        ON command_palette_usages (user_id, last_used_at DESC, id DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX ix_command_palette_usages_user_query_last_used_at
        ON command_palette_usages (user_id, query_normalized, last_used_at DESC)
        """
    )

    op.execute(
        """
        INSERT INTO command_palette_usages (
            user_id,
            query_normalized,
            target_key,
            target_kind,
            target_href,
            title_snapshot,
            source,
            use_count,
            visit_timestamps,
            last_used_at,
            created_at,
            updated_at
        )
        SELECT
            user_id,
            '',
            href,
            'href',
            href,
            COALESCE(NULLIF(title_snapshot, ''), href),
            'recent',
            1,
            jsonb_build_array(last_used_at::text),
            last_used_at,
            created_at,
            last_used_at
        FROM command_palette_recents
        """
    )

    op.drop_index(
        "ix_command_palette_recents_user_last_used_at_id",
        table_name="command_palette_recents",
    )
    op.drop_table("command_palette_recents")


def downgrade() -> None:
    op.create_table(
        "command_palette_recents",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("href", sa.Text(), nullable=False),
        sa.Column("title_snapshot", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "last_used_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("user_id", "href", name="uq_command_palette_recents_user_href"),
    )
    op.execute(
        """
        CREATE INDEX ix_command_palette_recents_user_last_used_at_id
        ON command_palette_recents (user_id, last_used_at DESC, id DESC)
        """
    )
    op.execute(
        """
        INSERT INTO command_palette_recents (
            user_id,
            href,
            title_snapshot,
            created_at,
            last_used_at
        )
        SELECT DISTINCT ON (user_id, target_href)
            user_id,
            target_href,
            title_snapshot,
            created_at,
            last_used_at
        FROM command_palette_usages
        WHERE target_href IS NOT NULL
        ORDER BY user_id, target_href, last_used_at DESC, id DESC
        """
    )

    op.drop_index(
        "ix_command_palette_usages_user_query_last_used_at",
        table_name="command_palette_usages",
    )
    op.drop_index(
        "ix_command_palette_usages_user_last_used_at_id",
        table_name="command_palette_usages",
    )
    op.drop_table("command_palette_usages")
