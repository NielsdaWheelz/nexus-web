"""Drop legacy conversation state snapshot memory residue.

Revision ID: 0124
Revises: 0123
Create Date: 2026-05-29
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0124"
down_revision: str | None = "0123"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        "chat_prompt_assemblies_snapshot_id_fkey",
        "chat_prompt_assemblies",
        type_="foreignkey",
    )
    op.drop_constraint(
        "ck_chat_prompt_assemblies_memory_item_ids_array",
        "chat_prompt_assemblies",
        type_="check",
    )
    op.drop_column("chat_prompt_assemblies", "snapshot_id")
    op.drop_column("chat_prompt_assemblies", "included_memory_item_ids")
    op.drop_table("conversation_state_snapshots")


def downgrade() -> None:
    raise NotImplementedError(
        "Hard cutover not reversible: legacy conversation state snapshots are not restored"
    )
