"""Separate podcast observations and archive coverage; retire automatic queueing.

Revision ID: 0306
Revises: 0305

Data effects: retain episode identities, progress, placements, removal markers and
lectern rows and settings versions. Drop auto-queue preferences/watermarks and archive counters. Unknown
recent rejection history stays null. Re-admit old active/limited syncs with exact
job ownership; restart limited archives at their original cutoff. Convert retained
archive job payloads, including terminal jobs. Refuse malformed source rows before
conversion; repair the identified data and retry under stopped writers.
"""

import json
from collections.abc import Sequence
from uuid import UUID

import sqlalchemy as sa
from alembic import op
from uuid6 import uuid7

revision: str = "0306"
down_revision: str | Sequence[str] | None = "0305"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    db = op.get_bind()
    subscriptions = db.execute(sa.text("SELECT * FROM podcast_subscriptions")).mappings().all()
    histories = db.execute(sa.text("SELECT * FROM podcast_subscription_backfills")).mappings().all()
    jobs = (
        db.execute(
            sa.text("""
        SELECT id, payload FROM background_jobs WHERE kind = 'podcast_backfill_subscription'
    """)
        )
        .mappings()
        .all()
    )
    history_subscriptions = {row["subscription_id"] for row in histories}
    for row in subscriptions:
        status = row["sync_status"]
        if (
            status not in {"Pending", "Running", "Complete", "SourceLimited", "Failed"}
            or row["id"] not in history_subscriptions
            or (row["sync_error_code"] is None) != (row["sync_error_message"] is None)
            or (
                status in {"Complete", "SourceLimited", "Failed"}
                and row["sync_completed_at"] is None
            )
            or (status == "Failed" and row["sync_error_code"] is None)
            or (status == "Running" and row["sync_started_at"] is None)
        ):
            raise RuntimeError(f"0306 cannot convert subscription {row['id']}: lifecycle")
    for row in histories:
        terminal_count = sum(
            row[key] is not None for key in ("completed_at", "source_limited_at", "failed_at")
        )
        cursor = row["cursor"]
        cursor_valid = cursor is None or (
            isinstance(cursor, dict)
            and set(cursor) == {"kind", "url", "visited"}
            and cursor["kind"] == "RssPage"
            and isinstance(cursor["url"], str)
            and bool(cursor["url"])
            and isinstance(cursor["visited"], list)
            and all(isinstance(url, str) and bool(url) for url in cursor["visited"])
            and len(cursor["visited"]) == len(set(cursor["visited"]))
            and len(cursor["visited"]) == row["step_no"]
            and cursor["url"] not in cursor["visited"]
        )
        if (
            terminal_count > 1
            or row["step_no"] < 0
            or row["processed_count"] < 0
            or not 0 <= row["added_count"] <= row["processed_count"]
            or not cursor_valid
            or (row["error_code"] is None) != (row["error_detail"] is None)
            or (row["failed_at"] is not None and row["error_code"] is None)
            or (
                (row["completed_at"] is not None or row["source_limited_at"] is not None)
                and cursor is not None
            )
            or (cursor is not None and (row["step_no"] == 0 or row["started_at"] is None))
            or (terminal_count == 0 and row["step_no"] > 0 and cursor is None)
        ):
            raise RuntimeError(f"0306 cannot convert history {row['id']}: lifecycle/cursor")
    converted_payloads = []
    for job in jobs:
        payload = job["payload"]
        if not isinstance(payload, dict) or set(payload) != {"backfillId", "expectedStepNo"}:
            raise RuntimeError(f"0306 cannot convert history job {job['id']}: payload keys")
        try:
            identity = UUID(payload["backfillId"])
        except (TypeError, ValueError, AttributeError) as exc:
            raise RuntimeError(f"0306 cannot convert history job {job['id']}: identity") from exc
        step = payload["expectedStepNo"]
        if type(step) is not int or step < 0:
            raise RuntimeError(f"0306 cannot convert history job {job['id']}: step")
        converted_payloads.append(
            {
                "id": job["id"],
                "payload": json.dumps({"backfill_id": str(identity), "expected_step_no": step}),
            }
        )

    op.add_column(
        "podcast_subscriptions", sa.Column("sync_had_rejected_items", sa.Boolean(), nullable=True)
    )
    op.add_column("podcast_subscriptions", sa.Column("sync_job_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        "fk_podcast_subscriptions_sync_job",
        "podcast_subscriptions",
        "background_jobs",
        ["sync_job_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.add_column(
        "podcast_subscription_backfills",
        sa.Column("had_rejected_items", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    for converted in converted_payloads:
        db.execute(
            sa.text("UPDATE background_jobs SET payload = CAST(:payload AS jsonb) WHERE id = :id"),
            converted,
        )
    for row in subscriptions:
        if row["sync_status"] not in {"Pending", "Running", "SourceLimited"}:
            continue
        job_id = uuid7()
        db.execute(
            sa.text("""
            INSERT INTO background_jobs (id, kind, payload, priority, max_attempts)
            VALUES (:id, 'podcast_sync_subscription_job', CAST(:payload AS jsonb), 100, 3)
        """),
            {"id": job_id, "payload": json.dumps({"subscription_id": str(row["id"])})},
        )
        db.execute(
            sa.text("""
            UPDATE podcast_subscriptions
            SET sync_status = 'Pending', sync_started_at = NULL, sync_job_id = :job,
                updated_at = now()
            WHERE id = :id
        """),
            {"id": row["id"], "job": job_id},
        )
    for row in histories:
        if row["source_limited_at"] is None:
            continue
        history_id = uuid7()
        db.execute(
            sa.text("DELETE FROM podcast_subscription_backfills WHERE id = :id"), {"id": row["id"]}
        )
        db.execute(
            sa.text("""
            INSERT INTO podcast_subscription_backfills
                (id, subscription_id, cutoff_at, step_no, processed_count, added_count,
                 error_code, error_detail)
            VALUES (:id, :subscription, :cutoff, 0, 0, 0,
                    'E_PODCAST_HISTORY_INCOMPLETE', 'Earlier history traversal stopped before coverage was established.')
        """),
            {"id": history_id, "subscription": row["subscription_id"], "cutoff": row["cutoff_at"]},
        )
        db.execute(
            sa.text("""
            INSERT INTO background_jobs (id, kind, payload, max_attempts, dedupe_key)
            VALUES (:id, 'podcast_backfill_subscription', CAST(:payload AS jsonb), 3, :key)
        """),
            {
                "id": uuid7(),
                "payload": json.dumps({"backfill_id": str(history_id), "expected_step_no": 0}),
                "key": f"podcast-backfill:{history_id}:0",
            },
        )
    op.drop_constraint(
        "ck_podcast_subscriptions_auto_queue_watermark", "podcast_subscriptions", type_="check"
    )
    op.drop_column("podcast_subscriptions", "auto_queue")
    op.drop_column("podcast_subscriptions", "auto_queue_watermark_at")
    op.drop_column("podcast_subscription_backfills", "source_limited_at")
    op.drop_column("podcast_subscription_backfills", "processed_count")
    op.drop_column("podcast_subscription_backfills", "added_count")


def downgrade() -> None:
    raise NotImplementedError("0306 is irreversible; restore the pre-release backup")
