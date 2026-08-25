"""0222 RED proof for the irreversible Codex-personal generation cutover."""

from __future__ import annotations

import json
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Engine, create_engine, inspect, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Message
from nexus.errors import ApiError, ApiErrorCode
from nexus.services.chat_failure import profile_selection_active
from nexus.services.chat_run_candidates import (
    regenerate_assistant_response,
    rerun_assistant_response,
)
from nexus.services.conversations import (
    regeneratable_assistant_message_ids,
    rerunnable_assistant_message_ids,
)

_CUTOVER_REVISION = "0222"
_PREVIOUS_REVISION = "0221"
_GENERATION_JOB_KINDS = (
    "enrich_metadata",
    "chat_run",
    "dossier_build",
    "oracle_reading_generate",
    "media_unit_build",
    "synapse_scan",
    "dawn_write_job",
)
_ACTIVE_JOB_STATUSES = ("pending", "running", "failed", "dead")
_FINAL_LEDGER_COLUMNS = {
    "id",
    "owner_kind",
    "owner_id",
    "generation_seq",
    "operation",
    "plan_id",
    "plan_revision",
    "backend",
    "transport",
    "auth_profile",
    "model_name",
    "reasoning_effort",
    "capability_kind",
    "request_fingerprint",
    "output_schema_fingerprint",
    "tool_plan_fingerprint",
    "streaming",
    "session_ref",
    "outcome",
    "error_code",
    "error_detail",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "reasoning_tokens",
    "cache_read_input_tokens",
    "cache_write_input_tokens",
    "sdk_version",
    "runtime_version",
    "latency_ms",
    "created_at",
    "accepted_at",
    "completed_at",
}
_NON_NULL_LEDGER_COLUMNS = {
    "id",
    "owner_kind",
    "owner_id",
    "generation_seq",
    "operation",
    "plan_id",
    "plan_revision",
    "backend",
    "transport",
    "auth_profile",
    "model_name",
    "reasoning_effort",
    "capability_kind",
    "request_fingerprint",
    "output_schema_fingerprint",
    "streaming",
    "created_at",
}
_LEDGER_CHECK_NAMES = {
    "ck_llm_calls_fingerprints",
    "ck_llm_calls_generation_seq_positive",
    "ck_llm_calls_lifecycle",
    "ck_llm_calls_owner_operation",
    "ck_llm_calls_plan_capability",
    "ck_llm_calls_route",
    "ck_llm_calls_session_ref",
    "ck_llm_calls_usage",
}
_LEDGER_OPERATION_FACTS: dict[str, tuple[str, str, str, str, str]] = {
    "metadata_enrichment": (
        "media_enrichment",
        "routine",
        "gpt-5.6-luna",
        "low",
        "Synthesis",
    ),
    "media_summary": ("media_summary", "routine", "gpt-5.6-luna", "low", "Synthesis"),
    "synapse": ("synapse_scan", "routine", "gpt-5.6-luna", "low", "Synthesis"),
    "dawn_write": ("dawn_write", "standard", "gpt-5.6-terra", "medium", "Synthesis"),
    "oracle": ("oracle_reading", "standard", "gpt-5.6-terra", "medium", "Synthesis"),
    "dossier_page": ("artifact_build", "routine", "gpt-5.6-luna", "low", "Synthesis"),
    "dossier_note": ("artifact_build", "routine", "gpt-5.6-luna", "low", "Synthesis"),
    "dossier_media": (
        "artifact_build",
        "standard",
        "gpt-5.6-terra",
        "medium",
        "Synthesis",
    ),
    "dossier_conversation": (
        "artifact_build",
        "standard",
        "gpt-5.6-terra",
        "medium",
        "Synthesis",
    ),
    "dossier_library": ("artifact_build", "thorough", "gpt-5.6-terra", "high", "Synthesis"),
    "dossier_podcast": ("artifact_build", "thorough", "gpt-5.6-terra", "high", "Synthesis"),
    "dossier_contributor": (
        "artifact_build",
        "thorough",
        "gpt-5.6-terra",
        "high",
        "Synthesis",
    ),
    "dossier_idea": ("artifact_build", "thorough", "gpt-5.6-terra", "high", "Synthesis"),
    "dossier_idea_resolve": (
        "artifact_learn_request",
        "routine",
        "gpt-5.6-luna",
        "low",
        "Synthesis",
    ),
    "chat": ("chat_run", "standard", "gpt-5.6-terra", "medium", "ChatTools"),
}
_CHAT_OUTPUT_FINGERPRINT = "3f0d42022e6069f00f4048e3a091c1b225e739ef73e2d0a9fcee8986da69e9e7"
_CHAT_TOOL_FINGERPRINT = "62494626c69ba139121e1b761e4e2def6ca50ccf1ebfde551f8de061efef049c"
_INSERT_LEDGER_ROW = """
INSERT INTO llm_calls (
    id,
    owner_kind,
    owner_id,
    generation_seq,
    operation,
    plan_id,
    plan_revision,
    backend,
    transport,
    auth_profile,
    model_name,
    reasoning_effort,
    capability_kind,
    request_fingerprint,
    output_schema_fingerprint,
    tool_plan_fingerprint,
    streaming,
    session_ref,
    outcome,
    error_code,
    error_detail,
    input_tokens,
    output_tokens,
    total_tokens,
    reasoning_tokens,
    cache_read_input_tokens,
    cache_write_input_tokens,
    sdk_version,
    runtime_version,
    latency_ms,
    accepted_at,
    completed_at
) VALUES (
    :id,
    :owner_kind,
    :owner_id,
    :generation_seq,
    :operation,
    :plan_id,
    :plan_revision,
    :backend,
    :transport,
    :auth_profile,
    :model_name,
    :reasoning_effort,
    :capability_kind,
    :request_fingerprint,
    :output_schema_fingerprint,
    :tool_plan_fingerprint,
    :streaming,
    CAST(:session_ref AS jsonb),
    :outcome,
    :error_code,
    :error_detail,
    :input_tokens,
    :output_tokens,
    :total_tokens,
    :reasoning_tokens,
    :cache_read_input_tokens,
    :cache_write_input_tokens,
    :sdk_version,
    :runtime_version,
    :latency_ms,
    :accepted_at,
    :completed_at
)
"""


