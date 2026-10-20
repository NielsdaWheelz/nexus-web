"""Retire discovery suppression preferences.

Revision ID: 0299
Revises: 0298

Data effects: drop connection_discovery_suppressions and permanently discard
every saved preference, including rows with deleted endpoints. No resource,
edge or assistant-write receipt is changed. Cutover creates no edges or scans.
Recovery of committed preferences requires the verified pre-release backup.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0299"
down_revision: str | Sequence[str] | None = "0298"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_table("connection_discovery_suppressions")


def downgrade() -> None:
    raise NotImplementedError("0299 is irreversible; restore the pre-release backup")
