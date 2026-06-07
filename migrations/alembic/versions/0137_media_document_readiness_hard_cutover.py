"""media document readiness hard cutover

Revision ID: 0137
Revises: 0136
Create Date: 2026-06-05

media.processing_status now owns only source/document extraction readiness.
Search and embedding readiness live in media_content_index_states.
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0137"
down_revision: str | Sequence[str] | None = "0136"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE media
        SET processing_status = 'ready_for_reading'::processing_status_enum
        WHERE processing_status::text IN ('embedding', 'ready')
        """
    )
    op.execute("DROP INDEX IF EXISTS idx_media_stale_extracting_recovery")
    op.execute("DROP INDEX IF EXISTS idx_media_stale_pending_upload_cleanup")
    op.execute("ALTER TABLE media ALTER COLUMN processing_status DROP DEFAULT")
    op.execute("ALTER TYPE processing_status_enum RENAME TO processing_status_enum_old")
    op.execute(
        """
        CREATE TYPE processing_status_enum AS ENUM (
            'pending',
            'extracting',
            'ready_for_reading',
            'failed'
        )
        """
    )
    op.execute(
        """
        ALTER TABLE media
        ALTER COLUMN processing_status TYPE processing_status_enum
        USING processing_status::text::processing_status_enum
        """
    )
    op.execute(
        """
        ALTER TABLE media
        ALTER COLUMN processing_status SET DEFAULT 'pending'::processing_status_enum
        """
    )
    op.execute(
        """
        CREATE INDEX idx_media_stale_extracting_recovery
        ON media (processing_started_at, id)
        WHERE processing_status = 'extracting'
          AND kind IN ('web_article', 'pdf', 'epub', 'podcast_episode')
          AND processing_started_at IS NOT NULL
        """
    )
    op.execute(
        """
        CREATE INDEX idx_media_stale_pending_upload_cleanup
        ON media (created_at, processing_started_at, id)
        WHERE processing_status = 'pending'
          AND kind IN ('pdf', 'epub')
          AND file_sha256 IS NULL
        """
    )
    op.execute("DROP TYPE processing_status_enum_old")


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0137 is not reversible")
