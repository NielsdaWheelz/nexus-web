"""Priority proof: publication capture never mixes PostgreSQL and object generations."""

from __future__ import annotations

import hashlib
from concurrent.futures import ThreadPoolExecutor
from tempfile import TemporaryFile
from threading import Event
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import Fragment, Media, MediaFile, MediaKind, ProcessingStatus
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.media_deletion import delete_document_media_if_unreferenced
from nexus.services.reader_publication import (
    CapturedReaderPublication,
    ReaderPublicationBusy,
    ReaderPublicationObjectReader,
    ReaderPublicationProjection,
    ReaderPublicationSourceFile,
    capture_current,
    read_publication_generation,
    replace_reader_publication,
)
from nexus.services.reader_publication_artifacts import (
    prepare_pdf_reader_publication,
    verify_reader_publication_asset,
)
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_source_artifact_storage_path
from tests.testkit.reader_publication import FIXTURE_LIMITS


def test_capture_restarts_once_without_mixing_database_and_minio_publications(
    engine: Engine,
) -> None:
    """A raced capture returns one complete generation; a second race is busy."""
    user_id = uuid4()
    media_id = uuid4()
    fragment_id = uuid4()
    attempt_ids = [uuid4() for _ in range(4)]
    paths = [
        build_source_artifact_storage_path(media_id, attempt_id, "pdf")
        for attempt_id in attempt_ids
    ]
    payloads = [f"%PDF-1.4 publication-{index}".encode() for index in range(1, 5)]
    storage = get_storage_client()
    for path, payload in zip(paths, payloads, strict=True):
        storage.put_object(path, payload, "application/pdf")

    session_factory = sessionmaker(engine, expire_on_commit=False)
    with Session(engine) as db:
        ensure_user_and_default_library(
            db,
            user_id,
            f"reader-publication-{user_id}@example.invalid",
        )
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.pdf.value,
                title="Atomic publication",
                processing_status=ProcessingStatus.extracting,
                created_by_user_id=user_id,
            )
        )
        db.flush()
        db.add(
            Fragment(
                id=fragment_id,
                media_id=media_id,
                idx=0,
                canonical_text="Stable canonical fragment identity",
                html_sanitized="<p>Stable canonical fragment identity</p>",
            )
        )
        db.commit()
    _publish_pdf_generation(
        engine,
        media_id=media_id,
        title="Atomic publication",
        expected_generation=None,
        storage_path=paths[0],
        payload=payloads[0],
    )
    with Session(engine) as db:
        db.get(Media, media_id).processing_status = ProcessingStatus.ready_for_reading  # type: ignore[union-attr]
        db.commit()
        assert read_publication_generation(db, media_id=media_id) == 1

    first_assembly_started = Event()
    continue_first_assembly = Event()
    observed: list[tuple[int, str, bytes]] = []

    def assemble_after_one_race(
        projection: ReaderPublicationProjection,
        objects: ReaderPublicationObjectReader,
    ) -> tuple[str, bytes]:
        object_ref = projection.object_references[0]
        payload = b"".join(objects.stream(object_ref))
        observed.append((projection.generation, object_ref.storage_path, payload))
        if projection.generation == 1:
            first_assembly_started.set()
            assert continue_first_assembly.wait(10), (
                "publication replacement did not release the bounded capture race"
            )
        return object_ref.storage_path, payload

    with ThreadPoolExecutor(max_workers=1) as pool:
        capture_future = pool.submit(
            capture_current,
            session_factory,
            media_id=media_id,
            assemble=assemble_after_one_race,
            storage_client=storage,
        )
        assert first_assembly_started.wait(10), (
            "capture did not expose the first repeatable-read projection"
        )
        _publish_pdf_generation(
            engine,
            media_id=media_id,
            title="Atomic publication",
            expected_generation=1,
            storage_path=paths[1],
            payload=payloads[1],
        )
        continue_first_assembly.set()
        captured = capture_future.result(timeout=10)

    assert isinstance(captured, CapturedReaderPublication)
    assert captured.generation == 2, "capture mixed a database pointer and object generation"
    assert captured.value == (paths[1], payloads[1])
    assert captured.projection.fragments[0].fragment_id == fragment_id, (
        "capture replaced the canonical fragment UUID with an index-derived identity"
    )
    assert observed == [
        (1, paths[0], payloads[0]),
        (2, paths[1], payloads[1]),
    ], f"capture mixed a database pointer and object generation: {observed!r}"

    assembly_started = [Event(), Event()]
    continue_assembly = [Event(), Event()]
    busy_generations: list[int] = []

    def assemble_during_two_races(
        projection: ReaderPublicationProjection,
        objects: ReaderPublicationObjectReader,
    ) -> bytes:
        index = len(busy_generations)
        busy_generations.append(projection.generation)
        payload = b"".join(objects.stream(projection.object_references[0]))
        assembly_started[index].set()
        assert continue_assembly[index].wait(10), (
            f"publication race {index + 1} did not release the bounded capture"
        )
        return payload

    with ThreadPoolExecutor(max_workers=1) as pool:
        busy_future = pool.submit(
            capture_current,
            session_factory,
            media_id=media_id,
            assemble=assemble_during_two_races,
            storage_client=storage,
        )
        assert assembly_started[0].wait(10), "first busy capture projection was not observed"
        _publish_pdf_generation(
            engine,
            media_id=media_id,
            title="Atomic publication",
            expected_generation=2,
            storage_path=paths[2],
            payload=payloads[2],
        )
        continue_assembly[0].set()
        assert assembly_started[1].wait(10), "capture did not perform its one allowed restart"
        _publish_pdf_generation(
            engine,
            media_id=media_id,
            title="Atomic publication",
            expected_generation=3,
            storage_path=paths[3],
            payload=payloads[3],
        )
        continue_assembly[1].set()
        with pytest.raises(ReaderPublicationBusy) as busy:
            busy_future.result(timeout=10)

    assert busy.value.code == "E_READER_PUBLICATION_BUSY"
    assert busy_generations == [2, 3]
    with Session(engine) as oracle:
        assert read_publication_generation(oracle, media_id=media_id) == 4
        media_file = oracle.get(MediaFile, media_id)
        assert media_file is not None and media_file.storage_path == paths[3]

    with Session(engine) as db:
        cleanup_paths = delete_document_media_if_unreferenced(db, media_id)
        db.commit()
    assert cleanup_paths is not None and set(paths) <= set(cleanup_paths), (
        "media deletion left the objects its retained publications still reference behind: "
        f"{cleanup_paths!r}"
    )
    with Session(engine) as oracle:
        assert oracle.get(Media, media_id) is None
        assert read_publication_generation(oracle, media_id=media_id) is None, (
            "media deletion left its non-cascading Reader publication owner behind"
        )

    for path in cleanup_paths:
        storage.delete_object(path)


