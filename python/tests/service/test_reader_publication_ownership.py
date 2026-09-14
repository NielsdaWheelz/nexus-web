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

import hashlib
import json
from datetime import timedelta
from pathlib import Path
from tempfile import TemporaryFile
from uuid import UUID, uuid4

import fitz
import pytest
from sqlalchemy import Engine, select, text
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import ReaderPublicationLimits, get_settings
from nexus.db.models import (
    Media,
    MediaFile,
    MediaKind,
    ProcessingStatus,
    ReaderPublication,
    ReaderPublicationArtifact,
)
from nexus.jobs.queue import find_nonterminal_jobs_for_payload
from nexus.ops.reader_publication_preflight import (
    publish_unpublished_media,
    read_census,
)
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.metadata_enrichment import (
    MetadataEnrichmentOutput,
    merge_enrichment,
)
from nexus.services.parser_temp import parser_attempt_directory
from nexus.services.pdf_ingest import PdfExtractionPlan, build_pdf_extraction_plan
from nexus.services.pdf_lifecycle import publish_pdf_source
from nexus.services.reader_publication import (
    ReaderPublicationBusy,
    ReaderPublicationSourceFile,
    install_current_reader_publication,
    read_publication_generation,
    replace_reader_publication,
    unpublished_reader_source_paths,
)
from nexus.services.reader_publication_artifacts import (
    prepare_pdf_reader_publication,
    prepare_reader_publication_member,
    prepare_reader_publication_title,
    verify_reader_publication_asset,
)
from nexus.services.reader_publication_backfill import (
    prepare_current_reader_publication,
)
from nexus.services.reader_publication_sources import prepare_file_reader_publication
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_source_artifact_storage_path
from nexus.tasks.storage_object_cleanup import STORAGE_OBJECT_CLEANUP_JOB_KIND
from tests.testkit.reader_publication import (
    FIXTURE_LIMITS,
    delete_media,
    pdf_payload,
)


