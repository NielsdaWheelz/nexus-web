"""Add public web-search retrieval support.

Revision ID: 0060
Revises: 0058
Create Date: 2026-04-24
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0060"
down_revision: str | None = "0058"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        "ck_message_retrievals_result_type",
        "message_retrievals",
        type_="check",
    )
    op.create_check_constraint(
        "ck_message_retrievals_result_type",
        "message_retrievals",
        """
        result_type IN (
            'media',
            'podcast',
            'fragment',
            'annotation',
            'message',
            'transcript_chunk',
            'web_result'
        )
        """,
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_message_retrievals_result_type",
        "message_retrievals",
        type_="check",
    )
    op.create_check_constraint(
        "ck_message_retrievals_result_type",
        "message_retrievals",
        """
        result_type IN (
            'media',
            'podcast',
            'fragment',
            'annotation',
            'message',
            'transcript_chunk'
        )
        """,
    )
