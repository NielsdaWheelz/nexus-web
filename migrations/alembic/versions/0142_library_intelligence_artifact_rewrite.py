"""library intelligence artifact rewrite (stable head + immutable revisions)

Revision ID: 0142
Revises: 0141
Create Date: 2026-06-07

Hard cutover (S4). Drops the deterministic-compiler subtables and the old
``library_intelligence_artifacts`` head, then re-creates Library Intelligence as
a **stable head** (``library_intelligence_artifacts``, one per library, with a
nullable ``current_revision_id`` pointer) over **immutable revisions**
(``library_intelligence_artifact_revisions``). A revision IS the generation run:
its events live in ``library_intelligence_revision_events`` (run_kit) and its
typed citations in ``library_intelligence_citations``.

Also finishes the verifier-taxonomy teardown begun in ``0116``: drops the
orphaned ``assistant_claim_support_status`` enum, strips the dead
``claim``/``claim_evidence`` values from the ``chat_run_events`` event_type
CHECK, and drops the long-dead ``chat_runs.next_event_seq`` column + its CHECK.

Irreversible.
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0142"
down_revision: str | Sequence[str] | None = "0141"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # (A) Teardown of the deterministic-compiler tables (child -> parent; FKs are
    # non-cascading, so order matters). The source-set/version tables were
    # already dropped in 0138; active_version_id is already gone.
    op.execute("DROP TABLE library_intelligence_evidence")
    op.execute("DROP TABLE library_intelligence_claims")
    op.execute("DROP TABLE library_intelligence_nodes")
    op.execute("DROP TABLE library_intelligence_sections")
    op.execute("DROP TABLE library_intelligence_builds")
    op.execute("DROP TABLE library_intelligence_artifacts")

    # (B) New head + revisions + circular FK + citations.
    op.execute("""
        CREATE TABLE library_intelligence_artifacts (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            library_id uuid NOT NULL REFERENCES libraries(id),
            user_id uuid NOT NULL REFERENCES users(id),
            current_revision_id uuid NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT uq_library_intelligence_artifacts_library UNIQUE (library_id)
        )
    """)
    op.execute("""
        CREATE TABLE library_intelligence_artifact_revisions (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            artifact_id uuid NOT NULL REFERENCES library_intelligence_artifacts(id),
            content_md text NOT NULL DEFAULT '',
            covered_targets jsonb NOT NULL,
            status text NOT NULL,
            idempotency_key text NULL,
            completed_at timestamptz NULL,
            promoted_at timestamptz NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT ck_li_revisions_status CHECK (
                status IN ('building', 'ready', 'failed')
            ),
            CONSTRAINT ck_li_revisions_covered_targets_array CHECK (
                jsonb_typeof(covered_targets) = 'array'
            )
        )
    """)
    op.execute("""
        CREATE INDEX ix_li_revisions_artifact_created
        ON library_intelligence_artifact_revisions (artifact_id, created_at DESC, id DESC)
    """)
    op.execute("""
        CREATE UNIQUE INDEX uq_li_revisions_artifact_idempotency_key
        ON library_intelligence_artifact_revisions (artifact_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
    """)
    # Circular head <-> revision FK, resolved after both tables exist.
    op.execute("""
        ALTER TABLE library_intelligence_artifacts
        ADD CONSTRAINT fk_li_artifacts_current_revision
        FOREIGN KEY (current_revision_id)
        REFERENCES library_intelligence_artifact_revisions(id)
    """)
    op.execute("""
        CREATE TABLE library_intelligence_revision_events (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            revision_id uuid NOT NULL REFERENCES library_intelligence_artifact_revisions(id),
            seq integer NOT NULL,
            event_type text NOT NULL,
            payload jsonb NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT ck_li_revision_events_seq_positive CHECK (seq >= 1),
            CONSTRAINT ck_li_revision_events_type CHECK (
                event_type IN ('meta', 'progress', 'delta', 'done')
            ),
            CONSTRAINT uq_li_revision_events_seq UNIQUE (revision_id, seq)
        )
    """)
    # No separate (revision_id, seq) index: uq_li_revision_events_seq is already a
    # btree over exactly those columns in that order (database.md: no redundant index).
    op.execute("""
        CREATE TABLE library_intelligence_citations (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            revision_id uuid NOT NULL REFERENCES library_intelligence_artifact_revisions(id),
            ordinal integer NOT NULL,
            role text NOT NULL,
            target_type text NOT NULL,
            target_id uuid NOT NULL,
            locator jsonb NULL,
            snapshot jsonb NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT ck_li_citations_role CHECK (
                role IN ('supports', 'contradicts', 'context')
            ),
            CONSTRAINT ck_li_citations_target_type CHECK (
                target_type IN ('evidence_span', 'content_chunk', 'media')
            ),
            CONSTRAINT ck_li_citations_ordinal_non_negative CHECK (ordinal >= 0),
            CONSTRAINT ck_li_citations_locator_object CHECK (
                locator IS NULL OR jsonb_typeof(locator) = 'object'
            ),
            CONSTRAINT ck_li_citations_snapshot_object CHECK (
                snapshot IS NULL OR jsonb_typeof(snapshot) = 'object'
            ),
            CONSTRAINT uq_li_citations_revision_ordinal UNIQUE (revision_id, ordinal)
        )
    """)
    # No separate (revision_id) index: uq_li_citations_revision_ordinal already
    # leads with revision_id, so it serves every revision-scoped read.

    # (C) Strip the dead chat verifier taxonomy from the chat_run_events CHECK.
    op.execute("ALTER TABLE chat_run_events DROP CONSTRAINT ck_chat_run_events_event_type")
    op.execute("""
        ALTER TABLE chat_run_events
        ADD CONSTRAINT ck_chat_run_events_event_type CHECK (
            event_type IN (
                'meta', 'tool_call', 'retrieval_result',
                'citation_index', 'reference_added', 'delta', 'done'
            )
        )
    """)
    op.execute("DROP TYPE IF EXISTS assistant_claim_support_status")

    # (D) Drop the long-dead chat_runs.next_event_seq column + its CHECK.
    op.execute("ALTER TABLE chat_runs DROP CONSTRAINT ck_chat_runs_next_event_seq_positive")
    op.execute("ALTER TABLE chat_runs DROP COLUMN next_event_seq")

    # (E) pg_notify trigger for the LI revision event stream (mirrors 0122).
    op.execute("""
        CREATE FUNCTION notify_library_intelligence_revision_event() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            PERFORM pg_notify('library_intelligence_revision_events', NEW.revision_id::text);
            RETURN NULL;
        END;
        $$
    """)
    op.execute("""
        CREATE TRIGGER library_intelligence_revision_events_notify
        AFTER INSERT ON library_intelligence_revision_events
        FOR EACH ROW EXECUTE FUNCTION notify_library_intelligence_revision_event()
    """)


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0142 is not reversible")
