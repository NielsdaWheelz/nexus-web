"""Focused PostgreSQL admission proof for the destructive generation reset."""

import json
import re
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, text


def _migration_config() -> Config:
    migration_root = Path(__file__).parents[3] / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    return config


def test_0224_refuses_the_only_undrained_generation_job_before_history_reset(
    request: pytest.FixtureRequest,
) -> None:
    """Risk: destructive history reset admits live or ambiguous generation work."""

    config = _migration_config()
    reset_revision = next(
        (
            revision
            for revision in ScriptDirectory.from_config(config).walk_revisions()
            if revision.revision == "0224"
        ),
        None,
    )
    assert reset_revision is not None, (
        "generation-backends reset revision 0224 is absent before undrained-work "
        "admission can be proved"
    )

    migration_database_url = str(request.getfixturevalue("empty_migration_database_url"))
    command.upgrade(config, "0223")
    engine = create_engine(migration_database_url)
    generation_job_id = uuid4()
    enrichment_job_id = uuid4()
    minimal_enrichment_job_id = uuid4()
    llm_call_id = uuid4()
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO background_jobs (id, kind, payload, status, attempts) "
                    "VALUES (:job_id, 'chat_run', '{}'::jsonb, 'pending', 0)"
                ),
                {"job_id": generation_job_id},
            )

        expected_error = f"0224 preflight: generation jobs must be drained: ['{generation_job_id}']"
        with pytest.raises(RuntimeError, match=rf"^{re.escape(expected_error)}$"):
            command.upgrade(config, "0224")

        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0223"
            observed_job = connection.execute(
                text(
                    "SELECT kind, payload, status, attempts FROM background_jobs WHERE id = :job_id"
                ),
                {"job_id": generation_job_id},
            ).one_or_none()
            assert observed_job == ("chat_run", {}, "pending", 0), (
                "0224 mutated the isolated undrained job despite refusing admission; "
                f"job_id={generation_job_id}; observed={observed_job!r}"
            )

        with engine.begin() as connection:
            connection.execute(
                text("UPDATE background_jobs SET status = 'dead' WHERE id = :job_id"),
                {"job_id": generation_job_id},
            )

        with pytest.raises(RuntimeError, match=rf"^{re.escape(expected_error)}$"):
            command.upgrade(config, "0224")

        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0223"
            observed_job = connection.execute(
                text(
                    "SELECT kind, payload, status, attempts FROM background_jobs WHERE id = :job_id"
                ),
                {"job_id": generation_job_id},
            ).one_or_none()
            assert observed_job == ("chat_run", {}, "dead", 0), (
                "0224 accepted or mutated a dead domain-owned generation job; "
                f"job_id={generation_job_id}; observed={observed_job!r}"
            )

        with engine.begin() as connection:
            connection.execute(
                text("UPDATE background_jobs SET kind = 'synapse_scan' WHERE id = :job_id"),
                {"job_id": generation_job_id},
            )
            connection.execute(
                text(
                    "INSERT INTO llm_calls "
                    "(id, owner_kind, owner_id, call_seq, provider, model_name, "
                    "llm_operation, streaming, cost_status) VALUES "
                    "(:call_id, 'synapse_scan', :job_id, 1, 'openai', "
                    "'gpt-5.6-terra', 'synapse', false, 'missing_usage')"
                ),
                {"call_id": llm_call_id, "job_id": generation_job_id},
            )

        nonterminal_call_error = f"0224 preflight: llm_calls must be terminal: ['{llm_call_id}']"
        with pytest.raises(RuntimeError, match=rf"^{re.escape(nonterminal_call_error)}$"):
            command.upgrade(config, "0224")

        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0223"
            observed_job = connection.execute(
                text(
                    "SELECT kind, payload, status, attempts FROM background_jobs WHERE id = :job_id"
                ),
                {"job_id": generation_job_id},
            ).one_or_none()
            assert observed_job == ("synapse_scan", {}, "dead", 0), (
                "0224 mutated a dead Synapse scan while its model call was nonterminal; "
                f"job_id={generation_job_id}; observed={observed_job!r}"
            )
            assert (
                connection.scalar(
                    text("SELECT outcome FROM llm_calls WHERE id = :call_id"),
                    {"call_id": llm_call_id},
                )
                is None
            ), (
                "0224 mutated the nonterminal Synapse model call despite refusing admission; "
                f"call_id={llm_call_id}"
            )

        with engine.begin() as connection:
            connection.execute(
                text("UPDATE llm_calls SET outcome = 'succeeded' WHERE id = :call_id"),
                {"call_id": llm_call_id},
            )
            connection.execute(
                text(
                    "UPDATE background_jobs "
                    "SET payload = jsonb_build_object("
                    "'journal', jsonb_build_object('dispatch_phase', 'Uncertain')) "
                    "WHERE id = :job_id"
                ),
                {"job_id": generation_job_id},
            )

        uncertain_error = (
            f"0224 preflight: queue journals contain Uncertain dispatches: ['{generation_job_id}']"
        )
        with pytest.raises(RuntimeError, match=rf"^{re.escape(uncertain_error)}$"):
            command.upgrade(config, "0224")

        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0223"
            observed_job = connection.execute(
                text(
                    "SELECT kind, payload, status, attempts FROM background_jobs WHERE id = :job_id"
                ),
                {"job_id": generation_job_id},
            ).one_or_none()
            assert observed_job == (
                "synapse_scan",
                {"journal": {"dispatch_phase": "Uncertain"}},
                "dead",
                0,
            ), (
                "0224 mutated an uncertain dead Synapse scan despite refusing admission; "
                f"job_id={generation_job_id}; observed={observed_job!r}"
            )

        with engine.begin() as connection:
            connection.execute(
                text("UPDATE background_jobs SET payload = '{}'::jsonb WHERE id = :job_id"),
                {"job_id": generation_job_id},
            )

            connection.execute(
                text(
                    "INSERT INTO background_jobs "
                    "(id, kind, payload, status, attempts, max_attempts, error_code, "
                    "result, finished_at) VALUES "
                    "(:job_id, 'enrich_metadata', "
                    "jsonb_build_object('media_id', CAST(:media_id AS text)), "
                    "'dead', 1, 2, 'E_METADATA_PARSE_FAILED', CAST(:result AS jsonb), now())"
                ),
                {
                    "job_id": enrichment_job_id,
                    "media_id": str(uuid4()),
                    "result": None,
                },
            )

        enrichment_error = (
            f"0224 preflight: generation jobs must be drained: ['{enrichment_job_id}']"
        )
        with pytest.raises(RuntimeError, match=rf"^{re.escape(enrichment_error)}$"):
            command.upgrade(config, "0224")

        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0223"
            assert connection.execute(
                text(
                    "SELECT status, error_code, result ->> 'error_code' "
                    "FROM background_jobs WHERE id = :job_id"
                ),
                {"job_id": enrichment_job_id},
            ).one() == ("dead", "E_METADATA_PARSE_FAILED", None), (
                "0224 mutated a dead enrichment job without a terminal result"
            )

        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE background_jobs SET result = CAST(:result AS jsonb) WHERE id = :job_id"
                ),
                {
                    "job_id": enrichment_job_id,
                    "result": json.dumps(
                        {
                            "status": "failed",
                            "reason": "parse_failed",
                            "error_code": "E_OTHER",
                        }
                    ),
                },
            )

        with pytest.raises(RuntimeError, match=rf"^{re.escape(enrichment_error)}$"):
            command.upgrade(config, "0224")

        with engine.connect() as connection:
            assert connection.execute(
                text(
                    "SELECT status, error_code, result ->> 'error_code' "
                    "FROM background_jobs WHERE id = :job_id"
                ),
                {"job_id": enrichment_job_id},
            ).one() == ("dead", "E_METADATA_PARSE_FAILED", "E_OTHER"), (
                "0224 mutated a dead enrichment job whose terminal result was mismatched"
            )

        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE background_jobs SET result = CAST(:result AS jsonb) WHERE id = :job_id"
                ),
                {
                    "job_id": enrichment_job_id,
                    "result": json.dumps(
                        {
                            "status": "failed",
                            "reason": "future_failure",
                            "error_code": "E_METADATA_PARSE_FAILED",
                        }
                    ),
                },
            )

        with pytest.raises(RuntimeError, match=rf"^{re.escape(enrichment_error)}$"):
            command.upgrade(config, "0224")

        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE background_jobs "
                    "SET result = jsonb_set(result, '{reason}', "
                    "to_jsonb(CAST('parse_failed' AS text)), false) "
                    "|| jsonb_build_object('detail', 'unknown') WHERE id = :job_id"
                ),
                {"job_id": enrichment_job_id},
            )

        with pytest.raises(RuntimeError, match=rf"^{re.escape(enrichment_error)}$"):
            command.upgrade(config, "0224")

        with engine.connect() as connection:
            assert connection.scalar(
                text("SELECT result ? 'detail' FROM background_jobs WHERE id = :job_id"),
                {"job_id": enrichment_job_id},
            ), "0224 mutated a dead enrichment job with an unclassified result extension"

        for invalid_attempt in (
            {"provider": None, "model": "claude-test"},
            {"provider": "", "model": "claude-test"},
            {"provider": "anthropic", "model": None},
            {"provider": "anthropic", "model": ""},
        ):
            with engine.begin() as connection:
                connection.execute(
                    text(
                        "UPDATE background_jobs "
                        "SET result = CAST(:result AS jsonb) WHERE id = :job_id"
                    ),
                    {
                        "job_id": enrichment_job_id,
                        "result": json.dumps(
                            {
                                "status": "failed",
                                "reason": "parse_failed",
                                "error_code": "E_METADATA_PARSE_FAILED",
                                "provider": "openai",
                                "model": "gpt-test",
                                "attempted_providers": [
                                    invalid_attempt,
                                    {"provider": "openai", "model": "gpt-test"},
                                ],
                            }
                        ),
                    },
                )

            with pytest.raises(RuntimeError, match=rf"^{re.escape(enrichment_error)}$"):
                command.upgrade(config, "0224")

        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE background_jobs SET result = CAST(:result AS jsonb) WHERE id = :job_id"
                ),
                {
                    "job_id": enrichment_job_id,
                    "result": json.dumps(
                        {
                            "status": "failed",
                            "reason": "parse_failed",
                            "error_code": "E_METADATA_PARSE_FAILED",
                            "provider": "openai",
                            "model": "gpt-test",
                            "attempted_providers": [
                                {"provider": "anthropic", "model": "claude-test"},
                                {
                                    "provider": "openai",
                                    "model": "gpt-test",
                                    "detail": "unknown",
                                },
                            ],
                        }
                    ),
                },
            )

        with pytest.raises(RuntimeError, match=rf"^{re.escape(enrichment_error)}$"):
            command.upgrade(config, "0224")

        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE background_jobs SET result = CAST(:result AS jsonb) WHERE id = :job_id"
                ),
                {
                    "job_id": enrichment_job_id,
                    "result": json.dumps(
                        {
                            "status": "failed",
                            "reason": "parse_failed",
                            "error_code": "E_METADATA_PARSE_FAILED",
                            "provider": "openai",
                            "model": "gpt-test",
                            "attempted_providers": [
                                {"provider": "anthropic", "model": "claude-test"},
                                {"provider": "openai", "model": "gpt-other"},
                            ],
                        }
                    ),
                },
            )

        with pytest.raises(RuntimeError, match=rf"^{re.escape(enrichment_error)}$"):
            command.upgrade(config, "0224")

        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE background_jobs "
                    "SET result = CAST(:result AS jsonb), claimed_by = 'stale-worker' "
                    "WHERE id = :job_id"
                ),
                {
                    "job_id": enrichment_job_id,
                    "result": json.dumps(
                        {
                            "status": "failed",
                            "reason": "parse_failed",
                            "error_code": "E_METADATA_PARSE_FAILED",
                            "provider": "openai",
                            "model": "gpt-test",
                            "attempted_providers": [
                                {"provider": "anthropic", "model": "claude-test"},
                                {"provider": "openai", "model": "gpt-test"},
                            ],
                        }
                    ),
                },
            )

        with pytest.raises(RuntimeError, match=rf"^{re.escape(enrichment_error)}$"):
            command.upgrade(config, "0224")

        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE background_jobs "
                    "SET claimed_by = NULL, lease_expires_at = now() WHERE id = :job_id"
                ),
                {"job_id": enrichment_job_id},
            )

        with pytest.raises(RuntimeError, match=rf"^{re.escape(enrichment_error)}$"):
            command.upgrade(config, "0224")

        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE background_jobs "
                    "SET lease_expires_at = NULL, finished_at = NULL WHERE id = :job_id"
                ),
                {"job_id": enrichment_job_id},
            )

        with pytest.raises(RuntimeError, match=rf"^{re.escape(enrichment_error)}$"):
            command.upgrade(config, "0224")

        with engine.begin() as connection:
            connection.execute(
                text("UPDATE background_jobs SET finished_at = now() WHERE id = :job_id"),
                {"job_id": enrichment_job_id},
            )
            connection.execute(
                text(
                    "INSERT INTO background_jobs "
                    "(id, kind, payload, status, attempts, max_attempts, error_code, "
                    "result, finished_at) VALUES "
                    "(:job_id, 'enrich_metadata', "
                    "jsonb_build_object('media_id', CAST(:media_id AS text)), "
                    "'dead', 1, 2, 'E_BILLING_REQUIRED', CAST(:result AS jsonb), now())"
                ),
                {
                    "job_id": minimal_enrichment_job_id,
                    "media_id": str(uuid4()),
                    "result": json.dumps(
                        {
                            "status": "failed",
                            "reason": "llm_rejected",
                            "error_code": "E_BILLING_REQUIRED",
                        }
                    ),
                },
            )

        command.upgrade(config, "0224")

        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0224"
            assert (
                connection.scalar(
                    text(
                        "SELECT count(*) FROM background_jobs "
                        "WHERE id = :synapse_job_id OR id = :enrichment_job_id "
                        "OR id = :minimal_enrichment_job_id"
                    ),
                    {
                        "synapse_job_id": generation_job_id,
                        "enrichment_job_id": enrichment_job_id,
                        "minimal_enrichment_job_id": minimal_enrichment_job_id,
                    },
                )
                == 0
            ), "0224 retained classified terminal queue state outside its generation reset"
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM llm_calls WHERE id = :call_id"),
                    {"call_id": llm_call_id},
                )
                == 0
            ), "0224 retained the terminal Synapse call outside its generation reset"
    finally:
        engine.dispose()
