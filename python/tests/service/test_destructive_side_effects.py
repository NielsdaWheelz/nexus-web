"""Priority proof: viewer removal cannot destroy another holder's document."""

from __future__ import annotations

from uuid import uuid4

from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from nexus.db.models import (
    LibraryEntry,
    Media,
    MediaFile,
    MediaKind,
    MediaTeardownIntent,
    ProcessingStatus,
)
from nexus.schemas.media import MediaRemovedResult
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.services.media_deletion import remove_media_for_viewer
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_storage_path


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