def _migration_config() -> Config:
    migration_root = Path(__file__).parents[3] / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    return config


def _require_cutover_revision(config: Config) -> None:
    scripts = ScriptDirectory.from_config(config)
    revision = scripts.get_revision(_CUTOVER_REVISION)
    assert revision is not None, "missing successor migration 0222 for the generation hard cutover"
    assert revision.down_revision == _PREVIOUS_REVISION


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _ledger_row(operation: str = "metadata_enrichment", **overrides: object) -> dict[str, object]:
    owner_kind, plan_id, model_name, effort, capability = _LEDGER_OPERATION_FACTS[operation]
    row: dict[str, object] = {
        "id": uuid4(),
        "owner_kind": owner_kind,
        "owner_id": uuid4(),
        "generation_seq": 1,
        "operation": operation,
        "plan_id": plan_id,
        "plan_revision": "codex-generation.2026-08-24.2",
        "backend": "codex",
        "transport": "sdk",
        "auth_profile": "codex-personal",
        "model_name": model_name,
        "reasoning_effort": effort,
        "capability_kind": capability,
        "request_fingerprint": "a" * 64,
        "output_schema_fingerprint": (
            _CHAT_OUTPUT_FINGERPRINT if operation == "chat" else "b" * 64
        ),
        "tool_plan_fingerprint": _CHAT_TOOL_FINGERPRINT if operation == "chat" else None,
        "streaming": operation == "chat",
        "session_ref": None,
        "outcome": None,
        "error_code": None,
        "error_detail": None,
        "input_tokens": None,
        "output_tokens": None,
        "total_tokens": None,
        "reasoning_tokens": None,
        "cache_read_input_tokens": None,
        "cache_write_input_tokens": None,
        "sdk_version": None,
        "runtime_version": None,
        "latency_ms": None,
        "accepted_at": None,
        "completed_at": None,
    }
    row.update(overrides)
    return row


def _session_ref(**overrides: object) -> str:
    session_ref: dict[str, object] = {
        "schema_version": "agent-session-ref.v1",
        "backend": "codex",
        "transport": "sdk",
        "native_session_id": "migration-proof-session",
        "profile_key": "codex-personal",
        "state_root_fingerprint": "c" * 64,
        "cwd_fingerprint": "d" * 64,
    }
    session_ref.update(overrides)
    return _json(session_ref)


def _accepted_terminal(
    operation: str = "metadata_enrichment", **overrides: object
) -> dict[str, object]:
    row = _ledger_row(operation)
    row.update(
        {
            "outcome": "Succeeded",
            "session_ref": _session_ref(),
            "sdk_version": "0.144.4",
            "runtime_version": "codex-cli 0.144.4",
            "latency_ms": 125,
            "accepted_at": "2026-08-24T12:00:00+00:00",
            "completed_at": "2026-08-24T12:00:01+00:00",
        }
    )
    row.update(overrides)
    return row


