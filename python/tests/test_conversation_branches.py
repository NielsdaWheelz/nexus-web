"""Integration tests for conversation branch tree contracts."""

from uuid import uuid4

import pytest
from sqlalchemy import text

from nexus.db.models import (
    ChatRun,
    ConversationActivePath,
    ConversationBranch,
    Message,
)
from nexus.errors import ApiError, ApiErrorCode
from nexus.services.conversation_branches import load_leaf_message_path, load_message_path
from tests.factories import create_test_conversation, create_test_message, create_test_model
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
        model_id = create_test_model(session)
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
            model_id=model_id,
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
                    model_id=model_id,
                    reasoning="none",
                    key_mode="auto",
                    web_search={"mode": "off"},
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


def test_delete_branch_removes_subtree_and_dependent_rows(
    auth_client, direct_db: DirectSessionManager
):
    owner_id = create_test_user_id()
    other_viewer_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(owner_id))
    auth_client.get("/me", headers=auth_headers(other_viewer_id))
    with direct_db.session() as session:
        model_id = create_test_model(session)
        conversation_id = create_test_conversation(session, owner_id, sharing="public")
        root_user_id = create_test_message(session, conversation_id, 1, "user", "Root")
        root_assistant_id = create_test_message(
            session,
            conversation_id,
            2,
            "assistant",
            "Root answer",
            parent_message_id=root_user_id,
        )
        safe_user_id = create_test_message(
            session,
            conversation_id,
            3,
            "user",
            "Safe branch",
            parent_message_id=root_assistant_id,
        )
        safe_assistant_id = create_test_message(
            session,
            conversation_id,
            4,
            "assistant",
            "Safe answer",
            parent_message_id=safe_user_id,
        )
        delete_user_id = create_test_message(
            session,
            conversation_id,
            5,
            "user",
            "Delete branch",
            parent_message_id=root_assistant_id,
        )
        delete_assistant_id = create_test_message(
            session,
            conversation_id,
            6,
            "assistant",
            "Delete answer",
            parent_message_id=delete_user_id,
        )
        delete_child_user_id = create_test_message(
            session,
            conversation_id,
            7,
            "user",
            "Delete child branch",
            parent_message_id=delete_assistant_id,
        )
        delete_child_assistant_id = create_test_message(
            session,
            conversation_id,
            8,
            "assistant",
            "Delete child answer",
            parent_message_id=delete_child_user_id,
        )
        run_id = uuid4()
        event_id = uuid4()
        prompt_assembly_id = uuid4()
        tool_call_id = uuid4()
        retrieval_id = uuid4()
        summary_id = uuid4()
        claim_id = uuid4()
        claim_evidence_id = uuid4()
        context_item_id = uuid4()
        object_link_id = uuid4()
        session.add_all(
            [
                ConversationBranch(
                    id=safe_user_id,
                    conversation_id=conversation_id,
                    branch_user_message_id=safe_user_id,
                    title="Safe branch",
                ),
                ConversationBranch(
                    id=delete_user_id,
                    conversation_id=conversation_id,
                    branch_user_message_id=delete_user_id,
                    title="Delete branch",
                ),
                ConversationActivePath(
                    conversation_id=conversation_id,
                    viewer_user_id=owner_id,
                    active_leaf_message_id=safe_assistant_id,
                ),
                ConversationActivePath(
                    conversation_id=conversation_id,
                    viewer_user_id=other_viewer_id,
                    active_leaf_message_id=delete_child_assistant_id,
                ),
                ChatRun(
                    id=run_id,
                    owner_user_id=owner_id,
                    conversation_id=conversation_id,
                    user_message_id=delete_user_id,
                    assistant_message_id=delete_assistant_id,
                    idempotency_key="delete-cleanup-run",
                    payload_hash="delete-cleanup-run",
                    status="complete",
                    model_id=model_id,
                    reasoning="none",
                    key_mode="auto",
                    web_search={"mode": "off"},
                ),
            ]
        )
        session.flush()
        session.execute(
            text(
                """
                INSERT INTO chat_run_events (id, run_id, seq, event_type, payload)
                VALUES (:id, :run_id, 1, 'meta', '{}'::jsonb)
                """
            ),
            {"id": event_id, "run_id": run_id},
        )
        session.execute(
            text(
                """
                INSERT INTO chat_prompt_assemblies (
                    id,
                    chat_run_id,
                    conversation_id,
                    assistant_message_id,
                    model_id,
                    prompt_version,
                    prompt_plan_version,
                    assembler_version,
                    stable_prefix_hash,
                    cacheable_input_tokens_estimate,
                    prompt_block_manifest,
                    provider_request_hash,
                    max_context_tokens,
                    reserved_output_tokens,
                    reserved_reasoning_tokens,
                    input_budget_tokens,
                    estimated_input_tokens,
                    included_message_ids,
                    included_memory_item_ids,
                    included_retrieval_ids,
                    included_context_refs,
                    dropped_items,
                    budget_breakdown
                )
                VALUES (
                    :id,
                    :run_id,
                    :conversation_id,
                    :assistant_message_id,
                    :model_id,
                    'test',
                    'test',
                    'test',
                    'stable',
                    0,
                    '{}'::jsonb,
                    'provider',
                    4096,
                    128,
                    0,
                    3968,
                    100,
                    '[]'::jsonb,
                    '[]'::jsonb,
                    '[]'::jsonb,
                    '[]'::jsonb,
                    '[]'::jsonb,
                    '{}'::jsonb
                )
                """
            ),
            {
                "id": prompt_assembly_id,
                "run_id": run_id,
                "conversation_id": conversation_id,
                "assistant_message_id": delete_assistant_id,
                "model_id": model_id,
            },
        )
        session.execute(
            text(
                """
                INSERT INTO message_context_items (
                    id,
                    message_id,
                    user_id,
                    object_type,
                    object_id,
                    ordinal,
                    context_snapshot
                )
                VALUES (
                    :id,
                    :message_id,
                    :user_id,
                    'message',
                    :object_id,
                    0,
                    '{}'::jsonb
                )
                """
            ),
            {
                "id": context_item_id,
                "message_id": delete_user_id,
                "user_id": owner_id,
                "object_id": root_user_id,
            },
        )
        session.execute(
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
                    semantic,
                    status
                )
                VALUES (
                    :id,
                    :conversation_id,
                    :user_message_id,
                    :assistant_message_id,
                    'app_search',
                    0,
                    'all',
                    false,
                    'complete'
                )
                """
            ),
            {
                "id": tool_call_id,
                "conversation_id": conversation_id,
                "user_message_id": delete_user_id,
                "assistant_message_id": delete_assistant_id,
            },
        )
        session.execute(
            text(
                """
                INSERT INTO message_retrievals (
                    id,
                    tool_call_id,
                    ordinal,
                    result_type,
                    source_id,
                    scope,
                    context_ref,
                    result_ref,
                    selected,
                    retrieval_status
                )
                VALUES (
                    :id,
                    :tool_call_id,
                    0,
                    'message',
                    'source-message',
                    'all',
                    '{}'::jsonb,
                    '{}'::jsonb,
                    true,
                    'selected'
                )
                """
            ),
            {"id": retrieval_id, "tool_call_id": tool_call_id},
        )
        session.execute(
            text(
                """
                INSERT INTO message_llm (
                    message_id,
                    provider,
                    model_name,
                    key_mode_requested,
                    key_mode_used,
                    prompt_version
                )
                VALUES (
                    :message_id,
                    'openai',
                    'gpt-5.4-mini',
                    'auto',
                    'platform',
                    'test'
                )
                """
            ),
            {"message_id": delete_assistant_id},
        )
        session.execute(
            text(
                """
                INSERT INTO assistant_message_evidence_summaries (
                    id,
                    message_id,
                    scope_type,
                    retrieval_status,
                    support_status,
                    verifier_status,
                    claim_count,
                    supported_claim_count,
                    unsupported_claim_count,
                    not_enough_evidence_count,
                    prompt_assembly_id
                )
                VALUES (
                    :id,
                    :message_id,
                    'general',
                    'included_in_prompt',
                    'supported',
                    'verified',
                    1,
                    1,
                    0,
                    0,
                    :prompt_assembly_id
                )
                """
            ),
            {
                "id": summary_id,
                "message_id": delete_assistant_id,
                "prompt_assembly_id": prompt_assembly_id,
            },
        )
        session.execute(
            text(
                """
                INSERT INTO assistant_message_claims (
                    id,
                    message_id,
                    ordinal,
                    claim_text,
                    claim_kind,
                    support_status,
                    verifier_status
                )
                VALUES (
                    :id,
                    :message_id,
                    0,
                    'A claim',
                    'answer',
                    'supported',
                    'verified'
                )
                """
            ),
            {"id": claim_id, "message_id": delete_assistant_id},
        )
        session.execute(
            text(
                """
                INSERT INTO assistant_message_claim_evidence (
                    id,
                    claim_id,
                    ordinal,
                    evidence_role,
                    source_ref,
                    retrieval_id,
                    exact_snippet,
                    retrieval_status,
                    selected,
                    included_in_prompt
                )
                VALUES (
                    :id,
                    :claim_id,
                    0,
                    'supports',
                    '{}'::jsonb,
                    :retrieval_id,
                    'Evidence',
                    'included_in_prompt',
                    true,
                    true
                )
                """
            ),
            {
                "id": claim_evidence_id,
                "claim_id": claim_id,
                "retrieval_id": retrieval_id,
            },
        )
        session.execute(
            text(
                """
                INSERT INTO object_links (
                    id,
                    user_id,
                    relation_type,
                    a_type,
                    a_id,
                    b_type,
                    b_id
                )
                VALUES (
                    :id,
                    :user_id,
                    'references',
                    'message',
                    :message_id,
                    'conversation',
                    :conversation_id
                )
                """
            ),
            {
                "id": object_link_id,
                "user_id": owner_id,
                "message_id": delete_assistant_id,
                "conversation_id": conversation_id,
            },
        )
        session.commit()
    direct_db.register_cleanup("conversations", "id", conversation_id)

    response = auth_client.delete(
        f"/conversations/{conversation_id}/forks/{delete_user_id}",
        headers=auth_headers(owner_id),
    )

    assert response.status_code == 204, (
        f"Expected branch delete to succeed, got {response.status_code}: {response.text}"
    )

    owner_tree_response = auth_client.get(
        f"/conversations/{conversation_id}/tree",
        headers=auth_headers(owner_id),
    )
    other_tree_response = auth_client.get(
        f"/conversations/{conversation_id}/tree",
        headers=auth_headers(other_viewer_id),
    )

    assert owner_tree_response.status_code == 200, (
        f"Expected owner tree read to succeed, got {owner_tree_response.status_code}: "
        f"{owner_tree_response.text}"
    )
    assert other_tree_response.status_code == 200, (
        f"Expected other viewer tree read to succeed, got {other_tree_response.status_code}: "
        f"{other_tree_response.text}"
    )
    owner_tree = owner_tree_response.json()["data"]
    other_tree = other_tree_response.json()["data"]
    owner_message_ids = {message["id"] for message in owner_tree["selected_path"]}
    graph_message_ids = {node["message_id"] for node in owner_tree["branch_graph"]["nodes"]}
    assert str(safe_assistant_id) in owner_message_ids
    assert str(delete_user_id) not in graph_message_ids
    assert other_tree["active_leaf_message_id"] == str(root_assistant_id)
    assert [message["id"] for message in other_tree["selected_path"]] == [
        str(root_user_id),
        str(root_assistant_id),
    ]

    subtree_ids = [
        delete_user_id,
        delete_assistant_id,
        delete_child_user_id,
        delete_child_assistant_id,
    ]
    dependent_ids = {
        "run_id": run_id,
        "event_id": event_id,
        "prompt_assembly_id": prompt_assembly_id,
        "tool_call_id": tool_call_id,
        "retrieval_id": retrieval_id,
        "summary_id": summary_id,
        "claim_id": claim_id,
        "claim_evidence_id": claim_evidence_id,
        "context_item_id": context_item_id,
        "object_link_id": object_link_id,
    }
    with direct_db.session() as session:
        remaining = session.execute(
            text(
                """
                SELECT
                    (SELECT COUNT(*) FROM messages WHERE id = ANY(:subtree_ids)) AS messages,
                    (SELECT COUNT(*) FROM conversation_branches WHERE branch_user_message_id = ANY(:subtree_ids)) AS branches,
                    (SELECT COUNT(*) FROM chat_runs WHERE id = :run_id) AS runs,
                    (SELECT COUNT(*) FROM chat_run_events WHERE id = :event_id) AS events,
                    (SELECT COUNT(*) FROM chat_prompt_assemblies WHERE id = :prompt_assembly_id) AS prompt_assemblies,
                    (SELECT COUNT(*) FROM message_context_items WHERE id = :context_item_id) AS contexts,
                    (SELECT COUNT(*) FROM message_tool_calls WHERE id = :tool_call_id) AS tool_calls,
                    (SELECT COUNT(*) FROM message_retrievals WHERE id = :retrieval_id) AS retrievals,
                    (SELECT COUNT(*) FROM assistant_message_evidence_summaries WHERE id = :summary_id) AS summaries,
                    (SELECT COUNT(*) FROM assistant_message_claims WHERE id = :claim_id) AS claims,
                    (SELECT COUNT(*) FROM assistant_message_claim_evidence WHERE id = :claim_evidence_id) AS claim_evidence,
                    (SELECT COUNT(*) FROM message_llm WHERE message_id = :assistant_message_id) AS message_llm,
                    (SELECT COUNT(*) FROM object_links WHERE id = :object_link_id) AS object_links
                """
            ),
            {
                "subtree_ids": subtree_ids,
                "assistant_message_id": delete_assistant_id,
                **dependent_ids,
            },
        ).one()

    assert all(count == 0 for count in remaining), (
        f"Expected branch delete to remove subtree dependents, got {remaining}"
    )
