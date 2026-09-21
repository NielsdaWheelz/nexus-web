"""Durable final sweep for in-process storage-object writes.

A write reserves the one nonterminal cleanup job for its ``Media | UploadSession``
owner and ``storagePath`` before the bounded external call and marks it ``Retained``
once the committed owner is visible; otherwise the future-dated ``Armed`` deadline
fires and this handler retains, reschedules, or deletes the orphan. At-most-one is
enforced by the owner row lock plus a nonterminal payload-containment lookup, not by
a ``dedupe_key`` (permanent, and unusable after a terminal transition).
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.session import get_session_factory, transaction
from nexus.errors import ApiErrorCode, ConflictError, NotFoundError
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    RescheduleRequested,
    ScheduleAt,
    enqueue_job,
    find_nonterminal_jobs_for_payload,
    get_job,
    update_running_job_payload,
    update_unclaimed_job,
)
from nexus.logging import get_logger
from nexus.services.source_attempt_artifacts import source_attempt_storage_paths
from nexus.storage.client import StorageClient, get_storage_client

logger = get_logger(__name__)

STORAGE_OBJECT_CLEANUP_JOB_KIND = "storage_object_cleanup"

_ARMED = "Armed"
_RETAINED = "Retained"
_DELETE_REQUIRED = "DeleteRequired"
_DELETED = "Deleted"
_TERMINAL_CHECKPOINTS = frozenset({_RETAINED, _DELETED})
_MEDIA_OWNER = "Media"
_UPLOAD_SESSION_OWNER = "UploadSession"


class StoragePathCleanupInFlight(Exception):
    """The single cleanup reservation for a path is claimed, running, or deleting.

    Deliberately not an ``ApiError``: a ``Media`` write maps it to
    ``E_MEDIA_DELETING``, while the upload owner reads it as the durable cleanup
    intent its delete route requires.
    """


def now_utc(db: Session) -> datetime:
    return db.execute(text("SELECT now()")).scalar_one()


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat()


def parse_iso(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def _media_id_from_storage_path(storage_path: str) -> UUID | None:
    parts = storage_path.split("/")
    if len(parts) < 2 or parts[0] != "media":
        return None
    try:
        return UUID(parts[1])
    except ValueError:
        return None


def path_has_live_db_owner(db: Session, storage_path: str) -> bool:
    """Whether a committed DB row still owns ``storage_path``.

    The ownership surfaces are exactly those the media hard-delete enumerates:
    ``media_file``, ``epub_resources``, and source-attempt artifact paths.
    """
    owned = db.execute(
        text("""
            SELECT 1 FROM media_file WHERE storage_path = :p
            UNION ALL
            SELECT 1 FROM epub_resources WHERE storage_path = :p
            LIMIT 1
        """),
        {"p": storage_path},
    ).first()
    if owned:
        return True
    media_id = _media_id_from_storage_path(storage_path)
    if media_id is None:
        return False
    return any(
        storage_path in source_attempt_storage_paths(source_payload)
        for (source_payload,) in db.execute(
            text("SELECT source_payload FROM media_source_attempts WHERE media_id = :m"),
            {"m": media_id},
        ).fetchall()
    )


def _armed_writers_for_path(db: Session, storage_path: str) -> list[JobRow]:
    return find_nonterminal_jobs_for_payload(
        db,
        kind=STORAGE_OBJECT_CLEANUP_JOB_KIND,
        expected_payload_match={"storagePath": storage_path},
    )


def _lock_owner(db: Session, owner_kind: str, owner_id: UUID) -> tuple[bool, bool]:
    """Lock the owner row. Returns (owner row exists, live teardown intent exists)."""
    owner = db.execute(
        text(
            "SELECT 1 FROM media WHERE id = :owner_id FOR UPDATE"
            if owner_kind == _MEDIA_OWNER
            else "SELECT 1 FROM media_upload_sessions WHERE id = :owner_id FOR UPDATE"
        ),
        {"owner_id": owner_id},
    ).first()
    if owner_kind != _MEDIA_OWNER:
        return owner is not None, False
    intent = db.execute(
        text("SELECT 1 FROM media_teardown_intents WHERE media_id = :owner_id"),
        {"owner_id": owner_id},
    ).first()
    return owner is not None, intent is not None


def _owner_match(owner_kind: str, owner_id: UUID) -> dict[str, str]:
    id_key = "mediaId" if owner_kind == _MEDIA_OWNER else "uploadSessionId"
    return {"ownerKind": owner_kind, id_key: str(owner_id)}


def _reserve(
    db: Session,
    *,
    owner_kind: str,
    owner_id: UUID,
    storage_path: str,
    retain_until: datetime | None,
) -> None:
    """Install or CAS-renew the one Armed reservation for (owner, path).

    ``writeMayLandUntil`` is ``now + storage_object_cleanup_write_window_seconds``
    — wider than every configured writer deadline, so a delayed write still lands
    inside it. Upload-session bytes additionally carry an exact ``retainUntil``.
    """
    owner_present, intent_present = _lock_owner(db, owner_kind, owner_id)
    if not owner_present:
        raise NotFoundError(
            ApiErrorCode.E_MEDIA_NOT_FOUND
            if owner_kind == _MEDIA_OWNER
            else ApiErrorCode.E_UPLOAD_SESSION_NOT_FOUND,
            "Media not found" if owner_kind == _MEDIA_OWNER else "Upload session not found",
        )
    if intent_present:
        raise ConflictError(ApiErrorCode.E_MEDIA_DELETING, "Media is being deleted")
    if owner_kind == _UPLOAD_SESSION_OWNER and retain_until is None:
        raise ValueError("UploadSession storage reservations require retain_until")

    window = int(get_settings().storage_object_cleanup_write_window_seconds)
    write_may_land_until = now_utc(db) + timedelta(seconds=window)
    match = {**_owner_match(owner_kind, owner_id), "storagePath": storage_path}
    payload: dict[str, Any] = {
        **match,
        "writeMayLandUntil": iso(write_may_land_until),
        "checkpoint": {"kind": _ARMED},
    }
    available_at = write_may_land_until
    if retain_until is not None:
        payload["retainUntil"] = iso(retain_until)
        available_at = max(retain_until, write_may_land_until)

    existing = find_nonterminal_jobs_for_payload(
        db, kind=STORAGE_OBJECT_CLEANUP_JOB_KIND, expected_payload_match=match
    )
    if not existing:
        enqueue_job(
            db,
            kind=STORAGE_OBJECT_CLEANUP_JOB_KIND,
            payload=payload,
            available_at=available_at,
            max_attempts=5,
        )
        return
    renewed = update_unclaimed_job(
        db,
        job_id=existing[0].id,
        kind=STORAGE_OBJECT_CLEANUP_JOB_KIND,
        expected_payload_match=match,
        payload=payload,
        available_at=available_at,
    )
    if not renewed:
        # Claimed, running, or already holding the exclusive delete hold: the
        # path is mid-cleanup. Report it; the owner decides what it means.
        raise StoragePathCleanupInFlight(storage_path)


def reserve_storage_object_write(db: Session, *, media_id: UUID, storage_path: str) -> None:
    """Reserve a durable final sweep owned by published Media support state."""
    with transaction(db):
        try:
            _reserve(
                db,
                owner_kind=_MEDIA_OWNER,
                owner_id=media_id,
                storage_path=storage_path,
                retain_until=None,
            )
        except StoragePathCleanupInFlight as exc:
            raise ConflictError(
                ApiErrorCode.E_MEDIA_DELETING, "Storage path is being cleaned up"
            ) from exc


def reserve_upload_session_storage_object_write_in_current_transaction(
    db: Session, *, upload_session_id: UUID, storage_path: str, retain_until: datetime
) -> None:
    """Reserve staged/candidate cleanup inside the caller's owner transaction."""
    _reserve(
        db,
        owner_kind=_UPLOAD_SESSION_OWNER,
        owner_id=upload_session_id,
        storage_path=storage_path,
        retain_until=retain_until,
    )


