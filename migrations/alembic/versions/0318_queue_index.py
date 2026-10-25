"""Remove retained queue provenance without changing playback identities or progress.

Revision ID: 0318
Revises: 0317

Data effects: validate every supported saved browser queue and its surviving
occurrence/cursor invariants, then remove only state.source. Session, queue and
occurrence ids, entry order, cursor and session revisions remain unchanged.
Refuse unsupported or unconvertible state. Writers must be stopped; downgrade
requires the verified pre-release backup and matching binaries.
"""

from collections.abc import Sequence
from uuid import UUID

import sqlalchemy as sa
from alembic import op

revision: str = "0318"
down_revision: str | Sequence[str] | None = "0317"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    for row in connection.execute(sa.text("SELECT id, state FROM playback_sessions")):
        state = row.state
        try:
            if not isinstance(state, dict) or set(state) != {
                "queue_id",
                "entries",
                "current_entry_id",
                "source",
            }:
                raise ValueError("unsupported queue shape")
            UUID(state["queue_id"])
            entries = state["entries"]
            if not isinstance(entries, list) or len(entries) > 10_000:
                raise ValueError("unsupported queue entries")
            ids: set[UUID] = set()
            for entry in entries:
                if not isinstance(entry, dict) or set(entry) != {"id", "media_id"}:
                    raise ValueError("unsupported queue entry")
                entry_id = UUID(entry["id"])
                UUID(entry["media_id"])
                if entry_id in ids:
                    raise ValueError("duplicate occurrence id")
                ids.add(entry_id)
            current = state["current_entry_id"]
            if current is not None and UUID(current) not in ids:
                raise ValueError("current occurrence is absent")
            if state["source"] is not None and not isinstance(state["source"], dict):
                raise ValueError("unsupported source shape")
        except (ValueError, TypeError, AttributeError) as error:
            raise RuntimeError(
                f"playback session {row.id} cannot convert: {error}"
            ) from error
    connection.execute(sa.text("UPDATE playback_sessions SET state = state - 'source'"))


def downgrade() -> None:
    raise RuntimeError(
        "Restore the verified pre-release backup and matching binaries to downgrade"
    )
