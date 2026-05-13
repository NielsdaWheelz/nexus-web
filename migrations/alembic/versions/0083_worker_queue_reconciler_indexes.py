"""Worker queue and reconciler indexes.

Revision ID: 0083
Revises: 0082
Create Date: 2026-05-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0083"
down_revision: str | None = "0082"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.create_index(
            "idx_background_jobs_due_claim",
            "background_jobs",
            ["priority", "available_at", "created_at", "id"],
            postgresql_where=sa.text("status IN ('pending', 'failed')"),
            postgresql_concurrently=True,
        )
        op.create_index(
            "idx_background_jobs_running_expired_claim",
            "background_jobs",
            ["priority", "lease_expires_at", "created_at", "id"],
            postgresql_where=sa.text("status = 'running' AND lease_expires_at IS NOT NULL"),
            postgresql_concurrently=True,
        )
        op.create_index(
            "idx_background_jobs_terminal_prune",
            "background_jobs",
            ["finished_at", "id"],
            postgresql_where=sa.text(
                "status IN ('succeeded', 'dead') AND finished_at IS NOT NULL"
            ),
            postgresql_concurrently=True,
        )
        op.create_index(
            "idx_media_stale_extracting_recovery",
            "media",
            ["processing_started_at", "id"],
            postgresql_where=sa.text(
                "processing_status = 'extracting' "
                "AND kind IN ('web_article', 'pdf', 'epub', 'podcast_episode') "
                "AND processing_started_at IS NOT NULL"
            ),
            postgresql_concurrently=True,
        )
        op.create_index(
            "ix_media_content_index_states_repair_waiting",
            "media_content_index_states",
            ["updated_at", "media_id"],
            postgresql_where=sa.text("status IN ('pending', 'failed') AND active_run_id IS NULL"),
            postgresql_concurrently=True,
        )
        op.create_index(
            "ix_media_content_index_states_repair_indexing",
            "media_content_index_states",
            ["updated_at", "media_id"],
            postgresql_where=sa.text("status = 'indexing'"),
            postgresql_concurrently=True,
        )
        op.create_index(
            "ix_media_transcript_states_semantic_repair",
            "media_transcript_states",
            ["updated_at", "media_id"],
            postgresql_where=sa.text(
                "active_transcript_version_id IS NOT NULL "
                "AND transcript_state IN ('ready', 'partial') "
                "AND transcript_coverage IN ('partial', 'full') "
                "AND semantic_status IN ('pending', 'failed', 'ready')"
            ),
            postgresql_concurrently=True,
        )
        op.execute(
            """
            CREATE INDEX CONCURRENTLY ix_source_snapshots_transcript_run_version
            ON source_snapshots (index_run_id, ((metadata ->> 'transcript_version_id')))
            WHERE source_kind = 'transcript'
            """
        )


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("DROP INDEX CONCURRENTLY ix_source_snapshots_transcript_run_version")
        op.drop_index(
            "ix_media_transcript_states_semantic_repair",
            table_name="media_transcript_states",
            postgresql_concurrently=True,
        )
        op.drop_index(
            "ix_media_content_index_states_repair_indexing",
            table_name="media_content_index_states",
            postgresql_concurrently=True,
        )
        op.drop_index(
            "ix_media_content_index_states_repair_waiting",
            table_name="media_content_index_states",
            postgresql_concurrently=True,
        )
        op.drop_index(
            "idx_media_stale_extracting_recovery",
            table_name="media",
            postgresql_concurrently=True,
        )
        op.drop_index(
            "idx_background_jobs_terminal_prune",
            table_name="background_jobs",
            postgresql_concurrently=True,
        )
        op.drop_index(
            "idx_background_jobs_running_expired_claim",
            table_name="background_jobs",
            postgresql_concurrently=True,
        )
        op.drop_index(
            "idx_background_jobs_due_claim",
            table_name="background_jobs",
            postgresql_concurrently=True,
        )
