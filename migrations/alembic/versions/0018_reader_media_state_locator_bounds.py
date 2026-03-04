"""Add bounds checks for reader media locator fields.

Revision ID: 0018
Revises: 0017
Create Date: 2026-03-04
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'ck_reader_media_state_offset'
            ) THEN
                ALTER TABLE reader_media_state
                ADD CONSTRAINT ck_reader_media_state_offset
                CHECK ("offset" IS NULL OR "offset" >= 0);
            END IF;
        END
        $$;
        """
    )
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'ck_reader_media_state_page'
            ) THEN
                ALTER TABLE reader_media_state
                ADD CONSTRAINT ck_reader_media_state_page
                CHECK (page IS NULL OR page >= 1);
            END IF;
        END
        $$;
        """
    )
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'ck_reader_media_state_zoom'
            ) THEN
                ALTER TABLE reader_media_state
                ADD CONSTRAINT ck_reader_media_state_zoom
                CHECK (zoom IS NULL OR (zoom BETWEEN 0.25 AND 4.0));
            END IF;
        END
        $$;
        """
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE reader_media_state DROP CONSTRAINT IF EXISTS ck_reader_media_state_zoom"
    )
    op.execute(
        "ALTER TABLE reader_media_state DROP CONSTRAINT IF EXISTS ck_reader_media_state_page"
    )
    op.execute(
        "ALTER TABLE reader_media_state DROP CONSTRAINT IF EXISTS ck_reader_media_state_offset"
    )
