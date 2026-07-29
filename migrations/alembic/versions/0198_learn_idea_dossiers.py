"""Cut Dossiers to HTML bodies and add user-owned Idea subjects.

Revision ID: 0198
Revises: 0197
Create Date: 2026-07-28
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0198"
down_revision: str | Sequence[str] | None = "0197"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("DELETE FROM background_jobs WHERE kind = 'dossier_build'")

    op.execute(
        """
        CREATE TEMP TABLE _0198_external_snapshot_ids
        ON COMMIT DROP AS
        SELECT DISTINCT target_id AS id
        FROM resource_edges
        WHERE target_scheme = 'external_snapshot'
          AND source_scheme = 'artifact_revision'
        """
    )
    op.execute(
        """
        DELETE FROM resource_view_states
        WHERE surface_scheme = 'artifact_revision'
           OR target_scheme = 'artifact_revision'
           OR edge_id IN (
               SELECT id
               FROM resource_edges
               WHERE source_scheme = 'artifact_revision'
                  OR target_scheme = 'artifact_revision'
           )
        """
    )
    op.execute(
        """
        DELETE FROM resource_edges
        WHERE source_scheme = 'artifact_revision'
           OR target_scheme = 'artifact_revision'
        """
    )
    op.execute(
        """
        DELETE FROM resource_external_snapshots AS snapshot
        WHERE snapshot.id IN (SELECT id FROM _0198_external_snapshot_ids)
          AND NOT EXISTS (
              SELECT 1
              FROM resource_edges AS edge
              WHERE edge.target_scheme = 'external_snapshot'
                AND edge.target_id = snapshot.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM message_retrievals AS retrieval
              WHERE retrieval.result_type = 'web_result'
                AND retrieval.source_id = snapshot.id::text
          )
        """
    )

    op.execute("UPDATE artifacts SET current_revision_id = NULL")
    op.execute("DELETE FROM llm_calls WHERE owner_kind = 'artifact_build'")
    op.execute("DELETE FROM artifact_build_events")
    op.execute("DELETE FROM artifact_revisions")
    op.execute("DELETE FROM artifact_build_failures")
    op.execute("DELETE FROM artifact_build_cancellations")
    op.execute("DELETE FROM artifact_builds")

    op.execute("ALTER TABLE artifact_revisions ADD COLUMN content_html text NULL")
    op.execute("ALTER TABLE artifact_revisions ADD COLUMN content_text text NULL")
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM artifact_revisions) THEN
                RAISE EXCEPTION 'artifact_revisions must be empty at the 0198 body cutover';
            END IF;
        END
        $$;
        """
    )
    op.execute("ALTER TABLE artifact_revisions ALTER COLUMN content_html SET NOT NULL")
    op.execute("ALTER TABLE artifact_revisions ALTER COLUMN content_text SET NOT NULL")
    op.execute("ALTER TABLE artifact_revisions DROP COLUMN content_md")

    op.execute(
        "ALTER TABLE artifact_build_events DROP CONSTRAINT ck_artifact_build_events_type"
    )
    op.execute(
        """
        ALTER TABLE artifact_build_events
        ADD CONSTRAINT ck_artifact_build_events_type
        CHECK (event_type IN ('Started', 'Progress', 'Succeeded', 'Failed', 'Cancelled'))
        """
    )
    op.execute("ALTER TABLE llm_calls DROP CONSTRAINT ck_llm_calls_owner_kind")
    op.execute(
        """
        ALTER TABLE llm_calls
        ADD CONSTRAINT ck_llm_calls_owner_kind
        CHECK (
            owner_kind IN (
                'chat_run',
                'oracle_reading',
                'artifact_build',
                'artifact_learn_request',
                'media_summary',
                'media_enrichment',
                'synapse_scan',
                'dawn_write'
            )
        )
        """
    )

    op.execute(
        """
        CREATE TABLE artifact_idea_subjects (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id uuid NOT NULL REFERENCES users(id),
            idea_key jsonb NOT NULL,
            display_title text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT uq_artifact_idea_subjects_owner_key UNIQUE (user_id, idea_key)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE artifact_idea_resolutions (
            highlight_id uuid PRIMARY KEY REFERENCES highlights(id),
            user_id uuid NOT NULL REFERENCES users(id),
            idea_subject_id uuid NOT NULL REFERENCES artifact_idea_subjects(id),
            created_at timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE TABLE artifact_idea_seeds (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            artifact_id uuid NOT NULL REFERENCES artifacts(id),
            highlight_id uuid NOT NULL REFERENCES highlights(id),
            added_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT uq_artifact_idea_seeds_pair UNIQUE (artifact_id, highlight_id)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE artifact_learn_requests (
            id uuid PRIMARY KEY,
            user_id uuid NOT NULL REFERENCES users(id),
            idempotency_key text NOT NULL,
            request_hash text NOT NULL,
            highlight_id uuid NOT NULL REFERENCES highlights(id),
            coordination jsonb NOT NULL,
            resolver_lease_expires_at timestamptz NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT uq_artifact_learn_requests_user_key
                UNIQUE (user_id, idempotency_key)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE artifact_learn_successes (
            request_id uuid PRIMARY KEY REFERENCES artifact_learn_requests(id),
            outcome_kind text NOT NULL,
            artifact_id uuid NOT NULL REFERENCES artifacts(id),
            build_id uuid NULL REFERENCES artifact_builds(id),
            created_at timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE TABLE artifact_learn_failures (
            request_id uuid PRIMARY KEY REFERENCES artifact_learn_requests(id),
            error_code text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        )
        """
    )


def downgrade() -> None:
    raise RuntimeError("Hard cutover: 0198 is not reversible")
