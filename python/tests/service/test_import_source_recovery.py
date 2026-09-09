"""Source recovery admission against the real queue, worker, and PDF adapter.

Queue state and domain state are two machines: a dead ``ingest_media_source``
job repairs only while its attempt is still nonterminal, and a terminally
failed attempt recovers only through a new attempt. Every scenario publishes a
real upload, so the worker runs the real ``uploaded_pdf_file`` adapter against
real PostgreSQL and MinIO.
"""

from __future__ import annotations

import dataclasses
import threading
from collections.abc import Iterator, Mapping
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import fitz
import pytest
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from nexus.db.models import Media, MediaSourceAttempt
from nexus.db.session import create_session_factory, transaction
from nexus.errors import ApiError, ApiErrorCode
from nexus.jobs.history_projections import RetryScheduled, apply_history_projection
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    RescheduleRequested,
    ScheduleAfter,
    claim_job,
    fail_job,
    get_job,
)
from nexus.jobs.registry import get_default_registry
from nexus.jobs.worker import JobWorker
from nexus.schemas.import_history import MediaHistoryOwner
from nexus.schemas.presence import absent, present
from nexus.services import library_entries, media_deletion
from nexus.services.capabilities import ViewerRecovery
from nexus.services.content_indexing import request_media_content_reindex
from nexus.services.media import list_media_for_viewer_by_ids
from nexus.services.media_source_ingest import (
    accept_embedded_source,
    complete_x_post_snapshot_attempt,
    enqueue_accepted_source_attempt_in_transaction,
    repair_dead_source_execution,
    retry_source_for_viewer,
)
from nexus.services.media_upload_sessions import confirm_upload_session, create_upload_session
from nexus.services.reader_publication import replace_reader_publication
from nexus.services.sealed_handles import unseal_upload_session
from nexus.services.source_attempt_failures import (
    ResourceLimitedSourceAttempt,
    SourceAttemptFailure,
    publish_resource_limited_source_attempt,
    publish_source_attempt_failure,
)
from nexus.services.x_identity import canonical_x_post_url
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_upload_session_staging_storage_path
from tests.testkit.auth import UserRecord
from tests.testkit.unreachable_state import (
    delete_jobs_by_ids,
    expire_heavy_job_claim,
    forget_job_execution_id,
    make_failed_job_retryable,
    make_pending_job_due,
    read_events,
    retarget_job_kind,
    set_pending_job_max_attempts,
)
from tests.testkit.upload_sessions import ingest_job_count, upload_request

_SOURCE_KIND = "ingest_media_source"


def _raise_execution_failure(*, payload: Mapping[str, Any], context: JobExecutionContext) -> None:
    raise RuntimeError("synthetic execution failure before any source work")


