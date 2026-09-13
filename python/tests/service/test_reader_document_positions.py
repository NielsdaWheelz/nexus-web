"""Real-stack proof for canonical EPUB document positions."""

from __future__ import annotations

import base64
import hashlib
import json
import zipfile
from pathlib import Path
from uuid import NAMESPACE_URL, uuid4, uuid5

import pytest
from sqlalchemy import Engine, select, update
from sqlalchemy.orm import Session

from nexus.db.models import EpubNavLocation, Fragment, Media, MediaFile, MediaKind, ProcessingStatus
from nexus.db.session import create_session_factory
from nexus.errors import ApiErrorCode, ConflictError
from nexus.schemas.epub_find import EpubFindRequest
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.epub_find import find_epub_for_viewer
from nexus.services.epub_ingest import (
    EpubExtractionPlan,
    build_epub_extraction_plan,
    publish_epub_extraction_plan,
)
from nexus.services.epub_read import get_epub_fragment_for_viewer, get_epub_navigation_for_viewer
from nexus.services.highlights import create_fragment_highlight_in_txn
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.services.offline_reading_delivery import build_offline_reading_archive_file
from nexus.services.reader_document_map import get_reader_document_map
from nexus.services.reader_locations import locator_end_fraction, locator_fraction
from nexus.services.reader_publication import capture_current, replace_reader_publication
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
    tmp_path: Path,
) -> None:
    """Ingest, navigation, and overview markers must share one canonical coordinate system."""
    coordinate_cases = json.loads(
        (Path(__file__).parents[3] / "testdata/reader-document-position.json").read_text()
    )["cases"]
    for case in coordinate_cases:
        identifiers = {
            item["fragment_id"]: uuid5(NAMESPACE_URL, item["fragment_id"])
            for item in case["fragments"]
        }
        ranges = {}
        total = 0
        for item in case["fragments"]:
            ranges[str(identifiers[item["fragment_id"]])] = (total, item["char_count"])
            total += item["char_count"]
        for point in case["points"]:
            identifier, offset = point["point"]
            locator = {
                "fragment_id": identifiers[identifier],
                "start_offset": offset,
                "end_offset": offset,
            }
            expected = None if point["global"] is None else pytest.approx(point["global"])
            assert locator_fraction(locator, ranges, total, None, {}) == expected, case["name"]
            assert locator_end_fraction(locator, ranges, total, None, {}) == expected, case["name"]
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
                source_sha256=hashlib.sha256(payload).hexdigest(),
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
            expected_source_sha256=hashlib.sha256(payload).hexdigest(),
            storage_client=storage,
            record_progress=lambda _completed, _total, _unit: None,
        )
        assert isinstance(plan, EpubExtractionPlan), (
            f"authored EPUB did not produce an extraction plan: {plan!r}"
        )

        with Session(engine) as db:
            replace_reader_publication(
                db,
                media_id=media_id,
                expected_kind="epub",
                replace_projection=lambda _media: publish_epub_extraction_plan(
                    db, media_id=media_id, plan=plan
                ),
            )
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
            fragment_id = db.scalars(select(Fragment.id).where(Fragment.media_id == media_id)).one()
            create_fragment_highlight_in_txn(
                db,
                viewer_id=viewer_id,
                highlight_id=uuid4(),
                fragment_id=fragment_id,
                start_offset=expected_text.index("Omega"),
                end_offset=expected_text.index("Omega") + len("Omega"),
                color="yellow",
            )
            db.commit()
            canonical_text = db.scalar(
                select(Fragment.canonical_text).where(Fragment.media_id == media_id)
            )
            navigation = get_epub_navigation_for_viewer(db, viewer_id, media_id)
            document_map = get_reader_document_map(
                db,
                viewer_id=viewer_id,
                media_id=media_id,
            )
            fragment = get_epub_fragment_for_viewer(
                db, viewer_id, media_id, navigation.fragments[0].fragment_id
            )
            find_request = EpubFindRequest.model_validate(
                {
                    "source_witness_fragment_id": fragment.fragment_id,
                    "source_generation": navigation.generation,
                    "query": "Omega",
                    "match_case": True,
                    "whole_word": True,
                    "scope": {
                        "kind": "Section",
                        "section_id": navigation.sections[1].section_id,
                    },
                }
            )
            found = find_epub_for_viewer(db, viewer_id, media_id, find_request)

        assert canonical_text == expected_text
        navigation_payload = navigation.model_dump(mode="json")
        map_payload = document_map.model_dump(mode="json")
        assert navigation_payload.get("generation") == 1 and map_payload.get("generation") == {
            "kind": "Present",
            "value": 1,
        }, "navigation and the document map must identify the same published source generation"
        assert [fragment.char_count for fragment in navigation.fragments] == [len(expected_text)]
        assert [section.label for section in navigation.sections] == [
            "Opening",
            "Second",
            "Closing",
        ]
        assert all(
            section.target.fragment_id == fragment.fragment_id for section in navigation.sections
        )
        assert all(section.extent.kind == "Present" for section in navigation.sections)
        # The authored h1 owns both following h2 sections through source EOF;
        # the publisher's flat table of contents does not flatten that hierarchy.
        assert navigation.sections[0].parent_section_id.kind == "Absent"
        assert [
            section.parent_section_id.model_dump(mode="json") for section in navigation.sections[1:]
        ] == [
            {"kind": "Present", "value": navigation.sections[0].section_id},
            {"kind": "Present", "value": navigation.sections[0].section_id},
        ]
        assert [
            (section.target.offset, section.extent.value.end.offset)
            for section in navigation.sections
            if section.extent.kind == "Present"
        ] == [
            (0, len(expected_text)),
            (second_start, expected_text.index("Closing")),
            (expected_text.index("Closing"), len(expected_text)),
        ], "EPUB sections did not retain their canonical anchor intervals"
        assert fragment.canonical_text == expected_text
        assert fragment.char_count == len(expected_text)
        assert fragment.generation == navigation.generation
        assert fragment.href_path
        assert found.kind == "Ready"
        assert found.source_generation == navigation.generation
        assert len(found.occurrences) == 1
        occurrence = found.occurrences[0]
        assert occurrence.fragment_id == fragment.fragment_id
        assert occurrence.start_offset == expected_text.index("Omega")
        assert occurrence.section.kind == "Present"
        assert occurrence.section.value.section_id == navigation.sections[1].section_id

        captured = capture_current(
            create_session_factory(engine),
            media_id=media_id,
            assemble=lambda projection, _objects: projection.navigation,
            storage_client=storage,
        )
        assert captured.value.kind == "Present"
        assert captured.value.value == navigation
        archive_path = tmp_path / "canonical-reader.zip"
        build_offline_reading_archive_file(
            create_session_factory(engine), media_id=media_id, path=archive_path
        )
        with zipfile.ZipFile(archive_path) as archive:
            packaged = json.loads(archive.read("reader.json"))
        assert packaged["navigation"] == navigation_payload
        assert len(packaged["fragments"]) == 1, (
            "three semantic sections must not duplicate one render unit"
        )
        assert packaged["fragments"][0]["canonical_text"] == expected_text

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
        assert {
            marker.label: marker.end_position.value
            for marker in document_map.markers
            if marker.kind == "Contents" and marker.end_position.kind == "Present"
        } == {
            "Opening": pytest.approx(1.0),
            "Second": pytest.approx(expected_text.index("Closing") / len(expected_text)),
            "Closing": pytest.approx(1.0),
        }, "Document Map section spans lost their canonical endpoints"
        highlighted = [marker for marker in document_map.markers if marker.kind == "Highlight"]
        assert len(highlighted) == 1
        assert highlighted[0].position == pytest.approx(
            expected_text.index("Omega") / len(expected_text)
        )
        assert highlighted[0].end_position.kind == "Present"
        assert highlighted[0].end_position.value == pytest.approx(
            (expected_text.index("Omega") + len("Omega")) / len(expected_text)
        )
        with Session(engine) as db:
            replace_reader_publication(
                db,
                media_id=media_id,
                expected_kind="epub",
                replace_projection=lambda _media: db.execute(
                    update(EpubNavLocation)
                    .where(
                        EpubNavLocation.media_id == media_id,
                        EpubNavLocation.location_id == navigation.sections[1].section_id,
                    )
                    .values(label="Second, corrected label")
                ),
            )
            db.commit()
            assert (
                db.scalars(select(Fragment.id).where(Fragment.media_id == media_id)).one()
                == fragment.fragment_id
            )
            with pytest.raises(ConflictError) as stale:
                find_epub_for_viewer(db, viewer_id, media_id, find_request)
            assert stale.value.code == ApiErrorCode.E_EPUB_FIND_SOURCE_CHANGED

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
                source_sha256=hashlib.sha256(payload).hexdigest(),
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
            expected_source_sha256=hashlib.sha256(payload).hexdigest(),
            storage_client=storage,
            record_progress=lambda _completed, _total, _unit: None,
        )
        assert isinstance(result, EpubExtractionPlan), (
            f"canonical real EPUB did not produce an extraction plan: {result!r}"
        )
        plan = result
        assert plan.result.title == "Moby Dick; Or, The Whale"
        assert "Herman Melville" in plan.result.creators
        assert plan.result.fragment_count >= 10
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
