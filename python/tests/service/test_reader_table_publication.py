"""The web source owner publishes bounded table units and a closed sparse archive."""

import hashlib
import json
import os
from pathlib import Path
from uuid import uuid4

from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import ReaderPublicationLimits
from nexus.db.models import Media
from nexus.schemas.offline_reading_package import OfflineReadingEntry
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.media_deletion import delete_document_media_if_unreferenced
from nexus.services.offline_reading_packages import (
    assemble_offline_reading_zip_from_files,
    build_offline_reading_manifest_from_entries,
    verify_offline_reading_zip,
)
from nexus.services.reader_publication_web import WebReaderFragment, prepare_web_reader_publication
from nexus.services.web_article_structure import prepare_web_article_fragment
from nexus.storage.client import get_storage_client


def test_source_table_is_split_published_and_verified_with_its_original_context(
    engine: Engine,
) -> None:
    output = Path(os.environ["NEXUS_TEST_RESULTS_DIR"]) / "source-table"
    output.mkdir(parents=True, exist_ok=True)
    source = (
        '<table><tr><th id="header" scope="col">heading</th></tr>'
        + "".join(
            f'<tr><td id="row-{index}">{index}: ' + "x" * 90 + "</td></tr>" for index in range(24)
        )
        + '<caption id="caption">late caption</caption></table>'
        + '<table><tr><td rowspan="2" colspan="2">ordinary</td></tr></table>'
    )
    canonical = (
        "heading\n"
        + "\n".join(f"{index}: " + "x" * 90 for index in range(24))
        + "\nlate caption\nordinary"
    )
    user_id, media_id, fragment_id = uuid4(), uuid4(), uuid4()
    storage = get_storage_client()
    factory = sessionmaker(engine, expire_on_commit=False)
    with factory() as db:
        ensure_user_and_default_library(db, user_id, f"table-source-{user_id}@example.invalid")
        db.add(
            Media(
                id=media_id,
                kind="web_article",
                title="Source tables",
                processing_status="extracting",
                created_by_user_id=user_id,
            )
        )
        db.commit()
    fragment = prepare_web_article_fragment(
        html=source,
        base_url="https://example.invalid/article",
        fragment_idx=0,
    )
    assert fragment.canonical_text == canonical
    limits = ReaderPublicationLimits(
        unit_bytes=6000,
        unit_codepoints=160,
        unit_dom_nodes=80,
        index_bytes=3000,
        descriptor_bytes=1500,
    )
    paths = []
    try:
        with prepare_web_reader_publication(
            factory,
            media_id=media_id,
            fragments=(WebReaderFragment(fragment_id, 0, fragment, ()),),
            source_html=source,
            title="Source tables",
            limits=limits,
        ) as publication:
            assert publication.descriptor.table_metadata_ref is not None
            entries, files, members = [], {}, {}
            for member in publication.members:
                paths.append(member.storage_path)
                body = b"".join(storage.stream_object(member.storage_path))
                assert hashlib.sha256(body).hexdigest() == member.ref.sha256
                if member.ref.key == "assets/source.html":
                    assert body == source.encode(), (
                        "render normalization cannot rewrite the retained original"
                    )
                    continue
                target = output / member.ref.key
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(body)
                files[member.ref.key] = target
                members[member.ref.key] = body.decode()
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
                media_kind="WebArticle",
                title="Source tables",
                reader_generation=1,
                entries=entries,
            )
            archive = output / "source-table-schema-2.zip"
            assemble_offline_reading_zip_from_files(
                manifest, files, archive, publication_limits=limits
            )
            verified = verify_offline_reading_zip(archive.read_bytes(), publication_limits=limits)
            assert verified.manifest.reader_generation == 1
            assert (
                "".join(
                    json.loads(members[unit.index.member.key])["canonical_text"]
                    for unit in publication.units
                )
                == canonical
            )
            records = []
            page_key = publication.descriptor.table_metadata_ref.key
            while page_key is not None:
                page = json.loads(members[page_key])
                records.extend(page["table_metadata"])
                page_key = page["next_ref"]["key"] if page["next_ref"] is not None else None
            tables = [record for record in records if record["kind"] == "Table"]
            assert len(tables) == 1 and tables[0]["table_ordinal"] == 0
            assert (tables[0]["row_count"], tables[0]["column_count"]) == (25, 1)
            cells = [record for record in records if record["kind"] == "Cell"]
            assert [(cell["row"], cell["column"], cell["header_kind"]) for cell in cells] == [
                (0, 0, "column"),
                *((row, 0, "data") for row in range(1, 25)),
            ]
            assert (cells[0]["range"]["start_cp"], cells[0]["range"]["end_cp"]) == (0, 7)
            for index, cell in enumerate(cells[1:]):
                text = f"{index}: " + "x" * 90
                start = canonical.index(text)
                assert (cell["range"]["start_cp"], cell["range"]["end_cp"]) == (
                    start,
                    start + len(text),
                )
            caption = tables[0]["caption"]
            assert caption is not None, "web source sanitizer discarded the table caption"
            caption_start = canonical.index("late caption")
            assert (caption["start_cp"], caption["end_cp"]) == (
                caption_start,
                caption_start + len("late caption"),
            )
            caption_unit = json.loads(members[caption["unit_key"]])
            assert caption_unit["fragment_id"] == str(fragment_id)
            assert caption_unit["start_cp"] <= caption_start <= caption_unit["end_cp"]
            assert any(
                node["kind"] == "Element" and node["name"] == "caption"
                for node in caption_unit["render_nodes"]
            ), "caption source range lost its original table element"
            (output / "source-table-schema-2-members.json").write_text(
                json.dumps(
                    {
                        "source_html": source,
                        "canonical_text": canonical,
                        "package_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                        "members": members,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
    finally:
        with Session(engine) as db:
            delete_document_media_if_unreferenced(db, media_id)
            db.commit()
        for path in set(paths):
            storage.delete_object(path)
