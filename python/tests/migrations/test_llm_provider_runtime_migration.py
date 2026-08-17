"""0215 proof: the v2 provider ledger cutover is strict and lossless."""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text


def _migration_config() -> Config:
    migration_root = Path(__file__).parents[3] / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    return config


def _json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def test_0215_refuses_every_non_succeeded_chat_journal_before_mutation(
    empty_migration_database_url: str,
) -> None:
    config = _migration_config()
    command.upgrade(config, "0214")
    engine = create_engine(empty_migration_database_url)
    job_ids = {status: uuid4() for status in ("pending", "running", "failed", "dead")}
    try:
        with engine.begin() as connection:
            for status, job_id in job_ids.items():
                connection.execute(
                    text(
                        """
                        INSERT INTO background_jobs (id, kind, payload, status, attempts)
                        VALUES (:id, 'chat_run', CAST(:payload AS jsonb), :status, :attempts)
                        """
                    ),
                    {
                        "id": job_id,
                        "payload": _json(
                            {
                                "coordination": {
                                    "generation": {
                                        "request_fingerprint": {
                                            "kind": "Present",
                                            "value": status * 8,
                                        }
                                    }
                                }
                            }
                        ),
                        "status": status,
                        "attempts": 0 if status == "pending" else 1,
                    },
                )

        before_columns = {column["name"] for column in inspect(engine).get_columns("llm_calls")}
        with pytest.raises(RuntimeError, match="non-succeeded chat_run"):
            command.upgrade(config, "0215")

        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0214"
            retained = dict(
                connection.execute(
                    text(
                        "SELECT status, id FROM background_jobs "
                        "WHERE kind = 'chat_run' ORDER BY status"
                    )
                )
                .tuples()
                .all()
            )
        assert retained == {status: job_ids[status] for status in sorted(job_ids)}
        assert {column["name"] for column in inspect(engine).get_columns("llm_calls")} == (
            before_columns
        )
        assert "requested_reasoning" not in before_columns
        assert "reasoning_effort" in before_columns
    finally:
        engine.dispose()


