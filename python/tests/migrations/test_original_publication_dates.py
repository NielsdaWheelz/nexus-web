"""The publication-date cutover drains work and discards ambiguous dates."""

import json
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text


def test_publication_dates_require_drained_work_and_invalidate_chronology(
    empty_migration_database_url: str,
) -> None:
    migration_root = Path(__file__).parents[3] / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    command.upgrade(config, "0227")
    engine = create_engine(empty_migration_database_url)
    viewer_id, media_id, job_id = uuid4(), uuid4(), uuid4()
    try:
        with engine.begin() as connection:
            connection.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": viewer_id})
            connection.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status, published_date) "
                    "VALUES (:id, 'epub', 'Heart of Darkness', 'ready_for_reading', '2007')"
                ),
                {"id": media_id},
            )
            created_at = connection.scalar(
                text("SELECT created_at FROM media WHERE id = :id"), {"id": media_id}
            )
            connection.execute(
                text(
                    "INSERT INTO viewer_collection_revisions (viewer_id, family, revision) "
                    "VALUES (:id, 'LibraryEntries', 7)"
                ),
                {"id": viewer_id},
            )

        for kind in (
            "ingest_media_source",
            "podcast_sync_subscription_job",
            "podcast_backfill_subscription",
            "enrich_metadata",
        ):
            with engine.begin() as connection:
                connection.execute(
                    text(
                        "INSERT INTO background_jobs (id, kind, payload, status, attempts) "
                        "VALUES (:id, :kind, '{}'::jsonb, 'pending', 0)"
                    ),
                    {"id": job_id, "kind": kind},
                )
            with pytest.raises(RuntimeError, match="requires drained"):
                command.upgrade(config, "0228")
            with engine.begin() as connection:
                assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0227"
                assert (
                    connection.scalar(
                        text("SELECT published_date FROM media WHERE id = :id"), {"id": media_id}
                    )
                    == "2007"
                )
                connection.execute(
                    text("DELETE FROM background_jobs WHERE id = :id"), {"id": job_id}
                )

        # A dead queue envelope does not resolve an accepted, uncertain generation.
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO background_jobs (id, kind, payload, status, attempts) "
                    "VALUES (:id, 'enrich_metadata', CAST(:payload AS jsonb), 'dead', 1)"
                ),
                {
                    "id": job_id,
                    "payload": json.dumps(
                        {"coordination": {"codex/metadata": {"dispatch_phase": "Uncertain"}}}
                    ),
                },
            )
        with pytest.raises(RuntimeError, match="uncertain_metadata"):
            command.upgrade(config, "0228")
        with engine.begin() as connection:
            connection.execute(text("DELETE FROM background_jobs WHERE id = :id"), {"id": job_id})

        command.upgrade(config, "0228")
        assert "published_date" not in {
            column["name"] for column in inspect(engine).get_columns("media")
        }
        with engine.connect() as connection:
            assert connection.execute(
                text(
                    "SELECT original_published_date, edition_published_date, edition_isbn, "
                    "created_at FROM media WHERE id = :id"
                ),
                {"id": media_id},
            ).one() == (None, None, None, created_at)
            assert dict(
                connection.execute(
                    text(
                        "SELECT family, revision FROM viewer_collection_revisions WHERE viewer_id = :id"
                    ),
                    {"id": viewer_id},
                ).all()
            ) == {
                "AuthorWorks": 1,
                "LibraryEntries": 8,
                "PodcastEpisodes": 1,
                "PodcastSubscriptions": 1,
            }
    finally:
        engine.dispose()
