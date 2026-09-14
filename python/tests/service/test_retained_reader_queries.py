"""Retained queries preserve exact coordinates across splits and replacements."""

from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from nexus.config import ReaderPublicationLimits
from nexus.db.models import (
    Media,
    ReaderPublication,
    ReaderPublicationArtifact,
    ReaderPublicationTarget,
    ReaderPublicationUnit,
)
from nexus.errors import ApiError, ApiErrorCode, ReaderContentTooLargeError
from nexus.ids import new_uuid7
from nexus.schemas.epub_find import EpubFindEntireResourceScopeIn
from nexus.schemas.reader import (
    ReaderFragmentTarget,
    ReaderQuoteContext,
    ReaderTextLocations,
    WebReaderResumeState,
)
from nexus.schemas.reader_publication import (
    ReaderPublicationFindRequest,
    ReaderPublicationIncomplete,
    ReaderPublicationLocatorTarget,
    ReaderPublicationNavigationTarget,
    ReaderPublicationResolveRequest,
    ReaderPublicationSectionScope,
    ReaderPublicationTextResolution,
    ReaderPublicationUnitResolution,
    ReaderPublicationUnitTarget,
    ReaderPublicationUnresolved,
)
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.services.reader_publication_find import find_reader_publication_for_viewer
from nexus.services.reader_publication_resolve import resolve_reader_publication_for_viewer
from tests.testkit.auth import UserRecord
from tests.testkit.reader_publication import seed_retained_text


def test_retained_fragment_keeps_owner_rollup_and_final_deletion_ownership(
    db_session: Session,
    test_user: UserRecord,
) -> None:
    from nexus.db.models import NoteBlock, ResourceEdge
    from nexus.services.library_entries import delete_all_entries_for_media
    from nexus.services.media_deletion import delete_document_media_if_unreferenced
    from nexus.services.reader_publication_read import get_reader_publication_member_for_viewer
    from nexus.services.resource_graph.connections import query_connections
    from nexus.services.resource_graph.refs import ResourceRef
    from nexus.services.resource_graph.schemas import ConnectionFilters, ConnectionQuery

    media_id, fragment_id = seed_retained_text(db_session, test_user, ("retained",), (0, 8))
    note_id, edge_id = uuid4(), uuid4()
    db_session.add(
        NoteBlock(
            id=note_id,
            user_id=test_user.id,
            body_pm_json={"type": "doc", "content": []},
            body_text="Related note",
        )
    )
    db_session.add(
        ResourceEdge(
            id=edge_id,
            user_id=test_user.id,
            kind="context",
            origin="user",
            source_scheme="note_block",
            source_id=note_id,
            target_scheme="fragment",
            target_id=fragment_id,
        )
    )
    db_session.flush()
    page = query_connections(
        db_session,
        viewer_id=test_user.id,
        query=ConnectionQuery(
            refs=(ResourceRef("media", media_id),),
            direction="both",
            rollup="owner",
            filters=ConnectionFilters(),
            limit=20,
        ),
    )
    assert [item.edge_id for item in page.items] == [edge_id]
    assert page.items[0].other.ref == ResourceRef("note_block", note_id)
    assert (
        page.items[0].target.missing is True
    )  # A logical ref never chooses a retained generation.
    assert (
        get_reader_publication_member_for_viewer(
            db_session,
            viewer_id=test_user.id,
            media_id=media_id,
            generation=1,
            key="units/0.json",
            role="unit",
        ).generation
        == 1
    )
    delete_all_entries_for_media(db_session, media_id)
    with pytest.raises(ApiError) as revoked:
        get_reader_publication_member_for_viewer(
            db_session,
            viewer_id=test_user.id,
            media_id=media_id,
            generation=1,
            key="units/0.json",
            role="unit",
        )
    assert revoked.value.code == ApiErrorCode.E_MEDIA_NOT_FOUND, (
        f"revoked visibility of media {media_id} must mask the retained member as absent"
    )
    delete_document_media_if_unreferenced(db_session, media_id=media_id)
    db_session.flush()
    assert db_session.get(ResourceEdge, edge_id) is None
    assert db_session.get(NoteBlock, note_id).body_text == "Related note"


