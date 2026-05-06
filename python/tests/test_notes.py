from datetime import date
from uuid import uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import select, text

from nexus.db.models import (
    Conversation,
    DailyNotePage,
    MessageContextItem,
    NoteBlock,
    ObjectLink,
    ObjectSearchDocument,
    Page,
    PinnedObjectRef,
)
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.notes import (
    CreateNoteBlockRequest,
    CreateObjectLinkRequest,
    CreatePageRequest,
    CreatePinnedObjectRefRequest,
    LinkedObjectRequest,
    MoveNoteBlockRequest,
    ObjectRef,
    QuickCaptureRequest,
    SplitNoteBlockRequest,
    UpdateNoteBlockRequest,
    UpdateObjectLinkRequest,
    UpdatePageRequest,
)
from nexus.services import notes, object_links, object_refs, vault
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.contributor_credits import replace_media_contributor_credits
from nexus.services.notes import markdown_from_pm_json, text_from_pm_json
from tests.factories import (
    add_library_member,
    add_media_to_library,
    create_searchable_media,
    create_test_conversation_with_message,
    create_test_fragment,
    create_test_highlight,
    create_test_library,
    create_test_media,
    create_test_media_in_library,
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


def _exported_vault_page_file(db_session, user_id, page_id):
    page_handle = f"page_{page_id.hex}"
    return next(
        file
        for file in vault.export_vault_files(db_session, user_id)
        if file["path"].startswith("Pages/") and file["path"].endswith(f"--{page_handle}.md")
    )


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
            }
        )


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

    notes.delete_note_block(db_session, bootstrapped_user, parent.id)

    with pytest.raises(NotFoundError):
        notes.get_note_block(db_session, bootstrapped_user, child_two.id)
    remaining_links = object_links.list_object_links(
        db_session,
        bootstrapped_user,
        object_ref=ObjectRef(object_type="page", object_id=page.id),
    )
    assert remaining_links == [], "Deleting a parent block should clean descendant object links"


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
    assert ("highlight", highlight_id) in ref_keys
    assert ("conversation", conversation_id) in ref_keys
    assert ("message", message_id) in ref_keys
    assert ("page", other_page.id) not in ref_keys


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
def test_quick_capture_appends_to_daily_page_and_projects_search_docs(
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
    docs = db_session.scalars(
        select(ObjectSearchDocument).where(
            ObjectSearchDocument.user_id == bootstrapped_user,
            ObjectSearchDocument.object_type.in_(["page", "note_block"]),
        )
    ).all()

    assert block.page_id == daily.page.id
    assert [item.body_text for item in daily.page.blocks] == ["Daily capture projection needle"]
    doc_keys = {(doc.object_type, doc.object_id) for doc in docs}
    assert ("page", daily.page.id) in doc_keys
    assert ("note_block", block.id) in doc_keys


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
        CreatePinnedObjectRefRequest(object_type="page", object_id=page.id, order_key="0000000002"),
    )
    block_pin = object_refs.pin_object_ref(
        db_session,
        bootstrapped_user,
        CreatePinnedObjectRefRequest(
            object_type="note_block",
            object_id=block.id,
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
        CreatePinnedObjectRefRequest(object_type="page", object_id=page.id),
    )
    block_pin = object_refs.pin_object_ref(
        db_session,
        bootstrapped_user,
        CreatePinnedObjectRefRequest(object_type="note_block", object_id=block.id),
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
            WHERE media_id = :media_id
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
    request = CreateObjectLinkRequest(
        relation_type="related",
        a_type="page",
        a_id=page.id,
        b_type="note_block",
        b_id=block.id,
    )

    object_links.create_object_link(db_session, bootstrapped_user, request)
    with pytest.raises(ApiError) as duplicate:
        object_links.create_object_link(db_session, bootstrapped_user, request)

    assert duplicate.value.code == ApiErrorCode.E_INVALID_REQUEST
    reverse = CreateObjectLinkRequest(
        relation_type="related",
        a_type="note_block",
        a_id=block.id,
        b_type="page",
        b_id=page.id,
    )
    with pytest.raises(ApiError) as reverse_duplicate:
        object_links.create_object_link(db_session, bootstrapped_user, reverse)

    assert reverse_duplicate.value.code == ApiErrorCode.E_INVALID_REQUEST

    located = CreateObjectLinkRequest(
        relation_type="related",
        a_type="page",
        a_id=page.id,
        b_type="note_block",
        b_id=block.id,
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
        CreateObjectLinkRequest(
            relation_type="references",
            a_type="page",
            a_id=page.id,
            b_type="note_block",
            b_id=block.id,
        ),
    )
    with pytest.raises(ApiError) as update_duplicate:
        object_links.update_object_link(
            db_session,
            bootstrapped_user,
            references.id,
            UpdateObjectLinkRequest(relation_type="related"),
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
        UpdateNoteBlockRequest(body_pm_json=_paragraph_with_page_ref(target.id, "Target")),
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
            body_pm_json=_paragraph_with_page_ref(second_target.id, "Second target")
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
def test_split_note_block_copies_note_about_without_copying_context(db_session, bootstrapped_user):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Split relation semantics {uuid4()}"),
    )
    linked_page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Split note-about target {uuid4()}"),
    )
    block = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(
            page_id=page.id,
            body_markdown="Alpha beta",
            linked_object=LinkedObjectRequest(
                object_type="page",
                object_id=linked_page.id,
                relation_type="note_about",
            ),
        ),
    )
    _message_id, message_id = create_test_conversation_with_message(db_session, bootstrapped_user)
    context_item = MessageContextItem(
        message_id=message_id,
        user_id=bootstrapped_user,
        object_type="note_block",
        object_id=block.id,
        ordinal=0,
        context_snapshot_json={"label": "Original split source"},
    )
    db_session.add(context_item)
    db_session.commit()

    new_block = notes.split_note_block(
        db_session,
        bootstrapped_user,
        block.id,
        SplitNoteBlockRequest(offset=len("Alpha")),
    )

    source_note_about = object_links.list_object_links(
        db_session,
        bootstrapped_user,
        a_ref=ObjectRef(object_type="note_block", object_id=block.id),
        relation_type="note_about",
    )
    split_note_about = object_links.list_object_links(
        db_session,
        bootstrapped_user,
        a_ref=ObjectRef(object_type="note_block", object_id=new_block.id),
        relation_type="note_about",
    )
    context_items = db_session.scalars(
        select(MessageContextItem).where(MessageContextItem.id == context_item.id)
    ).all()

    assert [link.b.object_id for link in source_note_about] == [linked_page.id]
    assert [link.b.object_id for link in split_note_about] == [linked_page.id]
    assert [item.object_id for item in context_items] == [block.id]


