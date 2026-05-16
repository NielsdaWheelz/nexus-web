"""Make citation audits append-only per message.

Revision ID: 0094
Revises: 0093
Create Date: 2026-05-15
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0094"
down_revision: str | None = "0093"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE message_artifacts "
        "DROP CONSTRAINT IF EXISTS uix_message_artifacts_message_key"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_message_artifacts_message_key_created "
        "ON message_artifacts (message_id, artifact_key, created_at, id)"
    )
    op.execute(
        "ALTER TABLE assistant_message_citation_audits "
        "DROP CONSTRAINT IF EXISTS uix_assistant_citation_audits_message"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_assistant_citation_audits_message_created "
        "ON assistant_message_citation_audits (message_id, created_at, id)"
    )


def downgrade() -> None:
    op.execute(
        """
        WITH duplicate_artifacts AS (
            SELECT artifact.id
            FROM message_artifacts artifact
            WHERE artifact.artifact_key IS NOT NULL
              AND artifact.id NOT IN (
                  SELECT DISTINCT ON (message_id, artifact_key) id
                  FROM message_artifacts
                  WHERE artifact_key IS NOT NULL
                  ORDER BY message_id, artifact_key, created_at DESC, id DESC
              )
        )
        DELETE FROM message_artifact_parts part
        USING duplicate_artifacts duplicate
        WHERE part.artifact_id = duplicate.id
        """
    )
    op.execute(
        """
        WITH duplicate_artifacts AS (
            SELECT artifact.id
            FROM message_artifacts artifact
            WHERE artifact.artifact_key IS NOT NULL
              AND artifact.id NOT IN (
                  SELECT DISTINCT ON (message_id, artifact_key) id
                  FROM message_artifacts
                  WHERE artifact_key IS NOT NULL
                  ORDER BY message_id, artifact_key, created_at DESC, id DESC
              )
        )
        DELETE FROM message_artifacts artifact
        USING duplicate_artifacts duplicate
        WHERE artifact.id = duplicate.id
        """
    )
    op.execute("DROP INDEX IF EXISTS idx_assistant_citation_audits_message_created")
    op.execute("DROP INDEX IF EXISTS idx_message_artifacts_message_key_created")
    op.execute(
        """
        DELETE FROM assistant_message_citation_audits older
        USING assistant_message_citation_audits newer
        WHERE older.message_id = newer.message_id
          AND (
              older.created_at < newer.created_at
              OR (older.created_at = newer.created_at AND older.id < newer.id)
          )
        """
    )
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'uix_assistant_citation_audits_message'
            ) THEN
                ALTER TABLE assistant_message_citation_audits
                ADD CONSTRAINT uix_assistant_citation_audits_message UNIQUE (message_id);
            END IF;
        END $$;
        """
    )
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'uix_message_artifacts_message_key'
            ) THEN
                ALTER TABLE message_artifacts
                ADD CONSTRAINT uix_message_artifacts_message_key UNIQUE (message_id, artifact_key);
            END IF;
        END $$;
        """
    )