def test_retained_embed_cards_keep_original_targets_and_read_current_capabilities(
    db_session: Session,
    test_user: UserRecord,
) -> None:
    import hashlib

    from nexus.schemas.media import DocumentEmbedSource, DocumentEmbedTargetMaterialized
    from nexus.schemas.reader_publication import ReaderPublicationEmbedsRequest
    from nexus.schemas.reader_publication_evidence import ReaderEvidenceMarkerPreviewRequest
    from nexus.services import library_entries
    from nexus.services.reader_publication_embeds import list_reader_publication_embeds
    from nexus.services.reader_publication_evidence import get_reader_publication_marker_preview
    from nexus.services.reader_publication_units import split_reader_publication_fragment
    from nexus.storage.client import get_storage_client
    from nexus.storage.paths import build_reader_publication_member_storage_path

    media_id, fragment_id = seed_retained_text(db_session, test_user, ("one\ntwo",), (0, 3, 4, 7))
    children = [uuid4(), uuid4()]
    for index, child_id in enumerate(children):
        db_session.add(
            Media(
                id=child_id,
                kind="web_article",
                title=f"Live child {index}",
                processing_status="ready_for_reading",
                created_by_user_id=test_user.id,
            )
        )
        db_session.flush()
        ensure_media_in_default_library(db_session, test_user.id, child_id)
    sources = tuple(
        DocumentEmbedSource(
            id=uuid4(),
            ordinal=index,
            occurrence_key=f"embed:{index}",
            provider="x",
            embed_kind="post",
            source_shape="provider_json",
            source_url=f"https://x.com/i/status/{index + 42}",
            canonical_source_url=f"https://x.com/i/status/{index + 42}",
            provider_target_ref=str(index + 42),
            title=None,
            authored_text=None,
            placeholder_text=word,
            canonical_start_offset=index * 4,
            canonical_end_offset=index * 4 + 3,
            target=DocumentEmbedTargetMaterialized(media_id=child_id),
        )
        for index, (word, child_id) in enumerate(zip(("one", "two"), children, strict=True))
    )
    limits = ReaderPublicationLimits(
        unit_bytes=8192,
        unit_codepoints=100,
        unit_dom_nodes=30,
        index_bytes=2000,
        descriptor_bytes=1000,
    )
    unit = next(
        split_reader_publication_fragment(
            fragment_id=fragment_id,
            fragment_idx=0,
            fragment_document_start_cp=0,
            fragment_document_word_start=0,
            epub_target=None,
            document_embeds=sources,
            html_sanitized='<p data-nexus-document-embed-id="embed:0">one</p><p data-nexus-document-embed-id="embed:1">two</p>',
            canonical_text="one\ntwo",
            assets_by_url={},
            limits=limits,
        )
    )
    payload = unit.model_dump_json().encode("utf-8")
    digest = hashlib.sha256(payload).hexdigest()
    path = build_reader_publication_member_storage_path(media_id, digest)
    storage = get_storage_client()
    storage.put_object(path, payload, "application/json")
    member = db_session.get(ReaderPublicationArtifact, (media_id, 1, "units/0.json"))
    assert member is not None
    member.storage_path, member.size_bytes, member.sha256 = path, len(payload), digest
    retained_unit = db_session.get(ReaderPublicationUnit, (media_id, 1, "units/0.json"))
    assert retained_unit is not None
    retained_unit.embed_markers = [
        {
            "id": str(source.id),
            "ordinal": source.ordinal,
            "occurrence_key": source.occurrence_key,
            "canonical_start_offset": source.canonical_start_offset,
            "canonical_end_offset": source.canonical_end_offset,
        }
        for source in sources
    ]
    db_session.commit()
    try:
        first = list_reader_publication_embeds(
            db_session,
            viewer_id=test_user.id,
            media_id=media_id,
            generation=1,
            request=ReaderPublicationEmbedsRequest(unit_key="units/0.json", after_ordinal=None),
            limits=limits,
        )
        assert [item.id for item in first.items] == [sources[0].id]
        assert first.next_ordinal == 0
        assert first.items[0].target.media_id == children[0]
        assert first.items[0].target.title == "Live child 0"
        second = list_reader_publication_embeds(
            db_session,
            viewer_id=test_user.id,
            media_id=media_id,
            generation=1,
            request=ReaderPublicationEmbedsRequest(unit_key="units/0.json", after_ordinal=0),
            limits=limits,
        )
        assert [item.id for item in second.items] == [sources[1].id]
        assert second.next_ordinal is None
        child = db_session.get(Media, children[0])
        assert child is not None
        child.title, child.processing_status = "Changed after publication", "failed"
        child.last_error_code, child.last_error_message = "E_SOURCE_FAILED", "Current failure"
        db_session.commit()
        changed = list_reader_publication_embeds(
            db_session,
            viewer_id=test_user.id,
            media_id=media_id,
            generation=1,
            request=ReaderPublicationEmbedsRequest(unit_key="units/0.json", after_ordinal=None),
            limits=limits,
        )
        assert changed.items[0].id == sources[0].id
        assert changed.items[0].target.media_id == children[0]
        assert changed.items[0].target.title == "Changed after publication"
        assert changed.items[0].display.mode == "failed"
        preview = get_reader_publication_marker_preview(
            db_session,
            viewer_id=test_user.id,
            media_id=media_id,
            generation=1,
            request=ReaderEvidenceMarkerPreviewRequest(
                marker_id=f"marker:Embed:embed:{sources[0].id}"
            ),
            limits=limits,
        )
        assert preview.model_dump() == {
            "marker_id": f"marker:Embed:embed:{sources[0].id}",
            "kind": "Embed",
            "tone": "Warning",
            "label_excerpt": "one",
            "label_codepoints": 3,
            "excerpt": "Current failure",
            "excerpt_codepoints": 15,
        }
        assert all(
            action.disabled
            for action in changed.items[0].display.actions
            if action.kind == "retry_child"
        )
        library_entries.delete_all_entries_for_media(db_session, children[0])
        db_session.commit()
        denied = list_reader_publication_embeds(
            db_session,
            viewer_id=test_user.id,
            media_id=media_id,
            generation=1,
            request=ReaderPublicationEmbedsRequest(unit_key="units/0.json", after_ordinal=None),
            limits=limits,
        )
        assert denied.items[0].target.status == "forbidden"
        assert denied.items[0].target.title is None
        assert denied.items[0].target.href is None
    finally:
        storage.delete_object(path)


