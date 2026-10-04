"""A dossier head carries its one revision; a build carries its status.

Revision ID: 0259
Revises: 0258

artifact_revisions folds into its head (revision_id is preserved, so every
artifact_revision: edge, link and context still resolves); the three terminal-child
tables and the event log become artifact_builds.status; idea keys become title_key;
artifact_idea_resolutions (write-only) goes.

upgrade() refuses, before any change, on rows the new shape cannot hold: an idea key
other than {version: v1, title_key}, a non-uuid audience_id, a build with more than
one terminal child, a current revision belonging to another head, a revision that is
not its head's current one. Fix the rows (or this file) and retry.

What it loses, read-only (the owner's loss count):
    -- active builds: cancelled, their jobs (and journals) deleted
    SELECT count(*) FROM artifact_builds b
    WHERE NOT EXISTS (SELECT 1 FROM artifact_revisions WHERE build_id = b.id)
      AND NOT EXISTS (SELECT 1 FROM artifact_build_failures WHERE build_id = b.id)
      AND NOT EXISTS (SELECT 1 FROM artifact_build_cancellations WHERE build_id = b.id);
    -- heads that read stale until regenerated: every head with a revision, since the
    -- new input fingerprint cannot be proven for old inputs
    SELECT count(*) FROM artifacts WHERE current_revision_id IS NOT NULL;
    -- failed or cancelled builds older than their head's revision: deleted, as a
    -- publish now deletes every other build of its head
    SELECT count(*) FROM artifact_builds b JOIN artifacts a ON a.id = b.artifact_id
    JOIN artifact_revisions r ON r.id = a.current_revision_id
    WHERE b.created_at < r.created_at AND b.id <> r.build_id;
Plus every event row, failure detail of a deleted build, cancellation actor and idea
resolution. Irreversible: the release's backup is the only copy.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0259"
down_revision: str | Sequence[str] | None = "0258"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PREFLIGHT = """
WITH bad AS (
    SELECT 'idea key other than {version: v1, title_key}' AS what, s.id
    FROM artifact_idea_subjects s
    WHERE (SELECT count(*) FROM jsonb_object_keys(s.idea_key)) <> 2
       OR s.idea_key->>'version' IS DISTINCT FROM 'v1'
       OR jsonb_typeof(s.idea_key->'title_key') IS DISTINCT FROM 'string'
    UNION ALL
    SELECT 'non-uuid audience_id', a.id FROM artifacts a
    WHERE a.audience_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    UNION ALL
    SELECT 'build with more than one terminal child', b.id FROM artifact_builds b
    WHERE (SELECT count(*) FROM artifact_revisions WHERE build_id = b.id)
        + (SELECT count(*) FROM artifact_build_failures WHERE build_id = b.id)
        + (SELECT count(*) FROM artifact_build_cancellations WHERE build_id = b.id) > 1
    UNION ALL
    SELECT 'current revision of another head', a.id FROM artifacts a
    LEFT JOIN artifact_revisions r ON r.id = a.current_revision_id
    LEFT JOIN artifact_builds b ON b.id = r.build_id
    WHERE a.current_revision_id IS NOT NULL AND b.artifact_id IS DISTINCT FROM a.id
    UNION ALL
    SELECT 'revision that is not current', r.id FROM artifact_revisions r
    JOIN artifact_builds b ON b.id = r.build_id JOIN artifacts a ON a.id = b.artifact_id
    WHERE a.current_revision_id IS DISTINCT FROM r.id
)
SELECT what, count(*), (array_agg(id ORDER BY id))[1:10] FROM bad GROUP BY what ORDER BY what
"""

_HEAD_COLUMNS = """
ALTER TABLE artifacts ADD COLUMN revision_id uuid, ADD COLUMN content_html text,
    ADD COLUMN content_text text, ADD COLUMN coverage jsonb, ADD COLUMN citation_owner_user_id uuid,
    ADD COLUMN creator_user_id uuid, ADD COLUMN instruction text, ADD COLUMN model_name text,
    ADD COLUMN total_tokens integer, ADD COLUMN generated_at timestamptz;
"""

_BUILD_STATUS = """
ALTER TABLE artifact_builds ADD COLUMN status text, ADD COLUMN failure_code text,
    ADD COLUMN failure_detail text, ADD COLUMN finished_at timestamptz;
UPDATE artifact_builds b SET status = 'succeeded', finished_at = r.created_at
FROM artifact_revisions r WHERE r.build_id = b.id;
UPDATE artifact_builds b SET status = 'failed', failure_code = f.failure_code,
    failure_detail = f.detail, finished_at = f.created_at
