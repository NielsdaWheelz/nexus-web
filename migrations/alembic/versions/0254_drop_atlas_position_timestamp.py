"""drop the unused atlas position timestamp.

irreversible: the release's pre-migration backup owns the discarded timestamps.

revision id: 0254
revises: 0253
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0254"
down_revision: str | Sequence[str] | None = "0253"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_column("media_atlas_positions", "computed_at")


def downgrade() -> None:
    raise NotImplementedError("0254 is an irreversible atlas timestamp deletion")