def test_retained_highlight_paint_preserves_source_identity_order_and_pagination(
    db_session: Session, test_user: UserRecord, authenticated_client: TestClient
) -> None:
    from datetime import UTC, datetime, timedelta

    from nexus.db.models import Highlight, HighlightFragmentAnchor
    from nexus.schemas.reader_publication import ReaderPublicationHighlightsRequest
    from nexus.services.highlights import get_highlight
    from nexus.services.reader_publication_highlights import list_reader_publication_highlights

    media_id, old_fragment = seed_retained_text(
        db_session, test_user, ("one two", ""), (0, 3, 4, 7)
    )
    # Generation 2 changes the title only; generation 3 replaces the source.
    new_fragment = uuid4()
    from sqlalchemy import select

    publication = db_session.scalar(
        select(ReaderPublication).where(ReaderPublication.media_id == media_id)
    )
    assert publication is not None
    publication.generation = 3
    db_session.add(
        ReaderPublicationArtifact(
            media_id=media_id,
            generation=3,
            path="descriptor.json",
            role="descriptor",
            storage_path=f"proof/{media_id}/3/descriptor",
            media_type="application/json",
            size_bytes=2,
            sha256="0" * 64,
        )
    )
    for generation, fragment, canonical in (
        (2, old_fragment, "one two"),
        (3, new_fragment, "new one two"),
    ):
        db_session.add(
            ReaderPublicationArtifact(
                media_id=media_id,
                generation=generation,
                path="units/0.json",
                role="unit",
                storage_path=f"proof/{media_id}/{generation}/unit",
                media_type="application/json",
                size_bytes=100,
                sha256="1" * 64,
            )
        )
        db_session.flush()
        db_session.add(
            ReaderPublicationUnit(
                embed_markers=[],
                media_id=media_id,
                generation=generation,
                unit_key="units/0.json",
                ordinal=0,
                fragment_id=fragment,
                fragment_idx=0,
                start_cp=0,
                end_cp=len(canonical),
                canonical_text=canonical,
                word_boundaries=[],
            )
        )
    first, second, current = uuid4(), uuid4(), uuid4()
    authored = datetime(2026, 1, 1, tzinfo=UTC)
    for highlight_id, fragment, start, end, exact, created in (
        (first, old_fragment, 0, 3, "one", authored),
        (second, old_fragment, 0, 7, "one two", authored + timedelta(seconds=1)),
        (current, new_fragment, 0, 3, "new", authored),
    ):
        db_session.add(
            Highlight(
                id=highlight_id,
                user_id=test_user.id,
                anchor_kind="fragment_offsets",
                anchor_media_id=media_id,
                color="yellow",
                exact=exact,
                prefix="",
                suffix="",
                created_at=created,
            )
        )
        db_session.flush()
        db_session.add(
            HighlightFragmentAnchor(
                highlight_id=highlight_id, fragment_id=fragment, start_offset=start, end_offset=end
            )
        )
    db_session.flush()
    limits = ReaderPublicationLimits(
        unit_bytes=1000,
        unit_codepoints=100,
        unit_dom_nodes=10,
        index_bytes=2000,
        descriptor_bytes=1000,
    )

    def page(generation: int, after: str | None = None, key: str = "units/0.json"):
        return list_reader_publication_highlights(
            db_session,
            viewer_id=test_user.id,
            media_id=media_id,
            generation=generation,
            request=ReaderPublicationHighlightsRequest(
                unit_key=key, mine_only=True, after=after, limit=1
            ),
            limits=limits,
        )

    old = page(1)
    assert [item.id for item in old.items] == [first]
    assert old.items[0].created_at == authored
    assert old.items[0].start_offset == 0 and old.items[0].end_offset == 3
    assert old.next_cursor is not None
    remaining = page(1, old.next_cursor)
    assert [item.id for item in remaining.items] == [second]
    assert remaining.next_cursor is None
    assert page(2).items == old.items, "title publication must preserve source-bound paint"
    assert [item.id for item in page(3).items] == [current], "replacement must not borrow old paint"
    assert page(1, key="units/1.json").items == (), "image-only units have no text to paint"
    with pytest.raises(ApiError) as replayed:
        page(2, old.next_cursor)
    assert replayed.value.code == ApiErrorCode.E_INVALID_CURSOR, (
        f"a generation 1 cursor for media {media_id} must not continue a generation 2 page"
    )
    assert set(old.items[0].model_dump()) == {
        "id",
        "color",
        "start_offset",
        "end_offset",
        "created_at",
        "author_user_id",
        "is_owner",
    }
    # The existing quote-repair owner can move the disposable cache to the new
    # immutable fragment. That must not erase or falsely repaint authored data.
    cache = db_session.get(HighlightFragmentAnchor, first)
    assert cache is not None
    cache.fragment_id, cache.start_offset, cache.end_offset = new_fragment, 4, 7
    db_session.flush()
    assert [item.id for item in page(1).items] == [second]
    assert [item.id for item in page(2).items] == [second]
    assert get_highlight(db_session, test_user.id, first).exact == "one"
    response = authenticated_client.post(
        f"/media/{media_id}/reader-publications/1/highlights",
        json={"unit_key": "units/0.json", "mine_only": True, "after": None, "limit": 1},
    )
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, no-store, no-transform"
    assert int(response.headers["content-length"]) == len(response.content)
    assert [item["id"] for item in response.json()["data"]["items"]] == [str(second)]

    long_quote = ("🧠a " * 150).strip()
    missing = uuid4()
    db_session.add(
        Highlight(
            id=missing,
            user_id=test_user.id,
            anchor_kind="fragment_offsets",
            anchor_media_id=media_id,
            color="blue",
            exact=long_quote,
            prefix="",
            suffix="",
            created_at=authored + timedelta(seconds=2),
        )
    )
    db_session.flush()
    db_session.add(
        HighlightFragmentAnchor(
            highlight_id=missing, fragment_id=uuid4(), start_offset=0, end_offset=len(long_quote)
        )
    )
    db_session.flush()
    after = None
    summaries = []
    for _ in range(4):
        response = authenticated_client.post(
            f"/media/{media_id}/reader-publications/1/highlight-summaries",
            json={"mine_only": True, "after": after, "limit": 1},
        )
        assert response.status_code == 200, response.text
        assert response.headers["cache-control"] == "private, no-store, no-transform"
        assert int(response.headers["content-length"]) == len(response.content)
        payload = response.json()["data"]
        summaries.extend(payload["items"])
        after = payload["next_cursor"]
        if after is None:
            break
    assert after is None
    assert [item["id"] for item in summaries] == [
        str(second),
        str(current),
        str(missing),
        str(first),
    ]
    by_id = {item["id"]: item for item in summaries}
    assert by_id[str(second)]["range"] == {
        "fragment_id": str(old_fragment),
        "unit_key": "units/0.json",
        "start_cp": 0,
        "end_cp": 7,
    }
    assert by_id[str(first)]["range"] is None
    assert by_id[str(missing)]["range"] is None
    assert by_id[str(missing)]["quote_excerpt"] == long_quote[:300]
    assert by_id[str(missing)]["quote_codepoints"] == len(long_quote)
    assert get_highlight(db_session, test_user.id, missing).exact == long_quote


