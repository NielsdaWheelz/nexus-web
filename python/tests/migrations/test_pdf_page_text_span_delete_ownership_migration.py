"""Head-schema proof for explicit PDF page-span deletion ownership."""

from __future__ import annotations

from pathlib import Path
from uuid import UUID

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError


def test_pdf_page_text_spans_restrict_parent_delete_at_head(
    empty_migration_database_url: str,
) -> None:
    migration_root = Path(__file__).parents[3] / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    command.upgrade(config, "0221")

    engine = create_engine(empty_migration_database_url)
    media_id = UUID("00000000-0000-0000-0000-000000002220")
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO media (id, kind, title, processing_status)
                    VALUES (:media_id, 'pdf', 'Explicit page-span deletion',
                            'ready_for_reading')
                    """
                ),
                {"media_id": media_id},
            )
            connection.execute(
                text(
                    """
                    INSERT INTO pdf_page_text_spans (
                        media_id, page_number, start_offset, end_offset
                    ) VALUES (:media_id, 1, 0, 4)
                    """
                ),
                {"media_id": media_id},
            )

        command.upgrade(config, "head")

        media_foreign_keys = [
            constraint
            for constraint in inspect(engine).get_foreign_keys("pdf_page_text_spans")
            if constraint["referred_table"] == "media"
            and constraint["constrained_columns"] == ["media_id"]
        ]
        assert len(media_foreign_keys) == 1, (
            f"expected one PDF page-span media FK, found {media_foreign_keys!r}"
        )
        media_foreign_key = media_foreign_keys[0]
        assert media_foreign_key["name"] == "pdf_page_text_spans_media_id_fkey"
        assert media_foreign_key["options"].get("ondelete") in {
            None,
            "NO ACTION",
        }, "PDF page-span deletion must remain explicit and non-cascading"

        with pytest.raises(IntegrityError):
            with engine.begin() as connection:
                connection.execute(
                    text("DELETE FROM media WHERE id = :media_id"),
                    {"media_id": media_id},
                )

        with engine.connect() as connection:
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM pdf_page_text_spans WHERE media_id = :media_id"),
                    {"media_id": media_id},
                )
                == 1
            )

        with engine.begin() as connection:
            connection.execute(
                text("DELETE FROM pdf_page_text_spans WHERE media_id = :media_id"),
                {"media_id": media_id},
            )
            connection.execute(
                text("DELETE FROM media WHERE id = :media_id"),
                {"media_id": media_id},
            )
    finally:
        engine.dispose()
