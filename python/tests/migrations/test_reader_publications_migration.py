"""0219 proof: document publications gain an isolated generation owner."""

from __future__ import annotations

from pathlib import Path
from uuid import UUID

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError


def test_0219_backfills_only_ready_documents_without_database_cascade(
    empty_migration_database_url: str,
) -> None:
    """Migration preserves rollback-artifact reads/writes and explicit deletion."""
    migration_root = Path(__file__).parents[3] / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    command.upgrade(config, "0215")

    ready_pdf = UUID("00000000-0000-0000-0000-000000002160")
    ready_epub = UUID("00000000-0000-0000-0000-000000002161")
    ready_article = UUID("00000000-0000-0000-0000-000000002162")
    extracting_pdf = UUID("00000000-0000-0000-0000-000000002163")
    ready_video = UUID("00000000-0000-0000-0000-000000002164")
    ready_podcast = UUID("00000000-0000-0000-0000-000000002165")
    engine = create_engine(empty_migration_database_url)
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO media (id, kind, title, processing_status)
                    VALUES
                        (:ready_pdf, 'pdf', 'Ready PDF', 'ready_for_reading'),
                        (:ready_epub, 'epub', 'Ready EPUB', 'ready_for_reading'),
                        (:ready_article, 'web_article', 'Ready article', 'ready_for_reading'),
                        (:extracting_pdf, 'pdf', 'Extracting PDF', 'extracting'),
                        (:ready_video, 'video', 'Ready video', 'ready_for_reading'),
                        (:ready_podcast, 'podcast_episode', 'Ready podcast', 'ready_for_reading')
                    """
                ),
                {
                    "ready_pdf": ready_pdf,
                    "ready_epub": ready_epub,
                    "ready_article": ready_article,
                    "extracting_pdf": extracting_pdf,
                    "ready_video": ready_video,
                    "ready_podcast": ready_podcast,
                },
            )

        command.upgrade(config, "0219")

        inspector = inspect(engine)
        columns = {
            column["name"]: (column["nullable"], str(column["type"]))
            for column in inspector.get_columns("reader_publications")
        }
        foreign_keys = inspector.get_foreign_keys("reader_publications")
        with engine.connect() as connection:
            rows = connection.execute(
                text(
                    """
                    SELECT media_id, generation, changed_at IS NOT NULL,
                           get_byte(uuid_send(id), 6) >> 4
                    FROM reader_publications
                    ORDER BY media_id
                    """
                )
            ).all()

        assert columns == {
            "id": (False, "UUID"),
            "media_id": (False, "UUID"),
            "generation": (False, "BIGINT"),
            "changed_at": (False, "TIMESTAMP"),
        }, f"0219 installed an unexpected publication storage shape: {columns!r}"
        assert inspector.get_pk_constraint("reader_publications")["constrained_columns"] == ["id"]
        assert {
            tuple(constraint["column_names"])
            for constraint in inspector.get_unique_constraints("reader_publications")
        } == {("media_id",)}
        assert inspector.get_check_constraints("reader_publications") == [], (
            "generation positivity belongs to the publication service, not a database CHECK"
        )
        assert len(foreign_keys) == 1
        assert foreign_keys[0]["referred_table"] == "media"
        assert foreign_keys[0]["options"].get("ondelete") in {None, "NO ACTION"}, (
            "reader publication deletion must remain explicit and non-cascading"
        )
        assert rows == [
            (ready_pdf, 1, True, 7),
            (ready_epub, 1, True, 7),
            (ready_article, 1, True, 7),
        ], f"0219 backfilled the wrong media set or generation: {rows!r}"

        # A rolled-back application artifact knows only the old media schema. Its
        # ordinary reads and writes continue to work against the additive table.
        rollback_artifact_media = UUID("00000000-0000-0000-0000-000000002166")
        with engine.begin() as connection:
            connection.execute(
                text("UPDATE media SET title = 'Old artifact update' WHERE id = :media_id"),
                {"media_id": ready_pdf},
            )
            connection.execute(
                text(
                    """
                    INSERT INTO media (id, kind, title, processing_status)
                    VALUES (:media_id, 'pdf', 'Old artifact insert', 'pending')
                    """
                ),
                {"media_id": rollback_artifact_media},
            )
        with engine.connect() as connection:
            assert (
                connection.scalar(
                    text("SELECT title FROM media WHERE id = :media_id"),
                    {"media_id": ready_pdf},
                )
                == "Old artifact update"
            )

        with pytest.raises(IntegrityError):
            with engine.begin() as connection:
                connection.execute(
                    text("DELETE FROM media WHERE id = :media_id"),
                    {"media_id": ready_pdf},
                )

        with engine.begin() as connection:
            connection.execute(
                text("DELETE FROM reader_publications WHERE media_id = :media_id"),
                {"media_id": ready_pdf},
            )
            connection.execute(
                text("DELETE FROM media WHERE id = :media_id"),
                {"media_id": ready_pdf},
            )
        with engine.connect() as connection:
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM media WHERE id = :media_id"),
                    {"media_id": ready_pdf},
                )
                == 0
            )
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0219"
    finally:
        engine.dispose()