def test_retained_find_and_resolution_cross_units_without_losing_source_or_coordinates(
    db_session: Session,
    test_user: UserRecord,
) -> None:
    chunks = ("the ca", "", "", "t 🧠 the ", "cat")
    media_id, fragment_id = seed_retained_text(
        db_session,
        test_user,
        chunks,
        (0, 3, 4, 7, 8, 9, 10, 13, 14, 17),
    )
    db_session.add(
        ReaderPublicationTarget(
            media_id=media_id,
            generation=1,
            target_id="section",
            ordinal=0,
            label="Whole passage",
            unit_key="units/0.json",
            offset_cp=0,
            end_cp=17,
            href_path=None,
            anchor_id=None,
        )
    )
    db_session.flush()
    limits = ReaderPublicationLimits(
        unit_bytes=1100,
        unit_codepoints=160,
        unit_dom_nodes=20,
        index_bytes=2000,
        descriptor_bytes=1000,
    )
    navigation = resolve_reader_publication_for_viewer(
        db_session,
        viewer_id=test_user.id,
        media_id=media_id,
        generation=1,
        request=ReaderPublicationResolveRequest(
            target=ReaderPublicationNavigationTarget(target_id="section")
        ),
    )
    assert isinstance(navigation, ReaderPublicationTextResolution)
    assert navigation.unit_ref.key == "units/0.json"
    assert navigation.previous_ref is None and navigation.next_ref.key == "units/1.json"
    assert navigation.locator == WebReaderResumeState(
        kind="web",
        target=ReaderFragmentTarget(fragment_id=str(fragment_id)),
        locations=ReaderTextLocations(
            text_offset=0, progression=None, total_progression=None, position=None
        ),
        text=ReaderQuoteContext(quote=None, quote_prefix=None, quote_suffix=None),
    )
    missing = resolve_reader_publication_for_viewer(
        db_session,
        viewer_id=test_user.id,
        media_id=media_id,
        generation=2,
        request=ReaderPublicationResolveRequest(
            target=ReaderPublicationNavigationTarget(target_id="section")
        ),
    )
    assert missing == ReaderPublicationUnresolved(locator=None, reason="TargetMissing")
    request = ReaderPublicationFindRequest(
        query="cat",
        match_case=True,
        whole_word=True,
        scope=EpubFindEntireResourceScopeIn(kind="EntireResource"),
    )
    pages = []
    while True:
        page = find_reader_publication_for_viewer(
            db_session,
            viewer_id=test_user.id,
            media_id=media_id,
            generation=1,
            request=request,
            limits=limits,
        )
        pages.append(page)
        assert len(page.model_dump_json().encode("utf-8")) + len(b'{"data":}') <= limits.index_bytes
        if page.next_cursor is None:
            break
        request = request.model_copy(update={"after": page.next_cursor})
        assert len(pages) < len(chunks), "image-only units must not consume find pages"
    assert [[hit.start_offset for hit in page.occurrences] for page in pages] == [[4], [], [14]]
    assert [(hit.start_offset, hit.end_offset) for page in pages for hit in page.occurrences] == [
        (4, 7),
        (14, 17),
    ]
    assert all(hit.fragment_id == str(fragment_id) for page in pages for hit in page.occurrences)
    assert all(
        hit.locator.kind == "web"
        and hit.locator.target.fragment_id == str(fragment_id)
        and hit.locator.locations.text_offset == hit.start_offset
        for page in pages
        for hit in page.occurrences
    )
    assert [segment.text for segment in pages[0].occurrences[0].snippet if segment.emphasized] == [
        "cat"
    ]

    scope = ReaderPublicationFindRequest(
        query="the cat",
        match_case=False,
        whole_word=True,
        scope=ReaderPublicationSectionScope(kind="Section", section_id="section"),
    )
    first = find_reader_publication_for_viewer(
        db_session,
        viewer_id=test_user.id,
        media_id=media_id,
        generation=1,
        request=scope,
        limits=limits,
    )
    assert [(hit.start_offset, hit.end_offset) for hit in first.occurrences] == [(0, 7)]
    second = find_reader_publication_for_viewer(
        db_session,
        viewer_id=test_user.id,
        media_id=media_id,
        generation=1,
        request=scope.model_copy(update={"after": first.next_cursor}),
        limits=limits,
    )
    assert [(hit.start_offset, hit.end_offset) for hit in second.occurrences] == [(10, 17)]
    assert second.next_cursor is None
    with pytest.raises(ApiError) as cursor_changed:
        find_reader_publication_for_viewer(
            db_session,
            viewer_id=test_user.id,
            media_id=media_id,
            generation=2,
            request=scope.model_copy(update={"after": first.next_cursor}),
            limits=limits,
        )
    assert cursor_changed.value.code == ApiErrorCode.E_INVALID_REQUEST

    def locate(
        offset: int | None,
        quote: str | None,
        *,
        prefix: str | None = None,
        suffix: str | None = None,
    ):
        locator = WebReaderResumeState(
            kind="web",
            target=ReaderFragmentTarget(fragment_id=str(fragment_id)),
            locations=ReaderTextLocations(
                text_offset=offset, progression=None, total_progression=None, position=None
            ),
            text=ReaderQuoteContext(quote=quote, quote_prefix=prefix, quote_suffix=suffix),
        )
        result = resolve_reader_publication_for_viewer(
            db_session,
            viewer_id=test_user.id,
            media_id=media_id,
            generation=1,
            request=ReaderPublicationResolveRequest(
                target=ReaderPublicationLocatorTarget(locator=locator)
            ),
        )
        assert not isinstance(result, ReaderPublicationIncomplete), (
            "quote resolution must not require a roundtrip per publication unit"
        )
        assert result.locator == locator, "resolving a view must not rewrite authored intent"
        return result

    exact = locate(6, "cat")
    assert isinstance(exact, ReaderPublicationTextResolution)
    assert (exact.unit_ref.key, exact.offset_cp, exact.local_offset_cp) == ("units/3.json", 6, 0)
    terminal = locate(17, None)
    assert isinstance(terminal, ReaderPublicationTextResolution)
    assert (terminal.unit_ref.key, terminal.local_offset_cp) == ("units/4.json", 3)
    ambiguous = locate(None, "cat")
    assert isinstance(ambiguous, ReaderPublicationUnresolved)
    assert ambiguous.reason == "QuoteAmbiguous"
    unique = locate(None, "🧠")
    assert isinstance(unique, ReaderPublicationTextResolution)
    assert unique.offset_cp == 8
    contextual = locate(None, "cat", prefix="the ", suffix=" 🧠")
    assert isinstance(contextual, ReaderPublicationTextResolution)
    assert contextual.offset_cp == 4
    with pytest.raises(ApiError) as inaccessible:
        resolve_reader_publication_for_viewer(
            db_session,
            viewer_id=UUID(int=0),
            media_id=media_id,
            generation=1,
            request=ReaderPublicationResolveRequest(
                target=ReaderPublicationLocatorTarget(locator=exact.locator)
            ),
        )
    assert inaccessible.value.code == ApiErrorCode.E_MEDIA_NOT_FOUND

    empty = resolve_reader_publication_for_viewer(
        db_session,
        viewer_id=test_user.id,
        media_id=media_id,
        generation=1,
        request=ReaderPublicationResolveRequest(
            target=ReaderPublicationUnitTarget(unit_key="units/1.json")
        ),
    )
    assert isinstance(empty, ReaderPublicationUnitResolution)
    assert (empty.start_cp, empty.end_cp, empty.ordinal) == (6, 6, 1)
    assert empty.previous_ref is not None and empty.previous_ref.key == "units/0.json"
    assert empty.next_ref is not None and empty.next_ref.key == "units/2.json"