def _finalize(
    db: Session,
    *,
    owner_kind: str,
    owner_id: UUID,
    storage_path: str,
    storage_client: StorageClient | None,
) -> None:
    """Recheck after a successful write and mark its reservation Retained.

    Committed path ownership is authoritative even when the reservation was
    already claimed. Only an unowned write is rejected and best-effort deleted.
    """
    match = {**_owner_match(owner_kind, owner_id), "storagePath": storage_path}
    with transaction(db):
        owner_present, intent_present = _lock_owner(db, owner_kind, owner_id)
        owned = path_has_live_db_owner(db, storage_path)
        reservations = find_nonterminal_jobs_for_payload(
            db, kind=STORAGE_OBJECT_CLEANUP_JOB_KIND, expected_payload_match=match
        )
        if owner_present and not intent_present and owned and reservations:
            update_unclaimed_job(
                db,
                job_id=reservations[0].id,
                kind=STORAGE_OBJECT_CLEANUP_JOB_KIND,
                expected_payload_match=match,
                payload={**reservations[0].payload, "checkpoint": {"kind": _RETAINED}},
                available_at=now_utc(db),
            )
    if owned:
        return
    # Rejected write: leave the reservation Armed, best-effort delete the object.
    try:
        (storage_client or get_storage_client()).delete_object(storage_path)
    except Exception as exc:  # noqa: BLE001 - best-effort; the Armed deadline retries.
        logger.warning(
            "storage_object_cleanup_reject_delete_failed storage_path=%s error=%s",
            storage_path,
            exc,
        )


