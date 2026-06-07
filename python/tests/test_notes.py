from datetime import date
from uuid import uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import select, text

from nexus.db.models import (
    Conversation,
    DailyNotePage,
    NoteBlock,
    ObjectLink,
    Page,
    PinnedObjectRef,
)
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.jobs.queue import claim_next_job, complete_job
from nexus.schemas.notes import (
    UNSET,
    CreateNoteBlockRequest,
    CreatePageRequest,
    LinkedObjectRequest,
    MoveNoteBlockRequest,
    ObjectRef,
    PatchPageDocumentRequest,
    QuickCaptureRequest,
    SplitNoteBlockRequest,
    UpdateNoteBlockRequest,
    UpdateObjectLinkRequest,
    UpdatePageRequest,
)
from nexus.services import notes, object_links, object_refs
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.contributor_credits import replace_media_contributor_credits
from nexus.services.note_indexing import rebuild_page_content_index
from nexus.services.notes import markdown_from_pm_json, text_from_pm_json
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
)
from tests.helpers import auth_headers, create_test_user_id
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

    valid = CreateNoteBlockRequest(
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
        }
    )

    assert valid.body_pm_json is not None
    assert valid.body_pm_json["type"] == "paragraph"

    with pytest.raises(ValidationError):
        CreateNoteBlockRequest(body_pm_json={"content": []})

    with pytest.raises(ValidationError):
        UpdateNoteBlockRequest(
            body_pm_json={
                "type": "paragraph",
                "content": [{"type": "unknown_node", "text": "bad"}],
            },
        )


def test_update_object_link_request_distinguishes_absent_null_and_value():
    """The order-key sentinel separates an omitted field, an explicit null, and a value."""
    absent = UpdateObjectLinkRequest()
    assert absent.a_order_key is UNSET
    assert absent.b_order_key is UNSET

    cleared = UpdateObjectLinkRequest(a_order_key=None)
    assert cleared.a_order_key is None
    assert cleared.b_order_key is UNSET

    valued = UpdateObjectLinkRequest(a_order_key="0000000001")
    assert valued.a_order_key == "0000000001"

    with pytest.raises(ValidationError):
        UpdateObjectLinkRequest(a_order_key="")


@pytest.mark.integration
def test_nested_note_create_move_and_delete_cleanup(db_session, bootstrapped_user):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Nested notes {uuid4()}"),
    )
    parent = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(page_id=page.id, body_markdown="parent"),
    )
    child_one = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(
            page_id=page.id,
            parent_block_id=parent.id,
            body_markdown="child one",
        ),
    )
    child_two = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(
            page_id=page.id,
            parent_block_id=parent.id,
            after_block_id=child_one.id,
            body_markdown="child two",
            linked_object=LinkedObjectRequest(
                object_type="page",
                object_id=page.id,
                relation_type="references",
            ),
        ),
    )
    child_zero = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(
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

    other_parent = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(page_id=page.id, body_markdown="other parent"),
    )
    moved = notes.move_note_block(
        db_session,
        bootstrapped_user,
        child_zero.id,
        MoveNoteBlockRequest(parent_block_id=other_parent.id),
    )
    assert moved.parent_block_id == other_parent.id

    with pytest.raises(ApiError) as invalid_anchor:
        notes.create_note_block(
            db_session,
            bootstrapped_user,
            CreateNoteBlockRequest(
                page_id=page.id,
                parent_block_id=other_parent.id,
                before_block_id=child_one.id,
                body_markdown="bad anchor",
            ),
        )
    assert invalid_anchor.value.code == ApiErrorCode.E_INVALID_REQUEST

    with pytest.raises(ApiError) as invalid_move:
        notes.move_note_block(
            db_session,
            bootstrapped_user,
            parent.id,
            MoveNoteBlockRequest(parent_block_id=child_two.id),
        )
    assert invalid_move.value.code == ApiErrorCode.E_INVALID_REQUEST

    notes.delete_note_block(
        db_session,
        bootstrapped_user,
        parent.id,
    )

    with pytest.raises(NotFoundError):
        notes.get_note_block(db_session, bootstrapped_user, child_two.id)
    remaining_links = object_links.list_object_links(
        db_session,
        bootstrapped_user,
        object_ref=ObjectRef(object_type="page", object_id=page.id),
    )
    assert remaining_links == [], "Deleting a parent block should clean descendant object links"


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
    first = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(page_id=page.id, body_markdown="first"),
    )
    second = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(page_id=page.id, after_block_id=first.id, body_markdown="second"),
    )
    child = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(page_id=page.id, parent_block_id=first.id, body_markdown="child"),
    )
    created_id = uuid4()

    result = notes.patch_page_document(
        db_session,
        bootstrapped_user,
        page.id,
        PatchPageDocumentRequest(
            client_mutation_id="mutation-1",
            blocks=[
                {
                    "id": first.id,
                    "parent_block_id": None,
                    "before_block_id": None,
                    "after_block_id": None,
                    "block_kind": "bullet",
                    "body_pm_json": {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": "first edited"}],
                    },
                    "collapsed": False,
                },
                {
                    "id": created_id,
                    "parent_block_id": first.id,
                    "before_block_id": None,
                    "after_block_id": None,
                    "block_kind": "bullet",
                    "body_pm_json": {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": "new child"}],
                    },
                    "collapsed": False,
                },
                {
                    "id": child.id,
                    "parent_block_id": None,
                    "before_block_id": None,
                    "after_block_id": first.id,
                    "block_kind": "bullet",
                    "body_pm_json": {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": "child"}],
                    },
                    "collapsed": False,
                },
            ],
            deleted_blocks=[second.id],
        ),
    )

    assert result.client_mutation_id == "mutation-1"
    assert [block.id for block in result.page.blocks] == [first.id, child.id]
    assert result.page.blocks[0].body_text == "first edited"
    assert [block.id for block in result.page.blocks[0].children] == [created_id]
    assert result.page.blocks[0].children[0].body_text == "new child"
    assert result.page.blocks[1].parent_block_id is None
    assert db_session.get(NoteBlock, second.id) is None


