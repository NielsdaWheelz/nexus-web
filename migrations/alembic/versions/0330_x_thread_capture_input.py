"""Normalize author-thread input; preserve existing captures, posts and exact-save receipts.

Known historical URL, backfill, empty and supersession-parent inputs become explicit
null capture input, preserving the actual parent. Authoritative attempt columns,
captures, posts and exact-save receipts do not change. Retired URL/type markers and
obsolete destination lists leave the live payload; retain their exact pre-migration
values in the private release archive. Validate every candidate before any update.
No post is converted into a thread. Unknown or inconsistent history aborts.
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

_HISTORICAL_PROCESSING_STATUSES = {
    "pending",
    "extracting",
    "ready_for_reading",
    "embedding",
    "ready",
    "failed",
}


def upgrade() -> None:
    db = op.get_bind()
    rows = db.execute(
        sa.text(
            "SELECT id, source_payload, requested_url, provider, provider_target_ref "
            "FROM media_source_attempts WHERE source_type='x_author_thread'"
        )
    ).mappings()
    converted: list[tuple[UUID, str | None]] = []
    for row in rows:
        payload = row["source_payload"]
        if not isinstance(payload, dict):
            raise RuntimeError(f"0330 invalid thread input on attempt {row['id']}")
        parent = None
        keys = set(payload)
        if not keys:
            pass
        elif keys == {"parent_source_attempt_id"}:
            value = payload["parent_source_attempt_id"]
            if not isinstance(value, str):
                raise RuntimeError(f"0330 invalid thread parent on attempt {row['id']}")
            try:
                parent = str(UUID(value))
            except ValueError as exc:
                raise RuntimeError(
                    f"0330 invalid thread parent on attempt {row['id']}"
                ) from exc
        elif keys == {"url", "kind", "post_id", "library_ids"}:
            # e5428eb4f URL admission copied its accepted URL, kind and destinations.
            if (
                not isinstance(payload["url"], str)
                or not payload["url"]
                or payload["url"] != row["requested_url"]
                or payload["kind"] != "web_article"
                or not isinstance(payload["library_ids"], list)
            ):
                raise RuntimeError(
                    f"0330 invalid historical thread URL on attempt {row['id']}"
                )
            for library_id in payload["library_ids"]:
                if not isinstance(library_id, str):
                    raise RuntimeError(
                        f"0330 invalid historical thread destination on attempt {row['id']}"
                    )
                try:
                    UUID(library_id)
                except ValueError as exc:
                    raise RuntimeError(
                        f"0330 invalid historical thread destination on attempt {row['id']}"
                    ) from exc
        elif keys == {"backfilled", "media_kind", "media_status", "post_id"}:
            # 0133 recorded the source state; 0136 added its already retained target.
            if (
                payload["backfilled"] is not True
                or payload["media_kind"] != "web_article"
                or not isinstance(payload["media_status"], str)
                or payload["media_status"] not in _HISTORICAL_PROCESSING_STATUSES
            ):
                raise RuntimeError(
                    f"0330 invalid historical thread backfill on attempt {row['id']}"
                )
        else:
            raise RuntimeError(f"0330 unexpected thread input on attempt {row['id']}")
        if "post_id" in payload:
            post_id = payload["post_id"]
            if (
                not isinstance(post_id, str)
                or not post_id.isascii()
                or not post_id.isdecimal()
                or post_id != row["provider_target_ref"]
                or row["provider"] != "x"
            ):
                raise RuntimeError(
                    f"0330 inconsistent historical thread target on attempt {row['id']}"
                )
        converted.append((row["id"], parent))
    for attempt_id, parent in converted:
        db.execute(
            sa.text(
                "UPDATE media_source_attempts SET source_payload=CAST(:payload AS jsonb) "
                "WHERE id=:id RETURNING id"
            ),
            {
                "id": attempt_id,
                "payload": json.dumps(
                    {
                        "capture_input": None,
                        "parent_source_attempt_id": parent,
                    }
                ),
            },
        ).scalar_one()


def downgrade() -> None:
    raise RuntimeError(
        "x thread capture-input receipts cannot be converted to URL-only input"
    )