@pytest.mark.integration
def test_merge_note_block_transfers_durable_links_and_context_rows(db_session, bootstrapped_user):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Merge durable links {uuid4()}"),
    )
    linked_page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Merge note-about target {uuid4()}"),
    )
    first = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(page_id=page.id, body_markdown="Alpha"),
    )
    second = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(page_id=page.id, after_block_id=first.id, body_markdown="Beta"),
    )
    _conversation_id, message_id = create_test_conversation_with_message(
        db_session, bootstrapped_user
    )
    context_item = MessageContextItem(
        message_id=message_id,
        user_id=bootstrapped_user,
        object_type="note_block",
        object_id=second.id,
        ordinal=0,
        context_snapshot_json={"label": "Merged source"},
    )
    db_session.add_all(
        [
            context_item,
            ObjectLink(
                user_id=bootstrapped_user,
                relation_type="used_as_context",
                a_type="message",
                a_id=message_id,
                b_type="note_block",
                b_id=second.id,
                a_order_key="0000000001",
                metadata_json={},
            ),
            ObjectLink(
                user_id=bootstrapped_user,
                relation_type="note_about",
                a_type="note_block",
                a_id=second.id,
                b_type="page",
                b_id=linked_page.id,
                metadata_json={},
            ),
        ]
    )
    db_session.commit()

    merged = notes.merge_note_block(db_session, bootstrapped_user, second.id)

    assert merged.id == first.id
    assert (
        db_session.scalar(
            select(MessageContextItem.object_id).where(MessageContextItem.id == context_item.id)
        )
        == first.id
    )
    refreshed_snapshot = db_session.scalar(
        select(MessageContextItem.context_snapshot_json).where(
            MessageContextItem.id == context_item.id
        )
    )
    assert refreshed_snapshot is not None
    assert refreshed_snapshot["objectType"] == "note_block"
    assert refreshed_snapshot["objectId"] == str(first.id)
    assert refreshed_snapshot["label"] == "Alpha"
    assert refreshed_snapshot["snippet"] == "Alpha\nBeta"
    remaining_source_links = db_session.scalars(
        select(ObjectLink).where(
            ((ObjectLink.a_type == "note_block") & (ObjectLink.a_id == second.id))
            | ((ObjectLink.b_type == "note_block") & (ObjectLink.b_id == second.id))
        )
    ).all()
    assert remaining_source_links == []
    transferred_note_about = object_links.list_object_links(
        db_session,
        bootstrapped_user,
        a_ref=ObjectRef(object_type="note_block", object_id=first.id),
        relation_type="note_about",
    )
    transferred_context = object_links.list_object_links(
        db_session,
        bootstrapped_user,
        b_ref=ObjectRef(object_type="note_block", object_id=first.id),
        relation_type="used_as_context",
    )
    assert [link.b.object_id for link in transferred_note_about] == [linked_page.id]
    assert [link.a.object_id for link in transferred_context] == [message_id]


