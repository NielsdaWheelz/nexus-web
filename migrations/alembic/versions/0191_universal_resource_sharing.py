"""Universal resource sharing active grants.

Revision ID: 0191
Revises: 0190
Create Date: 2026-07-23
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0191"
down_revision: str | Sequence[str] | None = "0190"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "resource_grants",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("subject_scheme", sa.Text(), nullable=False),
        sa.Column("subject_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("grantee_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("share_token", sa.Text(), nullable=True),
        sa.Column("share_token_hash", sa.LargeBinary(), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            name="fk_resource_grants_created_by_user_id_users",
        ),
        sa.ForeignKeyConstraint(
            ["grantee_user_id"],
            ["users.id"],
            name="fk_resource_grants_grantee_user_id_users",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_resource_grants"),
    )
    op.create_index(
        "uq_resource_grants_share_token_hash",
        "resource_grants",
        ["share_token_hash"],
        unique=True,
    )
    op.create_index(
        "ix_resource_grants_subject",
        "resource_grants",
        ["subject_scheme", "subject_id"],
    )
    op.create_index(
        "ix_resource_grants_recipient_subject",
        "resource_grants",
        ["grantee_user_id", "subject_scheme", "subject_id"],
    )
    op.create_index(
        "ix_resource_grants_creator_subject",
        "resource_grants",
        ["created_by_user_id", "subject_scheme", "subject_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_resource_grants_creator_subject", table_name="resource_grants")
    op.drop_index("ix_resource_grants_recipient_subject", table_name="resource_grants")
    op.drop_index("ix_resource_grants_subject", table_name="resource_grants")
    op.drop_index("uq_resource_grants_share_token_hash", table_name="resource_grants")
    op.drop_table("resource_grants")
