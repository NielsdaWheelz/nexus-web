"""Delete the local vault pane's palette history.

The pane is gone, so a recent or frecent /settings/local-vault entry would only
open the unsupported placeholder. Irreversible: the rows carry nothing else.

Revision ID: 0258
Revises: 0257
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0258"
down_revision: str | Sequence[str] | None = "0257"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("DELETE FROM nexus_usages WHERE target_href ~ '^/settings/local-vault([?#]|$)'")


def downgrade() -> None:
    raise NotImplementedError("0258 is an irreversible local vault history deletion")