@pytest.mark.integration
def test_patch_page_document_overwrites_current_block_without_compare_tokens(
    db_session,
    bootstrapped_user,
):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Stale document {uuid4()}"),
    )
    block = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(page_id=page.id, body_markdown="original"),
    )

    notes.update_note_block(
        db_session,
        bootstrapped_user,
        block.id,
        UpdateNoteBlockRequest(
            body_pm_json={"type": "paragraph", "content": [{"type": "text", "text": "remote"}]},
        ),
    )

    result = notes.patch_page_document(
        db_session,
        bootstrapped_user,
        page.id,
        PatchPageDocumentRequest(
            client_mutation_id="mutation-current",
            blocks=[
                {
                    "id": block.id,
                    "parent_block_id": None,
                    "before_block_id": None,
                    "after_block_id": None,
                    "block_kind": "bullet",
                    "body_pm_json": {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": "local"}],
                    },
                    "collapsed": False,
                }
            ],
        ),
    )

    assert result.page.blocks[0].body_text == "local"
    assert db_session.get(NoteBlock, block.id).body_text == "local"


def test_patch_page_document_rejects_legacy_revision_tokens():
    block_id = uuid4()
    with pytest.raises(ValidationError):
        PatchPageDocumentRequest.model_validate(
            {
                "client_mutation_id": "mutation-legacy",
                "base_page_revision": 12,
                "blocks": [],
                "deleted_blocks": [],
            }
        )
    with pytest.raises(ValidationError):
        PatchPageDocumentRequest.model_validate(
            {
                "client_mutation_id": "mutation-legacy",
                "blocks": [
                    {
                        "id": str(block_id),
                        "parent_block_id": None,
                        "before_block_id": None,
                        "after_block_id": None,
                        "block_kind": "bullet",
                        "body_pm_json": {"type": "paragraph"},
                        "collapsed": False,
                        "base_revision": 4,
                    }
                ],
                "deleted_blocks": [],
            }
        )
    with pytest.raises(ValidationError):
        PatchPageDocumentRequest.model_validate(
            {
                "client_mutation_id": "mutation-legacy",
                "blocks": [],
                "deleted_blocks": [{"id": str(block_id), "base_revision": 4}],
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
    first = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(page_id=page.id, body_markdown="first"),
    )
    second = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(page_id=page.id, after_block_id=first.id, body_markdown="second"),
    )

    notes.patch_page_document(
        db_session,
        bootstrapped_user,
        page.id,
        PatchPageDocumentRequest(
            client_mutation_id="mutation-first",
            blocks=[
                {
                    "id": first.id,
                    "parent_block_id": None,
                    "before_block_id": None,
                    "after_block_id": None,
                    "block_kind": "bullet",
                    "body_pm_json": {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": "first local"}],
                    },
                    "collapsed": False,
                }
            ],
        ),
    )
    result = notes.patch_page_document(
        db_session,
        bootstrapped_user,
        page.id,
        PatchPageDocumentRequest(
            client_mutation_id="mutation-second",
            blocks=[
                {
                    "id": second.id,
                    "parent_block_id": None,
                    "before_block_id": None,
                    "after_block_id": first.id,
                    "block_kind": "bullet",
                    "body_pm_json": {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": "second local"}],
                    },
                    "collapsed": False,
                }
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
    block = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(page_id=page.id, body_markdown="Evergreen planning block"),
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

    block = notes.quick_capture_to_daily(
        db_session,
        bootstrapped_user,
        local_date=local_date,
        request=QuickCaptureRequest(body_markdown="Daily capture projection needle"),
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
def test_pinned_object_refs_hydrate_and_order_navigation_items(db_session, bootstrapped_user):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Pinned page {uuid4()}"),
    )
    block = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(page_id=page.id, body_markdown="Pinned block"),
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
    block = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(page_id=page.id, body_markdown="Pinned child block"),
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

    notes.delete_page(db_session, bootstrapped_user, page.id)

    assert db_session.get(PinnedObjectRef, page_pin.id) is None
    assert db_session.get(PinnedObjectRef, block_pin.id) is None
    assert object_refs.list_pinned_object_refs(db_session, bootstrapped_user) == []


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
def test_delete_note_block_api_rejects_legacy_revision_body(
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
        json={"title": f"Delete body page {uuid4()}"},
    )
    assert page_response.status_code == 201, page_response.text
    block_response = auth_client.post(
        "/notes/blocks",
        headers=headers,
        json={
            "page_id": page_response.json()["data"]["id"],
            "body_markdown": "delete me",
        },
    )
    assert block_response.status_code == 201, block_response.text

    delete_response = auth_client.request(
        "DELETE",
        f"/notes/blocks/{block_response.json()['data']['id']}",
        headers=headers,
        json={"base_revision": 1},
    )

    assert delete_response.status_code == 422, delete_response.text


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
def test_shared_reader_can_create_own_note_about_visible_highlight(db_session):
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

    block = notes.create_note_block(
        db_session,
        reader_id,
        CreateNoteBlockRequest(
            body_markdown="Reader-owned note",
            linked_object=LinkedObjectRequest(
                object_type="highlight",
                object_id=highlight_id,
                relation_type="note_about",
            ),
        ),
    )

    assert block.body_text == "Reader-owned note"
    links = object_links.list_object_links(
        db_session,
        reader_id,
        object_ref=ObjectRef(object_type="highlight", object_id=highlight_id),
        relation_type="note_about",
    )
    assert [(link.a.object_type, link.a.object_id, link.b.object_id) for link in links] == [
        ("note_block", block.id, highlight_id)
    ]


@pytest.mark.integration
def test_object_links_reject_duplicate_non_located_links(db_session, bootstrapped_user):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Duplicate links {uuid4()}"),
    )
    block = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(page_id=page.id, body_markdown="linked block"),
    )
    request = object_links.CreateObjectLinkInput(
        relation_type="related",
        a=ObjectRef(object_type="page", object_id=page.id),
        b=ObjectRef(object_type="note_block", object_id=block.id),
    )

    object_links.create_object_link(db_session, bootstrapped_user, request)
    with pytest.raises(ApiError) as duplicate:
        object_links.create_object_link(db_session, bootstrapped_user, request)

    assert duplicate.value.code == ApiErrorCode.E_INVALID_REQUEST
    reverse = object_links.CreateObjectLinkInput(
        relation_type="related",
        a=ObjectRef(object_type="note_block", object_id=block.id),
        b=ObjectRef(object_type="page", object_id=page.id),
    )
    with pytest.raises(ApiError) as reverse_duplicate:
        object_links.create_object_link(db_session, bootstrapped_user, reverse)

    assert reverse_duplicate.value.code == ApiErrorCode.E_INVALID_REQUEST

    located = object_links.CreateObjectLinkInput(
        relation_type="related",
        a=ObjectRef(object_type="page", object_id=page.id),
        b=ObjectRef(object_type="note_block", object_id=block.id),
        a_locator={"section": "intro"},
        b_locator={"offset": 12},
    )
    first_located = object_links.create_object_link(db_session, bootstrapped_user, located)
    second_located = object_links.create_object_link(db_session, bootstrapped_user, located)
    assert first_located.id != second_located.id, "Located links may repeat for distinct anchors"
    assert first_located.a_locator == {"section": "intro"}
    assert first_located.b_locator == {"offset": 12}

    references = object_links.create_object_link(
        db_session,
        bootstrapped_user,
        object_links.CreateObjectLinkInput(
            relation_type="references",
            a=ObjectRef(object_type="page", object_id=page.id),
            b=ObjectRef(object_type="note_block", object_id=block.id),
        ),
    )
    with pytest.raises(ApiError) as update_duplicate:
        object_links.update_object_link(
            db_session,
            bootstrapped_user,
            references.id,
            object_links.UpdateObjectLinkPatch(relation_type="related"),
        )

    assert update_duplicate.value.code == ApiErrorCode.E_INVALID_REQUEST
    stored_relation = db_session.scalar(
        select(ObjectLink.relation_type).where(ObjectLink.id == references.id)
    )
    assert stored_relation == "references"


@pytest.mark.integration
def test_object_link_reads_use_endpoint_order(db_session, bootstrapped_user):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Endpoint order links {uuid4()}"),
    )
    first = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(page_id=page.id, body_markdown="first"),
    )
    second = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(page_id=page.id, body_markdown="second"),
    )
    db_session.add_all(
        [
            ObjectLink(
                user_id=bootstrapped_user,
                relation_type="related",
                a_type="page",
                a_id=page.id,
                b_type="note_block",
                b_id=first.id,
                a_order_key="0000000002",
                metadata_json={},
            ),
            ObjectLink(
                user_id=bootstrapped_user,
                relation_type="related",
                a_type="page",
                a_id=page.id,
                b_type="note_block",
                b_id=second.id,
                a_order_key="0000000001",
                metadata_json={},
            ),
        ]
    )
    db_session.commit()

    links = object_links.list_object_links(
        db_session,
        bootstrapped_user,
        a_ref=ObjectRef(object_type="page", object_id=page.id),
        relation_type="related",
    )
    backlink_links = object_links.list_object_links(
        db_session,
        bootstrapped_user,
        object_ref=ObjectRef(object_type="page", object_id=page.id),
        relation_type="related",
    )

    assert [link.b.object_id for link in links] == [second.id, first.id]
    assert [link.b.object_id for link in backlink_links] == [second.id, first.id]


