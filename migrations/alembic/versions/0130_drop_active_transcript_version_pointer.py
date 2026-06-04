"""drop media_transcript_states.active_transcript_version_id; resolve active version by is_active

Revision ID: 0130
Revises: 0129
Create Date: 2026-06-03

Key Decision 9 of the podcast-subsystem ownership cutover. The active transcript
version was stored twice: podcast_transcript_versions.is_active (a DB invariant
via the partial unique index uix_podcast_transcript_versions_media_active) and the
denormalized media_transcript_states.active_transcript_version_id pointer that
nothing kept in sync with is_active. Slice 1 switched every reader and writer to
resolve the active version by WHERE is_active; this drops the now-unused pointer
and re-expresses the dependent semantic-repair partial index without it (the
"has an active version" half is enforced by is_active and applied via the
EXISTS join in the reconciler's scan, not by the index predicate).

podcast_transcript_chunks — the other drop in the original slice-9 plan — was
already dropped in 0064; no action here.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0130"
down_revision: str | Sequence[str] | None = "0129"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The partial index predicate references the pointer column, so drop the index
    # first, drop the column (its FK to podcast_transcript_versions drops with it),
    # then recreate the index over the transcript-state columns alone.
    op.drop_index(
        "ix_media_transcript_states_semantic_repair",
        table_name="media_transcript_states",
    )
    op.drop_column("media_transcript_states", "active_transcript_version_id")
    op.create_index(
        "ix_media_transcript_states_semantic_repair",
        "media_transcript_states",
        ["updated_at", "media_id"],
        postgresql_where=sa.text(
            "transcript_state IN ('ready', 'partial') "
            "AND transcript_coverage IN ('partial', 'full') "
            "AND semantic_status IN ('pending', 'failed', 'ready')"
        ),
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0130 is not reversible")
