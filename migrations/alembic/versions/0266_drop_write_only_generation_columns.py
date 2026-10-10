"""Drop the chat prompt ledger and the tool-position replay pointer.

Revision ID: 0266
Revises: 0265

Every chat run wrote chat_prompt_assemblies' budget and inclusion columns, so
production holds real values. Their only reader was the trust trail's `prompt`
projection (AssistantTrustTrailOut.prompt), which the same commit removes; no
web, android or extension client read it. The chat worker reads only the frozen
generation_intent. Postgres drops the jsonb-type CHECKs and the replay pointer's
self-referencing foreign key with their columns.

No commit since 0255 added replay_of_position_id (c087faba0) has written it, and
production (0241) has not yet created it, so every value it drops is null.

Irreversible: the release's pre-migration backup is the only copy of the dropped data.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0266"
down_revision: str | Sequence[str] | None = "0265"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    for column in (
        "reserved_output_tokens",
        "input_budget_tokens",
        "estimated_input_tokens",
        "included_message_ids",
        "included_context_refs",
        "dropped_items",
    ):
        op.drop_column("chat_prompt_assemblies", column)
    op.drop_column("llm_tool_positions", "replay_of_position_id")


def downgrade() -> None:
    raise NotImplementedError("0266 is an irreversible schema deletion")
