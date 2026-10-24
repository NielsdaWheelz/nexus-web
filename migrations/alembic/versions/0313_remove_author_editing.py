"""remove manual author ownership; existing attribution remains unchanged.

revision: 0313; parent: 0312. data effects: drop only the media author-pin flag.
keep every credit, person, alias, external identity, graph link, source/reader
state and job result unchanged. removed pin values cannot be reconstructed;
rollback requires the verified pre-release backup.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0313"
down_revision: str | Sequence[str] | None = "0312"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_column("media", "authors_manually_managed")


def downgrade() -> None:
    raise NotImplementedError("0313 is irreversible; restore the verified pre-release backup")
