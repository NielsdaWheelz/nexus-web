"""Priority proof: committed database ownership and object storage converge."""

from __future__ import annotations

from uuid import uuid4

from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from nexus.db.models import Media, MediaFile, MediaKind, ProcessingStatus
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.media_deletion import (
    delete_document_media_if_unreferenced,
    delete_document_storage_objects,
)
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_storage_path
from nexus.tasks.storage_object_cleanup import (
    finalize_storage_object_write,
    reserve_storage_object_write,
)


def test_owned_object_write_and_document_delete_converge_across_postgres_and_minio(
    engine: Engine,
) -> None:
    """The write guard retains an owned object; deletion removes both owners."""
    user_id = uuid4()
    media_id = uuid4()
    storage_path = build_storage_path(media_id, "pdf")
    payload = b"%PDF-1.4 database-object convergence proof"
    storage = get_storage_client()

    with Session(engine) as db:
        ensure_user_and_default_library(
            db,
            user_id,
            f"object-convergence-{user_id}@example.invalid",
        )
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.pdf.value,
                title="Database and object convergence",
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=user_id,
            )
        )
        db.commit()
        reserve_storage_object_write(db, media_id=media_id, storage_path=storage_path)

    storage.put_object(storage_path, payload, "application/pdf")

    with Session(engine) as db:
        db.add(
            MediaFile(
                media_id=media_id,
                storage_path=storage_path,
                content_type="application/pdf",
                size_bytes=len(payload),
            )
        )
        db.commit()
        finalize_storage_object_write(
            db,
            media_id=media_id,
            storage_path=storage_path,
            storage_client=storage,
        )

    with Session(engine) as oracle:
        persisted_path = oracle.scalar(
            select(MediaFile.storage_path).where(MediaFile.media_id == media_id)
        )
    assert persisted_path == storage_path, (
        f"committed database owner did not retain the written object path: {persisted_path!r}"
    )
    assert b"".join(storage.stream_object(storage_path)) == payload, (
        "write finalization discarded an object with committed database ownership"
    )

    with Session(engine) as db:
        deletion_paths = delete_document_media_if_unreferenced(db, media_id)
        db.commit()

    assert deletion_paths == [storage_path], (
        f"database deletion did not publish its exact object cleanup obligation: {deletion_paths!r}"
    )
    with Session(engine) as oracle:
        assert oracle.get(Media, media_id) is None, "document database owner survived deletion"
        assert oracle.get(MediaFile, media_id) is None, (
            "object ownership metadata survived document deletion"
        )
    assert storage.head_object(storage_path) is not None, (
        "object disappeared before the committed database deletion exposed its cleanup obligation"
    )

    delete_document_storage_objects(deletion_paths, storage)

    assert storage.head_object(storage_path) is None, (
        "document deletion left an object without a live database owner"
    )
