"""Cut over libraries to mixed library entries and remove podcast categories.

Revision ID: 0047
Revises: 0046
Create Date: 2026-04-17
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0047"
down_revision: str | None = "0046"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("libraries", sa.Column("color", sa.Text(), nullable=True))

    op.create_table(
        "library_entries",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("library_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("podcast_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("position", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.CheckConstraint(
            "(media_id IS NOT NULL AND podcast_id IS NULL) "
            "OR (media_id IS NULL AND podcast_id IS NOT NULL)",
            name="ck_library_entries_exactly_one_target",
        ),
        sa.CheckConstraint(
            "position >= 0",
            name="ck_library_entries_position_non_negative",
        ),
        sa.ForeignKeyConstraint(["library_id"], ["libraries.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["podcast_id"], ["podcasts.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("library_id", "media_id", name="uq_library_entries_library_media"),
        sa.UniqueConstraint("library_id", "podcast_id", name="uq_library_entries_library_podcast"),
    )
    op.create_index(
        "idx_library_entries_media_library",
        "library_entries",
        ["media_id", "library_id"],
    )
    op.create_index(
        "idx_library_entries_podcast_library",
        "library_entries",
        ["podcast_id", "library_id"],
    )
    op.create_index(
        "ix_library_entries_library_position",
        "library_entries",
        ["library_id", "position"],
    )

    op.execute(
        """
        INSERT INTO library_entries (id, library_id, media_id, podcast_id, created_at, position)
        SELECT
            gen_random_uuid(),
            lm.library_id,
            lm.media_id,
            NULL,
            lm.created_at,
            lm.position
        FROM library_media lm
        """
    )

    op.execute(
        """
        CREATE TEMP TABLE podcast_category_library_cutover_map (
            category_id uuid PRIMARY KEY,
            library_id uuid NOT NULL
        ) ON COMMIT DROP
        """
    )
    op.execute(
        """
        INSERT INTO podcast_category_library_cutover_map (category_id, library_id)
        SELECT id, gen_random_uuid()
        FROM podcast_subscription_categories
        """
    )
    op.execute(
        """
        INSERT INTO libraries (id, owner_user_id, name, color, is_default, created_at, updated_at)
        SELECT
            map.library_id,
            c.user_id,
            c.name,
            c.color,
            false,
            c.created_at,
            c.created_at
        FROM podcast_subscription_categories c
        JOIN podcast_category_library_cutover_map map ON map.category_id = c.id
        """
    )
    op.execute(
        """
        INSERT INTO memberships (library_id, user_id, role, created_at)
        SELECT
            map.library_id,
            c.user_id,
            'admin',
            c.created_at
        FROM podcast_subscription_categories c
        JOIN podcast_category_library_cutover_map map ON map.category_id = c.id
        """
    )
    op.execute(
        """
        WITH ordered AS (
            SELECT
                map.library_id,
                ps.podcast_id,
                ps.created_at,
                ROW_NUMBER() OVER (
                    PARTITION BY map.library_id
                    ORDER BY ps.created_at ASC, ps.podcast_id ASC
                ) - 1 AS position
            FROM podcast_subscriptions ps
            JOIN podcast_category_library_cutover_map map ON map.category_id = ps.category_id
            WHERE ps.status = 'active'
        )
        INSERT INTO library_entries (id, library_id, media_id, podcast_id, created_at, position)
        SELECT
            gen_random_uuid(),
            ordered.library_id,
            NULL,
            ordered.podcast_id,
            ordered.created_at,
            ordered.position
        FROM ordered
        """
    )

    op.drop_index("ix_podcast_subscriptions_user_category", table_name="podcast_subscriptions")
    op.drop_constraint(
        "fk_podcast_subscriptions_category_id",
        "podcast_subscriptions",
        type_="foreignkey",
    )
    op.drop_column("podcast_subscriptions", "category_id")
    op.drop_constraint(
        "ck_podcast_subscriptions_unsubscribe_mode_valid",
        "podcast_subscriptions",
        type_="check",
    )
    op.drop_column("podcast_subscriptions", "unsubscribe_mode")
    op.drop_index(
        "ix_podcast_subscription_categories_user_position",
        table_name="podcast_subscription_categories",
    )
    op.drop_table("podcast_subscription_categories")
    op.drop_table("library_media")


def downgrade() -> None:
    op.create_table(
        "library_media",
        sa.Column("library_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("position", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.CheckConstraint(
            "position >= 0",
            name="ck_library_media_position_non_negative",
        ),
        sa.ForeignKeyConstraint(["library_id"], ["libraries.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("library_id", "media_id"),
    )
    op.create_index(
        "idx_library_media_media_library",
        "library_media",
        ["media_id", "library_id"],
    )
    op.create_index(
        "ix_library_media_library_position",
        "library_media",
        ["library_id", "position"],
    )
    op.execute(
        """
        INSERT INTO library_media (library_id, media_id, created_at, position)
        SELECT
            library_id,
            media_id,
            created_at,
            position
        FROM library_entries
        WHERE media_id IS NOT NULL
        """
    )

    op.create_table(
        "podcast_subscription_categories",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("color", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint(
            "user_id",
            "name",
            name="uq_podcast_subscription_categories_user_name",
        ),
    )
    op.create_index(
        "ix_podcast_subscription_categories_user_position",
        "podcast_subscription_categories",
        ["user_id", "position"],
    )
    op.add_column(
        "podcast_subscriptions",
        sa.Column("category_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "podcast_subscriptions",
        sa.Column("unsubscribe_mode", sa.Integer(), nullable=False, server_default="1"),
    )
    op.create_check_constraint(
        "ck_podcast_subscriptions_unsubscribe_mode_valid",
        "podcast_subscriptions",
        "unsubscribe_mode IN (1, 2, 3)",
    )
    op.create_foreign_key(
        "fk_podcast_subscriptions_category_id",
        "podcast_subscriptions",
        "podcast_subscription_categories",
        ["category_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_podcast_subscriptions_user_category",
        "podcast_subscriptions",
        ["user_id", "category_id"],
    )

    op.drop_index("ix_library_entries_library_position", table_name="library_entries")
    op.drop_index("idx_library_entries_podcast_library", table_name="library_entries")
    op.drop_index("idx_library_entries_media_library", table_name="library_entries")
    op.drop_table("library_entries")
    op.drop_column("libraries", "color")