def test_missing_object_defects_at_an_unchanged_generation_and_restarts_after_a_bump(
    engine: Engine,
) -> None:
    """Capture rule 5: an unchanged generation defects, a bumped generation restarts."""
    user_id = uuid4()
    media_id = uuid4()
    fragment_id = uuid4()
    attempt_ids = [uuid4() for _ in range(2)]
    paths = [
        build_source_artifact_storage_path(media_id, attempt_id, "pdf")
        for attempt_id in attempt_ids
    ]
    payloads = [f"%PDF-1.4 missing-object-{index}".encode() for index in range(1, 3)]
    storage = get_storage_client()
    storage.put_object(paths[0], payloads[0], "application/pdf")
    storage.put_object(paths[1], payloads[1], "application/pdf")

    session_factory = sessionmaker(engine, expire_on_commit=False)
    with Session(engine) as db:
        ensure_user_and_default_library(
            db,
            user_id,
            f"reader-publication-{user_id}@example.invalid",
        )
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.pdf.value,
                title="Missing object publication",
                processing_status=ProcessingStatus.extracting,
                created_by_user_id=user_id,
            )
        )
        db.flush()
        db.add(
            Fragment(
                id=fragment_id,
                media_id=media_id,
                idx=0,
                canonical_text="Canonical fragment of a lost object",
                html_sanitized="<p>Canonical fragment of a lost object</p>",
            )
        )
        db.commit()
    _publish_pdf_generation(
        engine,
        media_id=media_id,
        title="Missing object publication",
        expected_generation=None,
        storage_path=paths[0],
        payload=payloads[0],
    )
    with Session(engine) as db:
        db.get(Media, media_id).processing_status = ProcessingStatus.ready_for_reading  # type: ignore[union-attr]
        db.commit()
        assert read_publication_generation(db, media_id=media_id) == 1
    # The published object is lost after it was published: that is the scenario.
    storage.delete_object(paths[0])

    defected_generations: list[int] = []

    def assemble_missing_object(
        projection: ReaderPublicationProjection,
        objects: ReaderPublicationObjectReader,
    ) -> bytes:
        defected_generations.append(projection.generation)
        return b"".join(objects.stream(projection.object_references[0]))

    with pytest.raises(AssertionError) as defect:
        capture_current(
            session_factory,
            media_id=media_id,
            assemble=assemble_missing_object,
            storage_client=storage,
        )

    assert "missing object at its unchanged generation" in str(defect.value), (
        "a lost reader-visible object at an unchanged generation was not a defect: "
        f"{defect.value!r}"
    )
    assert defected_generations == [1], (
        f"an unchanged generation restarted instead of defecting: {defected_generations!r}"
    )

    restarted_generations: list[int] = []

    def assemble_and_publish_over_the_missing_object(
        projection: ReaderPublicationProjection,
        objects: ReaderPublicationObjectReader,
    ) -> bytes:
        restarted_generations.append(projection.generation)
        if projection.generation == 1:
            # The publication that replaced this object is exactly why it is gone.
            _publish_pdf_generation(
                engine,
                media_id=media_id,
                title="Missing object publication",
                expected_generation=1,
                storage_path=paths[1],
                payload=payloads[1],
            )
        return b"".join(objects.stream(projection.object_references[0]))

    captured = capture_current(
        session_factory,
        media_id=media_id,
        assemble=assemble_and_publish_over_the_missing_object,
        storage_client=storage,
    )

    assert restarted_generations == [1, 2], (
        f"a missing object after a bump did not restart the capture: {restarted_generations!r}"
    )
    assert captured.generation == 2
    assert captured.value == payloads[1]

    with Session(engine) as db:
        cleanup_paths = delete_document_media_if_unreferenced(db, media_id)
        db.commit()
    assert cleanup_paths is not None and set(paths) <= set(cleanup_paths), (
        "media deletion left the objects its retained publications still reference behind: "
        f"{cleanup_paths!r}"
    )
    for path in cleanup_paths:
        storage.delete_object(path)


