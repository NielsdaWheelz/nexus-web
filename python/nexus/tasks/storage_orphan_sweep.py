"""Recurring orphan sweep over the canonical ``media/`` object prefix.

Writes happen before the row that names them commits, and nothing reserves a
path: a failed commit, a late upload, a superseded or reused candidate, or a
write that lands after a teardown leaves an object no row owns. This sweep is
their only reclaimer. One ``list_objects`` page per invocation, resumed through
the continuation token; objects younger than the min age (24 h by default) wait
for a later pass, so no write still on its way is ever raced.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.session import get_session_factory
from nexus.jobs.queue import JobExecutionContext, RescheduleRequested
from nexus.logging import get_logger
from nexus.services.source_types import stored_artifact_path
from nexus.storage.client import get_storage_client

logger = get_logger(__name__)

_MEDIA_PREFIX = "media/"
_CONTINUATION_TOKEN_KEY = "continuationToken"


def storage_orphan_sweep(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | RescheduleRequested | None:
    """Sweep one page of the media prefix; reschedule to continue, else complete."""
    min_age = timedelta(seconds=int(get_settings().storage_orphan_sweep_min_age_seconds))
    db = get_session_factory()()
    try:
        client = get_storage_client()
        page = client.list_objects(
            _MEDIA_PREFIX, continuation_token=payload.get(_CONTINUATION_TOKEN_KEY)
        )
        now = db.execute(text("SELECT now()")).scalar_one()
        deleted = 0
        scanned = 0
        for entry in page.objects:
            scanned += 1
            last_modified = entry.last_modified
            if last_modified.tzinfo is None:
                last_modified = last_modified.replace(tzinfo=UTC)
            if now - last_modified < min_age or _owned(db, entry.path):
                continue
            client.delete_object(entry.path)
            deleted += 1

        if deleted:
            logger.warning(
                "storage_orphan_sweep_reclaimed_objects",
                deleted=deleted,
                scanned=scanned,
                execution_id=str(context.execution_id),
            )
        if page.next_continuation_token is not None:
            return RescheduleRequested(
                datetime.now(UTC),
                payload={**payload, _CONTINUATION_TOKEN_KEY: page.next_continuation_token},
            )
        return {"disposition": "SweepComplete", "deleted": deleted, "scanned": scanned}
    finally:
        db.close()


def _owned(db: Session, storage_path: str) -> bool:
    """Whether a committed row names ``storage_path``: exactly the surfaces the media
    hard-delete enumerates (``media_file``, ``epub_resources``, an attempt's stored
    artifact)."""
    if db.execute(
        text("""
            SELECT 1 FROM media_file WHERE storage_path = :p
            UNION ALL
            SELECT 1 FROM epub_resources WHERE storage_path = :p
            LIMIT 1
        """),
        {"p": storage_path},
    ).first():
        return True
    parts = storage_path.split("/")
    try:
        media_id = UUID(parts[1])
    except (IndexError, ValueError):
        return False
    return any(
        storage_path == stored_artifact_path(source_payload)
        for (source_payload,) in db.execute(
            text("SELECT source_payload FROM media_source_attempts WHERE media_id = :m"),
            {"m": media_id},
        )
    )
