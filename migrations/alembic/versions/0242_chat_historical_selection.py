"""Retire current catalog state from persisted chat meta event projections.

Revision ID: 0242
Revises: 0241
Create Date: 2026-09-25
"""

import json
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from nexus.schemas.conversation import ChatRunMetaEventPayload

revision: str = "0242"
down_revision: str | Sequence[str] | None = "0241"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_RETIRED = frozenset(
    {"current_state", "current_state_observed_at", "rerun_eligibility"}
)


def upgrade() -> None:
    connection = op.get_bind()
    rows = connection.execute(
        sa.text(
            "SELECT id, payload FROM chat_run_events WHERE event_type = 'meta' ORDER BY id"
        )
    ).mappings()
    for row in rows:
        payload = row["payload"]
        if not isinstance(payload, dict) or not isinstance(
            payload.get("run_selection"), dict
        ):
            raise ValueError(f"chat meta event {row['id']} lacks run_selection")
        selection = payload["run_selection"]
        migrated = {
            **payload,
            "run_selection": {
                key: value for key, value in selection.items() if key not in _RETIRED
            },
        }
        try:
            ChatRunMetaEventPayload.model_validate_json(json.dumps(migrated))
        except ValueError as error:
            raise ValueError(
                f"chat meta event {row['id']} has invalid dispatch facts"
            ) from error
        if migrated != payload:
            connection.execute(
                sa.text(
                    "UPDATE chat_run_events SET payload = CAST(:payload AS jsonb) WHERE id = :id"
                ),
                {"id": row["id"], "payload": json.dumps(migrated)},
            )


def downgrade() -> None:
    raise NotImplementedError("0242 is an irreversible chat wire cutover")