def test_0215_refuses_running_non_chat_llm_jobs_before_mutation(
    empty_migration_database_url: str,
) -> None:
    config = _migration_config()
    command.upgrade(config, "0214")
    engine = create_engine(empty_migration_database_url)
    job_id = uuid4()
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO background_jobs (id, kind, payload, status, attempts)
                    VALUES (:id, 'dossier_build', '{}'::jsonb, 'running', 1)
                    """
                ),
                {"id": job_id},
            )

        before_columns = {column["name"] for column in inspect(engine).get_columns("llm_calls")}
        with pytest.raises(RuntimeError, match="running non-chat LLM job"):
            command.upgrade(config, "0215")

        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0214"
            assert (
                connection.scalar(
                    text("SELECT status FROM background_jobs WHERE id = :id"),
                    {"id": job_id},
                )
                == "running"
            )
        assert {column["name"] for column in inspect(engine).get_columns("llm_calls")} == (
            before_columns
        )
    finally:
        engine.dispose()


def test_0215_rewrites_only_retired_provider_facts_and_preserves_durable_state(
    empty_migration_database_url: str,
) -> None:
    config = _migration_config()
    scripts = ScriptDirectory.from_config(config)
    assert scripts.get_current_head() == "0217"
    command.upgrade(config, "0214")

    user_id = uuid4()
    conversation_id = uuid4()
    user_message_id = uuid4()
    assistant_message_id = uuid4()
    chat_run_id = uuid4()
    event_id = uuid4()
    prompt_id = uuid4()
    committed_call_id = uuid4()
    uncommitted_call_id = uuid4()
    succeeded_chat_job_id = uuid4()
    retained_job_id = uuid4()
    replay_fingerprint = "f" * 64

    manifest = {
        "cacheable_input_tokens_estimate": 30,
        "manifest_owner": "retained",
        "blocks": [
            {
                "id": "system",
                "role": "system",
                "cache_policy": {"ttl": "5m"},
                "privacy_scope": "global",
                "required_provider_capability": "prompt_caching",
                "source_refs": [{"kind": "retained-source"}],
            },
            {
                "id": "user",
                "role": "user",
                "cache_policy": None,
                "privacy_scope": "conversation",
                "source_refs": [],
            },
        ],
    }
    dropped_items = [
        {
            "key": "old-context",
            "reason": "budget_exceeded",
            "metadata": {"retained": True},
            "blocks": [
                {
                    "id": "dropped",
                    "cache_policy": {"ttl": "5m"},
                    "privacy_scope": "conversation",
                    "required_provider_capability": "prompt_caching",
                    "source_refs": [{"kind": "retained-drop-source"}],
                }
            ],
        }
    ]
    budget_breakdown = {
        "remaining_tokens": 100,
        "input_budget_tokens": 700,
        "reserved_output_tokens": 200,
        "reserved_reasoning_tokens": 100,
        "lanes": {"current_user": {"included_tokens": 10}},
    }

    engine = create_engine(empty_migration_database_url)
    try:
        with engine.begin() as connection:
            connection.execute(
                text("INSERT INTO users (id, email) VALUES (:id, :email)"),
                {"id": user_id, "email": f"llm-cutover-{user_id}@example.invalid"},
            )
            connection.execute(
                text("INSERT INTO conversations (id, owner_user_id) VALUES (:id, :user_id)"),
                {"id": conversation_id, "user_id": user_id},
            )
            connection.execute(
                text(
                    """
                    INSERT INTO messages (
                        id, conversation_id, seq, role, content, status, parent_message_id
                    )
                    VALUES
                        (:user_message_id, :conversation_id, 1, 'user', 'Question',
                         'complete', NULL),
                        (:assistant_message_id, :conversation_id, 2, 'assistant', 'Answer',
                         'complete', :user_message_id)
                    """
                ),
                {
                    "user_message_id": user_message_id,
                    "assistant_message_id": assistant_message_id,
                    "conversation_id": conversation_id,
                },
            )
            connection.execute(
                text(
                    """
                    INSERT INTO chat_runs (
                        id, owner_user_id, conversation_id, user_message_id,
                        assistant_message_id, idempotency_key, payload_hash, status
                    ) VALUES (
                        :id, :owner_user_id, :conversation_id, :user_message_id,
                        :assistant_message_id, 'migration-proof', 'payload-hash', 'complete'
                    )
                    """
                ),
                {
                    "id": chat_run_id,
                    "owner_user_id": user_id,
                    "conversation_id": conversation_id,
                    "user_message_id": user_message_id,
                    "assistant_message_id": assistant_message_id,
                },
            )
            connection.execute(
                text(
                    """
                    INSERT INTO chat_run_events (id, run_id, seq, event_type, payload)
                    VALUES (:id, :run_id, 1, 'done', '{}'::jsonb)
                    """
                ),
                {"id": event_id, "run_id": chat_run_id},
            )
            connection.execute(
                text(
                    """
                    INSERT INTO chat_prompt_assemblies (
                        id, chat_run_id, conversation_id, assistant_message_id,
                        cacheable_input_tokens_estimate, prompt_block_manifest,
                        max_context_tokens, reserved_output_tokens,
                        reserved_reasoning_tokens, input_budget_tokens,
                        estimated_input_tokens, included_message_ids,
                        included_retrieval_ids, included_context_refs, dropped_items,
                        budget_breakdown
                    ) VALUES (
                        :id, :chat_run_id, :conversation_id, :assistant_message_id,
                        30, CAST(:manifest AS jsonb), 1000, 200, 100, 700, 600,
                        '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
                        CAST(:dropped_items AS jsonb), CAST(:budget_breakdown AS jsonb)
                    )
                    """
                ),
                {
                    "id": prompt_id,
                    "chat_run_id": chat_run_id,
                    "conversation_id": conversation_id,
                    "assistant_message_id": assistant_message_id,
                    "manifest": _json(manifest),
                    "dropped_items": _json(dropped_items),
                    "budget_breakdown": _json(budget_breakdown),
                },
            )
            connection.execute(
                text(
                    """
                    INSERT INTO llm_calls (
                        id, owner_kind, owner_id, call_seq, provider, model_name,
                        llm_operation, streaming, reasoning_effort,
                        input_tokens, output_tokens, total_tokens, reasoning_tokens,
                        cache_write_input_tokens, cache_read_input_tokens,
                        cached_input_tokens, catalog_revision, request_fingerprint,
                        cache_strategy, cache_ttl, input_cost_usd_micros,
                        output_cost_usd_micros, cache_write_cost_usd_micros,
                        cache_read_cost_usd_micros, reasoning_cost_usd_micros,
                        total_cost_usd_micros, cost_status, pricing_snapshot,
                        provider_usage
                    ) VALUES (
                        :committed_id, 'chat_run', :owner_id, 1, 'openai',
                        'gpt-5.6-luna', 'chat', false, 'high',
                        100, 10, 110, 5, 10, 20, 20,
                        'legacy-catalog-1', 'legacy-provider-fingerprint',
                        'stable-prefix', '5m', 80, 60, 3, 2, 0, 145,
                        'estimated', '{"source":"legacy"}'::jsonb,
                        '{"retired":"raw-provider-shape"}'::jsonb
                    ), (
                        :uncommitted_id, 'chat_run', :owner_id, 2, 'openai',
                        'gpt-5.6-luna', 'chat', false, 'low',
                        NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                        'not_token_priced', NULL, NULL
                    )
                    """
                ),
                {
                    "committed_id": committed_call_id,
                    "uncommitted_id": uncommitted_call_id,
                    "owner_id": chat_run_id,
                },
            )
            connection.execute(
                text(
                    """
                    INSERT INTO background_jobs (id, kind, payload, status)
                    VALUES
                        (:chat_job_id, 'chat_run', CAST(:chat_payload AS jsonb), 'succeeded'),
                        (:retained_job_id, 'dossier_build', CAST(:retained_payload AS jsonb), 'pending')
                    """
                ),
                {
                    "chat_job_id": succeeded_chat_job_id,
                    "chat_payload": _json({"old_intent": True}),
                    "retained_job_id": retained_job_id,
                    "retained_payload": _json(
                        {
                            "coordination": {
                                "generation": {
                                    "generation_id": str(committed_call_id),
                                    "dispatch_phase": "Prepared",
                                    "request_fingerprint": {
                                        "kind": "Present",
                                        "value": replay_fingerprint,
                                    },
                                    "terminal_result": {"kind": "Absent"},
                                }
                            }
                        }
                    ),
                },
            )

        command.upgrade(config, "0215")

        inspector = inspect(engine)
        llm_columns = {column["name"] for column in inspector.get_columns("llm_calls")}
        prompt_columns = {
            column["name"] for column in inspector.get_columns("chat_prompt_assemblies")
        }
        llm_checks = {item["name"] for item in inspector.get_check_constraints("llm_calls")}
        prompt_checks = {
            item["name"] for item in inspector.get_check_constraints("chat_prompt_assemblies")
        }

        with engine.connect() as connection:
            actual_head = connection.scalar(text("SELECT version_num FROM alembic_version"))
            domain_counts = connection.execute(
                text(
                    """
                    SELECT
                        (SELECT count(*) FROM users WHERE id = :user_id),
                        (SELECT count(*) FROM conversations WHERE id = :conversation_id),
                        (SELECT count(*) FROM messages
                            WHERE id IN (:user_message_id, :assistant_message_id)),
                        (SELECT count(*) FROM chat_runs WHERE id = :chat_run_id),
                        (SELECT count(*) FROM chat_run_events WHERE id = :event_id),
                        (SELECT count(*) FROM llm_calls
                            WHERE id IN (:committed_call_id, :uncommitted_call_id))
                    """
                ),
                {
                    "user_id": user_id,
                    "conversation_id": conversation_id,
                    "user_message_id": user_message_id,
                    "assistant_message_id": assistant_message_id,
                    "chat_run_id": chat_run_id,
                    "event_id": event_id,
                    "committed_call_id": committed_call_id,
                    "uncommitted_call_id": uncommitted_call_id,
                },
            ).one()
            calls = connection.execute(
                text(
                    """
                    SELECT id, requested_reasoning, native_reasoning,
                           registry_revision, total_cost_usd_micros, cost_status,
                           cost_source, cost_as_of
                    FROM llm_calls
                    WHERE id IN (:committed_call_id, :uncommitted_call_id)
                    ORDER BY call_seq
                    """
                ),
                {
                    "committed_call_id": committed_call_id,
                    "uncommitted_call_id": uncommitted_call_id,
                },
            ).all()
            rewritten_prompt = connection.execute(
                text(
                    """
                    SELECT prompt_block_manifest, dropped_items, budget_breakdown
                    FROM chat_prompt_assemblies WHERE id = :id
                    """
                ),
                {"id": prompt_id},
            ).one()
            jobs = connection.execute(
                text(
                    "SELECT id, kind, status, payload FROM background_jobs "
                    "WHERE id IN (:chat_job_id, :retained_job_id) ORDER BY kind"
                ),
                {"chat_job_id": succeeded_chat_job_id, "retained_job_id": retained_job_id},
            ).all()
            residue_count = connection.scalar(
                text(
                    """
                    SELECT count(*) FROM chat_prompt_assemblies
                    WHERE prompt_block_manifest @? '$.**.cacheable_input_tokens_estimate'
                       OR prompt_block_manifest @? '$.**.cache_policy'
                       OR prompt_block_manifest @? '$.**.privacy_scope'
                       OR prompt_block_manifest @? '$.**.required_provider_capability'
                       OR dropped_items @? '$.**.cache_policy'
                       OR dropped_items @? '$.**.privacy_scope'
                       OR dropped_items @? '$.**.required_provider_capability'
                       OR budget_breakdown @? '$.**.reserved_reasoning_tokens'
                    """
                )
            )

        assert actual_head == "0215"
        assert domain_counts == (1, 1, 2, 1, 1, 2)
        assert calls == [
            (
                committed_call_id,
                None,
                "high",
                None,
                145,
                "estimated",
                "provider-runtime-v1",
                None,
            ),
            (
                uncommitted_call_id,
                None,
                None,
                None,
                None,
                "missing_pricing",
                None,
                None,
            ),
        ]
        assert rewritten_prompt.prompt_block_manifest == {
            "manifest_owner": "retained",
            "blocks": [
                {
                    "id": "system",
                    "role": "system",
                    "source_refs": [{"kind": "retained-source"}],
                },
                {"id": "user", "role": "user", "source_refs": []},
            ],
        }
        assert rewritten_prompt.dropped_items == [
            {
                "key": "old-context",
                "reason": "budget_exceeded",
                "metadata": {"retained": True},
                "blocks": [
                    {
                        "id": "dropped",
                        "source_refs": [{"kind": "retained-drop-source"}],
                    }
                ],
            }
        ]
        assert rewritten_prompt.budget_breakdown == {
            "remaining_tokens": 100,
            "input_budget_tokens": 700,
            "reserved_output_tokens": 200,
            "lanes": {"current_user": {"included_tokens": 10}},
        }
        assert jobs == [
            (
                retained_job_id,
                "dossier_build",
                "pending",
                {
                    "coordination": {
                        "generation": {
                            "generation_id": str(committed_call_id),
                            "dispatch_phase": "Prepared",
                            "request_fingerprint": {
                                "kind": "Present",
                                "value": replay_fingerprint,
                            },
                            "terminal_result": {"kind": "Absent"},
                        }
                    }
                },
            )
        ]
        assert residue_count == 0

        assert {
            "requested_reasoning",
            "native_reasoning",
            "registry_revision",
            "cost_source",
            "cost_as_of",
        } <= llm_columns
        assert (
            not {
                "reasoning_effort",
                "catalog_revision",
                "request_fingerprint",
                "cache_strategy",
                "cache_ttl",
                "cached_input_tokens",
                "input_cost_usd_micros",
                "output_cost_usd_micros",
                "cache_write_cost_usd_micros",
                "cache_read_cost_usd_micros",
                "reasoning_cost_usd_micros",
                "pricing_snapshot",
                "provider_usage",
            }
            & llm_columns
        )
        assert not {"cacheable_input_tokens_estimate", "reserved_reasoning_tokens"} & (
            prompt_columns
        )
        assert (
            not {
                "ck_llm_calls_token_counts_non_negative",
                "ck_llm_calls_provider_usage_object",
                "ck_llm_calls_cost_status",
                "ck_llm_calls_input_cost_non_negative",
                "ck_llm_calls_output_cost_non_negative",
                "ck_llm_calls_cache_write_cost_non_negative",
                "ck_llm_calls_cache_read_cost_non_negative",
                "ck_llm_calls_reasoning_cost_non_negative",
                "ck_llm_calls_pricing_snapshot_object",
            }
            & llm_checks
        )
        assert (
            not {
                "ck_chat_prompt_assemblies_token_budget",
                "ck_chat_prompt_assemblies_cacheable_tokens",
            }
            & prompt_checks
        )
    finally:
        engine.dispose()
