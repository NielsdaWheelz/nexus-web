"""Visible gutter membership precedes complete counts and page limits."""

from uuid import UUID, uuid4

from sqlalchemy.orm import Session

from nexus.config import ReaderPublicationLimits
from nexus.db.models import Highlight, HighlightFragmentAnchor, NoteBlock, ResourceEdge
from tests.testkit.auth import UserRecord
from tests.testkit.reader_publication import seed_retained_text


def test_reader_gutter_counts_exact_visible_union_before_cap_and_keeps_note_stance(
    db_session: Session,
    test_user: UserRecord,
) -> None:
    from nexus.db.models import ReaderPublicationApparatusItem
    from nexus.schemas.reader_publication_evidence import ReaderEvidenceGutterRequest
    from nexus.services.reader_publication_evidence import list_reader_publication_gutter

    source = "ab" * 200
    media_id, fragment_id = seed_retained_text(
        db_session, test_user, (source[:380], source[380:]), (0, 400)
    )
    last = uuid4()
    for index in range(101):
        start, end = (index * 2, index * 2 + 1) if index < 100 else (378, 390)
        highlight_id = uuid4() if index < 100 else last
        db_session.add(
            Highlight(
                id=highlight_id,
                user_id=test_user.id,
                anchor_kind="fragment_offsets",
                anchor_media_id=media_id,
                exact=source[start:end],
                prefix="",
                suffix="",
                color="yellow",
            )
        )
        db_session.flush()
        db_session.add(
            HighlightFragmentAnchor(
                highlight_id=highlight_id,
                fragment_id=fragment_id,
                start_offset=start,
                end_offset=end,
            )
        )
    for note_id, body in (
        (UUID("10000000-0000-4000-8000-000000000000"), "z first by ref"),
        (UUID("20000000-0000-4000-8000-000000000000"), "a later by ref"),
    ):
        db_session.add(
            NoteBlock(
                id=note_id,
                user_id=test_user.id,
                body_text=body,
                body_pm_json={"type": "doc", "content": []},
            )
        )
        db_session.flush()
        db_session.add(
            ResourceEdge(
                id=uuid4(),
                user_id=test_user.id,
                kind="context",
                origin="highlight_note",
                source_scheme="highlight",
                source_id=last,
                target_scheme="note_block",
                target_id=note_id,
            )
        )
    stance_id = uuid4()
    db_session.add(
        ResourceEdge(
            id=stance_id,
            user_id=test_user.id,
            kind="supports",
            origin="user",
            source_scheme="highlight",
            source_id=last,
            target_scheme="note_block",
            target_id=note_id,
        )
    )
    db_session.add(
        ReaderPublicationApparatusItem(
            media_id=media_id,
            generation=1,
            item_id=uuid4(),
            ordinal=0,
            stable_key="eof",
            sort_key="eof",
            kind="footnote",
            label="end",
            body_text=None,
            confidence="exact",
            locator_status="resolved",
            locator={
                "type": "web_text_offsets",
                "media_id": str(media_id),
                "fragment_id": str(fragment_id),
                "start_offset": 400,
                "end_offset": 400,
            },
        )
    )
    db_session.flush()
    args = dict(
        viewer_id=test_user.id,
        media_id=media_id,
        generation=1,
        limits=ReaderPublicationLimits(
            unit_bytes=8192,
            unit_codepoints=500,
            unit_dom_nodes=100,
            index_bytes=8192,
            descriptor_bytes=1024,
        ),
    )
    request = ReaderEvidenceGutterRequest(
        window={
            "kind": "Text",
            "units": [
                {"unit_key": "units/1.json", "ranges": [[380, 385], [383, 389]]},
                {"unit_key": "units/1.json", "ranges": [[382, 384]]},
            ],
        },
        kinds=("Highlight",),
        include_stances=True,
        after=None,
        limit=1,
    )
    first = list_reader_publication_gutter(db_session, **args, request=request)
    assert first.total_count == 2, "gutter counted hidden or duplicated visible occurrences"
    assert len(first.items) == 1 and first.items[0].fact_id == f"highlight:{last}"
    assert first.items[0].excerpt == "z first by ref"
    assert first.items[0].location.range.unit_key == "units/0.json", (
        "a cross-unit span keeps its original start key outside the requested visible unit"
    )
    assert first.items[0].location.range.start_cp == 378
    assert first.items[0].location.range.end_cp == 390
    assert first.next_cursor is not None
    second = list_reader_publication_gutter(
        db_session, **args, request=request.model_copy(update={"after": first.next_cursor})
    )
    assert second.total_count == 2 and second.next_cursor is None
    assert [(item.id, item.kind, item.stance) for item in second.items] == [
        (f"margin:stance:{stance_id}", "Stance", "supports")
    ]
    stance_only = list_reader_publication_gutter(
        db_session, **args, request=request.model_copy(update={"kinds": ()})
    )
    assert stance_only.total_count == 1 and stance_only.items[0].kind == "Stance"
    point = list_reader_publication_gutter(
        db_session,
        **args,
        request=request.model_copy(
            update={
                "window": type(request.window).model_validate(
                    {
                        "kind": "Text",
                        "units": [{"unit_key": "units/1.json", "ranges": [[400, 400]]}],
                    }
                ),
                "kinds": ("SourceReference",),
                "include_stances": False,
            }
        ),
    )
    assert point.total_count == 1 and point.items[0].fact_id == "source-reference:eof"
    assert point.items[0].location.range.start_cp == point.items[0].location.range.end_cp == 400
