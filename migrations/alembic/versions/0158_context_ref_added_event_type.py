"""Rename chat context-ref SSE event type.

Revision ID: 0158
Revises: 0157
Create Date: 2026-06-12
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0158"
down_revision: str | Sequence[str] | None = "0157"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE chat_run_events DROP CONSTRAINT ck_chat_run_events_event_type")
    op.execute("""
        UPDATE chat_run_events
        SET event_type = 'context_ref_added'
        WHERE event_type = 'reference_added'
    """)
    op.execute("""
        ALTER TABLE chat_run_events ADD CONSTRAINT ck_chat_run_events_event_type CHECK (
            event_type IN (
                'meta', 'tool_call', 'retrieval_result',
                'citation_index', 'context_ref_added', 'delta', 'done'
            )
        )
    """)


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0158 is not reversible")
