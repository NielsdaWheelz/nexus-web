"""Add chat_singletons and drop conversation/evidence scope columns.

Revision ID: 0114
Revises: 0113
Create Date: 2026-05-25
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0114"
down_revision: str | None = "0113"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "chat_singletons",
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        sa.Column(
            "kind",
            sa.Text(),
            nullable=False,
        ),
        sa.Column(
            "target_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        sa.Column(
            "conversation_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["conversation_id"],
            ["conversations.id"],
        ),
        sa.PrimaryKeyConstraint(
            "user_id",
            "kind",
            "target_id",
            name="pk_chat_singletons",
        ),
        sa.UniqueConstraint(
            "conversation_id",
            name="uq_chat_singletons_conversation_id",
        ),
        sa.CheckConstraint(
            "kind IN ('media', 'library')",
            name="ck_chat_singletons_kind",
        ),
    )

    op.drop_index("uix_conversations_owner_scope_media", table_name="conversations")
    op.drop_index("uix_conversations_owner_scope_library", table_name="conversations")
    op.drop_constraint("ck_conversations_scope_targets", "conversations", type_="check")
    op.drop_constraint("ck_conversations_scope_type", "conversations", type_="check")
    op.drop_constraint(
        "fk_conversations_scope_library_id_libraries",
        "conversations",
        type_="foreignkey",
    )
    op.drop_constraint(
        "fk_conversations_scope_media_id_media",
        "conversations",
        type_="foreignkey",
    )
    op.drop_column("conversations", "scope_library_id")
    op.drop_column("conversations", "scope_media_id")
    op.drop_column("conversations", "scope_type")

    op.drop_constraint(
        "ck_assistant_evidence_summaries_scope_type",
        "assistant_message_evidence_summaries",
        type_="check",
    )
    op.drop_column("assistant_message_evidence_summaries", "scope_type")


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0114 is not reversible")
