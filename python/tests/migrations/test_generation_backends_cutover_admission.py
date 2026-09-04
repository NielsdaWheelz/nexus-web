"""Focused PostgreSQL admission proof for the destructive generation reset."""

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
    """Risk: destructive history reset starts while admitted generation work is live."""

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
        try:
            command.upgrade(config, "0224")
        except RuntimeError as error:
            assert str(error) == expected_error, (
                "0224 refused the isolated undrained job at the wrong preflight boundary; "
                f"job_id={generation_job_id}; expected={expected_error!r}; actual={str(error)!r}"
            )
        else:
            pytest.fail(
                "0224 accepted an undrained generation job into the destructive history reset; "
                f"job_id={generation_job_id}"
            )

        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0223"
            observed_job = connection.execute(
                text("SELECT kind, status, attempts FROM background_jobs WHERE id = :job_id"),
                {"job_id": generation_job_id},
            ).one_or_none()
            assert observed_job == ("chat_run", "pending", 0), (
                "0224 mutated the isolated undrained job despite refusing admission; "
                f"job_id={generation_job_id}; observed={observed_job!r}"
            )
    finally:
        engine.dispose()
