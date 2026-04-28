"""Add durable conversation scopes.

Revision ID: 0062
Revises: 0061
Create Date: 2026-04-28
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0062"
down_revision: str | None = "0061"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("scope_type", sa.Text(), server_default="general", nullable=False),
    )
    op.add_column(
        "conversations",
        sa.Column("scope_media_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "conversations",
        sa.Column("scope_library_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_conversations_scope_media_id_media",
        "conversations",
        "media",
        ["scope_media_id"],
        ["id"],
    )
    op.create_foreign_key(
        "fk_conversations_scope_library_id_libraries",
        "conversations",
        "libraries",
        ["scope_library_id"],
        ["id"],
    )
    op.create_check_constraint(
        "ck_conversations_scope_type",
        "conversations",
        "scope_type IN ('general', 'media', 'library')",
    )
    op.create_check_constraint(
        "ck_conversations_scope_targets",
        "conversations",
        """
        (
            scope_type = 'general'
            AND scope_media_id IS NULL
            AND scope_library_id IS NULL
        )
        OR (
            scope_type = 'media'
            AND scope_media_id IS NOT NULL
            AND scope_library_id IS NULL
        )
        OR (
            scope_type = 'library'
            AND scope_media_id IS NULL
            AND scope_library_id IS NOT NULL
        )
        """,
    )
    op.create_index(
        "uix_conversations_owner_scope_media",
        "conversations",
        ["owner_user_id", "scope_media_id"],
        unique=True,
        postgresql_where=sa.text("scope_type = 'media'"),
    )
    op.create_index(
        "uix_conversations_owner_scope_library",
        "conversations",
        ["owner_user_id", "scope_library_id"],
        unique=True,
        postgresql_where=sa.text("scope_type = 'library'"),
    )

    op.add_column(
        "message_retrievals",
        sa.Column("scope", sa.Text(), server_default="all", nullable=False),
    )
    op.create_check_constraint(
        "ck_message_retrievals_scope_length",
        "message_retrievals",
        "char_length(scope) BETWEEN 1 AND 256",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_message_retrievals_scope_length",
        "message_retrievals",
        type_="check",
    )
    op.drop_column("message_retrievals", "scope")

    op.drop_index("uix_conversations_owner_scope_library", table_name="conversations")
    op.drop_index("uix_conversations_owner_scope_media", table_name="conversations")
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
