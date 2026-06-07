"""media intelligence units (per-media summary + grounded claims)

Revision ID: 0141
Revises: 0140
Create Date: 2026-06-07

Per-media "units" are a reusable per-document summary plus grounded claims, each
claim bound to an existing evidence span. They are the input substrate for the
library-intelligence reduce, and also feed app_search cards, the reader, and the
library list. ``media_summaries`` is the 1:1 unit head; ``media_claims`` carries
the grounded claims. ``media_claims.evidence_span_id`` is NOT NULL, so an
ungrounded claim is physically unpersistable (grounding-by-construction, AC-2).

This sits after 0140 (the search intent-model cutover's ``message_tool_calls.semantic``
drop) in a single linear Alembic history; the library-intelligence artifact rewrite
follows as 0142.
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0141"
down_revision: str | Sequence[str] | None = "0140"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE media_summaries (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            media_id uuid NOT NULL REFERENCES media(id),
            content_fingerprint text NOT NULL,
            summary_md text NOT NULL,
            model_name text NOT NULL,
            status text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT ck_media_summaries_status CHECK (
                status IN ('building', 'ready', 'failed')
            ),
            CONSTRAINT uq_media_summaries_media UNIQUE (media_id)
        )
    """)
    op.execute("""
        CREATE TABLE media_claims (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            media_id uuid NOT NULL REFERENCES media(id),
            summary_id uuid NOT NULL REFERENCES media_summaries(id),
            claim_text text NOT NULL,
            evidence_span_id uuid NOT NULL REFERENCES evidence_spans(id),
            ordinal integer NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT ck_media_claims_ordinal_non_negative CHECK (ordinal >= 0),
            CONSTRAINT uq_media_claims_summary_ordinal UNIQUE (summary_id, ordinal)
        )
    """)
    # media_id has no covering unique index, so it needs its own. summary_id is
    # already the leading column of uq_media_claims_summary_ordinal, so a separate
    # index on it would be a redundant prefix (database.md: no speculative indexes).
    op.execute("CREATE INDEX ix_media_claims_media ON media_claims (media_id)")


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0141 is not reversible")