@pytest.mark.integration
def test_inline_reference_sync_skips_reverse_duplicate_link(db_session, bootstrapped_user):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Reverse inline refs {uuid4()}"),
    )
    target = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Reverse inline target {uuid4()}"),
    )
    block = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(page_id=page.id, body_markdown="plain"),
    )
    db_session.add(
        ObjectLink(
            user_id=bootstrapped_user,
            relation_type="references",
            a_type="page",
            a_id=target.id,
            b_type="note_block",
            b_id=block.id,
            metadata_json={},
        )
    )
    db_session.commit()

    notes.update_note_block(
        db_session,
        bootstrapped_user,
        block.id,
        UpdateNoteBlockRequest(
            body_pm_json=_paragraph_with_page_ref(target.id, "Target"),
        ),
    )

    links = object_links.list_object_links(
        db_session,
        bootstrapped_user,
        object_ref=ObjectRef(object_type="note_block", object_id=block.id),
        relation_type="references",
    )
    assert [(link.a.object_id, link.b.object_id) for link in links] == [(target.id, block.id)]


@pytest.mark.integration
def test_linked_note_blocks_for_highlights_reads_both_link_orientations(
    db_session,
    bootstrapped_user,
):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Reverse highlight notes {uuid4()}"),
    )
    first = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(page_id=page.id, body_markdown="first note"),
    )
    second = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(page_id=page.id, body_markdown="second note"),
    )
    highlight_id = uuid4()
    db_session.add_all(
        [
            ObjectLink(
                user_id=bootstrapped_user,
                relation_type="note_about",
                a_type="highlight",
                a_id=highlight_id,
                b_type="note_block",
                b_id=second.id,
                a_order_key="0000000002",
                metadata_json={},
            ),
            ObjectLink(
                user_id=bootstrapped_user,
                relation_type="note_about",
                a_type="note_block",
                a_id=first.id,
                b_type="highlight",
                b_id=highlight_id,
                b_order_key="0000000001",
                metadata_json={},
            ),
        ]
    )
    db_session.commit()

    linked = notes.linked_note_blocks_for_highlights(db_session, bootstrapped_user, [highlight_id])

    assert [block.id for block in linked[highlight_id]] == [first.id, second.id]


