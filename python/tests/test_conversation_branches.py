"""Integration tests for conversation branch tree contracts."""

from uuid import uuid4

import pytest

from nexus.db.models import (
    ChatRun,
    ConversationActivePath,
    ConversationBranch,
    Message,
)
from nexus.errors import ApiError, ApiErrorCode
from nexus.services.conversation_branches import load_leaf_message_path, load_message_path
from tests.factories import create_test_conversation, create_test_message
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _assert_branch_path_invalid(callable_result) -> None:
    with pytest.raises(ApiError) as exc_info:
        callable_result()
    assert exc_info.value.code == ApiErrorCode.E_BRANCH_PATH_INVALID


def test_load_message_paths_reject_invalid_role_chains(db_session, bootstrapped_user):
    user_id = bootstrapped_user
    user_parent_user_conversation_id = create_test_conversation(db_session, user_id)
    root_user_id = create_test_message(
        db_session, user_parent_user_conversation_id, 1, "user", "Root"
    )
    bad_user_id = create_test_message(
        db_session,
        user_parent_user_conversation_id,
        2,
        "user",
        "Bad user child",
        parent_message_id=root_user_id,
    )

    assistant_parent_assistant_conversation_id = create_test_conversation(db_session, user_id)
    assistant_root_user_id = create_test_message(
        db_session, assistant_parent_assistant_conversation_id, 1, "user", "Root"
    )
    assistant_parent_id = create_test_message(
        db_session,
        assistant_parent_assistant_conversation_id,
        2,
        "assistant",
        "Parent assistant",
        parent_message_id=assistant_root_user_id,
    )
    bad_assistant_id = create_test_message(
        db_session,
        assistant_parent_assistant_conversation_id,
        3,
        "assistant",
        "Bad assistant child",
        parent_message_id=assistant_parent_id,
    )

    system_root_conversation_id = create_test_conversation(db_session, user_id)
    system_root_id = create_test_message(
        db_session, system_root_conversation_id, 1, "system", "System root"
    )
    assistant_after_system_id = create_test_message(
        db_session,
        system_root_conversation_id,
        2,
        "assistant",
        "Bad assistant child",
        parent_message_id=system_root_id,
    )

    cycle_conversation_id = create_test_conversation(db_session, user_id)
    cycle_user_id = create_test_message(db_session, cycle_conversation_id, 1, "user", "Root")
    cycle_assistant_id = create_test_message(
        db_session,
        cycle_conversation_id,
        2,
        "assistant",
        "Assistant",
        parent_message_id=cycle_user_id,
    )
    cycle_user = db_session.get(Message, cycle_user_id)
    assert cycle_user is not None
    cycle_user.parent_message_id = cycle_assistant_id
    db_session.commit()

    _assert_branch_path_invalid(
        lambda: load_message_path(
            db_session,
            conversation_id=user_parent_user_conversation_id,
            leaf_message_id=bad_user_id,
        )
    )
    _assert_branch_path_invalid(
        lambda: load_leaf_message_path(
            db_session,
            conversation_id=assistant_parent_assistant_conversation_id,
            leaf_message_id=bad_assistant_id,
        )
    )
    _assert_branch_path_invalid(
        lambda: load_message_path(
            db_session,
            conversation_id=system_root_conversation_id,
            leaf_message_id=assistant_after_system_id,
        )
    )
    _assert_branch_path_invalid(
        lambda: load_message_path(
            db_session,
            conversation_id=cycle_conversation_id,
            leaf_message_id=cycle_assistant_id,
        )
    )


