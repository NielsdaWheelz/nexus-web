"""Add message artifact export ledgers.

Revision ID: 0096
Revises: 0095
Create Date: 2026-05-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0096"
down_revision: str | None = "0095"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "message_artifact_exports",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("conversation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("artifact_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("viewer_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("export_format", sa.Text(), nullable=False),
        sa.Column("artifact_version", sa.Integer(), nullable=False),
        sa.Column("content_sha256", sa.Text(), nullable=False),
        sa.Column("manifest_sha256", sa.Text(), nullable=False),
        sa.Column("metadata", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "export_format IN ('markdown', 'json', 'html', 'pdf', 'csv')",
            name="ck_message_artifact_exports_format",
        ),
        sa.CheckConstraint(
            "artifact_version >= 1",
            name="ck_message_artifact_exports_version_positive",
        ),
        sa.CheckConstraint(
            "char_length(content_sha256) = 64 AND char_length(manifest_sha256) = 64",
            name="ck_message_artifact_exports_sha256_length",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(metadata) = 'object'",
            name="ck_message_artifact_exports_metadata_object",
        ),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"]),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"]),
        sa.ForeignKeyConstraint(["artifact_id"], ["message_artifacts.id"]),
        sa.ForeignKeyConstraint(["viewer_user_id"], ["users.id"]),
    )
    op.create_index(
        "idx_message_artifact_exports_artifact_created",
        "message_artifact_exports",
        ["artifact_id", "created_at", "id"],
    )
    op.create_index(
        "idx_message_artifact_exports_message_created",
        "message_artifact_exports",
        ["message_id", "created_at", "id"],
    )
    op.create_index(
        "idx_message_artifact_exports_viewer_created",
        "message_artifact_exports",
        ["viewer_user_id", "created_at", "id"],
    )


def downgrade() -> None:
    op.drop_index(
        "idx_message_artifact_exports_viewer_created",
        table_name="message_artifact_exports",
    )
    op.drop_index(
        "idx_message_artifact_exports_message_created",
        table_name="message_artifact_exports",
    )
    op.drop_index(
        "idx_message_artifact_exports_artifact_created",
        table_name="message_artifact_exports",
    )
    op.drop_table("message_artifact_exports")