def _publish_pdf_generation(
    engine: Engine,
    *,
    media_id: UUID,
    title: str,
    expected_generation: int | None,
    storage_path: str,
    payload: bytes,
) -> None:
    """Publish one PDF generation the way its owner does: prepare, then replace.

    The successor descriptor and its verified document asset are written as
    immutable objects before the transaction opens, so the generation this
    installs is fenced to exactly the members prepared under it.
    """
    storage = get_storage_client()
    digest = hashlib.sha256(payload).hexdigest()
    with TemporaryFile(mode="w+b") as search_file:
        prepared = prepare_pdf_reader_publication(
            sessionmaker(engine, expire_on_commit=False),
            storage,
            media_id=media_id,
            expected_generation=expected_generation,
            generation=(expected_generation or 0) + 1,
            title=title,
            page_count=1,
            plain_text="",
            page_spans=(),
            page_heights=(),
            search_projection_file=search_file,
            document=verify_reader_publication_asset(
                storage,
                key="assets/document.pdf",
                storage_path=storage_path,
                media_type="application/pdf",
                expected_size_bytes=len(payload),
                expected_sha256=digest,
            ),
            limits=FIXTURE_LIMITS,
        )
        with Session(engine) as db:
            replace_reader_publication(
                db,
                media_id=media_id,
                expected_kind=MediaKind.pdf.value,
                replace_projection=lambda _media: None,
                source_file=ReaderPublicationSourceFile(
                    storage_path=storage_path,
                    content_type="application/pdf",
                    size_bytes=len(payload),
                    source_sha256=digest,
                ),
                prepared=prepared,
            )
            db.commit()