def test_quote_resolution_finds_overlapping_matches_and_skips_many_empty_parts(
    db_session: Session, test_user: UserRecord
) -> None:
    chunks = ("aaaaaa",) + ("",) * 1024 + ("🧠",) + ("",) * 1024 + ("c", "a", "t")
    media_id, fragment_id = seed_retained_text(db_session, test_user, chunks, ())
    for quote, prefix, expected in (
        ("aa", None, None),
        ("cat", None, 7),
        ("cat", "🧠", 7),
        ("🧠cat", "aaaaaa", 6),
    ):
        locator = WebReaderResumeState(
            kind="web",
            target=ReaderFragmentTarget(fragment_id=str(fragment_id)),
            locations=ReaderTextLocations(
                text_offset=None, progression=None, total_progression=None, position=None
            ),
            text=ReaderQuoteContext(quote=quote, quote_prefix=prefix, quote_suffix=None),
        )
        result = resolve_reader_publication_for_viewer(
            db_session,
            viewer_id=test_user.id,
            media_id=media_id,
            generation=1,
            request=ReaderPublicationResolveRequest(
                target=ReaderPublicationLocatorTarget(locator=locator)
            ),
        )
        assert result.locator == locator
        if expected is None:
            assert isinstance(result, ReaderPublicationUnresolved)
            assert result.reason == "QuoteAmbiguous", "overlapping starts in one unit are distinct"
        else:
            assert isinstance(result, ReaderPublicationTextResolution)
            assert result.offset_cp == expected


def test_section_context_preserves_selected_revision_and_equal_offset_epub_target(
    db_session: Session, test_user: UserRecord, authenticated_client: TestClient
) -> None:
    media_id, fragment_id = seed_retained_text(db_session, test_user, ("intro chapter end",), ())
    media = db_session.get(Media, media_id)
    assert media is not None
    media.kind = "epub"
    for ordinal, (target_id, start, end) in enumerate(
        (
            ("intro", 0, 6),
            ("image-heading", 6, 6),
            ("chapter", 6, 17),
        )
    ):
        db_session.add(
            ReaderPublicationTarget(
                media_id=media_id,
                generation=1,
                target_id=target_id,
                ordinal=ordinal,
                label=target_id,
                unit_key="units/0.json",
                offset_cp=start,
                end_cp=end,
                href_path="chapter.xhtml",
                anchor_id=target_id,
            )
        )
    db_session.commit()
    locator = {
        "kind": "epub",
        "target": {
            "section_id": "image-heading",
            "href_path": "chapter.xhtml",
            "anchor_id": "image-heading",
        },
        "locations": {
            "text_offset": 6,
            "progression": None,
            "total_progression": None,
            "position": None,
        },
        "text": {"quote": None, "quote_prefix": None, "quote_suffix": None},
    }
    path = f"/media/{media_id}/reader-publications/1/section-context"
    response = authenticated_client.post(path, json={"locator": locator})
    assert response.status_code == 200
    page = response.json()["data"]
    assert page["current"]["section_id"] == "image-heading"
    assert page["current"]["fragment_id"] == str(fragment_id)
    assert page["previous"]["section_id"] == "intro"
    assert page["next"]["section_id"] == "chapter"
    assert page["section_count"] == 3
    assert page["section_position"] == 2
    assert response.headers["cache-control"] == "private, no-store, no-transform"
    assert int(response.headers["content-length"]) == len(response.content)
    locator["locations"]["text_offset"] = 10
    moved = authenticated_client.post(path, json={"locator": locator}).json()["data"]
    assert moved["current"]["section_id"] == "chapter"
    assert moved["previous"]["section_id"] == "image-heading"
    assert moved["next"] is None
    absent = authenticated_client.post(path.replace("/1/", "/2/"), json={"locator": locator})
    assert absent.status_code == 200
    assert absent.json()["data"] == {
        "current": None,
        "previous": None,
        "next": None,
        "section_count": 0,
        "section_position": None,
    }
    locator["locations"]["text_offset"] = None
    assert authenticated_client.post(path, json={"locator": locator}).status_code == 400


