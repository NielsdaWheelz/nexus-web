"""Dawn write artifact table and owner_kind widen.

Revision ID: 0169
Revises: 0168
Create Date: 2026-07-08
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0171"
down_revision: str | Sequence[str] | None = "0170"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # (A) Dawn write artifact table — one row per (user_id, local_date).
    op.execute("""
        CREATE TABLE dawn_writes (
            id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id      uuid        NOT NULL REFERENCES users(id),
            local_date   date        NOT NULL,
            body_md      text        NOT NULL,
            generated_at timestamptz NOT NULL DEFAULT now(),
            dismissed_at timestamptz,
            CONSTRAINT uq_dawn_writes_user_date UNIQUE (user_id, local_date),
            CONSTRAINT ck_dawn_writes_body_nonempty CHECK (char_length(body_md) >= 1)
        )
    """)
    op.execute("CREATE INDEX ix_dawn_writes_user ON dawn_writes (user_id)")

    # (B) Widen ck_llm_calls_owner_kind to include 'dawn_write'.
    op.execute("ALTER TABLE llm_calls DROP CONSTRAINT ck_llm_calls_owner_kind")
    op.execute("""
        ALTER TABLE llm_calls ADD CONSTRAINT ck_llm_calls_owner_kind CHECK (
            owner_kind IN (
                'chat_run', 'oracle_reading', 'li_revision',
                'media_summary', 'media_enrichment', 'synapse_scan',
                'dawn_write'
            )
        )
    """)


def downgrade() -> None:
    # (B) Restore narrowed constraint (remove dawn_write calls first).
    op.execute("DELETE FROM llm_calls WHERE owner_kind = 'dawn_write'")
    op.execute("ALTER TABLE llm_calls DROP CONSTRAINT ck_llm_calls_owner_kind")
    op.execute("""
        ALTER TABLE llm_calls ADD CONSTRAINT ck_llm_calls_owner_kind CHECK (
            owner_kind IN (
                'chat_run', 'oracle_reading', 'li_revision',
                'media_summary', 'media_enrichment', 'synapse_scan'
            )
        )
    """)

    # (A) Drop dawn_writes table.
    op.execute("DROP TABLE dawn_writes")
