"""The one reclaimer of objects under ``media/`` that no row names.

Writers store bytes first and commit the row that names them after, and nothing reserves
a path, so a failed commit, a superseded candidate, a reading copy or a write after a
teardown leaves an unowned object. One listing page per run, resumed by its continuation
token; an object younger than the min age (24 h) waits, so no write on its way is raced.
Runs every six hours (jobs/registry.py), so an orphan lives at most min age + 6 h.
"""

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


def storage_orphan_sweep(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | RescheduleRequested:
    storage = get_storage_client()
    objects, token = storage.list_objects(
        "media/", continuation_token=payload.get("continuation_token")
    )
    min_age = timedelta(seconds=get_settings().storage_orphan_sweep_min_age_seconds)
    with get_session_factory()() as db:
        cutoff = db.scalar(text("SELECT now()")) - min_age
        old = [path for path, modified in objects if modified < cutoff]
        owned = _owned(db, old)
    orphans = [path for path in old if path not in owned]
    for path in orphans:
        storage.delete_object(path)
    if orphans:
        logger.warning(
            "storage_orphan_sweep_reclaimed_objects",
            deleted=len(orphans),
            scanned=len(objects),
            execution_id=str(context.execution_id),
        )
    if token is not None:
        return RescheduleRequested(datetime.now(UTC), payload={"continuation_token": token})
    return {"disposition": "SweepComplete", "deleted": len(orphans), "scanned": len(objects)}


def _owned(db: Session, paths: list[str]) -> set[str]:
    """The paths a committed row names: exactly what the media hard-delete enumerates
    (``media_file``, ``epub_resources``, an attempt's stored artifact). Two statements per
    page; attempts are read by the media id in the key, since they store under their own."""
    named = db.scalars(
        text("""
            SELECT storage_path FROM media_file WHERE storage_path = ANY(:paths)
            UNION SELECT storage_path FROM epub_resources WHERE storage_path = ANY(:paths)
        """),
        {"paths": paths},
    )
    media_ids = set()
    for path in paths:
        try:
            media_ids.add(UUID(path.split("/")[1]))
        except (IndexError, ValueError):
            continue
    payloads = db.scalars(
        text("SELECT source_payload FROM media_source_attempts WHERE media_id = ANY(:ids)"),
        {"ids": list(media_ids)},
    )
    return {*named, *filter(None, map(stored_artifact_path, payloads))}