@pytest.mark.parametrize(
    ("href_path", "pathname"),
    (
        ("Text/café chapter.xhtml", "Text/caf%C3%A9%20chapter.xhtml"),
        ("Text/a%2Fb.xhtml", "Text/a%2Fb.xhtml"),
    ),
)
def test_epub_authored_anchor_resolves_exact_empty_unit_without_becoming_a_section(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
    href_path: str,
    pathname: str,
) -> None:
    from nexus.db.models import ReaderPublicationAnchor
    from nexus.services.reader_publication_anchors import reader_publication_anchor_key

    anchor_id = "image 🧠" + "x" * 3000
    media_id, _fragment_id = seed_retained_text(
        db_session, test_user, ("intro ", "", "chapter end"), ()
    )
    media = db_session.get(Media, media_id)
    assert media is not None
    media.kind = "epub"
    db_session.add(
        ReaderPublicationTarget(
            media_id=media_id,
            generation=1,
            target_id="chapter",
            ordinal=0,
            label="Chapter",
            unit_key="units/2.json",
            offset_cp=6,
            end_cp=17,
            href_path=href_path,
            href_pathname=pathname,
            anchor_id="heading",
        )
    )
    db_session.add(
        ReaderPublicationAnchor(
            media_id=media_id,
            generation=1,
            href_path=href_path,
            anchor_id=anchor_id,
            anchor_key=reader_publication_anchor_key(href_path, anchor_id),
            unit_key="units/1.json",
            offset_cp=6,
        )
    )
    db_session.commit()
    path = f"/media/{media_id}/reader-publications/1/resolve"
    target = {"kind": "EpubHref", "pathname": pathname, "anchor_id": anchor_id}
    response = authenticated_client.post(path, json={"target": target})
    assert response.status_code == 200
    addressed = response.json()["data"]
    assert addressed["kind"] == "Text"
    assert addressed["unit_ref"]["key"] == "units/1.json"
    assert addressed["offset_cp"] == 6
    reopened = authenticated_client.post(
        path,
        json={
            "target": {"kind": "Locator", "locator": addressed["locator"]},
        },
    ).json()["data"]
    assert reopened["unit_ref"]["key"] == "units/1.json"
    assert reopened["locator"] == addressed["locator"]
    assert addressed["locator"]["target"] == {
        "section_id": "chapter",
        "href_path": href_path,
        "anchor_id": anchor_id,
    }
    context = authenticated_client.post(
        path.removesuffix("resolve") + "section-context", json={"locator": addressed["locator"]}
    ).json()["data"]
    assert context["section_count"] == 1
    target["anchor_id"] = None
    start = authenticated_client.post(path, json={"target": target}).json()["data"]
    assert start["offset_cp"] == 0
    assert start["unit_ref"]["key"] == "units/0.json"
    target["anchor_id"] = "missing"
    missing = authenticated_client.post(path, json={"target": target}).json()["data"]
    assert missing == {"kind": "Unresolved", "locator": None, "reason": "TargetMissing"}
    target["anchor_id"] = anchor_id
    retired = authenticated_client.post(path.replace("/1/", "/2/"), json={"target": target}).json()[
        "data"
    ]
    assert retired == missing


def test_equal_offset_targets_keep_one_owner_across_find_and_section_context(
    db_session: Session, test_user: UserRecord
) -> None:
    """A point at a shared offset belongs to the earlier authored target everywhere."""
    from nexus.schemas.reader_publication import ReaderPublicationSectionContextRequest
    from nexus.services.reader_publication_resolve import get_reader_publication_section_context

    media_id, fragment_id = seed_retained_text(
        db_session, test_user, ("intro chapter end",), (0, 6, 13, 17)
    )
    for ordinal, (target_id, start, end) in enumerate(
        (("intro", 0, 6), ("image-heading", 6, 6), ("chapter", 6, 17))
    ):
        db_session.add(
            ReaderPublicationTarget(
                media_id=media_id,
                generation=1,
                target_id=target_id,
                ordinal=ordinal,
                label=target_id,
                unit_key="units/0.json",
                offset_cp=start,
                end_cp=end,
                href_path=None,
                anchor_id=None,
            )
        )
    db_session.flush()
    page = find_reader_publication_for_viewer(
        db_session,
        viewer_id=test_user.id,
        media_id=media_id,
        generation=1,
        request=ReaderPublicationFindRequest(
            query="chapter",
            match_case=True,
            whole_word=True,
            scope=EpubFindEntireResourceScopeIn(kind="EntireResource"),
        ),
        limits=ReaderPublicationLimits(
            unit_bytes=1100,
            unit_codepoints=160,
            unit_dom_nodes=20,
            index_bytes=2000,
            descriptor_bytes=1000,
        ),
    )
    assert [(hit.start_offset, hit.section_id) for hit in page.occurrences] == [
        (6, "image-heading")
    ], "the zero-width heading owns its own offset"
    context = get_reader_publication_section_context(
        db_session,
        viewer_id=test_user.id,
        media_id=media_id,
        generation=1,
        request=ReaderPublicationSectionContextRequest(
            locator=WebReaderResumeState(
                kind="web",
                target=ReaderFragmentTarget(fragment_id=str(fragment_id)),
                locations=ReaderTextLocations(
                    text_offset=6, progression=None, total_progression=None, position=None
                ),
                text=ReaderQuoteContext(quote=None, quote_prefix=None, quote_suffix=None),
            )
        ),
    )
    assert context.current is not None
    assert context.current.section_id == page.occurrences[0].section_id


