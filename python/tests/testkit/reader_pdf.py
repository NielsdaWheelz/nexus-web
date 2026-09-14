"""Concrete two-source PDF fixture using extraction, storage and publication owners."""

import hashlib
from contextlib import contextmanager
from dataclasses import dataclass
from uuid import UUID, uuid4

from sqlalchemy import Engine
from sqlalchemy.orm import sessionmaker

from nexus.db.models import Media, ProcessingStatus
from nexus.schemas.highlights import (
    CreatePdfHighlightRequest,
    PdfQuadIn,
)
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.library_entries import (
    delete_all_entries_for_media,
    ensure_media_in_default_library,
)
from nexus.services.metadata_enrichment import MetadataEnrichmentOutput, merge_enrichment
from nexus.services.pdf_highlights import create_pdf_highlight
from nexus.services.pdf_ingest import PdfExtractionPlan, build_pdf_extraction_plan
from nexus.services.pdf_lifecycle import publish_pdf_source
from nexus.services.reader_publication import ReaderPublicationSourceFile
from nexus.services.reader_publication_artifacts import prepare_reader_publication_title
from nexus.services.reader_publication_sources import prepare_file_reader_publication
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_source_artifact_storage_path
from tests.testkit.reader_publication import (
    FIXTURE_LIMITS,
    delete_media,
    pdf_payload,
)


@dataclass(frozen=True)
class PublishedPdfSources:
    engine: Engine
    factory: sessionmaker
    user_id: UUID
    media_id: UUID
    quad: PdfQuadIn
    digests: tuple[str, ...]
    highlights: tuple[UUID, ...]


@contextmanager
def published_pdf_sources(engine: Engine):
    user_id, media_id = uuid4(), uuid4()
    factory = sessionmaker(engine, expire_on_commit=False)
    storage = get_storage_client()
    quad = PdfQuadIn(x1=10, y1=10, x2=20, y2=10, x3=20, y3=20, x4=10, y4=20)
    with factory() as db:
        ensure_user_and_default_library(db, user_id, f"pdf-source-{user_id}@example.invalid")
        db.add(Media(id=media_id, kind="pdf", title="untitled.pdf", created_by_user_id=user_id))
        db.flush()
        ensure_media_in_default_library(db, user_id, media_id)
        db.commit()
    paths, digests, highlights = [], [], []
    for generation, label in ((1, "original"), (2, "replacement")):
        payload = pdf_payload(label)
        path = build_source_artifact_storage_path(media_id, uuid4(), "pdf")
        digest = hashlib.sha256(payload).hexdigest()
        paths.append(path)
        digests.append(digest)
        storage.put_object(path, payload, "application/pdf")
        plan = build_pdf_extraction_plan(
            media_id=media_id,
            attempt_id=uuid4(),
            storage_path=path,
            source_size_bytes=len(payload),
            expected_source_sha256=digest,
            storage_client=storage,
            record_progress=lambda _completed, _total, _unit: None,
        )
        assert isinstance(plan, PdfExtractionPlan)
        with factory() as db:
            db.get(Media, media_id).processing_status = ProcessingStatus.extracting
            db.commit()
        with prepare_file_reader_publication(
            factory, media_id=media_id, plan=plan, limits=FIXTURE_LIMITS
        ) as prepared:
            with factory() as db:
                response, cleanup = publish_pdf_source(
                    db,
                    media_id=media_id,
                    plan=plan,
                    publication=prepared.publication,
                    source_file=ReaderPublicationSourceFile(
                        storage_path=path,
                        content_type="application/pdf",
                        size_bytes=len(payload),
                        source_sha256=digest,
                    ),
                )
                db.commit()
                assert response["status"] == "success" and cleanup == []
        with factory() as db:
            created = create_pdf_highlight(
                db,
                user_id,
                media_id,
                CreatePdfHighlightRequest(
                    reader_generation=generation,
                    page_number=1,
                    quads=[quad],
                    exact=label,
                    color="yellow",
                ),
            )
            highlights.append(created.id)
    renamed = prepare_reader_publication_title(
        factory, storage, media_id=media_id, title="Retained PDF title", limits=FIXTURE_LIMITS
    )
    with factory() as db:
        merged = merge_enrichment(
            db,
            db.get(Media, media_id),
            MetadataEnrichmentOutput(
                title="Retained PDF title",
                authors=None,
                publisher=None,
                description=None,
                published_date=None,
                language=None,
            ),
            prepared_title=renamed,
        )
        db.commit()
        assert merged.accepted_fields == ("title",)
    try:
        yield PublishedPdfSources(
            engine, factory, user_id, media_id, quad, tuple(digests), tuple(highlights)
        )
    finally:
        with factory() as db:
            delete_all_entries_for_media(db, media_id)
            db.commit()
        delete_media(engine, media_id)
        for path in paths:
            storage.delete_object(path)
