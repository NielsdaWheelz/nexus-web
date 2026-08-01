"""Priority proof: viewer removal cannot destroy another holder's document."""

from __future__ import annotations

from uuid import uuid4

from sqlalchemy import Engine, select, text
from sqlalchemy.orm import Session

from nexus.db.models import (
    LibraryEntry,
    Media,
    MediaFile,
    MediaKind,
    MediaTeardownIntent,
    ProcessingStatus,
)
from nexus.jobs.queue import claim_job, enqueue_job, fail_job, update_running_job_payload
from nexus.schemas.media import MediaRemovedResult
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.conversations import delete_conversation
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.services.media_deletion import remove_media_for_viewer
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_storage_path
from tests.testkit.chat import create_entitled_chat


def test_viewer_removal_preserves_shared_media_database_and_object(engine: Engine) -> None:
    """Removing one reference cannot arm teardown or delete shared durable state."""
    removing_user_id = uuid4()
    retaining_user_id = uuid4()
    media_id = uuid4()
    storage_path = build_storage_path(media_id, "pdf")
    payload = b"%PDF-1.4 shared destructive-scope proof"

    with Session(engine) as db:
        removing_library_id = ensure_user_and_default_library(
            db,
            removing_user_id,
            f"destructive-remove-{removing_user_id}@example.invalid",
        )
        retaining_library_id = ensure_user_and_default_library(
            db,
            retaining_user_id,
            f"destructive-retain-{retaining_user_id}@example.invalid",
        )
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.pdf.value,
                title="Shared deletion boundary",
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=removing_user_id,
            )
        )
        db.add(
            MediaFile(
                media_id=media_id,
                storage_path=storage_path,
                content_type="application/pdf",
                size_bytes=len(payload),
            )
        )
        db.flush()
        ensure_media_in_default_library(db, removing_user_id, media_id)
        ensure_media_in_default_library(db, retaining_user_id, media_id)
        db.commit()

    storage = get_storage_client()
    storage.put_object(storage_path, payload, "application/pdf")

    with Session(engine) as db:
        result = remove_media_for_viewer(db, removing_user_id, media_id)

    assert isinstance(result, MediaRemovedResult), (
        f"shared media removal unexpectedly selected a destructive branch: {result!r}"
    )
    assert result.remaining_reference_count == 1, (
        f"shared media removal did not retain exactly one durable reference: {result!r}"
    )

    with Session(engine) as oracle:
        remaining_library_ids = set(
            oracle.scalars(
                select(LibraryEntry.library_id).where(LibraryEntry.media_id == media_id)
            ).all()
        )
        media_survived = oracle.get(Media, media_id)
        file_survived = oracle.get(MediaFile, media_id)
        teardown_intent = oracle.scalar(
            select(MediaTeardownIntent.id).where(MediaTeardownIntent.media_id == media_id)
        )

    assert remaining_library_ids == {retaining_library_id}, (
        "viewer removal crossed its ownership boundary: "
        f"removed={removing_library_id}, remaining={remaining_library_ids!r}"
    )
    assert media_survived is not None, "viewer removal destroyed shared media metadata"
    assert file_survived is not None, "viewer removal destroyed shared object ownership metadata"
    assert teardown_intent is None, "viewer removal armed physical teardown for shared media"
    assert b"".join(storage.stream_object(storage_path)) == payload, (
        "viewer removal deleted or changed the object still owned by another reference"
    )


def test_conversation_delete_removes_its_dead_chat_journal_only(engine: Engine) -> None:
    worker_id = "conversation-delete-proof-worker"
    with Session(engine) as db:
        chat = create_entitled_chat(
            db,
            content="This prompt must disappear with its deleted conversation.",
        )
        for attempt in range(1, 4):
            claimed = claim_job(
                db,
                job_id=chat.job_id,
                worker_id=worker_id,
                lease_seconds=300,
                allowed_kinds=("chat_run",),
            )
            assert claimed is not None
            if attempt == 1:
                assert update_running_job_payload(
                    db,
                    job_id=chat.job_id,
                    worker_id=worker_id,
                    attempt_no=attempt,
                    payload={
                        **claimed.payload,
                        "coordination": {"generation": {"terminal_result": "private"}},
                    },
                )
            assert fail_job(
                db,
                job_id=chat.job_id,
                worker_id=worker_id,
                error_code="E_DELETE_PROOF",
                error_message="synthetic dead chat",
                retry_delays_seconds=(0,),
            ) == ("dead" if attempt == 3 else "failed")
            db.commit()

        unrelated = enqueue_job(
            db,
            kind="purge_expired_auth_handoff_codes",
            payload={"owner": "unrelated-delete-sentinel"},
            dedupe_key=f"delete-sentinel:{uuid4()}",
            max_attempts=1,
        )
        db.commit()
        delete_conversation(db, chat.user_id, chat.conversation_id)

    with Session(engine) as oracle:
        chat_job_count = oracle.execute(
            text("SELECT count(*) FROM background_jobs WHERE id = :job_id"),
            {"job_id": chat.job_id},
        ).scalar_one()
        unrelated_status = oracle.execute(
            text("SELECT status FROM background_jobs WHERE id = :job_id"),
            {"job_id": unrelated.id},
        ).scalar_one()

    assert chat_job_count == 0, "conversation deletion retained its private chat journal"
    assert unrelated_status == "pending", "conversation deletion crossed into unrelated work"
