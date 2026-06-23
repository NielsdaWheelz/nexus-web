"""Persist started LLM calls before provider streaming.

Revision ID: 0172
Revises: 0171
Create Date: 2026-06-21
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0172"
down_revision: str | Sequence[str] | None = "0171"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE llm_calls
            ADD COLUMN call_status text NULL
    """)
    op.execute("""
        ALTER TABLE llm_calls
            DROP CONSTRAINT IF EXISTS ck_llm_calls_call_status,
            DROP CONSTRAINT IF EXISTS ck_llm_calls_terminal_attempt_status
    """)
    op.execute("""
        UPDATE llm_calls
        SET call_status = CASE
            WHEN error_class IS NULL THEN 'succeeded'
            ELSE 'failed'
        END
        WHERE call_status IS NULL
    """)
    op.execute("""
        UPDATE llm_calls
        SET terminal_attempt_status = 'terminal_error'
        WHERE error_class IS NOT NULL
          AND terminal_attempt_status = 'success'
    """)
    op.execute("""
        ALTER TABLE llm_calls
            ALTER COLUMN call_status SET NOT NULL,
            ALTER COLUMN call_status DROP DEFAULT,
            ALTER COLUMN terminal_attempt_status DROP DEFAULT
    """)


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0172 is not reversible")