def _assert_ledger_constraints(engine: Engine) -> None:
    valid_rows = [_ledger_row(operation) for operation in _LEDGER_OPERATION_FACTS]
    valid_rows.extend(
        (
            _ledger_row(
                operation="chat",
                plan_id="routine",
                model_name="gpt-5.6-luna",
                reasoning_effort="low",
            ),
            _ledger_row(
                operation="chat",
                plan_id="deep",
                model_name="gpt-5.6-sol",
                reasoning_effort="high",
            ),
            _ledger_row(
                operation="synapse",
                outcome="Failed",
                error_code="capacity_unavailable",
                error_detail="codex generation capacity unavailable",
                completed_at="2026-08-24T12:00:01+00:00",
            ),
            _ledger_row(
                operation="dossier_page",
                outcome="Cancelled",
                error_detail="owner cancelled before host acceptance",
                completed_at="2026-08-24T12:00:01+00:00",
            ),
            _accepted_terminal(
                input_tokens=20,
                output_tokens=10,
                total_tokens=30,
                reasoning_tokens=4,
                cache_read_input_tokens=2,
            ),
            _accepted_terminal(
                operation="media_summary",
                outcome="Failed",
                error_code="timeout",
                error_detail="codex generation failed: turn_timeout",
                session_ref=None,
            ),
            _accepted_terminal(
                operation="dawn_write",
                outcome="Cancelled",
                error_detail="codex generation cancelled",
                session_ref=None,
            ),
        )
    )
    with engine.begin() as connection:
        connection.execute(text(_INSERT_LEDGER_ROW), valid_rows)
        connection.execute(text("DELETE FROM llm_calls"))

    invalid_rows = (
        ("ck_llm_calls_generation_seq_positive", _ledger_row(generation_seq=0)),
        (
            "ck_llm_calls_owner_operation",
            _ledger_row(owner_kind="chat_run"),
        ),
        (
            "ck_llm_calls_plan_capability",
            _ledger_row(
                plan_id="standard",
                model_name="gpt-5.6-terra",
                reasoning_effort="medium",
            ),
        ),
        ("ck_llm_calls_route", _ledger_row(auth_profile="api-key")),
        (
            "ck_llm_calls_fingerprints",
            _ledger_row(request_fingerprint="A" * 64),
        ),
        (
            "ck_llm_calls_fingerprints",
            _ledger_row(tool_plan_fingerprint="e" * 64),
        ),
        (
            "ck_llm_calls_fingerprints",
            _ledger_row(operation="chat", tool_plan_fingerprint=None),
        ),
        (
            "ck_llm_calls_session_ref",
            _accepted_terminal(session_ref=_session_ref(transport="http")),
        ),
        (
            "ck_llm_calls_usage",
            _accepted_terminal(input_tokens=1, total_tokens=1),
        ),
        (
            "ck_llm_calls_lifecycle",
            _accepted_terminal(session_ref=None),
        ),
        (
            "ck_llm_calls_lifecycle",
            _accepted_terminal(
                outcome="Failed",
                error_detail="failed terminal missing normalized code",
                session_ref=None,
            ),
        ),
        (
            "ck_llm_calls_lifecycle",
            _ledger_row(completed_at="2026-08-24T12:00:01+00:00"),
        ),
    )
    for constraint_name, invalid_row in invalid_rows:
        with pytest.raises(IntegrityError, match=constraint_name):
            with engine.begin() as connection:
                connection.execute(text(_INSERT_LEDGER_ROW), invalid_row)


def _journal_state(*, phase: str, generation_id: UUID | None = None) -> dict[str, object]:
    return {
        "generation_id": str(generation_id or uuid4()),
        "dispatch_phase": phase,
        "request_fingerprint": {"kind": "Present", "value": "f" * 64},
        "terminal_result": (
            {"kind": "Present", "value": "pre-cutover terminal"}
            if phase == "Completed"
            else {"kind": "Absent"}
        ),
    }


