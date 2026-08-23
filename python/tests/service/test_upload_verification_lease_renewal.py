"""Priority proof: a lapsed lease alone never rejects a live verifier's publication."""

from __future__ import annotations

from threading import Event, Thread
from typing import cast

from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from nexus.db.models import MediaUploadSession
from nexus.services.media_upload_sessions import confirm_upload_session, create_upload_session
from nexus.storage.client import StorageClientBase, get_storage_client
from nexus.storage.paths import build_upload_session_staging_storage_path
from tests.testkit.auth import UserRecord
from tests.testkit.unreachable_state import expire_upload_verification_lease
from tests.testkit.upload_sessions import BlockingCopyStorage, ingest_job_count, upload_request


def test_verification_lease_renewal_lets_a_slow_verifier_publish(
    committed_upload_support: tuple[Session, UserRecord],
    engine: Engine,
) -> None:
    """A lapsed lease alone never rejects a commit; the phase-boundary renewal fences it.

    The lease is forced to lapse while the verifier is alive and nobody has stolen
    it. Because publication requires the lease token rather than a non-expired lease,
    and the verifier heartbeats at each phase boundary, the confirm still publishes
    instead of failing with a stale-generation error the user cannot act on.
    """
    db_session, test_user = committed_upload_support
    storage = get_storage_client()

    slow_payload = b"%PDF-1.7\nslow but live verifier\n%%EOF"
    slow_created = create_upload_session(
        db_session,
        viewer_id=test_user.id,
        request=upload_request(filename="slow-lease.pdf", size_bytes=len(slow_payload)),
        request_id="slow-lease-create",
        idempotency_key="slow-lease",
        storage_client=storage,
    )
    slow_session = db_session.execute(
        select(MediaUploadSession).where(
            MediaUploadSession.created_by_user_id == test_user.id,
            MediaUploadSession.idempotency_key == "slow-lease",
        )
    ).scalar_one()
    storage.put_object(
        build_upload_session_staging_storage_path(slow_session.id, 1, "pdf"),
        slow_payload,
        "application/pdf",
    )
    slow_copy_started = Event()
    release_slow_copy = Event()
    slow_storage = BlockingCopyStorage(storage, slow_copy_started, release_slow_copy)
    slow_outcomes: list[str] = []
    slow_errors: list[Exception] = []

    def confirm_slow_verifier() -> None:
        with Session(engine, expire_on_commit=False) as slow_db:
            try:
                slow_outcomes.append(
                    confirm_upload_session(
                        slow_db,
                        viewer_id=test_user.id,
                        session_handle=slow_created.session_handle,
                        generation=1,
                        request_id="slow-verifier",
                        storage_client=cast(StorageClientBase, slow_storage),
                    ).idempotency_outcome
                )
            except Exception as exc:  # noqa: BLE001 - surfaced in the parent proof thread.
                slow_errors.append(exc)

    slow_thread = Thread(target=confirm_slow_verifier, name="slow-upload-verifier")
    slow_thread.start()
    try:
        assert slow_copy_started.wait(timeout=20), "slow verifier never reached its copy"
        expire_upload_verification_lease(db_session, session_id=slow_session.id)
    finally:
        release_slow_copy.set()
        slow_thread.join(timeout=30)

    assert not slow_thread.is_alive()
    assert slow_errors == []
    assert slow_outcomes == ["Created"]
    db_session.expire_all()
    slow_published = db_session.get(MediaUploadSession, slow_session.id)
    assert slow_published is not None
    assert slow_published.published_media_id == slow_session.candidate_media_id
    assert slow_published.verification_token is None
    assert (
        ingest_job_count(
            db_session,
            media_id=slow_session.candidate_media_id,
            attempt_id=slow_published.published_source_attempt_id,
        )
        == 1
    )