FROM artifact_build_failures f WHERE f.build_id = b.id;
UPDATE artifact_builds b SET status = 'cancelled', finished_at = c.created_at
FROM artifact_build_cancellations c WHERE c.build_id = b.id;
"""

# Old manifests carry no fingerprint the new collectors reproduce: fingerprint '' never
# matches, so each migrated revision reads stale until regenerated. Counts per old kind.
_HEAD_REVISION = """
CREATE TEMP TABLE head_revisions ON COMMIT DROP AS
SELECT a.id AS artifact_id, r.id AS revision_id, r.content_html, r.content_text,
       r.citation_owner_user_id, r.creator_user_id, b.instruction, r.created_at,
       r.input_manifest->>'kind' AS kind, r.input_manifest AS m,
       CASE r.input_manifest->>'kind' WHEN 'library' THEN r.input_manifest->'media'
           WHEN 'podcast' THEN r.input_manifest->'episodes'
           WHEN 'contributor' THEN r.input_manifest->'works' END AS members,
       g.model_name, g.total_tokens
FROM artifacts a
JOIN artifact_revisions r ON r.id = a.current_revision_id
JOIN artifact_builds b ON b.id = r.build_id
LEFT JOIN LATERAL (
    SELECT COALESCE(l.generation_spec->'selection'->>'model',
                    l.generation_spec->'selection'->>'model_ref') AS model_name,
           (SELECT CASE WHEN bool_and(COALESCE(t.usage->>'total_tokens' ~ '^[0-9]+$', false))
                   THEN sum((t.usage->>'total_tokens')::bigint)::integer END
            FROM llm_model_turns t WHERE t.generation_id = l.id) AS total_tokens
    FROM llm_calls l
    WHERE l.owner_kind = 'artifact_build' AND l.owner_id = r.build_id AND l.outcome = 'Succeeded'
    ORDER BY l.generation_seq DESC LIMIT 1
) g ON true;

UPDATE artifacts a SET
    revision_id = h.revision_id, content_html = h.content_html, content_text = h.content_text,
    citation_owner_user_id = h.citation_owner_user_id, creator_user_id = h.creator_user_id,
    instruction = h.instruction, model_name = h.model_name, total_tokens = h.total_tokens,
    generated_at = h.created_at,
    coverage = jsonb_build_object(
        'unit', CASE h.kind WHEN 'media' THEN 'claim' WHEN 'library' THEN 'media'
            WHEN 'podcast' THEN 'episode' WHEN 'contributor' THEN 'work' ELSE 'source' END,
        'included', c.included,
        'omitted', CASE h.kind WHEN 'media' THEN jsonb_array_length(h.m->'omitted_evidence')
            WHEN 'idea' THEN jsonb_array_length(h.m->'omitted_sources')
            WHEN 'library' THEN jsonb_array_length(h.members) - c.included
            WHEN 'podcast' THEN jsonb_array_length(h.members) - c.included
            WHEN 'contributor' THEN jsonb_array_length(h.members) - c.included ELSE 0 END,
        'fingerprint', '',
        'sources', CASE WHEN h.kind = 'idea' THEN (
            SELECT COALESCE(jsonb_agg(jsonb_build_array(s->>'ref', s->>'ref')), '[]')
            FROM jsonb_array_elements(h.m->'included_sources') s) ELSE '[]' END)
FROM head_revisions h CROSS JOIN LATERAL (
    SELECT CASE h.kind
        WHEN 'media' THEN (h.m->>'offered_claim_count')::integer
        WHEN 'conversation' THEN jsonb_array_length(h.m->'message_refs')
            + jsonb_array_length(h.m->'context_refs')
        WHEN 'page' THEN jsonb_array_length(h.m->'block_refs')
            + jsonb_array_length(h.m->'connection_refs')
        WHEN 'note' THEN (h.m->'body_fingerprint'->>'kind' = 'Present')::integer
            + jsonb_array_length(h.m->'connection_refs')
        WHEN 'idea' THEN jsonb_array_length(h.m->'included_sources')
        ELSE (SELECT count(*)::integer FROM jsonb_array_elements(h.members) e
              WHERE e->>'disposition' = 'Included') END AS included
) c
WHERE a.id = h.artifact_id;
"""

# Active builds are cancelled (their journals hold shapes the new code does not decode);
# failed and cancelled builds older than their head's revision are deleted. Both lose
# their queue rows; a held Heavy lease slot is released, never deleted (as 0250 did).
_RETIRE_BUILDS = """
CREATE TEMP TABLE superseded ON COMMIT DROP AS
SELECT b.id FROM artifact_builds b JOIN artifacts a ON a.id = b.artifact_id
WHERE b.status IN ('failed', 'cancelled') AND b.created_at < a.generated_at;
CREATE TEMP TABLE retired_jobs ON COMMIT DROP AS
SELECT j.id FROM background_jobs j JOIN artifact_builds b
  ON j.kind = 'dossier_build' AND j.dedupe_key = 'dossier_build:' || b.id::text