@pytest.mark.parametrize("kind", ["pdf", "epub"])
def test_real_file_sources_produce_native_schema_two_fixtures(
    engine: Engine, tmp_path: Path, kind: str
) -> None:
    from nexus.schemas.offline_reading_package import OfflineReadingEntry
    from nexus.services.epub_ingest import (
        EpubExtractionPlan,
        build_epub_extraction_plan,
    )
    from nexus.services.offline_reading_packages import (
        assemble_offline_reading_zip_from_files,
        build_offline_reading_manifest_from_entries,
        verify_offline_reading_zip,
    )
    from tests.testkit.epub_fixtures import EPUB2_NCX, epub2_payload

    user_id, media_id = uuid4(), uuid4()
    storage = get_storage_client()
    source = (
        pdf_payload("Retained PDF source")
        if kind == "pdf"
        else epub2_payload(
            chapter=(
                '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head>'
                '<body><p id="opening">café 🧠</p><p id="cat">cat</p></body></html>'
            ).encode(),
            ncx=EPUB2_NCX,
        )
    )
    source_path = build_source_artifact_storage_path(media_id, uuid4(), kind)
    storage.put_object(
        source_path,
        source,
        "application/pdf" if kind == "pdf" else "application/epub+zip",
    )
    with Session(engine) as db:
        ensure_user_and_default_library(db, user_id, f"schema-two-source-{user_id}@example.invalid")
        db.add(
            Media(
                id=media_id,
                kind=kind,
                title="Retained source",
                processing_status="extracting",
                created_by_user_id=user_id,
            )
        )
        db.flush()
        db.add(ReaderPublication(id=uuid4(), media_id=media_id, generation=6))
        db.commit()
    factory = sessionmaker(engine, expire_on_commit=False)
    common = dict(
        media_id=media_id,
        attempt_id=uuid4(),
        storage_path=source_path,
        source_size_bytes=len(source),
        expected_source_sha256=hashlib.sha256(source).hexdigest(),
        storage_client=storage,
        record_progress=lambda _completed, _total, _unit: None,
    )
    with parser_attempt_directory(common["attempt_id"]) as attempt_directory:
        plan = (
            build_pdf_extraction_plan(**common)
            if kind == "pdf"
            else build_epub_extraction_plan(
                session_factory=factory, attempt_directory=attempt_directory, **common
            )
        )
        assert isinstance(plan, (PdfExtractionPlan, EpubExtractionPlan)), plan
        limits = ReaderPublicationLimits(
            unit_bytes=4096,
            unit_codepoints=160,
            unit_dom_nodes=30,
            index_bytes=4096,
            descriptor_bytes=1600,
        )
        prepared_paths = []
        try:
            with prepare_file_reader_publication(
                factory, media_id=media_id, plan=plan, limits=limits
            ) as prepared:
                publication = prepared.publication
                entries, files = [], {}
                for member in publication.members:
                    prepared_paths.append(member.storage_path)
                    # Original EPUB archive is retained server-side, never nested in a reading package.
                    if member.ref.key == "assets/source.epub":
                        continue
                    body = b"".join(storage.stream_object(member.storage_path))
                    assert hashlib.sha256(body).hexdigest() == member.ref.sha256
                    target = tmp_path / member.ref.key
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(body)
                    files[member.ref.key] = target
                    entries.append(
                        OfflineReadingEntry(
                            path=member.ref.key,
                            media_type=member.media_type,
                            size_bytes=len(body),
                            sha256=member.ref.sha256,
                        )
                    )
                manifest = build_offline_reading_manifest_from_entries(
                    media_id=media_id,
                    media_kind="Pdf" if kind == "pdf" else "Epub",
                    title=publication.descriptor.title,
                    reader_generation=7,
                    entries=entries,
                )
                archive = tmp_path / f"retained-{kind}-schema-2.zip"
                assemble_offline_reading_zip_from_files(
                    manifest, files, archive, publication_limits=limits
                )
                verified = verify_offline_reading_zip(
                    archive.read_bytes(), publication_limits=limits
                )
                assert verified.manifest.reader_generation == 7
                if kind == "pdf":
                    with fitz.open(
                        stream=files["assets/source.pdf"].read_bytes(), filetype="pdf"
                    ) as document:
                        assert document.page_count == 1
                        assert document[0].get_text().strip() == "Retained PDF source"
                    canonical = None
                else:
                    canonical = "".join(
                        json.loads(files[unit.index.member.key].read_bytes())["canonical_text"]
                        for unit in publication.units
                    )
                    assert canonical == "café 🧠\ncat"
                    assert publication.descriptor.contents_ref is not None
                    anchors = [
                        anchor
                        for key, path in files.items()
                        if key.startswith("index/")
                        for anchor in json.loads(path.read_bytes())["anchors"]
                    ]
                    assert {anchor["anchor_id"]: anchor["offset_cp"] for anchor in anchors} == {
                        "opening": 0,
                        "cat": 7,
                    }
                    assert all(anchor["unit_key"] in files for anchor in anchors)
                    assert all(
                        json.loads(files[unit.index.member.key].read_bytes())["epub_target"]
                        is not None
                        for unit in publication.units
                    )
                (tmp_path / f"retained-{kind}-schema-2.json").write_text(
                    json.dumps(
                        {
                            "package_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                            "expanded_bytes": verified.expanded_length,
                            "canonical_text": canonical,
                            "manifest": manifest.model_dump(mode="json", by_alias=True),
                        },
                        ensure_ascii=False,
                        indent=2,
                    )
                    + "\n"
                )
        finally:
            delete_media(engine, media_id)
            for path in set([source_path, *prepared_paths]):
                storage.delete_object(path)


