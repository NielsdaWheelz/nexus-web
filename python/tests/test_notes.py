from datetime import date
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import func, select, text

from nexus.db.models import (
    Conversation,
    DailyNotePage,
    NoteBlock,
    NoteViewState,
    Page,
    PageDocumentMutation,
    PinnedObjectRef,
    ResourceEdge,
    Tag,
)
from nexus.errors import ApiError, ApiErrorCode, ConflictError, NotFoundError
from nexus.jobs.queue import claim_next_job, complete_job
from nexus.schemas.notes import (
    CreatePageRequest,
    ObjectRef,
    PageDocumentBlockRequest,
    PatchPageDocumentRequest,
    QuickCaptureRequest,
    UpdatePageRequest,
)
from nexus.services import notes, object_refs
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.contributor_credits import replace_media_contributor_credits
from nexus.services.note_indexing import rebuild_page_content_index
from nexus.services.notes import markdown_from_pm_json, text_from_pm_json
from nexus.services.resource_graph import documents as graph_documents
from nexus.services.resource_graph.connections import query_connections
from nexus.services.resource_graph.edges import create_edge
from nexus.services.resource_graph.highlight_notes import linked_note_blocks_for_highlights
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import (
    ConnectionFilters,
    ConnectionQuery,
    EdgeCreate,
    EdgeOrigin,
    EdgeOut,
)
from nexus.services.search.service import get_search_result
from tests.factories import (
    add_library_member,
    add_media_to_library,
    create_searchable_media,
    create_test_conversation,
    create_test_conversation_with_message,
    create_test_fragment,
    create_test_highlight,
    create_test_library,
    create_test_media,
    create_test_media_in_library,
    create_test_message,
    get_user_default_library,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.note_document_helpers import (
    create_block_via_document,
    delete_block_via_document,
    move_block_via_document,
    patch_document_via_command,
    update_block_via_document,
)
from tests.utils.db import DirectSessionManager


def _paragraph_with_page_ref(page_id, label: str) -> dict:
    return {
        "type": "paragraph",
        "content": [
            {"type": "text", "text": "See "},
            {
                "type": "object_ref",
                "attrs": {
                    "objectType": "page",
                    "objectId": str(page_id),
                    "label": label,
                },
            },
        ],
    }


def _paragraph_with_duplicate_page_refs(page_id, label: str) -> dict:
    return {
        "type": "paragraph",
        "content": [
            {
                "type": "object_ref",
                "attrs": {
                    "objectType": "page",
                    "objectId": str(page_id),
                    "label": label,
                },
            },
            {"type": "text", "text": " and again "},
            {
                "type": "object_ref",
                "attrs": {
                    "objectType": "page",
                    "objectId": str(page_id),
                    "label": label,
                },
            },
        ],
    }


def _note_body_edges(db, viewer_id, block_id: UUID) -> list[EdgeOut]:
    """The block's ``origin=note_body`` edge set (the body-sync replace-set scope)."""
    source = ResourceRef(scheme="note_block", id=block_id)
    return [
        edge
        for edge in _connection_edges(db, viewer_id=viewer_id, ref=source, origin="note_body")
        if edge.source == source
    ]


def _note_body_targets(db, viewer_id, block_id: UUID) -> set[str]:
    return {edge.target.uri for edge in _note_body_edges(db, viewer_id, block_id)}


def _connection_edges(
    db,
    *,
    viewer_id: UUID,
    ref: ResourceRef,
    origin: EdgeOrigin | None = None,
) -> list[EdgeOut]:
    out: list[EdgeOut] = []
    cursor = None
    while True:
        page = query_connections(
            db,
            viewer_id=viewer_id,
            query=ConnectionQuery(
                refs=(ref,),
                direction="both",
                rollup="exact",
                filters=ConnectionFilters(origins=(origin,) if origin is not None else None),
                limit=100,
                cursor=cursor,
            ),
        )
        out.extend(
            EdgeOut(
                id=edge.edge_id,
                source=edge.source_ref,
                target=edge.target_ref,
                kind=edge.kind,
                origin=edge.origin,
                source_order_key=edge.source_order_key,
                target_order_key=edge.target_order_key,
                ordinal=edge.ordinal,
                snapshot=edge.snapshot,
                created_at=edge.created_at,
            )
            for edge in page.items
        )
        if page.next_cursor is None:
            return out
        cursor = page.next_cursor


def _paragraph_text(text_value: str) -> dict:
    return {"type": "paragraph", "content": [{"type": "text", "text": text_value}]}


def _document_block(block_id: UUID, text_value: str) -> dict:
    return {
        "id": str(block_id),
        "block_kind": "bullet",
        "body_pm_json": _paragraph_text(text_value),
    }


def _document_containment(
    parent_scheme: str,
    parent_id: UUID,
    children: list[UUID],
) -> dict:
    return {
        "parent": {"scheme": parent_scheme, "id": str(parent_id)},
        "children": [
            {
                "block_id": str(block_id),
                "source_order_key": f"{index + 1:010d}",
                "collapsed": False,
            }
            for index, block_id in enumerate(children)
        ],
    }


@pytest.mark.unit
def test_note_projections_include_object_refs_and_marks():
    paragraph = {
        "type": "paragraph",
        "content": [
            {"type": "text", "text": "Read "},
            {
                "type": "text",
                "text": "docs",
                "marks": [{"type": "link", "attrs": {"href": "https://example.com"}}],
            },
            {"type": "text", "text": " "},
            {
                "type": "object_ref",
                "attrs": {
                    "objectType": "media",
                    "objectId": "11111111-1111-4111-8111-111111111111",
                    "label": "Source",
                },
            },
        ],
    }

    assert text_from_pm_json(paragraph) == "Read docs Source"
    assert (
        markdown_from_pm_json(paragraph) == "Read [docs](https://example.com) "
        "[[media:11111111-1111-4111-8111-111111111111|Source]]"
    )


@pytest.mark.unit
def test_note_body_pm_json_rejects_non_prosemirror_shapes():
    object_id = "11111111-1111-4111-8111-111111111111"

    valid = PageDocumentBlockRequest(
        id=uuid4(),
        block_kind="bullet",
        body_pm_json={
            "type": "paragraph",
            "content": [
                {"type": "text", "text": "Read "},
                {
                    "type": "object_ref",
                    "attrs": {
                        "objectType": "media",
                        "objectId": object_id,
                        "label": "Source",
                    },
                },
            ],
        },
    )

    assert valid.body_pm_json is not None
    assert valid.body_pm_json["type"] == "paragraph"

    with pytest.raises(ValidationError):
        PageDocumentBlockRequest(id=uuid4(), block_kind="bullet", body_pm_json={"content": []})

    with pytest.raises(ValidationError):
        PageDocumentBlockRequest(
            id=uuid4(),
            block_kind="bullet",
            body_pm_json={
                "type": "paragraph",
                "content": [{"type": "unknown_node", "text": "bad"}],
            },
        )


@pytest.mark.integration
def test_nested_note_create_move_and_delete_cleanup(db_session, bootstrapped_user):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Nested notes {uuid4()}"),
    )
    parent = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(page_id=page.id, body_markdown="parent"),
    )
    child_one = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(
            page_id=page.id,
            parent_block_id=parent.id,
            body_markdown="child one",
        ),
    )
    child_two = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(
            page_id=page.id,
            parent_block_id=parent.id,
            after_block_id=child_one.id,
            body_markdown="child two",
        ),
    )
    create_edge(
        db_session,
        viewer_id=bootstrapped_user,
        input=EdgeCreate(
            source=ResourceRef(scheme="note_block", id=child_two.id),
            target=ResourceRef(scheme="page", id=page.id),
            kind="context",
            origin="user",
        ),
    )
    db_session.commit()
    child_zero = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(
            page_id=page.id,
            parent_block_id=parent.id,
            before_block_id=child_one.id,
            body_markdown="child zero",
        ),
    )

    fetched_parent = notes.get_note_block(db_session, bootstrapped_user, parent.id)
    assert [child.body_text for child in fetched_parent.children] == [
        "child zero",
        "child one",
        "child two",
    ], f"Nested sibling order was not preserved: {fetched_parent.children}"

    other_parent = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(page_id=page.id, body_markdown="other parent"),
    )
    moved = move_block_via_document(
        db_session,
        bootstrapped_user,
        child_zero.id,
        dict(parent_block_id=other_parent.id),
    )
    assert moved.parent_block_id == other_parent.id

    with pytest.raises(ApiError) as invalid_anchor:
        create_block_via_document(
            db_session,
            bootstrapped_user,
            dict(
                page_id=page.id,
                parent_block_id=other_parent.id,
                before_block_id=child_one.id,
                body_markdown="bad anchor",
            ),
        )
    assert invalid_anchor.value.code == ApiErrorCode.E_INVALID_REQUEST

    with pytest.raises(ApiError) as invalid_move:
        move_block_via_document(
            db_session,
            bootstrapped_user,
            parent.id,
            dict(parent_block_id=child_two.id),
        )
    assert invalid_move.value.code == ApiErrorCode.E_INVALID_REQUEST

    delete_block_via_document(
        db_session,
        bootstrapped_user,
        parent.id,
    )

    with pytest.raises(NotFoundError):
        notes.get_note_block(db_session, bootstrapped_user, child_two.id)
    remaining = _connection_edges(
        db_session, viewer_id=bootstrapped_user, ref=ResourceRef(scheme="page", id=page.id)
    )
    remaining_by_origin: dict[str, list[EdgeOut]] = {}
    for edge in remaining:
        remaining_by_origin.setdefault(edge.origin, []).append(edge)
    assert remaining_by_origin.get("note_containment") == [
        next(edge for edge in remaining if edge.target.id == other_parent.id)
    ]
    assert [
        (edge.source.uri, edge.target.uri) for edge in remaining_by_origin["note_containment"]
    ] == [(f"page:{page.id}", f"note_block:{other_parent.id}")]
    assert {
        origin: edges
        for origin, edges in remaining_by_origin.items()
        if origin != "note_containment"
    } == {}, f"Deleting a parent block should clean descendant edges, got {remaining}"


