"""Slice 1 schema - ingestion framework, storage, and processing lifecycle

Revision ID: 0002
Revises: 0001
Create Date: 2026-01-21

This migration adds S1 fields to the media table and creates the media_file table
for storage metadata. It also converts processing_status from text with CHECK
constraint to a proper PostgreSQL enum type.

Key changes:
- Convert processing_status to enum type
- Add failure_stage enum and column
- Add processing lifecycle timestamps and counters
- Add URL/file identity fields
- Add provider fields for future S7/S8
- Add created_by_user_id with system user backfill
- Create media_file table
- Create partial unique indexes for idempotency
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# System user UUID for backfilling created_by_user_id on existing media
# This is a well-known UUID that represents "system" operations
SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000"


def upgrade() -> None:
    # ==========================================================================
    # Step 1: Create enum types using guarded DO blocks
    # ==========================================================================

    # Processing status enum (will replace text column)
    op.execute("""
        DO $$
        BEGIN
            CREATE TYPE processing_status_enum AS ENUM (
                'pending', 'extracting', 'ready_for_reading', 'embedding', 'ready', 'failed'
            );
        EXCEPTION
            WHEN duplicate_object THEN NULL;
        END $$;
    """)

    # Failure stage enum
    op.execute("""
        DO $$
        BEGIN
            CREATE TYPE failure_stage_enum AS ENUM (
                'upload', 'extract', 'transcribe', 'embed', 'other'
            );
        EXCEPTION
            WHEN duplicate_object THEN NULL;
        END $$;
    """)

    # ==========================================================================
    # Step 2: Create system user for backfilling
    # ==========================================================================
    op.execute(f"""
        INSERT INTO users (id, created_at)
        VALUES ('{SYSTEM_USER_ID}'::uuid, now())
        ON CONFLICT (id) DO NOTHING
    """)

    # ==========================================================================
    # Step 3: Migrate processing_status from text to enum
    # ==========================================================================

    # 3a. Add new enum column
    op.add_column(
        "media",
        sa.Column(
            "processing_status_new",
            sa.Enum(
                "pending",
                "extracting",
                "ready_for_reading",
                "embedding",
                "ready",
                "failed",
                name="processing_status_enum",
                create_type=False,
            ),
            nullable=True,
        ),
    )

    # 3b. Migrate data from text to enum
    op.execute(
        "UPDATE media SET processing_status_new = processing_status::processing_status_enum"
    )

    # 3c. Drop old CHECK constraint and column
    op.drop_constraint("ck_media_processing_status", "media", type_="check")
    op.drop_column("media", "processing_status")

    # 3d. Rename new column
    op.alter_column("media", "processing_status_new", new_column_name="processing_status")

    # 3e. Set NOT NULL and default
    op.alter_column(
        "media",
        "processing_status",
        nullable=False,
        server_default="pending",
    )

    # ==========================================================================
    # Step 4: Add S1 columns to media table
    # ==========================================================================

    # Failure tracking
    op.add_column(
        "media",
        sa.Column(
            "failure_stage",
            sa.Enum(
                "upload",
                "extract",
                "transcribe",
                "embed",
                "other",
                name="failure_stage_enum",
                create_type=False,
            ),
            nullable=True,
        ),
    )
    op.add_column(
        "media",
        sa.Column("last_error_code", sa.Text(), nullable=True),
    )
    op.add_column(
        "media",
        sa.Column("last_error_message", sa.Text(), nullable=True),
    )

    # Processing lifecycle
    op.add_column(
        "media",
        sa.Column(
            "processing_attempts",
            sa.Integer(),
            server_default="0",
            nullable=False,
        ),
    )
    op.add_column(
        "media",
        sa.Column(
            "processing_started_at",
            sa.TIMESTAMP(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        "media",
        sa.Column(
            "processing_completed_at",
            sa.TIMESTAMP(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        "media",
        sa.Column(
            "failed_at",
            sa.TIMESTAMP(timezone=True),
            nullable=True,
        ),
    )

    # URL/file identity
    op.add_column(
        "media",
        sa.Column("requested_url", sa.Text(), nullable=True),
    )
    op.add_column(
        "media",
        sa.Column("canonical_url", sa.Text(), nullable=True),
    )
    op.add_column(
        "media",
        sa.Column("file_sha256", sa.Text(), nullable=True),
    )
    op.add_column(
        "media",
        sa.Column("external_playback_url", sa.Text(), nullable=True),
    )

    # Provider fields (for future S7/S8)
    op.add_column(
        "media",
        sa.Column("provider", sa.Text(), nullable=True),
    )
    op.add_column(
        "media",
        sa.Column("provider_id", sa.Text(), nullable=True),
    )

    # Creator tracking - add column
    op.add_column(
        "media",
        sa.Column(
            "created_by_user_id",
            sa.UUID(),
            nullable=True,
        ),
    )

    # Backfill existing media with system user
    op.execute(f"""
        UPDATE media SET created_by_user_id = '{SYSTEM_USER_ID}'::uuid
        WHERE created_by_user_id IS NULL
    """)

    # Now make it NOT NULL and add FK constraint
    op.alter_column("media", "created_by_user_id", nullable=False)
    op.create_foreign_key(
        "fk_media_created_by_user_id",
        "media",
        "users",
        ["created_by_user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    # Actually we need to allow NULL for SET NULL to work on delete
    op.alter_column("media", "created_by_user_id", nullable=True)

    # ==========================================================================
    # Step 5: Add URL length CHECK constraints
    # ==========================================================================
    op.create_check_constraint(
        "ck_media_requested_url_length",
        "media",
        "requested_url IS NULL OR char_length(requested_url) <= 2048",
    )
    op.create_check_constraint(
        "ck_media_canonical_url_length",
        "media",
        "canonical_url IS NULL OR char_length(canonical_url) <= 2048",
    )

    # ==========================================================================
    # Step 6: Create media_file table
    # ==========================================================================
    op.create_table(
        "media_file",
        sa.Column(
            "media_id",
            sa.UUID(),
            sa.ForeignKey("media.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("storage_path", sa.Text(), nullable=False),
        sa.Column("content_type", sa.Text(), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
    )

    # ==========================================================================
    # Step 7: Create partial unique indexes for idempotency
    # ==========================================================================

    # URL-based idempotency: (kind, canonical_url) must be unique when canonical_url is set
    op.create_index(
        "uix_media_canonical_url",
        "media",
        ["kind", "canonical_url"],
        unique=True,
        postgresql_where=sa.text("canonical_url IS NOT NULL"),
    )

    # File-based idempotency: (user, kind, sha256) must be unique for pdf/epub uploads
    op.create_index(
        "uix_media_file_sha256",
        "media",
        ["created_by_user_id", "kind", "file_sha256"],
        unique=True,
        postgresql_where=sa.text("file_sha256 IS NOT NULL AND kind IN ('pdf', 'epub')"),
    )


def downgrade() -> None:
    # ==========================================================================
    # Step 1: Delete system user (must happen before dropping created_by_user_id)
    # Only deletes if system user has no associated data
    # ==========================================================================
    op.execute(f"""
        DELETE FROM users WHERE id = '{SYSTEM_USER_ID}'::uuid
        AND NOT EXISTS (SELECT 1 FROM libraries WHERE owner_user_id = '{SYSTEM_USER_ID}'::uuid)
        AND NOT EXISTS (SELECT 1 FROM media WHERE created_by_user_id = '{SYSTEM_USER_ID}'::uuid)
    """)

    # ==========================================================================
    # Step 2: Drop partial unique indexes
    # ==========================================================================
    op.drop_index("uix_media_file_sha256", table_name="media")
    op.drop_index("uix_media_canonical_url", table_name="media")

    # ==========================================================================
    # Step 3: Drop media_file table
    # ==========================================================================
    op.drop_table("media_file")

    # ==========================================================================
    # Step 4: Drop URL length constraints
    # ==========================================================================
    op.drop_constraint("ck_media_canonical_url_length", "media", type_="check")
    op.drop_constraint("ck_media_requested_url_length", "media", type_="check")

    # ==========================================================================
    # Step 5: Drop S1 columns from media table
    # ==========================================================================
    op.drop_constraint("fk_media_created_by_user_id", "media", type_="foreignkey")
    op.drop_column("media", "created_by_user_id")
    op.drop_column("media", "provider_id")
    op.drop_column("media", "provider")
    op.drop_column("media", "external_playback_url")
    op.drop_column("media", "file_sha256")
    op.drop_column("media", "canonical_url")
    op.drop_column("media", "requested_url")
    op.drop_column("media", "failed_at")
    op.drop_column("media", "processing_completed_at")
    op.drop_column("media", "processing_started_at")
    op.drop_column("media", "processing_attempts")
    op.drop_column("media", "last_error_message")
    op.drop_column("media", "last_error_code")
    op.drop_column("media", "failure_stage")

    # ==========================================================================
    # Step 5: Migrate processing_status back to text
    # ==========================================================================

    # 5a. Add text column
    op.add_column(
        "media",
        sa.Column("processing_status_text", sa.Text(), nullable=True),
    )

    # 5b. Migrate data
    op.execute("UPDATE media SET processing_status_text = processing_status::text")

    # 5c. Drop enum column
    op.drop_column("media", "processing_status")

    # 5d. Rename text column
    op.alter_column("media", "processing_status_text", new_column_name="processing_status")

    # 5e. Set NOT NULL, default, and add CHECK constraint
    op.alter_column(
        "media",
        "processing_status",
        nullable=False,
        server_default="pending",
    )
    op.create_check_constraint(
        "ck_media_processing_status",
        "media",
        "processing_status IN ('pending', 'extracting', 'ready_for_reading', "
        "'embedding', 'ready', 'failed')",
    )

    # ==========================================================================
    # Step 8: Drop enum types
    # ==========================================================================
    op.execute("DROP TYPE IF EXISTS failure_stage_enum")
    op.execute("DROP TYPE IF EXISTS processing_status_enum")
