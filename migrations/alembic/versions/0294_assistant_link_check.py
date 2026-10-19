"""Drop the stale assistant-link snapshot check.

Revision ID: 0294
Revises: 0293

``ck_resource_edges_assistant_snapshot_excerpt`` (0236, kept by the 0292 baseline)
requires a non-blank ``snapshot.excerpt`` on ``origin = 'assistant'`` edges. Since 0290
the graph writer stores assistant snapshots as ``{evidence: null, rationale}``, so every
model ``edge_create`` violates it. The writer owns conditional snapshot shapes since 0264
(``resource_graph.edges._validate`` requires a non-blank rationale) and discovery edges
carry no such check, so nothing replaces it.

Data effects: none. The census line counts assistant edges for the release log. Fails,
writing nothing, if the check is absent under this name.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0294"
down_revision: str | Sequence[str] | None = "0293"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    assistant = op.get_bind().scalar(
        sa.text("SELECT count(*) FROM resource_edges WHERE origin = 'assistant'")
    )
    print(f"0294 census: {assistant} assistant edges")
    op.drop_constraint(
        "ck_resource_edges_assistant_snapshot_excerpt", "resource_edges", type_="check"
    )


def downgrade() -> None:
    raise NotImplementedError("0294 is irreversible; restore the pre-release backup")