@pytest.mark.integration
def test_patch_page_document_applies_create_update_move_and_delete_atomically(
    db_session,
    bootstrapped_user,
):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Atomic document {uuid4()}"),
    )
    first = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(page_id=page.id, body_markdown="first"),
    )
    second = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(page_id=page.id, after_block_id=first.id, body_markdown="second"),
    )
    child = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(page_id=page.id, parent_block_id=first.id, body_markdown="child"),
    )
    created_id = uuid4()
    current_page = notes.get_page(db_session, bootstrapped_user, page.id)
    request = PatchPageDocumentRequest(
        client_mutation_id="mutation-1",
        base_document_version=current_page.document_version,
        blocks=[
            _document_block(first.id, "first edited"),
            _document_block(created_id, "new child"),
            _document_block(child.id, "child"),
        ],
        containment=[
            _document_containment("page", page.id, [first.id, child.id]),
            _document_containment("note_block", first.id, [created_id]),
        ],
        deleted_block_ids=[second.id],
    )

    result = notes.patch_page_document(db_session, bootstrapped_user, page.id, request)
    replay = notes.patch_page_document(db_session, bootstrapped_user, page.id, request)

    assert result.client_mutation_id == "mutation-1"
    assert replay.document_version == result.document_version
    assert [block.id for block in result.page.blocks] == [first.id, child.id]
    assert result.page.blocks[0].body_text == "first edited"
    assert [block.id for block in result.page.blocks[0].children] == [created_id]
    assert result.page.blocks[0].children[0].body_text == "new child"
    assert result.page.blocks[1].parent_block_id is None
    assert db_session.get(NoteBlock, second.id) is None


@pytest.mark.integration
def test_patch_page_document_rejects_stale_document_version(
    db_session,
    bootstrapped_user,
):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Stale document {uuid4()}"),
    )
    block = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(page_id=page.id, body_markdown="original"),
    )

    current_page = db_session.get(Page, page.id)
    assert current_page is not None
    db_session.refresh(current_page)
    stale_version = current_page.document_version
    update_block_via_document(
        db_session,
        bootstrapped_user,
        block.id,
        dict(
            body_pm_json={"type": "paragraph", "content": [{"type": "text", "text": "remote"}]},
        ),
    )
    db_session.refresh(current_page)
    latest_version = current_page.document_version

    with pytest.raises(ApiError) as stale:
        notes.patch_page_document(
            db_session,
            bootstrapped_user,
            page.id,
            PatchPageDocumentRequest(
                client_mutation_id="mutation-current",
                base_document_version=stale_version,
                blocks=[_document_block(block.id, "local")],
                containment=[_document_containment("page", page.id, [block.id])],
            ),
        )

    assert stale.value.code == ApiErrorCode.E_NOTE_CONFLICT
    latest = stale.value.details["latestDocument"]
    assert latest["documentVersion"] == latest_version
    assert latest_version > stale_version
    assert latest["page"]["blocks"][0]["bodyText"] == "remote"


@pytest.mark.integration
def test_patch_page_document_rejects_parent_outside_document_command(db_session, bootstrapped_user):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Strict anchors {uuid4()}"),
    )
    first_parent = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(page_id=page.id, body_markdown="first parent"),
    )
    second_parent = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(page_id=page.id, body_markdown="second parent"),
    )
    child = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(page_id=page.id, parent_block_id=first_parent.id, body_markdown="child"),
    )
    current_page = notes.get_page(db_session, bootstrapped_user, page.id)

    with pytest.raises(ApiError) as stale_anchor:
        notes.patch_page_document(
            db_session,
            bootstrapped_user,
            page.id,
            PatchPageDocumentRequest(
                client_mutation_id="mutation-stale-anchor",
                base_document_version=current_page.document_version,
                blocks=[_document_block(child.id, "child")],
                containment=[_document_containment("note_block", second_parent.id, [child.id])],
            ),
        )

    assert stale_anchor.value.code == ApiErrorCode.E_INVALID_REQUEST


def test_patch_page_document_rejects_legacy_revision_tokens():
    block_id = uuid4()
    with pytest.raises(ValidationError):
        PatchPageDocumentRequest.model_validate(
            {
                "client_mutation_id": "mutation-legacy",
                "base_document_version": 1,
                "base_page_revision": 12,
                "blocks": [],
                "containment": [],
                "deleted_block_ids": [],
            }
        )
    with pytest.raises(ValidationError):
        PatchPageDocumentRequest.model_validate(
            {
                "client_mutation_id": "mutation-legacy",
                "base_document_version": 1,
                "blocks": [
                    {
                        "id": str(block_id),
                        "block_kind": "bullet",
                        "body_pm_json": {"type": "paragraph"},
                        "base_revision": 4,
                    }
                ],
                "containment": [
                    _document_containment("page", uuid4(), [block_id]),
                ],
                "deleted_block_ids": [],
            }
        )
    with pytest.raises(ValidationError):
        PatchPageDocumentRequest.model_validate(
            {
                "client_mutation_id": "mutation-legacy",
                "base_document_version": 1,
                "blocks": [],
                "containment": [],
                "deleted_block_ids": [{"id": str(block_id), "base_revision": 4}],
            }
        )


@pytest.mark.integration
def test_patch_page_document_applies_independent_current_block_edits(
    db_session,
    bootstrapped_user,
):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Mergeable document {uuid4()}"),
    )
    first = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(page_id=page.id, body_markdown="first"),
    )
    second = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(page_id=page.id, after_block_id=first.id, body_markdown="second"),
    )
    current_page = notes.get_page(db_session, bootstrapped_user, page.id)

    first_result = notes.patch_page_document(
        db_session,
        bootstrapped_user,
        page.id,
        PatchPageDocumentRequest(
            client_mutation_id="mutation-first",
            base_document_version=current_page.document_version,
            blocks=[
                _document_block(first.id, "first local"),
                _document_block(second.id, "second"),
            ],
            containment=[
                _document_containment("page", page.id, [first.id, second.id]),
            ],
        ),
    )
    result = notes.patch_page_document(
        db_session,
        bootstrapped_user,
        page.id,
        PatchPageDocumentRequest(
            client_mutation_id="mutation-second",
            base_document_version=first_result.document_version,
            blocks=[
                _document_block(first.id, "first local"),
                _document_block(second.id, "second local"),
            ],
            containment=[
                _document_containment("page", page.id, [first.id, second.id]),
            ],
        ),
    )

    assert [block.body_text for block in result.page.blocks] == ["first local", "second local"]


@pytest.mark.integration
def test_object_ref_search_returns_visible_note_editor_targets(db_session, bootstrapped_user):
    default_library_id = ensure_user_and_default_library(db_session, bootstrapped_user)
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Evergreen notes {uuid4()}"),
    )
    block = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(page_id=page.id, body_markdown="Evergreen planning block"),
    )
    media_id = create_test_media_in_library(
        db_session,
        bootstrapped_user,
        default_library_id,
        title="Evergreen source article",
    )
    fragment_id = create_test_fragment(db_session, media_id, "Evergreen passage")
    highlight_id = create_test_highlight(
        db_session,
        bootstrapped_user,
        fragment_id,
        exact="Evergreen passage",
    )
    conversation_id, message_id = create_test_conversation_with_message(
        db_session,
        bootstrapped_user,
        content="Evergreen message",
    )
    conversation = db_session.get(Conversation, conversation_id)
    assert conversation is not None
    conversation.title = "Evergreen chat"
    other_user_id = create_test_user_id()
    ensure_user_and_default_library(db_session, other_user_id)
    other_page = Page(id=uuid4(), user_id=other_user_id, title="Evergreen private")
    db_session.add(other_page)
    db_session.commit()

    refs = object_refs.search_object_refs(db_session, bootstrapped_user, "Evergreen", limit=10)
    ref_keys = {(ref.object_type, ref.object_id) for ref in refs}

    assert ("page", page.id) in ref_keys
    assert ("note_block", block.id) in ref_keys
    assert ("media", media_id) in ref_keys
    assert ("fragment", fragment_id) in ref_keys
    assert ("highlight", highlight_id) in ref_keys
    assert ("conversation", conversation_id) in ref_keys
    assert ("message", message_id) in ref_keys
    assert ("page", other_page.id) not in ref_keys


@pytest.mark.integration
def test_hydrate_fragment_object_ref_returns_media_fragment_route(db_session, bootstrapped_user):
    default_library_id = ensure_user_and_default_library(db_session, bootstrapped_user)
    media_id = create_test_media_in_library(
        db_session,
        bootstrapped_user,
        default_library_id,
        title="Fragment route source",
    )
    fragment_id = create_test_fragment(
        db_session,
        media_id,
        "Fragment route passage for object refs",
    )

    ref = object_refs.hydrate_object_ref(
        db_session,
        bootstrapped_user,
        ObjectRef(object_type="fragment", object_id=fragment_id),
    )

    assert ref.object_type == "fragment"
    assert ref.object_id == fragment_id
    assert ref.label == "Fragment 1"
    assert ref.route == f"/media/{media_id}#fragment-{fragment_id}"
    assert "Fragment route passage" in (ref.snippet or "")
    assert ref.icon == "text"


