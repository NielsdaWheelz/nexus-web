"""0213 proof: retained activity gains capture identity without losing facts."""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError


def test_0213_backfills_unique_capture_keys_and_installs_adjustment_storage(
    empty_migration_database_url: str,
) -> None:
    repo_root = Path(__file__).parents[3]
    migration_root = repo_root / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    command.upgrade(config, "0212")
    user_id = uuid4()
    media_id = uuid4()
    span_ids = [uuid4(), uuid4()]
    engine = create_engine(empty_migration_database_url)
    try:
        with engine.begin() as connection:
            connection.execute(
                text("INSERT INTO users (id, email) VALUES (:id, :email)"),
                {"id": user_id, "email": f"activity-migration-{user_id}@example.invalid"},
            )
            connection.execute(
                text(
                    """
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Retained observed facts',
                            'ready_for_reading', :user_id)
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            connection.execute(
                text(
                    """
                    INSERT INTO consumption_activity_spans (
                        id, user_id, media_id, modality, device_id, device_class,
                        occurred_at, duration_ms
                    ) VALUES (
                        :id, :user_id, :media_id, 'Reading', 'migration-device',
                        'Desktop', now() - interval '1 day' + :ordinal * interval '1 minute',
                        1000
                    )
                    """
                ),
                [
                    {"id": span_id, "user_id": user_id, "media_id": media_id, "ordinal": index}
                    for index, span_id in enumerate(span_ids)
                ],
            )

        command.upgrade(config, "0213")

        with engine.begin() as connection:
            actual_head = connection.scalar(text("SELECT version_num FROM alembic_version"))
            retained = connection.execute(
                text(
                    """
                    SELECT id, capture_key
                    FROM consumption_activity_spans
                    WHERE id = ANY(:span_ids)
                    ORDER BY id
                    """
                ),
                {"span_ids": span_ids},
            ).all()
            adjustment_columns = dict(
                connection.execute(
                    text(
                        """
                        SELECT column_name, is_nullable
                        FROM information_schema.columns
                        WHERE table_schema = 'public'
                          AND table_name = 'consumption_activity_adjustments'
                        """
                    )
                ).all()
            )
            indexes = set(
                connection.scalars(
                    text(
                        """
                        SELECT indexname
                        FROM pg_indexes
                        WHERE schemaname = 'public'
                          AND tablename = 'consumption_activity_adjustments'
                        """
                    )
                )
            )

        assert actual_head == "0213"
        assert [row.id for row in retained] == sorted(span_ids), (
            f"0213 lost retained activity spans: {retained!r}"
        )
        capture_keys = [row.capture_key for row in retained]
        assert all(capture_keys) and len(set(capture_keys)) == len(span_ids), (
            f"0213 did not mint one unique capture key per retained fact: {retained!r}"
        )
        assert adjustment_columns == {
            "id": "NO",
            "user_id": "NO",
            "media_id": "NO",
            "kind": "NO",
            "modality": "NO",
            "device_id": "YES",
            "occurred_at": "NO",
            "duration_ms": "NO",
            "created_at": "NO",
            "retracted_at": "YES",
        }
        assert {
            "ix_consumption_activity_adjustments_user_occurred_id",
            "ix_cons_activity_adj_user_media_device_time_id",
            "ix_consumption_activity_adjustments_media_id",
        } <= indexes

        with pytest.raises(IntegrityError):
            with engine.begin() as connection:
                connection.execute(
                    text(
                        """
                        INSERT INTO consumption_activity_spans (
                            id, capture_key, user_id, media_id, modality, device_id,
                            device_class, occurred_at, duration_ms
                        ) VALUES (
                            :id, :capture_key, :user_id, :media_id, 'Reading',
                            'migration-device', 'Desktop', now(), 1000
                        )
                        """
                    ),
                    {
                        "id": uuid4(),
                        "capture_key": capture_keys[0],
                        "user_id": user_id,
                        "media_id": media_id,
                    },
                )
    finally:
        engine.dispose()
