"""Migration 0228 repairs only evidenced stale web reader cursor targets."""

import json
from pathlib import Path
from uuid import UUID

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text


def test_reader_structure_repair_reanchors_only_exact_stale_web_cursors(
    empty_migration_database_url: str,
) -> None:
    migration_root = Path(__file__).parents[3] / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    command.upgrade(config, "0227")
    media_id = UUID("00000000-0000-0000-0000-000000002310")
    repaired_fragment_id = UUID("00000000-0000-0000-0000-000000002311")
    duplicate_fragment_id = UUID("00000000-0000-0000-0000-000000002312")
    changed_duplicate_id = UUID("00000000-0000-0000-0000-000000002313")
    repaired_user_id = UUID("00000000-0000-0000-0000-000000002314")
    current_user_id = UUID("00000000-0000-0000-0000-000000002315")
    blocked_user_id = UUID("00000000-0000-0000-0000-000000002316")
    repaired_cursor_id = UUID("00000000-0000-0000-0000-000000002317")
    current_cursor_id = UUID("00000000-0000-0000-0000-000000002318")
    blocked_cursor_id = UUID("00000000-0000-0000-0000-000000002319")
    stale_repaired_fragment_id = UUID("00000000-0000-0000-0000-000000002320")
    stale_blocked_fragment_id = UUID("00000000-0000-0000-0000-000000002321")
    repaired_prefix = "0123456789🧠abcdefghij"
    repaired_quote = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuv"
    repaired_text = f"{repaired_prefix}{repaired_quote}"
    duplicate_quote = "ABCDEFGHIJKLMNOPQRSTUVWXabcdefghijklmnopqrstuvwx"
    duplicate_text = f"duplicate:{duplicate_quote}:context"
    repaired_locator = {
        "kind": "web",
        "target": {"fragment_id": str(stale_repaired_fragment_id)},
        "locations": {
            "text_offset": len(repaired_text),
            "progression": 1.0,
            "total_progression": 1.0,
            "position": 2,
        },
        "text": {
            "quote": repaired_quote,
            "quote_prefix": repaired_prefix,
            "quote_suffix": None,
        },
    }
    current_locator = {
        "kind": "web",
        "target": {"fragment_id": str(repaired_fragment_id)},
        "locations": {
            "text_offset": 4,
            "progression": None,
            "total_progression": None,
            "position": None,
        },
        "text": {"quote": None, "quote_prefix": None, "quote_suffix": None},
    }
    blocked_locator = {
        "kind": "web",
        "target": {"fragment_id": str(stale_blocked_fragment_id)},
        "locations": {
            "text_offset": 10,
            "progression": 0.5,
            "total_progression": 0.5,
            "position": 2,
        },
        "text": {
            "quote": "an absent source passage",
            "quote_prefix": None,
            "quote_suffix": None,
        },
    }
    engine = create_engine(empty_migration_database_url)
    try:
        with engine.begin() as connection:
            connection.execute(
                text("INSERT INTO users (id) VALUES (:a), (:b), (:c)"),
                {"a": repaired_user_id, "b": current_user_id, "c": blocked_user_id},
            )
            connection.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status) "
                    "VALUES (:id, 'web_article', 'cursor repair', 'ready_for_reading')"
                ),
                {"id": media_id},
            )
            connection.execute(
                text(
                    "INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized) "
                    "VALUES (:first, :media, 0, :first_text, :first_html), "
                    "(:second, :media, 1, :duplicate_text, :duplicate_html), "
                    "(:third, :media, 2, :duplicate_text, :duplicate_html)"
                ),
                {
                    "first": repaired_fragment_id,
                    "second": duplicate_fragment_id,
                    "third": changed_duplicate_id,
                    "media": media_id,
                    "first_text": repaired_text,
                    "first_html": f"<p>{repaired_text}</p>",
                    "duplicate_text": duplicate_text,
                    "duplicate_html": f"<p>{duplicate_text}</p>",
                },
            )
            connection.execute(
                text(
                    "INSERT INTO reader_media_state "
                    "(id, user_id, media_id, locator, revision) VALUES "
                    "(:repaired, :repaired_user, :media, CAST(:repaired_locator AS jsonb), 7), "
                    "(:current, :current_user, :media, CAST(:current_locator AS jsonb), 5), "
                    "(:blocked, :blocked_user, :media, CAST(:blocked_locator AS jsonb), 9)"
                ),
                {
                    "repaired": repaired_cursor_id,
                    "repaired_user": repaired_user_id,
                    "repaired_locator": json.dumps(repaired_locator),
                    "current": current_cursor_id,
                    "current_user": current_user_id,
                    "current_locator": json.dumps(current_locator),
                    "blocked": blocked_cursor_id,
                    "blocked_user": blocked_user_id,
                    "blocked_locator": json.dumps(blocked_locator),
                    "media": media_id,
                },
            )

        with pytest.raises(RuntimeError, match=str(blocked_cursor_id)):
            command.upgrade(config, "head")
        with engine.begin() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0227"
            assert connection.execute(
                text("SELECT id, locator, revision FROM reader_media_state ORDER BY id")
            ).all() == [
                (repaired_cursor_id, repaired_locator, 7),
                (current_cursor_id, current_locator, 5),
                (blocked_cursor_id, blocked_locator, 9),
            ]
            ambiguous_locator = {
                **blocked_locator,
                "text": {
                    "quote": duplicate_quote,
                    "quote_prefix": "duplicate:",
                    "quote_suffix": ":context",
                },
            }
            connection.execute(
                text(
                    "UPDATE reader_media_state SET locator = CAST(:locator AS jsonb) "
                    "WHERE id = :id"
                ),
                {"id": blocked_cursor_id, "locator": json.dumps(ambiguous_locator)},
            )

        with pytest.raises(RuntimeError, match=str(blocked_cursor_id)):
            command.upgrade(config, "head")
        with engine.begin() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0227"
            assert connection.execute(
                text("SELECT id, revision FROM reader_media_state ORDER BY id")
            ).all() == [
                (repaired_cursor_id, 7),
                (current_cursor_id, 5),
                (blocked_cursor_id, 9),
            ]
            changed_text = "a third fragment with distinct canonical text"
            connection.execute(
                text(
                    "UPDATE fragments SET canonical_text = :canonical, html_sanitized = :html "
                    "WHERE id = :id"
                ),
                {
                    "id": changed_duplicate_id,
                    "canonical": changed_text,
                    "html": f"<p>{changed_text}</p>",
                },
            )

        command.upgrade(config, "head")
        with engine.connect() as connection:
            assert connection.execute(
                text("SELECT id, locator, revision FROM reader_media_state ORDER BY id")
            ).all() == [
                (
                    repaired_cursor_id,
                    {
                        **repaired_locator,
                        "target": {"fragment_id": str(repaired_fragment_id)},
                    },
                    8,
                ),
                (current_cursor_id, current_locator, 5),
                (
                    blocked_cursor_id,
                    {
                        **ambiguous_locator,
                        "target": {"fragment_id": str(duplicate_fragment_id)},
                    },
                    10,
                ),
            ]
        command.upgrade(config, "head")
        with engine.connect() as connection:
            assert connection.execute(
                text("SELECT id, revision FROM reader_media_state ORDER BY id")
            ).all() == [
                (repaired_cursor_id, 8),
                (current_cursor_id, 5),
                (blocked_cursor_id, 10),
            ]
    finally:
        engine.dispose()