@pytest.mark.integration
def test_daily_note_resolution_uses_durable_date_identity(db_session, bootstrapped_user):
    local_date = date(2026, 5, 6)
    same_title = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title="May 6, 2026"),
    )

    daily = notes.get_daily_note(db_session, bootstrapped_user, local_date)
    assert daily.local_date == local_date
    assert daily.page.id != same_title.id
    assert daily.page.title == "May 6, 2026"

    notes.update_page(
        db_session,
        bootstrapped_user,
        daily.page.id,
        UpdatePageRequest(title="Renamed daily page"),
    )
    resolved_again = notes.get_daily_note(db_session, bootstrapped_user, local_date)

    daily_rows = db_session.scalars(
        select(DailyNotePage).where(DailyNotePage.user_id == bootstrapped_user)
    ).all()
    assert len(daily_rows) == 1
    assert resolved_again.page.id == daily.page.id
    assert resolved_again.page.title == "Renamed daily page"


@pytest.mark.integration
def test_quick_capture_appends_to_daily_page_and_makes_it_indexable(
    db_session,
    bootstrapped_user,
):
    local_date = date(2026, 5, 7)

    block = notes.quick_capture(
        db_session,
        bootstrapped_user,
        request=QuickCaptureRequest(
            id=uuid4(),
            client_mutation_id="quick-capture-indexable",
            local_date=local_date,
            body_markdown="Daily capture projection needle",
        ),
    )
    daily = notes.get_daily_note(db_session, bootstrapped_user, local_date)

    assert block.page_id == daily.page.id
    assert [item.body_text for item in daily.page.blocks] == ["Daily capture projection needle"]

    # quick_capture enqueues a debounced reindex on the production path: the page is
    # marked pending and one in-flight page_reindex_job is queued for it.
    job_kind = db_session.scalar(
        text(
            """
            SELECT kind FROM background_jobs
            WHERE kind = 'page_reindex_job'
              AND (payload->>'page_id') = :page_id
              AND status NOT IN ('succeeded', 'dead')
            """
        ),
        {"page_id": str(daily.page.id)},
    )
    assert job_kind == "page_reindex_job"

    # Running that reindex synchronously indexes the captured note into the unified
    # content pipeline (owner_kind='page'), so its note_block becomes searchable content.
    rebuild_page_content_index(db_session, page_id=daily.page.id, reason="test")
    chunk_count = db_session.scalar(
        text(
            """
            SELECT count(*) FROM content_chunks
            WHERE owner_kind = 'page' AND owner_id = :page_id
            """
        ),
        {"page_id": daily.page.id},
    )
    assert chunk_count >= 1


@pytest.mark.integration
def test_quick_capture_reuses_caller_block_id_on_retry(db_session, bootstrapped_user):
    local_date = date(2026, 5, 8)
    block_id = uuid4()

    first = notes.quick_capture(
        db_session,
        bootstrapped_user,
        request=QuickCaptureRequest(
            id=block_id,
            client_mutation_id="quick-capture-retry-1",
            local_date=local_date,
            body_markdown="first save",
        ),
    )
    second = notes.quick_capture(
        db_session,
        bootstrapped_user,
        request=QuickCaptureRequest(
            id=block_id,
            client_mutation_id="quick-capture-retry-2",
            local_date=local_date,
            body_markdown="second save",
        ),
    )
    daily = notes.get_daily_note(db_session, bootstrapped_user, local_date)

    assert first.id == second.id == block_id
    assert [item.id for item in daily.page.blocks] == [block_id]
    assert [item.body_text for item in daily.page.blocks] == ["second save"]
    containment_count = db_session.scalar(
        select(func.count())
        .select_from(ResourceEdge)
        .where(
            ResourceEdge.user_id == bootstrapped_user,
            ResourceEdge.origin == "note_containment",
            ResourceEdge.target_scheme == "note_block",
            ResourceEdge.target_id == block_id,
        )
    )
    assert containment_count == 1


@pytest.mark.integration
def test_quick_capture_replays_same_client_mutation_id(db_session, bootstrapped_user):
    local_date = date(2026, 5, 9)
    block_id = uuid4()
    request = QuickCaptureRequest(
        id=block_id,
        client_mutation_id="quick-capture-same-mutation-replay",
        local_date=local_date,
        body_markdown="same retry body",
    )

    first = notes.quick_capture(db_session, bootstrapped_user, request=request)
    second = notes.quick_capture(db_session, bootstrapped_user, request=request)
    daily = notes.get_daily_note(db_session, bootstrapped_user, local_date)

    assert first.id == second.id == block_id
    assert [item.id for item in daily.page.blocks] == [block_id]
    assert [item.body_text for item in daily.page.blocks] == ["same retry body"]
    mutation_count = db_session.scalar(
        select(func.count())
        .select_from(PageDocumentMutation)
        .where(
            PageDocumentMutation.user_id == bootstrapped_user,
            PageDocumentMutation.page_id == daily.page.id,
            PageDocumentMutation.client_mutation_id == request.client_mutation_id,
        )
    )
    assert mutation_count == 1


@pytest.mark.integration
def test_pinned_object_refs_hydrate_and_order_navigation_items(db_session, bootstrapped_user):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Pinned page {uuid4()}"),
    )
    block = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(page_id=page.id, body_markdown="Pinned block"),
    )

    page_pin = object_refs.pin_object_ref(
        db_session,
        bootstrapped_user,
        object_refs.PinObjectRefInput(
            object_ref=ObjectRef(object_type="page", object_id=page.id),
            order_key="0000000002",
        ),
    )
    block_pin = object_refs.pin_object_ref(
        db_session,
        bootstrapped_user,
        object_refs.PinObjectRefInput(
            object_ref=ObjectRef(object_type="note_block", object_id=block.id),
            order_key="0000000001",
        ),
    )
    pins = object_refs.list_pinned_object_refs(db_session, bootstrapped_user)

    assert [pin.id for pin in pins] == [block_pin.id, page_pin.id]
    assert [pin.surface_key for pin in pins] == ["navbar", "navbar"]
    assert pins[0].object_ref.route == f"/notes/{block.id}"
    assert pins[1].object_ref.label == page.title

    object_refs.unpin_object_ref(db_session, bootstrapped_user, block_pin.id)
    assert db_session.get(PinnedObjectRef, block_pin.id) is None


@pytest.mark.integration
def test_deleting_pinned_page_removes_page_and_note_block_pins(db_session, bootstrapped_user):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Pinned deletion page {uuid4()}"),
    )
    block = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(page_id=page.id, body_markdown="Pinned child block"),
    )
    page_pin = object_refs.pin_object_ref(
        db_session,
        bootstrapped_user,
        object_refs.PinObjectRefInput(object_ref=ObjectRef(object_type="page", object_id=page.id)),
    )
    block_pin = object_refs.pin_object_ref(
        db_session,
        bootstrapped_user,
        object_refs.PinObjectRefInput(
            object_ref=ObjectRef(object_type="note_block", object_id=block.id)
        ),
    )
    view_state = db_session.scalar(
        select(NoteViewState).where(
            NoteViewState.user_id == bootstrapped_user,
            NoteViewState.context_source_scheme == "page",
            NoteViewState.context_source_id == page.id,
            NoteViewState.target_block_id == block.id,
        )
    )
    assert view_state is not None
    view_state.collapsed = True
    mutation = PageDocumentMutation(
        user_id=bootstrapped_user,
        page_id=page.id,
        client_mutation_id="test-delete-page",
        request_hash="0" * 64,
        base_document_version=1,
        document_version=1,
        response_json={"page": {"id": str(page.id)}},
    )
    db_session.add(mutation)
    db_session.flush()

    notes.delete_page(db_session, bootstrapped_user, page.id)

    assert db_session.get(PinnedObjectRef, page_pin.id) is None
    assert db_session.get(PinnedObjectRef, block_pin.id) is None
    assert db_session.get(NoteViewState, view_state.id) is None
    assert db_session.get(PageDocumentMutation, mutation.id) is None
    assert object_refs.list_pinned_object_refs(db_session, bootstrapped_user) == []


@pytest.mark.integration
def test_delete_note_block_preserves_inbound_citation_edge(db_session, bootstrapped_user):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Cited block deletion page {uuid4()}"),
    )
    block = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(page_id=page.id, body_markdown="Cited block body"),
    )
    _conversation_id, message_id = create_test_conversation_with_message(
        db_session,
        bootstrapped_user,
    )
    snapshot = {
        "title": "Deleted note block",
        "excerpt": "Cited block body",
        "deep_link": f"/pages/{page.id}",
    }
    cited = ResourceEdge(
        user_id=bootstrapped_user,
        kind="context",
        origin="citation",
        source_scheme="message",
        source_id=message_id,
        target_scheme="note_block",
        target_id=block.id,
        ordinal=1,
        snapshot=snapshot,
    )
    db_session.add(cited)
    db_session.flush()

    delete_block_via_document(db_session, bootstrapped_user, block.id)

    surviving = db_session.get(ResourceEdge, cited.id)
    assert db_session.get(NoteBlock, block.id) is None
    assert surviving is not None
    assert surviving.ordinal == 1
    assert surviving.snapshot == snapshot