def _insert_old_audit_rows(
    connection: object,
    *,
    call_id: UUID,
    turn_id: UUID,
    owner_id: UUID,
) -> None:
    connection.execute(
        text(
            """
            INSERT INTO llm_calls (
                id, owner_kind, owner_id, call_seq, provider, model_name,
                llm_operation, streaming, requested_reasoning, cost_status
            ) VALUES (
                :id, 'chat_run', :owner_id, 1, 'openai', 'gpt-5.6-luna',
                'chat', false, 'low', 'missing_usage'
            )
            """
        ),
        {"id": call_id, "owner_id": owner_id},
    )
    connection.execute(
        text(
            """
            INSERT INTO agent_turns (
                id, owner_kind, owner_id, turn_seq, operation, operation_revision,
                backend, transport, auth_profile, model_name, requested_reasoning,
                request_fingerprint, policy_fingerprint, output_schema_fingerprint
            ) VALUES (
                :id, 'media_enrichment', :owner_id, 1, 'metadata_enrichment',
                'metadata-enrichment.2026-08-12.4', 'codex', 'sdk', 'codex-personal',
                'gpt-5.6-luna', 'low', :request_fingerprint, :policy_fingerprint,
                :output_schema_fingerprint
            )
            """
        ),
        {
            "id": turn_id,
            "owner_id": owner_id,
            "request_fingerprint": "1" * 64,
            "policy_fingerprint": "2" * 64,
            "output_schema_fingerprint": "3" * 64,
        },
    )


def _preflight_fingerprint(
    engine: Engine,
    *,
    call_id: UUID,
    turn_id: UUID,
) -> tuple[object, ...]:
    inspector = inspect(engine)
    with engine.connect() as connection:
        return (
            connection.scalar(text("SELECT version_num FROM alembic_version")),
            tuple(sorted(column["name"] for column in inspector.get_columns("llm_calls"))),
            tuple(sorted(column["name"] for column in inspector.get_columns("chat_runs"))),
            tuple(sorted(inspector.get_table_names())),
            connection.scalar(
                text("SELECT count(*) FROM llm_calls WHERE id = :id"), {"id": call_id}
            ),
            connection.scalar(
                text("SELECT count(*) FROM agent_turns WHERE id = :id"), {"id": turn_id}
            ),
            connection.scalar(text("SELECT count(*) FROM background_jobs")),
            connection.scalar(text("SELECT count(*) FROM chat_runs")),
            connection.scalar(text("SELECT count(*) FROM artifact_builds")),
            connection.scalar(text("SELECT count(*) FROM artifact_learn_requests")),
        )


def _assert_refused_without_mutation(
    config: Config,
    engine: Engine,
    *,
    call_id: UUID,
    turn_id: UUID,
    blocker: str,
    expected_error: str = "0222 preflight",
) -> None:
    before = _preflight_fingerprint(engine, call_id=call_id, turn_id=turn_id)
    with pytest.raises(RuntimeError, match=expected_error):
        command.upgrade(config, _CUTOVER_REVISION)
    after = _preflight_fingerprint(engine, call_id=call_id, turn_id=turn_id)
    assert after == before, f"migration mutated state before refusing {blocker}"


def _seed_user_conversation(connection: object) -> dict[str, UUID]:
    ids = {
        "user": uuid4(),
        "conversation": uuid4(),
        "user_message": uuid4(),
        "assistant_message": uuid4(),
    }
    connection.execute(
        text("INSERT INTO users (id, email) VALUES (:id, :email)"),
        {"id": ids["user"], "email": f"generation-cutover-{ids['user']}@example.invalid"},
    )
    connection.execute(
        text("INSERT INTO conversations (id, owner_user_id) VALUES (:id, :owner)"),
        {"id": ids["conversation"], "owner": ids["user"]},
    )
    connection.execute(
        text(
            """
            INSERT INTO messages (
                id, conversation_id, seq, role, content, status, parent_message_id
            ) VALUES
                (:user_message, :conversation, 1, 'user', 'Preserve question',
                 'complete', NULL),
                (:assistant_message, :conversation, 2, 'assistant', 'Preserve answer',
                 'complete', :user_message)
            """
        ),
        ids,
    )
    return ids


