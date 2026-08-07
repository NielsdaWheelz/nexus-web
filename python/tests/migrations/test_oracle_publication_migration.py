"""The Oracle hard cut adds one absent-by-default publication marker."""

from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text


def test_0211_adds_only_the_unpublished_oracle_marker(
    empty_migration_database_url: str,
) -> None:
    migration_root = Path(__file__).parents[3] / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    command.upgrade(config, "0210")

    engine = create_engine(empty_migration_database_url)
    try:
        assert "oracle_corpus_publications" not in inspect(engine).get_table_names()

        command.upgrade(config, "0211")

        inspector = inspect(engine)
        columns = {
            column["name"]: (column["nullable"], str(column["type"]))
            for column in inspector.get_columns("oracle_corpus_publications")
        }
        assert columns == {
            "corpus_key": (False, "TEXT"),
            "manifest_digest": (False, "TEXT"),
            "embedding_provider": (False, "TEXT"),
            "embedding_model": (False, "TEXT"),
        }
        assert inspector.get_pk_constraint("oracle_corpus_publications")["constrained_columns"] == [
            "corpus_key"
        ]
        assert inspector.get_check_constraints("oracle_corpus_publications") == []
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT count(*) FROM oracle_corpus_publications")) == 0
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0211"
    finally:
        engine.dispose()