def test_background_lane_installs_accepted_generation_without_creating_an_archive(
    engine: Engine,
) -> None:
    from pathlib import Path

    from nexus.schemas.reader_publication import ReaderPublicationPreparationRequest
    from nexus.services.reader_publication_preparation import enqueue_reader_publication
    from nexus_test_control import services as test_services
    from tests.testkit.unreachable_state import prioritize_job_for_worker_proof
    from tests.testkit.worker import (
        assert_production_worker,
        controller_run,
        kill_and_forget_process,
        wait_for_job,
    )

    user_id, media_id = uuid4(), uuid4()
    source_path = build_source_artifact_storage_path(media_id, uuid4(), "pdf")
    source = pdf_payload("Accepted generation seven")
    storage = get_storage_client()
    storage.put_object(source_path, source, "application/pdf")
    with Session(engine) as db:
        ensure_user_and_default_library(db, user_id, f"backfill-lane-{user_id}@example.invalid")
        db.add(
            Media(
                id=media_id,
                kind="pdf",
                title="Seven",
                processing_status="ready_for_reading",
                created_by_user_id=user_id,
                page_count=1,
            )
        )
        db.flush()
        db.add(
            MediaFile(
                media_id=media_id,
                storage_path=source_path,
                content_type="application/pdf",
                size_bytes=len(source),
                source_sha256=hashlib.sha256(source).hexdigest(),
            )
        )
        db.add(ReaderPublication(id=uuid4(), media_id=media_id, generation=7))
        db.flush()
        request = ReaderPublicationPreparationRequest(media_id=media_id, expected_generation=7)
        job = enqueue_reader_publication(db, request=request)
        assert enqueue_reader_publication(db, request=request).id == job.id
        with pytest.raises(ReaderPublicationBusy):
            enqueue_reader_publication(
                db,
                request=ReaderPublicationPreparationRequest(
                    media_id=media_id, expected_generation=6
                ),
            )
        prioritize_job_for_worker_proof(db, job_id=job.id)
        db.commit()
    worker = None
    try:
        run = controller_run()
        worker = test_services.start_python_process(
            Path(__file__).resolve().parents[3],
            {"NEXUS_ENV": "test"},
            run,
            "worker-background",
        )
        result = wait_for_job(engine, job.id, status="succeeded", attempts=1)
        assert_production_worker(worker, run)
        assert result[4] == {"status": "ready", "reader_generation": 7}
        with Session(engine) as db:
            assert read_publication_generation(db, media_id=media_id) == 7
            rows = db.scalars(
                select(ReaderPublicationArtifact).where(
                    ReaderPublicationArtifact.media_id == media_id
                )
            ).all()
            assert {row.role for row in rows} == {"descriptor", "asset"}
            assert {row.generation for row in rows} == {7}
            descriptor = next(row for row in rows if row.role == "descriptor")
            asset = next(row for row in rows if row.role == "asset")
            assert asset.storage_path == source_path
            assert asset.sha256 == hashlib.sha256(source).hexdigest()
            from nexus.schemas.reader_publication import PUBLICATION_DESCRIPTOR

            raw = b"".join(storage.stream_object(descriptor.storage_path))
            document = PUBLICATION_DESCRIPTOR.validate_json(raw)
            assert document.reader_generation == 7 and document.title == "Seven"
            assert document.document_asset_ref.sha256 == hashlib.sha256(source).hexdigest()
            assert enqueue_reader_publication(db, request=request).id == job.id
            db.commit()
        from nexus.config import require_reader_publication_limits
        from nexus.services.offline_reading_packages import OfflineReadingPackageError
        from nexus.services.reader_publication_verification import (
            verify_retained_reader_publication,
        )

        factory = sessionmaker(engine, expire_on_commit=False)
        verify_retained_reader_publication(
            factory,
            media_id=media_id,
            generation=7,
            limits=require_reader_publication_limits(),
        )
        # Deliberately unreachable ready-row corruption: a descriptor's existence
        # alone must never satisfy the release verification contract.
        with Session(engine) as db:
            asset = db.scalar(
                select(ReaderPublicationArtifact).where(
                    ReaderPublicationArtifact.media_id == media_id,
                    ReaderPublicationArtifact.role == "asset",
                )
            )
            assert asset is not None
            original_digest = asset.sha256
            asset.sha256 = "0" * 64
            db.commit()
        try:
            with pytest.raises(OfflineReadingPackageError, match="reference"):
                verify_retained_reader_publication(
                    factory,
                    media_id=media_id,
                    generation=7,
                    limits=require_reader_publication_limits(),
                )
        finally:
            with Session(engine) as db:
                asset = db.scalar(
                    select(ReaderPublicationArtifact).where(
                        ReaderPublicationArtifact.media_id == media_id,
                        ReaderPublicationArtifact.role == "asset",
                    )
                )
                assert asset is not None
                asset.sha256 = original_digest
                db.commit()
    finally:
        if worker is not None:
            kill_and_forget_process(worker)
        delete_media(engine, media_id)
        storage.delete_object(source_path)


