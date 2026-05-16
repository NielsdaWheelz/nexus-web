"""Allow chat-run claim evidence SSE replay events.

Revision ID: 0099
Revises: 0098
Create Date: 2026-05-15 00:00:00.000000
"""

from alembic import op


revision = "0099"
down_revision = "0098"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_chat_run_events_event_type", "chat_run_events", type_="check")
    op.create_check_constraint(
        "ck_chat_run_events_event_type",
        "chat_run_events",
        """
        event_type IN (
            'meta',
            'tool_call',
            'retrieval_result',
            'source_manifest_delta',
            'artifact_delta',
            'citation',
            'claim',
            'claim_evidence',
            'delta',
            'done'
        )
        """,
    )


def downgrade() -> None:
    op.execute("DELETE FROM chat_run_events WHERE event_type = 'claim_evidence'")
    op.drop_constraint("ck_chat_run_events_event_type", "chat_run_events", type_="check")
    op.create_check_constraint(
        "ck_chat_run_events_event_type",
        "chat_run_events",
        """
        event_type IN (
            'meta',
            'tool_call',
            'retrieval_result',
            'source_manifest_delta',
            'artifact_delta',
            'citation',
            'claim',
            'delta',
            'done'
        )
        """,
    )
