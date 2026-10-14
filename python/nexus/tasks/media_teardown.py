"""Durable checkpointed media teardown, one transition per invocation:

    Unprepared -> PathsPrepared(storagePaths, cleanupNotBefore)
               -> DeletionCommitted -> delete the paths, after cleanupNotBefore

with terminals ``Voided`` / ``NoOp`` / ``Stale``. Every intent lookup and delete
matches BOTH ``intentId`` and ``mediaId``, so a requeued old job can never act on a
later intent. Checkpoint writes are lease-fenced, and the deletion checkpoint lands
in the same serializable transaction as the deletes.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory, transaction
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    RescheduleRequested,
    get_job,
    update_running_job_payload,
)
from nexus.services import media_deletion
from nexus.storage.client import get_storage_client

_UNPREPARED = "Unprepared"
_PATHS_PREPARED = "PathsPrepared"
_DELETION_COMMITTED = "DeletionCommitted"
_VOIDED = "Voided"
_NOOP = "NoOp"
_STALE = "Stale"
_TERMINAL_CHECKPOINTS = frozenset({_VOIDED, _NOOP, _STALE})


def _now(db: Session) -> datetime:
    return db.execute(text("SELECT now()")).scalar_one()


def _exact_intent_id(db: Session, media_id: UUID) -> UUID | None:
    row = db.execute(
        text("SELECT id FROM media_teardown_intents WHERE media_id = :m"), {"m": media_id}
    ).first()
    return UUID(str(row[0])) if row is not None else None


def media_teardown(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | RescheduleRequested | None:
    """Advance one media-teardown checkpoint transition."""
    media_id = UUID(str(payload["mediaId"]))
    intent_id = UUID(str(payload["intentId"]))
    db = get_session_factory()()
    try:
        job = get_job(db, context.job_id)
        if job is None:
            raise RuntimeError("media_teardown job row vanished after claim")
        checkpoint = dict(job.payload.get("checkpoint") or {})
        kind = str(checkpoint.get("kind") or "")

        if kind in _TERMINAL_CHECKPOINTS:
            return {"disposition": kind}
        if kind == _UNPREPARED:
            return _prepare(db, context, media_id, intent_id, job)
        if kind == _PATHS_PREPARED:
            return _commit_or_void(db, context, media_id, intent_id, checkpoint, job)
        return _cleanup_storage(db, checkpoint)
    finally:
        db.close()


def _write_checkpoint(
    db: Session, context: JobExecutionContext, job: JobRow, checkpoint: Mapping[str, Any]
) -> None:
    """Lease-fenced checkpoint write; a lost lease aborts the whole transition."""
    if not update_running_job_payload(
        db,
        context=context,
        payload={**job.payload, "checkpoint": dict(checkpoint)},
    ):
        raise RuntimeError("lost lease writing media_teardown checkpoint")


def _prepare(
    db: Session, context: JobExecutionContext, media_id: UUID, intent_id: UUID, job: JobRow
) -> Mapping[str, Any] | RescheduleRequested:
    """Unprepared -> PathsPrepared (or terminal), under the media row lock."""
    with transaction(db):
        db.execute(text("SELECT 1 FROM media WHERE id = :m FOR UPDATE"), {"m": media_id})
        current_intent = _exact_intent_id(db, media_id)
        terminal = (
            _NOOP if current_intent is None else (_STALE if current_intent != intent_id else None)
        )
        if terminal is not None:
            _write_checkpoint(db, context, job, {"kind": terminal})
            return {"disposition": terminal}

        storage_paths = media_deletion.enumerate_media_storage_paths(db, media_id)
        # Wait out the object-store clock-skew grace; a write that lands after the
        # deletion leaves an unowned object, which the orphan sweep reclaims.
        grace = int(get_settings().media_teardown_cleanup_grace_seconds)
        cleanup_not_before = _now(db) + timedelta(seconds=grace)
        _write_checkpoint(
            db,
            context,
            job,
            {
                "kind": _PATHS_PREPARED,
                "storagePaths": sorted(storage_paths),
                "cleanupNotBefore": cleanup_not_before.astimezone(UTC).isoformat(),
            },
        )

    # Re-run immediately for the deletion step, on the queue's own clock.
    return RescheduleRequested(_now(db))


def _commit_or_void(
    db: Session,
    context: JobExecutionContext,
    media_id: UUID,
    intent_id: UUID,
    checkpoint: Mapping[str, Any],
    job: JobRow,
) -> Mapping[str, Any] | RescheduleRequested:
    """PathsPrepared -> DeletionCommitted (or Voided / NoOp / Stale), serializable."""

    def op() -> str:
        current_intent = _exact_intent_id(db, media_id)
        if current_intent is None:
            next_kind = _NOOP
        elif current_intent != intent_id:
            next_kind = _STALE
        elif media_deletion.total_reference_count(db, media_id) > 0:
            # A reference reappeared: void only this intent and keep the media.
            db.execute(
                text("DELETE FROM media_teardown_intents WHERE id = :id AND media_id = :m"),
                {"id": intent_id, "m": media_id},
            )
            next_kind = _VOIDED
        elif media_deletion.delete_document_media_if_unreferenced(db, media_id) is None:
            # Only a document kind is ever claimed, so nothing deleted means the
            # claim and the deletion doorway disagree. Fail loudly rather than
            # report Deleted over a media that survives behind a live intent.
            raise RuntimeError("media_teardown commit found media un-deletable")
        else:
            next_kind = _DELETION_COMMITTED

        _write_checkpoint(
            db,
            context,
            job,
            {
                "kind": _DELETION_COMMITTED,
                "storagePaths": list(checkpoint.get("storagePaths") or []),
                "cleanupNotBefore": checkpoint.get("cleanupNotBefore"),
            }
            if next_kind == _DELETION_COMMITTED
            else {"kind": next_kind},
        )
        # retry_serializable requires op to commit: the deletes and the
        # checkpoint land atomically here.
        db.commit()
        return next_kind

    next_kind = retry_serializable(db, "media_teardown_commit", op)
    if next_kind == _DELETION_COMMITTED:
        return RescheduleRequested(datetime.fromisoformat(str(checkpoint["cleanupNotBefore"])))
    return {"disposition": next_kind}


def _cleanup_storage(
    db: Session, checkpoint: Mapping[str, Any]
) -> Mapping[str, Any] | RescheduleRequested:
    """DeletionCommitted: wait out cleanupNotBefore, then delete the persisted paths."""
    cleanup_not_before = datetime.fromisoformat(str(checkpoint["cleanupNotBefore"]))
    if _now(db) < cleanup_not_before:
        return RescheduleRequested(cleanup_not_before)

    client = get_storage_client()
    storage_paths = list(checkpoint.get("storagePaths") or [])
    for storage_path in storage_paths:
        # Idempotent: deleting a missing object succeeds, so retries are harmless.
        client.delete_object(storage_path)
    return {"disposition": "Deleted", "deletedPaths": len(storage_paths)}
