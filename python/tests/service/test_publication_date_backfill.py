"""The maintenance command preserves content and admits only authorized research."""

import hashlib
from pathlib import Path
from uuid import uuid4

from sqlalchemy import Engine, select, text
from sqlalchemy.orm import Session

from nexus.db.models import Media, MediaFile, MediaKind, ProcessingStatus
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_storage_path
from scripts.backfill_media_publication_dates import backfill_media_publication_dates
from tests.testkit.unreachable_state import (
    cleanup_committed_upload_user,
    delete_jobs_by_ids,
)


def test_date_backfill_reads_only_opf_and_deduplicates_without_reverting_research(
    engine: Engine,
) -> None:
    viewer_id, other_id, media_id, foreign_id = (uuid4() for _ in range(4))
    payload = (Path(__file__).parents[1] / "fixtures/epub/moby-dick-epub3.epub").read_bytes()
    source_hash = hashlib.sha256(payload).hexdigest()
    storage_path = build_storage_path(media_id, "epub")
    storage = get_storage_client()
    try:
        storage.put_object(storage_path, payload, "application/epub+zip")
        with Session(engine) as db:
            ensure_user_and_default_library(db, viewer_id, f"dates-{viewer_id}@example.invalid")
            ensure_user_and_default_library(db, other_id, f"dates-{other_id}@example.invalid")
            db.add_all(
                [
                    Media(
                        id=media_id,
                        kind=MediaKind.epub,
                        title="Reader title",
                        original_published_date="1851",
                        processing_status=ProcessingStatus.ready_for_reading,
                        created_by_user_id=viewer_id,
                    ),
                    Media(
                        id=foreign_id,
                        kind=MediaKind.pdf,
                        title="Another viewer's document",
                        processing_status=ProcessingStatus.ready_for_reading,
                        created_by_user_id=other_id,
                    ),
                ]
            )
            db.flush()
            db.add(
                MediaFile(
                    media_id=media_id,
                    storage_path=storage_path,
                    content_type="application/epub+zip",
                    size_bytes=len(payload),
                    source_sha256=source_hash,
                )
            )
            ensure_media_in_default_library(db, viewer_id, media_id)
            ensure_media_in_default_library(db, other_id, foreign_id)
            db.commit()

        assert backfill_media_publication_dates(viewer_id=viewer_id) == 0
        with Session(engine) as db:
            media = db.scalars(select(Media).where(Media.id == media_id)).one()
            assert (
                media.original_published_date,
                media.edition_published_date,
                media.edition_isbn,
            ) == ("1851", "2001-07-01", None)
            assert media.title == "Reader title"
            assert (
                db.scalar(
                    text("SELECT count(*) FROM fragments WHERE media_id = :id"), {"id": media_id}
                )
                == 0
            )
            assert (
                db.scalar(
                    text("SELECT count(*) FROM content_index_states WHERE owner_id = :id"),
                    {"id": media_id},
                )
                == 0
            )
            # A subsequent successful research result must survive a duplicate command.
            media.edition_published_date = "2010"
            db.commit()

        assert backfill_media_publication_dates(viewer_id=viewer_id) == 0
        with Session(engine) as db:
            jobs = (
                db.execute(
                    text(
                        "SELECT payload FROM background_jobs WHERE kind = 'enrich_metadata' "
                        "AND payload->>'media_id' IN (:media_id, :foreign_id)"
                    ),
                    {"media_id": str(media_id), "foreign_id": str(foreign_id)},
                )
                .scalars()
                .all()
            )
            assert jobs == [
                {"media_id": str(media_id), "requester_user_id": str(viewer_id), "request_id": None}
            ]
            media = db.scalars(select(Media).where(Media.id == media_id)).one()
            assert (media.original_published_date, media.edition_published_date) == ("1851", "2010")
            media_file = db.scalars(select(MediaFile).where(MediaFile.media_id == media_id)).one()
            assert (media_file.storage_path, media_file.source_sha256) == (
                storage_path,
                source_hash,
            )
        assert (
            hashlib.sha256(b"".join(storage.stream_object(storage_path))).hexdigest() == source_hash
        )
    finally:
        with Session(engine) as db:
            job_ids = db.scalars(
                text(
                    "SELECT id FROM background_jobs "
                    "WHERE payload->>'media_id' IN (:media_id, :foreign_id)"
                ),
                {"media_id": str(media_id), "foreign_id": str(foreign_id)},
            ).all()
            delete_jobs_by_ids(db, job_ids=job_ids)
            db.commit()
        cleanup_committed_upload_user(engine, user_id=viewer_id)
        cleanup_committed_upload_user(engine, user_id=other_id)
        storage.delete_object(storage_path)


def test_backfill_researches_pending_audio_video_but_waits_for_document_ingestion(
    engine: Engine,
) -> None:
    viewer_id = uuid4()
    media_ids = {
        kind: uuid4() for kind in (MediaKind.video, MediaKind.podcast_episode, MediaKind.epub)
    }
    try:
        with Session(engine) as db:
            ensure_user_and_default_library(db, viewer_id, f"dates-{viewer_id}@example.invalid")
            for kind, media_id in media_ids.items():
                db.add(
                    Media(
                        id=media_id,
                        kind=kind,
                        title="Pending source",
                        processing_status=ProcessingStatus.pending,
                        created_by_user_id=viewer_id,
                    )
                )
                db.flush()
                ensure_media_in_default_library(db, viewer_id, media_id)
            db.commit()
        assert backfill_media_publication_dates(viewer_id=viewer_id) == 0
        assert backfill_media_publication_dates(viewer_id=viewer_id) == 0
        with Session(engine) as db:
            payloads = db.scalars(
                text(
                    "SELECT payload FROM background_jobs WHERE kind = 'enrich_metadata' "
                    "AND payload->>'requester_user_id' = :viewer_id"
                ),
                {"viewer_id": str(viewer_id)},
            ).all()
            assert len(payloads) == 2
            assert {payload["media_id"] for payload in payloads} == {
                str(media_ids[MediaKind.video]),
                str(media_ids[MediaKind.podcast_episode]),
            }
    finally:
        with Session(engine) as db:
            job_ids = db.scalars(
                text("SELECT id FROM background_jobs WHERE payload->>'media_id' = ANY(:media_ids)"),
                {"media_ids": [str(media_id) for media_id in media_ids.values()]},
            ).all()
            delete_jobs_by_ids(db, job_ids=job_ids)
            db.commit()
        cleanup_committed_upload_user(engine, user_id=viewer_id)
