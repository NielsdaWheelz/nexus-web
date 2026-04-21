"""Preserve the reader locator revision anchor.

Revision ID: 0053
Revises: 0052
Create Date: 2026-04-21

This revision exists so databases previously stamped at 0053 still have a
valid Alembic graph. The actual flat-locator repair lives in 0054.
"""

from collections.abc import Sequence

revision: str = "0053"
down_revision: str | None = "0052"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
