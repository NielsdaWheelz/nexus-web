"""Preserve historical work and refuse migration while a generation can dispatch."""

from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text


def test_shared_kernel_cutover_requires_drain_and_preserves_history(
    empty_migration_database_url: str,
) -> None:
    migration_root = Path(__file__).parents[3] / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    command.upgrade(config, "0224")
    engine = create_engine(empty_migration_database_url)
    live_id, historical_id, dead_id = uuid4(), uuid4(), uuid4()
    try:
        with engine.begin() as db:
            db.execute(
                text(
                    "INSERT INTO background_jobs (id, kind, payload, status, attempts) "
                    "VALUES (:live, 'chat_run', '{\"decision\":\"original\"}', 'pending', 0), "
                    "(:history, 'chat_run', '{\"decision\":\"retained\"}', 'succeeded', 1), "
                    "(:dead, 'chat_run', '{\"decision\":\"failed-history\"}', 'dead', 3)"
                ),
                {"live": live_id, "history": historical_id, "dead": dead_id},
            )
        with pytest.raises(RuntimeError, match=f"generation_job {live_id}"):
            command.upgrade(config, "0225")
        with engine.begin() as db:
            assert db.scalar(text("SELECT version_num FROM alembic_version")) == "0224"
            assert db.execute(
                text("SELECT status, payload FROM background_jobs WHERE id = :id"),
                {"id": live_id},
            ).one() == ("pending", {"decision": "original"})
            # This fixture represents completion by the old worker before the
            # second migration attempt; the migration itself cannot drain work.
            db.execute(
                text("UPDATE background_jobs SET status = 'succeeded' WHERE id = :id"),
                {"id": live_id},
            )
        command.upgrade(config, "0225")
        with engine.connect() as db:
            assert db.scalar(text("SELECT version_num FROM alembic_version")) == "0225"
            assert db.execute(
                text("SELECT status, attempts, payload FROM background_jobs WHERE id = :id"),
                {"id": historical_id},
            ).one() == ("succeeded", 1, {"decision": "retained"})
            assert db.execute(
                text("SELECT status, attempts, payload FROM background_jobs WHERE id = :id"),
                {"id": dead_id},
            ).one() == ("dead", 3, {"decision": "failed-history"})
            assert db.scalar(text("SELECT count(*) FROM background_jobs")) == 3
    finally:
        engine.dispose()
