"""Add retrieval-plan chat stream event.

Revision ID: 0173
Revises: 0172
Create Date: 2026-06-21
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0173"
down_revision: str | Sequence[str] | None = "0172"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE chat_run_events DROP CONSTRAINT ck_chat_run_events_event_type")
    op.execute("""
        ALTER TABLE chat_run_events ADD CONSTRAINT ck_chat_run_events_event_type CHECK (
            event_type IN (
                'meta', 'assistant_activity', 'assistant_text_delta',
                'tool_call_start', 'tool_call_delta', 'tool_call_done', 'tool_result',
                'retrieval_plan', 'prompt_assembly', 'tool_ledger_snapshot',
                'citation_index', 'context_ref_added', 'done'
            )
        )
    """)


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0173 is not reversible")