def test_current_generation_backfill_is_idempotent_and_rejects_a_changed_pointer(
    engine: Engine,
) -> None:
    user_id, media_id = uuid4(), uuid4()
    source_path = build_source_artifact_storage_path(media_id, uuid4(), "pdf")
    payload = pdf_payload("Retained seven")
    storage = get_storage_client()
    storage.put_object(source_path, payload, "application/pdf")
    with Session(engine) as db:
        ensure_user_and_default_library(db, user_id, f"backfill-{user_id}@example.invalid")
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.pdf.value,
                title="Retained seven",
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=user_id,
                page_count=1,
            )
        )
        db.flush()
        db.add(
            MediaFile(
                media_id=media_id,
                storage_path=source_path,
                content_type="application/pdf",
                size_bytes=len(payload),
                source_sha256=hashlib.sha256(payload).hexdigest(),
            )
        )
        # Independently declared pre-cutover state: publication existed before member artifacts.
        db.add(ReaderPublication(id=uuid4(), media_id=media_id, generation=7))
        db.commit()
    factory = sessionmaker(engine, expire_on_commit=False)
    with prepare_current_reader_publication(
        factory, media_id=media_id, expected_generation=7, limits=FIXTURE_LIMITS
    ) as prepared:
        assert prepared.expected_generation == prepared.descriptor.reader_generation == 7
        with Session(engine) as db:
            assert install_current_reader_publication(db, prepared=prepared) is True
            db.commit()
            assert install_current_reader_publication(db, prepared=prepared) is False
            db.commit()
            assert read_publication_generation(db, media_id=media_id) == 7
        renamed = prepare_reader_publication_title(
            factory,
            storage,
            media_id=media_id,
            title="Replacement eight",
            limits=FIXTURE_LIMITS,
        )
        with Session(engine) as db:
            media = db.get(Media, media_id)
            assert media is not None
            merge_enrichment(
                db,
                media,
                MetadataEnrichmentOutput(
                    title="Replacement eight",
                    authors=None,
                    publisher=None,
                    description=None,
                    published_date=None,
                    language=None,
                ),
                prepared_title=renamed,
            )
            db.commit()
            with pytest.raises(ReaderPublicationBusy):
                install_current_reader_publication(db, prepared=prepared)
            db.rollback()
            assert read_publication_generation(db, media_id=media_id) == 8
            old = db.get(ReaderPublicationArtifact, (media_id, 7, "assets/source.pdf"))
            current = db.get(ReaderPublicationArtifact, (media_id, 8, "assets/source.pdf"))
            assert old is not None and current is not None
            assert old.storage_path == current.storage_path == source_path
    delete_media(engine, media_id)
    storage.delete_object(source_path)


