"""Evidence classification precedes source ordering, filters and bounded pages."""

from uuid import UUID, uuid4

from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from nexus.config import ReaderPublicationLimits
from nexus.db.models import Highlight, HighlightFragmentAnchor, NoteBlock, ResourceEdge
from nexus.schemas.reader_publication_evidence import (
    ReaderEvidenceAssociationsRequest,
    ReaderEvidenceFactAssociations,
    ReaderEvidenceFactsRequest,
    ReaderEvidenceSeekRequest,
)
from nexus.services.reader_publication_evidence import (
    list_reader_publication_evidence,
    list_reader_publication_evidence_associations,
)
from tests.testkit.auth import UserRecord
from tests.testkit.reader_publication import FIXTURE_LIMITS, seed_retained_text


def test_reader_source_marker_seek_preserves_last_displayed_owner(
    db_session: Session,
    test_user: UserRecord,
) -> None:
    from nexus.db.models import ReaderPublicationApparatusEdge, ReaderPublicationApparatusItem
    from nexus.schemas.reader_publication_evidence import ReaderEvidenceMarkerPreviewRequest
    from nexus.services.reader_publication_evidence import get_reader_publication_marker_preview

    media_id, fragment_id = seed_retained_text(db_session, test_user, ("one ", "two"), (0, 3, 4, 7))
    # The later source position wins despite earlier insertion. At the same
    # position the final locus id wins, even with an earlier stable-key label.
    owners = [
        (UUID("30000000-0000-4000-8000-000000000000"), "a-last", 4),
        (UUID("20000000-0000-4000-8000-000000000000"), "z-tied", 4),
        (UUID("40000000-0000-4000-8000-000000000000"), "later-id-earlier-source", 0),
    ]
    target_id = uuid4()
    for ordinal, (item_id, key, offset) in enumerate([*owners, (target_id, "shared-target", 6)]):
        db_session.add(
            ReaderPublicationApparatusItem(
                media_id=media_id,
                generation=1,
                item_id=item_id,
                ordinal=ordinal,
                stable_key=key,
                sort_key=f"source:{ordinal}",
                kind="footnote" if item_id == target_id else "footnote_ref",
                label=key,
                body_text="shared authored note" if item_id == target_id else None,
                confidence="exact",
                locator_status="resolved",
                locator={
                    "type": "web_text_offsets",
                    "media_id": str(media_id),
                    "fragment_id": str(fragment_id),
                    "start_offset": offset,
                    "end_offset": offset,
                },
            )
        )
    db_session.flush()
    for ordinal, (item_id, _key, _offset) in enumerate(owners):
        db_session.add(
            ReaderPublicationApparatusEdge(
                media_id=media_id,
                generation=1,
                edge_id=uuid4(),
                ordinal=ordinal,
                from_item_id=item_id,
                to_item_id=target_id,
                relation="points_to_note",
                confidence="exact",
            )
        )
    db_session.flush()
    args = dict(
        viewer_id=test_user.id,
        media_id=media_id,
        generation=1,
        limits=ReaderPublicationLimits(
            unit_bytes=8192,
            unit_codepoints=100,
            unit_dom_nodes=100,
            index_bytes=4096,
            descriptor_bytes=1024,
        ),
    )
    page = list_reader_publication_evidence(
        db_session,
        **args,
        request=ReaderEvidenceSeekRequest(
            target={"kind": "SourceReference", "stable_key": "shared-target"},
            scope="Passages",
            kinds=("SourceReference",),
            limit=1,
        ),
    )
    assert [item.id for item in page.items] == ["source-reference:a-last"], (
        "shared source marker chose a different displayed owner"
    )
    assert page.counts.citations == 3 and page.items[0].target_count == 1
    preview = get_reader_publication_marker_preview(
        db_session,
        **args,
        request=ReaderEvidenceMarkerPreviewRequest(
            marker_id="marker:SourceReference:source-reference:a-last"
        ),
    )
    assert preview.model_dump() == dict(
        marker_id="marker:SourceReference:source-reference:a-last",
        kind="SourceReference",
        tone="Citation",
        label_excerpt="a-last",
        label_codepoints=6,
        excerpt="shared authored note",
        excerpt_codepoints=20,
    )


