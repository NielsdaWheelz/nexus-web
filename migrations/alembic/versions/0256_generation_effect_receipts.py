"""Keep completed assistant-write inspection and undo independent of LLM history.

Revision ID: 0256
Revises: 0255

0246 preserves effects before reset on the fresh chain. This forward migration
also handles databases that already applied the original 0246, and backfills
completed post-reset writes without changing generation terminal authority.
"""

from collections.abc import Sequence

from alembic import op

from nexus.db.generation_effect_receipts_migration import (
    preserve_generation_effect_receipts,
)
from nexus.model_cutover_archive import create_model_cutover_archive_table

revision: str = "0256"
down_revision: str | Sequence[str] | None = "0255"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    create_model_cutover_archive_table(connection)
    preserve_generation_effect_receipts(connection, source="After0255")


def downgrade() -> None:
    raise NotImplementedError(
        "restore the reviewed backup to undo effect receipt cutover"
    )