def test_source_pointer_moves_exactly_when_its_publication_bumps_the_generation(
    engine: Engine,
) -> None:
    """A publication that replaces nothing must leave the reader-visible pointer."""
    user_id = uuid4()
    media_id = uuid4()
    published_path = build_source_artifact_storage_path(media_id, uuid4(), "pdf")
    prepared_path = build_source_artifact_storage_path(media_id, uuid4(), "pdf")
    published_payload = pdf_payload("Published PDF revision")
    prepared_payload = pdf_payload("Prepared PDF revision")
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
            source_sha256=hashlib.sha256(published_payload).hexdigest(),
        ),
    )

    prepared = build_pdf_extraction_plan(
        media_id=media_id,
        attempt_id=uuid4(),
        storage_path=prepared_path,
        source_size_bytes=len(prepared_payload),
        expected_source_sha256=hashlib.sha256(prepared_payload).hexdigest(),
        storage_client=storage,
        record_progress=lambda _completed, _total, _unit: None,
    )
    assert isinstance(prepared, PdfExtractionPlan), f"fixture PDF did not parse: {prepared!r}"
    prepared_source_file = ReaderPublicationSourceFile(
        storage_path=prepared_path,
        content_type="application/pdf",
        size_bytes=len(prepared_payload),
        source_sha256=hashlib.sha256(prepared_payload).hexdigest(),
    )
    limits = ReaderPublicationLimits(
        unit_bytes=1100,
        unit_codepoints=160,
        unit_dom_nodes=20,
        index_bytes=2000,
        descriptor_bytes=1000,
    )
    with prepare_file_reader_publication(
        sessionmaker(engine, expire_on_commit=False),
        media_id=media_id,
        plan=prepared,
        limits=limits,
    ) as prepared_reader:
        publication = prepared_reader.publication

        # The document is no longer extracting, so this run publishes nothing.
        with Session(engine) as db:
            response, cleanup_paths = publish_pdf_source(
                db,
                media_id=media_id,
                plan=prepared,
                publication=publication,
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
                publication=publication,
                source_file=prepared_source_file,
            )
            db.commit()

        assert response["status"] == "success"
        assert cleanup_paths == [], (
            "a retained generation must never schedule its source for deletion"
        )
        with Session(engine) as oracle:
            media_file = oracle.get(MediaFile, media_id)
            assert media_file is not None and media_file.storage_path == prepared_path
            assert media_file.size_bytes == len(prepared_payload)
            assert read_publication_generation(oracle, media_id=media_id) == 2, (
                "the replaced reader-visible pointer did not advance its generation"
            )
            old_source = oracle.scalar(
                select(ReaderPublicationArtifact).where(
                    ReaderPublicationArtifact.media_id == media_id,
                    ReaderPublicationArtifact.generation == 1,
                    ReaderPublicationArtifact.role == "asset",
                )
            )
            assert old_source is not None and old_source.storage_path == published_path
            assert b"".join(storage.stream_object(old_source.storage_path)) == published_payload
            from nexus.services.library_entries import ensure_media_in_default_library
            from nexus.services.reader_publication_read import (
                get_reader_publication_member_for_viewer,
            )

            ensure_media_in_default_library(oracle, user_id, media_id)
            selected = get_reader_publication_member_for_viewer(
                oracle,
                viewer_id=user_id,
                media_id=media_id,
                generation=1,
                key=old_source.path,
                role="asset",
            )
            assert b"".join(storage.stream_object(selected.storage_path)) == published_payload
            rejected_cleanup = unpublished_reader_source_paths(
                oracle,
                media_id=media_id,
                source_file=ReaderPublicationSourceFile(
                    storage_path=published_path,
                    content_type="application/pdf",
                    size_bytes=len(published_payload),
                    source_sha256=hashlib.sha256(published_payload).hexdigest(),
                ),
            )
            assert rejected_cleanup == [], (
                "rejected preparation must preserve an older retained source"
            )

        delete_media(engine, media_id)
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
    payload = pdf_payload("Enriched title PDF")
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
            source_sha256=hashlib.sha256(payload).hexdigest(),
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

    prepared_title = prepare_reader_publication_title(
        sessionmaker(engine, expire_on_commit=False),
        storage,
        media_id=document_id,
        title="The Canonical Work",
        limits=FIXTURE_LIMITS,
    )
    stale_title = prepare_reader_publication_title(
        sessionmaker(engine, expire_on_commit=False),
        storage,
        media_id=document_id,
        title="Stale title",
        limits=FIXTURE_LIMITS,
    )
    with Session(engine) as db:
        document = db.get(Media, document_id)
        assert document is not None
        merged = merge_enrichment(
            db,
            document,
            MetadataEnrichmentOutput(
                title="The Canonical Work",
                authors=None,
                publisher=None,
                description=None,
                published_date=None,
                language=None,
            ),
            prepared_title=prepared_title,
        )
        db.commit()

    assert merged.accepted_fields == ("title",)
    with Session(engine) as oracle:
        document = oracle.get(Media, document_id)
        assert document is not None and document.title == "The Canonical Work"
        assert read_publication_generation(oracle, media_id=document_id) == 2, (
            "a replaced reader-visible title did not advance its publication generation"
        )
        original = oracle.get(ReaderPublicationArtifact, (document_id, 1, "assets/document.pdf"))
        renamed = oracle.get(ReaderPublicationArtifact, (document_id, 2, "assets/document.pdf"))
        assert original is not None and renamed is not None
        assert (original.storage_path, original.sha256, original.size_bytes) == (
            renamed.storage_path,
            renamed.sha256,
            renamed.size_bytes,
        ), "title publication rewrote its retained source asset"
        with pytest.raises(ReaderPublicationBusy):
            merge_enrichment(
                oracle,
                document,
                MetadataEnrichmentOutput(
                    title="Stale title",
                    authors=None,
                    publisher=None,
                    description=None,
                    published_date=None,
                    language=None,
                ),
                prepared_title=stale_title,
            )
        oracle.rollback()
        assert read_publication_generation(oracle, media_id=document_id) == 2

    with Session(engine) as db:
        video = db.get(Media, video_id)
        assert video is not None
        assert merge_enrichment(
            db,
            video,
            MetadataEnrichmentOutput(
                title="Clip title",
                authors=None,
                publisher=None,
                description=None,
                published_date=None,
                language=None,
            ),
        ).accepted_fields == ("title",)
        db.commit()
    with Session(engine) as oracle:
        video = oracle.get(Media, video_id)
        assert video is not None and video.title == "Clip title"
        assert read_publication_generation(oracle, media_id=video_id) is None, (
            "an ineligible media kind was given a Reader publication row"
        )

    delete_media(engine, document_id)
    delete_media(engine, video_id)
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
    payload = pdf_payload("Already published PDF")
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
            source_sha256=hashlib.sha256(payload).hexdigest(),
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
    # Scoped to this proof's own documents: an unscoped run would count whatever
    # the rest of the suite has committed and durably enqueue publication jobs
    # for foreign media.
    scope = (unpublished_id, published_id, extracting_id, video_id)
    with session_factory() as db:
        before = read_census(db, media_ids=scope)
    assert (before.eligible_ready_media, before.unpublished_media_count) == (2, 1), (
        "the census missed a ready document with no publication generation"
    )
    assert before.missing_descriptor_count == 0

    census = publish_unpublished_media(session_factory=session_factory, media_ids=scope)
    assert (census.unpublished_media_count, census.missing_descriptor_count) == (
        0,
        1,
    ), "the preflight returned before every ready document held a publication generation"

    with Session(engine) as oracle:
        assert _descriptor_artifact_generations(oracle, unpublished_id) == [], (
            "an accepted job was reported as a ready artifact"
        )
        assert _descriptor_artifact_generations(oracle, published_id) == [1], (
            "the preflight disturbed an already published descriptor"
        )
        assert _publication_job_dedupe_keys(oracle, unpublished_id) == [
            f"reader-publication:{unpublished_id}:1:reader-1"
        ], "the preflight did not durably enqueue the missing publication"
        for ineligible in (published_id, extracting_id, video_id):
            assert _publication_job_dedupe_keys(oracle, ineligible) == [], (
                "the preflight enqueued publication work it does not owe"
            )

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
    repeated = publish_unpublished_media(session_factory=session_factory, media_ids=scope)
    assert (repeated.unpublished_media_count, repeated.missing_descriptor_count) == (
        0,
        1,
    )
    with Session(engine) as oracle:
        assert read_publication_generation(oracle, media_id=unpublished_id) == 1
        assert read_publication_generation(oracle, media_id=published_id) == 1

    for media_id in (unpublished_id, published_id, extracting_id, video_id):
        delete_media(engine, media_id)
    storage.delete_object(source_path)


