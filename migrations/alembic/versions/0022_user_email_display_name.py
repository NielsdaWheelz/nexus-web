"""Add email and display_name to users table.

Revision ID: 0022
Revises: 0021
Create Date: 2026-03-07
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0022"
down_revision: str | None = "0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("email", sa.Text(), nullable=True))
    op.add_column("users", sa.Column("display_name", sa.Text(), nullable=True))
    op.create_unique_constraint("uq_users_email", "users", ["email"])
    op.create_index(
        "ix_users_email_pattern",
        "users",
        ["email"],
        postgresql_ops={"email": "text_pattern_ops"},
    )


def downgrade() -> None:
    op.drop_index("ix_users_email_pattern", table_name="users")
    op.drop_constraint("uq_users_email", "users", type_="unique")
    op.drop_column("users", "display_name")
    op.drop_column("users", "email")