def test_reader_evidence_pages_count_facts_before_coalescing_and_keep_retained_source(
    db_session: Session,
    test_user: UserRecord,
) -> None:
    media_id, fragment_id = seed_retained_text(db_session, test_user, ("one ", "two"), (0, 3, 4, 7))
    highlight_id, note_id, attached_id, loose_id = (uuid4() for _ in range(4))
    authored_note = "🧠é" * 400_000
    db_session.add(
        NoteBlock(
            id=note_id,
            user_id=test_user.id,
            body_text=authored_note,
            body_pm_json={"type": "doc", "content": []},
        )
    )
    db_session.add(
        Highlight(
            id=highlight_id,
            user_id=test_user.id,
            anchor_kind="fragment_offsets",
            anchor_media_id=media_id,
            exact="two",
            prefix="one ",
            suffix="",
            color="yellow",
        )
    )
    db_session.flush()
    db_session.add(
        HighlightFragmentAnchor(
            highlight_id=highlight_id, fragment_id=fragment_id, start_offset=4, end_offset=7
        )
    )
    for edge_id, target_scheme, target_id in (
        (attached_id, "highlight", highlight_id),
        (loose_id, "fragment", fragment_id),
    ):
        db_session.add(
            ResourceEdge(
                id=edge_id,
                user_id=test_user.id,
                kind="context",
                origin="user",
                source_scheme="note_block",
                source_id=note_id,
                target_scheme=target_scheme,
                target_id=target_id,
            )
        )
    db_session.flush()
    limits = ReaderPublicationLimits(
        unit_bytes=8192,
        unit_codepoints=100,
        unit_dom_nodes=100,
        index_bytes=8192,
        descriptor_bytes=1024,
    )
    request = ReaderEvidenceFactsRequest(
        scope="Passages",
        kinds=("Highlight", "SourceReference", "GeneratedCitation", "Link", "Synapse"),
        window=None,
        after=None,
        limit=1,
    )
    try:
        page = list_reader_publication_evidence(
            db_session,
            viewer_id=test_user.id,
            media_id=media_id,
            generation=1,
            request=request,
            limits=limits,
        )
    except DBAPIError as exc:
        raise AssertionError(str(exc.orig)) from None
    assert page.counts.model_dump() == {
        "highlights": 1,
        "citations": 0,
        "links": 1,
        "synapses": 0,
        "passages": 2,
        "document": 0,
    }
    # The unattached fragment Link comes first in source order. Its note body
    # remains exact in its owner; the reader receives a Unicode excerpt only.
    assert [item.id for item in page.items] == [f"link:{loose_id}:anchor:fragment:{fragment_id}"]
    assert page.items[0].object.excerpt == authored_note[:300]
    assert page.items[0].object.excerpt_codepoints == len(authored_note)
    assert page.items[0].position.range.unit_key == "units/0.json"
    assert page.next_cursor is not None
    second = list_reader_publication_evidence(
        db_session,
        viewer_id=test_user.id,
        media_id=media_id,
        generation=1,
        request=request.model_copy(update={"after": page.next_cursor}),
        limits=limits,
    )
    assert [item.id for item in second.items] == [f"highlight:{highlight_id}"]
    assert second.items[0].association_count == 1
    assert second.items[0].position.range.unit_key == "units/1.json"
    assert second.next_cursor is None
    associations = list_reader_publication_evidence_associations(
        db_session,
        viewer_id=test_user.id,
        media_id=media_id,
        generation=1,
        request=ReaderEvidenceAssociationsRequest(
            target=ReaderEvidenceFactAssociations(fact_id=f"highlight:{highlight_id}"),
            after=None,
            limit=10,
        ),
        limits=limits,
    )
    assert len(associations.items) == 1
    assert associations.items[0].relationship == "DirectlyAttached"
    assert associations.items[0].edge_id == attached_id
    assert associations.items[0].direction == "Outgoing"  # Existing neutral-Link presentation.
    seek = list_reader_publication_evidence(
        db_session,
        viewer_id=test_user.id,
        media_id=media_id,
        generation=1,
        request=ReaderEvidenceSeekRequest(
            target={"kind": "Fact", "fact_id": f"highlight:{highlight_id}"},
            scope="Passages",
            kinds=request.kinds,
            limit=1,
        ),
        limits=limits,
    )
    assert [item.id for item in seek.items] == [f"highlight:{highlight_id}"]
    assert db_session.get(NoteBlock, note_id).body_text == authored_note


