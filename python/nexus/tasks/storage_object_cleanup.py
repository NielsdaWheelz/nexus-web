"""Durable final-sweep for in-process storage-object writes (spec §3.1).

Every in-process object write reserves an at-most-one-nonterminal
``StorageObjectCleanupJob`` for its closed ``Media | UploadSession`` owner and
``storagePath`` *before* the bounded external call, then marks
it ``Retained`` after a successful write once the committed DB owner is visible.
If the writer crashes between the write and that recheck (or the write lands after
the client timeout), the reservation's future-dated ``Armed`` deadline fires and
the handler decides ``Retained`` (committed owner), reschedules (a live teardown
intent), or takes an exclusive ``DeleteRequired`` hold and deletes the orphaned
object. This closes the write/delete gap without an external call inside a
transaction.

Reservation mechanism: the caller holds the owner row ``FOR UPDATE`` while
reserving, so "at most one nonterminal cleanup job per (owner, storagePath)" is
enforced by that owner lock plus a nonterminal-scoped payload-containment lookup
(:func:`nexus.jobs.queue.find_nonterminal_jobs_for_payload`) — no permanent
``dedupe_key`` (which is global and never re-usable after a terminal transition) and
no schema change. A future-dated, unclaimed ``Armed`` reservation is renewed or
promoted with the pre-claim CAS :func:`nexus.jobs.queue.update_unclaimed_job`.
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

# Checkpoint discriminators.
_ARMED = "Armed"
_RETAINED = "Retained"
_DELETE_REQUIRED = "DeleteRequired"
_DELETED = "Deleted"
_TERMINAL_CHECKPOINTS = frozenset({_RETAINED, _DELETED})
_MEDIA_OWNER = "Media"
_UPLOAD_SESSION_OWNER = "UploadSession"


class StoragePathCleanupInFlight(Exception):
    """The single cleanup reservation for a path is claimed, running, or deleting.

    This is the owner-agnostic condition detected by the reservation CAS; it is
    deliberately not an :class:`~nexus.errors.ApiError`. Each owner maps it in its
    own domain: a ``Media`` write is rejected with ``E_MEDIA_DELETING``, while the
    upload owner reads an in-flight sweep of a staged generation as the durable
    cleanup intent that ``DELETE /media/uploads/{session_handle}`` requires.
    """


def _now_utc(db: Session) -> datetime:
    return db.execute(text("SELECT now()")).scalar_one()


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat()


def _parse_iso(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def _media_id_from_storage_path(storage_path: str) -> UUID | None:
    """Extract the media id embedded in a canonical ``media/{id}/...`` path."""
    parts = storage_path.split("/")
    if len(parts) >= 2 and parts[0] == "media":
        candidate = parts[1]
    else:
        return None
    try:
        return UUID(candidate)
    except ValueError:
        return None


def path_has_live_db_owner(db: Session, storage_path: str) -> bool:
    """Whether a committed DB row still owns ``storage_path``.

    Reuses the ownership surfaces the media hard-delete enumerates: ``media_file`` and
    ``epub_resources`` storage paths, plus source-attempt artifact paths carried in
    ``media_source_attempts.source_payload`` for the media the path belongs to.
    """
    if db.execute(
        text("SELECT 1 FROM media_file WHERE storage_path = :p LIMIT 1"),
        {"p": storage_path},
    ).first():
        return True
    if db.execute(
        text("SELECT 1 FROM epub_resources WHERE storage_path = :p LIMIT 1"),
        {"p": storage_path},
    ).first():
        return True
    media_id = _media_id_from_storage_path(storage_path)
    if media_id is not None:
        for (source_payload,) in db.execute(
            text("SELECT source_payload FROM media_source_attempts WHERE media_id = :m"),
            {"m": media_id},
        ).fetchall():
            if storage_path in source_attempt_storage_paths(source_payload):
                return True
    return False


def _armed_writers_for_path(db: Session, storage_path: str) -> list:
    return find_nonterminal_jobs_for_payload(
        db,
        kind=STORAGE_OBJECT_CLEANUP_JOB_KIND,
        expected_payload_match={"storagePath": storage_path},
    )


# ---------------------------------------------------------------------------
# Write-path reservation (called by in-process object writers, spec §3.1)
# ---------------------------------------------------------------------------


def reserve_storage_object_write(db: Session, *, media_id: UUID, storage_path: str) -> None:
    """Reserve a durable final-sweep owned by published Media support state."""
    with transaction(db):
        try:
            _reserve_storage_object_write_in_current_transaction(
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


def reserve_upload_session_storage_object_write(
    db: Session,
    *,
    upload_session_id: UUID,
    storage_path: str,
    retain_until: datetime,
) -> None:
    """Reserve a final-sweep for staged/candidate bytes under upload intent.

    Raises :class:`StoragePathCleanupInFlight` when this exact path is already
    being swept; the upload owner maps that condition in its own domain.
    """
    with transaction(db):
        reserve_upload_session_storage_object_write_in_current_transaction(
            db,
            upload_session_id=upload_session_id,
            storage_path=storage_path,
            retain_until=retain_until,
        )


def reserve_upload_session_storage_object_write_in_current_transaction(
    db: Session,
    *,
    upload_session_id: UUID,
    storage_path: str,
    retain_until: datetime,
) -> None:
    """Reserve staged/candidate cleanup inside the caller's owner transaction.

    Raises :class:`StoragePathCleanupInFlight` when this exact path is already
    being swept; the upload owner maps that condition in its own domain.
    """
    _reserve_storage_object_write_in_current_transaction(
        db,
        owner_kind=_UPLOAD_SESSION_OWNER,
        owner_id=upload_session_id,
        storage_path=storage_path,
        retain_until=retain_until,
    )


def _reserve_storage_object_write_in_current_transaction(
    db: Session,
    *,
    owner_kind: str,
    owner_id: UUID,
    storage_path: str,
    retain_until: datetime | None,
) -> None:
    """Reserve the one cleanup job for a validated member of the owner union.

    Locks the owner row and installs or renews the single
    nonterminal ``Armed`` cleanup job for ``(owner, path)`` whose
    ``writeMayLandUntil`` is ``now + storage_object_cleanup_write_window_seconds`` (the
    window is wider than every configured server/browser writer deadline, so a delayed
    write can still land inside it). Upload-session bytes may additionally carry an exact
    ``retainUntil``; their cleanup job is not due before that instant.
    """
    settings = get_settings()
    window = int(settings.storage_object_cleanup_write_window_seconds)
    if owner_kind == _MEDIA_OWNER:
        media = db.execute(
            text("SELECT 1 FROM media WHERE id = :owner_id FOR UPDATE"),
            {"owner_id": owner_id},
        ).first()
        if media is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        intent = db.execute(
            text("SELECT 1 FROM media_teardown_intents WHERE media_id = :owner_id"),
            {"owner_id": owner_id},
        ).first()
        if intent is not None:
            raise ConflictError(ApiErrorCode.E_MEDIA_DELETING, "Media is being deleted")
        owner_match = {"ownerKind": _MEDIA_OWNER, "mediaId": str(owner_id)}
    elif owner_kind == _UPLOAD_SESSION_OWNER:
        session = db.execute(
            text("SELECT 1 FROM media_upload_sessions WHERE id = :owner_id FOR UPDATE"),
            {"owner_id": owner_id},
        ).first()
        if session is None:
            raise NotFoundError(
                ApiErrorCode.E_UPLOAD_SESSION_NOT_FOUND,
                "Upload session not found",
            )
        if retain_until is None:
            raise ValueError("UploadSession storage reservations require retain_until")
        owner_match = {
            "ownerKind": _UPLOAD_SESSION_OWNER,
            "uploadSessionId": str(owner_id),
        }
    else:
        raise ValueError(f"Unknown storage cleanup owner {owner_kind!r}")

    write_may_land_until = _now_utc(db) + timedelta(seconds=window)
    match = {**owner_match, "storagePath": storage_path}
    payload = {
        **match,
        "writeMayLandUntil": _iso(write_may_land_until),
        "checkpoint": {"kind": _ARMED},
    }
    if retain_until is not None:
        payload["retainUntil"] = _iso(retain_until)
    available_at = max(
        deadline for deadline in (retain_until, write_may_land_until) if deadline is not None
    )
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
    # Renew the still-Armed, still-unclaimed reservation under the media lock.
    renewed = update_unclaimed_job(
        db,
        job_id=existing[0].id,
        kind=STORAGE_OBJECT_CLEANUP_JOB_KIND,
        expected_payload_match=match,
        payload=payload,
        available_at=available_at,
    )
    if not renewed:
        # Claimed/running or already holding the exclusive delete: the path is
        # mid-cleanup. Report the condition; the owner decides what it means.
        raise StoragePathCleanupInFlight(storage_path)


def finalize_storage_object_write(
    db: Session,
    *,
    media_id: UUID,
    storage_path: str,
    storage_client: StorageClient | None = None,
) -> None:
    """Finalize a write whose reservation owner is Media."""
    _finalize_storage_object_write(
        db,
        owner_match={"ownerKind": _MEDIA_OWNER, "mediaId": str(media_id)},
        storage_path=storage_path,
        storage_client=storage_client,
        media_id=media_id,
    )


def finalize_upload_session_storage_object_write(
    db: Session,
    *,
    upload_session_id: UUID,
    storage_path: str,
    storage_client: StorageClient | None = None,
) -> None:
    """Finalize a candidate write after its published Media owner is visible."""
    _finalize_storage_object_write(
        db,
        owner_match={
            "ownerKind": _UPLOAD_SESSION_OWNER,
            "uploadSessionId": str(upload_session_id),
        },
        storage_path=storage_path,
        storage_client=storage_client,
        media_id=None,
    )


def _finalize_storage_object_write(
    db: Session,
    *,
    owner_match: Mapping[str, str],
    storage_path: str,
    storage_client: StorageClient | None,
    media_id: UUID | None,
) -> None:
    """Recheck after a successful write and mark its reservation Retained.

    Committed path ownership is authoritative even when the reservation was already
    claimed or settled. A still-unclaimed reservation is marked ``Retained`` for prompt
    completion; otherwise its worker independently observes the same owner. Only an
    unowned write is rejected and best-effort deleted.
    """
    match = {**owner_match, "storagePath": storage_path}
    with transaction(db):
        if media_id is not None:
            owner = db.execute(
                text("SELECT 1 FROM media WHERE id = :owner_id FOR UPDATE"),
                {"owner_id": media_id},
            ).first()
            intent = db.execute(
                text("SELECT 1 FROM media_teardown_intents WHERE media_id = :owner_id"),
                {"owner_id": media_id},
            ).first()
        else:
            owner = db.execute(
                text("SELECT 1 FROM media_upload_sessions WHERE id = :owner_id FOR UPDATE"),
                {"owner_id": UUID(owner_match["uploadSessionId"])},
            ).first()
            intent = None
        owned = path_has_live_db_owner(db, storage_path)
        reservations = find_nonterminal_jobs_for_payload(
            db, kind=STORAGE_OBJECT_CLEANUP_JOB_KIND, expected_payload_match=match
        )
        if owner is not None and intent is None and owned and reservations:
            update_unclaimed_job(
                db,
                job_id=reservations[0].id,
                kind=STORAGE_OBJECT_CLEANUP_JOB_KIND,
                expected_payload_match=match,
                payload={
                    **reservations[0].payload,
                    "checkpoint": {"kind": _RETAINED},
                },
                available_at=_now_utc(db),
            )
    if owned:
        return
    # Rejected write: leave Armed, best-effort delete the object now.
    client = storage_client or get_storage_client()
    try:
        client.delete_object(storage_path)
    except Exception as exc:  # noqa: BLE001 - best-effort; the Armed deadline retries.
        logger.warning(
            "storage_object_cleanup_reject_delete_failed storage_path=%s error=%s",
            storage_path,
            exc,
        )


# ---------------------------------------------------------------------------
# Armed-deadline / delete handler (claimed after every retained/write window)
# ---------------------------------------------------------------------------


def storage_object_cleanup(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any] | RescheduleRequested | None:
    """Resolve a reservation whose ``Armed`` deadline fired without a Retained recheck.

    One checkpoint transition per invocation. Committed live ownership records
    ``Retained``; a live teardown intent reschedules until deletion/void; an absent
    media row or an unowned path takes the exclusive ``DeleteRequired`` hold (installed
    only when no other nonterminal writer targets the path) and deletes the object
    outside the transaction, recording ``Deleted``. Only ``Retained``/``Deleted`` are
    prunable success; failure retries and dead rows stay unpruned for repair.
    """
    storage_path = str(payload["storagePath"])
    owner_kind = str(payload.get("ownerKind") or "")
    if owner_kind == _MEDIA_OWNER:
        owner_id = UUID(str(payload["mediaId"]))
    elif owner_kind == _UPLOAD_SESSION_OWNER:
        owner_id = UUID(str(payload["uploadSessionId"]))
    else:
        # justify-defect: 0221 hard-cuts every durable payload to this union.
        raise RuntimeError(f"unknown storage_object_cleanup owner {owner_kind!r}")
    session_factory = get_session_factory()
    db = session_factory()
    try:
        job = get_job(db, context.job_id)
        if job is None:
            # justify-defect: the worker just claimed this row; it cannot be gone.
            raise RuntimeError("storage_object_cleanup job row vanished after claim")
        checkpoint = dict(job.payload.get("checkpoint") or {})
        kind = str(checkpoint.get("kind") or "")

        if kind in _TERMINAL_CHECKPOINTS:
            return {"disposition": kind}

        if kind == _DELETE_REQUIRED:
            return _perform_delete(db, context, storage_path, job.payload)

        if kind == _ARMED:
            return _resolve_armed(
                db,
                context,
                owner_kind,
                owner_id,
                storage_path,
                job.payload,
            )

        # justify-defect: unknown checkpoint is an impossible encoded state.
        raise RuntimeError(f"unknown storage_object_cleanup checkpoint {kind!r}")
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
    settings = get_settings()
    poll_seconds = int(settings.storage_object_cleanup_write_window_seconds)
    decision: str
    with transaction(db):
        raw_write_may_land_until = base_payload.get("writeMayLandUntil")
        if not isinstance(raw_write_may_land_until, str):
            # justify-defect: every reservation writes the delayed-writer fence.
            raise RuntimeError("storage cleanup payload has no writeMayLandUntil")
        write_may_land_until = _parse_iso(raw_write_may_land_until)
        if owner_kind == _MEDIA_OWNER:
            db.execute(
                text("SELECT 1 FROM media WHERE id = :owner_id FOR UPDATE"),
                {"owner_id": owner_id},
            )
            intent = db.execute(
                text("SELECT 1 FROM media_teardown_intents WHERE media_id = :owner_id"),
                {"owner_id": owner_id},
            ).first()
            retain_until = None
        elif owner_kind == _UPLOAD_SESSION_OWNER:
            db.execute(
                text("SELECT 1 FROM media_upload_sessions WHERE id = :owner_id FOR UPDATE"),
                {"owner_id": owner_id},
            )
            intent = None
            raw_retain_until = base_payload.get("retainUntil")
            if not isinstance(raw_retain_until, str):
                # justify-defect: every UploadSession reservation writes its exact
                # retention boundary into the closed durable payload.
                raise RuntimeError("UploadSession cleanup payload has no retainUntil")
            retain_until = _parse_iso(raw_retain_until)
        else:
            raise RuntimeError(f"unknown storage_object_cleanup owner {owner_kind!r}")
        owned = path_has_live_db_owner(db, storage_path)
        now = _now_utc(db)

        delete_not_before = max(
            deadline for deadline in (retain_until, write_may_land_until) if deadline is not None
        )
        if owned and intent is None:
            decision = _RETAINED
        elif intent is not None:
            decision = "reschedule"
        elif now < delete_not_before:
            decision = "retained-window"
        else:
            # Absent media or unowned path: install the exclusive delete hold only when
            # no other nonterminal writer targets the path.
            others = [
                writer
                for writer in _armed_writers_for_path(db, storage_path)
                if writer.id != context.job_id
            ]
            decision = "reschedule" if others else _DELETE_REQUIRED

        next_checkpoint = (
            _RETAINED
            if decision == _RETAINED
            else (_DELETE_REQUIRED if decision == _DELETE_REQUIRED else _ARMED)
        )
        if decision in (_RETAINED, _DELETE_REQUIRED):
            if not update_running_job_payload(
                db,
                job_id=context.job_id,
                worker_id=context.worker_id,
                attempt_no=context.attempt_no,
                payload={**base_payload, "checkpoint": {"kind": next_checkpoint}},
            ):
                # justify-defect: lost the lease mid-checkpoint; abort so a reclaim redoes.
                raise RuntimeError("lost lease writing storage_object_cleanup checkpoint")

    if decision == _RETAINED:
        return {"disposition": _RETAINED}
    if decision == _DELETE_REQUIRED:
        return _perform_delete(db, context, storage_path, base_payload)
    if decision == "retained-window":
        return RescheduleRequested(schedule=ScheduleAt(delete_not_before))
    # Live intent: wait for teardown to delete the media or void the intent.
    return RescheduleRequested(schedule=ScheduleAt(_now_utc(db) + timedelta(seconds=poll_seconds)))


def _perform_delete(
    db: Session,
    context: JobExecutionContext,
    storage_path: str,
    base_payload: Mapping[str, Any],
) -> Mapping[str, Any]:
    # Delete outside any transaction (external side effect); idempotent, so a retry
    # after a crash re-runs harmlessly.
    get_storage_client().delete_object(storage_path)
    with transaction(db):
        if not update_running_job_payload(
            db,
            job_id=context.job_id,
            worker_id=context.worker_id,
            attempt_no=context.attempt_no,
            payload={**base_payload, "checkpoint": {"kind": _DELETED}},
        ):
            # justify-defect: lost the lease after the idempotent delete; a reclaim from
            # DeleteRequired re-deletes (no-op) and records Deleted.
            raise RuntimeError("lost lease recording storage_object_cleanup Deleted")
    return {"disposition": _DELETED}
