"""Normalize author-thread input; preserve existing captures, posts and exact-save receipts.

Historical empty and supersession-parent payloads become explicit null capture input.
No post is converted into a thread. Unknown payloads abort rather than discard evidence.
"""

import json
from collections.abc import Sequence
from uuid import UUID

import sqlalchemy as sa
from alembic import op

revision: str = "0330"
down_revision: str | Sequence[str] | None = "0329"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    db = op.get_bind()
    rows = db.execute(
        sa.text(
            "SELECT id, source_payload FROM media_source_attempts WHERE source_type='x_author_thread'"
        )
    ).mappings()
    for row in rows:
        payload = row["source_payload"]
        if payload == {}:
            parent = None
        elif isinstance(payload, dict) and set(payload) == {"parent_source_attempt_id"}:
            value = payload["parent_source_attempt_id"]
            if not isinstance(value, str):
                raise RuntimeError(f"0330 invalid thread parent on attempt {row['id']}")
            try:
                parent = str(UUID(value))
            except ValueError as exc:
                raise RuntimeError(f"0330 invalid thread parent on attempt {row['id']}") from exc
        else:
            raise RuntimeError(f"0330 unexpected thread input on attempt {row['id']}")
        db.execute(
            sa.text(
                "UPDATE media_source_attempts SET source_payload=CAST(:payload AS jsonb) WHERE id=:id"
            ),
            {
                "id": row["id"],
                "payload": json.dumps(
                    {
                        "capture_input": None,
                        "parent_source_attempt_id": parent,
                    }
                ),
            },
        )


def downgrade() -> None:
    raise RuntimeError("x thread capture-input receipts cannot be converted to URL-only input")
