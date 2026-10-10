"""One reindex job for any media; drop the index's write-only and duplicate schema.

Revision ID: 0273
Revises: 0272

1. ``podcast_reindex_semantic_job`` retires: transcripts are indexed by
   ``media_content_reindex_job`` under the media's revision fence. Every row of the
   retired kind is deleted (nonterminal rows would run under no registry entry, dead rows
   are never prunable and no longer repairable). What they were waiting to do survives
   as state: each readable transcript whose semantic index was pending or failed gets a
   ``pending`` content-index state, which the reconciler re-admits (25 per tick). Its
   passages leave search until that reindex publishes.
2. ``media_transcript_states.semantic_status`` duplicated the transcript owner's
   ``content_index_states.status``; it, its CHECK and its two indexes go.
3. ``content_blocks`` has had no reader since 0251 dropped the span block pointers.
4. ``uq_note_reindex_job_inflight`` forbade a waiting note job beside a running one, so
   an edit during a running job was lost. Notes it stranded (``pending`` or ``failed``
   with no live job) get one ``backfill`` job each.

Irreversible: the release's pre-migration backup is the only copy of the dropped data.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0273"
down_revision: str | Sequence[str] | None = "0272"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO content_index_states (owner_kind, owner_id, status, status_reason,
            revision, updated_at, created_at)
        SELECT 'media', mts.media_id, 'pending', 'reconciliation', 0, now(), now()
        FROM media_transcript_states mts
        WHERE mts.semantic_status IN ('pending', 'failed')
          AND mts.transcript_state IN ('ready', 'partial')
          AND mts.transcript_coverage IN ('partial', 'full')
          AND EXISTS (SELECT 1 FROM podcast_transcript_segments s WHERE s.media_id = mts.media_id)
        ON CONFLICT ON CONSTRAINT uq_content_index_states_owner DO UPDATE
        SET status = 'pending', status_reason = 'reconciliation',
            active_embedding_provider = NULL, active_embedding_model = NULL, updated_at = now()
        """
    )
    op.execute("DELETE FROM background_jobs WHERE kind = 'podcast_reindex_semantic_job'")
    op.drop_index("ix_media_transcript_states_semantic_repair", "media_transcript_states")
    op.drop_index("ix_media_transcript_states_semantic_status", "media_transcript_states")
    op.drop_column("media_transcript_states", "semantic_status")
    op.drop_table("content_blocks")
    op.drop_index("uq_note_reindex_job_inflight", "background_jobs")
    op.execute(
        """
        INSERT INTO background_jobs (kind, payload)
        SELECT 'note_reindex_job',
               jsonb_build_object('note_block_id', cis.owner_id::text, 'reason', 'backfill')
        FROM content_index_states cis
        JOIN note_blocks nb ON nb.id = cis.owner_id
        WHERE cis.owner_kind = 'note_block' AND cis.status IN ('pending', 'failed')
          AND NOT EXISTS (
              SELECT 1 FROM background_jobs j
              WHERE j.kind = 'note_reindex_job' AND j.status IN ('pending', 'failed', 'running')
                AND j.payload ->> 'note_block_id' = cis.owner_id::text
          )
        """
    )


def downgrade() -> None:
    raise NotImplementedError("0273 is an irreversible schema deletion")
