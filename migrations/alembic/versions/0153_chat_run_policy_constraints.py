"""chat run provider policy constraints

Revision ID: 0153
Revises: 0152
Create Date: 2026-06-12

Hard cutover: chat run requests persist only the explicit provider policy
vocabulary accepted by the API.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0153"
down_revision: str | Sequence[str] | None = "0152"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        UPDATE chat_runs
        SET key_mode = CASE key_mode
            WHEN 'byok' THEN 'byok_only'
            WHEN 'platform' THEN 'platform_only'
            ELSE key_mode
        END
        WHERE key_mode IN ('byok', 'platform')
    """)
    op.execute("""
        ALTER TABLE chat_runs
            DROP CONSTRAINT IF EXISTS ck_chat_runs_reasoning,
            DROP CONSTRAINT IF EXISTS ck_chat_runs_key_mode
    """)
    op.execute("""
        ALTER TABLE chat_runs
            ADD CONSTRAINT ck_chat_runs_reasoning
                CHECK (reasoning IN ('default', 'none', 'minimal', 'low', 'medium', 'high', 'max')),
            ADD CONSTRAINT ck_chat_runs_key_mode
                CHECK (key_mode IN ('auto', 'byok_only', 'platform_only'))
    """)


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0153 is not reversible")
