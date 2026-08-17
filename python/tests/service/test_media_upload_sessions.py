"""Real PostgreSQL + MinIO proof for durable upload intent and publication."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Generator, Iterator
from datetime import UTC, datetime, timedelta
from threading import Event, Thread
from typing import cast
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, event, func, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from nexus.config import DIRECT_UPLOAD_PUT_TIMEOUT_SECONDS, Settings, get_settings
from nexus.db.models import (
    LibraryEntry,
    Media,
    MediaFile,
    MediaSourceAttempt,
    MediaUploadSession,
    MediaUploadSessionDestination,
)
from nexus.db.session import transaction
from nexus.errors import ApiError, ApiErrorCode
from nexus.jobs.worker import JobWorker
from nexus.schemas.library import CreateLibraryRequest
from nexus.schemas.media import (
    CreateUploadSessionRequest,
    RetryUploadSessionRequest,
    TransportFailed,
    UploadHttpRejectedFailureRequest,
    UploadNetworkFailureRequest,
    UploadTransportHttpRejectedFailure,
    VerificationFailed,
)
from nexus.services import library_entries, library_governance, media_deletion
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.media_upload_sessions import (
    confirm_upload_session,
    create_upload_session,
    delete_upload_session,
    list_viewer_unresolved_upload_sessions,
    record_transport_failure,
    retry_upload_session,
)
from nexus.storage.client import ObjectMetadata, SignedUpload, StorageClientBase, get_storage_client
from nexus.storage.paths import (
    build_upload_session_staging_storage_path,
    build_upload_verification_candidate_storage_path,
)
from tests.testkit.auth import UserRecord
from tests.testkit.unreachable_state import (
    cleanup_committed_upload_user,
    delete_jobs_by_ids,
    force_upload_cleanup_job_due,
    install_deferred_media_insert_failure,
    make_upload_cleanup_job_available_before_its_fence,
    remove_deferred_media_insert_failure,
)


@pytest.fixture
def committed_upload_support(engine: Engine) -> Generator[tuple[Session, UserRecord], None, None]:
    user_id = uuid4()
    email = f"upload-session-proof-{user_id}@example.invalid"
    db = Session(engine, expire_on_commit=False)
    default_library_id = ensure_user_and_default_library(db, user_id, email)
    db.commit()
    try:
        yield (
            db,
            UserRecord(
                id=user_id,
                email=email,
                default_library_id=default_library_id,
            ),
        )
    finally:
        storage = get_storage_client()
        for session in db.execute(
            select(MediaUploadSession).where(MediaUploadSession.created_by_user_id == user_id)
        ).scalars():
            for generation in range(1, session.upload_generation + 1):
                storage.delete_object(
                    build_upload_session_staging_storage_path(session.id, generation, session.kind)
                )
            _delete_storage_prefix(storage, f"media/{session.candidate_media_id}/")
        db.close()
        cleanup_committed_upload_user(engine, user_id=user_id)


def _delete_storage_prefix(storage: StorageClientBase, prefix: str) -> None:
    paths: list[str] = []
    continuation_token: str | None = None
    while True:
        page = storage.list_objects(prefix, continuation_token=continuation_token)
        paths.extend(item.path for item in page.objects)
        continuation_token = page.next_continuation_token
        if continuation_token is None:
            break
    for path in paths:
        storage.delete_object(path)


def _cleanup_worker(engine: Engine) -> JobWorker:
    return JobWorker(
        session_factory=lambda: Session(engine),
        worker_id=f"upload-cleanup-proof-{uuid4()}",
        allowed_kinds=("storage_object_cleanup",),
    )


class _BlockingCopyStorage:
    """Real-storage proxy that holds one candidate copy at a controlled boundary."""

    def __init__(self, delegate: StorageClientBase, copy_started: Event, release_copy: Event):
        self._delegate = delegate
        self._copy_started = copy_started
        self._release_copy = release_copy
        self.destination_path: str | None = None

    def head_object(self, path: str) -> ObjectMetadata | None:
        return self._delegate.head_object(path)

    def stream_object(self, path: str) -> Iterator[bytes]:
        return self._delegate.stream_object(path)

    def copy_object(self, source_path: str, destination_path: str) -> None:
        self.destination_path = destination_path
        self._copy_started.set()
        if not self._release_copy.wait(timeout=20):
            raise AssertionError("stale verification copy was never released")
        self._delegate.copy_object(source_path, destination_path)


class _BlockingSignStorage:
    """Real-storage proxy that holds a minted capability before returning it."""

    def __init__(self, delegate: StorageClientBase, sign_issued: Event, return_sign: Event):
        self._delegate = delegate
        self._sign_issued = sign_issued
        self._return_sign = return_sign
        self.issued_paths: list[str] = []

    def sign_upload(
        self,
        path: str,
        *,
        content_type: str,
        size_bytes: int,
        expires_in: int = 300,
    ) -> SignedUpload:
        signed = self._delegate.sign_upload(
            path,
            content_type=content_type,
            size_bytes=size_bytes,
            expires_in=expires_in,
        )
        self.issued_paths.append(path)
        self._sign_issued.set()
        if not self._return_sign.wait(timeout=20):
            raise AssertionError("minted retry capability was never released")
        return signed


def _upload_request(
    *,
    filename: str,
    size_bytes: int,
    library_ids: list[UUID] | None = None,
) -> CreateUploadSessionRequest:
    return CreateUploadSessionRequest(
        kind="Pdf",
        filename=filename,
        content_type="application/pdf",
        size_bytes=size_bytes,
        library_ids=library_ids or [],
    )


def _ingest_job_count(db: Session, *, media_id: UUID, attempt_id: UUID | None = None) -> int:
    match = {"media_id": str(media_id)}
    if attempt_id is not None:
        match["attempt_id"] = str(attempt_id)
    return int(
        db.execute(
            text(
                """
                SELECT count(*)
                FROM background_jobs
                WHERE kind = 'ingest_media_source'
                  AND payload @> CAST(:match AS jsonb)
                """
            ),
            {"match": json.dumps(match)},
        ).scalar_one()
    )


def test_upload_session_fences_generations_and_atomically_publishes_or_converges(
    committed_upload_support: tuple[Session, UserRecord],
    engine: Engine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with monkeypatch.context() as config:
        config.setenv(
            "STORAGE_OBJECT_CLEANUP_WRITE_WINDOW_SECONDS",
            str(DIRECT_UPLOAD_PUT_TIMEOUT_SECONDS),
        )
        with pytest.raises(ValueError, match="browser direct-upload PUT timeout"):
            Settings()

    db_session, test_user = committed_upload_support
    storage = get_storage_client()
    payload = b"%PDF-1.7\nreliable upload source\n%%EOF"
    destination_library_id = uuid4()
    library_governance.create_library(
        db_session,
        test_user.id,
        CreateLibraryRequest(library_id=destination_library_id, name="Upload destination"),
    )
    request = _upload_request(
        filename="reliable.pdf",
        size_bytes=len(payload),
        library_ids=[destination_library_id],
    )
    staged_paths: set[str] = set()
    candidate_paths: set[str] = set()

    created = create_upload_session(
        db_session,
        viewer_id=test_user.id,
        request=request,
        request_id="upload-create",
        idempotency_key="durable-upload",
        storage_client=storage,
    )
    assert created.kind == "UploadRequired"
    assert created.idempotency_outcome == "Created"
    assert created.generation == 1
    assert created.required_headers.model_dump(by_alias=True) == {"Content-Type": "application/pdf"}
    assert "Content-Length" not in created.required_headers.model_dump(by_alias=True)
    session = db_session.execute(
        select(MediaUploadSession).where(MediaUploadSession.idempotency_key == "durable-upload")
    ).scalar_one()
    candidate_media_id = session.candidate_media_id
    assert db_session.get(Media, candidate_media_id) is None
    assert (
        db_session.scalar(
            select(func.count())
            .select_from(MediaSourceAttempt)
            .where(MediaSourceAttempt.media_id == candidate_media_id)
        )
        == 0
    )
    assert _ingest_job_count(db_session, media_id=candidate_media_id) == 0

    live_replay = create_upload_session(
        db_session,
        viewer_id=test_user.id,
        request=request,
        request_id="upload-live-replay",
        idempotency_key="durable-upload",
        storage_client=storage,
    )
    assert live_replay.session_handle == created.session_handle
    assert live_replay.generation == 1
    assert live_replay.idempotency_outcome == "Reused"
    first_staging_path = build_upload_session_staging_storage_path(session.id, 1, "pdf")
    assert (
        db_session.execute(
            text(
                """
                SELECT count(*)
                FROM background_jobs
                WHERE kind = 'storage_object_cleanup'
                  AND status IN ('pending', 'running')
                  AND payload @> jsonb_build_object(
                      'ownerKind', 'UploadSession',
                      'uploadSessionId', CAST(:session_id AS text),
                      'storagePath', CAST(:storage_path AS text)
                  )
                """
            ),
            {"session_id": str(session.id), "storage_path": first_staging_path},
        ).scalar_one()
        == 1
    )
    with pytest.raises(ApiError) as mismatch:
        create_upload_session(
            db_session,
            viewer_id=test_user.id,
            request=_upload_request(filename="different.pdf", size_bytes=len(payload)),
            request_id="upload-conflict",
            idempotency_key="durable-upload",
            storage_client=storage,
        )
    assert mismatch.value.code is ApiErrorCode.E_IDEMPOTENCY_CONFLICT

    session.upload_url_expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db_session.commit()
    expiry_replay = create_upload_session(
        db_session,
        viewer_id=test_user.id,
        request=request,
        request_id="upload-expiry-replay",
        idempotency_key="durable-upload",
        storage_client=storage,
    )
    assert expiry_replay.session_handle == created.session_handle
    assert expiry_replay.generation == 2
    assert db_session.get(MediaUploadSession, session.id).candidate_media_id == candidate_media_id

    record_transport_failure(
        db_session,
        viewer_id=test_user.id,
        session_handle=created.session_handle,
        failure=UploadNetworkFailureRequest(
            kind="Network", generation=1, duration_ms=10, request_id="stale-put"
        ),
    )
    session = db_session.get(MediaUploadSession, session.id)
    assert session is not None and session.transport_failure_kind is None
    record_transport_failure(
        db_session,
        viewer_id=test_user.id,
        session_handle=created.session_handle,
        failure=UploadHttpRejectedFailureRequest(
            kind="HttpRejected",
            status=503,
            generation=2,
            duration_ms=20,
            request_id="current-put",
        ),
    )
    attention = list_viewer_unresolved_upload_sessions(db_session, viewer_id=test_user.id)
    assert len(attention) == 1
    assert attention[0].state == "TransportFailed"
    assert attention[0].expected_size_bytes == len(payload)
    assert isinstance(attention[0].failure, TransportFailed)
    assert isinstance(attention[0].failure.reason, UploadTransportHttpRejectedFailure)
    assert attention[0].failure.reason.status == 503

    retry = retry_upload_session(
        db_session,
        viewer_id=test_user.id,
        session_handle=created.session_handle,
        request=RetryUploadSessionRequest(
            filename="reliable.pdf",
            content_type="application/pdf",
            size_bytes=len(payload),
        ),
        storage_client=storage,
    )
    assert retry.session_handle == created.session_handle
    assert retry.generation == 3
    with pytest.raises(ApiError) as stale:
        confirm_upload_session(
            db_session,
            viewer_id=test_user.id,
            session_handle=created.session_handle,
            generation=2,
            request_id="stale-confirm",
            storage_client=storage,
        )
    assert stale.value.code is ApiErrorCode.E_UPLOAD_GENERATION_STALE

    other_user_id = uuid4()
    with pytest.raises(ApiError) as isolated:
        retry_upload_session(
            db_session,
            viewer_id=other_user_id,
            session_handle=created.session_handle,
            request=RetryUploadSessionRequest(
                filename="reliable.pdf",
                content_type="application/pdf",
                size_bytes=len(payload),
            ),
            storage_client=storage,
        )
    assert isolated.value.code is ApiErrorCode.E_UPLOAD_SESSION_NOT_FOUND

    staging_path = build_upload_session_staging_storage_path(session.id, 3, "pdf")
    staged_paths.add(staging_path)
    storage.put_object(staging_path, payload, "application/pdf")
    published = confirm_upload_session(
        db_session,
        viewer_id=test_user.id,
        session_handle=created.session_handle,
        generation=3,
        request_id="publish",
        storage_client=storage,
    )
    assert published.media_id == candidate_media_id
    assert published.idempotency_outcome == "Created"
    media = db_session.get(Media, candidate_media_id)
    media_file = db_session.get(MediaFile, candidate_media_id)
    attempt = db_session.get(MediaSourceAttempt, published.source_attempt_id)
    assert media is not None and media.processing_status.value == "extracting"
    assert media_file is not None
    candidate_path = media_file.storage_path
    candidate_paths.add(candidate_path)
    assert candidate_path.startswith(f"media/{candidate_media_id}/candidates/")
    assert media_file.source_sha256 == hashlib.sha256(payload).hexdigest()
    assert attempt is not None and attempt.status == "queued"
    assert attempt.job_id is not None
    assert _ingest_job_count(db_session, media_id=candidate_media_id, attempt_id=attempt.id) == 1
    assert (
        db_session.scalar(
            select(func.count())
            .select_from(LibraryEntry)
            .where(LibraryEntry.media_id == candidate_media_id)
        )
        == 2
    )
    assert storage.head_object(candidate_path) is not None
    assert storage.head_object(staging_path) is None
    replayed = confirm_upload_session(
        db_session,
        viewer_id=test_user.id,
        session_handle=created.session_handle,
        generation=3,
        request_id="publish-replay",
        storage_client=storage,
    )
    assert replayed.media_id == candidate_media_id
    assert replayed.source_attempt_id == attempt.id
    assert replayed.idempotency_outcome == "Reused"
    assert _ingest_job_count(db_session, media_id=candidate_media_id, attempt_id=attempt.id) == 1
    with Session(engine) as replay_oracle:
        replayed_media = replay_oracle.get(Media, candidate_media_id)
        replayed_file = replay_oracle.get(MediaFile, candidate_media_id)
        replayed_attempt = replay_oracle.get(MediaSourceAttempt, attempt.id)
        replayed_session = replay_oracle.get(MediaUploadSession, session.id)
        assert replayed_media is not None and replayed_media.processing_status.value == "extracting"
        assert replayed_file is not None
        assert replayed_file.storage_path == candidate_path
        assert replayed_file.content_type == "application/pdf"
        assert replayed_file.size_bytes == len(payload)
        assert replayed_file.source_sha256 == hashlib.sha256(payload).hexdigest()
        assert replayed_attempt is not None
        assert replayed_attempt.media_id == candidate_media_id
        assert replayed_attempt.status == "queued"
        assert replayed_attempt.job_id == attempt.job_id
        assert set(
            replay_oracle.scalars(
                select(LibraryEntry.library_id).where(LibraryEntry.media_id == candidate_media_id)
            )
        ) == {test_user.default_library_id, destination_library_id}
        assert replayed_session is not None
        assert replayed_session.published_media_id == candidate_media_id
        assert replayed_session.published_source_attempt_id == attempt.id
        assert replayed_session.published_at is not None
        assert replayed_session.verification_token is None
        assert replayed_session.transport_failure_kind is None
        assert replayed_session.verification_error_code is None
        assert (
            _ingest_job_count(
                replay_oracle,
                media_id=candidate_media_id,
                attempt_id=attempt.id,
            )
            == 1
        )

    published_session = db_session.get(MediaUploadSession, session.id)
    assert published_session is not None
    published_session.transport_failure_kind = "Network"
    published_session.transport_failed_at = datetime.now(UTC)
    db_session.commit()
    with pytest.raises(AssertionError, match="published upload retains unresolved facts"):
        confirm_upload_session(
            db_session,
            viewer_id=test_user.id,
            session_handle=created.session_handle,
            generation=3,
            request_id="invalid-published-replay",
            storage_client=storage,
        )
    db_session.rollback()
    published_session = db_session.get(MediaUploadSession, session.id)
    assert published_session is not None
    published_session.transport_failure_kind = None
    published_session.transport_failed_at = None
    db_session.commit()

    with pytest.raises(ApiError) as published_remove:
        delete_upload_session(
            db_session,
            viewer_id=test_user.id,
            session_handle=created.session_handle,
        )
    assert published_remove.value.code is ApiErrorCode.E_UPLOAD_ALREADY_PUBLISHED

    library_governance.delete_library(db_session, test_user.id, destination_library_id)
    assert db_session.get(MediaUploadSession, session.id) is not None
    assert (
        db_session.scalar(
            select(func.count())
            .select_from(MediaUploadSessionDestination)
            .where(MediaUploadSessionDestination.upload_session_id == session.id)
        )
        == 0
    )
    with transaction(db_session):
        removed_library_ids = library_entries.delete_all_entries_for_media(
            db_session,
            candidate_media_id,
        )
        assert removed_library_ids == [test_user.default_library_id]
        deletion_paths = media_deletion.delete_document_media_if_unreferenced(
            db_session,
            candidate_media_id,
        )
    assert deletion_paths == [candidate_path]
    assert db_session.get(MediaUploadSession, session.id) is None
    media_deletion.delete_document_storage_objects(deletion_paths, storage)
    assert storage.head_object(candidate_path) is None

    rejected_payload = b"not-a-pdf-but-same-length"
    rejected = create_upload_session(
        db_session,
        viewer_id=test_user.id,
        request=_upload_request(filename="rejected.pdf", size_bytes=len(rejected_payload)),
        request_id="reject-create",
        idempotency_key="rejected-upload",
        storage_client=storage,
    )
    rejected_session = db_session.execute(
        select(MediaUploadSession).where(MediaUploadSession.idempotency_key == "rejected-upload")
    ).scalar_one()
    rejected_staging_path = build_upload_session_staging_storage_path(rejected_session.id, 1, "pdf")
    staged_paths.add(rejected_staging_path)
    storage.put_object(rejected_staging_path, rejected_payload, "application/pdf")
    with pytest.raises(ApiError) as rejected_confirm:
        confirm_upload_session(
            db_session,
            viewer_id=test_user.id,
            session_handle=rejected.session_handle,
            generation=1,
            request_id="reject-confirm",
            storage_client=storage,
        )
    assert rejected_confirm.value.code is ApiErrorCode.E_INVALID_FILE_TYPE
    assert db_session.get(Media, rejected_session.candidate_media_id) is None
    rejection_attention = list_viewer_unresolved_upload_sessions(db_session, viewer_id=test_user.id)
    terminal = next(item for item in rejection_attention if item.session_id == rejected_session.id)
    assert terminal.state == "VerificationFailed"
    assert isinstance(terminal.failure, VerificationFailed)
    assert terminal.failure.code == "E_INVALID_FILE_TYPE"
    assert terminal.capabilities.can_retry_upload is False

    rejected_session.verification_token = uuid4()
    rejected_session.verification_generation = rejected_session.upload_generation
    rejected_session.verification_expires_at = datetime.now(UTC) + timedelta(minutes=1)
    db_session.commit()
    with pytest.raises(AssertionError, match="terminal upload verification retains a live lease"):
        list_viewer_unresolved_upload_sessions(db_session, viewer_id=test_user.id)
    db_session.rollback()
    rejected_session = db_session.get(MediaUploadSession, rejected_session.id)
    assert rejected_session is not None
    rejected_session.verification_token = None
    rejected_session.verification_generation = None
    rejected_session.verification_expires_at = None
    db_session.commit()

    rejected_session.transport_failure_kind = "Network"
    rejected_session.transport_failed_at = datetime.now(UTC)
    db_session.commit()
    with pytest.raises(
        AssertionError, match="terminal upload verification retains a transport failure"
    ):
        list_viewer_unresolved_upload_sessions(db_session, viewer_id=test_user.id)
    db_session.rollback()
    rejected_session = db_session.get(MediaUploadSession, rejected_session.id)
    assert rejected_session is not None
    rejected_session.transport_failure_kind = None
    rejected_session.transport_failed_at = None
    db_session.commit()

    delete_upload_session(
        db_session,
        viewer_id=test_user.id,
        session_handle=rejected.session_handle,
    )
    assert db_session.get(MediaUploadSession, rejected_session.id) is None
    delete_upload_session(
        db_session,
        viewer_id=test_user.id,
        session_handle=rejected.session_handle,
    )
    assert db_session.get(MediaUploadSession, rejected_session.id) is None
    cleanup_jobs = list(
        db_session.execute(
            text(
                """
                SELECT id, payload, available_at
                FROM background_jobs
                WHERE kind = 'storage_object_cleanup'
                  AND payload->>'uploadSessionId' = :session_id
                  AND status IN ('pending', 'running')
                """
            ),
            {"session_id": str(rejected_session.id)},
        ).mappings()
    )
    assert len(cleanup_jobs) == 1
    cleanup_job = cleanup_jobs[0]
    assert cleanup_job["payload"]["storagePath"] == rejected_staging_path
    retain_until = datetime.fromisoformat(cleanup_job["payload"]["retainUntil"])
    write_may_land_until = datetime.fromisoformat(cleanup_job["payload"]["writeMayLandUntil"])
    assert cleanup_job["available_at"] >= max(retain_until, write_may_land_until)

    storage.put_object(rejected_staging_path, rejected_payload, "application/pdf")
    cleanup_worker = _cleanup_worker(engine)
    assert cleanup_worker.run_exact(cleanup_job["id"]) is None
    assert storage.head_object(rejected_staging_path) is not None
    force_upload_cleanup_job_due(db_session, job_id=cleanup_job["id"])
    assert cleanup_worker.run_exact(cleanup_job["id"]) is True
    assert storage.head_object(rejected_staging_path) is None

    # A committed PostgreSQL constraint trigger fails the publication at the
    # transaction boundary. Removing it and replaying must converge on the same
    # candidate identity and exactly one source job.
    failure_user_id = uuid4()
    failure_db = Session(engine, expire_on_commit=False)
    failure_session_id: UUID | None = None
    failure_candidate_id: UUID | None = None
    trigger_name = ""
    function_name = ""
    try:
        ensure_user_and_default_library(
            failure_db,
            failure_user_id,
            f"upload-commit-failure-{failure_user_id}@example.invalid",
        )
        failure_db.commit()
        failure_payload = b"%PDF-1.7\ncommit failure source\n%%EOF"
        failure_created = create_upload_session(
            failure_db,
            viewer_id=failure_user_id,
            request=_upload_request(filename="commit-failure.pdf", size_bytes=len(failure_payload)),
            request_id="commit-failure-create",
            idempotency_key="commit-failure-upload",
            storage_client=storage,
        )
        failure_session = failure_db.execute(
            select(MediaUploadSession).where(
                MediaUploadSession.created_by_user_id == failure_user_id
            )
        ).scalar_one()
        failure_session_id = failure_session.id
        failure_candidate_id = failure_session.candidate_media_id
        failure_staging_path = build_upload_session_staging_storage_path(
            failure_session.id, 1, "pdf"
        )
        staged_paths.add(failure_staging_path)
        storage.put_object(failure_staging_path, failure_payload, "application/pdf")
        trigger_name, function_name = install_deferred_media_insert_failure(
            engine,
            media_id=failure_candidate_id,
            discriminator=failure_user_id.hex,
        )
        with pytest.raises(DBAPIError, match="forced upload publication commit failure"):
            confirm_upload_session(
                failure_db,
                viewer_id=failure_user_id,
                session_handle=failure_created.session_handle,
                generation=1,
                request_id="forced-commit-failure",
                storage_client=storage,
            )
        with Session(engine) as rollback_oracle:
            assert rollback_oracle.get(Media, failure_candidate_id) is None
            assert rollback_oracle.get(MediaFile, failure_candidate_id) is None
            assert (
                rollback_oracle.scalar(
                    select(func.count())
                    .select_from(LibraryEntry)
                    .where(LibraryEntry.media_id == failure_candidate_id)
                )
                == 0
            )
            assert (
                rollback_oracle.scalar(
                    select(func.count())
                    .select_from(MediaSourceAttempt)
                    .where(MediaSourceAttempt.media_id == failure_candidate_id)
                )
                == 0
            )
            failed_session = rollback_oracle.get(MediaUploadSession, failure_session_id)
            assert failed_session is not None
            assert failed_session.published_media_id is None
            assert failed_session.published_source_attempt_id is None
            assert failed_session.published_at is None
            assert failed_session.verification_token is None
            assert _ingest_job_count(rollback_oracle, media_id=failure_candidate_id) == 0
        failure_db.rollback()
        remove_deferred_media_insert_failure(
            engine, trigger_name=trigger_name, function_name=function_name
        )
        trigger_name = ""
        function_name = ""
        converged = confirm_upload_session(
            failure_db,
            viewer_id=failure_user_id,
            session_handle=failure_created.session_handle,
            generation=1,
            request_id="commit-failure-replay",
            storage_client=storage,
        )
        assert converged.media_id == failure_candidate_id
        converged_file = failure_db.get(MediaFile, failure_candidate_id)
        assert converged_file is not None
        candidate_paths.add(converged_file.storage_path)
        assert (
            _ingest_job_count(
                failure_db,
                media_id=failure_candidate_id,
                attempt_id=converged.source_attempt_id,
            )
            == 1
        )
    finally:
        failure_db.rollback()
        if trigger_name and function_name:
            remove_deferred_media_insert_failure(
                engine, trigger_name=trigger_name, function_name=function_name
            )
        if failure_candidate_id is not None:
            _delete_storage_prefix(storage, f"media/{failure_candidate_id}/")
        cleanup_committed_upload_user(engine, user_id=failure_user_id)
        failure_db.close()
        for path in staged_paths | candidate_paths:
            storage.delete_object(path)
    orphaned_cleanup_job_ids = list(
        db_session.execute(
            text(
                """
                SELECT id
                FROM background_jobs
                WHERE kind = 'storage_object_cleanup'
                  AND payload->>'uploadSessionId' = ANY(CAST(:session_ids AS text[]))
                """
            ),
            {"session_ids": [str(session.id), str(rejected_session.id)]},
        ).scalars()
    )
    delete_jobs_by_ids(db_session, job_ids=orphaned_cleanup_job_ids)
    db_session.commit()


def test_published_source_survives_cleanup_settling_before_finalizer(
    committed_upload_support: tuple[Session, UserRecord],
    engine: Engine,
) -> None:
    db_session, test_user = committed_upload_support
    storage = get_storage_client()
    payload = b"%PDF-1.7\ncleanup finalizer race\n%%EOF"
    created = create_upload_session(
        db_session,
        viewer_id=test_user.id,
        request=_upload_request(filename="finalizer-race.pdf", size_bytes=len(payload)),
        request_id="finalizer-race-create",
        idempotency_key="finalizer-race",
        storage_client=storage,
    )
    session = db_session.execute(
        select(MediaUploadSession).where(
            MediaUploadSession.created_by_user_id == test_user.id,
            MediaUploadSession.idempotency_key == "finalizer-race",
        )
    ).scalar_one()
    staging_path = build_upload_session_staging_storage_path(session.id, 1, "pdf")
    storage.put_object(staging_path, payload, "application/pdf")

    publication_committed = Event()
    release_finalizer = Event()
    publish_results: list[tuple[UUID, UUID]] = []
    publish_errors: list[Exception] = []

    def confirm_while_cleanup_settles() -> None:
        with Session(engine, expire_on_commit=False) as publish_db:

            def hold_after_publication_commit(committed_db: Session) -> None:
                published_support = next(
                    (
                        value
                        for value in committed_db.identity_map.values()
                        if isinstance(value, MediaUploadSession)
                        and value.id == session.id
                        and value.published_at is not None
                    ),
                    None,
                )
                if published_support is None or publication_committed.is_set():
                    return
                publication_committed.set()
                if not release_finalizer.wait(timeout=20):
                    raise AssertionError("publication finalizer was never released")

            event.listen(publish_db, "after_commit", hold_after_publication_commit)
            try:
                published = confirm_upload_session(
                    publish_db,
                    viewer_id=test_user.id,
                    session_handle=created.session_handle,
                    generation=1,
                    request_id="finalizer-race-confirm",
                    storage_client=storage,
                )
                publish_results.append((published.media_id, published.source_attempt_id))
            except Exception as exc:  # noqa: BLE001 - surfaced in the parent proof thread.
                publish_errors.append(exc)

    publish_thread = Thread(
        target=confirm_while_cleanup_settles,
        name="upload-publication-finalizer-race",
    )
    publish_thread.start()
    candidate_path: str | None = None
    try:
        assert publication_committed.wait(timeout=20), "upload publication never committed"
        with Session(engine) as oracle:
            published_file = oracle.get(MediaFile, session.candidate_media_id)
            assert published_file is not None
            candidate_path = published_file.storage_path
            cleanup_job_id = oracle.scalar(
                text(
                    """
                    SELECT id
                    FROM background_jobs
                    WHERE kind = 'storage_object_cleanup'
                      AND payload->>'uploadSessionId' = :session_id
                      AND payload->>'storagePath' = :storage_path
                      AND status = 'pending'
                    """
                ),
                {"session_id": str(session.id), "storage_path": candidate_path},
            )
        assert cleanup_job_id is not None
        db_session.rollback()
        force_upload_cleanup_job_due(db_session, job_id=cleanup_job_id)
        assert _cleanup_worker(engine).run_exact(cleanup_job_id) is True
        assert storage.head_object(candidate_path) is not None
    finally:
        release_finalizer.set()
        publish_thread.join(timeout=20)

    assert not publish_thread.is_alive(), "upload publication finalizer did not finish"
    assert publish_errors == []
    assert len(publish_results) == 1
    assert publish_results[0][0] == session.candidate_media_id
    assert candidate_path is not None
    stored_bytes = b"".join(storage.stream_object(candidate_path))
    assert stored_bytes == payload
    with Session(engine) as oracle:
        published_file = oracle.get(MediaFile, session.candidate_media_id)
        assert published_file is not None
        assert published_file.storage_path == candidate_path
        assert published_file.source_sha256 == hashlib.sha256(stored_bytes).hexdigest()


def test_expired_verifier_candidate_cannot_overwrite_the_published_source(
    committed_upload_support: tuple[Session, UserRecord],
    engine: Engine,
) -> None:
    db_session, test_user = committed_upload_support
    storage = get_storage_client()
    stale_payload = b"%PDF-1.7\nstale verifier bytes\n%%EOF"
    winning_payload = b"%PDF-1.7\nfresh verifier bytes\n%%EOF"
    assert len(stale_payload) == len(winning_payload)
    request = _upload_request(filename="fenced.pdf", size_bytes=len(stale_payload))
    created = create_upload_session(
        db_session,
        viewer_id=test_user.id,
        request=request,
        request_id="fenced-create",
        idempotency_key="fenced-verification",
        storage_client=storage,
    )
    session = db_session.execute(
        select(MediaUploadSession).where(
            MediaUploadSession.created_by_user_id == test_user.id,
            MediaUploadSession.idempotency_key == "fenced-verification",
        )
    ).scalar_one()
    stale_staging_path = build_upload_session_staging_storage_path(session.id, 1, "pdf")
    storage.put_object(stale_staging_path, stale_payload, "application/pdf")

    copy_started = Event()
    release_copy = Event()
    blocking_storage = _BlockingCopyStorage(storage, copy_started, release_copy)
    stale_outcomes: list[str] = []
    stale_errors: list[Exception] = []

    def confirm_stale_candidate() -> None:
        with Session(engine, expire_on_commit=False) as stale_db:
            try:
                result = confirm_upload_session(
                    stale_db,
                    viewer_id=test_user.id,
                    session_handle=created.session_handle,
                    generation=1,
                    request_id="stale-verifier",
                    storage_client=cast(StorageClientBase, blocking_storage),
                )
                stale_outcomes.append(result.idempotency_outcome)
            except Exception as exc:  # noqa: BLE001 - surfaced in the parent proof thread.
                stale_errors.append(exc)

    stale_thread = Thread(target=confirm_stale_candidate, name="stale-upload-verifier")
    stale_thread.start()
    try:
        assert copy_started.wait(timeout=20), "stale verifier never reached its candidate copy"
        with Session(engine) as oracle:
            stale_token = oracle.scalar(
                select(MediaUploadSession.verification_token).where(
                    MediaUploadSession.id == session.id
                )
            )
        assert stale_token is not None
        stale_candidate_path = build_upload_verification_candidate_storage_path(
            session.candidate_media_id,
            stale_token,
            "pdf",
        )
        assert blocking_storage.destination_path == stale_candidate_path

        db_session.expire_all()
        retry = retry_upload_session(
            db_session,
            viewer_id=test_user.id,
            session_handle=created.session_handle,
            request=RetryUploadSessionRequest(
                filename="fenced.pdf",
                content_type="application/pdf",
                size_bytes=len(winning_payload),
            ),
            storage_client=storage,
        )
        assert retry.generation == 2
        winning_staging_path = build_upload_session_staging_storage_path(session.id, 2, "pdf")
        storage.put_object(winning_staging_path, winning_payload, "application/pdf")
        published = confirm_upload_session(
            db_session,
            viewer_id=test_user.id,
            session_handle=created.session_handle,
            generation=2,
            request_id="winning-verifier",
            storage_client=storage,
        )
        assert published.idempotency_outcome == "Created"
    finally:
        release_copy.set()
        stale_thread.join(timeout=20)

    assert not stale_thread.is_alive(), "stale verifier did not finish"
    assert stale_errors == []
    assert stale_outcomes == ["Reused"]
    db_session.expire_all()
    media_file = db_session.get(MediaFile, session.candidate_media_id)
    assert media_file is not None
    assert media_file.storage_path != stale_candidate_path
    winning_bytes = b"".join(storage.stream_object(media_file.storage_path))
    assert winning_bytes == winning_payload
    assert media_file.source_sha256 == hashlib.sha256(winning_bytes).hexdigest()
    assert b"".join(storage.stream_object(stale_candidate_path)) == stale_payload

    stale_cleanup_job_id = db_session.scalar(
        text(
            """
            SELECT id
            FROM background_jobs
            WHERE kind = 'storage_object_cleanup'
              AND payload->>'uploadSessionId' = :session_id
              AND payload->>'storagePath' = :storage_path
              AND status = 'pending'
            """
        ),
        {"session_id": str(session.id), "storage_path": stale_candidate_path},
    )
    assert stale_cleanup_job_id is not None
    force_upload_cleanup_job_due(db_session, job_id=stale_cleanup_job_id)
    assert _cleanup_worker(engine).run_exact(stale_cleanup_job_id) is True
    assert storage.head_object(stale_candidate_path) is None


def test_retry_capability_is_cleanup_fenced_before_concurrent_remove(
    committed_upload_support: tuple[Session, UserRecord],
    engine: Engine,
) -> None:
    db_session, test_user = committed_upload_support
    storage = get_storage_client()
    payload = b"%PDF-1.7\nlate retry upload bytes\n%%EOF"
    created = create_upload_session(
        db_session,
        viewer_id=test_user.id,
        request=_upload_request(filename="retry-remove.pdf", size_bytes=len(payload)),
        request_id="retry-remove-create",
        idempotency_key="retry-remove",
        storage_client=storage,
    )
    session = db_session.execute(
        select(MediaUploadSession).where(
            MediaUploadSession.created_by_user_id == test_user.id,
            MediaUploadSession.idempotency_key == "retry-remove",
        )
    ).scalar_one()
    generation_paths = {
        generation: build_upload_session_staging_storage_path(session.id, generation, "pdf")
        for generation in (1, 2)
    }
    sign_issued = Event()
    return_sign = Event()
    blocking_storage = _BlockingSignStorage(storage, sign_issued, return_sign)
    retry_results: list[int] = []
    retry_errors: list[Exception] = []

    def retry_while_removing() -> None:
        with Session(engine, expire_on_commit=False) as retry_db:
            try:
                result = retry_upload_session(
                    retry_db,
                    viewer_id=test_user.id,
                    session_handle=created.session_handle,
                    request=RetryUploadSessionRequest(
                        filename="retry-remove.pdf",
                        content_type="application/pdf",
                        size_bytes=len(payload),
                    ),
                    storage_client=cast(StorageClientBase, blocking_storage),
                )
                retry_results.append(result.generation)
            except Exception as exc:  # noqa: BLE001 - surfaced in the parent proof thread.
                retry_errors.append(exc)

    retry_thread = Thread(target=retry_while_removing, name="retry-while-removing-upload")
    retry_thread.start()
    cleanup_job_ids: list[UUID] = []
    generation_two_expires_at: datetime | None = None
    try:
        assert sign_issued.wait(timeout=20), "retry never minted its generation-2 capability"
        assert blocking_storage.issued_paths == [generation_paths[2]]
        with Session(engine) as oracle:
            generation_two_expires_at = oracle.scalar(
                select(MediaUploadSession.upload_url_expires_at).where(
                    MediaUploadSession.id == session.id
                )
            )
        assert generation_two_expires_at is not None

        delete_upload_session(
            db_session,
            viewer_id=test_user.id,
            session_handle=created.session_handle,
        )
        assert db_session.get(MediaUploadSession, session.id) is None
    finally:
        return_sign.set()
        retry_thread.join(timeout=20)

    try:
        assert not retry_thread.is_alive(), "retry did not finish after removal"
        assert retry_errors == []
        assert retry_results == [2]
        cleanup_jobs = list(
            db_session.execute(
                text(
                    """
                    SELECT id, payload, available_at
                    FROM background_jobs
                    WHERE kind = 'storage_object_cleanup'
                      AND payload->>'uploadSessionId' = :session_id
                      AND status IN ('pending', 'running')
                    ORDER BY payload->>'storagePath'
                    """
                ),
                {"session_id": str(session.id)},
            ).mappings()
        )
        cleanup_job_ids = [row["id"] for row in cleanup_jobs]
        assert {row["payload"]["storagePath"] for row in cleanup_jobs} == set(
            generation_paths.values()
        )
        assert generation_two_expires_at is not None
        settings = get_settings()
        assert (
            settings.storage_object_cleanup_write_window_seconds > DIRECT_UPLOAD_PUT_TIMEOUT_SECONDS
        )
        expected_landing_fence = generation_two_expires_at + timedelta(
            seconds=settings.storage_object_cleanup_write_window_seconds
        )
        for cleanup_job in cleanup_jobs:
            retain_until = datetime.fromisoformat(cleanup_job["payload"]["retainUntil"])
            write_may_land_until = datetime.fromisoformat(
                cleanup_job["payload"]["writeMayLandUntil"]
            )
            assert cleanup_job["available_at"] >= max(retain_until, write_may_land_until)
            assert retain_until >= expected_landing_fence

        # The capability was already minted when removal linearized. Its late PUT
        # lands only after an early cleanup attempt observes the durable future fence.
        generation_two_job = next(
            row for row in cleanup_jobs if row["payload"]["storagePath"] == generation_paths[2]
        )
        cleanup_worker = _cleanup_worker(engine)
        make_upload_cleanup_job_available_before_its_fence(
            db_session,
            job_id=generation_two_job["id"],
        )
        assert cleanup_worker.run_exact(generation_two_job["id"]) is True
        rescheduled_not_before = db_session.execute(
            text("SELECT available_at FROM background_jobs WHERE id = :job_id"),
            {"job_id": generation_two_job["id"]},
        ).scalar_one()
        assert rescheduled_not_before >= expected_landing_fence
        assert storage.head_object(generation_paths[2]) is None
        storage.put_object(generation_paths[2], payload, "application/pdf")
        assert storage.head_object(generation_paths[2]) is not None
        for cleanup_job_id in cleanup_job_ids:
            force_upload_cleanup_job_due(db_session, job_id=cleanup_job_id)
            assert cleanup_worker.run_exact(cleanup_job_id) is True
        assert all(storage.head_object(path) is None for path in generation_paths.values())
    finally:
        for path in generation_paths.values():
            storage.delete_object(path)
        if not cleanup_job_ids:
            cleanup_job_ids = list(
                db_session.execute(
                    text(
                        """
                        SELECT id
                        FROM background_jobs
                        WHERE kind = 'storage_object_cleanup'
                          AND payload->>'uploadSessionId' = :session_id
                        """
                    ),
                    {"session_id": str(session.id)},
                ).scalars()
            )
        delete_jobs_by_ids(db_session, job_ids=cleanup_job_ids)
        db_session.commit()
