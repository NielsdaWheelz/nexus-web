"""Priority proof: a stolen verification lease loses as contention and publishes once."""

from __future__ import annotations

from threading import Event, Thread
from typing import cast

from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session

from nexus.db.models import MediaFile, MediaSourceAttempt, MediaUploadSession
from nexus.errors import ApiError, ApiErrorCode
from nexus.services.media_upload_sessions import confirm_upload_session, create_upload_session
from nexus.storage.client import StorageClientBase, get_storage_client
from nexus.storage.paths import (
    build_upload_session_staging_storage_path,
    build_upload_verification_candidate_storage_path,
)
from tests.testkit.auth import UserRecord
from tests.testkit.unreachable_state import expire_upload_verification_lease
from tests.testkit.upload_sessions import BlockingCopyStorage, ingest_job_count, upload_request


def test_verification_lease_refuses_a_stolen_lease_and_publishes_once(
    committed_upload_support: tuple[Session, UserRecord],
    engine: Engine,
) -> None:
    """A stolen lease loses as verification contention and never publishes twice.

    A second confirm claims the first verifier's lapsed lease. The loser's own
    heartbeat sees a different token with the generation unchanged, so it is refused
    as contention (not as a superseded generation, which would tell the user to
    re-pick their file), and exactly one publication survives — from the bytes of the
    verifier that actually held the fence.
    """
    db_session, test_user = committed_upload_support
    storage = get_storage_client()

    stolen_payload = b"%PDF-1.7\nlease theft fencing test\n%%EOF"
    stolen_created = create_upload_session(
        db_session,
        viewer_id=test_user.id,
        request=upload_request(filename="stolen-lease.pdf", size_bytes=len(stolen_payload)),
        request_id="stolen-lease-create",
        idempotency_key="stolen-lease",
        storage_client=storage,
    )
    stolen_session = db_session.execute(
        select(MediaUploadSession).where(
            MediaUploadSession.created_by_user_id == test_user.id,
            MediaUploadSession.idempotency_key == "stolen-lease",
        )
    ).scalar_one()
    storage.put_object(
        build_upload_session_staging_storage_path(stolen_session.id, 1, "pdf"),
        stolen_payload,
        "application/pdf",
    )
    loser_copy_started = Event()
    release_loser_copy = Event()
    loser_storage = BlockingCopyStorage(storage, loser_copy_started, release_loser_copy)
    thief_copy_started = Event()
    release_thief_copy = Event()
    thief_storage = BlockingCopyStorage(storage, thief_copy_started, release_thief_copy)
    loser_errors: list[ApiError] = []
    loser_unexpected: list[Exception] = []
    thief_outcomes: list[str] = []
    thief_errors: list[Exception] = []

    def confirm_loser() -> None:
        with Session(engine, expire_on_commit=False) as loser_db:
            try:
                confirm_upload_session(
                    loser_db,
                    viewer_id=test_user.id,
                    session_handle=stolen_created.session_handle,
                    generation=1,
                    request_id="lease-loser",
                    storage_client=cast(StorageClientBase, loser_storage),
                )
            except ApiError as exc:
                loser_errors.append(exc)
            except Exception as exc:  # noqa: BLE001 - surfaced in the parent proof thread.
                loser_unexpected.append(exc)

    def confirm_thief() -> None:
        with Session(engine, expire_on_commit=False) as thief_db:
            try:
                thief_outcomes.append(
                    confirm_upload_session(
                        thief_db,
                        viewer_id=test_user.id,
                        session_handle=stolen_created.session_handle,
                        generation=1,
                        request_id="lease-thief",
                        storage_client=cast(StorageClientBase, thief_storage),
                    ).idempotency_outcome
                )
            except Exception as exc:  # noqa: BLE001 - surfaced in the parent proof thread.
                thief_errors.append(exc)

    loser_thread = Thread(target=confirm_loser, name="stolen-lease-loser")
    thief_thread = Thread(target=confirm_thief, name="stolen-lease-thief")
    loser_thread.start()
    try:
        assert loser_copy_started.wait(timeout=20), "loser never reached its candidate copy"
        loser_token = expire_upload_verification_lease(db_session, session_id=stolen_session.id)
        thief_thread.start()
        assert thief_copy_started.wait(timeout=20), "thief never claimed the lapsed lease"
        with Session(engine) as oracle:
            thief_token = oracle.scalar(
                select(MediaUploadSession.verification_token).where(
                    MediaUploadSession.id == stolen_session.id
                )
            )
        assert thief_token is not None and thief_token != loser_token
    finally:
        release_loser_copy.set()
        loser_thread.join(timeout=30)
        release_thief_copy.set()
        thief_thread.join(timeout=30)

    assert not loser_thread.is_alive() and not thief_thread.is_alive()
    assert loser_unexpected == []
    assert thief_errors == []
    assert len(loser_errors) == 1
    assert loser_errors[0].code is ApiErrorCode.E_UPLOAD_VERIFICATION_IN_PROGRESS
    assert thief_outcomes == ["Created"]
    db_session.expire_all()
    stolen_published = db_session.get(MediaUploadSession, stolen_session.id)
    assert stolen_published is not None and stolen_published.published_at is not None
    assert (
        db_session.scalar(
            select(func.count())
            .select_from(MediaSourceAttempt)
            .where(MediaSourceAttempt.media_id == stolen_session.candidate_media_id)
        )
        == 1
    )
    assert (
        ingest_job_count(
            db_session,
            media_id=stolen_session.candidate_media_id,
            attempt_id=stolen_published.published_source_attempt_id,
        )
        == 1
    )
    stolen_file = db_session.get(MediaFile, stolen_session.candidate_media_id)
    assert stolen_file is not None
    assert stolen_file.storage_path == build_upload_verification_candidate_storage_path(
        stolen_session.candidate_media_id, thief_token, "pdf"
    )
    assert stolen_file.storage_path != build_upload_verification_candidate_storage_path(
        stolen_session.candidate_media_id, loser_token, "pdf"
    )
