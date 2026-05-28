"""Drop verifier / claim / evidence / citation-audit tables.

Removes the post-hoc verification stack: AI-first chat keeps the
model's answer as-is. Tool-call retrieval audits (message_tool_calls,
message_retrievals, source_manifests) are retained.

Revision ID: 0116
Revises: 0115
Create Date: 2026-05-27
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0116"
down_revision: str | None = "0115"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("DROP TABLE IF EXISTS assistant_message_claim_evidence CASCADE")
    op.execute("DROP TABLE IF EXISTS assistant_message_citation_audits CASCADE")
    op.execute("DROP TABLE IF EXISTS assistant_message_claims CASCADE")
    op.execute("DROP TABLE IF EXISTS assistant_message_evidence_summaries CASCADE")
    op.execute("DROP TABLE IF EXISTS assistant_message_verifier_runs CASCADE")


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0116 is not reversible")