def test_tree_response_includes_graph_path_cache_and_active_path_switch(
    auth_client, direct_db: DirectSessionManager
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    with direct_db.session() as session:
        conversation_id = create_test_conversation(session, user_id)
        root_user_id = create_test_message(session, conversation_id, 1, "user", "Root")
        root_assistant_id = create_test_message(
            session,
            conversation_id,
            2,
            "assistant",
            "Pick one direction.",
            parent_message_id=root_user_id,
        )
        first_user_id = create_test_message(
            session,
            conversation_id,
            3,
            "user",
            "Follow the first idea.",
            parent_message_id=root_assistant_id,
        )
        first_assistant_id = create_test_message(
            session,
            conversation_id,
            4,
            "assistant",
            "First answer.",
            parent_message_id=first_user_id,
        )
        quote_user_id = create_test_message(
            session,
            conversation_id,
            5,
            "user",
            "Branch from selected text.",
            parent_message_id=root_assistant_id,
        )
        quote_assistant_id = create_test_message(
            session,
            conversation_id,
            6,
            "assistant",
            "Quote branch answer.",
            parent_message_id=quote_user_id,
        )

        first_user = session.get(Message, first_user_id)
        quote_user = session.get(Message, quote_user_id)
        assert first_user is not None
        assert quote_user is not None
        first_user.branch_anchor_kind = "assistant_message"
        first_user.branch_anchor = {"message_id": str(root_assistant_id)}
        quote_user.branch_anchor_kind = "assistant_selection"
        quote_user.branch_anchor = {
            "message_id": str(root_assistant_id),
            "exact": "one direction",
            "prefix": "Pick ",
            "suffix": ".",
            "offset_status": "mapped",
            "start_offset": 5,
            "end_offset": 18,
            "client_selection_id": "test-selection",
        }
        session.add_all(
            [
                ConversationBranch(
                    id=first_user_id,
                    conversation_id=conversation_id,
                    branch_user_message_id=first_user_id,
                    title="First branch",
                ),
                ConversationBranch(
                    id=quote_user_id,
                    conversation_id=conversation_id,
                    branch_user_message_id=quote_user_id,
                    title="Quote branch",
                ),
                ConversationActivePath(
                    conversation_id=conversation_id,
                    viewer_user_id=user_id,
                    active_leaf_message_id=first_assistant_id,
                ),
            ]
        )
        session.commit()
    direct_db.register_cleanup("conversations", "id", conversation_id)

    response = auth_client.get(
        f"/conversations/{conversation_id}/tree",
        headers=auth_headers(user_id),
    )

    assert response.status_code == 200, (
        f"Expected tree response to succeed, got {response.status_code}: {response.text}"
    )
    data = response.json()["data"]
    assert [message["id"] for message in data["selected_path"]] == [
        str(root_user_id),
        str(root_assistant_id),
        str(first_user_id),
        str(first_assistant_id),
    ]
    fork_options = data["fork_options_by_parent_id"][str(root_assistant_id)]
    assert [fork["leaf_message_id"] for fork in fork_options] == [
        str(first_assistant_id),
        str(quote_assistant_id),
    ]
    assert data["path_cache_by_leaf_id"][str(first_assistant_id)][-1]["id"] == str(
        first_assistant_id
    )
    assert data["path_cache_by_leaf_id"][str(quote_assistant_id)][-1]["id"] == str(
        quote_assistant_id
    )
    assert {node["message_id"] for node in data["branch_graph"]["nodes"]} >= {
        str(root_assistant_id),
        str(first_assistant_id),
        str(quote_assistant_id),
    }
    assert {(edge["from"], edge["to"]) for edge in data["branch_graph"]["edges"]} >= {
        (str(root_assistant_id), str(first_user_id)),
        (str(root_assistant_id), str(quote_user_id)),
    }

    switch_response = auth_client.post(
        f"/conversations/{conversation_id}/active-path",
        headers=auth_headers(user_id),
        json={"active_leaf_message_id": str(quote_assistant_id)},
    )

    assert switch_response.status_code == 200, (
        f"Expected active path switch to succeed, got {switch_response.status_code}: "
        f"{switch_response.text}"
    )
    switched = switch_response.json()["data"]
    assert switched["active_leaf_message_id"] == str(quote_assistant_id)
    assert [message["id"] for message in switched["selected_path"]] == [
        str(root_user_id),
        str(root_assistant_id),
        str(quote_user_id),
        str(quote_assistant_id),
    ]

    non_leaf_switch = auth_client.post(
        f"/conversations/{conversation_id}/active-path",
        headers=auth_headers(user_id),
        json={"active_leaf_message_id": str(root_assistant_id)},
    )

    assert non_leaf_switch.status_code == 400, (
        f"Expected non-leaf active path to fail, got {non_leaf_switch.status_code}: "
        f"{non_leaf_switch.text}"
    )
    assert non_leaf_switch.json()["error"]["code"] == "E_BRANCH_PATH_INVALID"

    forks_response = auth_client.get(
        f"/conversations/{conversation_id}/forks",
        headers=auth_headers(user_id),
    )
    search_response = auth_client.get(
        f"/conversations/{conversation_id}/forks?search=selected",
        headers=auth_headers(user_id),
    )

    assert forks_response.status_code == 200, (
        f"Expected fork list to succeed, got {forks_response.status_code}: {forks_response.text}"
    )
    assert search_response.status_code == 200, (
        f"Expected fork search to succeed, got {search_response.status_code}: "
        f"{search_response.text}"
    )
    assert [fork["title"] for fork in forks_response.json()["data"]["forks"]] == [
        "First branch",
        "Quote branch",
    ]
    assert [fork["title"] for fork in search_response.json()["data"]["forks"]] == [
        "Quote branch",
    ]


def test_delete_branch_rejects_current_path_and_active_subtree_run(
    auth_client, direct_db: DirectSessionManager
):
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    with direct_db.session() as session:
        conversation_id = create_test_conversation(session, user_id)
        root_user_id = create_test_message(session, conversation_id, 1, "user", "Root")
        root_assistant_id = create_test_message(
            session,
            conversation_id,
            2,
            "assistant",
            "Root answer",
            parent_message_id=root_user_id,
        )
        active_user_id = create_test_message(
            session,
            conversation_id,
            3,
            "user",
            "Active branch",
            parent_message_id=root_assistant_id,
        )
        active_assistant_id = create_test_message(
            session,
            conversation_id,
            4,
            "assistant",
            "Active answer",
            parent_message_id=active_user_id,
        )
        running_user_id = create_test_message(
            session,
            conversation_id,
            5,
            "user",
            "Running branch",
            parent_message_id=root_assistant_id,
        )
        running_assistant_id = create_test_message(
            session,
            conversation_id,
            6,
            "assistant",
            "",
            status="pending",
            parent_message_id=running_user_id,
        )
        session.add_all(
            [
                ConversationBranch(
                    id=active_user_id,
                    conversation_id=conversation_id,
                    branch_user_message_id=active_user_id,
                    title="Active branch",
                ),
                ConversationBranch(
                    id=running_user_id,
                    conversation_id=conversation_id,
                    branch_user_message_id=running_user_id,
                    title="Running branch",
                ),
                ConversationActivePath(
                    conversation_id=conversation_id,
                    viewer_user_id=user_id,
                    active_leaf_message_id=active_assistant_id,
                ),
                ChatRun(
                    id=uuid4(),
                    owner_user_id=user_id,
                    conversation_id=conversation_id,
                    user_message_id=running_user_id,
                    assistant_message_id=running_assistant_id,
                    idempotency_key="active-subtree-run",
                    payload_hash="active-subtree-run",
                    status="running",
                ),
            ]
        )
        session.commit()
    direct_db.register_cleanup("conversations", "id", conversation_id)

    active_delete = auth_client.delete(
        f"/conversations/{conversation_id}/forks/{active_user_id}",
        headers=auth_headers(user_id),
    )

    assert active_delete.status_code == 409, (
        f"Expected active branch delete to conflict, got {active_delete.status_code}: "
        f"{active_delete.text}"
    )
    assert active_delete.json()["error"]["code"] == "E_BRANCH_DELETE_ACTIVE_PATH"

    running_delete = auth_client.delete(
        f"/conversations/{conversation_id}/forks/{running_user_id}",
        headers=auth_headers(user_id),
    )

    assert running_delete.status_code == 409, (
        f"Expected running branch delete to conflict, got {running_delete.status_code}: "
        f"{running_delete.text}"
    )
    assert running_delete.json()["error"]["code"] == "E_BRANCH_HAS_ACTIVE_RUN"
