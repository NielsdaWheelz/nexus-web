"""Durable media-teardown integration tests (spec §3.1, §8 items 6/7).

Covers the claim/reference-barrier races, the checkpointed teardown job lifecycle
and each checkpoint's crash-recovery, ref-recheck void, stale-job handling,
dead-letter void + requeue repair, the storage-object-cleanup Armed deadline, and
the recurring orphan sweep.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.db.session import transaction
from nexus.errors import ApiError, ApiErrorCode
from nexus.jobs.queue import enqueue_job, requeue_dead_job
from nexus.jobs.registry import get_default_registry
from nexus.jobs.worker import JobWorker
from nexus.services import library_entries, media_deletion
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.tasks.storage_object_cleanup import (
    STORAGE_OBJECT_CLEANUP_JOB_KIND,
    reserve_storage_object_write,
)
from tests.factories import create_test_library, create_test_media
from tests.helpers import create_test_user_id
from tests.support.storage import FakeStorageClient
from tests.support.teardown import drive_media_teardown, install_fake_storage_for_teardown
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

_TEARDOWN_KINDS = ("media_teardown", "storage_object_cleanup", "storage_orphan_sweep")


@pytest.fixture(autouse=True)
def _clean_teardown_state(direct_db: DirectSessionManager):
    yield
    with direct_db.session() as db:
        db.execute(text("DELETE FROM media_teardown_intents"))
        db.execute(
            text(
                "DELETE FROM background_jobs "
                "WHERE kind IN ('media_teardown', 'storage_object_cleanup', 'storage_orphan_sweep')"
            )
        )
        db.commit()


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #


def _bootstrap_user(direct_db: DirectSessionManager, user_id: UUID) -> UUID:
    with direct_db.session() as session:
        default_library = ensure_user_and_default_library(session, user_id)
        session.commit()
    return default_library


def _create_library(direct_db: DirectSessionManager, user_id: UUID, name: str) -> UUID:
    with direct_db.session() as session:
        return create_test_library(session, user_id, name)


def _seed_media_with_file(direct_db: DirectSessionManager, *, user_id: UUID) -> tuple[UUID, str]:
    """Seed a document media row + media_file and return (media_id, storage_path)."""
    _bootstrap_user(direct_db, user_id)
    with direct_db.session() as session:
        media_id = create_test_media(session, title="Teardown target")
        storage_path = f"media/{media_id}/original.pdf"
        session.execute(
            text("UPDATE media SET kind = 'pdf', created_by_user_id = :u WHERE id = :m"),
            {"u": user_id, "m": media_id},
        )
        session.execute(
            text(
                "INSERT INTO media_file (media_id, storage_path, content_type, size_bytes) "
                "VALUES (:m, :p, 'application/pdf', 4)"
            ),
            {"m": media_id, "p": storage_path},
        )
        session.commit()
    direct_db.register_cleanup("media_file", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    return media_id, storage_path


def _claim(direct_db: DirectSessionManager, media_id: UUID) -> UUID:
    with direct_db.session() as session, transaction(session):
        return media_deletion.claim_media_teardown(session, media_id)


def _add_reference(direct_db: DirectSessionManager, *, library_id: UUID, media_id: UUID) -> None:
    with direct_db.session() as session, transaction(session):
        library_entries.ensure_entry(session, library_id, library_entries.media_target(media_id))


def _teardown_job(direct_db: DirectSessionManager, media_id: UUID) -> dict:
    with direct_db.session() as session:
        return dict(
            session.execute(
                text(
                    "SELECT id, status, payload FROM background_jobs "
                    "WHERE kind = 'media_teardown' AND payload->>'mediaId' = :m "
                    "ORDER BY created_at DESC LIMIT 1"
                ),
                {"m": str(media_id)},
            )
            .mappings()
            .one()
        )


def _checkpoint(direct_db: DirectSessionManager, media_id: UUID) -> str:
    return str(_teardown_job(direct_db, media_id)["payload"]["checkpoint"]["kind"])


def _media_exists(direct_db: DirectSessionManager, media_id: UUID) -> bool:
    with direct_db.session() as session:
        return (
            session.execute(text("SELECT 1 FROM media WHERE id = :m"), {"m": media_id}).first()
            is not None
        )


def _intent_id(direct_db: DirectSessionManager, media_id: UUID) -> UUID | None:
    with direct_db.session() as session:
        row = session.execute(
            text("SELECT id FROM media_teardown_intents WHERE media_id = :m"),
            {"m": media_id},
        ).first()
    return UUID(str(row[0])) if row is not None else None


def _worker(direct_db: DirectSessionManager) -> JobWorker:
    return JobWorker(
        session_factory=direct_db.session,
        worker_id=f"test-teardown-{uuid4()}",
        registry=get_default_registry(),
        allowed_kinds=_TEARDOWN_KINDS,
    )


# --------------------------------------------------------------------------- #
# reference barrier / claim races (§8 item 6)
# --------------------------------------------------------------------------- #


def test_claim_first_makes_new_reference_raise_media_deleting(
    direct_db: DirectSessionManager, monkeypatch
):
    install_fake_storage_for_teardown(monkeypatch, FakeStorageClient())
    user_id = create_test_user_id()
    media_id, _ = _seed_media_with_file(direct_db, user_id=user_id)
    library_id = _create_library(direct_db, user_id, "Barrier")

    _claim(direct_db, media_id)

    with pytest.raises(ApiError) as excinfo:
        _add_reference(direct_db, library_id=library_id, media_id=media_id)
    assert excinfo.value.code == ApiErrorCode.E_MEDIA_DELETING


def test_creator_first_makes_claim_a_noop_via_reference_count(
    direct_db: DirectSessionManager, monkeypatch
):
    install_fake_storage_for_teardown(monkeypatch, FakeStorageClient())
    user_id = create_test_user_id()
    media_id, _ = _seed_media_with_file(direct_db, user_id=user_id)
    library_id = _create_library(direct_db, user_id, "Creator")

    # Creator-first: a reference exists, so the claim doorway is never reached.
    _add_reference(direct_db, library_id=library_id, media_id=media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    with direct_db.session() as session:
        remaining = media_deletion._total_reference_count(session, media_id)
    assert remaining == 1
    assert _intent_id(direct_db, media_id) is None


# --------------------------------------------------------------------------- #
# teardown job lifecycle + per-checkpoint recovery (§8 item 7)
# --------------------------------------------------------------------------- #


def test_teardown_lifecycle_deletes_media_and_sweeps_storage(
    direct_db: DirectSessionManager, monkeypatch
):
    storage = FakeStorageClient()
    install_fake_storage_for_teardown(monkeypatch, storage)
    user_id = create_test_user_id()
    media_id, storage_path = _seed_media_with_file(direct_db, user_id=user_id)
    storage.put_object(storage_path, b"%PDF-1.4", "application/pdf")

    _claim(direct_db, media_id)
    assert _checkpoint(direct_db, media_id) == "Unprepared"

    assert drive_media_teardown(direct_db.session, media_id) == "succeeded"
    assert not _media_exists(direct_db, media_id)
    assert _intent_id(direct_db, media_id) is None
    assert storage.get_object(storage_path) is None


def test_teardown_checkpoints_advance_one_step_per_run_and_recover(
    direct_db: DirectSessionManager, monkeypatch
):
    storage = FakeStorageClient()
    install_fake_storage_for_teardown(monkeypatch, storage)
    user_id = create_test_user_id()
    media_id, storage_path = _seed_media_with_file(direct_db, user_id=user_id)
    storage.put_object(storage_path, b"%PDF-1.4", "application/pdf")
    _claim(direct_db, media_id)

    worker = _worker(direct_db)

    # Step 1: Unprepared -> PathsPrepared (durable checkpoint persisted, still pending).
    worker.run_once()
    assert _checkpoint(direct_db, media_id) == "PathsPrepared"
    assert _media_exists(direct_db, media_id)
    # "Crash + re-run" is just re-driving from the persisted checkpoint.

    # Step 2: PathsPrepared -> DeletionCommitted (media + child state gone atomically).
    worker.run_once()
    assert _checkpoint(direct_db, media_id) == "DeletionCommitted"
    assert not _media_exists(direct_db, media_id)
    # Storage still present: it is only swept after cleanupNotBefore.
    assert storage.get_object(storage_path) is not None

    # Step 3: after cleanupNotBefore, delete persisted paths and complete.
    assert drive_media_teardown(direct_db.session, media_id) == "succeeded"
    assert storage.get_object(storage_path) is None


def test_teardown_voids_only_exact_intent_when_reference_reappears(
    direct_db: DirectSessionManager, monkeypatch
):
    install_fake_storage_for_teardown(monkeypatch, FakeStorageClient())
    user_id = create_test_user_id()
    media_id, _ = _seed_media_with_file(direct_db, user_id=user_id)
    library_id = _create_library(direct_db, user_id, "Reappear")
    intent_id = _claim(direct_db, media_id)

    # A reference reappears out-of-band (barrier-bypassing raw insert) before the job's
    # deletion step. The ref recheck must void only that intent and keep the media.
    with direct_db.session() as session:
        session.execute(
            text(
                "INSERT INTO library_entries (library_id, media_id, podcast_id, position) "
                "VALUES (:lib, :m, NULL, 0)"
            ),
            {"lib": library_id, "m": media_id},
        )
        session.commit()
    direct_db.register_cleanup("library_entries", "media_id", media_id)

    assert drive_media_teardown(direct_db.session, media_id) == "succeeded"
    assert _checkpoint(direct_db, media_id) == "Voided"
    assert _media_exists(direct_db, media_id)
    assert _intent_id(direct_db, media_id) is None
    assert intent_id is not None


def test_teardown_stale_when_intent_replaced_by_a_newer_one(
    direct_db: DirectSessionManager, monkeypatch
):
    install_fake_storage_for_teardown(monkeypatch, FakeStorageClient())
    user_id = create_test_user_id()
    media_id, _ = _seed_media_with_file(direct_db, user_id=user_id)
    _claim(direct_db, media_id)

    # Replace the intent with a different one (id mismatch) for the same media.
    new_intent = uuid4()
    with direct_db.session() as session:
        session.execute(
            text("DELETE FROM media_teardown_intents WHERE media_id = :m"), {"m": media_id}
        )
        session.execute(
            text("INSERT INTO media_teardown_intents (id, media_id) VALUES (:id, :m)"),
            {"id": new_intent, "m": media_id},
        )
        session.commit()

    assert drive_media_teardown(direct_db.session, media_id) == "succeeded"
    assert _checkpoint(direct_db, media_id) == "Stale"
    assert _media_exists(direct_db, media_id)
    # The newer intent is untouched by the stale job.
    assert _intent_id(direct_db, media_id) == new_intent


def test_dead_letter_voids_exact_intent_and_requeue_repairs(
    direct_db: DirectSessionManager, monkeypatch
):
    install_fake_storage_for_teardown(monkeypatch, FakeStorageClient())
    user_id = create_test_user_id()
    media_id, _ = _seed_media_with_file(direct_db, user_id=user_id)
    intent_id = _claim(direct_db, media_id)
    job_id = UUID(str(_teardown_job(direct_db, media_id)["id"]))

    # Force the job to an exhausted, expired running state so the worker dead-letters it.
    with direct_db.session() as session:
        session.execute(
            text(
                "UPDATE background_jobs SET status = 'running', attempts = max_attempts, "
                "claimed_by = 'dead-worker', lease_expires_at = now() - interval '1 minute' "
                "WHERE id = :id"
            ),
            {"id": job_id},
        )
        session.commit()

    assert _worker(direct_db).run_once() is True
    assert _teardown_job(direct_db, media_id)["status"] == "dead"
    # Live media => only the exact matching intent is voided.
    assert _intent_id(direct_db, media_id) is None
    assert _media_exists(direct_db, media_id)
    assert intent_id is not None

    # requeue_dead_job is the repair transition: dead -> pending with a fresh budget.
    with direct_db.session() as session:
        assert requeue_dead_job(session, job_id=job_id) is True
        session.commit()
    # No intent now => prepare records NoOp and the repaired job completes.
    assert drive_media_teardown(direct_db.session, media_id) == "succeeded"
    assert _media_exists(direct_db, media_id)


# --------------------------------------------------------------------------- #
# storage-object cleanup reservation (§3.1)
# --------------------------------------------------------------------------- #


def test_reserve_storage_object_write_is_at_most_one_nonterminal_and_rejects_intent(
    direct_db: DirectSessionManager, monkeypatch
):
    install_fake_storage_for_teardown(monkeypatch, FakeStorageClient())
    user_id = create_test_user_id()
    media_id, storage_path = _seed_media_with_file(direct_db, user_id=user_id)

    with direct_db.session() as session:
        reserve_storage_object_write(session, media_id=media_id, storage_path=storage_path)
        reserve_storage_object_write(session, media_id=media_id, storage_path=storage_path)

    with direct_db.session() as session:
        count = session.execute(
            text(
                "SELECT count(*) FROM background_jobs "
                "WHERE kind = :k AND status NOT IN ('succeeded', 'dead') "
                "AND payload->>'storagePath' = :p"
            ),
            {"k": STORAGE_OBJECT_CLEANUP_JOB_KIND, "p": storage_path},
        ).scalar_one()
    assert count == 1, "at most one nonterminal cleanup job per (media, path)"

    # A pending teardown intent makes a new reservation reject the write.
    _claim(direct_db, media_id)
    with direct_db.session() as session, pytest.raises(ApiError) as excinfo:
        reserve_storage_object_write(session, media_id=media_id, storage_path=storage_path)
    assert excinfo.value.code == ApiErrorCode.E_MEDIA_DELETING


def test_storage_object_cleanup_armed_deadline_deletes_orphaned_object(
    direct_db: DirectSessionManager, monkeypatch
):
    storage = FakeStorageClient()
    install_fake_storage_for_teardown(monkeypatch, storage)
    user_id = create_test_user_id()
    media_id, storage_path = _seed_media_with_file(direct_db, user_id=user_id)

    # Reserve, then simulate a crashed writer: the object was written but never got its
    # committed owner (drop the media_file so the path is unowned) and no Retained
    # recheck ran. The Armed deadline must take the exclusive hold and delete it.
    with direct_db.session() as session:
        reserve_storage_object_write(session, media_id=media_id, storage_path=storage_path)
    storage.put_object(storage_path, b"late PUT", "application/pdf")
    with direct_db.session() as session:
        session.execute(text("DELETE FROM media_file WHERE media_id = :m"), {"m": media_id})
        # Make the Armed reservation due now.
        session.execute(
            text(
                "UPDATE background_jobs SET available_at = now() "
                "WHERE kind = :k AND payload->>'storagePath' = :p"
            ),
            {"k": STORAGE_OBJECT_CLEANUP_JOB_KIND, "p": storage_path},
        )
        session.commit()

    _worker(direct_db).run_once()
    assert storage.get_object(storage_path) is None


# --------------------------------------------------------------------------- #
# recurring orphan sweep (§3.1)
# --------------------------------------------------------------------------- #


def test_orphan_sweep_deletes_unowned_aged_objects_only(
    direct_db: DirectSessionManager, monkeypatch
):
    storage = FakeStorageClient()
    install_fake_storage_for_teardown(monkeypatch, storage)
    user_id = create_test_user_id()
    media_id, owned_path = _seed_media_with_file(direct_db, user_id=user_id)

    orphan_old = f"media/{uuid4()}/original.pdf"
    orphan_recent = f"media/{uuid4()}/original.pdf"
    storage.put_object(owned_path, b"owned", "application/pdf")
    storage.put_object(orphan_old, b"old orphan", "application/pdf")
    storage.put_object(orphan_recent, b"recent orphan", "application/pdf")
    # Age the old orphan past the 24h min-age; owned + recent stay young.
    storage._last_modified[orphan_old] = datetime.now(UTC) - timedelta(hours=25)

    with direct_db.session() as session:
        enqueue_job(session, kind="storage_orphan_sweep", payload={})
        session.commit()

    _worker(direct_db).run_once()

    assert storage.get_object(owned_path) is not None, "a live DB owner protects the object"
    assert storage.get_object(orphan_recent) is not None, "objects within min-age are ignored"
    assert storage.get_object(orphan_old) is None, "an aged, unowned object is swept"
