"""Keep only each dossier's current revision; drop promoted_at and the write-free learn tables.

Revision ID: 0250
Revises: 0249

Irreversible. The release stops writers and verifies a backup first; after this revision the
backup is the only copy of every replaced revision with its build, build events, queue row and
edges, of every promoted_at value, and of the artifact_learn_* rows. The pre-0250 backend cannot
run on the result (it reads and writes promoted_at and deletes learn rows), so a backend rollback
means restoring the previous application and this backup together.

upgrade() first refuses, before any change, when a stored row lacks a key whose default the
typed wire drops (a current revision's manifest list, a chat context_ref_added activation, an
oracle passage citation): such a row loads today and would fail to load after the release. A
manifest of no known kind already fails today and is not counted. Fix: add an UPDATE here that
writes the missing key as [] or null; never restore the defaults.

What it deletes, read-only (the owner's loss count; the preflight ticket repeats it):
    SELECT a.subject_scheme, count(*) FROM artifact_revisions r
      JOIN artifact_builds b ON b.id = r.build_id JOIN artifacts a ON a.id = b.artifact_id
    WHERE a.current_revision_id IS DISTINCT FROM r.id GROUP BY 1;
    SELECT e.origin, e.ordinal IS NOT NULL AS cited,
           e.source_scheme = 'artifact_revision' AS from_revision, count(*)
      FROM resource_edges e JOIN artifact_revisions r
        ON (e.source_scheme = 'artifact_revision' AND e.source_id = r.id)
        OR (e.target_scheme = 'artifact_revision' AND e.target_id = r.id)
      JOIN artifact_builds b ON b.id = r.build_id JOIN artifacts a ON a.id = b.artifact_id
    WHERE a.current_revision_id IS DISTINCT FROM r.id GROUP BY 1, 2, 3;
    SELECT (SELECT count(*) FROM artifact_learn_requests),
           (SELECT count(*) FROM artifact_learn_successes),
           (SELECT count(*) FROM artifact_learn_failures);
Edges with cited = true and from_revision = false survive and resolve missing; every other
counted edge is deleted, with each link-note motif it belongs to.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0250"
down_revision: str | Sequence[str] | None = "0249"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    blocked = (
        op.get_bind()
        .execute(
            sa.text("""
        WITH bad AS (
            SELECT 'artifact_revisions.input_manifest' AS what, r.id
            FROM artifact_revisions r JOIN artifacts a ON a.current_revision_id = r.id
            WHERE NOT r.input_manifest ?& CASE r.input_manifest->>'kind'
                WHEN 'media' THEN ARRAY['omitted_evidence']
                WHEN 'conversation' THEN ARRAY['message_refs', 'context_refs']
                WHEN 'library' THEN ARRAY['media']
                WHEN 'podcast' THEN ARRAY['episodes']
                WHEN 'contributor' THEN ARRAY['works']
                WHEN 'page' THEN ARRAY['block_refs', 'connection_refs']
                WHEN 'note' THEN ARRAY['connection_refs']
                WHEN 'idea' THEN ARRAY['included_seed_refs', 'nexus_query_fingerprints',
                                       'web_query_fingerprints', 'included_sources',
                                       'omitted_sources'] END
            UNION ALL
            SELECT 'chat_run_events context_ref_added', e.id FROM chat_run_events e
            WHERE e.event_type = 'context_ref_added'
              AND NOT (e.payload->'activation' ?& ARRAY['href', 'unresolved_reason'])
            UNION ALL
            SELECT 'oracle_reading_events passage', e.id FROM oracle_reading_events e
            WHERE e.event_type = 'passage' AND jsonb_typeof(e.payload->'citation') = 'object'
              AND NOT (e.payload->'citation' ?& ARRAY['media_id', 'locator', 'deep_link', 'snapshot']
                AND e.payload->'citation'->'activation' ?& ARRAY['href', 'unresolved_reason']
                AND (jsonb_typeof(e.payload->'citation'->'snapshot') <> 'object'
                  OR e.payload->'citation'->'snapshot' ?& ARRAY['title', 'excerpt',
                     'section_label', 'result_type', 'summary_md']))
        )
        SELECT what, count(*), (array_agg(id ORDER BY id))[1:10] FROM bad GROUP BY what ORDER BY what
        """)
        )
        .all()
    )
    if blocked:
        raise RuntimeError(
            "0250 blocked: stored rows lack keys the release no longer defaults; "
            + "; ".join(
                f"{what}: {count} rows, sample ids {', '.join(str(row_id) for row_id in ids)}"
                for what, count, ids in blocked
            )
            + ". add a backfill UPDATE to 0250 and retry"
        )
    # Write-free since the Idea resolver was deleted; artifact_learn_successes.build_id
    # would block deleting replaced builds, here and in every later success.
    op.drop_table("artifact_learn_successes")
    op.drop_table("artifact_learn_failures")
    op.drop_table("artifact_learn_requests")
    op.execute(
        """
        CREATE TEMP TABLE replaced ON COMMIT DROP AS
        SELECT r.id, r.build_id FROM artifact_revisions r
        JOIN artifact_builds b ON b.id = r.build_id
        JOIN artifacts a ON a.id = b.artifact_id
        WHERE a.current_revision_id IS DISTINCT FROM r.id
        """
    )
    # resource_graph/cleanup.py: a dying revision takes every edge it sources, every bare edge
    # that targets it, and each link-note motif attached to it, whole. Cited edges that target
    # it survive with their snapshot.
    op.execute(
        """
        CREATE TEMP TABLE dying_edges ON COMMIT DROP AS
        SELECT e.id FROM resource_edges e JOIN replaced r
          ON (e.source_scheme = 'artifact_revision' AND e.source_id = r.id)
          OR (e.target_scheme = 'artifact_revision' AND e.target_id = r.id AND e.ordinal IS NULL)
        UNION
        SELECT m.id FROM resource_edges m
        WHERE m.origin = 'link_note' AND m.source_scheme = 'note_block' AND m.source_id IN (
            SELECT e.source_id FROM resource_edges e JOIN replaced r
              ON e.target_scheme = 'artifact_revision' AND e.target_id = r.id
            WHERE e.origin = 'link_note'
        )
        """
    )
    op.execute("DELETE FROM resource_view_states WHERE edge_id IN (SELECT id FROM dying_edges)")
    op.execute("DELETE FROM resource_edges WHERE id IN (SELECT id FROM dying_edges)")
    jobs = (
        "SELECT j.id FROM background_jobs j JOIN replaced r "
        "ON j.kind = 'dossier_build' AND j.dedupe_key = 'dossier_build:' || r.build_id::text"
    )
    # The lease table is a slot table (one 'Heavy' row): release a held slot, never delete it.
    op.execute(
        "UPDATE background_job_capacity_leases SET job_id = NULL, worker_id = NULL, "
        "attempt_no = NULL, lease_expires_at = NULL, updated_at = now() "
        f"WHERE resource_class = 'Heavy' AND job_id IN ({jobs})"
    )
    op.execute(f"DELETE FROM background_jobs WHERE id IN ({jobs})")
    op.execute(
        "DELETE FROM artifact_build_events WHERE build_id IN (SELECT build_id FROM replaced)"
    )
    op.execute("DELETE FROM artifact_revisions WHERE id IN (SELECT id FROM replaced)")
    op.execute("DELETE FROM artifact_builds WHERE id IN (SELECT build_id FROM replaced)")
    op.drop_column("artifact_revisions", "promoted_at")


def downgrade() -> None:
    raise NotImplementedError(
        "0250 requires restoring the previous application and database together"
    )
