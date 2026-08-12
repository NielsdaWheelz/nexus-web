"""0214 proof: manual activity is deleted and exclusions retain exact identity."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection


def _migration_config() -> Config:
    migration_root = Path(__file__).parents[3] / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    return config


def _install_owner(connection: Connection, *, user_id: UUID, media_id: UUID) -> None:
    connection.execute(
        text("INSERT INTO users (id, email) VALUES (:id, :email)"),
        {"id": user_id, "email": f"observed-migration-{user_id}@example.invalid"},
    )
    connection.execute(
        text(
            """
            INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
            VALUES (:id, 'web_article', 'Observed activity migration',
                    'ready_for_reading', :user_id)
            """
        ),
        {"id": media_id, "user_id": user_id},
    )


def test_0214_deletes_adds_and_replay_memos_but_preserves_exclusions(
    empty_migration_database_url: str,
) -> None:
    config = _migration_config()
    command.upgrade(config, "0213")
    engine = create_engine(empty_migration_database_url)
    user_id, media_id = uuid4(), uuid4()
    add_id, active_id, restored_id = uuid4(), uuid4(), uuid4()
    started_at = datetime(2026, 8, 10, 12, tzinfo=UTC)
    created_at = started_at + timedelta(hours=1)
    restored_at = created_at + timedelta(hours=1)
    try:
        with engine.begin() as connection:
            _install_owner(connection, user_id=user_id, media_id=media_id)
            connection.execute(
                text(
                    """
                    INSERT INTO consumption_activity_adjustments (
                        id, user_id, media_id, kind, modality, device_id,
                        occurred_at, duration_ms, created_at, retracted_at
                    ) VALUES
                        (:add_id, :user_id, :media_id, 'Add', 'Reading', NULL,
                         :started_at, 9000, :created_at, NULL),
                        (:active_id, :user_id, :media_id, 'Exclude', 'Reading',
                         'migration-device', :started_at, 10000, :created_at, NULL),
                        (:restored_id, :user_id, :media_id, 'Exclude', 'Reading',
                         'migration-device', :restored_start, 5000, :created_at,
                         :restored_at)
                    """
                ),
                {
                    "add_id": add_id,
                    "active_id": active_id,
                    "restored_id": restored_id,
                    "user_id": user_id,
                    "media_id": media_id,
                    "started_at": started_at,
                    "restored_start": started_at + timedelta(minutes=1),
                    "created_at": created_at,
                    "restored_at": restored_at,
                },
            )
            connection.execute(
                text(
                    """
                    INSERT INTO resource_mutations (
                        user_id, mutation_scope, client_mutation_id, request_hash,
                        changed_lanes, response_json
                    ) VALUES
                        (:user_id, 'Consumption.ActivityAdjustments', 'old-adjustment',
                         :request_hash, '{}'::jsonb, '{}'::jsonb),
                        (:user_id, 'Consumption.Activity', 'retained-activity',
                         :request_hash, '{}'::jsonb, '{}'::jsonb)
                    """
                ),
                {"user_id": user_id, "request_hash": "0" * 64},
            )

        command.upgrade(config, "0214")

        with engine.connect() as connection:
            actual_head = connection.scalar(text("SELECT version_num FROM alembic_version"))
            tables = set(
                connection.scalars(
                    text(
                        """
                        SELECT table_name
                        FROM information_schema.tables
                        WHERE table_schema = 'public'
                          AND table_name LIKE 'consumption_activity_%'
                        """
                    )
                )
            )
            columns = dict(
                connection.execute(
                    text(
                        """
                        SELECT column_name, is_nullable
                        FROM information_schema.columns
                        WHERE table_schema = 'public'
                          AND table_name = 'consumption_activity_exclusions'
                        """
                    )
                ).all()
            )
            rows = (
                connection.execute(
                    text(
                        """
                    SELECT id, started_at, ended_at, created_at, restored_at, device_id
                    FROM consumption_activity_exclusions
                    ORDER BY started_at, id
                    """
                    )
                )
                .mappings()
                .all()
            )
            indexes = set(
                connection.scalars(
                    text(
                        """
                        SELECT indexname
                        FROM pg_indexes
                        WHERE schemaname = 'public'
                          AND tablename = 'consumption_activity_exclusions'
                        """
                    )
                )
            )
            constraints = set(
                connection.scalars(
                    text(
                        """
                        SELECT conname
                        FROM pg_constraint
                        WHERE conrelid = 'consumption_activity_exclusions'::regclass
                        """
                    )
                )
            )
            replay_scopes = list(
                connection.scalars(
                    text(
                        """
                        SELECT mutation_scope
                        FROM resource_mutations
                        WHERE user_id = :user_id
                        ORDER BY mutation_scope
                        """
                    ),
                    {"user_id": user_id},
                )
            )

        assert actual_head == "0214"
        assert "consumption_activity_adjustments" not in tables
        assert "consumption_activity_exclusions" in tables
        assert columns == {
            "id": "NO",
            "user_id": "NO",
            "media_id": "NO",
            "modality": "NO",
            "device_id": "NO",
            "started_at": "NO",
            "ended_at": "NO",
            "created_at": "NO",
            "restored_at": "YES",
        }
        assert [row["id"] for row in rows] == [active_id, restored_id]
        assert rows[0] == {
            "id": active_id,
            "started_at": started_at,
            "ended_at": started_at + timedelta(seconds=10),
            "created_at": created_at,
            "restored_at": None,
            "device_id": "migration-device",
        }
        assert rows[1] == {
            "id": restored_id,
            "started_at": started_at + timedelta(minutes=1),
            "ended_at": started_at + timedelta(minutes=1, seconds=5),
            "created_at": created_at,
            "restored_at": restored_at,
            "device_id": "migration-device",
        }
        assert indexes == {
            "consumption_activity_exclusions_pkey",
            "ix_consumption_activity_exclusions_user_started_id",
            "ix_cons_activity_exclusions_user_media_device_started_id",
            "ix_consumption_activity_exclusions_media_id",
        }
        assert constraints == {
            "consumption_activity_exclusions_pkey",
            "fk_consumption_activity_exclusions_user",
            "fk_consumption_activity_exclusions_media",
        }
        assert replay_scopes == ["Consumption.Activity"]
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    ("kind", "modality", "device_id", "duration_ms"),
    [
        pytest.param("Unexpected", "Reading", "migration-device", 1000, id="unknown-kind"),
        pytest.param("Exclude", "Reading", None, 1000, id="missing-exclude-device"),
    ],
)
def test_0214_rejects_legacy_rows_that_cannot_become_exclusions(
    empty_migration_database_url: str,
    kind: str,
    modality: str,
    device_id: str | None,
    duration_ms: int,
) -> None:
    config = _migration_config()
    command.upgrade(config, "0213")
    engine = create_engine(empty_migration_database_url)
    user_id, media_id = uuid4(), uuid4()
    try:
        with engine.begin() as connection:
            _install_owner(connection, user_id=user_id, media_id=media_id)
            connection.execute(
                text(
                    """
                    INSERT INTO consumption_activity_adjustments (
                        id, user_id, media_id, kind, modality, device_id,
                        occurred_at, duration_ms
                    ) VALUES (
                        :id, :user_id, :media_id, :kind, :modality, :device_id,
                        now() - interval '1 minute', :duration_ms
                    )
                    """
                ),
                {
                    "id": uuid4(),
                    "user_id": user_id,
                    "media_id": media_id,
                    "kind": kind,
                    "modality": modality,
                    "device_id": device_id,
                    "duration_ms": duration_ms,
                },
            )

        with pytest.raises(RuntimeError, match="invalid legacy Consumption activity"):
            command.upgrade(config, "0214")

        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0213"
            assert connection.scalar(text("SELECT to_regclass('consumption_activity_adjustments')"))
            assert (
                connection.scalar(text("SELECT to_regclass('consumption_activity_exclusions')"))
                is None
            )
    finally:
        engine.dispose()
