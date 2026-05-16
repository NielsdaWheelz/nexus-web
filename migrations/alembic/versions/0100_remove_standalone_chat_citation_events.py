"""Remove standalone chat-run citation replay events.

Revision ID: 0100
Revises: 0099
Create Date: 2026-05-16 00:00:00.000000
"""

from alembic import op

revision = "0100"
down_revision = "0099"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DELETE FROM chat_run_events WHERE event_type = 'citation'")
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
            'claim',
            'claim_evidence',
            'delta',
            'done'
        )
        """,
    )


def downgrade() -> None:
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