def test_0222_refuses_every_active_or_uncertain_generation_owner_before_mutation(
    empty_migration_database_url: str,
) -> None:
    config = _migration_config()
    _require_cutover_revision(config)
    command.upgrade(config, _PREVIOUS_REVISION)
    engine = create_engine(empty_migration_database_url)
    call_id, turn_id, audit_owner_id = uuid4(), uuid4(), uuid4()
    try:
        with engine.begin() as connection:
            ids = _seed_user_conversation(connection)
            _insert_old_audit_rows(
                connection,
                call_id=call_id,
                turn_id=turn_id,
                owner_id=audit_owner_id,
            )

        for kind in _GENERATION_JOB_KINDS:
            for status in _ACTIVE_JOB_STATUSES:
                job_id = uuid4()
                with engine.begin() as connection:
                    connection.execute(
                        text(
                            """
                            INSERT INTO background_jobs (id, kind, payload, status, attempts)
                            VALUES (:id, :kind, '{}'::jsonb, :status, :attempts)
                            """
                        ),
                        {
                            "id": job_id,
                            "kind": kind,
                            "status": status,
                            "attempts": 0 if status == "pending" else 1,
                        },
                    )
                _assert_refused_without_mutation(
                    config,
                    engine,
                    call_id=call_id,
                    turn_id=turn_id,
                    blocker=f"{status} {kind}",
                )
                with engine.begin() as connection:
                    connection.execute(
                        text("DELETE FROM background_jobs WHERE id = :id"), {"id": job_id}
                    )

        for status in ("queued", "running"):
            run_id = uuid4()
            with engine.begin() as connection:
                connection.execute(
                    text(
                        """
                        INSERT INTO chat_runs (
                            id, owner_user_id, conversation_id, user_message_id,
                            assistant_message_id, idempotency_key, payload_hash, status
                        ) VALUES (
                            :id, :owner, :conversation, :user_message, :assistant_message,
                            :idempotency_key, 'preflight-payload', :status
                        )
                        """
                    ),
                    {
                        "id": run_id,
                        "owner": ids["user"],
                        "conversation": ids["conversation"],
                        "user_message": ids["user_message"],
                        "assistant_message": ids["assistant_message"],
                        "idempotency_key": f"preflight-{status}",
                        "status": status,
                    },
                )
            _assert_refused_without_mutation(
                config,
                engine,
                call_id=call_id,
                turn_id=turn_id,
                blocker=f"{status} chat run",
            )
            with engine.begin() as connection:
                connection.execute(text("DELETE FROM chat_runs WHERE id = :id"), {"id": run_id})

        artifact_id, build_id = uuid4(), uuid4()
        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO artifacts (
                        id, subject_scheme, subject_id, audience_scheme, audience_id
                    ) VALUES (:id, 'media', :subject_id, 'user', :audience_id)
                    """
                ),
                {
                    "id": artifact_id,
                    "subject_id": uuid4(),
                    "audience_id": str(ids["user"]),
                },
            )
            connection.execute(
                text(
                    """
                    INSERT INTO artifact_builds (
                        id, artifact_id, requester_user_id, idempotency_key
                    ) VALUES (:id, :artifact_id, :user_id, 'active-build')
                    """
                ),
                {"id": build_id, "artifact_id": artifact_id, "user_id": ids["user"]},
            )
        _assert_refused_without_mutation(
            config,
            engine,
            call_id=call_id,
            turn_id=turn_id,
            blocker="artifact build without terminal child",
        )
        with engine.begin() as connection:
            connection.execute(text("DELETE FROM artifact_builds WHERE id = :id"), {"id": build_id})
            connection.execute(text("DELETE FROM artifacts WHERE id = :id"), {"id": artifact_id})

        uncertain_job_id = uuid4()
        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO background_jobs (id, kind, payload, status, attempts)
                    VALUES (
                        :id, 'media_unit_build', CAST(:payload AS jsonb), 'succeeded', 1
                    )
                    """
                ),
                {
                    "id": uncertain_job_id,
                    "payload": _json(
                        {
                            "capacity_wait_index": 0,
                            "coordination": {"generation/1": _journal_state(phase="Uncertain")},
                        }
                    ),
                },
            )
        _assert_refused_without_mutation(
            config,
            engine,
            call_id=call_id,
            turn_id=turn_id,
            blocker="Uncertain terminal queue journal",
        )
        with engine.begin() as connection:
            connection.execute(
                text("DELETE FROM background_jobs WHERE id = :id"), {"id": uncertain_job_id}
            )

        highlight_id = uuid4()
        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO highlights (id, user_id, color, exact, prefix, suffix)
                    VALUES (:id, :user_id, 'yellow', 'idea', '', '')
                    """
                ),
                {"id": highlight_id, "user_id": ids["user"]},
            )

        learn_cases: tuple[tuple[str, dict[str, object]], ...] = (
            ("empty", {}),
            *(
                (phase.lower(), {"idea-resolution": _journal_state(phase=phase)})
                for phase in ("Prepared", "Uncertain", "Completed")
            ),
        )
        for label, coordination in learn_cases:
            learn_request_id = uuid4()
            with engine.begin() as connection:
                connection.execute(
                    text(
                        """
                        INSERT INTO artifact_learn_requests (
                            id, user_id, idempotency_key, request_hash, highlight_id, coordination
                        ) VALUES (
                            :id, :user_id, :idempotency_key, :request_hash, :highlight_id,
                            CAST(:coordination AS jsonb)
                        )
                        """
                    ),
                    {
                        "id": learn_request_id,
                        "user_id": ids["user"],
                        "idempotency_key": f"{label}-learn",
                        "request_hash": "a" * 64,
                        "highlight_id": highlight_id,
                        "coordination": _json(coordination),
                    },
                )
            _assert_refused_without_mutation(
                config,
                engine,
                call_id=call_id,
                turn_id=turn_id,
                blocker=f"{label} artifact Learn request",
                expected_error=rf"pending Learn requests.*{learn_request_id}",
            )
            with engine.begin() as connection:
                connection.execute(
                    text("DELETE FROM artifact_learn_requests WHERE id = :id"),
                    {"id": learn_request_id},
                )

        legacy_job_id = uuid4()
        legacy_generation_id = uuid4()
        legacy_target = {"provider": "openai", "model": "gpt-5.6-luna"}
        legacy_intent = {
            "target": legacy_target,
            "messages": [
                {
                    "kind": "Assistant",
                    "text": "legacy continuation",
                    "tool_calls": [],
                    "continuation": {
                        "kind": "Present",
                        "value": {
                            "target": legacy_target,
                            "codec_id": "openai.responses.v1",
                            "opaque_payload": {"response_id": "legacy-response"},
                        },
                    },
                }
            ],
            "max_output_tokens": 64,
            "reasoning": "low",
            "tools": [],
            "tool_choice": "none",
            "output": {"kind": "Text"},
            "provider_options": {},
        }
        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO background_jobs (id, kind, payload, status, attempts)
                    VALUES (:id, 'chat_run', CAST(:payload AS jsonb), 'succeeded', 1)
                    """
                ),
                {
                    "id": legacy_job_id,
                    "payload": _json(
                        {
                            "capacity_wait_index": 0,
                            "coordination": {
                                "prepare": {
                                    "generation_id": str(legacy_generation_id),
                                    "dispatch_phase": "Completed",
                                    "request_fingerprint": {
                                        "kind": "Present",
                                        "value": "b" * 64,
                                    },
                                    "terminal_result": {
                                        "kind": "Present",
                                        "value": _json({"generate_intent": legacy_intent}),
                                    },
                                }
                            },
                        }
                    ),
                },
            )
        _assert_refused_without_mutation(
            config,
            engine,
            call_id=call_id,
            turn_id=turn_id,
            blocker="drained job carrying GenerateIntentState/ContinuationState",
            expected_error=rf"GenerateIntentState or ContinuationState.*{legacy_job_id}",
        )
        with engine.begin() as connection:
            connection.execute(
                text("DELETE FROM background_jobs WHERE id = :id"), {"id": legacy_job_id}
            )
            connection.execute(text("DELETE FROM highlights WHERE id = :id"), {"id": highlight_id})
    finally:
        engine.dispose()