def test_reader_evidence_classifies_shared_locus_before_counting_and_pages_all_markers(
    db_session: Session,
    test_user: UserRecord,
) -> None:
    from nexus.db.models import (
        Conversation,
        Message,
        ReaderPublicationTarget,
        ReaderPublicationUnit,
    )
    from nexus.schemas.reader_publication_evidence import (
        ReaderEvidenceBucketRequest,
        ReaderEvidenceLocationRequest,
        ReaderEvidenceLocusAssociations,
        ReaderEvidenceOverviewRequest,
    )
    from nexus.services.reader_publication_evidence import (
        get_reader_publication_evidence_overview,
        list_reader_publication_evidence_bucket,
        locate_reader_publication_evidence,
    )

    media_id, fragment_id = seed_retained_text(db_session, test_user, ("one ", "two"), (0, 3, 4, 7))
    conversation, message, note, highlight = (uuid4() for _ in range(4))
    citation, companion, synapse, context, neutral, highlight_citation = (uuid4() for _ in range(6))
    embed, unavailable_embed = uuid4(), uuid4()
    db_session.add(Conversation(id=conversation, owner_user_id=test_user.id, title="source chat"))
    db_session.add(
        NoteBlock(
            id=note,
            user_id=test_user.id,
            body_text="related note",
            body_pm_json={"type": "doc", "content": []},
        )
    )
    db_session.add(
        Highlight(
            id=highlight,
            user_id=test_user.id,
            anchor_kind="fragment_offsets",
            anchor_media_id=media_id,
            exact="two",
            prefix="one ",
            suffix="",
            color="yellow",
        )
    )
    db_session.flush()
    parent_message = uuid4()
    db_session.add(
        Message(
            id=parent_message,
            conversation_id=conversation,
            seq=1,
            role="user",
            content="source question",
        )
    )
    db_session.flush()
    db_session.add(
        Message(
            id=message,
            conversation_id=conversation,
            seq=2,
            role="assistant",
            content="authored citation",
            parent_message_id=parent_message,
        )
    )
    db_session.add(
        HighlightFragmentAnchor(
            highlight_id=highlight, fragment_id=fragment_id, start_offset=4, end_offset=7
        )
    )
    db_session.add(
        ReaderPublicationTarget(
            media_id=media_id,
            generation=1,
            target_id="chapter",
            ordinal=0,
            label="chapter",
            unit_key="units/0.json",
            offset_cp=0,
            end_cp=7,
        )
    )
    unit = db_session.get(ReaderPublicationUnit, (media_id, 1, "units/1.json"))
    unit.embed_markers = [
        {
            "id": str(embed),
            "ordinal": 0,
            "occurrence_key": "last",
            "canonical_start_offset": 7,
            "canonical_end_offset": 7,
        },
        {
            "id": str(unavailable_embed),
            "ordinal": 1,
            "occurrence_key": "unlocated",
            "canonical_start_offset": None,
            "canonical_end_offset": None,
        },
    ]
    for edge_id, source_scheme, source_id, target_scheme, target_id, origin, ordinal, snapshot in (
        (
            citation,
            "message",
            message,
            "fragment",
            fragment_id,
            "citation",
            1,
            {"title": "  cited title  ", "excerpt": "  cited excerpt  "},
        ),
        (companion, "conversation", conversation, "fragment", fragment_id, "user", None, None),
        (
            synapse,
            "highlight",
            highlight,
            "note_block",
            note,
            "synapse",
            None,
            {"excerpt": "shared evidence"},
        ),
        (
            highlight_citation,
            "message",
            message,
            "highlight",
            highlight,
            "citation",
            2,
            {"title": "highlight citation"},
        ),
        (context, "note_block", note, "fragment", fragment_id, "user", None, None),
        (neutral, "highlight", highlight, "fragment", fragment_id, "user", None, None),
    ):
        db_session.add(
            ResourceEdge(
                id=edge_id,
                user_id=test_user.id,
                kind="context",
                origin=origin,
                source_scheme=source_scheme,
                source_id=source_id,
                target_scheme=target_scheme,
                target_id=target_id,
                ordinal=ordinal,
                snapshot=snapshot,
            )
        )
    db_session.flush()
    args = dict(viewer_id=test_user.id, media_id=media_id, generation=1, limits=FIXTURE_LIMITS)
    kinds = ("Highlight", "SourceReference", "GeneratedCitation", "Link", "Synapse")
    try:
        page = list_reader_publication_evidence(
            db_session,
            **args,
            request=ReaderEvidenceFactsRequest(
                scope="Passages", kinds=kinds, window=None, after=None, limit=100
            ),
        )
    except DBAPIError as exc:
        raise AssertionError(str(exc.orig)) from None
    facts = list(page.items)
    continuation = page.next_cursor
    while continuation is not None:
        next_page = list_reader_publication_evidence(
            db_session,
            **args,
            request=ReaderEvidenceFactsRequest(
                scope="Passages", kinds=kinds, window=None, after=continuation, limit=100
            ),
        )
        assert next_page.counts == page.counts
        assert (
            len(next_page.model_dump_json().encode()) + len(b'{"data":}')
            <= FIXTURE_LIMITS.index_bytes
        )
        facts.extend(next_page.items)
        continuation = next_page.next_cursor
    assert [(item.kind, item.id) for item in facts] == [
        ("GeneratedCitation", f"generated-citation:{citation}"),
        ("Highlight", f"highlight:{highlight}"),
        ("GeneratedCitation", f"generated-citation:{highlight_citation}"),
        ("Synapse", f"synapse:{synapse}"),
    ]
    assert page.counts.model_dump() == dict(
        highlights=1, citations=2, links=0, synapses=1, passages=4, document=0
    )
    assert page.items[0].label_excerpt == "cited title" and page.items[0].excerpt == "cited excerpt"
    assert page.items[0].association_count == 1
    assert page.items[0].also_reference_count == 2  # Other note and the other local endpoint.
    associated = list_reader_publication_evidence_associations(
        db_session,
        **args,
        request=ReaderEvidenceAssociationsRequest(
            target=ReaderEvidenceLocusAssociations(locus_ref=f"fragment:{fragment_id}"),
            after=None,
            limit=100,
        ),
    )
    assert {item.object.ref for item in associated.items} == {
        f"note_block:{note}",
        f"highlight:{highlight}",
    }
    assert all(item.relationship == "AlsoReferences" for item in associated.items)
    location = locate_reader_publication_evidence(
        db_session, **args, request=ReaderEvidenceLocationRequest(fact_id=f"highlight:{highlight}")
    )
    assert location.location.model_dump() == {
        "kind": "Text",
        "range": {
            "unit_key": "units/1.json",
            "fragment_id": str(fragment_id),
            "start_cp": 4,
            "end_cp": 7,
        },
    }
    marker_kinds = ("Contents", "Embed", *kinds)
    overview = get_reader_publication_evidence_overview(
        db_session,
        **args,
        request=ReaderEvidenceOverviewRequest(bucket_count=1, kinds=marker_kinds),
    )
    assert overview.buckets[0].counts.model_dump() == dict(
        contents=1,
        embeds=1,
        highlights=1,
        source_references=0,
        generated_citations=2,
        links=0,
        synapses=1,
    )
    assert overview.unavailable_counts.embeds == 1
    request = ReaderEvidenceBucketRequest(
        bucket_count=1, index=0, kinds=marker_kinds, after=None, limit=2
    )
    markers = []
    while True:
        bucket = list_reader_publication_evidence_bucket(db_session, **args, request=request)
        markers.extend(bucket.items)
        if bucket.next_cursor is None:
            break
        request = request.model_copy(update={"after": bucket.next_cursor})
    assert [(item.kind, item.position) for item in markers] == [
        ("Contents", 0),
        ("GeneratedCitation", 0),
        ("GeneratedCitation", 4 / 7),
        ("Highlight", 4 / 7),
        ("Synapse", 4 / 7),
        ("Embed", 1),
    ]
    assert markers[0].target.section_id == "chapter"
    assert markers[-1].target.id == embed and markers[-1].target.unit_key == "units/1.json"
