"""0223 proof: transcript request audits reject the removed enqueue fallback."""

from __future__ import annotations

from pathlib import Path
from uuid import UUID

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError


def test_0223_removes_enqueue_failure_audits_and_rejects_the_legacy_outcome_at_head(
    empty_migration_database_url: str,
) -> None:
    migration_root = Path(__file__).parents[3] / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    expected_head = ScriptDirectory.from_config(config).get_current_head()
    assert expected_head == "0224", "integrated generation cutover must be the sole head"

    command.upgrade(config, "0222")
    media_id = UUID("00000000-0000-0000-0000-000000002230")
    engine = create_engine(empty_migration_database_url)
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO media (id, kind, title, processing_status)
                    VALUES (:media_id, 'podcast_episode', 'Atomic transcript admission',
                            'ready_for_reading')
                    """
                ),
                {"media_id": media_id},
            )
            connection.execute(
                text(
                    """
                    INSERT INTO podcast_transcript_request_audits (
                        media_id, request_reason, outcome
                    ) VALUES
                        (:media_id, 'quote', 'queued'),
                        (:media_id, 'quote', 'enqueue_failed')
                    """
                ),
                {"media_id": media_id},
            )

        command.upgrade(config, "head")

        with engine.connect() as connection:
            actual_head = connection.scalar(text("SELECT version_num FROM alembic_version"))
            outcomes = connection.scalars(
                text(
                    """
                    SELECT outcome
                    FROM podcast_transcript_request_audits
                    WHERE media_id = :media_id
                    ORDER BY outcome
                    """
                ),
                {"media_id": media_id},
            ).all()
            outcome_constraint = connection.scalar(
                text(
                    """
                    SELECT pg_get_constraintdef(oid)
                    FROM pg_constraint
                    WHERE conname = 'ck_podcast_transcript_request_audits_outcome'
                      AND conrelid = 'podcast_transcript_request_audits'::regclass
                    """
                )
            )

        assert actual_head == expected_head
        assert outcomes == ["queued"]
        assert outcome_constraint is not None
        assert "enqueue_failed" not in outcome_constraint
        for outcome in ("forecast", "queued", "idempotent", "rejected_quota"):
            assert outcome in outcome_constraint

        with pytest.raises(IntegrityError):
            with engine.begin() as connection:
                connection.execute(
                    text(
                        """
                        INSERT INTO podcast_transcript_request_audits (
                            media_id, request_reason, outcome
                        ) VALUES (:media_id, 'quote', 'enqueue_failed')
                        """
                    ),
                    {"media_id": media_id},
                )
    finally:
        engine.dispose()
