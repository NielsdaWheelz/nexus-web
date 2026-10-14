"""Metadata source revision and personal review of retained no-findings results."""

from alembic import op

revision = "0277"
down_revision = "0276"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE media_transcript_states ADD COLUMN content_revision bigint NOT NULL DEFAULT 0"
    )
    op.execute("""
        CREATE TABLE metadata_result_reviews (
            id uuid PRIMARY KEY,
            viewer_id uuid NOT NULL REFERENCES users(id),
            job_id uuid NOT NULL REFERENCES background_jobs(id),
            reviewed_at timestamptz NOT NULL,
            UNIQUE (viewer_id, job_id)
        )
    """)
    op.execute(
        "CREATE INDEX metadata_result_reviews_job_id_idx ON metadata_result_reviews (job_id)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE metadata_result_reviews")
    op.execute("ALTER TABLE media_transcript_states DROP COLUMN content_revision")
