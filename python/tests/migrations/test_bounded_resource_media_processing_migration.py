from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text


def test_0212_adds_heavy_capacity_and_source_progress_storage(
    empty_migration_database_url: str,
) -> None:
    migration_root = Path(__file__).parents[3] / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    command.upgrade(config, "0211")

    engine = create_engine(empty_migration_database_url)
    try:
        inspector = inspect(engine)
        assert "background_job_capacity_leases" not in inspector.get_table_names()
        prior_attempt_columns = {
            column["name"] for column in inspector.get_columns("media_source_attempts")
        }
        assert (
            not {
                "processing_stage",
                "progress_completed",
                "progress_total",
                "progress_unit",
                "progress_updated_at",
            }
            & prior_attempt_columns
        )

        command.upgrade(config, "0212")

        inspector = inspect(engine)
        capacity_columns = {
            column["name"]: (column["nullable"], str(column["type"]))
            for column in inspector.get_columns("background_job_capacity_leases")
        }
        assert capacity_columns == {
            "resource_class": (False, "TEXT"),
            "job_id": (True, "UUID"),
            "worker_id": (True, "TEXT"),
            "attempt_no": (True, "INTEGER"),
            "lease_expires_at": (True, "TIMESTAMP"),
            "updated_at": (False, "TIMESTAMP"),
        }
        assert all(
            column["type"].timezone is True
            for column in inspector.get_columns("background_job_capacity_leases")
            if column["name"] in {"lease_expires_at", "updated_at"}
        )
        assert inspector.get_pk_constraint("background_job_capacity_leases")[
            "constrained_columns"
        ] == ["resource_class"]
        foreign_keys = inspector.get_foreign_keys("background_job_capacity_leases")
        assert len(foreign_keys) == 1
        assert foreign_keys[0]["constrained_columns"] == ["job_id"]
        assert foreign_keys[0]["referred_table"] == "background_jobs"
        assert foreign_keys[0]["options"] == {}
        assert inspector.get_check_constraints("background_job_capacity_leases") == []

        attempt_columns = {
            column["name"]: (
                column["nullable"],
                str(column["type"]),
                column["default"],
            )
            for column in inspector.get_columns("media_source_attempts")
            if column["name"]
            in {
                "processing_stage",
                "progress_completed",
                "progress_total",
                "progress_unit",
                "progress_updated_at",
            }
        }
        assert attempt_columns == {
            "processing_stage": (True, "TEXT", None),
            "progress_completed": (False, "INTEGER", "0"),
            "progress_total": (True, "INTEGER", None),
            "progress_unit": (True, "TEXT", None),
            "progress_updated_at": (True, "TIMESTAMP", None),
        }
        assert (
            next(
                column["type"].timezone
                for column in inspector.get_columns("media_source_attempts")
                if column["name"] == "progress_updated_at"
            )
            is True
        )
        progress_check_names = {
            constraint["name"]
            for constraint in inspector.get_check_constraints("media_source_attempts")
            if constraint["name"] is not None
        }
        assert (
            not {
                "ck_media_source_attempts_processing_stage",
                "ck_media_source_attempts_progress_unit",
                "ck_media_source_attempts_progress_counted_shape",
            }
            & progress_check_names
        )
        with engine.connect() as connection:
            assert connection.execute(
                text(
                    """
                    SELECT resource_class, job_id, worker_id, attempt_no, lease_expires_at
                    FROM background_job_capacity_leases
                    """
                )
            ).one() == ("Heavy", None, None, None, None)
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0212"
    finally:
        engine.dispose()