@pytest.mark.integration
def test_vault_page_sync_updates_single_block_without_replacing_links(
    db_session,
    bootstrapped_user,
):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Vault stable block {uuid4()}"),
    )
    linked_page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Vault linked target {uuid4()}"),
    )
    block = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(page_id=page.id, body_markdown="Original body"),
    )
    _conversation_id, message_id = create_test_conversation_with_message(
        db_session, bootstrapped_user
    )
    context_item = MessageContextItem(
        message_id=message_id,
        user_id=bootstrapped_user,
        object_type="note_block",
        object_id=block.id,
        ordinal=0,
        context_snapshot_json={"label": "Original body"},
    )
    db_session.add_all(
        [
            context_item,
            ObjectLink(
                user_id=bootstrapped_user,
                relation_type="used_as_context",
                a_type="message",
                a_id=message_id,
                b_type="note_block",
                b_id=block.id,
                a_order_key="0000000001",
                metadata_json={},
            ),
            ObjectLink(
                user_id=bootstrapped_user,
                relation_type="related",
                a_type="note_block",
                a_id=block.id,
                b_type="page",
                b_id=linked_page.id,
                metadata_json={},
            ),
        ]
    )
    db_session.commit()
    page_file = _exported_vault_page_file(db_session, bootstrapped_user, page.id)

    result = vault.sync_vault_files(
        db_session,
        bootstrapped_user,
        [
            {
                "path": page_file["path"],
                "content": page_file["content"].replace(
                    "Original body",
                    f"Edited body [[page:{linked_page.id}|Linked target]]",
                ),
            }
        ],
    )

    assert result["conflicts"] == []
    db_session.expire_all()
    stored_block = db_session.get(NoteBlock, block.id)
    assert stored_block is not None
    assert stored_block.body_text == "Edited body Linked target"
    assert (
        db_session.scalar(
            select(MessageContextItem.object_id).where(MessageContextItem.id == context_item.id)
        )
        == block.id
    )
    assert db_session.scalar(
        select(ObjectLink.id).where(
            ObjectLink.relation_type == "related",
            ObjectLink.a_type == "note_block",
            ObjectLink.a_id == block.id,
            ObjectLink.b_type == "page",
            ObjectLink.b_id == linked_page.id,
        )
    )
    assert db_session.scalar(
        select(ObjectLink.id).where(
            ObjectLink.relation_type == "references",
            ObjectLink.a_type == "note_block",
            ObjectLink.a_id == block.id,
            ObjectLink.b_type == "page",
            ObjectLink.b_id == linked_page.id,
        )
    )


@pytest.mark.integration
def test_vault_page_sync_updates_multiple_marked_blocks_without_replacing_ids(
    db_session,
    bootstrapped_user,
):
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(title=f"Vault multi block {uuid4()}"),
    )
    first = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(page_id=page.id, body_markdown="First block"),
    )
    second = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(
            page_id=page.id,
            after_block_id=first.id,
            body_markdown="Second block",
        ),
    )
    child = notes.create_note_block(
        db_session,
        bootstrapped_user,
        CreateNoteBlockRequest(
            page_id=page.id,
            parent_block_id=first.id,
            body_markdown="Nested child block",
        ),
    )
    _conversation_id, message_id = create_test_conversation_with_message(
        db_session, bootstrapped_user
    )
    context_item = MessageContextItem(
        message_id=message_id,
        user_id=bootstrapped_user,
        object_type="note_block",
        object_id=second.id,
        ordinal=0,
        context_snapshot_json={"label": "Second block"},
    )
    db_session.add(context_item)
    db_session.commit()
    page_file = _exported_vault_page_file(db_session, bootstrapped_user, page.id)

    result = vault.sync_vault_files(
        db_session,
        bootstrapped_user,
        [
            {
                "path": page_file["path"],
                "content": page_file["content"]
                .replace("First block", "First block edited")
                .replace("Second block", "Second block edited")
                .replace("Nested child block", "Nested child block edited"),
            }
        ],
    )

    assert result["delete_paths"] == [page_file["path"]]
    assert result["conflicts"] == []
    blocks = list(
        db_session.scalars(
            select(NoteBlock)
            .where(NoteBlock.page_id == page.id)
            .order_by(NoteBlock.parent_block_id.asc().nullsfirst(), NoteBlock.order_key.asc())
        )
    )
    assert {(block.id, block.body_text) for block in blocks} == {
        (first.id, "First block edited"),
        (second.id, "Second block edited"),
        (child.id, "Nested child block edited"),
    }
    assert db_session.get(NoteBlock, child.id).parent_block_id == first.id
    assert (
        db_session.scalar(
            select(MessageContextItem.object_id).where(MessageContextItem.id == context_item.id)
        )
        == second.id
    )


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
