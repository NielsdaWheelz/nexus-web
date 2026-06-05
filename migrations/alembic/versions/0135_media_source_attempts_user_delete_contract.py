"""allow source attempts to outlive users

Revision ID: 0135
Revises: 0134
Create Date: 2026-06-04

Source attempts are durable ingest records. User attribution is nullable, so
deleting a user must clear that attribution rather than block account cleanup or
delete the source-attempt history.
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0135"
down_revision: str | Sequence[str] | None = "0134"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        "media_source_attempts_created_by_user_id_fkey",
        "media_source_attempts",
        type_="foreignkey",
    )
    op.create_foreign_key(
        "media_source_attempts_created_by_user_id_fkey",
        "media_source_attempts",
        "users",
        ["created_by_user_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0135 is not reversible")
