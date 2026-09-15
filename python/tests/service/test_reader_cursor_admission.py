"""Document cursor admission preserves media-owned, bounded source addresses."""

from __future__ import annotations

from typing import Literal
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from nexus.db.models import (
    EpubFragmentSource,
    Fragment,
    Media,
    ProcessingStatus,
    ReaderEngagementState,
)
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.reader import CursorWrite
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.consumption import service as consumption
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.services.reader_publication import replace_reader_publication


@pytest.mark.parametrize("media_kind", ["web_article", "epub"])
def test_document_cursor_admits_only_owned_source_addresses(
    engine: Engine, media_kind: Literal["web_article", "epub"]
) -> None:
    viewer_id, media_id, fragment_id, foreign_media_id, foreign_fragment_id = (
        uuid4(),
        uuid4(),
        uuid4(),
        uuid4(),
        uuid4(),
    )
    source_text = "Opening\U0001f600é\nRead here.\nSecond\nStay here.\nThird.\nFourth."
    with Session(engine) as db:
        ensure_user_and_default_library(db, viewer_id, f"cursor-source-{viewer_id}@example.invalid")
        for source_media_id, source_fragment_id in (
            (media_id, fragment_id),
            (foreign_media_id, foreign_fragment_id),
        ):
            media = Media(
                id=source_media_id,
                kind=media_kind,
                title="Document cursor source",
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
                            '<h1 id="opening">Opening\U0001f600é</h1><p>Read here.</p>'
                            '<h2 id="second">Second</h2><p>Stay here.</p>'
                            '<p id="duplicate">Third.</p><p id="duplicate">Fourth.</p>'
                        ),
                    )
                )
                db.flush()
                if media_kind == "epub":
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
                db, media_id=source_media_id, expected_kind=media_kind, replace_projection=publish
            )
            media.processing_status = ProcessingStatus.ready_for_reading
        db.commit()

    target: dict[str, object] = {"fragment_id": str(fragment_id)}
    if media_kind == "epub":
        target.update(
            href_path="chapter.xhtml",
            anchor_id={"kind": "Present", "value": "stale-heading"},
        )
    locator = {
        "kind": "epub" if media_kind == "epub" else "web",
        "target": target,
        "locations": {
            "text_offset": 19 if media_kind == "epub" else None,
            "progression": None,
            "total_progression": None,
            "position": None,
        },
        "text": {"quote": None, "quote_prefix": None, "quote_suffix": None},
    }
    initial = consumption.put_reader_cursor(
        viewer_id, media_id, CursorWrite.model_validate({"locator": locator, "base_revision": 0})
    )
    assert initial.state == "Positioned"
    assert initial.locator.model_dump(mode="json") == locator, (
        "web optional offsets and EPUB bounded offsets with stale optional anchors must stay exact"
    )
    locator["locations"]["text_offset"] = len(source_text)
    accepted = consumption.put_reader_cursor(
        viewer_id,
        media_id,
        CursorWrite.model_validate({"locator": locator, "base_revision": initial.revision}),
    )
    assert accepted.state == "Positioned"
    assert accepted.locator.model_dump(mode="json") == locator, (
        "the exact unicode codepoint eof is a valid document cursor"
    )
    engagement_query = select(
        ReaderEngagementState.last_engaged_at, ReaderEngagementState.max_total_progression
    ).where(ReaderEngagementState.user_id == viewer_id, ReaderEngagementState.media_id == media_id)
    with Session(engine) as db:
        engagement_before = db.execute(engagement_query).one()

    rejected: list[tuple[str, int | None, dict[str, object]]] = [
        ("missing fragment", 0, {"fragment_id": str(uuid4())}),
        ("foreign fragment", 0, {"fragment_id": str(foreign_fragment_id)}),
        ("unbounded offset", len(source_text) + 1, {}),
    ]
    if media_kind == "web_article":
        rejected.extend(
            [
                ("malformed fragment", 0, {"fragment_id": "p0"}),
                ("noncanonical fragment", 0, {"fragment_id": str(fragment_id).replace("-", "")}),
            ]
        )
    else:
        rejected.extend(
            [
                ("no address", None, {"anchor_id": {"kind": "Absent"}}),
                ("missing anchor", None, {"anchor_id": {"kind": "Present", "value": "missing"}}),
                (
                    "ambiguous anchor",
                    None,
                    {"anchor_id": {"kind": "Present", "value": "duplicate"}},
                ),
                ("foreign href", 0, {"href_path": "foreign.xhtml"}),
            ]
        )
    for case, offset, target_change in rejected:
        invalid = {
            **locator,
            "target": {**target, **target_change},
            "locations": {**locator["locations"], "text_offset": offset, "total_progression": 1},
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
            label = "EPUB" if media_kind == "epub" else "web"
            pytest.fail(f"unrestorable {label} source address was accepted: {case}")
        with Session(engine) as db:
            assert consumption.get_reader_cursor(db, viewer_id, media_id) == accepted, case
            assert db.execute(engagement_query).one() == engagement_before, case

    if media_kind == "epub":
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
