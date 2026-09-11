"""Focused PostgreSQL admission proof for the destructive generation reset."""

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

        command.upgrade(config, "0224")

        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0224"
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM background_jobs WHERE id = :job_id"),
                    {"job_id": generation_job_id},
                )
                == 0
            ), "0224 retained an unambiguous dead Synapse scan outside its generation reset"
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM llm_calls WHERE id = :call_id"),
                    {"call_id": llm_call_id},
                )
                == 0
            ), "0224 retained the terminal Synapse call outside its generation reset"
    finally:
        engine.dispose()