@pytest.mark.integration
def test_split_note_block_preserves_rich_pm_json(db_session, bootstrapped_user):
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
    block = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(
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

    new_block = notes.split_note_block(
        db_session,
        bootstrapped_user,
        block.id,
        SplitNoteBlockRequest(offset=len("Read docs")),
    )
    original = notes.get_note_block(db_session, bootstrapped_user, block.id)

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
    original_links = object_links.list_object_links(
        db_session,
        bootstrapped_user,
        a_ref=ObjectRef(object_type="note_block", object_id=block.id),
        relation_type="references",
    )
    new_links = object_links.list_object_links(
        db_session,
        bootstrapped_user,
        a_ref=ObjectRef(object_type="note_block", object_id=new_block.id),
        relation_type="references",
    )
    assert original_links == [], "Split should remove inline refs no longer present on original"
    assert [link.b.object_id for link in new_links] == [target_page.id]


@pytest.mark.integration
def test_merge_note_block_preserves_rich_pm_json(db_session, bootstrapped_user):
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
    first = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(
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
    second = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(
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

    merged = notes.merge_note_block(db_session, bootstrapped_user, second.id)

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
    links = object_links.list_object_links(
        db_session,
        bootstrapped_user,
        a_ref=ObjectRef(object_type="note_block", object_id=first.id),
        relation_type="references",
    )
    assert [link.b.object_id for link in links] == [target_page.id]


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
    block = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(
            page_id=page.id,
            body_pm_json=_paragraph_with_page_ref(first_target.id, "First target"),
        ),
    )

    created_links = object_links.list_object_links(
        db_session,
        bootstrapped_user,
        a_ref=ObjectRef(object_type="note_block", object_id=block.id),
        relation_type="references",
    )
    assert [link.b.object_id for link in created_links] == [first_target.id]

    notes.update_note_block(
        db_session,
        bootstrapped_user,
        block.id,
        UpdateNoteBlockRequest(
            body_pm_json=_paragraph_with_page_ref(second_target.id, "Second target"),
        ),
    )
    updated_links = object_links.list_object_links(
        db_session,
        bootstrapped_user,
        a_ref=ObjectRef(object_type="note_block", object_id=block.id),
        relation_type="references",
    )
    assert [link.b.object_id for link in updated_links] == [second_target.id]


@pytest.mark.integration
def test_inline_reference_sync_preserves_duplicate_occurrences(db_session, bootstrapped_user):
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

    block = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(
            page_id=page.id,
            body_pm_json=_paragraph_with_duplicate_page_refs(target.id, "Repeated target"),
        ),
    )

    links = object_links.list_object_links(
        db_session,
        bootstrapped_user,
        a_ref=ObjectRef(object_type="note_block", object_id=block.id),
        relation_type="references",
    )

    assert [link.b.object_id for link in links] == [target.id, target.id]
    assert [link.a_locator for link in links] == [
        {
            "kind": "note_inline_object_ref",
            "path": [0],
            "occurrence": 0,
            "target_occurrence": 0,
        },
        {
            "kind": "note_inline_object_ref",
            "path": [2],
            "occurrence": 1,
            "target_occurrence": 1,
        },
    ]
    assert [link.b_locator for link in links] == [None, None]


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

    block = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(
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

    link = db_session.scalar(
        select(ObjectLink).where(
            ObjectLink.relation_type == "embeds",
            ObjectLink.a_type == "note_block",
            ObjectLink.a_id == block.id,
            ObjectLink.b_type == "page",
            ObjectLink.b_id == target.id,
        )
    )

    assert block.body_text == "Embedded target"
    assert block.body_markdown == f"![[page:{target.id}|Embedded target]]"
    assert link is not None
    assert link.a_locator_json == {
        "kind": "note_object_embed",
        "path": [],
        "occurrence": 0,
        "target_occurrence": 0,
    }


@pytest.mark.integration
def test_notes_and_object_link_validation_through_api(auth_client, direct_db: DirectSessionManager):
    user_id = create_test_user_id()
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("libraries", "owner_user_id", user_id)
    direct_db.register_cleanup("memberships", "user_id", user_id)
    direct_db.register_cleanup("pages", "user_id", user_id)
    direct_db.register_cleanup("note_blocks", "user_id", user_id)
    direct_db.register_cleanup("object_links", "user_id", user_id)

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

    parent_response = auth_client.post(
        "/notes/blocks",
        headers=headers,
        json={"page_id": page_id, "body_markdown": "parent"},
    )
    assert parent_response.status_code == 201, parent_response.text
    parent_id = parent_response.json()["data"]["id"]

    child_response = auth_client.post(
        "/notes/blocks",
        headers=headers,
        json={"page_id": page_id, "parent_block_id": parent_id, "body_markdown": "child"},
    )
    assert child_response.status_code == 201, child_response.text
    child_id = child_response.json()["data"]["id"]

    invalid_pm_json = auth_client.post(
        "/notes/blocks",
        headers=headers,
        json={"page_id": page_id, "body_pm_json": {"content": [{"text": "missing type"}]}},
    )
    assert invalid_pm_json.status_code == 400, invalid_pm_json.text
    assert invalid_pm_json.json()["error"]["code"] == ApiErrorCode.E_INVALID_REQUEST.value

    invalid_move = auth_client.post(
        f"/notes/blocks/{parent_id}/move",
        headers=headers,
        json={"parent_block_id": child_id},
    )
    assert invalid_move.status_code == 400, invalid_move.text
    assert invalid_move.json()["error"]["code"] == ApiErrorCode.E_INVALID_REQUEST.value

    first_link = auth_client.post(
        "/object-links",
        headers=headers,
        json={
            "relation_type": "related",
            "a_type": "page",
            "a_id": page_id,
            "b_type": "note_block",
            "b_id": child_id,
        },
    )
    assert first_link.status_code == 201, first_link.text

    duplicate_link = auth_client.post(
        "/object-links",
        headers=headers,
        json={
            "relation_type": "related",
            "a_type": "page",
            "a_id": page_id,
            "b_type": "note_block",
            "b_id": child_id,
        },
    )
    assert duplicate_link.status_code == 400, duplicate_link.text
    assert duplicate_link.json()["error"]["code"] == ApiErrorCode.E_INVALID_REQUEST.value

    invalid_object_ref_type = auth_client.get(
        f"/object-refs/resolve?ref=invalid_type:{page_id}",
        headers=headers,
    )
    assert invalid_object_ref_type.status_code == 400, invalid_object_ref_type.text
    assert invalid_object_ref_type.json()["error"]["code"] == ApiErrorCode.E_INVALID_REQUEST.value

    invalid_object_link_type = auth_client.get(
        f"/object-links?object_type=invalid_type&object_id={page_id}",
        headers=headers,
    )
    assert invalid_object_link_type.status_code == 400, invalid_object_link_type.text
    assert invalid_object_link_type.json()["error"]["code"] == ApiErrorCode.E_INVALID_REQUEST.value


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
    notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(
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
    doomed = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(
            page_id=page.id,
            body_markdown="Doomed block needle that will be deleted and reindexed away",
        ),
    )
    survivor = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(
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
    notes.delete_note_block(db_session, bootstrapped_user, doomed.id)
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
    block = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(page_id=page.id, body_markdown="first body"),
    )
    db_session.commit()

    # First edit: enqueue_page_reindex runs and leaves exactly one in-flight job.
    notes.update_note_block(
        db_session,
        bootstrapped_user,
        block.id,
        UpdateNoteBlockRequest(
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
    notes.update_note_block(
        db_session,
        bootstrapped_user,
        block.id,
        UpdateNoteBlockRequest(
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
    notes.update_note_block(
        db_session,
        bootstrapped_user,
        block.id,
        UpdateNoteBlockRequest(
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