def test_find_reserves_the_continuation_cursor_its_page_actually_returns(
    db_session: Session, test_user: UserRecord
) -> None:
    """A match overflowing its unit resumes at a later, wider ordinal than its own."""
    from nexus.schemas.reader_publication import ReaderPublicationFindPage

    media_id, _fragment_id = seed_retained_text(
        db_session, test_user, ("",) * 8 + ("a", "b", "c", "yyyy"), ()
    )
    request = ReaderPublicationFindRequest(
        query="abc",
        match_case=True,
        whole_word=False,
        scope=EpubFindEntireResourceScopeIn(kind="EntireResource"),
    )
    limits = ReaderPublicationLimits(
        unit_bytes=1100,
        unit_codepoints=160,
        unit_dom_nodes=20,
        index_bytes=100_000,
        descriptor_bytes=1000,
    )

    def find(limit_bytes: int) -> ReaderPublicationFindPage:
        return find_reader_publication_for_viewer(
            db_session,
            viewer_id=test_user.id,
            media_id=media_id,
            generation=1,
            request=request,
            limits=limits.model_copy(update={"index_bytes": limit_bytes}),
        )

    full = find(limits.index_bytes)
    assert [(hit.start_offset, hit.end_offset) for hit in full.occurrences] == [(0, 3)]
    assert full.next_cursor is not None
    page_bytes = len(full.model_dump_json().encode("utf-8")) + len(b'{"data":}')
    for limit_bytes in range(page_bytes - 4, page_bytes + 1):
        try:
            page = find(limit_bytes)
        except ReaderContentTooLargeError as oversize:
            # Deterministic: this page overflows on every attempt, so it is the
            # terminal 422 and never the admission owner's retryable 503.
            assert oversize.code == ApiErrorCode.E_READER_CONTENT_TOO_LARGE
            assert oversize.status_code == 422
            assert oversize.retry_after_seconds is None
            assert oversize.details == {
                "limit": "index_bytes",
                "limit_value": limit_bytes,
                "measured": oversize.measured,
            }
            assert oversize.measured is not None and oversize.measured > limit_bytes
            continue
        assert len(page.model_dump_json().encode("utf-8")) + len(b'{"data":}') <= limit_bytes
    assert find(page_bytes).occurrences == full.occurrences


def test_pdf_locator_resolution_reads_only_verified_projection_rows(
    db_session: Session, test_user: UserRecord
) -> None:
    """Navigation bounds the page and names the asset without any object read."""
    from nexus.schemas.reader import PdfReaderResumeState
    from nexus.schemas.reader_publication import ReaderPublicationPdfResolution

    media_id = uuid4()
    db_session.add(
        Media(
            id=media_id,
            kind="pdf",
            title="Retained geometry proof",
            processing_status="ready_for_reading",
            created_by_user_id=test_user.id,
        )
    )
    db_session.flush()
    ensure_media_in_default_library(db_session, test_user.id, media_id)
    db_session.add(ReaderPublication(id=new_uuid7(), media_id=media_id, generation=1))
    db_session.add(
        ReaderPublicationArtifact(
            media_id=media_id,
            generation=1,
            path="descriptor.json",
            role="descriptor",
            storage_path=f"proof/{media_id}/1/descriptor",
            media_type="application/json",
            size_bytes=2,
            sha256="0" * 64,
            pdf_page_count=3,
        )
    )
    db_session.add(
        ReaderPublicationArtifact(
            media_id=media_id,
            generation=1,
            path="assets/document.pdf",
            role="asset",
            storage_path=f"proof/{media_id}/1/document.pdf",
            media_type="application/pdf",
            size_bytes=4096,
            sha256="2" * 64,
        )
    )
    db_session.flush()

    def resolve(page: int):
        return resolve_reader_publication_for_viewer(
            db_session,
            viewer_id=test_user.id,
            media_id=media_id,
            generation=1,
            request=ReaderPublicationResolveRequest(
                target=ReaderPublicationLocatorTarget(
                    locator=PdfReaderResumeState(
                        kind="pdf", page=page, page_progression=None, zoom=None, position=None
                    )
                )
            ),
        )

    inside = resolve(3)
    assert isinstance(inside, ReaderPublicationPdfResolution)
    assert inside.page == 3
    assert (inside.document_asset_ref.key, inside.document_asset_ref.bytes) == (
        "assets/document.pdf",
        4096,
    )
    assert inside.document_asset_ref.sha256 == "2" * 64
    beyond = resolve(4)
    assert isinstance(beyond, ReaderPublicationUnresolved)
    assert beyond.reason == "OffsetOutOfRange"