def finalize_storage_object_write(
    db: Session, *, media_id: UUID, storage_path: str, storage_client: StorageClient | None = None
) -> None:
    _finalize(
        db,
        owner_kind=_MEDIA_OWNER,
        owner_id=media_id,
        storage_path=storage_path,
        storage_client=storage_client,
    )


def finalize_upload_session_storage_object_write(
    db: Session,
    *,
    upload_session_id: UUID,
    storage_path: str,
    storage_client: StorageClient | None = None,
) -> None:
    _finalize(
        db,
        owner_kind=_UPLOAD_SESSION_OWNER,
        owner_id=upload_session_id,
        storage_path=storage_path,
        storage_client=storage_client,
    )


def storage_object_cleanup(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | RescheduleRequested | None:
    """Advance one reservation checkpoint: Armed -> Retained | DeleteRequired -> Deleted."""
    storage_path = str(payload["storagePath"])
    owner_kind = str(payload["ownerKind"])
    owner_id = UUID(str(payload["mediaId" if owner_kind == _MEDIA_OWNER else "uploadSessionId"]))
    db = get_session_factory()()
    try:
        job = get_job(db, context.job_id)
        if job is None:
            raise RuntimeError("storage_object_cleanup job row vanished after claim")
        kind = str(dict(job.payload.get("checkpoint") or {}).get("kind") or "")

        if kind in _TERMINAL_CHECKPOINTS:
            return {"disposition": kind}
        if kind == _DELETE_REQUIRED:
            return _perform_delete(db, context, storage_path, job.payload)
        return _resolve_armed(db, context, owner_kind, owner_id, storage_path, job.payload)
    finally:
        db.close()


def _resolve_armed(
    db: Session,
    context: JobExecutionContext,
    owner_kind: str,
    owner_id: UUID,
    storage_path: str,
    base_payload: Mapping[str, Any],
) -> Mapping[str, Any] | RescheduleRequested:
    poll_seconds = int(get_settings().storage_object_cleanup_write_window_seconds)
    with transaction(db):
        write_may_land_until = parse_iso(str(base_payload["writeMayLandUntil"]))
        _, intent_present = _lock_owner(db, owner_kind, owner_id)
        retain_until = (
            parse_iso(str(base_payload["retainUntil"]))
            if owner_kind == _UPLOAD_SESSION_OWNER
            else None
        )
        owned = path_has_live_db_owner(db, storage_path)
        # A slow write must never outlive its own sweep.
        delete_not_before = max(
            deadline for deadline in (retain_until, write_may_land_until) if deadline is not None
        )

        if owned and not intent_present:
            decision = _RETAINED
        elif intent_present:
            decision = "reschedule"
        elif now_utc(db) < delete_not_before:
            decision = "retained-window"
        else:
            # Take the exclusive delete hold only when no other nonterminal
            # writer targets this path.
            others = [
                writer
                for writer in _armed_writers_for_path(db, storage_path)
                if writer.id != context.job_id
            ]
            decision = "reschedule" if others else _DELETE_REQUIRED

        if decision in (_RETAINED, _DELETE_REQUIRED) and not update_running_job_payload(
            db,
            job_id=context.job_id,
            worker_id=context.worker_id,
            attempt_no=context.attempt_no,
            payload={**base_payload, "checkpoint": {"kind": decision}},
        ):
            raise RuntimeError("lost lease writing storage_object_cleanup checkpoint")

    if decision == _RETAINED:
        return {"disposition": _RETAINED}
    if decision == _DELETE_REQUIRED:
        return _perform_delete(db, context, storage_path, base_payload)
    if decision == "retained-window":
        return RescheduleRequested(schedule=ScheduleAt(delete_not_before))
    # Live intent: wait for teardown to delete the media or void the intent.
    return RescheduleRequested(schedule=ScheduleAt(now_utc(db) + timedelta(seconds=poll_seconds)))


def _perform_delete(
    db: Session, context: JobExecutionContext, storage_path: str, base_payload: Mapping[str, Any]
) -> Mapping[str, Any]:
    # Outside any transaction, and idempotent, so a crashed retry re-runs harmlessly.
    get_storage_client().delete_object(storage_path)
    with transaction(db):
        if not update_running_job_payload(
            db,
            job_id=context.job_id,
            worker_id=context.worker_id,
            attempt_no=context.attempt_no,
            payload={**base_payload, "checkpoint": {"kind": _DELETED}},
        ):
            raise RuntimeError("lost lease recording storage_object_cleanup Deleted")
    return {"disposition": _DELETED}
