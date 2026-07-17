"""Test helpers for driving the durable media-teardown jobs to completion.

The DELETE /media contract now returns ``Deleting`` and installs a checkpointed
``media_teardown`` job (plus, for in-process writes, ``storage_object_cleanup``
reservations). These helpers run a real ``JobWorker`` over those kinds until the
teardown job reaches a terminal status, fast-forwarding the ``DeletionCommitted``
wait on ``cleanupNotBefore`` so tests do not have to sleep through the grace.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.jobs.registry import get_default_registry
from nexus.jobs.worker import JobWorker

SessionFactory = Callable[[], Session]

_TEARDOWN_KINDS = ("media_teardown", "storage_object_cleanup")


def zero_media_teardown_grace(monkeypatch) -> None:
    """Zero the teardown cleanup grace so ``DeletionCommitted`` does not sleep on
    ``cleanupNotBefore`` (the reschedule becomes immediately due)."""
    monkeypatch.setattr(get_settings(), "media_teardown_cleanup_grace_seconds", 0)


def install_fake_storage_for_teardown(monkeypatch, storage) -> None:
    """Point every teardown/sweep task module at the same FakeStorageClient and zero the
    teardown cleanup grace so ``DeletionCommitted`` does not sleep on ``cleanupNotBefore``.
    """
    for module in ("media_teardown", "storage_object_cleanup", "storage_orphan_sweep"):
        monkeypatch.setattr(f"nexus.tasks.{module}.get_storage_client", lambda: storage)
    zero_media_teardown_grace(monkeypatch)


def _fast_forward_deletion_committed(session_factory: SessionFactory, media_id: UUID) -> None:
    """Make any waiting DeletionCommitted teardown job for ``media_id`` due now."""
    past = (datetime.now(UTC) - timedelta(minutes=5)).isoformat()
    with session_factory() as db:
        db.execute(
            text(
                """
                UPDATE background_jobs
                SET available_at = now(),
                    payload = jsonb_set(
                        payload, '{checkpoint,cleanupNotBefore}', to_jsonb(CAST(:past AS text))
                    )
                WHERE kind = 'media_teardown'
                  AND status IN ('pending', 'failed')
                  AND payload->>'mediaId' = :media_id
                  AND payload->'checkpoint'->>'kind' = 'DeletionCommitted'
                """
            ),
            {"past": past, "media_id": str(media_id)},
        )
        db.commit()


def _latest_teardown_status(session_factory: SessionFactory, media_id: UUID) -> str | None:
    with session_factory() as db:
        row = (
            db.execute(
                text(
                    """
                    SELECT status
                    FROM background_jobs
                    WHERE kind = 'media_teardown' AND payload->>'mediaId' = :media_id
                    ORDER BY created_at DESC
                    LIMIT 1
                    """
                ),
                {"media_id": str(media_id)},
            )
            .mappings()
            .first()
        )
    return None if row is None else str(row["status"])


def drive_media_teardown(
    session_factory: SessionFactory,
    media_id: UUID,
    *,
    max_iterations: int = 60,
) -> str:
    """Run the teardown worker until this media's teardown job is terminal.

    Returns the terminal status (``succeeded`` or ``dead``). Raises if it does not
    terminate within ``max_iterations``.
    """
    worker = JobWorker(
        session_factory=session_factory,
        worker_id="test-teardown-worker",
        registry=get_default_registry(),
        allowed_kinds=_TEARDOWN_KINDS,
    )
    for _ in range(max_iterations):
        status = _latest_teardown_status(session_factory, media_id)
        if status in ("succeeded", "dead"):
            return status
        _fast_forward_deletion_committed(session_factory, media_id)
        worker.run_once()
    final = _latest_teardown_status(session_factory, media_id)
    raise AssertionError(f"media {media_id} teardown did not terminate (last status={final!r})")
