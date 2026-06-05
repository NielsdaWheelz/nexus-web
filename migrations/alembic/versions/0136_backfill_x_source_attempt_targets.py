"""backfill x source attempt targets

Revision ID: 0136
Revises: 0135
Create Date: 2026-06-05

X source-attempt reuse is keyed by the source attempt's provider target ref.
Some production X media were materialized before that target was recorded on the
backfilled source attempt; normalize those rows to the durable source contract.
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0136"
down_revision: str | Sequence[str] | None = "0135"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE media_source_attempts AS msa
        SET
            provider = 'x',
            provider_target_ref = m.provider_id,
            source_payload = msa.source_payload || jsonb_build_object('post_id', m.provider_id),
            updated_at = now()
        FROM media AS m
        WHERE m.id = msa.media_id
          AND msa.source_type = 'x_author_thread'
          AND m.provider = 'x'
          AND m.provider_id IS NOT NULL
          AND m.provider_id ~ '^[0-9]+$'
          AND (
              msa.provider IS DISTINCT FROM 'x'
              OR msa.provider_target_ref IS DISTINCT FROM m.provider_id
              OR NOT msa.source_payload ? 'post_id'
              OR msa.source_payload->>'post_id' IS DISTINCT FROM m.provider_id
          )
        """
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0136 is not reversible")