@pytest.mark.integration
def test_pinned_objects_api_filters_and_reorders_by_surface(
    auth_client, direct_db: DirectSessionManager
):
    user_id = create_test_user_id()
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("libraries", "owner_user_id", user_id)
    direct_db.register_cleanup("memberships", "user_id", user_id)
    direct_db.register_cleanup("pages", "user_id", user_id)

    headers = auth_headers(user_id)
    assert auth_client.get("/me", headers=headers).status_code == 200
    page_response = auth_client.post(
        "/notes/pages",
        headers=headers,
        json={"title": f"Pinned API page {uuid4()}"},
    )
    assert page_response.status_code == 201, page_response.text
    page_id = page_response.json()["data"]["id"]

    navbar_pin = auth_client.post(
        "/pinned-objects",
        headers=headers,
        json={
            "objectType": "page",
            "objectId": page_id,
            "surfaceKey": "navbar",
            "orderKey": "0000000002",
        },
    )
    assert navbar_pin.status_code == 201, navbar_pin.text
    notes_pin = auth_client.post(
        "/pinned-objects",
        headers=headers,
        json={
            "objectType": "page",
            "objectId": page_id,
            "surfaceKey": "notes_home",
            "orderKey": "0000000001",
        },
    )
    assert notes_pin.status_code == 201, notes_pin.text

    navbar_list = auth_client.get("/pinned-objects?surface_key=navbar", headers=headers)
    assert navbar_list.status_code == 200, navbar_list.text
    assert [pin["id"] for pin in navbar_list.json()["data"]["pins"]] == [
        navbar_pin.json()["data"]["id"]
    ]

    patch_response = auth_client.patch(
        f"/pinned-objects/{navbar_pin.json()['data']['id']}",
        headers=headers,
        json={"orderKey": "0000000000"},
    )
    assert patch_response.status_code == 200, patch_response.text
    assert patch_response.json()["data"]["orderKey"] == "0000000000"
    assert patch_response.json()["data"]["surfaceKey"] == "navbar"

    delete_response = auth_client.delete(
        f"/pinned-objects/{notes_pin.json()['data']['id']}",
        headers=headers,
    )
    assert delete_response.status_code == 204, delete_response.text


@pytest.mark.integration
def test_note_block_mutation_routes_are_removed(auth_client, direct_db: DirectSessionManager):
    user_id = create_test_user_id()
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("libraries", "owner_user_id", user_id)
    direct_db.register_cleanup("memberships", "user_id", user_id)

    headers = auth_headers(user_id)
    assert auth_client.get("/me", headers=headers).status_code == 200

    block_id = uuid4()

    assert auth_client.post("/notes/blocks", headers=headers, json={}).status_code == 404
    assert (
        auth_client.patch(f"/notes/blocks/{block_id}", headers=headers, json={}).status_code == 405
    )
    assert auth_client.delete(f"/notes/blocks/{block_id}", headers=headers).status_code == 405
    assert (
        auth_client.post(f"/notes/blocks/{block_id}/move", headers=headers, json={}).status_code
        == 404
    )


@pytest.mark.integration
def test_object_ref_search_returns_contributors_and_content_chunks(
    db_session,
    bootstrapped_user,
):
    media_id = create_searchable_media(
        db_session,
        bootstrapped_user,
        title=f"ObjectRefNeedle source {uuid4()}",
    )
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[
            {
                "name": "ObjectRefNeedle Contributor",
                "role": "author",
                "source": "manual",
            }
        ],
    )
    contributor_id = db_session.execute(
        text(
            """
            SELECT contributor_id
            FROM contributor_credits
            WHERE media_id = :media_id
            LIMIT 1
            """
        ),
        {"media_id": media_id},
    ).scalar_one()
    chunk_id = db_session.execute(
        text(
            """
            SELECT id
            FROM content_chunks
            WHERE owner_kind = 'media' AND owner_id = :media_id
            ORDER BY chunk_idx ASC
            LIMIT 1
            """
        ),
        {"media_id": media_id},
    ).scalar_one()

    refs = object_refs.search_object_refs(
        db_session, bootstrapped_user, "ObjectRefNeedle", limit=10
    )
    ref_keys = {(ref.object_type, ref.object_id) for ref in refs}

    assert ("contributor", contributor_id) in ref_keys
    assert ("content_chunk", chunk_id) in ref_keys
    contributor_ref = object_refs.hydrate_object_ref(
        db_session,
        bootstrapped_user,
        ObjectRef(object_type="contributor", object_id=contributor_id),
    )
    content_chunk_ref = object_refs.hydrate_object_ref(
        db_session,
        bootstrapped_user,
        ObjectRef(object_type="content_chunk", object_id=chunk_id),
    )
    assert contributor_ref.label == "ObjectRefNeedle Contributor"
    assert content_chunk_ref.object_id == chunk_id
    assert "ObjectRefNeedle source" in (content_chunk_ref.snippet or "")


@pytest.mark.integration
def test_object_ref_search_and_hydration_support_page_owned_chunks_and_spans(
    db_session,
    bootstrapped_user,
):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"PageOwnedRefNeedle page {uuid4()}"),
    )
    block = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(
            page_id=page.id,
            body_markdown="PageOwnedRefNeedle citable note body",
        ),
    )
    rebuild_page_content_index(db_session, page_id=page.id, reason="test")

    chunk_id, evidence_span_id = db_session.execute(
        text(
            """
            SELECT id, primary_evidence_span_id
            FROM content_chunks
            WHERE owner_kind = 'page' AND owner_id = :page_id
            ORDER BY chunk_idx ASC
            LIMIT 1
            """
        ),
        {"page_id": page.id},
    ).one()
    assert evidence_span_id is not None

    chunk_ref = object_refs.hydrate_object_ref(
        db_session,
        bootstrapped_user,
        ObjectRef(object_type="content_chunk", object_id=chunk_id),
    )
    span_ref = object_refs.hydrate_object_ref(
        db_session,
        bootstrapped_user,
        ObjectRef(object_type="evidence_span", object_id=evidence_span_id),
    )
    assert chunk_ref.route == f"/notes/{block.id}"
    assert span_ref.route == f"/notes/{block.id}"
    assert "PageOwnedRefNeedle citable note body" in (chunk_ref.snippet or "")
    assert "PageOwnedRefNeedle citable note body" in (span_ref.snippet or "")

    chunk_results = object_refs.search_object_refs(
        db_session,
        bootstrapped_user,
        "PageOwnedRefNeedle",
        limit=10,
        object_types={"content_chunk"},
    )
    span_results = object_refs.search_object_refs(
        db_session,
        bootstrapped_user,
        "PageOwnedRefNeedle",
        limit=10,
        object_types={"evidence_span"},
    )
    assert [(ref.object_type, ref.object_id, ref.route) for ref in chunk_results] == [
        ("content_chunk", chunk_id, f"/notes/{block.id}")
    ]
    assert [(ref.object_type, ref.object_id, ref.route) for ref in span_results] == [
        ("evidence_span", evidence_span_id, f"/notes/{block.id}")
    ]
    with pytest.raises(NotFoundError):
        get_search_result(db_session, bootstrapped_user, "content_chunk", str(chunk_id))

    other_user = create_test_user_id()
    assert (
        object_refs.search_object_refs(
            db_session,
            other_user,
            "PageOwnedRefNeedle",
            limit=10,
            object_types={"content_chunk", "evidence_span"},
        )
        == []
    )
    with pytest.raises(NotFoundError):
        object_refs.hydrate_object_ref(
            db_session,
            other_user,
            ObjectRef(object_type="content_chunk", object_id=chunk_id),
        )
    with pytest.raises(NotFoundError):
        object_refs.hydrate_object_ref(
            db_session,
            other_user,
            ObjectRef(object_type="evidence_span", object_id=evidence_span_id),
        )


@pytest.mark.integration
def test_shared_reader_can_attach_own_note_to_visible_highlight(db_session):
    author_id = create_test_user_id()
    reader_id = create_test_user_id()
    ensure_user_and_default_library(db_session, author_id)
    ensure_user_and_default_library(db_session, reader_id)
    media_id = create_test_media(db_session, title=f"Shared note source {uuid4()}")
    shared_library_id = create_test_library(
        db_session, author_id, name=f"Shared note library {uuid4()}"
    )
    add_library_member(db_session, shared_library_id, reader_id)
    add_media_to_library(db_session, shared_library_id, media_id)
    fragment_id = create_test_fragment(db_session, media_id, "Shared quote for note linking")
    highlight_id = create_test_highlight(
        db_session,
        author_id,
        fragment_id,
        exact="Shared quote",
    )

    block = create_block_via_document(
        db_session,
        reader_id,
        dict(
            body_markdown="Reader-owned note",
            linked_object=dict(object_id=highlight_id),
        ),
    )

    assert block.body_text == "Reader-owned note"
    edges = _connection_edges(
        db_session,
        viewer_id=reader_id,
        ref=ResourceRef(scheme="highlight", id=highlight_id),
        origin="highlight_note",
    )
    assert [(edge.source.uri, edge.target.uri) for edge in edges] == [
        (f"highlight:{highlight_id}", f"note_block:{block.id}")
    ], f"Expected one reader-owned attachment edge, got {edges}"
    linked = linked_note_blocks_for_highlights(db_session, reader_id, [highlight_id])
    assert [b.id for b in linked.get(highlight_id, [])] == [block.id]