def _seed_drained_cutover(connection: object) -> dict[str, UUID]:
    ids = _seed_user_conversation(connection)
    ids.update(
        {
            "chat_run": uuid4(),
            "prompt": uuid4(),
            "dawn_write": uuid4(),
            "old_call": uuid4(),
            "old_turn": uuid4(),
        }
    )
    connection.execute(
        text(
            """
            INSERT INTO chat_runs (
                id, owner_user_id, conversation_id, user_message_id,
                assistant_message_id, idempotency_key, payload_hash, status,
                profile_id, reasoning_option_id, provider, model_name,
                reasoning_effort, error_origin
            ) VALUES (
                :chat_run, :user, :conversation, :user_message, :assistant_message,
                'preserved-run', 'preserved-payload', 'complete', 'balanced', 'medium',
                'openai', 'gpt-5.6-terra', 'medium', 'provider_response'
            )
            """
        ),
        ids,
    )
    connection.execute(
        text(
            """
            INSERT INTO chat_prompt_assemblies (
                id, chat_run_id, conversation_id, assistant_message_id,
                prompt_block_manifest, max_context_tokens, reserved_output_tokens,
                input_budget_tokens, estimated_input_tokens, included_message_ids,
                included_retrieval_ids, included_context_refs, dropped_items,
                budget_breakdown
            ) VALUES (
                :prompt, :chat_run, :conversation, :assistant_message,
                CAST(:prompt_manifest AS jsonb), 1050000, 128000, 922000, 100,
                CAST(:message_ids AS jsonb), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
                '{"source":"context-admission"}'::jsonb
            )
            """
        ),
        {
            **ids,
            "prompt_manifest": _json({"plan_bound": True}),
            "message_ids": _json([str(ids["user_message"])]),
        },
    )
    connection.execute(
        text(
            """
            INSERT INTO dawn_writes (id, user_id, local_date, body_md)
            VALUES (:dawn_write, :user, DATE '2026-08-24', 'Preserve durable dawn output')
            """
        ),
        ids,
    )
    _insert_old_audit_rows(
        connection,
        call_id=ids["old_call"],
        turn_id=ids["old_turn"],
        owner_id=ids["chat_run"],
    )
    connection.execute(
        text(
            """
            INSERT INTO token_budget_daily_usage (
                user_id, usage_date, spent_tokens, reserved_tokens
            ) VALUES (:user, DATE '2026-08-24', 90, 10)
            """
        ),
        ids,
    )
    connection.execute(
        text(
            """
            INSERT INTO token_budget_charges (
                reservation_id, user_id, usage_date, charged_tokens
            ) VALUES (:reservation_id, :user, DATE '2026-08-24', 90)
            """
        ),
        {**ids, "reservation_id": uuid4()},
    )
    connection.execute(
        text(
            """
            INSERT INTO token_budget_reservations (
                reservation_id, user_id, usage_date, reserved_tokens, expires_at
            ) VALUES (
                :reservation_id, :user, DATE '2026-08-24', 10,
                TIMESTAMPTZ '2026-08-25T00:00:00Z'
            )
            """
        ),
        {**ids, "reservation_id": uuid4()},
    )
    return ids