def test_member_routes_serve_exactly_the_generation_and_bytes_their_caller_named(
    db_session: Session, test_user: UserRecord, authenticated_client: TestClient
) -> None:
    """The immutable member wire contract, asserted where the client cannot fake it.

    apps/web/src/lib/reader/publicationTransport.ts refuses a member response whose
    X-Nexus-Reader-Generation is not a positive integer, whose Content-Digest is not
    the RFC 9530 `sha-256=:<44 base64 chars>:` form, or whose recomputed digest
    differs from the bytes. Those assertions live against fixtures the client writes
    itself, so only a server proof can show the route actually emits them — and a
    regression in any of them is a total reader outage.
    """
    import base64
    import hashlib
    import re

    from nexus.storage.client import get_storage_client

    media_id, fragment_id = uuid4(), uuid4()
    db_session.add(
        Media(
            id=media_id,
            kind="web_article",
            title="Member route proof",
            processing_status="ready_for_reading",
            created_by_user_id=test_user.id,
        )
    )
    db_session.flush()
    ensure_media_in_default_library(db_session, test_user.id, media_id)
    db_session.add(ReaderPublication(id=new_uuid7(), media_id=media_id, generation=2))
    storage = get_storage_client()
    bodies: dict[tuple[int, str], bytes] = {}

    def member(
        generation: int, key: str, role: str, body: bytes, media_type: str = "application/json"
    ) -> None:
        storage_path = f"proof/{media_id}/{generation}/{key}"
        storage.put_object(storage_path, body, media_type)
        db_session.add(
            ReaderPublicationArtifact(
                media_id=media_id,
                generation=generation,
                path=key,
                role=role,
                storage_path=storage_path,
                media_type=media_type,
                size_bytes=len(body),
                sha256=hashlib.sha256(body).hexdigest(),
            )
        )
        bodies[(generation, key)] = body

    figure = b"\x89PNG\r\n\x1a\nretained figure bytes"
    member(1, "descriptor.json", "descriptor", b'{"reader_generation":1}')
    member(1, "units/0.json", "unit", b'{"text":"retired only"}')
    member(2, "descriptor.json", "descriptor", b'{"reader_generation":2}')
    member(2, "index/0.json", "index", b'{"units":["units/0.json"]}')
    member(2, "units/0.json", "unit", b'{"text":"current only"}')
    member(2, "assets/figure.png", "asset", figure, "image/png")
    for generation, text in ((1, "retired only"), (2, "current only")):
        db_session.add(
            ReaderPublicationUnit(
                embed_markers=[],
                media_id=media_id,
                generation=generation,
                unit_key="units/0.json",
                ordinal=0,
                fragment_id=fragment_id,
                fragment_idx=0,
                start_cp=0,
                end_cp=len(text),
                canonical_text=text,
                word_boundaries=[0, len(text)],
            )
        )
    db_session.flush()
    base = f"/media/{media_id}/reader-publications"

    def assert_member(response, generation: int, key: str) -> None:
        body = bodies[(generation, key)]
        assert response.status_code == 200, response.text
        assert response.content == body
        assert response.headers["x-nexus-reader-generation"] == str(generation)
        assert re.fullmatch(r"[1-9][0-9]*", response.headers["x-nexus-reader-generation"])
        digest = hashlib.sha256(body)
        assert response.headers["etag"] == f'"{digest.hexdigest()}"'
        assert int(response.headers["content-length"]) == len(body)
        assert response.headers["cache-control"] == "private, no-store, no-transform"
        assert response.headers["x-content-type-options"] == "nosniff"
        assert re.fullmatch(
            r"sha-256=:([A-Za-z0-9+/]{43}=):", response.headers["content-digest"]
        ), response.headers["content-digest"]
        assert response.headers["content-digest"] == (
            f"sha-256=:{base64.b64encode(digest.digest()).decode('ascii')}:"
        )

    # The unversioned route resolves the current generation; naming an older one
    # returns that generation's own bytes, which is what makes members immutable.
    assert_member(
        authenticated_client.get(f"/media/{media_id}/reader-publication"), 2, "descriptor.json"
    )
    assert_member(authenticated_client.get(f"{base}/1/descriptor"), 1, "descriptor.json")
    assert_member(authenticated_client.get(f"{base}/2/index"), 2, "index/0.json")
    assert_member(authenticated_client.get(f"{base}/2/units/0.json"), 2, "units/0.json")
    assert_member(authenticated_client.get(f"{base}/1/units/0.json"), 1, "units/0.json")

    # The index continuation is one optional member key naming an index page.
    assert authenticated_client.get(f"{base}/2/index?after=index/0.json&limit=2").status_code == 400
    assert authenticated_client.get(f"{base}/2/index?after=units/0.json").status_code == 404
    assert authenticated_client.get(f"{base}/2/units/only-in-one.json").status_code == 404
    assert authenticated_client.get(f"{base}/3/descriptor").status_code == 404
    assert authenticated_client.get(f"{base}/0/descriptor").status_code == 400

    asset = authenticated_client.get(f"{base}/2/assets/figure.png")
    assert_member(asset, 2, "assets/figure.png")
    assert asset.headers["accept-ranges"] == "bytes"
    assert asset.headers["content-type"] == "image/png"
    ranged = authenticated_client.get(f"{base}/2/assets/figure.png", headers={"Range": "bytes=2-5"})
    assert ranged.status_code == 206
    assert ranged.content == figure[2:6]
    assert ranged.headers["content-range"] == f"bytes 2-5/{len(figure)}"
    assert int(ranged.headers["content-length"]) == 4
    unsatisfiable = authenticated_client.get(
        f"{base}/2/assets/figure.png", headers={"Range": f"bytes={len(figure)}-"}
    )
    assert unsatisfiable.status_code == 416
    assert unsatisfiable.headers["content-range"] == f"bytes */{len(figure)}"

    def find(generation: int, query: str) -> dict:
        response = authenticated_client.post(
            f"{base}/{generation}/find",
            json={
                "query": query,
                "match_case": True,
                "whole_word": False,
                "scope": {"kind": "EntireResource"},
                "after": None,
            },
        )
        assert response.status_code == 200, response.text
        assert response.headers["cache-control"] == "private, no-store, no-transform"
        assert int(response.headers["content-length"]) == len(response.content)
        return response.json()["data"]

    current = find(2, "current")
    assert [(hit["start_offset"], hit["end_offset"]) for hit in current["occurrences"]] == [(0, 7)]
    assert current["next_cursor"] is None
    # Find reads only the generation its path names, exactly as the members do.
    assert find(2, "retired")["occurrences"] == []
    assert [hit["start_offset"] for hit in find(1, "retired")["occurrences"]] == [0]
