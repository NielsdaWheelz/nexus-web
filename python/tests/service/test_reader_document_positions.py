"""Real-stack proof for canonical EPUB document positions."""

from __future__ import annotations

import base64
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from nexus.db.models import Fragment, Media, MediaFile, MediaKind, ProcessingStatus
from nexus.db.session import create_session_factory
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.epub_ingest import (
    EpubExtractionPlan,
    build_epub_extraction_plan,
    publish_epub_extraction_plan,
)
from nexus.services.epub_read import get_epub_navigation_for_viewer
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.services.reader_document_map import get_reader_document_map
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_storage_path


def _authored_epub() -> bytes:
    """Load the tiny authored EPUB shared with the Chromium journeys."""
    encoded = (
        (Path(__file__).parents[3] / "testdata/epub/canonical-reader-positions.epub.b64")
        .read_text(encoding="utf-8")
        .strip()
    )
    return base64.b64decode(encoded, validate=True)


def test_epub_navigation_and_document_map_share_exact_canonical_positions(
    engine: Engine,
) -> None:
    """Ingest, navigation, and overview markers must share one canonical coordinate system."""
    viewer_id = uuid4()
    media_id = uuid4()
    payload = _authored_epub()
    storage_path = build_storage_path(media_id, "epub")
    storage = get_storage_client()

    with Session(engine) as db:
        ensure_user_and_default_library(
            db,
            viewer_id,
            f"reader-position-{viewer_id}@example.invalid",
        )
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.epub.value,
                title="Canonical Reader Positions",
                processing_status=ProcessingStatus.extracting,
                created_by_user_id=viewer_id,
            )
        )
        db.flush()
        ensure_media_in_default_library(db, viewer_id, media_id)
        db.add(
            MediaFile(
                media_id=media_id,
                storage_path=storage_path,
                content_type="application/epub+zip",
                size_bytes=len(payload),
            )
        )
        db.commit()

    storage.put_object(storage_path, payload, "application/epub+zip")
    try:
        plan = build_epub_extraction_plan(
            session_factory=create_session_factory(engine),
            media_id=media_id,
            attempt_id=uuid4(),
            storage_path=storage_path,
            source_size_bytes=len(payload),
            storage_client=storage,
        )
        assert isinstance(plan, EpubExtractionPlan), (
            f"authored EPUB did not produce an extraction plan: {plan!r}"
        )

        with Session(engine) as db:
            publish_epub_extraction_plan(db, media_id=media_id, plan=plan)
            media = db.get(Media, media_id)
            assert media is not None
            media.processing_status = ProcessingStatus.ready_for_reading
            db.commit()

        expected_text = (
            "Opening\nCafé alpha begins the authored reader corpus.\n"
            "Second\nOmega proves the selected section and durable resume.\n"
            "Closing\nThe final passage proves reset returns to the beginning."
        )
        second_start = expected_text.index("Second")
        with Session(engine) as db:
            canonical_text = db.scalar(
                select(Fragment.canonical_text).where(Fragment.media_id == media_id)
            )
            navigation = get_epub_navigation_for_viewer(db, viewer_id, media_id)
            document_map = get_reader_document_map(
                db,
                viewer_id=viewer_id,
                media_id=media_id,
            )

        assert canonical_text == expected_text
        assert [fragment.char_count for fragment in navigation.fragments] == [len(expected_text)]
        assert [section.label for section in navigation.sections] == [
            "Opening",
            "Second",
            "Closing",
        ]
        assert [(section.start_offset, section.end_offset) for section in navigation.sections] == [
            (0, second_start),
            (second_start, expected_text.index("Closing")),
            (expected_text.index("Closing"), len(expected_text)),
        ], "EPUB sections did not retain their canonical anchor intervals"

        contents_positions = {
            marker.label: marker.position
            for marker in document_map.markers
            if marker.kind == "Contents"
        }
        assert contents_positions == {
            "Opening": pytest.approx(0.0),
            "Second": pytest.approx(second_start / len(expected_text)),
            "Closing": pytest.approx(expected_text.index("Closing") / len(expected_text)),
        }, f"Document Map used non-canonical section positions: {contents_positions!r}"
    finally:
        storage.delete_object(storage_path)


def test_real_epub_fixture_retains_known_book_structure(engine: Engine) -> None:
    """One real public-domain EPUB keeps format variance out of browser journeys."""
    fixture_path = Path(__file__).parents[1] / "fixtures/epub/moby-dick-epub3.epub"
    payload = fixture_path.read_bytes()
    viewer_id = uuid4()
    media_id = uuid4()
    storage_path = build_storage_path(media_id, "epub")
    storage = get_storage_client()

    with Session(engine) as db:
        ensure_user_and_default_library(
            db,
            viewer_id,
            f"real-epub-{viewer_id}@example.invalid",
        )
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.epub.value,
                title="Moby Dick; Or, The Whale",
                processing_status=ProcessingStatus.extracting,
                created_by_user_id=viewer_id,
            )
        )
        db.flush()
        ensure_media_in_default_library(db, viewer_id, media_id)
        db.add(
            MediaFile(
                media_id=media_id,
                storage_path=storage_path,
                content_type="application/epub+zip",
                size_bytes=len(payload),
            )
        )
        db.commit()

    storage.put_object(storage_path, payload, "application/epub+zip")
    plan: EpubExtractionPlan | None = None
    try:
        result = build_epub_extraction_plan(
            session_factory=create_session_factory(engine),
            media_id=media_id,
            attempt_id=uuid4(),
            storage_path=storage_path,
            source_size_bytes=len(payload),
            storage_client=storage,
        )
        assert isinstance(result, EpubExtractionPlan), (
            f"canonical real EPUB did not produce an extraction plan: {result!r}"
        )
        plan = result
        assert plan.result.title == "Moby Dick; Or, The Whale"
        assert "Herman Melville" in plan.result.creators
        assert plan.result.chapter_count >= 10
        assert any(location.label == "CHAPTER 1. Loomings." for location in plan.nav_locations)
        assert any(
            "Call me Ishmael. Some years ago" in fragment.canonical_text
            for fragment, _chapter, _items, _edges in plan.fragment_specs
        ), "real EPUB extraction lost its independently known opening sentence"
    finally:
        storage.delete_object(storage_path)
        if plan is not None:
            for asset_path in plan.asset_storage_paths.values():
                storage.delete_object(asset_path)
