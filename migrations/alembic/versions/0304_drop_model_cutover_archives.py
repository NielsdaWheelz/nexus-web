"""Drop model_cutover_archives, the 0246 reset's receipt; the cutover code is gone.

Revision ID: 0304
Revises: 0303

Data effect: the table's rows are deleted. Production holds one, the reviewed
2026-10-13 reset (target 3ea1b8e6e, from 0241). The 0277-0292 release backups
held it on 2026-10-20, and the 3ea1b8e6e release backup holds the history it
describes. The rows are printed first, to stdout, which the release log keeps.
Nothing converts, so nothing refuses.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0304"
down_revision: str | Sequence[str] | None = "0303"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    rows = op.get_bind().execute(
        sa.text(
            "SELECT target_source_sha, starting_revision FROM model_cutover_archives"
            " ORDER BY created_at, id"
        )
    )
    census = [f"{target}@{starting}" for target, starting in rows]
    print(f"0304 drops {len(census)} model_cutover_archives rows: {', '.join(census)}")
    op.drop_table("model_cutover_archives")


def downgrade() -> None:
    raise NotImplementedError("0304 is irreversible; restore the pre-release backup")
