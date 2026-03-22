"""Add pgvector ANN column for transcript semantic retrieval.

Revision ID: 0027
Revises: 0026
Create Date: 2026-03-13
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0027"
down_revision: str | None = "0026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.execute(
        """
        ALTER TABLE podcast_transcript_chunks
        ADD COLUMN IF NOT EXISTS embedding_vector vector(256)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_podcast_transcript_chunks_embedding_model
        ON podcast_transcript_chunks (embedding_model)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_podcast_transcript_chunks_embedding_vector_ann
        ON podcast_transcript_chunks
        USING ivfflat (embedding_vector vector_cosine_ops)
        WITH (lists = 100)
        """
    )
    op.execute(
        """
        UPDATE media_transcript_states mts
        SET semantic_status = 'pending',
            updated_at = now()
        WHERE mts.active_transcript_version_id IS NOT NULL
          AND mts.semantic_status = 'ready'
          AND EXISTS (
              SELECT 1
              FROM podcast_transcript_chunks tc
              WHERE tc.transcript_version_id = mts.active_transcript_version_id
                AND (
                    tc.embedding_vector IS NULL
                    OR tc.embedding_model NOT LIKE 'openai_%'
                )
          )
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_podcast_transcript_chunks_embedding_vector_ann")
    op.execute("DROP INDEX IF EXISTS ix_podcast_transcript_chunks_embedding_model")
    op.execute(
        """
        ALTER TABLE podcast_transcript_chunks
        DROP COLUMN IF EXISTS embedding_vector
        """
    )
