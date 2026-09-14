"""0228 preserves cursors and records only provenance that history establishes."""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text


def test_0228_preserves_unknown_source_and_tombstone_revision(
    empty_migration_database_url: str,
) -> None:
    migration_root = Path(__file__).parents[3] / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    command.upgrade(config, "0227")
    engine = create_engine(empty_migration_database_url)
    user_id, article_id, timeline_id, empty_id = (uuid4() for _ in range(4))
    old_rows = [
        (article_id, "web_article", {"kind": "web"}, 41),
        (timeline_id, "video", {"kind": "transcript"}, 9),
        (empty_id, "pdf", None, 23),
    ]
    try:
        with engine.begin() as db:
            db.execute(
                text("INSERT INTO users (id,email) VALUES (:id,:email)"),
                {"id": user_id, "email": f"cursor-migration-{user_id}@example.invalid"},
            )
            for media_id, kind, locator, revision in old_rows:
                db.execute(
                    text(
                        "INSERT INTO media (id,kind,title,processing_status) "
                        "VALUES (:id,:kind,'Retained cursor','ready_for_reading')"
                    ),
                    {"id": media_id, "kind": kind},
                )
                db.execute(
                    text(
                        "INSERT INTO reader_media_state (user_id,media_id,locator,revision) "
                        "VALUES (:user,:media,CAST(:locator AS jsonb),:revision)"
                    ),
                    {
                        "user": user_id,
                        "media": media_id,
                        "locator": json.dumps(locator) if locator is not None else None,
                        "revision": revision,
                    },
                )
            db.execute(
                text(
                    "INSERT INTO reader_publications (id,media_id,generation) "
                    "VALUES (:id,:media,88)"
                ),
                {"id": uuid4(), "media": article_id},
            )
        command.upgrade(config, "0228")
        with engine.connect() as db:
            rows = {
                row.media_id: row
                for row in db.execute(
                    text(
                        "SELECT media_id,locator,revision,source FROM reader_media_state WHERE user_id=:user"
                    ),
                    {"user": user_id},
                )
            }
        for media_id, _kind, locator, revision in old_rows:
            assert rows[media_id].locator == locator
            assert rows[media_id].revision == revision
        assert rows[article_id].source == {"kind": "Unresolved"}, (
            "migration must not label old coordinates with the current publication"
        )
        assert rows[timeline_id].source == {"kind": "Timeline"}
        assert rows[empty_id].source is None
    finally:
        engine.dispose()
