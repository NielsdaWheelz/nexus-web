"""Proof: every reader-visible input is published by `reader_publication` alone.

The offline package projection is denoted by one generation. A reader-visible
file pointer, or a reader-visible title, that moves without that generation
moving leaves an installed offline copy silently wrong with no fence that can
detect it. These scenarios hold that boundary at the two call sites that write
reader-visible input outside the extraction plan itself — source publication and
metadata enrichment — and at the deployment preflight that guarantees every
already-ready document has a publication generation at all.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import fitz
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import Media, MediaFile, MediaKind, ProcessingStatus
from nexus.ops.reader_publication_preflight import (
    publish_unpublished_media,
    read_census,
)
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.media_deletion import delete_document_media_if_unreferenced
from nexus.services.metadata_enrichment import merge_enrichment
from nexus.services.pdf_ingest import PdfExtractionPlan, build_pdf_extraction_plan
from nexus.services.pdf_lifecycle import publish_pdf_source
from nexus.services.reader_publication import (
    ReaderPublicationSourceFile,
    read_publication_generation,
    replace_reader_publication,
)
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_source_artifact_storage_path


def test_source_pointer_moves_exactly_when_its_publication_bumps_the_generation(
    engine: Engine,
) -> None:
    """A publication that replaces nothing must leave the reader-visible pointer."""
    user_id = uuid4()
    media_id = uuid4()
    published_path = build_source_artifact_storage_path(media_id, uuid4(), "pdf")
    prepared_path = build_source_artifact_storage_path(media_id, uuid4(), "pdf")
    published_payload = _pdf_payload("Published PDF revision")
    prepared_payload = _pdf_payload("Prepared PDF revision")
    storage = get_storage_client()
    storage.put_object(published_path, published_payload, "application/pdf")
    storage.put_object(prepared_path, prepared_payload, "application/pdf")

    _create_published_pdf(
        engine,
        user_id=user_id,
        media_id=media_id,
        title="Publication pointer ownership",
        source_file=ReaderPublicationSourceFile(
            storage_path=published_path,
            content_type="application/pdf",
            size_bytes=len(published_payload),
        ),
    )

    prepared = build_pdf_extraction_plan(
        media_id=media_id,
        attempt_id=uuid4(),
        storage_path=prepared_path,
        source_size_bytes=len(prepared_payload),
        storage_client=storage,
        record_progress=lambda _completed, _total, _unit: None,
    )
    assert isinstance(prepared, PdfExtractionPlan), f"fixture PDF did not parse: {prepared!r}"
    prepared_source_file = ReaderPublicationSourceFile(
        storage_path=prepared_path,
        content_type="application/pdf",
        size_bytes=len(prepared_payload),
    )

    # The document is no longer extracting, so this run publishes nothing.
    with Session(engine) as db:
        response, cleanup_paths = publish_pdf_source(
            db,
            media_id=media_id,
            plan=prepared,
            source_file=prepared_source_file,
        )
        db.commit()

    assert response == {"status": "skipped", "reason": "not_extracting"}
    assert cleanup_paths == [prepared_path], (
        "a publication that published nothing did not return its unreferenced "
        f"prepared object for cleanup: {cleanup_paths!r}"
    )
    with Session(engine) as oracle:
        media_file = oracle.get(MediaFile, media_id)
        assert media_file is not None and media_file.storage_path == published_path, (
            "a publication that published nothing replaced the reader-visible pointer"
        )
        assert read_publication_generation(oracle, media_id=media_id) == 1

    with Session(engine) as db:
        media = db.get(Media, media_id)
        assert media is not None
        media.processing_status = ProcessingStatus.extracting
        db.commit()

    with Session(engine) as db:
        response, cleanup_paths = publish_pdf_source(
            db,
            media_id=media_id,
            plan=prepared,
            source_file=prepared_source_file,
        )
        db.commit()

    assert response["status"] == "success"
    assert cleanup_paths == [published_path], (
        f"the superseded source object was not reported for deletion: {cleanup_paths!r}"
    )
    with Session(engine) as oracle:
        media_file = oracle.get(MediaFile, media_id)
        assert media_file is not None and media_file.storage_path == prepared_path
        assert media_file.size_bytes == len(prepared_payload)
        assert read_publication_generation(oracle, media_id=media_id) == 2, (
            "the replaced reader-visible pointer did not advance its generation"
        )

    _delete_media(engine, media_id)
    storage.delete_object(published_path)
    storage.delete_object(prepared_path)


def test_enriched_title_of_a_published_document_advances_its_generation(
    engine: Engine,
) -> None:
    """`media.title` is captured in the package, so enriching it is a publication."""
    user_id = uuid4()
    document_id = uuid4()
    video_id = uuid4()
    source_path = build_source_artifact_storage_path(document_id, uuid4(), "pdf")
    payload = _pdf_payload("Enriched title PDF")
    storage = get_storage_client()
    storage.put_object(source_path, payload, "application/pdf")

    _create_published_pdf(
        engine,
        user_id=user_id,
        media_id=document_id,
        title="untitled-2.pdf",
        source_file=ReaderPublicationSourceFile(
            storage_path=source_path,
            content_type="application/pdf",
            size_bytes=len(payload),
        ),
    )
    with Session(engine) as db:
        db.add(
            Media(
                id=video_id,
                kind=MediaKind.video.value,
                title="untitled clip",
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=user_id,
            )
        )
        db.commit()

    with Session(engine) as db:
        document = db.get(Media, document_id)
        assert document is not None
        merged = merge_enrichment(db, document, {"title": "The Canonical Work"})
        db.commit()

    assert merged.accepted_fields == ("title",)
    with Session(engine) as oracle:
        document = oracle.get(Media, document_id)
        assert document is not None and document.title == "The Canonical Work"
        assert read_publication_generation(oracle, media_id=document_id) == 2, (
            "a replaced reader-visible title did not advance its publication generation"
        )

    with Session(engine) as db:
        video = db.get(Media, video_id)
        assert video is not None
        assert merge_enrichment(db, video, {"title": "Clip title"}).accepted_fields == ("title",)
        db.commit()
    with Session(engine) as oracle:
        video = oracle.get(Media, video_id)
        assert video is not None and video.title == "Clip title"
        assert read_publication_generation(oracle, media_id=video_id) is None, (
            "an ineligible media kind was given a Reader publication row"
        )

    _delete_media(engine, document_id)
    _delete_media(engine, video_id)
    storage.delete_object(source_path)


def test_preflight_publishes_every_ready_document_that_has_no_generation(
    engine: Engine,
) -> None:
    """A ready document produced by an older artifact gains a publication fence."""
    user_id = uuid4()
    unpublished_id = uuid4()
    published_id = uuid4()
    extracting_id = uuid4()
    video_id = uuid4()
    source_path = build_source_artifact_storage_path(published_id, uuid4(), "pdf")
    payload = _pdf_payload("Already published PDF")
    storage = get_storage_client()
    storage.put_object(source_path, payload, "application/pdf")

    _create_published_pdf(
        engine,
        user_id=user_id,
        media_id=published_id,
        title="Already published",
        source_file=ReaderPublicationSourceFile(
            storage_path=source_path,
            content_type="application/pdf",
            size_bytes=len(payload),
        ),
    )
    with Session(engine) as db:
        # Exactly what an older artifact leaves behind: ready, unfenced.
        db.add(
            Media(
                id=unpublished_id,
                kind=MediaKind.web_article.value,
                title="Ready without a generation",
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=user_id,
            )
        )
        db.add(
            Media(
                id=extracting_id,
                kind=MediaKind.epub.value,
                title="Still extracting",
                processing_status=ProcessingStatus.extracting,
                created_by_user_id=user_id,
            )
        )
        db.add(
            Media(
                id=video_id,
                kind=MediaKind.video.value,
                title="Ineligible kind",
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=user_id,
            )
        )
        db.commit()

    session_factory = sessionmaker(engine, expire_on_commit=False)
    with session_factory() as db:
        before = read_census(db)
    assert unpublished_id in before.unpublished_media, (
        "the census missed a ready document with no publication generation"
    )

    census = publish_unpublished_media(session_factory=session_factory)
    assert census.unpublished_media == ()

    with Session(engine) as oracle:
        assert read_publication_generation(oracle, media_id=unpublished_id) == 1, (
            "the preflight left a ready document without a publication generation"
        )
        assert read_publication_generation(oracle, media_id=published_id) == 1, (
            "the preflight rewrote an existing publication generation"
        )
        assert read_publication_generation(oracle, media_id=extracting_id) is None, (
            "the preflight published a document that is not ready for reading"
        )
        assert read_publication_generation(oracle, media_id=video_id) is None, (
            "the preflight published an ineligible media kind"
        )

    # Idempotent: a second run publishes nothing and disturbs no generation.
    repeated = publish_unpublished_media(session_factory=session_factory)
    assert repeated.unpublished_media == ()
    with Session(engine) as oracle:
        assert read_publication_generation(oracle, media_id=unpublished_id) == 1
        assert read_publication_generation(oracle, media_id=published_id) == 1

    for media_id in (unpublished_id, published_id, extracting_id, video_id):
        _delete_media(engine, media_id)
    storage.delete_object(source_path)


def _pdf_payload(text: str) -> bytes:
    document = fitz.open()
    document.new_page().insert_text((72, 72), text)
    payload: bytes = document.tobytes()
    document.close()
    return payload


def _create_published_pdf(
    engine: Engine,
    *,
    user_id: UUID,
    media_id: UUID,
    title: str,
    source_file: ReaderPublicationSourceFile,
) -> None:
    """Create one ready PDF published at generation 1 through its owner."""
    with Session(engine) as db:
        ensure_user_and_default_library(
            db,
            user_id,
            f"reader-publication-ownership-{user_id}@example.invalid",
        )
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.pdf.value,
                title=title,
                processing_status=ProcessingStatus.extracting,
                created_by_user_id=user_id,
            )
        )
        db.flush()
        replace_reader_publication(
            db,
            media_id=media_id,
            expected_kind=MediaKind.pdf.value,
            replace_projection=lambda _media: None,
            source_file=source_file,
        )
        media = db.get(Media, media_id)
        assert media is not None
        media.processing_status = ProcessingStatus.ready_for_reading
        db.commit()


def _delete_media(engine: Engine, media_id: UUID) -> None:
    with Session(engine) as db:
        delete_document_media_if_unreferenced(db, media_id)
        db.commit()
