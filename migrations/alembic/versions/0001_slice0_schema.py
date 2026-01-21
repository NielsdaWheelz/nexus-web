"""Slice 0 schema - users, libraries, memberships, media, fragments, library_media

Revision ID: 0001
Revises:
Create Date: 2026-01-21

This migration creates the foundational schema for Nexus Slice 0.
All tables conform to the s0_spec.md and constitution.md specifications.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Enable pgcrypto extension for gen_random_uuid()
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")

    # ==========================================================================
    # users table
    # ==========================================================================
    op.create_table(
        "users",
        sa.Column(
            "id",
            sa.UUID(),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    # ==========================================================================
    # libraries table
    # ==========================================================================
    op.create_table(
        "libraries",
        sa.Column(
            "id",
            sa.UUID(),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("owner_user_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("is_default", sa.Boolean(), server_default="false", nullable=False),
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
        sa.ForeignKeyConstraint(
            ["owner_user_id"],
            ["users.id"],
            ondelete="CASCADE",
        ),
        # Constraint: name must be 1-100 characters
        sa.CheckConstraint(
            "char_length(name) BETWEEN 1 AND 100",
            name="ck_libraries_name_length",
        ),
    )

    # Partial unique index: enforce exactly one default library per user
    op.create_index(
        "uix_libraries_one_default_per_user",
        "libraries",
        ["owner_user_id"],
        unique=True,
        postgresql_where=sa.text("is_default = true"),
    )

    # ==========================================================================
    # memberships table
    # ==========================================================================
    op.create_table(
        "memberships",
        sa.Column("library_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("library_id", "user_id"),
        sa.ForeignKeyConstraint(
            ["library_id"],
            ["libraries.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            ondelete="CASCADE",
        ),
        # Constraint: role must be 'admin' or 'member'
        sa.CheckConstraint(
            "role IN ('admin', 'member')",
            name="ck_memberships_role",
        ),
    )

    # ==========================================================================
    # media table
    # ==========================================================================
    op.create_table(
        "media",
        sa.Column(
            "id",
            sa.UUID(),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("canonical_source_url", sa.Text(), nullable=True),
        sa.Column("processing_status", sa.Text(), server_default="pending", nullable=False),
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
        # Constraint: kind must be one of the allowed values
        sa.CheckConstraint(
            "kind IN ('web_article', 'epub', 'pdf', 'video', 'podcast_episode')",
            name="ck_media_kind",
        ),
        # Constraint: processing_status must be one of the allowed values
        sa.CheckConstraint(
            "processing_status IN ('pending', 'extracting', 'ready_for_reading', "
            "'embedding', 'ready', 'failed')",
            name="ck_media_processing_status",
        ),
    )

    # ==========================================================================
    # fragments table
    # ==========================================================================
    op.create_table(
        "fragments",
        sa.Column(
            "id",
            sa.UUID(),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("media_id", sa.UUID(), nullable=False),
        sa.Column("idx", sa.Integer(), nullable=False),
        sa.Column("canonical_text", sa.Text(), nullable=False),
        sa.Column("html_sanitized", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["media_id"],
            ["media.id"],
            ondelete="CASCADE",
        ),
        # Unique constraint: (media_id, idx)
        sa.UniqueConstraint("media_id", "idx", name="uq_fragments_media_idx"),
    )

    # ==========================================================================
    # library_media table
    # ==========================================================================
    op.create_table(
        "library_media",
        sa.Column("library_id", sa.UUID(), nullable=False),
        sa.Column("media_id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("library_id", "media_id"),
        sa.ForeignKeyConstraint(
            ["library_id"],
            ["libraries.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["media_id"],
            ["media.id"],
            ondelete="CASCADE",
        ),
    )


def downgrade() -> None:
    # Drop tables in reverse order (respecting foreign key dependencies)
    op.drop_table("library_media")
    op.drop_table("fragments")
    op.drop_table("media")
    op.drop_table("memberships")
    op.drop_index("uix_libraries_one_default_per_user", table_name="libraries")
    op.drop_table("libraries")
    op.drop_table("users")

    # Note: We don't drop pgcrypto extension as it may be used by other things