@pytest.mark.integration
def test_note_body_hashtag_syncs_to_tag_resource_edge(db_session, bootstrapped_user):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Tag sync {uuid4()}"),
    )
    block = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(
            page_id=page.id,
            body_pm_json=_paragraph_text("Ship #SOTA and #sota with #graph-grade"),
        ),
    )

    tags = db_session.scalars(
        select(Tag).where(Tag.user_id == bootstrapped_user).order_by(Tag.slug.asc())
    ).all()
    assert [(tag.name, tag.slug) for tag in tags] == [
        ("graph-grade", "graph-grade"),
        ("SOTA", "sota"),
    ]
    assert _note_body_targets(db_session, bootstrapped_user, block.id) == {
        f"tag:{tag.id}" for tag in tags
    }
    hydrated = object_refs.hydrate_object_ref(
        db_session,
        bootstrapped_user,
        ObjectRef(object_type="tag", object_id=tags[1].id),
    )
    assert hydrated.label == "#SOTA"
    assert hydrated.route is None
    tag_results = [
        result
        for result in object_refs.search_object_refs(db_session, bootstrapped_user, "#sot")
        if result.object_type == "tag"
    ]
    assert [result.object_id for result in tag_results] == [tags[1].id]

    update_block_via_document(
        db_session,
        bootstrapped_user,
        block.id,
        dict(body_pm_json=_paragraph_text("Keep #SOTA only")),
    )

    sota = db_session.scalar(
        select(Tag).where(Tag.user_id == bootstrapped_user, Tag.slug == "sota")
    )
    assert sota is not None
    assert _note_body_targets(db_session, bootstrapped_user, block.id) == {f"tag:{sota.id}"}


@pytest.mark.integration
def test_object_ref_search_type_filter_returns_tags_without_starvation(
    db_session, bootstrapped_user
):
    for index in range(3):
        notes.create_page(
            db_session,
            bootstrapped_user,
            CreatePageRequest(title=f"SOTA page result {index}"),
        )
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Tagged search {uuid4()}"),
    )
    block = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(page_id=page.id, body_pm_json=_paragraph_text("Ship #SOTA")),
    )

    unfiltered = object_refs.search_object_refs(db_session, bootstrapped_user, "sot", limit=1)
    tag_filtered = object_refs.search_object_refs(
        db_session,
        bootstrapped_user,
        "sot",
        limit=1,
        object_types={"tag"},
    )

    assert unfiltered[0].object_type == "page"
    assert [(result.object_type, result.label) for result in tag_filtered] == [("tag", "#SOTA")]
    assert _note_body_targets(db_session, bootstrapped_user, block.id) == {
        f"tag:{tag_filtered[0].object_id}"
    }


@pytest.mark.integration
def test_note_body_hashtag_sync_ignores_code_blocks(db_session, bootstrapped_user):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Code tag sync {uuid4()}"),
    )
    block = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(
            page_id=page.id,
            body_pm_json={
                "type": "code_block",
                "content": [{"type": "text", "text": "echo #not-a-tag"}],
            },
        ),
    )

    assert db_session.scalars(select(Tag).where(Tag.user_id == bootstrapped_user)).all() == []
    assert _note_body_targets(db_session, bootstrapped_user, block.id) == set()


@pytest.mark.integration
def test_body_sync_replace_sets_only_its_origin_scope(db_session, bootstrapped_user):
    """Body save replace-sets exactly the (source, origin='note_body') rows (§5.7).

    A seeded user link and a highlight attachment on the same block survive every
    body save, and a body ref whose endpoint pair already exists under the user
    origin still records the body-derived fact under ``origin=note_body``.
    """
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Replace-set scope {uuid4()}"),
    )
    first_target = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Replace-set target A {uuid4()}"),
    )
    second_target = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Replace-set target B {uuid4()}"),
    )
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title=f"Replace-set media {uuid4()}"
    )
    fragment_id = create_test_fragment(db_session, media_id, "Quote for the attachment edge")
    highlight_id = create_test_highlight(db_session, bootstrapped_user, fragment_id)
    block = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(
            page_id=page.id,
            body_pm_json=_paragraph_with_page_ref(first_target.id, "First target"),
            linked_object=dict(object_id=highlight_id),
        ),
    )
    block_ref = ResourceRef(scheme="note_block", id=block.id)
    user_edge = create_edge(
        db_session,
        viewer_id=bootstrapped_user,
        input=EdgeCreate(
            source=block_ref,
            target=ResourceRef(scheme="page", id=second_target.id),
            kind="context",
            origin="user",
        ),
    )
    db_session.commit()
    assert _note_body_targets(db_session, bootstrapped_user, block.id) == {
        f"page:{first_target.id}"
    }

    # Re-save with the body now pointing at second_target: the note_body set is
    # replaced and now coexists with the user's explicit link over the same pair.
    update_block_via_document(
        db_session,
        bootstrapped_user,
        block.id,
        dict(
            body_pm_json=_paragraph_with_page_ref(second_target.id, "Second target"),
        ),
    )

    assert _note_body_targets(db_session, bootstrapped_user, block.id) == {
        f"page:{second_target.id}"
    }
    survivors = _connection_edges(db_session, viewer_id=bootstrapped_user, ref=block_ref)
    by_origin: dict[str, list[EdgeOut]] = {}
    for edge in survivors:
        by_origin.setdefault(edge.origin, []).append(edge)
    assert [edge.id for edge in by_origin["user"]] == [user_edge.id], (
        f"user link must survive body sync: {survivors}"
    )
    assert [edge.target.uri for edge in by_origin["note_body"]] == [f"page:{second_target.id}"]
    assert by_origin["highlight_note"][0].source.uri == f"highlight:{highlight_id}", (
        f"highlight attachment must survive body sync: {survivors}"
    )
    assert [(edge.source.uri, edge.target.uri) for edge in by_origin["note_containment"]] == [
        (f"page:{page.id}", f"note_block:{block.id}")
    ]
    assert len(survivors) == 4, f"body sync must not leak extra edges: {survivors}"


@pytest.mark.integration
def test_highlight_note_attachment_round_trips_through_linked_note_blocks(
    db_session,
    bootstrapped_user,
):
    """Quick-note composer path: the attachment edge round-trips through
    ``linked_note_blocks_for_highlights`` in creation order, and a body that
    merely mentions the highlight is not an attachment (origin discrimination)."""
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title=f"Attachment media {uuid4()}"
    )
    fragment_id = create_test_fragment(db_session, media_id, "Quote for attachment round-trip")
    highlight_id = create_test_highlight(db_session, bootstrapped_user, fragment_id)

    first = notes.set_highlight_note_body_pm_json(
        db_session,
        bootstrapped_user,
        highlight_id=highlight_id,
        block_id=uuid4(),
        body_pm_json=_paragraph_text("first note"),
        client_mutation_id=f"highlight-note-test-{uuid4()}",
    )
    assert first is not None
    second = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(
            body_markdown="second note",
            linked_object=dict(object_id=highlight_id),
        ),
    )
    mention = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(
            body_pm_json={
                "type": "paragraph",
                "content": [
                    {"type": "text", "text": "Mentions "},
                    {
                        "type": "object_ref",
                        "attrs": {
                            "objectType": "highlight",
                            "objectId": str(highlight_id),
                            "label": "the quote",
                        },
                    },
                ],
            },
        ),
    )

    linked = linked_note_blocks_for_highlights(db_session, bootstrapped_user, [highlight_id])
    assert [block.id for block in linked[highlight_id]] == [first.id, second.id], (
        f"attachments must round-trip in creation order, got {linked}"
    )
    assert mention.id not in {block.id for block in linked[highlight_id]}, (
        "a note_body mention must not read as an attachment (origin=note_body vs highlight_note)"
    )


@pytest.mark.integration
def test_highlight_note_product_save_uses_document_mutation_ledger(
    db_session,
    bootstrapped_user,
):
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title=f"Highlight note media {uuid4()}"
    )
    fragment_id = create_test_fragment(db_session, media_id, "Quote for product note")
    highlight_id = create_test_highlight(db_session, bootstrapped_user, fragment_id)
    block_id = uuid4()
    mutation_id = "highlight-note-product-save"

    saved = notes.set_highlight_note_body_pm_json(
        db_session,
        bootstrapped_user,
        highlight_id=highlight_id,
        block_id=block_id,
        body_pm_json=_paragraph_text("first note"),
        client_mutation_id=mutation_id,
    )
    replay = notes.set_highlight_note_body_pm_json(
        db_session,
        bootstrapped_user,
        highlight_id=highlight_id,
        block_id=block_id,
        body_pm_json=_paragraph_text("first note"),
        client_mutation_id=mutation_id,
    )

    assert replay.id == saved.id == block_id
    linked = linked_note_blocks_for_highlights(db_session, bootstrapped_user, [highlight_id])
    assert [block.id for block in linked[highlight_id]] == [block_id]

    with pytest.raises(ConflictError) as excinfo:
        notes.set_highlight_note_body_pm_json(
            db_session,
            bootstrapped_user,
            highlight_id=highlight_id,
            block_id=block_id,
            body_pm_json=_paragraph_text("different note"),
            client_mutation_id=mutation_id,
        )
    assert excinfo.value.code == ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH

    notes.delete_highlight_note(
        db_session,
        bootstrapped_user,
        highlight_id=highlight_id,
        note_block_id=block_id,
        client_mutation_id="highlight-note-product-delete",
    )
    assert linked_note_blocks_for_highlights(db_session, bootstrapped_user, [highlight_id]) == {}


