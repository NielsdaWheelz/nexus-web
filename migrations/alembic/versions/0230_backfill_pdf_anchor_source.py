"""Attribute pre-cutover PDF anchors to the binary they were authored against.

Revision ID: 0230
Revises: 0229
Create Date: 2026-09-14
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0230"
down_revision: str | Sequence[str] | None = "0229"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # `media_file` is the only reader-visible PDF binary, and the only writer that
    # ever replaces its bytes publishes a new reader generation in the same
    # transaction. So an anchor was authored against the current bytes exactly
    # when its media has never republished (generation 1) or the anchor is newer
    # than the last republication. Every other anchor keeps NULL: stamping the
    # current digest there would attest a provenance the database cannot prove.
    op.execute(
        """
        UPDATE highlight_pdf_anchors AS hpa
        SET source_sha256 = mf.source_sha256
        FROM media m
        JOIN media_file mf ON mf.media_id = m.id
        JOIN reader_publications rp ON rp.media_id = m.id
        WHERE hpa.media_id = m.id
          AND hpa.source_sha256 IS NULL
          AND m.kind = 'pdf'
          AND mf.source_sha256 ~ '^[0-9a-f]{64}$'
          AND (rp.generation = 1 OR hpa.created_at >= rp.changed_at)
        """
    )


def downgrade() -> None:
    raise NotImplementedError(
        "0230 establishes anchor provenance and has no destructive downgrade"
    )
