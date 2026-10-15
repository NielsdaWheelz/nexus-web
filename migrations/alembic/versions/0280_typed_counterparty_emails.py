"""Invitations and person grants keep the email their creator typed.

Revision ID: 0280
Revises: 0279

An invitation or a person grant shows its creator the other person's email only when the
creator typed it (people search found the account by that exact email) or, for an
invitation, once the invitee is a member; otherwise their display name. Adds one nullable
column each: ``library_invitations.invitee_email`` and ``resource_grants.grantee_email``.

Data effects: every existing row gets NULL (what was typed was never stored), so existing
invitations and person grants show the invitee's or grantee's display name, or "Unknown
person" when they have none. Nothing is refused. Downgrade drops both columns.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0280"
down_revision: str | Sequence[str] | None = "0279"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("library_invitations", sa.Column("invitee_email", sa.Text(), nullable=True))
    op.add_column("resource_grants", sa.Column("grantee_email", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("resource_grants", "grantee_email")
    op.drop_column("library_invitations", "invitee_email")
