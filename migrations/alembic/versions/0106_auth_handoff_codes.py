"""Add single-use auth handoff codes for native sign-in.

Revision ID: 0106
Revises: 0105
Create Date: 2026-05-19
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0106"
down_revision: str | None = "0105"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "auth_handoff_codes",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("code_hash", sa.Text(), nullable=False),
        sa.Column("challenge", sa.Text(), nullable=False),
        sa.Column("access_token", sa.Text(), nullable=False),
        sa.Column("refresh_token", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("expires_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.CheckConstraint("char_length(code_hash) = 64", name="ck_auth_handoff_codes_code_hash_len"),
        sa.CheckConstraint("char_length(challenge) = 64", name="ck_auth_handoff_codes_challenge_len"),
        sa.CheckConstraint("expires_at > created_at", name="ck_auth_handoff_codes_expires_after_created"),
        sa.UniqueConstraint("code_hash", name="uix_auth_handoff_codes_code_hash"),
    )
    op.create_index(
        "idx_auth_handoff_codes_expires_at",
        "auth_handoff_codes",
        ["expires_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_auth_handoff_codes_expires_at", table_name="auth_handoff_codes")
    op.drop_table("auth_handoff_codes")
