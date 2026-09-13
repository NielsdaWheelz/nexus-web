"""Durable checkpointed media teardown (spec §3.1).

The claim (:func:`nexus.services.media_deletion.claim_media_teardown`) atomically
installs a UUIDv7 teardown intent plus one addressable ``media_teardown`` job. This
worker drives the tagged checkpoint payload forward, one transition per invocation:

    Unprepared
      -> PathsPrepared(storagePaths, cleanupNotBefore)   (or NoOp / Stale / defect)
      -> DeletionCommitted(...)                           (or Voided / NoOp / Stale)
      -> delete persisted paths                           (after cleanupNotBefore)

Every intent lookup/delete matches BOTH ``intentId`` and ``mediaId`` so an old job
never acts on a later intent. Checkpoint writes are lease-fenced
(:func:`nexus.jobs.queue.update_running_job_payload`); the atomic-deletion checkpoint
is written inside the same serializable transaction as the child/parent deletes. On
dead-letter, a live media row voids only the exact matching intent; a
``DeletionCommitted`` job whose media is already gone stays unpruned for
``requeue_dead_job`` repair.
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
    find_nonterminal_jobs_for_payload,
    get_job,
    update_running_job_payload,
)
from nexus.logging import get_logger
from nexus.services import media_deletion
from nexus.storage.client import get_storage_client
from nexus.tasks.storage_object_cleanup import STORAGE_OBJECT_CLEANUP_JOB_KIND

logger = get_logger(__name__)

MEDIA_TEARDOWN_JOB_KIND = "media_teardown"

# Checkpoint discriminators.
_UNPREPARED = "Unprepared"
_PATHS_PREPARED = "PathsPrepared"
_DELETION_COMMITTED = "DeletionCommitted"
_VOIDED = "Voided"
_NOOP = "NoOp"
_STALE = "Stale"
_TERMINAL_CHECKPOINTS = frozenset({_VOIDED, _NOOP, _STALE})


def _now_utc(db: Session) -> datetime:
    return db.execute(text("SELECT now()")).scalar_one()


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat()


def _parse_iso(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def _exact_intent_id(db: Session, media_id: UUID) -> UUID | None:
    row = db.execute(
        text("SELECT id FROM media_teardown_intents WHERE media_id = :m"),
        {"m": media_id},
    ).first()
    return UUID(str(row[0])) if row is not None else None


def _media_exists(db: Session, media_id: UUID) -> bool:
    return (
        db.execute(text("SELECT 1 FROM media WHERE id = :m"), {"m": media_id}).first() is not None
    )


def _void_exact_intent(db: Session, *, media_id: UUID, intent_id: UUID) -> None:
    """Delete only the exact matching intent (spec: match BOTH intentId and mediaId)."""
    db.execute(
        text("DELETE FROM media_teardown_intents WHERE id = :id AND media_id = :m"),
        {"id": intent_id, "m": media_id},
    )


def media_teardown(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | RescheduleRequested | None:
    """Advance one media-teardown checkpoint transition."""
    media_id = UUID(str(payload["mediaId"]))
    intent_id = UUID(str(payload["intentId"]))
    session_factory = get_session_factory()
    db = session_factory()
    try:
        job = get_job(db, context.job_id)
        if job is None:
            # justify-defect: the worker just claimed this row; it cannot be gone.
            raise RuntimeError("media_teardown job row vanished after claim")
        checkpoint = dict(job.payload.get("checkpoint") or {})
        kind = str(checkpoint.get("kind") or "")

        if kind in _TERMINAL_CHECKPOINTS:
            return {"disposition": kind}
        if kind == _UNPREPARED:
            return _prepare(db, context, media_id, intent_id, job)
        if kind == _PATHS_PREPARED:
            return _commit_or_void(db, context, media_id, intent_id, checkpoint, job)
        if kind == _DELETION_COMMITTED:
            return _cleanup_storage(db, context, checkpoint)

        # justify-defect: unknown checkpoint is an impossible encoded state.
        raise RuntimeError(f"unknown media_teardown checkpoint {kind!r}")
    finally:
        db.close()


def _prepare(
    db: Session,
    context: JobExecutionContext,
    media_id: UUID,
    intent_id: UUID,
    job: JobRow,
) -> Mapping[str, Any] | RescheduleRequested:
    """Unprepared -> PathsPrepared (or terminal). One short transaction."""
    result_disposition: str | None = None
    with transaction(db):
        media_present = (
            db.execute(
                text("SELECT 1 FROM media WHERE id = :m FOR UPDATE"), {"m": media_id}
            ).first()
            is not None
        )
        if not media_present:
            # justify-defect: media absent at preparation is an impossible state (spec).
            raise RuntimeError("media_teardown prepare found media absent")

        current_intent = _exact_intent_id(db, media_id)
        if current_intent is None:
            next_checkpoint: dict[str, Any] = {"kind": _NOOP}
            result_disposition = _NOOP
        elif current_intent != intent_id:
            next_checkpoint = {"kind": _STALE}
            result_disposition = _STALE
        else:
            storage_paths = list(media_deletion.enumerate_media_storage_paths(db, media_id))
            armed = find_nonterminal_jobs_for_payload(
                db,
                kind=STORAGE_OBJECT_CLEANUP_JOB_KIND,
                expected_payload_match={"mediaId": str(media_id)},
            )
            for writer in armed:
                sp = writer.payload.get("storagePath")
                if isinstance(sp, str) and sp not in storage_paths:
                    storage_paths.append(sp)
            cleanup_not_before = _compute_cleanup_not_before(db, media_id, armed)
            next_checkpoint = {
                "kind": _PATHS_PREPARED,
                "storagePaths": sorted(set(storage_paths)),
                "cleanupNotBefore": _iso(cleanup_not_before),
            }

        if not update_running_job_payload(
            db,
            job_id=context.job_id,
            worker_id=context.worker_id,
            attempt_no=context.attempt_no,
            payload={**job.payload, "checkpoint": next_checkpoint},
        ):
            # justify-defect: lost the lease mid-checkpoint; abort so a reclaim redoes.
            raise RuntimeError("lost lease writing media_teardown PathsPrepared checkpoint")

    if result_disposition is not None:
        return {"disposition": result_disposition}
    # Re-run immediately for the deletion/void step (attempts compensated). Use the DB
    # clock so the reschedule is due against the queue's own now() without clock skew.
    return RescheduleRequested(available_at=_now_utc(db))


def _compute_cleanup_not_before(db: Session, media_id: UUID, armed: list[JobRow]) -> datetime:
    settings = get_settings()
    grace = timedelta(seconds=int(settings.media_teardown_cleanup_grace_seconds))
    now = _now_utc(db)
    # Floor: always wait at least the object-store clock-skew grace.
    candidates = [now + grace]
    for (signed_expiry,) in db.execute(
        text(
            """
            SELECT signed_upload_expires_at
            FROM media_source_attempts
            WHERE media_id = :m AND signed_upload_expires_at IS NOT NULL
            """
        ),
        {"m": media_id},
    ).fetchall():
        candidates.append(signed_expiry + grace)
    for writer in armed:
        wmlu = writer.payload.get("writeMayLandUntil")
        if isinstance(wmlu, str):
            candidates.append(_parse_iso(wmlu))
    return max(candidates)


def _commit_or_void(
    db: Session,
    context: JobExecutionContext,
    media_id: UUID,
    intent_id: UUID,
    checkpoint: Mapping[str, Any],
    job: JobRow,
) -> Mapping[str, Any] | RescheduleRequested:
    """PathsPrepared -> DeletionCommitted (or Voided / NoOp / Stale). Serializable txn."""

    def op() -> str:
        current_intent = _exact_intent_id(db, media_id)
        if current_intent == intent_id:
            references = media_deletion._total_reference_count(db, media_id)
            if references > 0:
                # References present: void only the exact intent, keep the media.
                _void_exact_intent(db, media_id=media_id, intent_id=intent_id)
                next_kind = _VOIDED
            else:
                paths = media_deletion.delete_document_media_if_unreferenced(db, media_id)
                if paths is None:
                    # justify-defect: media absent/non-document before the atomic
                    # deletion checkpoint is an impossible state (spec).
                    raise RuntimeError("media_teardown commit found media un-deletable")
                next_kind = _DELETION_COMMITTED
        elif current_intent is None:
            if not _media_exists(db, media_id):
                # justify-defect: intent absent + media absent pre-deletion is impossible.
                raise RuntimeError("media_teardown commit found intent and media both absent")
            next_kind = _NOOP
        else:
            next_kind = _STALE

        if next_kind == _DELETION_COMMITTED:
            next_checkpoint: dict[str, Any] = {
                "kind": _DELETION_COMMITTED,
                "storagePaths": list(checkpoint.get("storagePaths") or []),
                "cleanupNotBefore": checkpoint.get("cleanupNotBefore"),
            }
        else:
            next_checkpoint = {"kind": next_kind}

        if not update_running_job_payload(
            db,
            job_id=context.job_id,
            worker_id=context.worker_id,
            attempt_no=context.attempt_no,
            payload={**job.payload, "checkpoint": next_checkpoint},
        ):
            # justify-defect: lost the lease; abort so the whole serializable txn rolls
            # back and a reclaim redoes the deletion atomically.
            raise RuntimeError("lost lease writing media_teardown commit checkpoint")
        # retry_serializable requires op to commit; the deletes + checkpoint land
        # atomically here so a reclaim never sees a half-deleted media without its
        # DeletionCommitted checkpoint.
        db.commit()
        return next_kind

    next_kind = retry_serializable(db, "media_teardown_commit", op)

    if next_kind == _DELETION_COMMITTED:
        cleanup_not_before = _parse_iso(str(checkpoint["cleanupNotBefore"]))
        return RescheduleRequested(available_at=cleanup_not_before)
    return {"disposition": next_kind}


def _cleanup_storage(
    db: Session,
    context: JobExecutionContext,
    checkpoint: Mapping[str, Any],
) -> Mapping[str, Any] | RescheduleRequested:
    """DeletionCommitted: wait until cleanupNotBefore, then delete persisted paths."""
    cleanup_not_before = _parse_iso(str(checkpoint["cleanupNotBefore"]))
    now = _now_utc(db)
    if now < cleanup_not_before:
        return RescheduleRequested(available_at=cleanup_not_before)

    client = get_storage_client()
    storage_paths = list(checkpoint.get("storagePaths") or [])
    for storage_path in storage_paths:
        # Idempotent: deleting a missing object succeeds, so a retry re-runs harmlessly.
        client.delete_object(storage_path)
    return {"disposition": "Deleted", "deletedPaths": len(storage_paths)}


def dead_letter_media_teardown(db: Session, job: JobRow) -> None:
    """On dead-letter, void only the exact matching intent when the media row is live.

    Runs inside the worker's dead-letter transaction (no commit here). A
    ``DeletionCommitted`` job whose media is already gone leaves the dead row intact for
    ``requeue_dead_job`` to finish the storage sweep.
    """
    media_id = UUID(str(job.payload["mediaId"]))
    intent_id = UUID(str(job.payload["intentId"]))
    if not _media_exists(db, media_id):
        return
    _void_exact_intent(db, media_id=media_id, intent_id=intent_id)