def _request_reschedule(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> RescheduleRequested:
    return RescheduleRequested(schedule=ScheduleAfter(seconds=600))


def _crash_after_publication(*, payload: Mapping[str, Any], context: JobExecutionContext) -> None:
    from nexus.tasks.ingest_media_source import ingest_media_source

    ingest_media_source(
        media_id=str(payload["media_id"]),
        attempt_id=str(payload["attempt_id"]),
        actor_user_id=str(payload["actor_user_id"]),
        request_id=None,
        context=context,
    )
    raise RuntimeError("synthetic crash after the source publication committed")


def _worker(
    engine: Engine, *, handler_path: str | None = None, kind: str = _SOURCE_KIND
) -> JobWorker:
    """The real source worker, restricted to one kind. ``kind`` names a private
    probe kind when the proof drives the scanning reaper, which would otherwise
    reach every due ingest row in the shared run database."""
    definition = get_default_registry()[_SOURCE_KIND]
    definition = dataclasses.replace(
        definition, kind=kind, handler_path=handler_path or definition.handler_path
    )
    return JobWorker(
        session_factory=create_session_factory(engine),
        worker_id=f"source-recovery-{uuid4()}",
        registry={definition.kind: definition},
        allowed_kinds=(definition.kind,),
    )


def _small_pdf() -> bytes:
    document = fitz.open()
    for body in ("First page", "Second page"):
        document.new_page().insert_text((72, 72), body)
    payload = document.tobytes()
    document.close()
    return payload


@dataclasses.dataclass(frozen=True, slots=True)
class _PublishedImport:
    media_id: UUID
    attempt_id: UUID
    job_id: UUID


def _publish_small_pdf(db: Session, user: UserRecord, *, label: str) -> _PublishedImport:
    payload = _small_pdf()
    storage = get_storage_client()
    created = create_upload_session(
        db,
        viewer_id=user.id,
        request=upload_request(filename=f"{label}.pdf", size_bytes=len(payload)),
        request_id=f"{label}-create",
        idempotency_key=f"{label}-{uuid4()}",
        storage_client=storage,
    )
    assert created.kind == "UploadRequired"
    session_id = unseal_upload_session(created.session_handle)
    storage.put_object(
        build_upload_session_staging_storage_path(session_id, created.generation, "pdf"),
        payload,
        "application/pdf",
    )
    published = confirm_upload_session(
        db,
        viewer_id=user.id,
        session_handle=created.session_handle,
        generation=created.generation,
        request_id=f"{label}-confirm",
        storage_client=storage,
    )
    attempt = db.get(MediaSourceAttempt, published.source_attempt_id)
    assert attempt is not None and attempt.job_id is not None, "publication did not enqueue"
    return _PublishedImport(
        media_id=published.media_id, attempt_id=attempt.id, job_id=attempt.job_id
    )


def _job(db: Session, job_id: UUID) -> JobRow:
    job = get_job(db, job_id)
    assert job is not None, f"queue row {job_id} disappeared"
    return job


def _attempt(db: Session, attempt_id: UUID) -> MediaSourceAttempt:
    db.expire_all()
    attempt = db.get(MediaSourceAttempt, attempt_id)
    assert attempt is not None, f"source attempt {attempt_id} disappeared"
    return attempt


def _media(db: Session, media_id: UUID) -> Media:
    db.expire_all()
    media = db.get(Media, media_id)
    assert media is not None, f"media {media_id} disappeared"
    return media


def _history(db: Session, media_id: UUID) -> list[tuple[str, str | None, str | None, dict]]:
    return [
        (event["event_type"], event["stage"], event["failure_code"], dict(event["payload"]))
        for event in read_events(db, owner=MediaHistoryOwner(media_id=media_id))
    ]


@pytest.fixture
def import_owner(
    committed_upload_support: tuple[Session, UserRecord], engine: Engine
) -> Iterator[tuple[Session, UserRecord]]:
    """One committed user whose published document media are torn down by their owner."""
    db, user = committed_upload_support
    yield db, user
    db.rollback()
    storage = get_storage_client()
    with Session(engine) as cleanup:
        media_ids = list(
            cleanup.scalars(select(Media.id).where(Media.created_by_user_id == user.id))
        )
        for media_id in media_ids:
            with transaction(cleanup):
                library_entries.delete_all_entries_for_media(cleanup, media_id)
                paths = media_deletion.delete_document_media_if_unreferenced(cleanup, media_id)
            media_deletion.delete_document_storage_objects(paths or [], storage)


def test_terminal_source_failure_retries_through_one_new_attempt_the_worker_completes(
    import_owner: tuple[Session, UserRecord], engine: Engine
) -> None:
    db, user = import_owner
    first = _publish_small_pdf(db, user, label="terminal-retry")
    publish_source_attempt_failure(
        db,
        SourceAttemptFailure(
            media_id=first.media_id,
            attempt_id=first.attempt_id,
            failure_stage="extract",
            error_code="E_INGEST_FAILED",
            error_message="enqueue-time failure recorded by the owner",
            retry_after_seconds=None,
            now=datetime.now(UTC),
            execution_id=absent(),
        ),
    )
    db.commit()
    # The queue row of a terminally failed attempt settles as a superseded success:
    # queue success never implies source success, and the fence loss records nothing.
    assert _worker(engine).run_exact(first.job_id) is True
    assert _job(db, first.job_id).status == "succeeded"
    assert _attempt(db, first.attempt_id).status == "failed"

    command = str(uuid4())
    admission = retry_source_for_viewer(
        db,
        viewer_id=user.id,
        media_id=first.media_id,
        client_mutation_id=command,
        expected_attempt_id=first.attempt_id,
        request_id="terminal-retry",
    )
    assert admission.kind == "SourceRetry" and admission.media_id == first.media_id
    retry_attempt = _attempt(db, admission.source_attempt_id)
    assert (retry_attempt.attempt_no, retry_attempt.status, retry_attempt.job_id) == (
        2,
        "queued",
        admission.job_id,
    ), f"retry admission did not bind one queued attempt: {retry_attempt!r}"
    assert ingest_job_count(db, media_id=first.media_id, attempt_id=retry_attempt.id) == 1
    assert _media(db, first.media_id).processing_status.value == "extracting"

    replayed = retry_source_for_viewer(
        db,
        viewer_id=user.id,
        media_id=first.media_id,
        client_mutation_id=command,
        expected_attempt_id=first.attempt_id,
        request_id="terminal-retry-replay",
    )
    assert replayed == admission, "an exact replay must return the original admission"
    with pytest.raises(ApiError) as stale:
        retry_source_for_viewer(
            db,
            viewer_id=user.id,
            media_id=first.media_id,
            client_mutation_id=str(uuid4()),
            expected_attempt_id=first.attempt_id,
            request_id="terminal-retry-stale",
        )
    assert stale.value.code is ApiErrorCode.E_RESOURCE_CONFLICT
    assert stale.value.details == {"current": {"attempt_id": str(retry_attempt.id)}}
    assert ingest_job_count(db, media_id=first.media_id) == 2, (
        "a replayed or stale command created extra source work"
    )

    assert _worker(engine).run_exact(admission.job_id) is True
    assert _attempt(db, retry_attempt.id).status == "succeeded"
    media = _media(db, first.media_id)
    assert media.processing_status.value == "ready_for_reading"
    assert "First page" in str(media.plain_text)

    execution_id = _job(db, admission.job_id).execution_id
    assert execution_id is not None
    history = _history(db, first.media_id)
    assert [(kind, stage, code) for kind, stage, code, _ in history] == [
        ("Accepted", "Validate", None),
        ("Failed", "Validate", "E_INGEST_FAILED"),
        ("Accepted", "Validate", None),
        ("RecoveryAccepted", "Validate", None),
        ("ExecutionStarted", "Validate", None),
        ("StageChanged", "Extract", None),
        ("StageChanged", "Finalize", None),
        ("Succeeded", "Finalize", None),
        ("Accepted", "Index", None),
    ], f"history does not narrate the retry: {history}"
    assert history[1][3] == {
        "source_attempt_id": str(first.attempt_id),
        "execution_id": {"kind": "Absent"},
        "origin": "Domain",
        "terminal": True,
        "progress": {"kind": "Absent"},
    }
    assert history[3][3] == {
        "source_attempt_id": str(first.attempt_id),
        "recovery": {"kind": "RetrySource", "new_source_attempt_id": str(retry_attempt.id)},
    }
    assert history[7][3] == {
        "source_attempt_id": str(retry_attempt.id),
        "execution_id": {"kind": "Present", "value": str(execution_id)},
    }


def test_dead_execution_repairs_the_same_job_and_the_worker_reruns_it(
    import_owner: tuple[Session, UserRecord], engine: Engine
) -> None:
    db, user = import_owner
    first = _publish_small_pdf(db, user, label="dead-repair")
    set_pending_job_max_attempts(db, job_id=first.job_id, max_attempts=1)
    db.commit()
    failing = _worker(
        engine, handler_path="tests.service.test_import_source_recovery:_raise_execution_failure"
    )
    assert failing.run_exact(first.job_id) is True
    dead = _job(db, first.job_id)
    assert (dead.status, dead.error_code) == ("dead", "E_WORKER_HANDLER_FAILED")
    assert _attempt(db, first.attempt_id).status == "queued"
    first_execution_id = dead.execution_id
    assert first_execution_id is not None, "the claim did not allocate an execution identity"

    projected = list_media_for_viewer_by_ids(db, user.id, [first.media_id])[0]
    assert projected.processing_status == "suspended"
    assert projected.capabilities.can_repair_source is True
    assert projected.capabilities.can_retry is False

    actor = ViewerRecovery(viewer_id=user.id, is_admin=False, client_mutation_id=str(uuid4()))
    with pytest.raises(ApiError) as foreign_job:
        repair_dead_source_execution(
            db,
            actor=actor,
            media_id=first.media_id,
            expected_attempt_id=first.attempt_id,
            expected_job_id=uuid4(),
        )
    assert foreign_job.value.code is ApiErrorCode.E_RESOURCE_CONFLICT
    assert foreign_job.value.details == {
        "current": {"attempt_id": str(first.attempt_id), "job_id": str(first.job_id)}
    }
    assert _job(db, first.job_id).status == "dead", "a stale command mutated the dead job"

    admission = repair_dead_source_execution(
        db,
        actor=actor,
        media_id=first.media_id,
        expected_attempt_id=first.attempt_id,
        expected_job_id=first.job_id,
    )
    assert (admission.kind, admission.source_attempt_id, admission.job_id) == (
        "SourceRepair",
        first.attempt_id,
        first.job_id,
    )
    requeued = _job(db, first.job_id)
    assert (requeued.status, requeued.attempts) == ("pending", 0)
    assert (
        repair_dead_source_execution(
            db,
            actor=actor,
            media_id=first.media_id,
            expected_attempt_id=first.attempt_id,
            expected_job_id=first.job_id,
        )
        == admission
    )
    assert ingest_job_count(db, media_id=first.media_id) == 1, "repair created a second job"

    assert _worker(engine).run_exact(first.job_id) is True
    assert _attempt(db, first.attempt_id).status == "succeeded"
    assert _media(db, first.media_id).processing_status.value == "ready_for_reading"
    rerun_execution_id = _job(db, first.job_id).execution_id
    assert rerun_execution_id not in (None, first_execution_id), (
        "the repaired execution must carry a fresh execution identity"
    )

    history = _history(db, first.media_id)
    assert [(kind, stage, code) for kind, stage, code, _ in history] == [
        ("Accepted", "Validate", None),
        ("Failed", "Validate", "E_WORKER_HANDLER_FAILED"),
        ("RecoveryAccepted", "Validate", None),
        ("ExecutionStarted", "Validate", None),
        ("StageChanged", "Extract", None),
        ("StageChanged", "Finalize", None),
        ("Succeeded", "Finalize", None),
        ("Accepted", "Index", None),
    ], f"history does not narrate the repair: {history}"
    assert history[1][3] == {
        "source_attempt_id": str(first.attempt_id),
        "execution_id": {"kind": "Present", "value": str(first_execution_id)},
        "origin": "Execution",
        "terminal": True,
        "progress": {"kind": "Absent"},
    }
    assert history[2][3] == {
        "source_attempt_id": str(first.attempt_id),
        "recovery": {"kind": "RepairSource", "job_id": str(first.job_id)},
    }
    assert history[3][3] == {
        "source_attempt_id": str(first.attempt_id),
        "execution_id": str(rerun_execution_id),
    }


def test_succeeded_attempt_with_a_later_dead_job_is_complete_and_unrepairable(
    import_owner: tuple[Session, UserRecord], engine: Engine
) -> None:
    db, user = import_owner
    first = _publish_small_pdf(db, user, label="published-then-dead")
    set_pending_job_max_attempts(db, job_id=first.job_id, max_attempts=1)
    db.commit()
    crashing = _worker(
        engine, handler_path="tests.service.test_import_source_recovery:_crash_after_publication"
    )
    assert crashing.run_exact(first.job_id) is True
    assert _job(db, first.job_id).status == "dead"
    attempt = _attempt(db, first.attempt_id)
    assert (attempt.status, attempt.job_id) == ("succeeded", first.job_id)
    assert _media(db, first.media_id).processing_status.value == "ready_for_reading"

    projected = list_media_for_viewer_by_ids(db, user.id, [first.media_id])[0]
    assert projected.processing_status == "ready_for_reading", (
        "a published source with a later dead job is complete, not suspended"
    )
    assert projected.capabilities.can_repair_source is False
    assert projected.capabilities.can_retry is False

    with pytest.raises(ApiError) as refused:
        repair_dead_source_execution(
            db,
            actor=ViewerRecovery(viewer_id=user.id, is_admin=True, client_mutation_id=str(uuid4())),
            media_id=first.media_id,
            expected_attempt_id=first.attempt_id,
            expected_job_id=first.job_id,
        )
    assert refused.value.code is ApiErrorCode.E_REPAIR_NOT_ALLOWED
    assert _job(db, first.job_id).status == "dead", "a refused repair requeued the dead job"


def _next_attempt_at(payload: dict[str, Any]) -> datetime:
    return datetime.fromisoformat(str(payload["next_attempt_at"]))


def test_handler_failure_schedules_a_retry_without_waiting_on_the_owners_media_lock(
    import_owner: tuple[Session, UserRecord], engine: Engine
) -> None:
    """The seam's history insert takes the media FK's KEY SHARE inside the queue
    transition, while a publishing owner holds the media row and then locks that
    media's queue rows; the owner's lock mode must admit the share or the two
    deadlock. The failed transition records the execution failure and the retry."""
    db, user = import_owner
    first = _publish_small_pdf(db, user, label="retry-scheduled")
    failing = _worker(
        engine, handler_path="tests.service.test_import_source_recovery:_raise_execution_failure"
    )
    outcomes: list[bool] = []
    transition = threading.Thread(target=lambda: outcomes.append(failing.run_exact(first.job_id)))
    with Session(engine) as owner:
        request_media_content_reindex(
            owner, media_id=first.media_id, reason="source_success", request_id=None
        )
        transition.start()
        transition.join(timeout=30)
        settled = not transition.is_alive()
        owner.rollback()
    transition.join()
    assert settled, "the failed queue transition waited on the owner's media lock"
    assert outcomes == [True]
    job = _job(db, first.job_id)
    assert (job.status, job.attempts, job.error_code) == (
        "failed",
        1,
        "E_WORKER_HANDLER_FAILED",
    )
    history = _history(db, first.media_id)
    assert [(kind, stage, code) for kind, stage, code, _ in history] == [
        ("Accepted", "Validate", None),
        ("Failed", "Validate", "E_WORKER_HANDLER_FAILED"),
        ("RetryScheduled", "Validate", None),
    ], f"history does not narrate the scheduled retry: {history}"
    assert history[1][3] == {
        "source_attempt_id": str(first.attempt_id),
        "execution_id": {"kind": "Present", "value": str(job.execution_id)},
        "origin": "Execution",
        "terminal": False,
        "progress": {"kind": "Absent"},
    }
    assert history[2][3]["execution_id"] == {"kind": "Present", "value": str(job.execution_id)}
    assert _next_attempt_at(history[2][3]) == job.available_at, (
        "the recorded next attempt is not the queue's available_at"
    )

    make_failed_job_retryable(db, job_id=first.job_id)
    db.commit()
    assert _worker(engine).run_exact(first.job_id) is True
    assert _attempt(db, first.attempt_id).status == "succeeded"
    assert _job(db, first.job_id).execution_id != job.execution_id


def test_a_quote_completion_settles_beside_its_running_ingest_transition(
    import_owner: tuple[Session, UserRecord], engine: Engine
) -> None:
    """The X-thread phase completes an embedded quote's in-flight attempt while it
    holds that quote media ``FOR UPDATE``; the quote's own worker holds the queue
    row it is failing and needs the media's ``KEY SHARE`` for the seam's history
    insert. The completion must read the attempt's queue rows without locking
    them: locking the running row closes the cycle and PostgreSQL kills one side.
    """
    db, user = import_owner
    parent = _publish_small_pdf(db, user, label="x-quote-parent")
    post_id = str(uuid4().int % 10**18)
    quote_url = canonical_x_post_url(post_id)
    accepted = accept_embedded_source(
        db=db,
        viewer_id=user.id,
        url=quote_url,
        parent_media_id=parent.media_id,
        document_embed_key=f"x-quote-post:{post_id}",
        library_ids=[],
        request_id=None,
    )
    enqueue_accepted_source_attempt_in_transaction(
        db,
        media_id=accepted.media_id,
        attempt_id=accepted.source_attempt_id,
        actor_user_id=user.id,
        request_id=None,
    )
    db.commit()
    quote_job_id = _attempt(db, accepted.source_attempt_id).job_id
    assert quote_job_id is not None, "the accepted quote attempt bound no ingest job"

    quote_media_locked = threading.Event()
    completions: list[str] = []

    def complete_the_quote_under_its_media_lock() -> None:
        def hold(locked: Media) -> Media:
            quote_media_locked.set()
            return locked

        with Session(engine) as phase:
            quote_media = replace_reader_publication(
                phase,
                media_id=accepted.media_id,
                expected_kind="web_article",
                replace_projection=hold,
            )
            complete_x_post_snapshot_attempt(
                phase,
                media=quote_media,
                source_attempt_id=accepted.source_attempt_id,
                viewer_id=user.id,
                post_id=post_id,
                canonical_url=quote_url,
                request_id=None,
            )
            phase.commit()
            completions.append("completed")

    thread_phase = threading.Thread(target=complete_the_quote_under_its_media_lock)
    try:
        claimed = claim_job(
            db,
            job_id=quote_job_id,
            worker_id="x-quote-worker",
            lease_seconds=300,
            heavy_kinds=(_SOURCE_KIND,),
        )
        assert claimed is not None
        db.commit()
        with Session(engine) as worker:
            # The worker's own failure transition: fail_job holds the queue row and
            # the seam records the outcome in that same transaction, exactly as
            # worker.py settles a handler failure.
            assert (
                fail_job(
                    worker,
                    job_id=quote_job_id,
                    worker_id="x-quote-worker",
                    attempt_no=claimed.job.attempts,
                    error_code="E_WORKER_HANDLER_FAILED",
                    error_message="synthetic quote execution failure",
                    retry_delays_seconds=(60,),
                )
                == "failed"
            )
            failing = _job(worker, quote_job_id)
            thread_phase.start()
            try:
                assert quote_media_locked.wait(timeout=30), (
                    "the thread phase never locked the quote media"
                )
                apply_history_projection(
                    worker,
                    projection="SourceAttempt",
                    job=failing,
                    outcome=RetryScheduled(
                        next_attempt_at=failing.available_at,
                        error_code="E_WORKER_HANDLER_FAILED",
                    ),
                )
                worker.commit()
            finally:
                thread_phase.join(timeout=30)
        assert completions == ["completed"], (
            "the quote completion never settled beside its running job's failed transition"
        )

        completed = _attempt(db, accepted.source_attempt_id)
        assert (completed.status, completed.error_code) == ("succeeded", None)
        assert _job(db, quote_job_id).status == "failed"
        history = _history(db, accepted.media_id)
        assert [(kind, stage, code) for kind, stage, code, _ in history] == [
            ("Accepted", "SourceProcessing", None),
            ("Failed", "SourceProcessing", "E_WORKER_HANDLER_FAILED"),
            ("RetryScheduled", "SourceProcessing", None),
            ("Succeeded", "SourceProcessing", None),
        ], f"history does not narrate the completion beside the failed execution: {history}"
        assert history[3][3] == {
            "source_attempt_id": str(accepted.source_attempt_id),
            "execution_id": {"kind": "Absent"},
        }
    finally:
        db.rollback()
        delete_jobs_by_ids(db, job_ids=(parent.job_id, quote_job_id))
        db.commit()


def test_expired_claims_record_the_displaced_execution_then_the_terminal_interruption(
    import_owner: tuple[Session, UserRecord], engine: Engine
) -> None:
    db, user = import_owner
    first = _publish_small_pdf(db, user, label="reclaim")
    displaced = claim_job(
        db,
        job_id=first.job_id,
        worker_id="displaced-worker",
        lease_seconds=300,
        heavy_kinds=(_SOURCE_KIND,),
    )
    assert displaced is not None and displaced.interrupted is None
    displaced_execution_id = displaced.job.execution_id
    assert displaced_execution_id is not None
    expire_heavy_job_claim(db, job_id=first.job_id)
    db.commit()

    failing = _worker(
        engine, handler_path="tests.service.test_import_source_recovery:_raise_execution_failure"
    )
    assert failing.run_exact(first.job_id) is True
    reclaimed = _job(db, first.job_id)
    assert (reclaimed.status, reclaimed.attempts) == ("failed", 2)
    assert reclaimed.execution_id not in (None, displaced_execution_id)

    # A running row claimed before execution identity existed names no execution;
    # its exhausted lease dead-letters through the worker's own reaper.
    make_failed_job_retryable(db, job_id=first.job_id)
    db.commit()
    assert (
        claim_job(
            db,
            job_id=first.job_id,
            worker_id="pre-cut-worker",
            lease_seconds=300,
            heavy_kinds=(_SOURCE_KIND,),
        )
        is not None
    )
    forget_job_execution_id(db, job_id=first.job_id)
    expire_heavy_job_claim(db, job_id=first.job_id)
    db.commit()
    reaper_kind = "import_source_recovery_expired_lease_probe"
    retarget_job_kind(db, job_id=first.job_id, kind=reaper_kind)
    db.commit()
    reaper = _worker(engine, kind=reaper_kind)
    assert reaper.run_once() is True, "no expired exhausted claim was dead-lettered"
    dead = _job(db, first.job_id)
    assert (dead.status, dead.error_code, dead.execution_id) == (
        "dead",
        "E_WORKER_INTERRUPTED",
        None,
    )

    history = _history(db, first.media_id)
    assert [(kind, stage, code) for kind, stage, code, _ in history] == [
        ("Accepted", "Validate", None),
        ("Failed", "Validate", "E_WORKER_INTERRUPTED"),
        ("Failed", "Validate", "E_WORKER_HANDLER_FAILED"),
        ("RetryScheduled", "Validate", None),
        ("Failed", "Validate", "E_WORKER_INTERRUPTED"),
    ], f"history does not narrate the interruptions: {history}"
    assert history[1][3] == {
        "source_attempt_id": str(first.attempt_id),
        "execution_id": {"kind": "Present", "value": str(displaced_execution_id)},
        "origin": "Execution",
        "terminal": False,
        "progress": {"kind": "Absent"},
    }
    assert history[2][3]["execution_id"] == {
        "kind": "Present",
        "value": str(reclaimed.execution_id),
    }
    assert history[4][3] == {
        "source_attempt_id": str(first.attempt_id),
        "execution_id": {"kind": "Absent"},
        "origin": "Execution",
        "terminal": True,
        "progress": {"kind": "Absent"},
    }


def test_a_rescheduled_execution_records_its_next_attempt(
    import_owner: tuple[Session, UserRecord], engine: Engine
) -> None:
    db, user = import_owner
    first = _publish_small_pdf(db, user, label="reschedule")
    waiting = _worker(
        engine, handler_path="tests.service.test_import_source_recovery:_request_reschedule"
    )
    assert waiting.run_exact(first.job_id) is True
    job = _job(db, first.job_id)
    assert (job.status, job.attempts, job.claimed_by) == ("pending", 0, None)
    assert job.execution_id is not None
    history = _history(db, first.media_id)
    assert [(kind, stage, code) for kind, stage, code, _ in history] == [
        ("Accepted", "Validate", None),
        ("RetryScheduled", "Validate", None),
    ], f"history does not narrate the reschedule: {history}"
    assert history[1][3]["execution_id"] == {"kind": "Present", "value": str(job.execution_id)}
    assert _next_attempt_at(history[1][3]) == job.available_at

    make_pending_job_due(db, job_id=first.job_id)
    db.commit()
    assert _worker(engine).run_exact(first.job_id) is True
    assert _attempt(db, first.attempt_id).status == "succeeded"


def test_refresh_stays_refused_for_a_failed_attempt_with_a_dead_resource_limit_job(
    import_owner: tuple[Session, UserRecord], engine: Engine
) -> None:
    db, user = import_owner
    first = _publish_small_pdf(db, user, label="resource-limited")
    set_pending_job_max_attempts(db, job_id=first.job_id, max_attempts=1)
    db.commit()
    claimed = claim_job(
        db,
        job_id=first.job_id,
        worker_id="resource-limit-worker",
        lease_seconds=300,
        heavy_kinds=(_SOURCE_KIND,),
    )
    assert claimed is not None
    publish_resource_limited_source_attempt(
        db,
        ResourceLimitedSourceAttempt(
            media_id=first.media_id,
            attempt_id=first.attempt_id,
            dimension="Memory",
            execution_id=present(claimed.job.execution_id),
        ),
    )
    assert (
        fail_job(
            db,
            job_id=first.job_id,
            worker_id="resource-limit-worker",
            attempt_no=claimed.job.attempts,
            error_code="E_RESOURCE_LIMIT",
            error_message="bounded",
            retry_delays_seconds=(),
        )
        == "dead"
    )
    db.commit()

    projected = list_media_for_viewer_by_ids(db, user.id, [first.media_id])[0]
    assert projected.processing_status == "failed"
    assert projected.capabilities.can_refresh_source is False
    assert projected.capabilities.can_retry is False
    assert projected.capabilities.can_repair_source is False
    history = _history(db, first.media_id)
    assert [(kind, stage, code) for kind, stage, code, _ in history] == [
        ("Accepted", "Validate", None),
        ("Failed", "Validate", "E_RESOURCE_LIMIT"),
    ]
    assert history[1][3]["origin"] == "Domain" and history[1][3]["terminal"] is True
    assert history[1][3]["execution_id"] == {
        "kind": "Present",
        "value": str(claimed.job.execution_id),
    }
