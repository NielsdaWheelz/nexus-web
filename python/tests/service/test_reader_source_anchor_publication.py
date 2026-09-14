"""Original EPUB marker positions survive bounded crops and actual retained lookup."""

import hashlib
from uuid import uuid4

import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import ReaderPublicationLimits
from nexus.db.models import Media
from nexus.schemas.reader_publication import ReaderPublicationResolveRequest
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.epub_ingest import EpubExtractionPlan, build_epub_extraction_plan
from nexus.services.epub_lifecycle import publish_epub_source
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.services.media_deletion import delete_document_media_if_unreferenced
from nexus.services.parser_temp import parser_attempt_directory
from nexus.services.reader_publication import ReaderPublicationSourceFile
from nexus.services.reader_publication_resolve import (
    resolve_reader_publication_for_viewer,
)
from nexus.services.reader_publication_sources import prepare_file_reader_publication
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_source_artifact_storage_path
from tests.testkit.epub_fixtures import EPUB2_NCX, epub2_payload


@pytest.mark.parametrize(
    ("markup", "expected"),
    (
        (
            '<table><tr><td id="first">first</td></tr>'
            '<tr><td id="second">second</td></tr></table><p id="first">duplicate</p>',
            {"first": 0, "second": 6},
        ),
        (
            '<p id="first">first<span id="space"> &#160;</span></p><p id="second">second</p>',
            {"first": 0, "space": 5, "second": 6},
        ),
        (
            '<p id="first">first</p><br/><p id="second">second</p>',
            {"first": 0, "second": 7},
        ),
        (
            '<p id="first">first</p><p id="second">e<span id="mark">́</span>x</p>',
            {"first": 0, "second": 6, "mark": 7},
        ),
        (
            '<p id="first">first</p><p id="second">ᄀ<span id="mark">ᅡ</span><b id="last">ᆨ</b>x</p>',
            {"first": 0, "second": 6, "mark": 7, "last": 7},
        ),
    ),
)
def test_original_marker_points_publish_and_resolve_without_cropped_offset_inference(
    engine: Engine, markup: str, expected: dict[str, int]
) -> None:
    source = epub2_payload(
        chapter=(
            '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body>'
            + markup
            + "</body></html>"
        ).encode(),
        ncx=EPUB2_NCX,
    )
    viewer, media_id = uuid4(), uuid4()
    storage = get_storage_client()
    source_path = build_source_artifact_storage_path(media_id, uuid4(), "epub")
    digest = hashlib.sha256(source).hexdigest()
    storage.put_object(source_path, source, "application/epub+zip")
    factory = sessionmaker(engine, expire_on_commit=False)
    paths = [source_path]
    try:
        with factory() as db:
            ensure_user_and_default_library(db, viewer, f"source-anchor-{viewer}@example.invalid")
            db.add(
                Media(
                    id=media_id,
                    kind="epub",
                    title="Source anchors",
                    processing_status="extracting",
                    created_by_user_id=viewer,
                )
            )
            db.flush()
            ensure_media_in_default_library(db, viewer, media_id)
            db.commit()
        attempt_id = uuid4()
        with parser_attempt_directory(attempt_id) as attempt_directory:
            plan = build_epub_extraction_plan(
                attempt_directory=attempt_directory,
                session_factory=factory,
                media_id=media_id,
                attempt_id=attempt_id,
                storage_path=source_path,
                source_size_bytes=len(source),
                expected_source_sha256=digest,
                storage_client=storage,
                record_progress=lambda _completed, _total, _unit: None,
            )
            assert isinstance(plan, EpubExtractionPlan)
            with prepare_file_reader_publication(
                factory,
                media_id=media_id,
                plan=plan,
                limits=ReaderPublicationLimits(
                    unit_bytes=6000,
                    unit_codepoints=7,
                    unit_dom_nodes=80,
                    index_bytes=3000,
                    descriptor_bytes=1500,
                ),
            ) as prepared:
                publication = prepared.publication
                paths.extend(member.storage_path for member in publication.members)
                assert {
                    anchor.anchor_id: anchor.offset_cp for anchor in publication.anchors
                } == expected, (
                    "published anchors must keep independently known original canonical points"
                )
                with factory() as db:
                    publish_epub_source(
                        db,
                        media_id=media_id,
                        plan=plan,
                        publication=publication,
                        source_file=ReaderPublicationSourceFile(
                            storage_path=source_path,
                            content_type="application/epub+zip",
                            size_bytes=len(source),
                            source_sha256=digest,
                        ),
                    )
                    db.commit()
                with factory() as db:
                    for anchor in publication.anchors:
                        resolved = resolve_reader_publication_for_viewer(
                            db,
                            viewer_id=viewer,
                            media_id=media_id,
                            generation=publication.descriptor.reader_generation,
                            request=ReaderPublicationResolveRequest(
                                target={
                                    "kind": "EpubHref",
                                    "pathname": anchor.href_path,
                                    "anchor_id": anchor.anchor_id,
                                }
                            ),
                        )
                        assert (
                            resolved.kind == "Text"
                            and resolved.offset_cp == expected[anchor.anchor_id]
                        )
                        assert resolved.unit_ref.key == anchor.unit_key
    finally:
        with Session(engine) as db:
            delete_document_media_if_unreferenced(db, media_id)
            db.commit()
        for path in set(paths):
            storage.delete_object(path)