def _assert_final_ledger_schema(engine: Engine) -> None:
    inspector = inspect(engine)
    columns = {column["name"]: column for column in inspector.get_columns("llm_calls")}
    assert set(columns) == _FINAL_LEDGER_COLUMNS
    assert {name for name, column in columns.items() if not column["nullable"]} == (
        _NON_NULL_LEDGER_COLUMNS
    )

    assert isinstance(columns["id"]["type"], postgresql.UUID)
    assert isinstance(columns["owner_id"]["type"], postgresql.UUID)
    assert isinstance(columns["session_ref"]["type"], postgresql.JSONB)
    for name in ("created_at", "accepted_at", "completed_at"):
        assert columns[name]["type"].timezone is True
    assert not {
        "session_id",
        "mcp_session_id",
        "protocol_session_id",
        "provider",
        "upstream_provider",
        "error_origin",
        "provider_attempts",
        "attempt_count",
        "retry_count",
        "total_cost_usd_micros",
    } & set(columns)

    assert inspector.get_pk_constraint("llm_calls")["constrained_columns"] == ["id"]
    unique = {
        item["name"]: tuple(item["column_names"])
        for item in inspector.get_unique_constraints("llm_calls")
    }
    assert unique["uq_llm_calls_owner_generation_seq"] == (
        "owner_kind",
        "owner_id",
        "generation_seq",
    )
    indexes = {
        item["name"]: tuple(item["column_names"]) for item in inspector.get_indexes("llm_calls")
    }
    assert indexes["ix_llm_calls_owner"] == ("owner_kind", "owner_id")
    assert inspector.get_foreign_keys("llm_calls") == []

    assert {
        item["name"] for item in inspector.get_check_constraints("llm_calls")
    } == _LEDGER_CHECK_NAMES


def _post_cutover_fingerprint(engine: Engine, ids: dict[str, UUID]) -> tuple[object, ...]:
    inspector = inspect(engine)
    with engine.connect() as connection:
        return (
            connection.scalar(text("SELECT version_num FROM alembic_version")),
            tuple(sorted(inspector.get_table_names())),
            tuple(sorted(column["name"] for column in inspector.get_columns("llm_calls"))),
            tuple(sorted(column["name"] for column in inspector.get_columns("chat_runs"))),
            connection.scalar(text("SELECT count(*) FROM llm_calls")),
            connection.execute(
                text("SELECT role, content FROM messages WHERE conversation_id = :id ORDER BY seq"),
                {"id": ids["conversation"]},
            ).all(),
            connection.scalar(
                text("SELECT body_md FROM dawn_writes WHERE id = :id"),
                {"id": ids["dawn_write"]},
            ),
            connection.scalar(
                text("SELECT reserved_output_tokens FROM chat_prompt_assemblies WHERE id = :id"),
                {"id": ids["prompt"]},
            ),
        )