@pytest.mark.integration
def test_page_document_command_persists_split_result_and_syncs_refs(db_session, bootstrapped_user):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Split rich note {uuid4()}"),
    )
    target_page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Split ref target {uuid4()}"),
    )
    block = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(
            page_id=page.id,
            body_pm_json={
                "type": "paragraph",
                "content": [
                    {"type": "text", "text": "Read "},
                    {
                        "type": "text",
                        "text": "docs",
                        "marks": [{"type": "strong"}],
                    },
                    {"type": "text", "text": " with "},
                    {
                        "type": "object_ref",
                        "attrs": {
                            "objectType": "page",
                            "objectId": str(target_page.id),
                            "label": "Source",
                        },
                    },
                    {"type": "text", "text": " after"},
                ],
            },
        ),
    )

    new_block_id = uuid4()
    patch_document_via_command(
        db_session,
        bootstrapped_user,
        page_id=page.id,
        blocks=[
            {
                "id": block.id,
                "block_kind": "bullet",
                "body_pm_json": {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "Read "},
                        {
                            "type": "text",
                            "text": "docs",
                            "marks": [{"type": "strong"}],
                        },
                    ],
                },
            },
            {
                "id": new_block_id,
                "block_kind": "bullet",
                "body_pm_json": {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": " with "},
                        {
                            "type": "object_ref",
                            "attrs": {
                                "objectType": "page",
                                "objectId": str(target_page.id),
                                "label": "Source",
                            },
                        },
                        {"type": "text", "text": " after"},
                    ],
                },
            },
        ],
        containment_by_parent={
            ResourceRef(scheme="page", id=page.id): [
                {"block_id": block.id, "source_order_key": "0000000001", "collapsed": False},
                {"block_id": new_block_id, "source_order_key": "0000000002", "collapsed": False},
            ]
        },
        focus_block_id=new_block_id,
    )
    original = notes.get_note_block(db_session, bootstrapped_user, block.id)
    new_block = notes.get_note_block(db_session, bootstrapped_user, new_block_id)

    assert original.body_text == "Read docs"
    assert original.body_pm_json["content"][1] == {
        "type": "text",
        "text": "docs",
        "marks": [{"type": "strong"}],
    }
    assert new_block.body_text == "with Source after"
    assert new_block.body_pm_json["content"][1] == {
        "type": "object_ref",
        "attrs": {
            "objectType": "page",
            "objectId": str(target_page.id),
            "label": "Source",
        },
    }
    assert _note_body_targets(db_session, bootstrapped_user, block.id) == set(), (
        "Split should remove inline refs no longer present on original"
    )
    assert _note_body_targets(db_session, bootstrapped_user, new_block.id) == {
        f"page:{target_page.id}"
    }


@pytest.mark.integration
def test_page_document_command_persists_merge_result_and_syncs_refs(db_session, bootstrapped_user):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Merge rich note {uuid4()}"),
    )
    target_page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Merge ref target {uuid4()}"),
    )
    first = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(
            page_id=page.id,
            body_pm_json={
                "type": "paragraph",
                "content": [
                    {"type": "text", "text": "Alpha "},
                    {"type": "text", "text": "one", "marks": [{"type": "em"}]},
                ],
            },
        ),
    )
    second = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(
            page_id=page.id,
            after_block_id=first.id,
            body_pm_json={
                "type": "paragraph",
                "content": [
                    {
                        "type": "object_ref",
                        "attrs": {
                            "objectType": "page",
                            "objectId": str(target_page.id),
                            "label": "Source",
                        },
                    },
                    {"type": "text", "text": " beta"},
                ],
            },
        ),
    )

    patch_document_via_command(
        db_session,
        bootstrapped_user,
        page_id=page.id,
        blocks=[
            {
                "id": first.id,
                "block_kind": "bullet",
                "body_pm_json": {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "Alpha "},
                        {"type": "text", "text": "one", "marks": [{"type": "em"}]},
                        {"type": "hard_break"},
                        {
                            "type": "object_ref",
                            "attrs": {
                                "objectType": "page",
                                "objectId": str(target_page.id),
                                "label": "Source",
                            },
                        },
                        {"type": "text", "text": " beta"},
                    ],
                },
            }
        ],
        containment_by_parent={
            ResourceRef(scheme="page", id=page.id): [
                {"block_id": first.id, "source_order_key": "0000000001", "collapsed": False},
            ],
        },
        deleted_block_ids=[second.id],
        focus_block_id=first.id,
    )
    merged = notes.get_note_block(db_session, bootstrapped_user, first.id)

    assert merged.id == first.id
    assert merged.body_text == "Alpha one\nSource beta"
    assert {"type": "hard_break"} in merged.body_pm_json["content"]
    assert {
        "type": "text",
        "text": "one",
        "marks": [{"type": "em"}],
    } in merged.body_pm_json["content"]
    assert {
        "type": "object_ref",
        "attrs": {
            "objectType": "page",
            "objectId": str(target_page.id),
            "label": "Source",
        },
    } in merged.body_pm_json["content"]
    assert _note_body_targets(db_session, bootstrapped_user, first.id) == {
        f"page:{target_page.id}"
    }, "Merge must move the absorbed block's body refs onto the surviving block"


@pytest.mark.integration
def test_page_document_command_moves_children_without_order_collision(
    db_session, bootstrapped_user
):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Merge children note {uuid4()}"),
    )
    first = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(page_id=page.id, body_markdown="First"),
    )
    second = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(
            page_id=page.id,
            after_block_id=first.id,
            body_markdown="Second",
        ),
    )
    first_child = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(
            page_id=page.id,
            parent_block_id=first.id,
            body_markdown="First child",
        ),
    )
    second_child = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(
            page_id=page.id,
            parent_block_id=second.id,
            body_markdown="Second child",
        ),
    )
    target_view_state = db_session.scalar(
        select(NoteViewState).where(
            NoteViewState.user_id == bootstrapped_user,
            NoteViewState.context_source_scheme == "page",
            NoteViewState.context_source_id == page.id,
            NoteViewState.target_block_id == second.id,
        )
    )
    child_view_state = db_session.scalar(
        select(NoteViewState).where(
            NoteViewState.user_id == bootstrapped_user,
            NoteViewState.context_source_scheme == "note_block",
            NoteViewState.context_source_id == second.id,
            NoteViewState.target_block_id == second_child.id,
        )
    )
    assert target_view_state is not None
    assert child_view_state is not None
    target_view_state.collapsed = True
    child_view_state.collapsed = True
    db_session.flush()
    target_view_state_id = target_view_state.id
    child_view_state_id = child_view_state.id

    patch_document_via_command(
        db_session,
        bootstrapped_user,
        page_id=page.id,
        blocks=[
            {
                "id": first.id,
                "block_kind": "bullet",
                "body_pm_json": first.body_pm_json,
            },
            {
                "id": first_child.id,
                "block_kind": "bullet",
                "body_pm_json": first_child.body_pm_json,
            },
            {
                "id": second_child.id,
                "block_kind": "bullet",
                "body_pm_json": second_child.body_pm_json,
            },
        ],
        containment_by_parent={
            ResourceRef(scheme="page", id=page.id): [
                {"block_id": first.id, "source_order_key": "0000000001", "collapsed": False},
            ],
            ResourceRef(scheme="note_block", id=first.id): [
                {
                    "block_id": first_child.id,
                    "source_order_key": "0000000001",
                    "collapsed": False,
                },
                {
                    "block_id": second_child.id,
                    "source_order_key": "0000000002",
                    "collapsed": False,
                },
            ],
        },
        deleted_block_ids=[second.id],
        focus_block_id=first.id,
    )
    merged = notes.get_note_block(db_session, bootstrapped_user, first.id)
    document = graph_documents.load_page_document(
        db_session,
        user_id=bootstrapped_user,
        page_id=page.id,
    )

    assert merged.id == first.id
    assert [root.block.id for root in document.roots] == [first.id]
    assert [child.block.id for child in document.roots[0].children] == [
        first_child.id,
        second_child.id,
    ]
    assert db_session.get(NoteBlock, second.id) is None
    assert db_session.get(NoteViewState, target_view_state_id) is None
    assert db_session.get(NoteViewState, child_view_state_id) is None


@pytest.mark.integration
def test_update_note_block_syncs_inline_reference_links(db_session, bootstrapped_user):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Inline refs source {uuid4()}"),
    )
    first_target = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Inline refs target A {uuid4()}"),
    )
    second_target = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Inline refs target B {uuid4()}"),
    )
    block = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(
            page_id=page.id,
            body_pm_json=_paragraph_with_page_ref(first_target.id, "First target"),
        ),
    )

    assert _note_body_targets(db_session, bootstrapped_user, block.id) == {
        f"page:{first_target.id}"
    }

    update_block_via_document(
        db_session,
        bootstrapped_user,
        block.id,
        dict(
            body_pm_json=_paragraph_with_page_ref(second_target.id, "Second target"),
        ),
    )
    assert _note_body_targets(db_session, bootstrapped_user, block.id) == {
        f"page:{second_target.id}"
    }, "body save must replace-set the note_body edges to the new body's targets"


@pytest.mark.integration
def test_inline_reference_sync_dedups_repeated_refs_to_one_edge(db_session, bootstrapped_user):
    """The same ref twice in one body is ONE edge — positions are not stored (§5.7)."""
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Inline duplicate refs source {uuid4()}"),
    )
    target = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Inline duplicate refs target {uuid4()}"),
    )

    block = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(
            page_id=page.id,
            body_pm_json=_paragraph_with_duplicate_page_refs(target.id, "Repeated target"),
        ),
    )

    edges = _note_body_edges(db_session, bootstrapped_user, block.id)
    assert [edge.target.uri for edge in edges] == [f"page:{target.id}"], (
        f"a ref repeated in one body must produce exactly one edge, got {edges}"
    )
    assert edges[0].kind == "context" and edges[0].ordinal is None