WHERE b.status IS NULL OR b.id IN (SELECT id FROM superseded);
UPDATE artifact_builds SET status = 'cancelled', finished_at = now() WHERE status IS NULL;
UPDATE background_job_capacity_leases SET job_id = NULL, worker_id = NULL, attempt_no = NULL,
    lease_expires_at = NULL, updated_at = now()
WHERE resource_class = 'Heavy' AND job_id IN (SELECT id FROM retired_jobs);
DELETE FROM background_jobs WHERE id IN (SELECT id FROM retired_jobs);
DROP TABLE artifact_build_events;
DROP FUNCTION notify_artifact_build_event();
DROP TABLE artifact_build_failures;
DROP TABLE artifact_build_cancellations;
DELETE FROM artifact_builds WHERE id IN (SELECT id FROM superseded);
"""

_CONSTRAIN = """
ALTER TABLE artifact_builds ALTER COLUMN status SET NOT NULL,
    ADD CONSTRAINT ck_artifact_builds_status
        CHECK (status IN ('active', 'succeeded', 'failed', 'cancelled')),
    ADD CONSTRAINT ck_artifact_builds_failure CHECK ((status = 'failed') = (failure_code IS NOT NULL)),
    ADD CONSTRAINT ck_artifact_builds_finished CHECK ((status = 'active') = (finished_at IS NULL)),
    DROP CONSTRAINT artifact_builds_artifact_id_fkey,
    ADD CONSTRAINT artifact_builds_artifact_id_fkey
        FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX uq_artifact_builds_active ON artifact_builds (artifact_id)
    WHERE status = 'active';

ALTER TABLE artifacts DROP CONSTRAINT fk_artifacts_current_revision,
    DROP COLUMN current_revision_id,
    ALTER COLUMN audience_id TYPE uuid USING audience_id::uuid,
    ADD CONSTRAINT uq_artifacts_revision UNIQUE (revision_id),
    ADD CONSTRAINT artifacts_citation_owner_user_id_fkey
        FOREIGN KEY (citation_owner_user_id) REFERENCES users(id),
    ADD CONSTRAINT artifacts_creator_user_id_fkey
        FOREIGN KEY (creator_user_id) REFERENCES users(id),
    ADD CONSTRAINT ck_artifacts_revision_complete CHECK (num_nulls(
        revision_id, content_html, content_text, coverage, citation_owner_user_id, generated_at
    ) IN (0, 6));
DROP TABLE artifact_revisions;

ALTER TABLE artifact_idea_subjects ADD COLUMN title_key text;
UPDATE artifact_idea_subjects SET title_key = idea_key->>'title_key';
ALTER TABLE artifact_idea_subjects ALTER COLUMN title_key SET NOT NULL,
    DROP CONSTRAINT uq_artifact_idea_subjects_owner_key,
    DROP COLUMN idea_key,
    ADD CONSTRAINT uq_artifact_idea_subjects_owner_key UNIQUE (user_id, title_key);
ALTER TABLE artifact_idea_seeds DROP CONSTRAINT artifact_idea_seeds_artifact_id_fkey,
    DROP CONSTRAINT artifact_idea_seeds_highlight_id_fkey,
    ADD CONSTRAINT artifact_idea_seeds_artifact_id_fkey
        FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE,
    ADD CONSTRAINT artifact_idea_seeds_highlight_id_fkey
        FOREIGN KEY (highlight_id) REFERENCES highlights(id) ON DELETE CASCADE;
DROP TABLE artifact_idea_resolutions;

CREATE FUNCTION notify_artifact_build() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('artifact_builds', (CASE TG_OP WHEN 'DELETE' THEN OLD.id ELSE NEW.id END)::text);
    RETURN NULL;
END $$;
CREATE TRIGGER artifact_builds_notify AFTER INSERT OR DELETE OR UPDATE OF status ON artifact_builds
    FOR EACH ROW EXECUTE FUNCTION notify_artifact_build();
"""


def upgrade() -> None:
    blocked = op.get_bind().execute(sa.text(_PREFLIGHT)).all()
    if blocked:
        raise RuntimeError(
            "0259 blocked: "
            + "; ".join(
                f"{what}: {count} rows, sample ids {', '.join(str(row_id) for row_id in ids)}"
                for what, count, ids in blocked
            )
        )
    # Multi-statement SQL goes straight to the DBAPI cursor, as 0236 does.
    with op.get_bind().connection.cursor() as cursor:
        for sql in (_HEAD_COLUMNS, _BUILD_STATUS, _HEAD_REVISION, _RETIRE_BUILDS, _CONSTRAIN):
            cursor.execute(sql)


def downgrade() -> None:
    raise NotImplementedError("0259 requires restoring the previous application and database")
