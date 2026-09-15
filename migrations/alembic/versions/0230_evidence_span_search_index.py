"""Index evidence-span full-text retrieval without rewriting source text.

Revision ID: 0230
Revises: 0229
"""

from alembic import op

revision = "0230"
down_revision = "0229"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The index build runs in Postgres, whose memory budget is separate from
    # the migration container. Bound maintenance workspace on the legacy host.
    op.execute("SET LOCAL maintenance_work_mem = '32MB'")
    op.execute(
        "CREATE INDEX ix_evidence_spans_span_text_tsv "
        "ON evidence_spans USING gin (to_tsvector('english', span_text))"
    )


def downgrade() -> None:
    raise RuntimeError("Search index releases move forward only")
