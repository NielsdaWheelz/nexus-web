"""Establish sole chat admission receipt ownership and retire anonymous counting.

Revision ID: 0226
Revises: 0225

Hard cutover: stop writers and workers and apply directly after the 0224 history
reset. A database paused at 0225 must still contain no chat runs: legacy candidate
hashes cannot identify the new source-independent commands and cannot be backfilled.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0226"
down_revision: str | Sequence[str] | None = "0225"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    # Deployment stops admissions and workers before migrating. These locks
    # make the empty-history checks and schema cutover one atomic boundary.
    connection.execute(
        sa.text("LOCK TABLE chat_runs, background_jobs IN EXCLUSIVE MODE")
    )
    if connection.scalar(sa.text("SELECT EXISTS(SELECT 1 FROM chat_runs)")):
        raise RuntimeError(
            "pre-receipt chat history exists; stop writers and audit the hard-cut maintenance gate"
        )
    if connection.scalar(
        sa.text("SELECT EXISTS(SELECT 1 FROM background_jobs WHERE status='running')")
    ):
        raise RuntimeError(
            "stop active worker claims before the chat admission cutover"
        )

    op.create_unique_constraint(
        "uq_chat_runs_assistant_message", "chat_runs", ["assistant_message_id"]
    )
    # ResourceMutation is now the sole admission identity and fingerprint owner.
    op.drop_constraint(
        "uix_chat_runs_owner_idempotency_key", "chat_runs", type_="unique"
    )
    op.drop_constraint(
        "ck_chat_runs_idempotency_key_length", "chat_runs", type_="check"
    )
    op.drop_column("chat_runs", "idempotency_key")
    op.drop_column("chat_runs", "payload_hash")
    op.drop_table("rate_limit_inflight")


def downgrade() -> None:
    raise NotImplementedError("0226 is an irreversible chat admission hard cutover")
