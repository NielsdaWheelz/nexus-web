"""Drop the unread view-state payload.

Revision ID: 0301
Revises: 0300

``resource_view_states.state`` is written ``{}`` and never read: a view state is one
link's display rank (``order_key``) and, at a conversation, its admission rank
(``context_order_key``, 0297) at one endpoint; folds live in pane-visit data. The column
and its ``ck_resource_view_states_state_object`` check go.

Data effects: every ``resource_view_states`` row loses an always-empty column; no row
is added, removed or changed otherwise. Refuses, writing nothing, when any row carries a
non-empty payload. Stop writers before applying this hard cutover.
"""

import sqlalchemy as sa
from alembic import op

revision = "0301"
down_revision = "0300"
branch_labels = None
depends_on = None


def upgrade() -> None:
    payloads = op.get_bind().scalar(
        sa.text("SELECT count(*) FROM resource_view_states WHERE state <> '{}'::jsonb")
    )
    if payloads:
        raise RuntimeError(
            f"0301 refused: {payloads} resource_view_states rows carry a non-empty state"
        )
    op.drop_column("resource_view_states", "state")


def downgrade() -> None:
    raise NotImplementedError("0301 is irreversible; restore the verified pre-release backup")
