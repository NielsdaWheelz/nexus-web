"""Publish lexical capability independently of semantic completion.

Revision ID: 0305
Revises: 0304

Data effects: validate ready owners' nonempty chunks and owned primary spans, then
stamp their current revision without changing passages, embeddings or summaries.
Other states start without lexical capability. Executable note jobs gain their
owner's revision; deleted notes' executable index jobs become superseded successes
with released claims. Terminal history is unchanged. Refuse inconsistent ready
materializations or surviving notes without state; operator repair precedes retry.
No provider calls or automatic reindexing.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0305"
down_revision: str | Sequence[str] | None = "0304"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    db = op.get_bind()
    invalid = db.scalar(
        sa.text("""
        SELECT count(*) FROM content_index_states s WHERE s.status = 'ready' AND (
            (s.owner_kind = 'media' AND NOT EXISTS (SELECT 1 FROM media m WHERE m.id = s.owner_id))
            OR (s.owner_kind = 'note_block' AND NOT EXISTS (SELECT 1 FROM note_blocks n WHERE n.id = s.owner_id))
            OR s.owner_kind NOT IN ('media', 'note_block')
            OR NOT EXISTS (SELECT 1 FROM content_chunks c
                WHERE c.owner_kind = s.owner_kind AND c.owner_id = s.owner_id)
            OR EXISTS (SELECT 1 FROM content_chunks c LEFT JOIN evidence_spans e
                ON e.id = c.primary_evidence_span_id
                WHERE c.owner_kind = s.owner_kind AND c.owner_id = s.owner_id
                  AND (btrim(c.chunk_text) = '' OR e.id IS NULL
                       OR e.owner_kind <> s.owner_kind OR e.owner_id <> s.owner_id
                       OR btrim(e.span_text) = '')))
    """)
    )
    if invalid:
        raise RuntimeError(
            f"0305 cannot convert {invalid} invalid ready content indexes"
        )
    missing = db.scalar(
        sa.text("""
        SELECT count(*) FROM note_blocks n WHERE NOT EXISTS (
            SELECT 1 FROM content_index_states s
            WHERE s.owner_kind = 'note_block' AND s.owner_id = n.id)
    """)
    )
    if missing:
        raise RuntimeError(f"0305 cannot convert {missing} notes without index state")
    op.add_column(
        "content_index_states",
        sa.Column("lexical_revision", sa.BigInteger(), nullable=True),
    )
    db.execute(
        sa.text(
            "UPDATE content_index_states SET lexical_revision = revision WHERE status = 'ready'"
        )
    )
    db.execute(
        sa.text("""
        UPDATE background_jobs j SET payload = j.payload || jsonb_build_object('revision', s.revision)
        FROM content_index_states s
        WHERE j.kind = 'note_reindex_job' AND j.status IN ('pending', 'failed', 'running')
          AND s.owner_kind = 'note_block' AND j.payload->>'note_block_id' = s.owner_id::text
          AND EXISTS (SELECT 1 FROM note_blocks n WHERE n.id = s.owner_id)
    """)
    )
    db.execute(
        sa.text("""
        UPDATE background_jobs j SET status = 'succeeded', result = '{"status":"superseded"}',
            finished_at = now(), updated_at = now(), execution_id = NULL,
            claimed_by = NULL, lease_expires_at = NULL
        WHERE j.kind = 'note_reindex_job' AND j.status IN ('pending', 'failed', 'running')
          AND NOT EXISTS (SELECT 1 FROM note_blocks n
                          WHERE n.id::text = j.payload->>'note_block_id')
    """)
    )


def downgrade() -> None:
    raise NotImplementedError("0305 is irreversible; restore the pre-release backup")
