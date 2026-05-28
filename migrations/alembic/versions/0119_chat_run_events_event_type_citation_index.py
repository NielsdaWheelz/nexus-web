"""Add citation_index to chat_run_events.event_type CHECK constraint.

Migration 0117 introduced the citation_index event but never updated the
DB CHECK on chat_run_events.event_type, so the first append of one would
have raised. Add it to the allowed set. Keep the old types (claim,
claim_evidence, source_manifest_delta) so existing historical rows
remain valid; new code only emits the current Literal types.

Revision ID: 0119
Revises: 0118
Create Date: 2026-05-28
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0119"
down_revision: str | None = "0118"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE chat_run_events DROP CONSTRAINT ck_chat_run_events_event_type")
    op.execute(
        """
        ALTER TABLE chat_run_events ADD CONSTRAINT ck_chat_run_events_event_type
        CHECK (event_type = ANY (ARRAY[
            'meta', 'tool_call', 'retrieval_result', 'source_manifest_delta',
            'citation_index', 'claim', 'claim_evidence', 'delta', 'done'
        ]))
        """
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0119 is not reversible")
