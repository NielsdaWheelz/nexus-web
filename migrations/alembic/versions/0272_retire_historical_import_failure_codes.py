"""Retire the historical import failure codes: billing, model-provider, podcast quota.

Revision ID: 0272
Revises: 0271

Nothing writes E_BILLING_REQUIRED, E_LLM_BAD_REQUEST or E_PODCAST_QUOTA_EXCEEDED any
more, and the import failure catalog drops them, so every stored import failure that
names one becomes E_INGEST_FAILED (all three were same-source retryable, like it):
the media's last error, the source attempt, the processing and upload event columns,
a source history baseline's recorded outcome, and the queue rows imports reads (a
source attempt's job, or a content reindex job). Unrelated queue rows keep their raw
code, and media_transcript_states.last_error_code keeps transcription's own reason
(0252). Irreversible: the release's pre-migration backup holds the original codes.
Writers are stopped; media_notify fires once per rewritten media row.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0272"
down_revision: str | Sequence[str] | None = "0271"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

RETIRED = "('E_BILLING_REQUIRED', 'E_LLM_BAD_REQUEST', 'E_PODCAST_QUOTA_EXCEEDED')"


def upgrade() -> None:
    for table, column in (
        ("media", "last_error_code"),
        ("media_source_attempts", "error_code"),
        ("media_processing_events", "failure_code"),
        ("media_upload_events", "failure_code"),
    ):
        op.execute(f"UPDATE {table} SET {column} = 'E_INGEST_FAILED' WHERE {column} IN {RETIRED}")
    op.execute(f"""
        UPDATE media_processing_events
           SET payload = jsonb_set(payload, '{{outcome,failure_code}}', '"E_INGEST_FAILED"')
         WHERE payload->'outcome'->>'failure_code' IN {RETIRED}
    """)
    op.execute(f"""
        UPDATE background_jobs SET error_code = 'E_INGEST_FAILED'
         WHERE error_code IN {RETIRED}
           AND (kind = 'media_content_reindex_job'
                OR id IN (SELECT job_id FROM media_source_attempts WHERE job_id IS NOT NULL))
    """)


def downgrade() -> None:
    raise NotImplementedError("0272 is an irreversible rewrite of retired failure codes")