def test_0222_deletes_old_audit_and_billing_state_but_preserves_domain_outputs(
    empty_migration_database_url: str,
) -> None:
    config = _migration_config()
    _require_cutover_revision(config)
    command.upgrade(config, _PREVIOUS_REVISION)
    engine = create_engine(empty_migration_database_url)
    try:
        with engine.begin() as connection:
            ids = _seed_drained_cutover(connection)

        command.upgrade(config, _CUTOVER_REVISION)

        inspector = inspect(engine)
        tables = set(inspector.get_table_names())
        assert {
            "agent_turns",
            "token_budget_daily_usage",
            "token_budget_charges",
            "token_budget_reservations",
        }.isdisjoint(tables)
        assert "rate_limit_inflight" in tables

        chat_columns = {column["name"]: column for column in inspector.get_columns("chat_runs")}
        assert {"reasoning_option_id", "provider", "error_origin"}.isdisjoint(chat_columns)
        assert {"profile_id", "model_name", "reasoning_effort"} <= set(chat_columns)

        prompt_columns = {
            column["name"]: column for column in inspector.get_columns("chat_prompt_assemblies")
        }
        assert "reserved_output_tokens" in prompt_columns
        assert prompt_columns["reserved_output_tokens"]["nullable"] is False

        _assert_final_ledger_schema(engine)
        _assert_ledger_constraints(engine)
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == (
                _CUTOVER_REVISION
            )
            assert connection.scalar(text("SELECT count(*) FROM llm_calls")) == 0
            assert connection.execute(
                text(
                    """
                    SELECT profile_id, model_name, reasoning_effort, status
                    FROM chat_runs WHERE id = :id
                    """
                ),
                {"id": ids["chat_run"]},
            ).one() == ("balanced", "gpt-5.6-terra", "medium", "complete")
            assert connection.execute(
                text("SELECT role, content FROM messages WHERE conversation_id = :id ORDER BY seq"),
                {"id": ids["conversation"]},
            ).all() == [("user", "Preserve question"), ("assistant", "Preserve answer")]
            assert (
                connection.scalar(
                    text("SELECT body_md FROM dawn_writes WHERE id = :id"),
                    {"id": ids["dawn_write"]},
                )
                == "Preserve durable dawn output"
            )
            assert (
                connection.scalar(
                    text(
                        "SELECT reserved_output_tokens FROM chat_prompt_assemblies WHERE id = :id"
                    ),
                    {"id": ids["prompt"]},
                )
                == 128000
            )

        # The preserved row predates the v2 generation ledger and chat-tool
        # snapshot. Its old profile/model strings remain historical display
        # facts, never authority for a fresh billable action.
        with Session(engine) as db:
            preserved_run = db.get(ChatRun, ids["chat_run"])
            assert preserved_run is not None
            assert profile_selection_active(db, preserved_run) is False
            assert (
                regeneratable_assistant_message_ids(
                    db,
                    viewer_id=ids["user"],
                    assistant_message_ids=[ids["assistant_message"]],
                )
                == set()
            )
            with pytest.raises(ApiError) as regenerate_error:
                regenerate_assistant_response(
                    db,
                    viewer_id=ids["user"],
                    assistant_message_id=ids["assistant_message"],
                    idempotency_key=f"pre-cutover-regenerate-{uuid4()}",
                )
            assert regenerate_error.value.code is ApiErrorCode.E_REGENERATION_NOT_ALLOWED

            # Exercise the other terminal action against the same pre-cutover
            # identity: cancellation status can make a current run rerunnable
            # only when the full ledger-backed profile selection is active.
            preserved_run = db.get(ChatRun, ids["chat_run"])
            preserved_message = db.get(Message, ids["assistant_message"])
            assert preserved_run is not None and preserved_message is not None
            preserved_run.status = "cancelled"
            preserved_message.status = "cancelled"
            db.commit()
            assert profile_selection_active(db, preserved_run) is False
            assert (
                rerunnable_assistant_message_ids(
                    db,
                    viewer_id=ids["user"],
                    assistant_message_ids=[ids["assistant_message"]],
                )
                == set()
            )
            with pytest.raises(ApiError) as rerun_error:
                rerun_assistant_response(
                    db,
                    viewer_id=ids["user"],
                    assistant_message_id=ids["assistant_message"],
                    idempotency_key=f"pre-cutover-rerun-{uuid4()}",
                )
            assert rerun_error.value.code is ApiErrorCode.E_RETRY_NOT_ALLOWED

        before_downgrade = _post_cutover_fingerprint(engine, ids)
        with pytest.raises(NotImplementedError, match="0222.*irreversible"):
            command.downgrade(config, _PREVIOUS_REVISION)
        assert _post_cutover_fingerprint(engine, ids) == before_downgrade, (
            "0222 downgrade mutated the irreversible cutover before refusing"
        )
    finally:
        engine.dispose()
