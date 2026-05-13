"""Chat branching hard cutover.

Revision ID: 0080
Revises: 0079
Create Date: 2026-05-06
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0080"
down_revision: str | None = "0079"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_index("uix_one_pending_assistant_per_conversation", table_name="messages")

    op.add_column(
        "messages",
        sa.Column("parent_message_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "messages",
        sa.Column("branch_root_message_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "messages",
        sa.Column(
            "branch_anchor_kind",
            sa.Text(),
            nullable=False,
            server_default="none",
        ),
    )
    op.add_column(
        "messages",
        sa.Column(
            "branch_anchor",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )

    op.execute(
        """
        WITH ordered AS (
            SELECT
                id,
                conversation_id,
                role,
                lag(id) OVER (PARTITION BY conversation_id ORDER BY seq ASC, id ASC) AS previous_id,
                lag(role) OVER (PARTITION BY conversation_id ORDER BY seq ASC, id ASC) AS previous_role
            FROM messages
            WHERE role IN ('user', 'assistant')
        )
        UPDATE messages m
        SET parent_message_id = ordered.previous_id
        FROM ordered
        WHERE m.id = ordered.id
          AND (
            (ordered.role = 'assistant' AND ordered.previous_role = 'user')
            OR (ordered.role = 'user' AND ordered.previous_role = 'assistant')
          )
        """
    )
    op.execute(
        """
        UPDATE messages m
        SET branch_root_message_id = m.parent_message_id
        WHERE m.role = 'user'
          AND m.parent_message_id IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE messages assistant
        SET branch_root_message_id = user_message.branch_root_message_id
        FROM messages user_message
        WHERE assistant.parent_message_id = user_message.id
          AND assistant.role = 'assistant'
          AND user_message.role = 'user'
          AND user_message.branch_root_message_id IS NOT NULL
        """
    )

    op.create_foreign_key(
        "fk_messages_parent_message_id_messages",
        "messages",
        "messages",
        ["parent_message_id"],
        ["id"],
    )
    op.create_foreign_key(
        "fk_messages_branch_root_message_id_messages",
        "messages",
        "messages",
        ["branch_root_message_id"],
        ["id"],
    )
    op.create_check_constraint(
        "ck_messages_branch_anchor_kind",
        "messages",
        "branch_anchor_kind IN ('none', 'assistant_message', 'assistant_selection', 'reader_context')",
    )
    op.create_check_constraint(
        "ck_messages_branch_anchor_object",
        "messages",
        "jsonb_typeof(branch_anchor) = 'object'",
    )
    op.create_check_constraint(
        "ck_messages_parent_role_shape",
        "messages",
        "(role = 'user' AND parent_message_id IS NULL) "
        "OR (role IN ('user', 'assistant') AND parent_message_id IS NOT NULL) "
        "OR (role = 'system')",
    )
    op.create_index("idx_messages_parent_message_id", "messages", ["parent_message_id"])

    op.create_table(
        "conversation_active_paths",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("conversation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("viewer_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("active_leaf_message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"]),
        sa.ForeignKeyConstraint(["viewer_user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["active_leaf_message_id"], ["messages.id"]),
        sa.UniqueConstraint(
            "conversation_id",
            "viewer_user_id",
            name="uix_conversation_active_paths_conversation_viewer",
        ),
    )
    op.create_table(
        "conversation_branches",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("conversation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("branch_user_message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "title IS NULL OR char_length(btrim(title)) BETWEEN 1 AND 120",
            name="ck_conversation_branches_title_length",
        ),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"]),
        sa.ForeignKeyConstraint(["branch_user_message_id"], ["messages.id"]),
        sa.UniqueConstraint(
            "branch_user_message_id",
            name="uix_conversation_branches_user_message",
        ),
    )
    op.create_index(
        "idx_conversation_branches_conversation",
        "conversation_branches",
        ["conversation_id"],
    )

    op.execute(
        """
        INSERT INTO conversation_branches (
            id,
            conversation_id,
            branch_user_message_id,
            created_at,
            updated_at
        )
        SELECT id, conversation_id, id, created_at, updated_at
        FROM messages
        WHERE role = 'user'
          AND parent_message_id IS NOT NULL
        """
    )
    op.execute(
        """
        INSERT INTO conversation_active_paths (
            conversation_id,
            viewer_user_id,
            active_leaf_message_id,
            created_at,
            updated_at
        )
        SELECT DISTINCT ON (c.id)
            c.id,
            c.owner_user_id,
            m.id,
            now(),
            now()
        FROM conversations c
        JOIN messages m ON m.conversation_id = c.id
        ORDER BY c.id, m.seq DESC, m.id DESC
        """
    )


def downgrade() -> None:
    op.drop_index("idx_conversation_branches_conversation", table_name="conversation_branches")
    op.drop_table("conversation_branches")
    op.drop_table("conversation_active_paths")
    op.drop_index("idx_messages_parent_message_id", table_name="messages")
    op.drop_constraint("ck_messages_parent_role_shape", "messages", type_="check")
    op.drop_constraint("ck_messages_branch_anchor_object", "messages", type_="check")
    op.drop_constraint("ck_messages_branch_anchor_kind", "messages", type_="check")
    op.drop_constraint(
        "fk_messages_branch_root_message_id_messages", "messages", type_="foreignkey"
    )
    op.drop_constraint("fk_messages_parent_message_id_messages", "messages", type_="foreignkey")
    op.drop_column("messages", "branch_anchor")
    op.drop_column("messages", "branch_anchor_kind")
    op.drop_column("messages", "branch_root_message_id")
    op.drop_column("messages", "parent_message_id")
    op.create_index(
        "uix_one_pending_assistant_per_conversation",
        "messages",
        ["conversation_id"],
        unique=True,
        postgresql_where=sa.text("role = 'assistant' AND status = 'pending'"),
    )
