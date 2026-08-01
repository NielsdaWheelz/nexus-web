"""0208/0209 proof: EPUB navigation offsets expand, defer, then hard-contract."""

from __future__ import annotations

from pathlib import Path
from uuid import UUID

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text


def test_0208_backfills_exact_offsets_and_0209_rejects_unrepaired_projection(
    empty_migration_database_url: str,
) -> None:
    repo_root = Path(__file__).parents[3]
    migration_root = repo_root / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))

    command.upgrade(config, "0207")

    valid_media_id = UUID("00000000-0000-0000-0000-000000000800")
    deferred_media_id = UUID("00000000-0000-0000-0000-000000000801")
    valid_text = "Opening.\nSecond."
    deferred_text = "Projection requiring repair."
    engine = create_engine(empty_migration_database_url)
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO media (id, kind, title, processing_status)
                    VALUES
                        (:valid_id, 'epub', 'Valid offsets', 'ready_for_reading'),
                        (:deferred_id, 'epub', 'Deferred offsets', 'ready_for_reading')
                    """
                ),
                {"valid_id": valid_media_id, "deferred_id": deferred_media_id},
            )
            connection.execute(
                text(
                    """
                    INSERT INTO fragments (
                        id, media_id, idx, canonical_text, html_sanitized
                    ) VALUES
                        (:valid_fragment, :valid_id, 0, :valid_text,
                         '<p id="opening">Opening.</p><p id="second">Second.</p>'),
                        (:deferred_fragment, :deferred_id, 0, :deferred_text,
                         '<p>Projection requiring repair.</p>')
                    """
                ),
                {
                    "valid_fragment": UUID("00000000-0000-0000-0000-000000000810"),
                    "deferred_fragment": UUID("00000000-0000-0000-0000-000000000811"),
                    "valid_id": valid_media_id,
                    "deferred_id": deferred_media_id,
                    "valid_text": valid_text,
                    "deferred_text": deferred_text,
                },
            )
            connection.execute(
                text(
                    """
                    INSERT INTO epub_nav_locations (
                        media_id, location_id, ordinal, source_node_id, label,
                        fragment_idx, href_path, href_fragment, source
                    ) VALUES
                        (:valid_id, 'chapter.xhtml#opening', 0, NULL, 'Opening',
                         0, 'chapter.xhtml', 'opening', 'toc'),
                        (:valid_id, 'chapter.xhtml#second', 1, NULL, 'Second',
                         0, 'chapter.xhtml', 'second', 'toc'),
                        (:deferred_id, 'repair.xhtml#removed', 0, NULL, 'Repair',
                         0, 'repair.xhtml', 'removed', 'toc')
                    """
                ),
                {"valid_id": valid_media_id, "deferred_id": deferred_media_id},
            )

        command.upgrade(config, "0208")

        second_start = valid_text.index("Second")
        with engine.connect() as connection:
            valid_offsets = connection.execute(
                text(
                    """
                    SELECT location_id, start_offset, end_offset
                    FROM epub_nav_locations
                    WHERE media_id = :media_id
                    ORDER BY ordinal
                    """
                ),
                {"media_id": valid_media_id},
            ).all()
            deferred_offsets = connection.execute(
                text(
                    """
                    SELECT start_offset, end_offset
                    FROM epub_nav_locations
                    WHERE media_id = :media_id
                    """
                ),
                {"media_id": deferred_media_id},
            ).one()

        assert valid_offsets == [
            ("chapter.xhtml#opening", 0, second_start),
            ("chapter.xhtml#second", second_start, len(valid_text)),
        ], f"0208 projected unexpected canonical offsets: {valid_offsets!r}"
        assert deferred_offsets == (None, None), (
            "0208 must leave an unresolvable historical anchor for the stopped-world repair"
        )

        with pytest.raises(
            RuntimeError,
            match="requires every EPUB navigation projection to have exact offsets",
        ):
            command.upgrade(config, "0209")

        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    UPDATE epub_nav_locations
                    SET start_offset = 0, end_offset = :end_offset
                    WHERE media_id = :media_id
                    """
                ),
                {"media_id": deferred_media_id, "end_offset": len(deferred_text) + 1},
            )

        with pytest.raises(RuntimeError, match="invalid EPUB navigation offset bounds"):
            command.upgrade(config, "0209")

        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    UPDATE epub_nav_locations
                    SET end_offset = :end_offset
                    WHERE media_id = :deferred_media_id
                    """
                ),
                {
                    "deferred_media_id": deferred_media_id,
                    "end_offset": len(deferred_text),
                },
            )
            connection.execute(
                text(
                    """
                    UPDATE epub_nav_locations
                    SET end_offset = :invalid_end
                    WHERE media_id = :valid_media_id AND ordinal = 0
                    """
                ),
                {
                    "valid_media_id": valid_media_id,
                    "invalid_end": second_start + 1,
                },
            )

        with pytest.raises(RuntimeError, match="invalid EPUB navigation intervals"):
            command.upgrade(config, "0209")

        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    UPDATE epub_nav_locations
                    SET end_offset = :end_offset
                    WHERE media_id = :media_id AND ordinal = 0
                    """
                ),
                {"media_id": valid_media_id, "end_offset": second_start},
            )

        command.upgrade(config, "0209")

        columns = {
            column["name"]: column["nullable"]
            for column in inspect(engine).get_columns("epub_nav_locations")
            if column["name"] in {"start_offset", "end_offset"}
        }
        with engine.connect() as connection:
            revision = connection.scalar(text("SELECT version_num FROM alembic_version"))
        assert revision == "0209", f"EPUB hard contract stopped at revision {revision!r}"
        assert columns == {"start_offset": False, "end_offset": False}, (
            f"0209 left nullable EPUB offset storage: {columns!r}"
        )

        with pytest.raises(RuntimeError, match="0209 is a hard cutover migration"):
            command.downgrade(config, "0208")
    finally:
        engine.dispose()
