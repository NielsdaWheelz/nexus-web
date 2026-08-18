"""Real-PostgreSQL proof for the Nexus tool-runtime hard cutover."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from llm_tools import MalformedJson, ParsedJson, canonical_json_bytes
from llm_tools.execution import raw_input_digest
from pydantic import JsonValue
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

_TARGET_REVISION = "0217"
_LEGACY_TO_CANONICAL = {
    "app_search": "nexus.search",
    "web_search": "web.search",
    "read_resource": "nexus.resource.read",
    "inspect_resource": "nexus.resource.inspect",
    "add_to_library": "nexus.library.add",
    "jot_note": "nexus.note.create",
    "create_highlight": "nexus.highlight.create",
    "mint_edge": "nexus.edge.create",
    "queue_add": "nexus.queue.add",
}


def _migration_config() -> Config:
    migration_root = Path(__file__).parents[3] / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    return config


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _sha256(value: object) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def _current_parsed_input_sha256(value: JsonValue) -> str:
    return raw_input_digest(ParsedJson(value))


def _legacy_sha256(value: object) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _historical_revision(*, kind: str, old_id: str) -> str:
    return _sha256(
        {
            "kind": kind,
            "revision": 1,
            "old_id": old_id,
            "canonical_id": _LEGACY_TO_CANONICAL[old_id],
        }
    )


def _current_tool_contract_revision(canonical_tool_id: str) -> str:
    from nexus.services.tool_runtime.declarations import CHAT_TOOL_DECLARATIONS

    revisions = [
        entry.spec.tool_contract_revision
        for entry in CHAT_TOOL_DECLARATIONS
        if str(entry.spec.id) == canonical_tool_id
    ]
    assert len(revisions) == 1
    return revisions[0]


def _test_binding_policy_revision() -> str:
    return _sha256({"kind": "migration-test-binding-policy", "revision": 1})


def _tool_request(
    *, provider_call_id: str, tool_name: str, tool_call_index: int, arguments: dict[str, object]
) -> dict[str, object]:
    return {
        "provider_call_id": provider_call_id,
        "tool_name": tool_name,
        "tool_call_index": tool_call_index,
        "arguments": arguments,
    }


def _canonical_tool_request(
    *,
    provider_call_id: str,
    canonical_tool_id: str,
    tool_call_index: int,
    arguments: dict[str, object],
) -> dict[str, object]:
    return {
        "provider_call_id": provider_call_id,
        "canonical_tool_id": canonical_tool_id,
        "tool_call_index": tool_call_index,
        "arguments": arguments,
    }


def _tool_result(
    *,
    tool_call_id: object,
    assistant_message_id: object,
    tool_name: str,
    tool_call_index: int,
    provider_call_id: str,
    scope: str,
    status: str,
    error_code: str | None,
) -> dict[str, object]:
    result_event = {
        "tool_call_id": str(tool_call_id),
        "assistant_message_id": str(assistant_message_id),
        "tool_name": tool_name,
        "tool_call_index": tool_call_index,
        "status": status,
        "scope": scope,
        "types": [],
        "filters": {},
        "error_code": error_code,
        "result_count": None,
        "selected_count": None,
        "latency_ms": None,
        "provider_request_ids": [],
        "results": [],
    }
    return {
        "tool_call_id": str(tool_call_id),
        "tool_name": tool_name,
        "tool_call_index": tool_call_index,
        "model_output": {
            "call_id": provider_call_id,
            "output": '{"retained":true}',
            "is_error": status == "error",
        },
        "next_citation_ordinal": 1,
        "result_event": result_event,
    }


def _completed_step_state(
    *, request_fingerprint: str, result: dict[str, object]
) -> dict[str, object]:
    return {
        "generation_id": str(uuid4()),
        "dispatch_phase": "Completed",
        "request_fingerprint": {"kind": "Present", "value": request_fingerprint},
        "terminal_result": {"kind": "Present", "value": _json(result)},
    }


def _insert_chat_run(
    connection: object,
    *,
    run_id: object,
    user_id: object,
    conversation_id: object,
    user_message_id: object,
    assistant_message_id: object,
    message_seq: int,
    status: str,
    idempotency_key: str,
) -> None:
    connection.execute(
        text(
            """
            INSERT INTO messages (
                id, conversation_id, seq, role, content, status, parent_message_id
            ) VALUES
                (:user_message_id, :conversation_id, :user_seq, 'user', 'Question',
                 'complete', NULL),
                (:assistant_message_id, :conversation_id, :assistant_seq, 'assistant',
                 'Answer', 'complete', :user_message_id)
            """
        ),
        {
            "user_message_id": user_message_id,
            "assistant_message_id": assistant_message_id,
            "conversation_id": conversation_id,
            "user_seq": message_seq,
            "assistant_seq": message_seq + 1,
        },
    )
    connection.execute(
        text(
            """
            INSERT INTO chat_runs (
                id, owner_user_id, conversation_id, user_message_id, assistant_message_id,
                idempotency_key, payload_hash, status, profile_id, reasoning_option_id
            ) VALUES (
                :id, :owner_user_id, :conversation_id, :user_message_id,
                :assistant_message_id, :idempotency_key, :payload_hash, :status,
                'balanced', 'medium'
            )
            """
        ),
        {
            "id": run_id,
            "owner_user_id": user_id,
            "conversation_id": conversation_id,
            "user_message_id": user_message_id,
            "assistant_message_id": assistant_message_id,
            "idempotency_key": idempotency_key,
            "payload_hash": _sha256({"run": str(run_id)}),
            "status": status,
        },
    )


def _insert_tool_call(
    connection: object,
    *,
    tool_call_id: object,
    conversation_id: object,
    user_message_id: object,
    assistant_message_id: object,
    tool_name: str,
    tool_call_index: int,
    scope: str,
    status: str,
    error_code: str | None,
    query_hash: str | None = None,
    result_refs: list[dict[str, object]] | None = None,
    reverted: bool = False,
) -> None:
    connection.execute(
        text(
            """
            INSERT INTO message_tool_calls (
                id, conversation_id, user_message_id, assistant_message_id,
                tool_name, tool_call_index, query_hash, scope, requested_types,
                result_refs, selected_context_refs, provider_request_ids, status,
                error_code, reverted_at
            ) VALUES (
                :id, :conversation_id, :user_message_id, :assistant_message_id,
                :tool_name, :tool_call_index, :query_hash, :scope, '[]'::jsonb,
                CAST(:result_refs AS jsonb), '[]'::jsonb, '[]'::jsonb, :status,
                :error_code,
                CASE WHEN :reverted THEN now() - interval '1 day' ELSE NULL END
            )
            """
        ),
        {
            "id": tool_call_id,
            "conversation_id": conversation_id,
            "user_message_id": user_message_id,
            "assistant_message_id": assistant_message_id,
            "tool_name": tool_name,
            "tool_call_index": tool_call_index,
            "query_hash": query_hash,
            "scope": scope,
            "result_refs": _json(result_refs or []),
            "status": status,
            "error_code": error_code,
            "reverted": reverted,
        },
    )


def _insert_event(
    connection: object,
    *,
    event_id: object,
    run_id: object,
    seq: int,
    event_type: str,
    payload: dict[str, object],
) -> None:
    connection.execute(
        text(
            """
            INSERT INTO chat_run_events (id, run_id, seq, event_type, payload)
            VALUES (:id, :run_id, :seq, :event_type, CAST(:payload AS jsonb))
            """
        ),
        {
            "id": event_id,
            "run_id": run_id,
            "seq": seq,
            "event_type": event_type,
            "payload": _json(payload),
        },
    )


def _tool_event_payload(
    *,
    tool_call_id: object,
    assistant_message_id: object,
    tool_name: str,
    tool_call_index: int,
    provider_call_id: str,
    input_value: dict[str, object] | None = None,
    result_scope: str | None = None,
    result_status: str | None = None,
    error_code: str | None = None,
) -> dict[str, object]:
    base = {
        "tool_call_id": str(tool_call_id),
        "assistant_message_id": str(assistant_message_id),
        "tool_name": tool_name,
        "tool_call_index": tool_call_index,
    }
    if input_value is not None:
        return {
            **base,
            "provider_tool_call_id": provider_call_id,
            "input": input_value,
            "provider_event_seq_start": 1,
            "provider_event_seq_end": 1,
        }
    if result_scope is not None and result_status is not None:
        return {
            **base,
            "status": result_status,
            "scope": result_scope,
            "types": [],
            "filters": {},
            "error_code": error_code,
            "result_count": None,
            "selected_count": None,
            "latency_ms": None,
            "provider_request_ids": [],
            "results": [],
        }
    return {
        **base,
        "provider_tool_call_id": provider_call_id,
        "provider_event_seq_start": 1,
        "provider_event_seq_end": 1,
    }


def _insert_retrieval(
    connection: object,
    *,
    retrieval_id: object,
    tool_call_id: object,
    ordinal: int,
    scope: str,
) -> None:
    connection.execute(
        text(
            """
            INSERT INTO message_retrievals (
                id, tool_call_id, ordinal, result_type, source_id, scope,
                context_ref, result_ref
            ) VALUES (
                :id, :tool_call_id, :ordinal, 'page', :source_id, :scope,
                CAST(:context_ref AS jsonb), CAST(:result_ref AS jsonb)
            )
            """
        ),
        {
            "id": retrieval_id,
            "tool_call_id": tool_call_id,
            "ordinal": ordinal,
            "source_id": f"migration-page-{retrieval_id}",
            "scope": scope,
            "context_ref": _json({"opaque": "preserve-context"}),
            "result_ref": _json({"opaque": "preserve-result"}),
        },
    )


def _insert_active_idea_build(
    connection: object,
    *,
    user_id: object,
    idea_id: object,
    artifact_id: object,
    build_id: object,
) -> None:
    connection.execute(
        text(
            """
            INSERT INTO artifact_idea_subjects (id, user_id, idea_key, display_title)
            VALUES (:id, :user_id, CAST(:idea_key AS jsonb), 'Migration-owned Idea')
            """
        ),
        {"id": idea_id, "user_id": user_id, "idea_key": _json({"idea": "migration"})},
    )
    connection.execute(
        text(
            """
            INSERT INTO artifacts (
                id, subject_scheme, subject_id, audience_scheme, audience_id
            ) VALUES (:id, 'idea', :subject_id, 'user', :audience_id)
            """
        ),
        {
            "id": artifact_id,
            "subject_id": idea_id,
            "audience_id": str(user_id),
        },
    )
    connection.execute(
        text(
            """
            INSERT INTO artifact_builds (
                id, artifact_id, requester_user_id, instruction, idempotency_key
            ) VALUES (:id, :artifact_id, :user_id, 'Research this Idea', 'migration-build')
            """
        ),
        {"id": build_id, "artifact_id": artifact_id, "user_id": user_id},
    )


def _migration_version(engine: object) -> str | None:
    with engine.connect() as connection:
        return connection.scalar(text("SELECT version_num FROM alembic_version"))


def _legacy_shape(engine: object) -> tuple[set[str], set[str]]:
    inspector = inspect(engine)
    return (
        {column["name"] for column in inspector.get_columns("chat_runs")},
        {column["name"] for column in inspector.get_columns("message_tool_calls")},
    )


def _assert_preflight_left_0216_untouched(
    engine: object,
    *,
    legacy_shape: tuple[set[str], set[str]],
    expected_chat_status: str,
    chat_run_id: object,
    artifact_build_id: object | None,
) -> None:
    assert _migration_version(engine) == "0216"
    assert _legacy_shape(engine) == legacy_shape
    with engine.connect() as connection:
        assert (
            connection.scalar(
                text("SELECT status FROM chat_runs WHERE id = :id"), {"id": chat_run_id}
            )
            == expected_chat_status
        )
        if artifact_build_id is not None:
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM artifact_builds WHERE id = :id"),
                    {"id": artifact_build_id},
                )
                == 1
            )


def _assert_payload_rewrite(
    *,
    original: dict[str, object],
    migrated: dict[str, object],
    canonical_tool_id: str | None,
    record_kind: str,
    effect: str | None,
    result_kind: str,
    provider_wire_name: str | None,
    activity_label: str,
) -> None:
    for key, value in original.items():
        if key != "tool_name":
            assert migrated.get(key) == value, f"migration changed retained event key {key!r}"
    assert "tool_name" not in migrated
    assert migrated["canonical_tool_id"] == canonical_tool_id
    assert migrated["record_kind"] == record_kind
    assert migrated["effect"] == effect
    assert migrated["result_kind"] == result_kind
    assert migrated["provider_wire_name"] == provider_wire_name
    assert migrated["activity_label"] == activity_label


def _insert_post_cutover_current_rows(
    connection: object,
    *,
    user_id: object,
    conversation_id: object,
    run_id: object,
    user_message_id: object,
    assistant_message_id: object,
    current_tool_call_id: object,
    malformed_tool_call_id: object,
) -> None:
    search_contract_revision = _current_tool_contract_revision("nexus.search")
    edge_contract_revision = _current_tool_contract_revision("nexus.edge.create")
    binding_policy_revision = _test_binding_policy_revision()
    _insert_chat_run(
        connection,
        run_id=run_id,
        user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        message_seq=5,
        status="complete",
        idempotency_key="post-cutover-current-row",
    )
    connection.execute(
        text(
            """
            UPDATE chat_runs
            SET tool_profile_id = 'chat',
                tool_profile_revision = 'migration-test-profile-revision',
                tool_profile_snapshot = CAST(:snapshot AS jsonb)
            WHERE id = :id
            """
        ),
        {
            "id": run_id,
            "snapshot": _json(
                {
                    "profile_id": "chat",
                    "profile_revision": "migration-test-profile-revision",
                    "plan": {"exposure": "Native"},
                }
            ),
        },
    )
    current_input = {"query": "a current canonical search"}
    connection.execute(
        text(
            """
            INSERT INTO message_tool_calls (
                id, conversation_id, user_message_id, assistant_message_id,
                canonical_tool_id, record_kind, provider_wire_name,
                canonical_input_sha256, tool_contract_revision,
                binding_policy_revision, scope, requested_types, result_refs,
                selected_context_refs, provider_request_ids, tool_call_index, status,
                error_code
            ) VALUES (
                :id, :conversation_id, :user_message_id, :assistant_message_id,
                'nexus.search', 'current_execution', NULL, :input_sha,
                :tool_contract_revision, :binding_policy_revision,
                'all', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
                1, 'complete', NULL
            )
            """
        ),
        {
            "id": current_tool_call_id,
            "conversation_id": conversation_id,
            "user_message_id": user_message_id,
            "assistant_message_id": assistant_message_id,
            "input_sha": _current_parsed_input_sha256(current_input),
            "tool_contract_revision": search_contract_revision,
            "binding_policy_revision": binding_policy_revision,
        },
    )
    # The database deliberately accepts only primitive storage shape. Every
    # public reader must reject this malformed current variant before it can
    # participate in replay, response, trust, or Undo.
    connection.execute(
        text(
            """
            INSERT INTO message_tool_calls (
                id, conversation_id, user_message_id, assistant_message_id,
                canonical_tool_id, record_kind, provider_wire_name,
                canonical_input_sha256, tool_contract_revision,
                binding_policy_revision, scope, requested_types, result_refs,
                selected_context_refs, provider_request_ids, tool_call_index, status,
                error_code
            ) VALUES (
                :id, :conversation_id, :user_message_id, :assistant_message_id,
                'nexus.edge.create', 'current_execution', NULL, 'not-a-sha256',
                :tool_contract_revision, :binding_policy_revision,
                'assistant_write', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
                2, 'complete', NULL
            )
            """
        ),
        {
            "id": malformed_tool_call_id,
            "conversation_id": conversation_id,
            "user_message_id": user_message_id,
            "assistant_message_id": assistant_message_id,
            "tool_contract_revision": edge_contract_revision,
            "binding_policy_revision": binding_policy_revision,
        },
    )


def test_cutover_rewrites_only_closed_historical_variants_and_refuses_live_or_malformed_state(
    empty_migration_database_url: str,
) -> None:
    """Refuse all live/ambiguous old state before the one-way 0217 rewrite."""
    migration_file = (
        Path(__file__).parents[3] / "migrations/alembic/versions/0217_llm_tools_cutover.py"
    )
    assert migration_file.is_file(), "the Nexus tool-runtime 0217 migration is missing"

    config = _migration_config()
    scripts = ScriptDirectory.from_config(config)
    assert scripts.get_heads() == [_TARGET_REVISION], "the cutover must leave one 0217 head"

    command.upgrade(config, "0216")
    engine = create_engine(empty_migration_database_url)

    user_id = uuid4()
    conversation_id = uuid4()
    live_run_id = uuid4()
    live_user_message_id = uuid4()
    live_assistant_message_id = uuid4()
    historical_run_id = uuid4()
    historical_user_message_id = uuid4()
    historical_assistant_message_id = uuid4()
    idea_id = uuid4()
    artifact_id = uuid4()
    active_build_id = uuid4()

    attached_call_id = uuid4()
    pre_0167_call_id = uuid4()
    unique_input_call_id = uuid4()
    rejected_provider_call_id = uuid4()
    edge_call_id = uuid4()
    edge_result_id = uuid4()
    other_historical_call_ids = {
        old_id: uuid4()
        for old_id in _LEGACY_TO_CANONICAL
        if old_id not in {"app_search", "read_resource", "mint_edge"}
    }
    malformed_legacy_call_id = uuid4()
    ambiguous_legacy_call_id = uuid4()
    current_run_id = uuid4()
    current_user_message_id = uuid4()
    current_assistant_message_id = uuid4()
    current_call_id = uuid4()
    malformed_current_call_id = uuid4()

    read_resource_input = {"uri": f"media:{uuid4()}"}
    rejected_provider_input = {
        "legacy_float": 1e-7,
        "untrusted": "provider input",
    }
    edge_input = {
        "source_uri": f"page:{uuid4()}",
        "target_uri": f"page:{uuid4()}",
        "kind": "context",
        "rationale": "Preserve this migration-owned edge.",
    }
    read_provider_call_id = "provider-read-resource"
    edge_provider_call_id = "provider-mint-edge"
    search_audit_fingerprint = "search-fingerprint-is-audit-only"

    read_done_payload = _tool_event_payload(
        tool_call_id=unique_input_call_id,
        assistant_message_id=historical_assistant_message_id,
        tool_name="read_resource",
        tool_call_index=2,
        provider_call_id=read_provider_call_id,
        input_value=read_resource_input,
    )
    provider_start_payload = _tool_event_payload(
        tool_call_id=rejected_provider_call_id,
        assistant_message_id=historical_assistant_message_id,
        tool_name="hallucinated_provider_tool",
        tool_call_index=3,
        provider_call_id="provider-hallucination",
    )
    provider_done_payload = _tool_event_payload(
        tool_call_id=rejected_provider_call_id,
        assistant_message_id=historical_assistant_message_id,
        tool_name="hallucinated_provider_tool",
        tool_call_index=3,
        provider_call_id="provider-hallucination",
        input_value=rejected_provider_input,
    )
    provider_result_payload = _tool_event_payload(
        tool_call_id=rejected_provider_call_id,
        assistant_message_id=historical_assistant_message_id,
        tool_name="hallucinated_provider_tool",
        tool_call_index=3,
        provider_call_id="provider-hallucination",
        result_scope="provider_tool",
        result_status="error",
        error_code="unknown_tool",
    )
    attached_result_payload = _tool_event_payload(
        tool_call_id=attached_call_id,
        assistant_message_id=historical_assistant_message_id,
        tool_name="attached_resources",
        tool_call_index=0,
        provider_call_id="synthetic-attached-context",
        result_scope="attached_context",
        result_status="complete",
    )
    edge_done_payload = _tool_event_payload(
        tool_call_id=edge_call_id,
        assistant_message_id=historical_assistant_message_id,
        tool_name="mint_edge",
        tool_call_index=4,
        provider_call_id=edge_provider_call_id,
        input_value=edge_input,
    )

    try:
        with engine.begin() as connection:
            connection.execute(
                text("INSERT INTO users (id, email) VALUES (:id, :email)"),
                {"id": user_id, "email": f"llm-tools-migration-{user_id}@example.invalid"},
            )
            connection.execute(
                text("INSERT INTO conversations (id, owner_user_id) VALUES (:id, :owner_id)"),
                {"id": conversation_id, "owner_id": user_id},
            )
            _insert_chat_run(
                connection,
                run_id=live_run_id,
                user_id=user_id,
                conversation_id=conversation_id,
                user_message_id=live_user_message_id,
                assistant_message_id=live_assistant_message_id,
                message_seq=1,
                status="running",
                idempotency_key="live-chat-must-refuse",
            )
            _insert_chat_run(
                connection,
                run_id=historical_run_id,
                user_id=user_id,
                conversation_id=conversation_id,
                user_message_id=historical_user_message_id,
                assistant_message_id=historical_assistant_message_id,
                message_seq=3,
                status="complete",
                idempotency_key="terminal-history",
            )

        legacy_shape = _legacy_shape(engine)
        with pytest.raises(RuntimeError, match=r"(?i)(chat.*nonterminal|nonterminal.*chat)"):
            command.upgrade(config, _TARGET_REVISION)
        _assert_preflight_left_0216_untouched(
            engine,
            legacy_shape=legacy_shape,
            expected_chat_status="running",
            chat_run_id=live_run_id,
            artifact_build_id=None,
        )

        with engine.begin() as connection:
            connection.execute(
                text("UPDATE chat_runs SET status = 'complete' WHERE id = :id"),
                {"id": live_run_id},
            )
            _insert_active_idea_build(
                connection,
                user_id=user_id,
                idea_id=idea_id,
                artifact_id=artifact_id,
                build_id=active_build_id,
            )

        with pytest.raises(
            RuntimeError,
            match=r"(?i)(?:active|nonterminal).*(?:idea|dossier|build)|(?:idea|dossier|build).*(?:active|nonterminal)",
        ):
            command.upgrade(config, _TARGET_REVISION)
        _assert_preflight_left_0216_untouched(
            engine,
            legacy_shape=legacy_shape,
            expected_chat_status="complete",
            chat_run_id=live_run_id,
            artifact_build_id=active_build_id,
        )

        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO artifact_build_cancellations (build_id, actor_user_id) "
                    "VALUES (:build_id, :actor_user_id)"
                ),
                {"build_id": active_build_id, "actor_user_id": user_id},
            )
            _insert_tool_call(
                connection,
                tool_call_id=attached_call_id,
                conversation_id=conversation_id,
                user_message_id=historical_user_message_id,
                assistant_message_id=historical_assistant_message_id,
                tool_name="attached_resources",
                tool_call_index=0,
                scope="attached_context",
                status="complete",
                error_code=None,
            )
            _insert_tool_call(
                connection,
                tool_call_id=pre_0167_call_id,
                conversation_id=conversation_id,
                user_message_id=historical_user_message_id,
                assistant_message_id=historical_assistant_message_id,
                tool_name="app_search",
                tool_call_index=1,
                scope="all",
                status="complete",
                error_code=None,
                query_hash=search_audit_fingerprint,
                result_refs=[
                    {
                        "opaque_audit": {"legacy_tool_name": "app_search", "retain": True},
                    }
                ],
            )
            _insert_tool_call(
                connection,
                tool_call_id=unique_input_call_id,
                conversation_id=conversation_id,
                user_message_id=historical_user_message_id,
                assistant_message_id=historical_assistant_message_id,
                tool_name="read_resource",
                tool_call_index=2,
                scope="conversation_context",
                status="complete",
                error_code=None,
                query_hash=search_audit_fingerprint,
                result_refs=[{"uri": read_resource_input["uri"], "status": "complete"}],
            )
            _insert_tool_call(
                connection,
                tool_call_id=rejected_provider_call_id,
                conversation_id=conversation_id,
                user_message_id=historical_user_message_id,
                assistant_message_id=historical_assistant_message_id,
                tool_name="hallucinated_provider_tool",
                tool_call_index=3,
                scope="provider_tool",
                status="error",
                error_code="unknown_tool",
            )
            _insert_tool_call(
                connection,
                tool_call_id=edge_call_id,
                conversation_id=conversation_id,
                user_message_id=historical_user_message_id,
                assistant_message_id=historical_assistant_message_id,
                tool_name="mint_edge",
                tool_call_index=4,
                scope="assistant_write",
                status="complete",
                error_code=None,
                result_refs=[{"kind": "edge", "id": str(edge_result_id), "retained": True}],
                reverted=True,
            )
            for tool_call_index, (old_id, tool_call_id) in enumerate(
                other_historical_call_ids.items(),
                start=10,
            ):
                _insert_tool_call(
                    connection,
                    tool_call_id=tool_call_id,
                    conversation_id=conversation_id,
                    user_message_id=historical_user_message_id,
                    assistant_message_id=historical_assistant_message_id,
                    tool_name=old_id,
                    tool_call_index=tool_call_index,
                    scope=(
                        "assistant_write"
                        if old_id
                        in {
                            "add_to_library",
                            "jot_note",
                            "create_highlight",
                            "queue_add",
                        }
                        else "all"
                    ),
                    status="complete",
                    error_code=None,
                )
            _insert_retrieval(
                connection,
                retrieval_id=uuid4(),
                tool_call_id=unique_input_call_id,
                ordinal=0,
                scope="read_resource",
            )
            _insert_retrieval(
                connection,
                retrieval_id=uuid4(),
                tool_call_id=edge_call_id,
                ordinal=0,
                scope="assistant_write",
            )
            _insert_retrieval(
                connection,
                retrieval_id=uuid4(),
                tool_call_id=attached_call_id,
                ordinal=0,
                scope="attached_context",
            )
            _insert_event(
                connection,
                event_id=uuid4(),
                run_id=historical_run_id,
                seq=1,
                event_type="tool_call_done",
                payload=read_done_payload,
            )
            _insert_event(
                connection,
                event_id=uuid4(),
                run_id=historical_run_id,
                seq=2,
                event_type="tool_call_start",
                payload=provider_start_payload,
            )
            _insert_event(
                connection,
                event_id=uuid4(),
                run_id=historical_run_id,
                seq=3,
                event_type="tool_call_done",
                payload=provider_done_payload,
            )
            _insert_event(
                connection,
                event_id=uuid4(),
                run_id=historical_run_id,
                seq=4,
                event_type="tool_result",
                payload=provider_result_payload,
            )
            _insert_event(
                connection,
                event_id=uuid4(),
                run_id=historical_run_id,
                seq=5,
                event_type="tool_result",
                payload=attached_result_payload,
            )
            _insert_event(
                connection,
                event_id=uuid4(),
                run_id=historical_run_id,
                seq=6,
                event_type="tool_call_done",
                payload=edge_done_payload,
            )
            read_request = _tool_request(
                provider_call_id=read_provider_call_id,
                tool_name="read_resource",
                tool_call_index=2,
                arguments=read_resource_input,
            )
            rejected_request = _tool_request(
                provider_call_id="provider-hallucination",
                tool_name="hallucinated_provider_tool",
                tool_call_index=3,
                arguments=rejected_provider_input,
            )
            connection.execute(
                text(
                    """
                    INSERT INTO background_jobs (id, kind, payload, status, attempts, result)
                    VALUES (:id, 'chat_run', CAST(:payload AS jsonb), 'succeeded', 1,
                            CAST(:result AS jsonb))
                    """
                ),
                {
                    "id": uuid4(),
                    "payload": _json(
                        {
                            "run_id": str(historical_run_id),
                            "coordination": {
                                "turn/0/tool/2": _completed_step_state(
                                    request_fingerprint=_legacy_sha256(read_request),
                                    result=_tool_result(
                                        tool_call_id=unique_input_call_id,
                                        assistant_message_id=historical_assistant_message_id,
                                        tool_name="read_resource",
                                        tool_call_index=2,
                                        provider_call_id=read_provider_call_id,
                                        scope="conversation_context",
                                        status="complete",
                                        error_code=None,
                                    ),
                                ),
                                "turn/0/tool/3": _completed_step_state(
                                    request_fingerprint=_legacy_sha256(rejected_request),
                                    result=_tool_result(
                                        tool_call_id=rejected_provider_call_id,
                                        assistant_message_id=historical_assistant_message_id,
                                        tool_name="hallucinated_provider_tool",
                                        tool_call_index=3,
                                        provider_call_id="provider-hallucination",
                                        scope="provider_tool",
                                        status="error",
                                        error_code="unknown_tool",
                                    ),
                                ),
                            },
                            "opaque_provider_continuation": {
                                "tool_name": "app_search",
                                "opaque": True,
                            },
                        }
                    ),
                    "result": _json({"opaque_result": {"tool_name": "app_search"}}),
                },
            )
            connection.execute(
                text(
                    """
                    INSERT INTO background_jobs (id, kind, payload, status, attempts)
                    VALUES (:id, 'unrelated_job', CAST(:payload AS jsonb), 'pending', 0)
                    """
                ),
                {
                    "id": uuid4(),
                    "payload": _json({"legacy_tool_name": "app_search", "retain": True}),
                },
            )
            _insert_tool_call(
                connection,
                tool_call_id=malformed_legacy_call_id,
                conversation_id=conversation_id,
                user_message_id=historical_user_message_id,
                assistant_message_id=historical_assistant_message_id,
                tool_name="app_search",
                tool_call_index=5,
                scope="all",
                status="complete",
                error_code=None,
            )
            _insert_event(
                connection,
                event_id=uuid4(),
                run_id=historical_run_id,
                seq=7,
                event_type="tool_call_done",
                payload={
                    **_tool_event_payload(
                        tool_call_id=malformed_legacy_call_id,
                        assistant_message_id=historical_assistant_message_id,
                        tool_name="app_search",
                        tool_call_index=5,
                        provider_call_id="provider-malformed",
                    ),
                    "input": ["not", "a", "typed", "object"],
                },
            )

        source_rows_before_malformed_refusal: list[tuple[object, ...]]
        edge_reverted_at: object
        with engine.connect() as connection:
            source_rows_before_malformed_refusal = connection.execute(
                text(
                    """
                    SELECT id, tool_name, query_hash, scope, status, error_code,
                           result_refs, reverted_at
                    FROM message_tool_calls
                    ORDER BY tool_call_index
                    """
                )
            ).all()
            edge_reverted_at = connection.scalar(
                text("SELECT reverted_at FROM message_tool_calls WHERE id = :id"),
                {"id": edge_call_id},
            )

        with pytest.raises(
            RuntimeError,
            match=r"(?i)(malformed|invalid).*(input|tool)|(?:input|tool).*(malformed|invalid)",
        ):
            command.upgrade(config, _TARGET_REVISION)
        _assert_preflight_left_0216_untouched(
            engine,
            legacy_shape=legacy_shape,
            expected_chat_status="complete",
            chat_run_id=live_run_id,
            artifact_build_id=active_build_id,
        )
        with engine.connect() as connection:
            assert (
                connection.execute(
                    text(
                        """
                        SELECT id, tool_name, query_hash, scope, status, error_code,
                               result_refs, reverted_at
                        FROM message_tool_calls
                        ORDER BY tool_call_index
                        """
                    )
                ).all()
                == source_rows_before_malformed_refusal
            )

        with engine.begin() as connection:
            connection.execute(
                text("DELETE FROM chat_run_events WHERE run_id = :run_id AND seq = 7"),
                {"run_id": historical_run_id},
            )
            connection.execute(
                text("DELETE FROM message_tool_calls WHERE id = :id"),
                {"id": malformed_legacy_call_id},
            )
            _insert_tool_call(
                connection,
                tool_call_id=ambiguous_legacy_call_id,
                conversation_id=conversation_id,
                user_message_id=historical_user_message_id,
                assistant_message_id=historical_assistant_message_id,
                tool_name="app_search",
                tool_call_index=5,
                scope="all",
                status="complete",
                error_code=None,
            )
            for seq in (7, 8):
                _insert_event(
                    connection,
                    event_id=uuid4(),
                    run_id=historical_run_id,
                    seq=seq,
                    event_type="tool_call_done",
                    payload=_tool_event_payload(
                        tool_call_id=ambiguous_legacy_call_id,
                        assistant_message_id=historical_assistant_message_id,
                        tool_name="app_search",
                        tool_call_index=5,
                        provider_call_id="provider-ambiguous",
                        input_value={"query": "same valid input twice"},
                    ),
                )

        with pytest.raises(RuntimeError, match=r"(?i)(ambiguous|contradictory)"):
            command.upgrade(config, _TARGET_REVISION)
        _assert_preflight_left_0216_untouched(
            engine,
            legacy_shape=legacy_shape,
            expected_chat_status="complete",
            chat_run_id=live_run_id,
            artifact_build_id=active_build_id,
        )

        with engine.begin() as connection:
            connection.execute(
                text("DELETE FROM chat_run_events WHERE run_id = :run_id AND seq IN (7, 8)"),
                {"run_id": historical_run_id},
            )
            connection.execute(
                text("DELETE FROM message_tool_calls WHERE id = :id"),
                {"id": ambiguous_legacy_call_id},
            )

        command.upgrade(config, _TARGET_REVISION)
        inspector = inspect(engine)
        assert _migration_version(engine) == _TARGET_REVISION
        assert scripts.get_heads() == [_TARGET_REVISION]

        chat_run_columns = {column["name"]: column for column in inspector.get_columns("chat_runs")}
        assert {"tool_profile_id", "tool_profile_revision", "tool_profile_snapshot"} <= set(
            chat_run_columns
        )
        assert all(
            chat_run_columns[name]["nullable"]
            for name in ("tool_profile_id", "tool_profile_revision", "tool_profile_snapshot")
        )

        tool_columns = {
            column["name"]: column for column in inspector.get_columns("message_tool_calls")
        }
        assert {
            "canonical_tool_id",
            "record_kind",
            "provider_wire_name",
            "canonical_input_sha256",
            "tool_contract_revision",
            "binding_policy_revision",
            "search_query_fingerprint",
        } <= set(tool_columns)
        assert "record_kind" in tool_columns and not tool_columns["record_kind"]["nullable"]
        assert not {"tool_name", "query_hash"} & set(tool_columns)
        for check in inspector.get_check_constraints("message_tool_calls"):
            sql = check.get("sqltext", "") or ""
            assert "record_kind" not in sql
            assert "canonical_input_sha256" not in sql

        with engine.connect() as connection:
            terminal_runs = connection.execute(
                text(
                    """
                    SELECT id, profile_id, tool_profile_id, tool_profile_revision,
                           tool_profile_snapshot
                    FROM chat_runs
                    WHERE id = ANY(:ids)
                    ORDER BY id
                    """
                ),
                {"ids": [live_run_id, historical_run_id]},
            ).all()
            migrated_calls = {
                row.id: row
                for row in connection.execute(
                    text(
                        """
                        SELECT id, canonical_tool_id, record_kind, provider_wire_name,
                               canonical_input_sha256, tool_contract_revision,
                               binding_policy_revision, search_query_fingerprint,
                               scope, status, error_code, result_refs, reverted_at
                        FROM message_tool_calls
                        ORDER BY tool_call_index
                        """
                    )
                ).mappings()
            }
            migrated_events = {
                row.seq: row.payload
                for row in connection.execute(
                    text(
                        """
                        SELECT seq, payload
                        FROM chat_run_events
                        WHERE run_id = :run_id
                        ORDER BY seq
                        """
                    ),
                    {"run_id": historical_run_id},
                ).mappings()
            }
            retrieval_scopes = dict(
                connection.execute(
                    text(
                        """
                        SELECT tool_call_id, scope
                        FROM message_retrievals
                        WHERE tool_call_id = ANY(:tool_call_ids)
                        """
                    ),
                    {"tool_call_ids": [unique_input_call_id, edge_call_id, attached_call_id]},
                ).all()
            )
            migrated_job = (
                connection.execute(
                    text(
                        """
                    SELECT payload, result
                    FROM background_jobs
                    WHERE kind = 'chat_run' AND payload ->> 'run_id' = :run_id
                    """
                    ),
                    {"run_id": str(historical_run_id)},
                )
                .mappings()
                .one()
            )
            unrelated_job = connection.execute(
                text("SELECT payload FROM background_jobs WHERE kind = 'unrelated_job'"),
            ).scalar_one()

        assert [
            (
                row.profile_id,
                row.tool_profile_id,
                row.tool_profile_revision,
                row.tool_profile_snapshot,
            )
            for row in terminal_runs
        ] == [
            ("balanced", None, None, None),
            ("balanced", None, None, None),
        ]
        assert migrated_calls[attached_call_id]["canonical_tool_id"] is None
        assert migrated_calls[attached_call_id]["record_kind"] == "attached_context"
        assert migrated_calls[attached_call_id]["provider_wire_name"] is None
        assert migrated_calls[attached_call_id]["canonical_input_sha256"] is None
        assert migrated_calls[attached_call_id]["tool_contract_revision"] is None
        assert migrated_calls[attached_call_id]["binding_policy_revision"] is None

        pre_0167 = migrated_calls[pre_0167_call_id]
        assert pre_0167["canonical_tool_id"] == _LEGACY_TO_CANONICAL["app_search"]
        assert pre_0167["record_kind"] == "historical_execution"
        assert pre_0167["provider_wire_name"] is None
        assert pre_0167["canonical_input_sha256"] is None
        assert pre_0167["tool_contract_revision"] == _historical_revision(
            kind="nexus_historical_tool_contract",
            old_id="app_search",
        )
        assert pre_0167["binding_policy_revision"] == _historical_revision(
            kind="nexus_historical_binding_policy",
            old_id="app_search",
        )
        assert pre_0167["search_query_fingerprint"] == search_audit_fingerprint
        assert pre_0167["result_refs"] == [
            {"opaque_audit": {"legacy_tool_name": "app_search", "retain": True}}
        ]

        unique_input = migrated_calls[unique_input_call_id]
        assert unique_input["canonical_tool_id"] == _LEGACY_TO_CANONICAL["read_resource"]
        assert unique_input["record_kind"] == "historical_execution"
        assert unique_input["provider_wire_name"] is None
        assert unique_input["canonical_input_sha256"] == _sha256(read_resource_input)
        assert unique_input["canonical_input_sha256"] != search_audit_fingerprint
        assert unique_input["tool_contract_revision"] == _historical_revision(
            kind="nexus_historical_tool_contract",
            old_id="read_resource",
        )
        assert unique_input["binding_policy_revision"] == _historical_revision(
            kind="nexus_historical_binding_policy",
            old_id="read_resource",
        )
        assert unique_input["search_query_fingerprint"] == search_audit_fingerprint

        rejected = migrated_calls[rejected_provider_call_id]
        assert rejected["canonical_tool_id"] is None
        assert rejected["record_kind"] == "rejected_provider_call"
        assert rejected["provider_wire_name"] == "hallucinated_provider_tool"
        assert rejected["canonical_input_sha256"] is None
        assert rejected["tool_contract_revision"] is None
        assert rejected["binding_policy_revision"] is None
        assert (rejected["scope"], rejected["status"], rejected["error_code"]) == (
            "provider_tool",
            "error",
            "unknown_tool",
        )

        edge = migrated_calls[edge_call_id]
        assert edge["canonical_tool_id"] == _LEGACY_TO_CANONICAL["mint_edge"]
        assert edge["record_kind"] == "historical_execution"
        assert edge["canonical_input_sha256"] == _sha256(edge_input)
        assert edge["tool_contract_revision"] == _historical_revision(
            kind="nexus_historical_tool_contract",
            old_id="mint_edge",
        )
        assert edge["binding_policy_revision"] == _historical_revision(
            kind="nexus_historical_binding_policy",
            old_id="mint_edge",
        )
        assert edge["result_refs"] == [
            {"kind": "edge", "id": str(edge_result_id), "retained": True}
        ]
        assert edge["reverted_at"] == edge_reverted_at

        for old_id, tool_call_id in other_historical_call_ids.items():
            historical = migrated_calls[tool_call_id]
            assert historical["canonical_tool_id"] == _LEGACY_TO_CANONICAL[old_id]
            assert historical["record_kind"] == "historical_execution"
            assert historical["provider_wire_name"] is None
            assert historical["canonical_input_sha256"] is None
            assert historical["tool_contract_revision"] == _historical_revision(
                kind="nexus_historical_tool_contract",
                old_id=old_id,
            )
            assert historical["binding_policy_revision"] == _historical_revision(
                kind="nexus_historical_binding_policy",
                old_id=old_id,
            )

        assert retrieval_scopes == {
            attached_call_id: "attached_context",
            unique_input_call_id: "resource_read",
            edge_call_id: "assistant_write",
        }
        assert [
            row["id"]
            for row in (pre_0167, unique_input)
            if row["search_query_fingerprint"] == search_audit_fingerprint
        ] == [pre_0167_call_id, unique_input_call_id]

        _assert_payload_rewrite(
            original=read_done_payload,
            migrated=migrated_events[1],
            canonical_tool_id="nexus.resource.read",
            record_kind="historical_execution",
            effect="Read",
            result_kind="retrieval",
            provider_wire_name=None,
            activity_label="Reading a resource",
        )
        _assert_payload_rewrite(
            original=provider_start_payload,
            migrated=migrated_events[2],
            canonical_tool_id=None,
            record_kind="rejected_provider_call",
            effect=None,
            result_kind="rejected_provider_call",
            provider_wire_name="hallucinated_provider_tool",
            activity_label="Skipped an unavailable tool",
        )
        _assert_payload_rewrite(
            original=provider_done_payload,
            migrated=migrated_events[3],
            canonical_tool_id=None,
            record_kind="rejected_provider_call",
            effect=None,
            result_kind="rejected_provider_call",
            provider_wire_name="hallucinated_provider_tool",
            activity_label="Skipped an unavailable tool",
        )
        _assert_payload_rewrite(
            original=provider_result_payload,
            migrated=migrated_events[4],
            canonical_tool_id=None,
            record_kind="rejected_provider_call",
            effect=None,
            result_kind="rejected_provider_call",
            provider_wire_name="hallucinated_provider_tool",
            activity_label="Skipped an unavailable tool",
        )
        _assert_payload_rewrite(
            original=attached_result_payload,
            migrated=migrated_events[5],
            canonical_tool_id=None,
            record_kind="attached_context",
            effect=None,
            result_kind="attached_context",
            provider_wire_name=None,
            activity_label="Attached conversation context",
        )
        _assert_payload_rewrite(
            original=edge_done_payload,
            migrated=migrated_events[6],
            canonical_tool_id="nexus.edge.create",
            record_kind="historical_execution",
            effect="Write",
            result_kind="mutation",
            provider_wire_name=None,
            activity_label="Creating a connection",
        )

        coordination = migrated_job["payload"]["coordination"]
        migrated_step = coordination["turn/0/tool/2"]
        rejected_step = coordination["turn/0/tool/3"]
        assert "read_resource" not in _json(coordination)
        assert '"tool_name"' not in _json(coordination)
        assert _legacy_sha256(rejected_request) != _sha256(rejected_request)
        assert migrated_step["request_fingerprint"]["value"] == _sha256(
            _canonical_tool_request(
                provider_call_id=read_provider_call_id,
                canonical_tool_id="nexus.resource.read",
                tool_call_index=2,
                arguments=read_resource_input,
            )
        )
        decoded_result = json.loads(migrated_step["terminal_result"]["value"])
        assert decoded_result["canonical_tool_id"] == "nexus.resource.read"
        assert "tool_name" not in decoded_result
        assert decoded_result["result_event"]["canonical_tool_id"] == "nexus.resource.read"
        assert "tool_name" not in decoded_result["result_event"]
        assert rejected_step["request_fingerprint"]["value"] == _legacy_sha256(
            _tool_request(
                provider_call_id="provider-hallucination",
                tool_name="hallucinated_provider_tool",
                tool_call_index=3,
                arguments=rejected_provider_input,
            )
        )
        rejected_result = json.loads(rejected_step["terminal_result"]["value"])
        assert rejected_result["canonical_tool_id"] is None
        assert rejected_result["record_kind"] == "rejected_provider_call"
        assert rejected_result["provider_wire_name"] == "hallucinated_provider_tool"
        assert rejected_result["canonical_input_sha256"] is None
        assert rejected_result["tool_contract_revision"] is None
        assert rejected_result["binding_policy_revision"] is None
        assert rejected_result["result_event"]["record_kind"] == "rejected_provider_call"
        assert rejected_result["result_event"]["provider_wire_name"] == (
            "hallucinated_provider_tool"
        )
        assert '"tool_name"' not in _json(rejected_result)
        assert migrated_job["payload"]["opaque_provider_continuation"] == {
            "tool_name": "app_search",
            "opaque": True,
        }
        assert migrated_job["result"] == {"opaque_result": {"tool_name": "app_search"}}
        assert unrelated_job == {"legacy_tool_name": "app_search", "retain": True}

        with engine.begin() as connection:
            _insert_post_cutover_current_rows(
                connection,
                user_id=user_id,
                conversation_id=conversation_id,
                run_id=current_run_id,
                user_message_id=current_user_message_id,
                assistant_message_id=current_assistant_message_id,
                current_tool_call_id=current_call_id,
                malformed_tool_call_id=malformed_current_call_id,
            )

        with engine.connect() as connection:
            current_row = (
                connection.execute(
                    text(
                        """
                    SELECT canonical_tool_id, record_kind, provider_wire_name,
                           canonical_input_sha256, tool_contract_revision,
                           binding_policy_revision
                    FROM message_tool_calls WHERE id = :id
                    """
                    ),
                    {"id": current_call_id},
                )
                .mappings()
                .one()
            )
        assert current_row == {
            "canonical_tool_id": "nexus.search",
            "record_kind": "current_execution",
            "provider_wire_name": None,
            "canonical_input_sha256": _current_parsed_input_sha256(
                {"query": "a current canonical search"}
            ),
            "tool_contract_revision": _current_tool_contract_revision("nexus.search"),
            "binding_policy_revision": _test_binding_policy_revision(),
        }

        from nexus.db.models import ChatRun, MessageToolCall
        from nexus.services.agent_tools.writes import undo_tool_call
        from nexus.services.chat_failure import compute_has_write_tool_attempt
        from nexus.services.chat_run_citations import persist_attached_citations
        from nexus.services.chat_run_response import build_chat_run_response
        from nexus.services.chat_run_tools import (
            RecordKind,
            current_tool_record_identity,
            decode_persisted_tool_record,
            persist_current_tool_record,
            persist_rejected_provider_tool_call,
            upsert_attached_context_tool_call,
        )
        from nexus.services.message_trust_trails import build_assistant_trust_trail

        factory = sessionmaker(engine, expire_on_commit=False)
        with factory() as db:
            current_run = db.get(ChatRun, current_run_id)
            assert current_run is not None
            identity = current_tool_record_identity(
                canonical_tool_id="nexus.search",
                canonical_input_sha256=_current_parsed_input_sha256(
                    {"query": "a current canonical search"}
                ),
                binding_policy_revision=_test_binding_policy_revision(),
            )
            assert identity.canonical_input_sha256 == raw_input_digest(
                ParsedJson({"query": "a current canonical search"})
            )
            malformed_input_identity = current_tool_record_identity(
                canonical_tool_id="nexus.search",
                canonical_input_sha256=raw_input_digest(MalformedJson(b'{"query":"unterminated')),
                binding_policy_revision=_test_binding_policy_revision(),
            )
            assert malformed_input_identity.canonical_input_sha256 == raw_input_digest(
                MalformedJson(b'{"query":"unterminated')
            )
            assert (
                persist_current_tool_record(
                    db,
                    conversation_id=current_run.conversation_id,
                    user_message_id=current_run.user_message_id,
                    assistant_message_id=current_run.assistant_message_id,
                    tool_call_index=1,
                    identity=identity,
                    search_query_fingerprint=_sha256({"query": "audit only"}),
                    scope="all",
                    requested_types=[],
                    result_refs=[],
                    selected_context_refs=[],
                    provider_request_ids=[],
                    latency_ms=None,
                    status="complete",
                    error_code=None,
                )
                == current_call_id
            )
            changed_input = current_tool_record_identity(
                canonical_tool_id="nexus.search",
                canonical_input_sha256=_current_parsed_input_sha256(
                    {"query": "a different input at the same position"}
                ),
                binding_policy_revision=_test_binding_policy_revision(),
            )
            with pytest.raises(
                AssertionError,
                match="occupied tool position changed canonical replay identity",
            ):
                persist_current_tool_record(
                    db,
                    conversation_id=current_run.conversation_id,
                    user_message_id=current_run.user_message_id,
                    assistant_message_id=current_run.assistant_message_id,
                    tool_call_index=1,
                    identity=changed_input,
                    search_query_fingerprint=None,
                    scope="all",
                    requested_types=[],
                    result_refs=[],
                    selected_context_refs=[],
                    provider_request_ids=[],
                    latency_ms=None,
                    status="complete",
                    error_code=None,
                )
            current_rejected_call_id = persist_rejected_provider_tool_call(
                db,
                run=current_run,
                tool_call_index=3,
                provider_wire_name="post_cutover_unknown_tool",
            )
            inserted_identity = current_tool_record_identity(
                canonical_tool_id="nexus.resource.inspect",
                canonical_input_sha256=_current_parsed_input_sha256({"uri": f"media:{uuid4()}"}),
                binding_policy_revision=_test_binding_policy_revision(),
            )
            inserted_current_call_id = persist_current_tool_record(
                db,
                conversation_id=current_run.conversation_id,
                user_message_id=current_run.user_message_id,
                assistant_message_id=current_run.assistant_message_id,
                tool_call_index=4,
                identity=inserted_identity,
                search_query_fingerprint=None,
                scope="conversation_context",
                requested_types=[],
                result_refs=[],
                selected_context_refs=[],
                provider_request_ids=[],
                latency_ms=None,
                status="complete",
                error_code=None,
            )
            current_attached_call_id = upsert_attached_context_tool_call(
                db,
                run=current_run,
            )
            db.commit()

        expected_record_kinds = {
            pre_0167_call_id: RecordKind.historical_execution,
            unique_input_call_id: RecordKind.historical_execution,
            edge_call_id: RecordKind.historical_execution,
            rejected_provider_call_id: RecordKind.rejected_provider_call,
            attached_call_id: RecordKind.attached_context,
            current_call_id: RecordKind.current_execution,
            current_rejected_call_id: RecordKind.rejected_provider_call,
            inserted_current_call_id: RecordKind.current_execution,
            current_attached_call_id: RecordKind.attached_context,
            **{
                tool_call_id: RecordKind.historical_execution
                for tool_call_id in other_historical_call_ids.values()
            },
        }
        with factory() as db:
            for tool_call_id, expected_kind in expected_record_kinds.items():
                row = db.get(MessageToolCall, tool_call_id)
                assert row is not None
                assert decode_persisted_tool_record(row).record_kind is expected_kind
            malformed = db.get(MessageToolCall, malformed_current_call_id)
            assert malformed is not None
            with pytest.raises(AssertionError, match="invalid persisted tool record"):
                decode_persisted_tool_record(malformed)

        with factory() as db:
            current_run = db.get(ChatRun, current_run_id)
            assert current_run is not None
            with pytest.raises(AssertionError, match="invalid persisted tool record"):
                build_assistant_trust_trail(
                    db,
                    viewer_id=user_id,
                    assistant_message_id=current_assistant_message_id,
                )
        with factory() as db:
            current_run = db.get(ChatRun, current_run_id)
            assert current_run is not None
            with pytest.raises(AssertionError, match="invalid persisted tool record"):
                build_chat_run_response(db, user_id, current_run)
        with factory() as db:
            current_run = db.get(ChatRun, current_run_id)
            assert current_run is not None
            with pytest.raises(AssertionError, match="invalid persisted tool record"):
                compute_has_write_tool_attempt(db, current_run)
        with factory() as db:
            with pytest.raises(AssertionError, match="invalid persisted tool record"):
                undo_tool_call(
                    db,
                    viewer_id=user_id,
                    conversation_id=conversation_id,
                    tool_call_id=malformed_current_call_id,
                )
        with engine.connect() as connection:
            assert (
                connection.scalar(
                    text("SELECT reverted_at FROM message_tool_calls WHERE id = :id"),
                    {"id": malformed_current_call_id},
                )
                is None
            )
        with factory() as db:
            current_run = db.get(ChatRun, current_run_id)
            assert current_run is not None
            db.execute(
                text(
                    """
                    UPDATE message_tool_calls
                    SET record_kind = 'current_execution',
                        canonical_tool_id = 'nexus.search'
                    WHERE id = :id
                    """
                ),
                {"id": current_attached_call_id},
            )
            db.commit()
            with pytest.raises(AssertionError, match="invalid persisted tool record"):
                persist_attached_citations(db, current_run, ())
            assert db.get(MessageToolCall, current_attached_call_id) is not None

        with engine.begin() as connection:
            connection.execute(text("DROP SCHEMA public CASCADE"))
            connection.execute(text("CREATE SCHEMA public"))
        command.upgrade(config, "head")
        assert _migration_version(engine) == _TARGET_REVISION
    finally:
        engine.dispose()
