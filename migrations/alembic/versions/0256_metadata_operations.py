"""Hard-cut metadata activity to typed job outcomes and semantic notifications.

Writers must be stopped and settled legacy jobs/generation evidence archived in
the verified release backup. Unresolved work blocks this migration. No legacy
memo is decoded or given fabricated modern outcome facts.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0256"
down_revision: str | Sequence[str] | None = "0255"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        DO $$ BEGIN
            IF EXISTS (
                SELECT 1 FROM background_jobs
                WHERE kind='enrich_metadata' AND (
                    status NOT IN ('succeeded', 'dead')
                    OR payload #>> '{coordination,codex/metadata,dispatch_phase}' = 'Uncertain'
                )
            ) OR EXISTS (
                SELECT 1 FROM llm_calls WHERE owner_kind='media_enrichment' AND outcome IS NULL
            ) THEN
                RAISE EXCEPTION 'unresolved metadata work blocks metadata outcome cutover';
            END IF;
        END $$;
        DELETE FROM background_jobs WHERE kind='enrich_metadata';
        ALTER TABLE podcast_episodes ADD COLUMN rss_metadata_fingerprint text;
        UPDATE media SET failure_stage=NULL, last_error_code=NULL, last_error_message=NULL
        WHERE failure_stage='metadata';
        ALTER TYPE failure_stage_enum RENAME TO failure_stage_enum_retired;
        CREATE TYPE failure_stage_enum AS ENUM ('upload','extract','transcribe','embed','other');
        ALTER TABLE media ALTER COLUMN failure_stage TYPE failure_stage_enum
            USING failure_stage::text::failure_stage_enum;
        DROP TYPE failure_stage_enum_retired;

        CREATE FUNCTION notify_metadata_job_change() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE item_id text;
        BEGIN
            IF TG_OP = 'DELETE' THEN
                IF OLD.kind <> 'enrich_metadata' THEN RETURN OLD; END IF;
                item_id := OLD.payload->>'media_id';
            ELSE
                IF NEW.kind <> 'enrich_metadata' THEN RETURN NEW; END IF;
                IF TG_OP = 'UPDATE' AND (
                    NEW.status, NEW.payload, NEW.available_at, NEW.error_code, NEW.result,
                    NEW.started_at, NEW.finished_at, NEW.execution_id
                ) IS NOT DISTINCT FROM (
                    OLD.status, OLD.payload, OLD.available_at, OLD.error_code, OLD.result,
                    OLD.started_at, OLD.finished_at, OLD.execution_id
                ) THEN RETURN NEW; END IF;
                item_id := NEW.payload->>'media_id';
            END IF;
            IF item_id IS NOT NULL THEN PERFORM pg_notify('media_events', item_id); END IF;
            IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
            RETURN NEW;
        END $$;
        CREATE TRIGGER metadata_job_change
            AFTER INSERT OR UPDATE OR DELETE ON background_jobs
            FOR EACH ROW EXECUTE FUNCTION notify_metadata_job_change();
        CREATE INDEX ix_metadata_jobs_media_created
            ON background_jobs ((payload->>'media_id'), created_at DESC, id DESC)
            WHERE kind='enrich_metadata';
    """)


def downgrade() -> None:
    raise NotImplementedError("0256 metadata memo cutover requires the verified release backup")
