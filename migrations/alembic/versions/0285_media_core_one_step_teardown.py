"""Media teardown is one step; the media row loses the columns nothing reads.

Revision ID: 0285
Revises: 0284

The ``media_teardown`` job deletes every row in one transaction and then its objects,
with no checkpoints and no grace; its payload is ``{media_id, intent_id}``. Nothing reads
``failure_stage`` or ``failed_at`` any more, ``processing_started_at`` fed only the
retired stale-ingest reconciler, and ``title_tsv`` (with its gin index) has no reader.
Writers are stopped. Nothing refuses.

1. every ``media_teardown`` job (any status) takes ``{media_id, intent_id}`` from its
   ``mediaId`` and ``intentId``, its checkpoint dropped: an unfinished one reruns as one
   step; one that had committed its deletion finds no intent (``Stale``), and the objects
   it had not deleted yet go to the storage orphan sweep (24 hours or more later);
2. ``media.failure_stage`` (and the ``failure_stage_enum`` type), ``failed_at``,
   ``processing_started_at`` (with ``idx_media_stale_extracting_recovery``) and
   ``title_tsv`` (with ``idx_media_title_tsv``) are dropped.

Irreversible: the release's pre-migration backup holds the old columns and payloads.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0285"
down_revision: str | Sequence[str] | None = "0284"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        UPDATE background_jobs
        SET payload = jsonb_build_object(
            'media_id', payload->>'mediaId', 'intent_id', payload->>'intentId')
        WHERE kind = 'media_teardown';

        ALTER TABLE media
            DROP COLUMN failure_stage,
            DROP COLUMN failed_at,
            DROP COLUMN processing_started_at,
            DROP COLUMN title_tsv;
        DROP TYPE failure_stage_enum;
    """)


def downgrade() -> None:
    raise NotImplementedError("0285 is irreversible; restore the pre-release backup")
