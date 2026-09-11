"""Search-index repair against the real queue, worker, and reindex job.

A dead ``media_content_reindex_job`` is repairable only while it is the exact
job of the current index revision; repair requeues that one job and never
touches the published source rows. The rerun crosses the real claim, fences,
and publication; only the embedding provider (an external call the service
runtime cannot reach) is a deterministic local function.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Iterator, Mapping
from typing import Any
from uuid import UUID, uuid4

import fitz
import pytest
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from nexus.db.models import Media, MediaFile, MediaSourceAttempt
from nexus.db.session import create_session_factory, transaction
from nexus.errors import ApiError, ApiErrorCode
from nexus.jobs.queue import JobExecutionContext, JobRow, find_nonterminal_jobs_for_payload, get_job
from nexus.jobs.registry import get_default_registry
from nexus.jobs.worker import JobWorker
from nexus.schemas.import_history import MediaHistoryOwner
from nexus.services import library_entries, media_deletion
from nexus.services.capabilities import ViewerRecovery
from nexus.services.content_indexing import repair_dead_media_reindex
from nexus.services.media import list_media_for_viewer_by_ids
from nexus.services.media_upload_sessions import confirm_upload_session, create_upload_session
from nexus.services.sealed_handles import unseal_upload_session
from nexus.services.semantic_chunks import (
    current_transcript_embedding_model,
    transcript_embedding_dimensions,
)
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_upload_session_staging_storage_path
from nexus.tasks.media_content_reindex import run_media_content_reindex
from tests.testkit.auth import UserRecord
from tests.testkit.unreachable_state import (
    read_content_index_state,
    read_events,
    set_pending_job_max_attempts,
    supersede_content_index_revision,
)
from tests.testkit.upload_sessions import upload_request

_SOURCE_KIND = "ingest_media_source"
_INDEX_KIND = "media_content_reindex_job"


def _raise_execution_failure(*, payload: Mapping[str, Any], context: JobExecutionContext) -> None:
    raise RuntimeError("synthetic execution failure before any index work")


def _deterministic_embeddings(texts: list[str]) -> tuple[str, list[list[float]]]:
    dimensions = transcript_embedding_dimensions()
    return (
        current_transcript_embedding_model(),
        [[float(index % 7) / 7 for index in range(dimensions)] for _ in texts],
    )


def _reindex_with_local_embeddings(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> dict[str, object]:
    return run_media_content_reindex(
        payload=payload, context=context, embed_texts=_deterministic_embeddings
    )


_LOCAL_REINDEX_HANDLER = "tests.service.test_import_index_recovery:_reindex_with_local_embeddings"


def _worker(engine: Engine, kind: str, *, handler_path: str | None = None) -> JobWorker:
    definition = get_default_registry()[kind]
    if handler_path is not None:
        definition = dataclasses.replace(definition, handler_path=handler_path)
    return JobWorker(
        session_factory=create_session_factory(engine),
        worker_id=f"index-recovery-{uuid4()}",
        registry={kind: definition},
        allowed_kinds=(kind,),
    )


@dataclasses.dataclass(frozen=True, slots=True)
class _IndexedImport:
    media_id: UUID
    attempt_id: UUID
    reindex_job_id: UUID
    source_sha256: str


def _publish_and_index(
    db: Session, user: UserRecord, engine: Engine, *, label: str
) -> _IndexedImport:
    document = fitz.open()
    for body in ("Indexed first page", "Indexed second page"):
        document.new_page().insert_text((72, 72), body)
    payload = document.tobytes()
    document.close()
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
    storage.put_object(
        build_upload_session_staging_storage_path(
            unseal_upload_session(created.session_handle), created.generation, "pdf"
        ),
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
    assert attempt is not None and attempt.job_id is not None
    assert _worker(engine, _SOURCE_KIND).run_exact(attempt.job_id) is True
    db.expire_all()
    media = db.get(Media, published.media_id)
    assert media is not None and media.processing_status.value == "ready_for_reading"
    (reindex_job,) = find_nonterminal_jobs_for_payload(
        db,
        kind=_INDEX_KIND,
        expected_payload_match={"media_id": str(published.media_id), "revision": 1},
    )
    source_sha256 = db.scalar(
        select(MediaFile.source_sha256).where(MediaFile.media_id == published.media_id)
    )
    assert source_sha256 is not None
    return _IndexedImport(
        media_id=published.media_id,
        attempt_id=attempt.id,
        reindex_job_id=reindex_job.id,
        source_sha256=str(source_sha256),
    )


def _dead_letter_reindex(db: Session, engine: Engine, imported: _IndexedImport) -> None:
    set_pending_job_max_attempts(db, job_id=imported.reindex_job_id, max_attempts=1)
    db.commit()
    failing = _worker(
        engine,
        _INDEX_KIND,
        handler_path="tests.service.test_import_index_recovery:_raise_execution_failure",
    )
    assert failing.run_exact(imported.reindex_job_id) is True
    assert _job(db, imported.reindex_job_id).status == "dead"


def _job(db: Session, job_id: UUID) -> JobRow:
    job = get_job(db, job_id)
    assert job is not None, f"queue row {job_id} disappeared"
    return job


def _source_rows(db: Session, imported: _IndexedImport) -> tuple[list[tuple[UUID, str]], str]:
    db.expire_all()
    attempts = [
        (attempt.id, attempt.status)
        for attempt in db.scalars(
            select(MediaSourceAttempt).where(MediaSourceAttempt.media_id == imported.media_id)
        )
    ]
    digest = db.scalar(
        select(MediaFile.source_sha256).where(MediaFile.media_id == imported.media_id)
    )
    return attempts, str(digest)


def _index_history(db: Session, media_id: UUID) -> list[tuple[str, str | None, dict]]:
    return [
        (event["event_type"], event["failure_code"], dict(event["payload"]))
        for event in read_events(db, owner=MediaHistoryOwner(media_id=media_id))
        if event["stage"] == "Index"
    ]


@pytest.fixture
def import_owner(
    committed_upload_support: tuple[Session, UserRecord], engine: Engine
) -> Iterator[tuple[Session, UserRecord]]:
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


def test_exact_index_repair_restores_search_and_preserves_the_source(
    import_owner: tuple[Session, UserRecord], engine: Engine
) -> None:
    db, user = import_owner
    imported = _publish_and_index(db, user, engine, label="index-repair")
    _dead_letter_reindex(db, engine, imported)
    dead_execution_id = _job(db, imported.reindex_job_id).execution_id
    source_before = _source_rows(db, imported)

    projected = list_media_for_viewer_by_ids(db, user.id, [imported.media_id])[0]
    assert projected.retrieval_status == "suspended"
    assert projected.capabilities.can_repair_search is True

    actor = ViewerRecovery(viewer_id=user.id, is_admin=False, client_mutation_id=str(uuid4()))
    with pytest.raises(ApiError) as foreign_job:
        repair_dead_media_reindex(
            db,
            actor=actor,
            media_id=imported.media_id,
            expected_revision=1,
            expected_job_id=uuid4(),
        )
    assert foreign_job.value.code is ApiErrorCode.E_RESOURCE_CONFLICT
    assert foreign_job.value.details == {
        "current": {"revision": 1, "job_id": str(imported.reindex_job_id)}
    }
    assert _job(db, imported.reindex_job_id).status == "dead"

    admission = repair_dead_media_reindex(
        db,
        actor=actor,
        media_id=imported.media_id,
        expected_revision=1,
        expected_job_id=imported.reindex_job_id,
    )
    assert (admission.kind, admission.revision, admission.job_id) == (
        "SearchRepair",
        1,
        imported.reindex_job_id,
    )
    assert _job(db, imported.reindex_job_id).status == "pending"
    assert (
        repair_dead_media_reindex(
            db,
            actor=actor,
            media_id=imported.media_id,
            expected_revision=1,
            expected_job_id=imported.reindex_job_id,
        )
        == admission
    )

    rerun = _worker(engine, _INDEX_KIND, handler_path=_LOCAL_REINDEX_HANDLER)
    assert rerun.run_exact(imported.reindex_job_id) is True
    state = read_content_index_state(db, owner_id=imported.media_id)
    assert state == ("ready", 1), f"search repair did not restore the index: {state}"
    assert _source_rows(db, imported) == source_before, "search repair touched the source"
    rerun_execution_id = _job(db, imported.reindex_job_id).execution_id
    assert rerun_execution_id not in (None, dead_execution_id)

    history = _index_history(db, imported.media_id)
    assert [(kind, code) for kind, code, _ in history] == [
        ("Accepted", None),
        ("Failed", "E_WORKER_HANDLER_FAILED"),
        ("RecoveryAccepted", None),
        ("ExecutionStarted", None),
        ("Succeeded", None),
    ], f"index history does not narrate the repair: {history}"
    assert history[1][2] == {
        "revision": 1,
        "job_id": str(imported.reindex_job_id),
        "execution_id": {"kind": "Present", "value": str(dead_execution_id)},
        "origin": "Execution",
        "terminal": True,
    }
    assert history[4][2] == {
        "revision": 1,
        "job_id": str(imported.reindex_job_id),
        "execution_id": str(rerun_execution_id),
    }


def test_stale_revision_cannot_requeue_a_dead_reindex_job(
    import_owner: tuple[Session, UserRecord], engine: Engine
) -> None:
    db, user = import_owner
    imported = _publish_and_index(db, user, engine, label="index-stale")
    _dead_letter_reindex(db, engine, imported)
    supersede_content_index_revision(db, owner_id=imported.media_id, expected_revision=1)
    db.commit()

    with pytest.raises(ApiError) as stale:
        repair_dead_media_reindex(
            db,
            actor=ViewerRecovery(
                viewer_id=user.id, is_admin=False, client_mutation_id=str(uuid4())
            ),
            media_id=imported.media_id,
            expected_revision=1,
            expected_job_id=imported.reindex_job_id,
        )
    assert stale.value.code is ApiErrorCode.E_RESOURCE_CONFLICT
    assert stale.value.details == {"current": {"revision": 2}}
    assert _job(db, imported.reindex_job_id).status == "dead", "a stale revision requeued"
    projected = list_media_for_viewer_by_ids(db, user.id, [imported.media_id])[0]
    assert projected.capabilities.can_repair_search is False
