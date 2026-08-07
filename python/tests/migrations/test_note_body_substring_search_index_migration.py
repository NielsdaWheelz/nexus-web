"""0210 proof: interrupted note-body substring indexing restarts to one usable head."""

from __future__ import annotations

import json
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, text

_INDEX_NAME = "ix_note_blocks_body_text_trgm"
_INDEX_DEFINITION = (
    "CREATE INDEX ix_note_blocks_body_text_trgm ON public.note_blocks "
    "USING gin (body_text gin_trgm_ops)"
)


def test_0210_restarts_an_invalid_exact_index_and_plans_substring_search_at_head(
    empty_migration_database_url: str,
) -> None:
    repo_root = Path(__file__).parents[3]
    migration_root = repo_root / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    expected_head = ScriptDirectory.from_config(config).get_current_head()
    assert expected_head is not None, "migration catalog must have exactly one head"

    command.upgrade(config, "0209")
    engine = create_engine(empty_migration_database_url)
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
            connection.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
            connection.execute(
                text(
                    f"CREATE INDEX CONCURRENTLY {_INDEX_NAME} "
                    "ON note_blocks USING gin (body_text gin_trgm_ops)"
                )
            )
        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE pg_index SET indisvalid = false "
                    "WHERE indexrelid = CAST(:index_name AS regclass)"
                ),
                {"index_name": _INDEX_NAME},
            )
            interrupted = connection.execute(
                text(
                    "SELECT indisvalid, pg_get_indexdef(indexrelid) "
                    "FROM pg_index WHERE indexrelid = CAST(:index_name AS regclass)"
                ),
                {"index_name": _INDEX_NAME},
            ).one()
        assert interrupted == (False, _INDEX_DEFINITION), (
            f"0210 restart fixture was not the exact invalid index: {interrupted!r}"
        )

        command.upgrade(config, "head")

        with engine.begin() as connection:
            actual_head = connection.scalar(text("SELECT version_num FROM alembic_version"))
            extension = connection.scalar(
                text("SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'")
            )
            index_state = connection.execute(
                text(
                    """
                    SELECT index_metadata.indisvalid,
                           access_method.amname,
                           operator_class.opcname,
                           pg_get_indexdef(index_metadata.indexrelid)
                    FROM pg_index index_metadata
                    JOIN pg_class index_relation
                      ON index_relation.oid = index_metadata.indexrelid
                    JOIN pg_am access_method
                      ON access_method.oid = index_relation.relam
                    JOIN pg_opclass operator_class
                      ON operator_class.oid = index_metadata.indclass[0]
                    WHERE index_relation.relname = :index_name
                    """
                ),
                {"index_name": _INDEX_NAME},
            ).one()
            connection.execute(text("SET LOCAL enable_seqscan = off"))
            plan = connection.scalar(
                text(
                    "EXPLAIN (FORMAT JSON, COSTS OFF) "
                    "SELECT id FROM note_blocks WHERE body_text ILIKE '%needle%'"
                )
            )

        assert actual_head == expected_head, (
            f"0210 restart stopped at revision {actual_head!r}, catalog head {expected_head!r}"
        )
        assert extension == "pg_trgm", "0210 reached head without its required pg_trgm extension"
        assert index_state == (True, "gin", "gin_trgm_ops", _INDEX_DEFINITION), (
            f"0210 installed the wrong note-body index contract: {index_state!r}"
        )
        serialized_plan = json.dumps(plan, sort_keys=True)
        assert _INDEX_NAME in serialized_plan and "Bitmap Index Scan" in serialized_plan, (
            "PostgreSQL did not plan note-body substring search through the exact trigram GIN "
            f"index: {serialized_plan}"
        )
    finally:
        engine.dispose()
