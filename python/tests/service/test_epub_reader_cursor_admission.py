"""EPUB cursor admission preserves only restorable, media-owned source addresses."""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from nexus.db.models import EpubFragmentSource, Fragment, Media, ProcessingStatus
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.reader import CursorWrite
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.consumption import service as consumption
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.services.reader_publication import replace_reader_publication


def test_epub_cursor_admits_only_owned_exact_offsets_or_unique_source_anchors(
    engine: Engine,
) -> None:
    viewer_id, media_id, fragment_id, foreign_media_id, foreign_fragment_id = (
        uuid4(),
        uuid4(),
        uuid4(),
        uuid4(),
        uuid4(),
    )
    source_text = "Opening\nRead here.\nSecond\nStay here.\nThird.\nFourth."
    with Session(engine) as db:
        ensure_user_and_default_library(db, viewer_id, f"cursor-source-{viewer_id}@example.invalid")
        for source_media_id, source_fragment_id in (
            (media_id, fragment_id),
            (foreign_media_id, foreign_fragment_id),
        ):
            media = Media(
                id=source_media_id,
                kind="epub",
                title="EPUB cursor source",
                processing_status=ProcessingStatus.extracting,
                created_by_user_id=viewer_id,
            )
            db.add(media)
            db.flush()
            ensure_media_in_default_library(db, viewer_id, source_media_id)

            def publish(
                _media: Media,
                *,
                source_media_id: UUID = source_media_id,
                source_fragment_id: UUID = source_fragment_id,
            ) -> None:
                db.add(
                    Fragment(
                        id=source_fragment_id,
                        media_id=source_media_id,
                        idx=0,
                        canonical_text=source_text,
                        html_sanitized=(
                            '<h1 id="opening">Opening</h1><p>Read here.</p>'
                            '<h2 id="second">Second</h2><p>Stay here.</p>'
                            '<p id="duplicate">Third.</p><p id="duplicate">Fourth.</p>'
                        ),
                    )
                )
                db.flush()
                db.add(
                    EpubFragmentSource(
                        media_id=source_media_id,
                        fragment_id=source_fragment_id,
                        package_href="chapter.xhtml",
                        manifest_item_id="chapter",
                        spine_itemref_id="spine",
                        media_type="application/xhtml+xml",
                        linear=True,
                        reading_order=0,
                    )
                )

            replace_reader_publication(
                db, media_id=source_media_id, expected_kind="epub", replace_projection=publish
            )
            media.processing_status = ProcessingStatus.ready_for_reading
        db.commit()

    locator = {
        "kind": "epub",
        "target": {
            "fragment_id": str(fragment_id),
            "href_path": "chapter.xhtml",
            "anchor_id": {"kind": "Present", "value": "stale-heading"},
        },
        "locations": {
            "text_offset": 19,
            "progression": None,
            "total_progression": None,
            "position": None,
        },
        "text": {"quote": None, "quote_prefix": None, "quote_suffix": None},
    }
    accepted = consumption.put_reader_cursor(
        viewer_id, media_id, CursorWrite.model_validate({"locator": locator, "base_revision": 0})
    )
    assert accepted.state == "Positioned"
    assert accepted.locator.model_dump(mode="json") == locator, (
        "a bounded source offset must remain exact when its optional anchor is stale"
    )
    for case, offset, target in (
        ("no address", None, {"anchor_id": {"kind": "Absent"}}),
        ("missing anchor", None, {"anchor_id": {"kind": "Present", "value": "missing"}}),
        ("ambiguous anchor", None, {"anchor_id": {"kind": "Present", "value": "duplicate"}}),
        (
            "unbounded offset",
            len(source_text) + 1,
            {"anchor_id": {"kind": "Present", "value": "opening"}},
        ),
        ("foreign fragment", 0, {"fragment_id": str(foreign_fragment_id)}),
        ("foreign href", 0, {"href_path": "foreign.xhtml"}),
    ):
        invalid = {
            **locator,
            "target": {**locator["target"], **target},
            "locations": {**locator["locations"], "text_offset": offset},
        }
        try:
            consumption.put_reader_cursor(
                viewer_id,
                media_id,
                CursorWrite.model_validate(
                    {"locator": invalid, "base_revision": accepted.revision}
                ),
            )
        except InvalidRequestError as error:
            assert error.code == ApiErrorCode.E_INVALID_REQUEST, case
        else:
            pytest.fail(f"unrestorable EPUB source address was accepted: {case}, media={media_id}")
    with Session(engine) as db:
        assert consumption.get_reader_cursor(db, viewer_id, media_id) == accepted, (
            "rejected source addresses must preserve accepted progress"
        )

    locator["target"]["anchor_id"] = {"kind": "Present", "value": "second"}
    locator["locations"]["text_offset"] = None
    anchored = consumption.put_reader_cursor(
        viewer_id,
        media_id,
        CursorWrite.model_validate({"locator": locator, "base_revision": accepted.revision}),
    )
    assert anchored.state == "Positioned"
    assert anchored.locator.model_dump(mode="json") == locator, (
        "a unique source anchor must remain exact without inventing a text offset"
    )
