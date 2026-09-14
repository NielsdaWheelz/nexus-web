"""Authored EPUB caption semantics survive real source preparation."""

import hashlib
import json
from uuid import uuid4

from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import ReaderPublicationLimits
from nexus.db.models import Media
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.epub_ingest import (
    EpubExtractionPlan,
    build_epub_extraction_plan,
    read_epub_fragment,
)
from nexus.services.parser_temp import parser_attempt_directory
from nexus.services.reader_publication_sources import prepare_file_reader_publication
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_source_artifact_storage_path
from tests.testkit.epub_fixtures import EPUB2_NCX, epub2_payload
from tests.testkit.reader_publication import delete_media


def test_epub_caption_retains_its_source_relation_and_authored_anchor(
    engine: Engine,
) -> None:
    user_id, media_id = uuid4(), uuid4()
    source = epub2_payload(
        chapter=(
            b'<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head>'
            b'<body><table><tr><td rowspan="65534">one</td></tr>'
            b'<caption id="caption">late caption</caption></table></body></html>'
        ),
        ncx=EPUB2_NCX,
    )
    storage = get_storage_client()
    source_path = build_source_artifact_storage_path(media_id, uuid4(), "epub")
    storage.put_object(source_path, source, "application/epub+zip")
    with Session(engine) as db:
        ensure_user_and_default_library(db, user_id, f"caption-{user_id}@example.invalid")
        db.add(
            Media(
                id=media_id,
                kind="epub",
                title="Caption source",
                processing_status="extracting",
                created_by_user_id=user_id,
            )
        )
        db.commit()
    factory = sessionmaker(engine, expire_on_commit=False)
    prepared_paths = []
    try:
        attempt_id = uuid4()
        with parser_attempt_directory(attempt_id) as attempt_directory:
            plan = build_epub_extraction_plan(
                attempt_directory=attempt_directory,
                session_factory=factory,
                media_id=media_id,
                attempt_id=attempt_id,
                storage_path=source_path,
                source_size_bytes=len(source),
                expected_source_sha256=hashlib.sha256(source).hexdigest(),
                storage_client=storage,
                record_progress=lambda _completed, _total, _unit: None,
            )
            assert isinstance(plan, EpubExtractionPlan), plan
            fragment = plan.fragments[0]
            _html, canonical_text = read_epub_fragment(fragment)
            assert canonical_text == "one\nlate caption"
            with prepare_file_reader_publication(
                factory,
                media_id=media_id,
                plan=plan,
                limits=ReaderPublicationLimits(
                    unit_bytes=6000,
                    unit_codepoints=160,
                    unit_dom_nodes=80,
                    index_bytes=6000,
                    descriptor_bytes=1600,
                ),
            ) as prepared:
                members = {}
                for member in prepared.publication.members:
                    prepared_paths.append(member.storage_path)
                    payload = b"".join(storage.stream_object(member.storage_path))
                    assert len(payload) == member.ref.bytes
                    assert hashlib.sha256(payload).hexdigest() == member.ref.sha256
                    if member.role in {"unit", "index"}:
                        members[member.ref.key] = json.loads(payload)
                records = [
                    record
                    for member in members.values()
                    for record in member.get("table_metadata", [])
                ]
                table = next(record for record in records if record["kind"] == "Table")
                caption = table["caption"]
                assert caption is not None, "epub sanitizer discarded the authored table caption"
                assert caption["fragment_id"] == str(fragment.id)
                assert (caption["start_cp"], caption["end_cp"]) == (4, 16)
                unit = members[caption["unit_key"]]
                assert any(node.get("name") == "caption" for node in unit["render_nodes"])
                anchors = [
                    anchor for member in members.values() for anchor in member.get("anchors", [])
                ]
                anchor = next(anchor for anchor in anchors if anchor["anchor_id"] == "caption")
                assert anchor["unit_key"] == caption["unit_key"] and anchor["offset_cp"] == 4
                assert b"".join(storage.stream_object(source_path)) == source
    finally:
        delete_media(engine, media_id)
        for path in {source_path, *prepared_paths}:
            storage.delete_object(path)