@pytest.mark.integration
def test_object_embed_block_syncs_embed_link(db_session, bootstrapped_user):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Embed source {uuid4()}"),
    )
    target = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Embed target {uuid4()}"),
    )

    block = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(
            page_id=page.id,
            block_kind="embed",
            body_pm_json={
                "type": "object_embed",
                "attrs": {
                    "objectType": "page",
                    "objectId": str(target.id),
                    "label": "Embedded target",
                    "relationType": "embeds",
                    "displayMode": "compact",
                },
            },
        ),
    )

    assert block.body_text == "Embedded target"
    assert block.body_markdown == f"![[page:{target.id}|Embedded target]]"
    assert _note_body_targets(db_session, bootstrapped_user, block.id) == {f"page:{target.id}"}, (
        "an object_embed body produces the same note_body edge as a ref (the verb died)"
    )


@pytest.mark.integration
def test_notes_validation_through_api(auth_client, direct_db: DirectSessionManager):
    user_id = create_test_user_id()
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("libraries", "owner_user_id", user_id)
    direct_db.register_cleanup("memberships", "user_id", user_id)
    direct_db.register_cleanup("pages", "user_id", user_id)
    direct_db.register_cleanup("note_blocks", "user_id", user_id)
    direct_db.register_cleanup("note_view_states", "user_id", user_id)

    headers = auth_headers(user_id)
    me_response = auth_client.get("/me", headers=headers)
    assert me_response.status_code == 200, me_response.text

    page_response = auth_client.post(
        "/notes/pages",
        headers=headers,
        json={"title": f"API notes {uuid4()}"},
    )
    assert page_response.status_code == 201, page_response.text
    page_id = page_response.json()["data"]["id"]

    parent_id = uuid4()
    child_id = uuid4()
    create_document = auth_client.patch(
        f"/notes/pages/{page_id}/document",
        headers=headers,
        json={
            "client_mutation_id": "api-notes-create",
            "base_document_version": page_response.json()["data"]["documentVersion"],
            "blocks": [
                _document_block(parent_id, "parent"),
                _document_block(child_id, "child"),
            ],
            "containment": [
                _document_containment("page", UUID(page_id), [parent_id]),
                _document_containment("note_block", parent_id, [child_id]),
            ],
            "deleted_block_ids": [],
        },
    )
    assert create_document.status_code == 200, create_document.text
    document_version = create_document.json()["data"]["documentVersion"]

    invalid_pm_json = auth_client.patch(
        f"/notes/pages/{page_id}/document",
        headers=headers,
        json={
            "client_mutation_id": "api-notes-invalid-pm",
            "base_document_version": document_version,
            "blocks": [
                {
                    "id": str(parent_id),
                    "block_kind": "bullet",
                    "body_pm_json": {"content": [{"text": "missing type"}]},
                },
                _document_block(child_id, "child"),
            ],
            "containment": [
                _document_containment("page", UUID(page_id), [parent_id]),
                _document_containment("note_block", parent_id, [child_id]),
            ],
            "deleted_block_ids": [],
        },
    )
    assert invalid_pm_json.status_code == 400, invalid_pm_json.text
    assert invalid_pm_json.json()["error"]["code"] == ApiErrorCode.E_INVALID_REQUEST.value

    invalid_move = auth_client.patch(
        f"/notes/pages/{page_id}/document",
        headers=headers,
        json={
            "client_mutation_id": "api-notes-invalid-cycle",
            "base_document_version": document_version,
            "blocks": [
                _document_block(parent_id, "parent"),
                _document_block(child_id, "child"),
            ],
            "containment": [
                _document_containment("note_block", parent_id, [child_id]),
                _document_containment("note_block", child_id, [parent_id]),
            ],
            "deleted_block_ids": [],
        },
    )
    assert invalid_move.status_code == 400, invalid_move.text
    assert invalid_move.json()["error"]["code"] == ApiErrorCode.E_INVALID_REQUEST.value

    invalid_object_ref_type = auth_client.get(
        f"/object-refs/resolve?ref=invalid_type:{page_id}",
        headers=headers,
    )
    assert invalid_object_ref_type.status_code == 400, invalid_object_ref_type.text
    assert invalid_object_ref_type.json()["error"]["code"] == ApiErrorCode.E_INVALID_REQUEST.value

    invalid_object_ref_search_type = auth_client.get(
        "/object-refs/search?q=sot&type=invalid_type",
        headers=headers,
    )
    assert invalid_object_ref_search_type.status_code == 400, invalid_object_ref_search_type.text
    assert (
        invalid_object_ref_search_type.json()["error"]["code"]
        == ApiErrorCode.E_INVALID_REQUEST.value
    )


def _page_content_index_row_counts(db_session, page_id) -> dict[str, int]:
    """All content-index rows owned by a page (owner_kind='page'), keyed by table.

    content_embeddings and content_chunk_parts join through content_chunks since they
    carry no owner columns of their own. After a page or its last cited block is gone
    and the index is rebuilt/torn down, every count here must be zero.
    """
    owned = {
        "content_chunks": (
            "SELECT count(*) FROM content_chunks WHERE owner_kind = 'page' AND owner_id = :page_id"
        ),
        "evidence_spans": (
            "SELECT count(*) FROM evidence_spans WHERE owner_kind = 'page' AND owner_id = :page_id"
        ),
        "content_blocks": (
            "SELECT count(*) FROM content_blocks WHERE owner_kind = 'page' AND owner_id = :page_id"
        ),
        "content_index_states": (
            "SELECT count(*) FROM content_index_states "
            "WHERE owner_kind = 'page' AND owner_id = :page_id"
        ),
        "content_embeddings": (
            "SELECT count(*) FROM content_embeddings ce "
            "JOIN content_chunks cc ON cc.id = ce.chunk_id "
            "WHERE cc.owner_kind = 'page' AND cc.owner_id = :page_id"
        ),
        "content_chunk_parts": (
            "SELECT count(*) FROM content_chunk_parts ccp "
            "JOIN content_chunks cc ON cc.id = ccp.chunk_id "
            "WHERE cc.owner_kind = 'page' AND cc.owner_id = :page_id"
        ),
    }
    return {
        table: int(db_session.scalar(text(sql), {"page_id": page_id}))
        for table, sql in owned.items()
    }


def _seed_note_citation_for_chunk(db_session, viewer_id, page_id, evidence_span_id):
    """Persist a note citation: a message_retrievals row whose evidence_span_id points at
    a page-owned content chunk's primary evidence span (the chat ``[N]`` -> note span link).

    Returns the retrieval id so the test can re-read its evidence_span_id after a delete.
    """
    conversation_id = create_test_conversation(db_session, viewer_id)
    user_message_id = create_test_message(db_session, conversation_id, seq=1, role="user")
    assistant_message_id = create_test_message(db_session, conversation_id, seq=2, role="assistant")
    tool_call_id = uuid4()
    db_session.execute(
        text(
            """
            INSERT INTO message_tool_calls (
                id,
                conversation_id,
                user_message_id,
                assistant_message_id,
                tool_name,
                tool_call_index,
                scope,
                status
            )
            VALUES (
                :tool_call_id,
                :conversation_id,
                :user_message_id,
                :assistant_message_id,
                'app_search',
                0,
                'all',
                'complete'
            )
            """
        ),
        {
            "tool_call_id": tool_call_id,
            "conversation_id": conversation_id,
            "user_message_id": user_message_id,
            "assistant_message_id": assistant_message_id,
        },
    )
    retrieval_id = uuid4()
    db_session.execute(
        text(
            """
            INSERT INTO message_retrievals (
                id,
                tool_call_id,
                ordinal,
                result_type,
                source_id,
                evidence_span_id,
                context_ref,
                result_ref
            )
            VALUES (
                :retrieval_id,
                :tool_call_id,
                0,
                'note_block',
                :source_id,
                :evidence_span_id,
                CAST(:context_ref AS jsonb),
                CAST(:result_ref AS jsonb)
            )
            """
        ),
        {
            "retrieval_id": retrieval_id,
            "tool_call_id": tool_call_id,
            "source_id": str(page_id),
            "evidence_span_id": evidence_span_id,
            "context_ref": f'{{"type":"page","id":"{page_id}"}}',
            "result_ref": (
                '{"type":"note_block",'
                f'"id":"{page_id}",'
                '"result_type":"note_block",'
                f'"source_id":"{page_id}"}}'
            ),
        },
    )
    db_session.commit()
    return retrieval_id


@pytest.mark.integration
def test_delete_page_nulls_note_citations_and_removes_all_owned_content_index_rows(
    db_session,
    bootstrapped_user,
):
    """AC-4: deleting a cited note page nulls the citation's span (row preserved) and
    leaves zero content-index rows for that owner across every backing table."""
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Citable note page {uuid4()}"),
    )
    create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(
            page_id=page.id,
            body_markdown="Orphan-cleanup note needle for content indexing",
        ),
    )

    rebuild_page_content_index(db_session, page_id=page.id, reason="test")
    db_session.commit()

    chunk_row = db_session.execute(
        text(
            """
            SELECT id, primary_evidence_span_id
            FROM content_chunks
            WHERE owner_kind = 'page' AND owner_id = :page_id
            ORDER BY chunk_idx ASC
            LIMIT 1
            """
        ),
        {"page_id": page.id},
    ).one_or_none()
    assert chunk_row is not None, "Indexing the note page must produce at least one content chunk"
    evidence_span_id = chunk_row[1]
    assert evidence_span_id is not None, "Note chunk must carry a primary evidence span to cite"

    retrieval_id = _seed_note_citation_for_chunk(
        db_session, bootstrapped_user, page.id, evidence_span_id
    )

    notes.delete_page(db_session, bootstrapped_user, page.id)

    citation_span = db_session.scalar(
        text("SELECT evidence_span_id FROM message_retrievals WHERE id = :id"),
        {"id": retrieval_id},
    )
    citation_exists = db_session.scalar(
        text("SELECT count(*) FROM message_retrievals WHERE id = :id"),
        {"id": retrieval_id},
    )
    assert citation_exists == 1, (
        "Deleting a page must preserve the citing message_retrievals row, not delete it; "
        f"retrieval {retrieval_id}"
    )
    assert citation_span is None, (
        "Deleting a cited page must null the citation's evidence_span_id, not dangle it; "
        f"got {citation_span} for retrieval {retrieval_id}"
    )

    counts = _page_content_index_row_counts(db_session, page.id)
    assert counts == {
        "content_chunks": 0,
        "evidence_spans": 0,
        "content_blocks": 0,
        "content_index_states": 0,
        "content_embeddings": 0,
        "content_chunk_parts": 0,
    }, f"Page delete must remove every owner_kind='page' content-index row, got {counts}"


