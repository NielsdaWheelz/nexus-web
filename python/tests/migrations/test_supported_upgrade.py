"""One production-shaped migration proof: an empty owned PostgreSQL database reaches head."""

from __future__ import annotations

import os
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text

from tests.testkit.database import require_test_migration_database_url

_REQUIRED_TABLES = {
    "alembic_version",
    "background_jobs",
    "chat_runs",
    "libraries",
    "library_entries",
    "llm_calls",
    "media",
    "reader_media_state",
    "resource_edges",
    "users",
}


def test_empty_owned_database_upgrades_to_the_single_head() -> None:
    repo_root = Path(__file__).parents[3]
    migration_root = repo_root / "migrations"
    database_url = require_test_migration_database_url(os.environ)
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    scripts = ScriptDirectory.from_config(config)
    expected_head = scripts.get_current_head()
    assert expected_head is not None, "migration catalog must have exactly one head"

    previous_url = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = database_url
    try:
        command.upgrade(config, "head")
    finally:
        if previous_url is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = previous_url

    engine = create_engine(database_url)
    try:
        actual_tables = set(inspect(engine).get_table_names())
        missing = sorted(_REQUIRED_TABLES - actual_tables)
        assert not missing, f"head schema is missing product-spine tables: {missing}"
        with engine.connect() as connection:
            actual_head = connection.scalar(text("SELECT version_num FROM alembic_version"))
            extensions = set(
                connection.scalars(
                    text("SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto', 'vector')")
                )
            )
        assert actual_head == expected_head, (
            f"database revision {actual_head!r} differs from catalog head {expected_head!r}"
        )
        assert extensions == {"pgcrypto", "vector"}, (
            f"head schema requires pgcrypto and vector, found {sorted(extensions)}"
        )
    finally:
        engine.dispose()
