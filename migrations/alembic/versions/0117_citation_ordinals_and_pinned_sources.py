"""Add citation_ordinal to message_retrievals; add conversation_pinned_sources.

PR 3 + PR 5 of the chat tool-calling spec. citation_ordinal lets the assistant
message reference retrievals as `[N]`. conversation_pinned_sources scopes the
chat persistently (media / library / reader_selection) instead of per-turn
attachment.

Revision ID: 0117
Revises: 0116
Create Date: 2026-05-28
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0117"
down_revision: str | None = "0116"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "message_retrievals",
        sa.Column("citation_ordinal", sa.Integer(), nullable=True),
    )
    op.create_check_constraint(
        "ck_message_retrievals_citation_ordinal_positive",
        "message_retrievals",
        "citation_ordinal IS NULL OR citation_ordinal > 0",
    )
    op.create_index(
        "ix_message_retrievals_assistant_citation",
        "message_retrievals",
        ["tool_call_id", "citation_ordinal"],
        postgresql_where=sa.text("citation_ordinal IS NOT NULL"),
    )

    op.create_table(
        "conversation_pinned_sources",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("conversation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("target_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("locator_json", postgresql.JSONB(), nullable=True),
        sa.Column("source_version", sa.Text(), nullable=True),
        sa.Column("exact", sa.Text(), nullable=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["conversation_id"],
            ["conversations.id"],
        ),
        sa.UniqueConstraint(
            "conversation_id",
            "ordinal",
            name="uix_pinned_sources_conversation_ordinal",
        ),
        sa.CheckConstraint(
            "kind IN ('media', 'library', 'reader_selection')",
            name="ck_pinned_sources_kind",
        ),
        sa.CheckConstraint("ordinal >= 0", name="ck_pinned_sources_ordinal_nonneg"),
        sa.CheckConstraint(
            "(kind IN ('media', 'library') AND target_id IS NOT NULL)"
            " OR (kind = 'reader_selection' AND target_id IS NULL"
            " AND locator_json IS NOT NULL AND source_version IS NOT NULL"
            " AND exact IS NOT NULL)",
            name="ck_pinned_sources_kind_fields",
        ),
    )
    op.create_index(
        "ix_pinned_sources_target",
        "conversation_pinned_sources",
        ["kind", "target_id"],
        postgresql_where=sa.text("target_id IS NOT NULL"),
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0117 is not reversible")
