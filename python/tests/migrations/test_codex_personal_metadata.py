"""Real-PostgreSQL proof for the Codex-personal durable turn ledger cutover."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker


def _migration_config() -> Config:
    migration_root = Path(__file__).parents[3] / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    return config


def test_0216_hard_cuts_metadata_calls_and_owns_exact_agent_turn_lifecycle(
    empty_migration_database_url: str,
) -> None:
    migration_file = (
        Path(__file__).parents[3] / "migrations/alembic/versions/0216_codex_personal_metadata.py"
    )
    assert migration_file.is_file(), "the Codex-personal metadata hard-cut migration is missing"

    from nexus.services.agent_turn_ledger import (
        AgentTurnOwner,
        AgentTurnStart,
        AgentTurnTerminal,
        complete_turn_in_current_transaction,
        start_turn,
    )

    config = _migration_config()
    scripts = ScriptDirectory.from_config(config)
    revision = scripts.get_revision("0216")
    assert revision is not None
    assert revision.down_revision == "0215"
    heads = scripts.get_heads()
    assert len(heads) == 1
    successors = tuple(scripts.iterate_revisions(heads[0], "0216"))
    assert successors, "0216 must remain a strict ancestor of the current head"
    assert successors[-1].down_revision == "0216"
    command.upgrade(config, "0215")

    removed_call_id = uuid4()
    retained_call_id = uuid4()
    pending_metadata_job_id = uuid4()
    dead_metadata_job_id = uuid4()
    reclaimable_metadata_job_id = uuid4()
    owner_id = uuid4()
    engine = create_engine(empty_migration_database_url)
    factory = sessionmaker(engine, expire_on_commit=False)
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO llm_calls (
                        id, owner_kind, owner_id, call_seq, provider, model_name,
                        llm_operation, streaming, cost_status
                    ) VALUES
                        (:removed_id, 'media_enrichment', :owner_id, 1, 'openai',
                         'gpt-5.4-mini', 'metadata_enrichment', false, 'missing_usage'),
                        (:retained_id, 'chat_run', :owner_id, 1, 'openai',
                         'gpt-5.4', 'chat_answer', true, 'missing_usage')
                    """
                ),
                {
                    "removed_id": removed_call_id,
                    "retained_id": retained_call_id,
                    "owner_id": owner_id,
                },
            )
            connection.execute(
                text(
                    """
                    INSERT INTO background_jobs (
                        id, kind, payload, status, attempts, max_attempts,
                        claimed_by, lease_expires_at, finished_at
                    ) VALUES
                        (:pending_id, 'enrich_metadata',
                         jsonb_build_object('media_id', CAST(:owner_id AS text)),
                         'pending', 0, 2, NULL, NULL, NULL),
                        (:dead_id, 'enrich_metadata',
                         jsonb_build_object(
                             'media_id', CAST(:owner_id AS text),
                             'capacity_wait_index', 99
                         ),
                         'dead', 2, 2, NULL, NULL, now()),
                        (:reclaimable_id, 'enrich_metadata',
                         jsonb_build_object('media_id', CAST(:owner_id AS text)),
                         'running', 1, 1, 'legacy-worker',
                         now() - interval '5 minutes', NULL)
                    """
                ),
                {
                    "pending_id": pending_metadata_job_id,
                    "dead_id": dead_metadata_job_id,
                    "reclaimable_id": reclaimable_metadata_job_id,
                    "owner_id": owner_id,
                },
            )

        command.upgrade(config, "0216")

        inspector = inspect(engine)
        columns = {column["name"]: column for column in inspector.get_columns("agent_turns")}
        assert set(columns) == {
            "id",
            "owner_kind",
            "owner_id",
            "turn_seq",
            "operation",
            "operation_revision",
            "backend",
            "transport",
            "auth_profile",
            "model_name",
            "requested_reasoning",
            "request_fingerprint",
            "policy_fingerprint",
            "output_schema_fingerprint",
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
            "created_at",
            "completed_at",
        }
        assert {name for name, column in columns.items() if column["nullable"]} == {
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
            "completed_at",
        }
        assert inspector.get_pk_constraint("agent_turns")["constrained_columns"] == ["id"]
        assert {
            (constraint["name"], tuple(constraint["column_names"]))
            for constraint in inspector.get_unique_constraints("agent_turns")
        } == {("uq_agent_turns_owner_turn_seq", ("owner_kind", "owner_id", "turn_seq"))}
        assert inspector.get_check_constraints("agent_turns") == []

        llm_owner_check = next(
            constraint
            for constraint in inspector.get_check_constraints("llm_calls")
            if constraint["name"] == "ck_llm_calls_owner_kind"
        )
        assert "media_enrichment" not in llm_owner_check["sqltext"]
        assert "chat_run" in llm_owner_check["sqltext"]
        with engine.connect() as connection:
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM llm_calls WHERE id = :id"),
                    {"id": removed_call_id},
                )
                == 0
            )
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM llm_calls WHERE id = :id"),
                    {"id": retained_call_id},
                )
                == 1
            )
            capacity_payloads = connection.execute(
                text(
                    """
                    SELECT id, status, max_attempts, payload
                    FROM background_jobs
                    WHERE id IN (:pending_id, :dead_id, :reclaimable_id)
                    ORDER BY status
                    """
                ),
                {
                    "pending_id": pending_metadata_job_id,
                    "dead_id": dead_metadata_job_id,
                    "reclaimable_id": reclaimable_metadata_job_id,
                },
            ).all()
            assert capacity_payloads == [
                (
                    dead_metadata_job_id,
                    "dead",
                    2,
                    {"media_id": str(owner_id), "capacity_wait_index": 0},
                ),
                (
                    pending_metadata_job_id,
                    "pending",
                    2,
                    {"media_id": str(owner_id), "capacity_wait_index": 0},
                ),
                (
                    reclaimable_metadata_job_id,
                    "running",
                    2,
                    {"media_id": str(owner_id), "capacity_wait_index": 0},
                ),
            ]

        from nexus.jobs.queue import claim_job, complete_job

        with factory() as db:
            reclaimed = claim_job(
                db,
                job_id=reclaimable_metadata_job_id,
                worker_id="codex-metadata-migration-proof",
                lease_seconds=300,
                heavy_kinds=("enrich_metadata",),
                allowed_kinds=("enrich_metadata",),
            )
            assert reclaimed is not None
            assert (reclaimed.status, reclaimed.attempts, reclaimed.max_attempts) == (
                "running",
                2,
                2,
            )
            assert complete_job(
                db,
                job_id=reclaimable_metadata_job_id,
                worker_id="codex-metadata-migration-proof",
            )
            db.commit()

        turn_id = UUID("25cb8dd3-7be6-51fe-9964-abfa29334031")
        owner = AgentTurnOwner(kind="media_enrichment", id=owner_id)
        started = AgentTurnStart(
            id=turn_id,
            owner=owner,
            operation="metadata_enrichment",
            operation_revision="metadata-enrichment.v1",
            backend="codex",
            transport="sdk",
            auth_profile="codex-personal",
            model_name="gpt-5.6-luna",
            requested_reasoning="low",
            request_fingerprint="1" * 64,
            policy_fingerprint="2" * 64,
            output_schema_fingerprint="3" * 64,
        )
        assert start_turn(factory, started) == turn_id
        assert start_turn(factory, started) == turn_id
        with pytest.raises(AssertionError, match="different immutable start facts"):
            start_turn(factory, replace(started, model_name="gpt-5.6-terra"))

        session_ref = {
            "schema_version": "agent-session-ref.v1",
            "backend": "codex",
            "transport": "sdk",
            "native_session_id": "thread-metadata-1",
            "profile_key": "codex-personal",
            "state_root_fingerprint": "4" * 64,
            "cwd_fingerprint": "5" * 64,
        }
        terminal = AgentTurnTerminal(
            outcome="succeeded",
            session_ref=session_ref,
            error_code=None,
            error_detail=None,
            input_tokens=80,
            output_tokens=20,
            total_tokens=100,
            reasoning_tokens=5,
            cache_read_input_tokens=None,
            cache_write_input_tokens=None,
            sdk_version="0.144.4",
            runtime_version="0.144.4",
        )
        with factory() as db:
            complete_turn_in_current_transaction(db, turn_id, terminal)
            db.commit()
        with pytest.raises(AssertionError, match="already has terminal outcome"):
            with factory() as db:
                complete_turn_in_current_transaction(db, turn_id, terminal)

        second_id = uuid4()
        start_turn(factory, replace(started, id=second_id))
        with factory() as db:
            complete_turn_in_current_transaction(
                db,
                second_id,
                AgentTurnTerminal(
                    outcome="failed",
                    session_ref=None,
                    error_code="quota_exhausted",
                    error_detail="x" * 1200,
                    input_tokens=None,
                    output_tokens=None,
                    total_tokens=None,
                    reasoning_tokens=None,
                    cache_read_input_tokens=None,
                    cache_write_input_tokens=None,
                    sdk_version="0.144.4",
                    runtime_version="0.144.4",
                ),
            )
            db.commit()

        with engine.connect() as connection:
            stored = (
                connection.execute(
                    text(
                        """
                    SELECT turn_seq, session_ref, outcome, error_code, error_detail,
                           input_tokens, output_tokens, total_tokens, reasoning_tokens,
                           cache_read_input_tokens, cache_write_input_tokens,
                           sdk_version, runtime_version, completed_at
                    FROM agent_turns
                    WHERE id = :id
                    """
                    ),
                    {"id": turn_id},
                )
                .mappings()
                .one()
            )
            failed = (
                connection.execute(
                    text(
                        "SELECT turn_seq, outcome, error_code, error_detail "
                        "FROM agent_turns WHERE id = :id"
                    ),
                    {"id": second_id},
                )
                .mappings()
                .one()
            )
        assert dict(stored) == {
            "turn_seq": 1,
            "session_ref": session_ref,
            "outcome": "succeeded",
            "error_code": None,
            "error_detail": None,
            "input_tokens": 80,
            "output_tokens": 20,
            "total_tokens": 100,
            "reasoning_tokens": 5,
            "cache_read_input_tokens": None,
            "cache_write_input_tokens": None,
            "sdk_version": "0.144.4",
            "runtime_version": "0.144.4",
            "completed_at": stored["completed_at"],
        }
        assert stored["completed_at"] is not None
        assert dict(failed) == {
            "turn_seq": 2,
            "outcome": "failed",
            "error_code": "quota_exhausted",
            "error_detail": "x" * 1000,
        }

        preaccept_id = uuid4()
        start_turn(factory, replace(started, id=preaccept_id))
        with factory() as db:
            complete_turn_in_current_transaction(
                db,
                preaccept_id,
                AgentTurnTerminal(
                    outcome="failed",
                    session_ref=None,
                    error_code="host_unavailable",
                    error_detail="native agent host was unavailable before acceptance",
                    input_tokens=None,
                    output_tokens=None,
                    total_tokens=None,
                    reasoning_tokens=None,
                    cache_read_input_tokens=None,
                    cache_write_input_tokens=None,
                    sdk_version=None,
                    runtime_version=None,
                ),
            )
            db.commit()
        with engine.connect() as connection:
            assert connection.execute(
                text(
                    "SELECT outcome, error_code, sdk_version, runtime_version "
                    "FROM agent_turns WHERE id = :id"
                ),
                {"id": preaccept_id},
            ).one() == ("failed", "host_unavailable", None, None)
    finally:
        engine.dispose()