def test_prepared_member_reservation_outlives_its_preparation(engine: Engine) -> None:
    """A member's own cleanup fence must not expire while its publication is pending.

    The reservation is armed before the object is written and is concluded only once a
    committed DB owner is visible, which for a publication is its final transaction. If
    the fence were the bare write window, a long preparation would have its own bytes
    deleted underneath it and publish a generation whose objects are gone.
    """
    user_id, media_id = uuid4(), uuid4()
    with Session(engine) as db:
        ensure_user_and_default_library(db, user_id, f"member-fence-{user_id}@example.invalid")
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.pdf.value,
                title="Fenced member",
                processing_status=ProcessingStatus.extracting,
                created_by_user_id=user_id,
            )
        )
        db.commit()
    storage = get_storage_client()
    member = prepare_reader_publication_member(
        sessionmaker(engine, expire_on_commit=False),
        storage,
        media_id=media_id,
        key="index/0.json",
        role="index",
        body=b"{}",
        media_type="application/json",
    )
    with Session(engine) as db:
        reservations = find_nonterminal_jobs_for_payload(
            db,
            kind=STORAGE_OBJECT_CLEANUP_JOB_KIND,
            expected_payload_match={"storagePath": member.storage_path},
        )
        now = db.execute(text("SELECT now()")).scalar_one()
    assert len(reservations) == 1
    settings = get_settings()
    assert "retainUntil" in reservations[0].payload
    # Not due before the longest preparation that could still publish this member,
    # which is strictly later than the delayed-write window alone.
    assert reservations[0].available_at >= now + timedelta(
        seconds=settings.background_process_wall_timeout_seconds
    )
    assert reservations[0].available_at > now + timedelta(
        seconds=settings.storage_object_cleanup_write_window_seconds
    )
    delete_media(engine, media_id)
    storage.delete_object(member.storage_path)


