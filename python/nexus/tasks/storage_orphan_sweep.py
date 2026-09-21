"""Recurring orphan sweep over the canonical ``media/`` object prefix.

The backstop for objects whose write completed after a signed-URL expiry or an
earlier delete. One ``list_objects`` page per invocation, resumed through the
continuation token; objects younger than the min age wait for a later pass.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any

from nexus.config import get_settings
from nexus.db.session import get_session_factory
from nexus.jobs.queue import JobExecutionContext, RescheduleRequested, ScheduleAt, get_job
from nexus.logging import get_logger
from nexus.storage.client import get_storage_client
from nexus.tasks.storage_object_cleanup import (
    _armed_writers_for_path,
    now_utc,
    path_has_live_db_owner,
)

logger = get_logger(__name__)

_MEDIA_PREFIX = "media/"
_CONTINUATION_TOKEN_KEY = "continuationToken"


def storage_orphan_sweep(
    *, context: JobExecutionContext
) -> Mapping[str, Any] | RescheduleRequested | None:
    """Sweep one page of the media prefix; reschedule to continue, else complete."""
    min_age = timedelta(seconds=int(get_settings().storage_orphan_sweep_min_age_seconds))
    db = get_session_factory()()
    try:
        job = get_job(db, context.job_id)
        if job is None:
            raise RuntimeError("storage_orphan_sweep job row vanished after claim")
        token = job.payload.get(_CONTINUATION_TOKEN_KEY)

        client = get_storage_client()
        page = client.list_objects(_MEDIA_PREFIX, continuation_token=token)

        now = now_utc(db)
        deleted = 0
        scanned = 0
        for entry in page.objects:
            scanned += 1
            last_modified = entry.last_modified
            if last_modified.tzinfo is None:
                last_modified = last_modified.replace(tzinfo=UTC)
            if now - last_modified < min_age:
                continue
            if path_has_live_db_owner(db, entry.path) or _armed_writers_for_path(db, entry.path):
                continue
            client.delete_object(entry.path)
            deleted += 1

        if deleted:
            logger.warning(
                "storage_orphan_sweep_reclaimed_objects",
                deleted=deleted,
                scanned=scanned,
                worker_id=context.worker_id,
            )
        if page.next_continuation_token is not None:
            return RescheduleRequested(
                schedule=ScheduleAt(datetime.now(UTC)),
                payload={**job.payload, _CONTINUATION_TOKEN_KEY: page.next_continuation_token},
            )
        return {"disposition": "SweepComplete", "deleted": deleted, "scanned": scanned}
    finally:
        db.close()
