"""SOTA chat streaming hard cutover.

Revision ID: 0167
Revises: 0166
Create Date: 2026-06-18
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0167"
down_revision: str | Sequence[str] | None = "0166"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE messages DROP CONSTRAINT ck_messages_status")
    op.execute("""
        ALTER TABLE messages ADD CONSTRAINT ck_messages_status CHECK (
            status IN ('pending', 'complete', 'error', 'cancelled')
        )
    """)
    op.execute("ALTER TABLE chat_run_events DROP CONSTRAINT ck_chat_run_events_event_type")
    op.execute("""
        DELETE FROM chat_run_events
        WHERE event_type IN ('delta', 'tool_call', 'retrieval_result')
    """)
    op.execute("""
        DELETE FROM chat_run_events
        WHERE event_type = 'context_ref_added'
          AND NOT (
            payload ? 'id'
            AND payload ? 'conversation_id'
            AND payload ? 'resource_ref'
            AND payload ? 'activation'
            AND payload ? 'label'
            AND payload ? 'summary'
            AND payload ? 'missing'
            AND payload ? 'created_at'
            AND payload ? 'citation_edge_id'
          )
    """)
    op.execute("""
        ALTER TABLE chat_run_events ADD CONSTRAINT ck_chat_run_events_event_type CHECK (
            event_type IN (
                'meta', 'assistant_activity', 'assistant_text_delta',
                'tool_call_start', 'tool_call_delta', 'tool_call_done', 'tool_result',
                'citation_index', 'context_ref_added', 'done'
            )
        )
    """)


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0167 is not reversible")
