"""Separate work publication from the encountered edition.

Revision ID: 0228
Revises: 0227

Stop admission and old API/workers before applying this forward-only cutover.
Mixed historical dates cannot safely seed either new field.
"""

import sqlalchemy as sa
from alembic import op

revision = "0228"
down_revision = "0227"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    connection.execute(
        sa.text(
            "LOCK TABLE media, media_source_attempts, background_jobs, llm_calls IN EXCLUSIVE MODE"
        )
    )
    pending = connection.execute(
        sa.text(
            """
            SELECT owner, id FROM (
                SELECT 'source_attempt' AS owner, id FROM media_source_attempts
                WHERE status IN ('accepted', 'queued', 'running')
                UNION ALL
                SELECT 'publication_job' AS owner, id FROM background_jobs
                WHERE status IN ('pending', 'running', 'failed')
                  AND kind IN (
                    'ingest_media_source', 'enrich_metadata',
                    'podcast_sync_subscription_job', 'podcast_backfill_subscription'
                  )
                UNION ALL
                SELECT 'uncertain_metadata' AS owner, id FROM background_jobs
                WHERE kind = 'enrich_metadata'
                  AND payload #>> '{coordination,codex/metadata,dispatch_phase}' = 'Uncertain'
                UNION ALL
                SELECT 'metadata_generation' AS owner, id FROM llm_calls
                WHERE owner_kind = 'media_enrichment' AND completed_at IS NULL
            ) AS active ORDER BY owner, id LIMIT 1
            """
        )
    ).first()
    if pending is not None:
        raise RuntimeError(
            "Publication-date cutover requires drained source, podcast, and metadata work; "
            f"resolve {pending.owner} {pending.id} before migrating."
        )

    op.add_column("media", sa.Column("original_published_date", sa.Text(), nullable=True))
    op.add_column("media", sa.Column("edition_published_date", sa.Text(), nullable=True))
    op.add_column("media", sa.Column("edition_isbn", sa.Text(), nullable=True))
    op.drop_column("media", "published_date")
    connection.execute(
        sa.text(
            """
            INSERT INTO viewer_collection_revisions (viewer_id, family, revision)
            SELECT users.id, family.name, 1
            FROM users
            CROSS JOIN (
                VALUES ('AuthorWorks'), ('LibraryEntries'),
                       ('PodcastSubscriptions'), ('PodcastEpisodes')
            ) AS family(name)
            ON CONFLICT (viewer_id, family)
            DO UPDATE SET revision = viewer_collection_revisions.revision + 1
            """
        )
    )


def downgrade() -> None:
    raise RuntimeError("Publication dates are a forward-only contract cutover")
