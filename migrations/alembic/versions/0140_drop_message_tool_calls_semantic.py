"""drop message_tool_calls.semantic; hybrid retrieval is now an invariant

Revision ID: 0140
Revises: 0139
Create Date: 2026-06-07

Search intent-model hard cutover (spec §11, S2'/D-14). Hybrid retrieval (FTS ∪ ANN)
is now an invariant of search, not a per-request toggle: the ``semantic`` axis is
removed from the HTTP contract, the service, the chat ``app_search`` tool, and the
started/updated tool-call SSE payload. The column that persisted the toggle on
``message_tool_calls`` is therefore dead state and is dropped.

``requested_types`` is retained (it now records the *resolved internal result types*;
old rows' values remain valid SEARCH_RESULT_TYPES strings). No backfill: chat tool
telemetry is not load-bearing history in this single-user prototype.

Manual re-add (this is a hard cutover with no automated downgrade): re-add the column
with ``ALTER TABLE message_tool_calls ADD COLUMN semantic boolean NOT NULL DEFAULT
false;`` and restore the producer/SSE field if the toggle is ever reintroduced.
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0140"
down_revision: str | Sequence[str] | None = "0139"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_column("message_tool_calls", "semantic")


def downgrade() -> None:
    raise NotImplementedError(
        "0140 is a hard cutover migration and has no downgrade path"
    )