def test_republishing_an_unchanged_title_advances_no_generation(engine: Engine) -> None:
    """A title identical to the published one is not a publication.

    Every retained title generation copies the document's whole canonical and
    normalized text into new rows, so enrichment returning the title it was handed
    must not produce one -- and must not need a prepared descriptor to say so.
    """
    user_id, media_id = uuid4(), uuid4()
    payload = pdf_payload("Unchanged title")
    source_path = build_source_artifact_storage_path(media_id, uuid4(), "pdf")
    storage = get_storage_client()
    storage.put_object(source_path, payload, "application/pdf")
    _create_published_pdf(
        engine,
        user_id=user_id,
        media_id=media_id,
        title="Unchanged title",
        source_file=ReaderPublicationSourceFile(
            source_path,
            "application/pdf",
            len(payload),
            hashlib.sha256(payload).hexdigest(),
        ),
    )
    with Session(engine) as db:
        media = db.get(Media, media_id)
        assert media is not None
        merge_enrichment(
            db,
            media,
            MetadataEnrichmentOutput(
                title="Unchanged title",
                authors=None,
                publisher=None,
                description=None,
                published_date=None,
                language=None,
            ),
            prepared_title=None,
        )
        db.commit()
        assert read_publication_generation(db, media_id=media_id) == 1
        assert db.get(ReaderPublicationArtifact, (media_id, 2, "descriptor.json")) is None
    delete_media(engine, media_id)
    storage.delete_object(source_path)


def _descriptor_artifact_generations(db: Session, media_id: UUID) -> list[int]:
    return list(
        db.scalars(
            select(ReaderPublicationArtifact.generation)
            .where(
                ReaderPublicationArtifact.media_id == media_id,
                ReaderPublicationArtifact.path == "descriptor.json",
                ReaderPublicationArtifact.role == "descriptor",
            )
            .order_by(ReaderPublicationArtifact.generation)
        )
    )


def _publication_job_dedupe_keys(db: Session, media_id: UUID) -> list[str]:
    return list(
        db.scalars(
            text(
                "SELECT dedupe_key FROM background_jobs "
                "WHERE kind = 'prepare_reader_publication' "
                "AND payload->>'media_id' = :media_id ORDER BY dedupe_key"
            ).bindparams(media_id=str(media_id))
        )
    )


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
        db.commit()
    storage = get_storage_client()
    with TemporaryFile(mode="w+b") as search_file:
        publication = prepare_pdf_reader_publication(
            sessionmaker(engine, expire_on_commit=False),
            storage,
            media_id=media_id,
            expected_generation=None,
            generation=1,
            title=title,
            page_count=1,
            plain_text="",
            page_spans=(),
            page_heights=(),
            search_projection_file=search_file,
            document=verify_reader_publication_asset(
                storage,
                key="assets/document.pdf",
                storage_path=source_file.storage_path,
                media_type="application/pdf",
                expected_size_bytes=source_file.size_bytes,
                expected_sha256=source_file.source_sha256,
            ),
            limits=FIXTURE_LIMITS,
        )
        with Session(engine) as db:
            replace_reader_publication(
                db,
                media_id=media_id,
                expected_kind=MediaKind.pdf.value,
                replace_projection=lambda _media: None,
                source_file=source_file,
                prepared=publication,
            )
            media = db.get(Media, media_id)
            assert media is not None
            media.processing_status = ProcessingStatus.ready_for_reading
            db.commit()
