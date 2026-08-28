"""Singleton recurring orphan sweep over canonical media prefixes (spec §3.1).

The second durable backstop (with the one-day R2 lifecycle on ``uploads/``) for
objects whose write completed after a signed-URL expiry or an earlier delete. It
durably pages the ``media/`` prefix via ``list_objects``, ignoring objects modified
within ``storage_orphan_sweep_min_age_seconds`` (a write completing after one pass
gets a fresh modified time and is caught by a later pass), and deletes only paths
with no live DB owner and no Armed cleanup writer.

Recurrence + seeding: this uses the registry's periodic mechanism
(``periodic_interval_seconds``) rather than the spec's self-chained successor. See
the report for the justification — briefly: a permanent ``dedupe_key`` cannot be
reused after a terminal transition, worker-startup seeding lives outside this
unit's ownership and would multiply chains on restart, and the periodic scheduler's
per-slot ``enqueue_unique_job`` dedupe already guarantees an at-most-one run per
slot. ``never_prune_dead=True`` keeps a failed run operator-discoverable for
``requeue_dead_job``; the sweep holds no domain ownership state a fresh scheduled
run would wrongly clear (it re-pages from the start and deletes only provably
unowned objects).
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.session import get_session_factory
from nexus.jobs.queue import JobExecutionContext, RescheduleRequested, ScheduleAt, get_job
from nexus.logging import get_logger
from nexus.storage.client import StorageClientBase, get_storage_client
from nexus.tasks.storage_object_cleanup import (
    _armed_writers_for_path,
    path_has_live_db_owner,
)

logger = get_logger(__name__)

STORAGE_ORPHAN_SWEEP_JOB_KIND = "storage_orphan_sweep"

# Canonical media object prefix (spec §3.1). ``uploads/`` staging is covered by the
# R2 lifecycle rule; final artifacts all live under ``media/``.
_MEDIA_PREFIX = "media/"
_CONTINUATION_TOKEN_KEY = "continuationToken"


def _now_utc(db: Session) -> datetime:
    return db.execute(text("SELECT now()")).scalar_one()


def _read_continuation_token(payload: Mapping[str, Any]) -> str | None:
    if _CONTINUATION_TOKEN_KEY not in payload:
        return None
    value = payload[_CONTINUATION_TOKEN_KEY]
    if not isinstance(value, str) or not value or value != value.strip():
        # justify-defect: the task is the sole writer of this durable checkpoint.
        raise AssertionError("storage orphan sweep has an invalid continuation token")
    return value


def _accept_next_continuation_token(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value or value != value.strip():
        # justify-defect: StorageClientBase returns the owned page representation.
        raise AssertionError("storage orphan sweep received an invalid continuation token")
    return value


def storage_orphan_sweep(
    *,
    context: JobExecutionContext,
    storage_client: StorageClientBase | None = None,
) -> Mapping[str, Any] | RescheduleRequested | None:
    """Sweep one page of the media prefix; reschedule to continue, else complete.

    One ``list_objects`` page per invocation. The continuation token is persisted in
    the payload via the lease-fenced reschedule so a reclaim resumes mid-paging.
    """
    settings = get_settings()
    min_age = timedelta(seconds=int(settings.storage_orphan_sweep_min_age_seconds))
    session_factory = get_session_factory()
    db = session_factory()
    try:
        job = get_job(db, context.job_id)
        if job is None:
            # justify-defect: the worker just claimed this row; it cannot be gone.
            raise RuntimeError("storage_orphan_sweep job row vanished after claim")
        continuation_token = _read_continuation_token(job.payload)

        client = storage_client if storage_client is not None else get_storage_client()
        page = client.list_objects(_MEDIA_PREFIX, continuation_token=continuation_token)
        next_continuation_token = _accept_next_continuation_token(
            page.next_continuation_token
        )

        now = _now_utc(db)
        deleted = 0
        scanned = 0
        for entry in page.objects:
            scanned += 1
            last_modified = entry.last_modified
            if last_modified.tzinfo is None:
                last_modified = last_modified.replace(tzinfo=UTC)
            if now - last_modified < min_age:
                continue
            if path_has_live_db_owner(db, entry.path):
                continue
            if _armed_writers_for_path(db, entry.path):
                continue
            # No live owner and no Armed writer: an orphan. Delete idempotently.
            client.delete_object(entry.path)
            deleted += 1

        if deleted:
            logger.info(
                "storage_orphan_sweep_page",
                deleted=deleted,
                scanned=scanned,
                worker_id=context.worker_id,
            )

        if next_continuation_token is not None:
            return RescheduleRequested(
                schedule=ScheduleAt(datetime.now(UTC)),
                payload={**job.payload, _CONTINUATION_TOKEN_KEY: next_continuation_token},
            )
        return {"disposition": "SweepComplete", "deleted": deleted, "scanned": scanned}
    finally:
        db.close()
