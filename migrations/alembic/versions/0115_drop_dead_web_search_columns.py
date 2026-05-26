"""Drop dead web_search columns from chat_runs and source_manifests.

Revision ID: 0115
Revises: 0114
Create Date: 2026-05-25
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0115"
down_revision: str | None = "0114"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        "ck_source_manifests_web_search_mode",
        "source_manifests",
        type_="check",
    )
    op.drop_column("source_manifests", "web_search_mode")
    op.drop_column("chat_runs", "web_search")


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0115 is not reversible")