@pytest.mark.integration
def test_delete_cited_note_block_then_reindex_removes_its_chunk_and_span(
    db_session,
    bootstrapped_user,
):
    """AC-4 (block level): deleting one cited block on a surviving page and reindexing
    drops that block's chunk + span (its citation is nulled) while the page itself and
    its other blocks keep a clean, orphan-free index."""
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Block-delete note page {uuid4()}"),
    )
    doomed = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(
            page_id=page.id,
            body_markdown="Doomed block needle that will be deleted and reindexed away",
        ),
    )
    survivor = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(
            page_id=page.id,
            body_markdown="Surviving block needle that stays indexed after the delete",
        ),
    )

    rebuild_page_content_index(db_session, page_id=page.id, reason="test")
    db_session.commit()

    doomed_span_id = db_session.scalar(
        text(
            """
            SELECT cc.primary_evidence_span_id
            FROM content_chunks cc
            JOIN evidence_spans es ON es.id = cc.primary_evidence_span_id
            JOIN content_blocks cb ON cb.id = es.start_block_id
            WHERE cc.owner_kind = 'page' AND cc.owner_id = :page_id
              AND (cb.locator->>'note_block_id') = :note_block_id
            LIMIT 1
            """
        ),
        {"page_id": page.id, "note_block_id": str(doomed.id)},
    )
    assert doomed_span_id is not None, (
        "Indexing must produce a citeable evidence span for the doomed block "
        f"{doomed.id} on page {page.id}"
    )

    retrieval_id = _seed_note_citation_for_chunk(
        db_session, bootstrapped_user, page.id, doomed_span_id
    )

    initial_counts = _page_content_index_row_counts(db_session, page.id)
    assert initial_counts["content_chunks"] >= 2, (
        f"Two non-empty blocks should index to at least two chunks, got {initial_counts}"
    )

    # Delete only the cited block; the service enqueues a reindex but does not rebuild
    # inline, so the new (post-delete) index is produced by running the reindex.
    delete_block_via_document(db_session, bootstrapped_user, doomed.id)
    rebuild_page_content_index(db_session, page_id=page.id, reason="test")
    db_session.commit()

    # The deleted block's span is gone, so its citation is nulled (row preserved).
    citation_span = db_session.scalar(
        text("SELECT evidence_span_id FROM message_retrievals WHERE id = :id"),
        {"id": retrieval_id},
    )
    assert citation_span is None, (
        "Reindexing after a cited block delete must null that block's note citation; "
        f"got {citation_span} for retrieval {retrieval_id}"
    )

    # No row for the deleted block remains anywhere in the page's index (no orphans).
    doomed_chunk_count = db_session.scalar(
        text(
            """
            SELECT count(*)
            FROM content_blocks
            WHERE owner_kind = 'page' AND owner_id = :page_id
              AND (locator->>'note_block_id') = :note_block_id
            """
        ),
        {"page_id": page.id, "note_block_id": str(doomed.id)},
    )
    assert doomed_chunk_count == 0, (
        f"Deleted block {doomed.id} must leave no content_blocks rows on page {page.id}"
    )

    # The surviving block is still indexed and the index stays internally consistent
    # (every chunk part / embedding still joins to a live page-owned chunk).
    survivor_block_count = db_session.scalar(
        text(
            """
            SELECT count(*)
            FROM content_blocks
            WHERE owner_kind = 'page' AND owner_id = :page_id
              AND (locator->>'note_block_id') = :note_block_id
            """
        ),
        {"page_id": page.id, "note_block_id": str(survivor.id)},
    )
    assert survivor_block_count >= 1, (
        f"Surviving block {survivor.id} must remain indexed on page {page.id}"
    )
    final_counts = _page_content_index_row_counts(db_session, page.id)
    assert final_counts["content_chunks"] >= 1, (
        f"The surviving block must still produce a chunk, got {final_counts}"
    )
    assert final_counts["content_embeddings"] == final_counts["content_chunks"], (
        "Every surviving page chunk must keep exactly one embedding (no orphan parts); "
        f"got {final_counts}"
    )


def _inflight_page_reindex_jobs(db_session, page_id) -> list:
    """Non-terminal page_reindex_job ids for a page, newest first.

    Mirrors the partial unique index uq_page_reindex_job_inflight predicate
    (kind='page_reindex_job' AND status NOT IN ('succeeded','dead')). page_id is bound
    as text because payload->>'page_id' is a text extraction.
    """
    return [
        row[0]
        for row in db_session.execute(
            text(
                """
                SELECT id
                FROM background_jobs
                WHERE kind = 'page_reindex_job'
                  AND (payload->>'page_id') = :page_id
                  AND status NOT IN ('succeeded', 'dead')
                ORDER BY created_at DESC, id DESC
                """
            ),
            {"page_id": str(page_id)},
        ).all()
    ]


@pytest.mark.integration
def test_debounced_page_reindex_coalesces_in_flight_then_rearms_after_completion(
    db_session,
    bootstrapped_user,
):
    """AC-3/AC-8: rapid edits coalesce onto one in-flight page_reindex_job, but once that
    job is terminal the next edit enqueues a FRESH job. Guards the static-dedupe-key
    regression where the second post-completion edit was silently dropped."""
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Debounce reindex page {uuid4()}"),
    )
    block = create_block_via_document(
        db_session,
        bootstrapped_user,
        dict(page_id=page.id, body_markdown="first body"),
    )
    db_session.commit()

    # First edit: enqueue_page_reindex runs and leaves exactly one in-flight job.
    update_block_via_document(
        db_session,
        bootstrapped_user,
        block.id,
        dict(
            body_pm_json={
                "type": "paragraph",
                "content": [{"type": "text", "text": "edited once"}],
            },
        ),
    )
    db_session.commit()

    after_first = _inflight_page_reindex_jobs(db_session, page.id)
    assert len(after_first) == 1, (
        f"First edit must leave exactly one in-flight page_reindex_job, got {after_first}"
    )
    inflight_job_id = after_first[0]

    # Second edit before the job drains: the in-flight job is reused, not duplicated, and
    # the IntegrityError from the partial unique index is swallowed (no error to caller).
    update_block_via_document(
        db_session,
        bootstrapped_user,
        block.id,
        dict(
            body_pm_json={
                "type": "paragraph",
                "content": [{"type": "text", "text": "edited twice"}],
            },
        ),
    )
    db_session.commit()

    after_second = _inflight_page_reindex_jobs(db_session, page.id)
    assert after_second == [inflight_job_id], (
        "Second edit must coalesce onto the in-flight job (one row, same id), got "
        f"{after_second} (expected [{inflight_job_id}])"
    )

    # Drive the page's in-flight job to 'succeeded' through the real queue path. The
    # shared queue may hold other page_reindex_jobs (FIFO claim order), so drain until
    # this page's job is terminal — exercising claim_next_job + complete_job for real.
    drained_ours = False
    while _inflight_page_reindex_jobs(db_session, page.id):
        claimed = claim_next_job(
            db_session,
            worker_id="test-worker",
            lease_seconds=60,
            allowed_kinds=["page_reindex_job"],
        )
        assert claimed is not None, (
            "A claimable page_reindex_job must exist while ours is in-flight"
        )
        drained_ours = drained_ours or claimed.id == inflight_job_id
        completed = complete_job(
            db_session,
            job_id=claimed.id,
            worker_id="test-worker",
            result_payload={"status": "ready"},
        )
        assert completed, f"complete_job must mark job {claimed.id} succeeded"
        db_session.commit()

    assert drained_ours, f"The in-flight job {inflight_job_id} must have been claimed and completed"
    assert _inflight_page_reindex_jobs(db_session, page.id) == [], (
        "After completion there must be no in-flight page_reindex_job for the page"
    )

    # Third edit after the job is terminal: the dedupe must RE-ARM and enqueue a fresh job.
    update_block_via_document(
        db_session,
        bootstrapped_user,
        block.id,
        dict(
            body_pm_json={
                "type": "paragraph",
                "content": [{"type": "text", "text": "edited a third time"}],
            },
        ),
    )
    db_session.commit()

    after_third = _inflight_page_reindex_jobs(db_session, page.id)
    assert len(after_third) == 1, (
        "A post-completion edit must enqueue exactly one fresh in-flight job (re-arm), got "
        f"{after_third}"
    )
    assert after_third[0] != inflight_job_id, (
        "The re-armed job must be a NEW row, not the completed one; "
        f"got {after_third[0]} == completed {inflight_job_id}"
    )
