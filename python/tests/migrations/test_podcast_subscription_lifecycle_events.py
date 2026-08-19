"""0218 installs the one-way Podcast subscription lifecycle notification contract."""

from __future__ import annotations

from pathlib import Path
from uuid import UUID

import psycopg
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

_EVENT_CHANNEL = "podcast_subscription_events"
_USER_ID = UUID("00000000-0000-7000-8000-000000000218")
_PODCAST_ID = UUID("00000000-0000-7000-8000-000000000219")
_SUBSCRIPTION_ID = UUID("00000000-0000-7000-8000-000000000220")
_BACKFILL_ID = UUID("00000000-0000-7000-8000-000000000221")


def _migration_config() -> Config:
    migration_root = Path(__file__).parents[3] / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    return config


def _notification_dsn(database_url: str) -> str:
    """Render the controller URL for psycopg's direct LISTEN connection."""
    return make_url(database_url).set(drivername="postgresql").render_as_string(hide_password=False)


def _assert_notification(listener: psycopg.Connection[object], *, payload: UUID) -> None:
    notification = next(listener.notifies(timeout=1.0, stop_after=1))
    assert notification.channel == _EVENT_CHANNEL
    assert notification.payload == str(payload)


def test_0218_owns_subscription_and_backfill_lifecycle_notifications(
    empty_migration_database_url: str,
) -> None:
    config = _migration_config()
    scripts = ScriptDirectory.from_config(config)
    heads = scripts.get_heads()
    assert len(heads) == 1
    successors = tuple(scripts.iterate_revisions(heads[0], "0217"))
    assert successors, "0217 must remain a strict ancestor of the current head"
    assert successors[-1].revision == "0218"
    assert successors[-1].down_revision == "0217"

    command.upgrade(config, "0218")
    engine = create_engine(empty_migration_database_url)
    try:
        with engine.connect() as connection:
            triggers = dict(
                connection.execute(
                    text(
                        """
                        SELECT trigger.tgname, pg_get_triggerdef(trigger.oid)
                        FROM pg_trigger trigger
                        JOIN pg_class relation ON relation.oid = trigger.tgrelid
                        WHERE relation.relname IN (
                            'podcast_subscriptions',
                            'podcast_subscription_backfills'
                        )
                          AND NOT trigger.tgisinternal
                        ORDER BY trigger.tgname
                        """
                    )
                ).all()
            )
            functions = dict(
                connection.execute(
                    text(
                        """
                        SELECT routine.proname, pg_get_functiondef(routine.oid)
                        FROM pg_proc routine
                        WHERE routine.proname IN (
                            'notify_podcast_subscription_lifecycle',
                            'notify_podcast_subscription_backfill_lifecycle'
                        )
                        ORDER BY routine.proname
                        """
                    )
                ).all()
            )

        assert set(triggers) == {
            "podcast_subscriptions_lifecycle_notify",
            "podcast_subscription_backfills_lifecycle_notify",
        }
        for trigger in triggers.values():
            normalized = trigger.upper()
            assert "AFTER" in normalized
            assert "INSERT" in normalized
            assert "UPDATE" in normalized
            assert "DELETE" in normalized
            assert "FOR EACH ROW" in normalized
        assert (
            "EXECUTE FUNCTION NOTIFY_PODCAST_SUBSCRIPTION_LIFECYCLE()"
            in triggers["podcast_subscriptions_lifecycle_notify"].upper()
        )
        assert (
            "EXECUTE FUNCTION NOTIFY_PODCAST_SUBSCRIPTION_BACKFILL_LIFECYCLE()"
            in triggers["podcast_subscription_backfills_lifecycle_notify"].upper()
        )

        assert set(functions) == {
            "notify_podcast_subscription_lifecycle",
            "notify_podcast_subscription_backfill_lifecycle",
        }
        for function in functions.values():
            normalized = function.upper()
            assert "PG_NOTIFY('PODCAST_SUBSCRIPTION_EVENTS'" in normalized, (
                "0218 lifecycle notification stopped publishing subscription epochs"
            )
            assert "WHEN TG_OP = 'DELETE' THEN OLD" in normalized
            assert "ELSE NEW" in normalized

        # Catalog text alone cannot prove a trigger invokes pg_notify with the
        # owner identity. Listen on a separate autocommit connection, then make
        # one subscription and one backfill transition in committed transactions.
        with psycopg.connect(
            _notification_dsn(empty_migration_database_url), autocommit=True
        ) as listener:
            listener.execute(f"LISTEN {_EVENT_CHANNEL}")
            with engine.begin() as connection:
                connection.execute(
                    text("INSERT INTO users (id) VALUES (:id)"),
                    {"id": _USER_ID},
                )
                connection.execute(
                    text(
                        """
                        INSERT INTO podcasts (id, provider, provider_podcast_id, title, feed_url)
                        VALUES (:id, 'migration-proof', '0218', 'Lifecycle proof', :feed_url)
                        """
                    ),
                    {
                        "id": _PODCAST_ID,
                        "feed_url": "https://example.invalid/migration-0218.xml",
                    },
                )
                connection.execute(
                    text(
                        """
                        INSERT INTO podcast_subscriptions (
                            id, user_id, podcast_id, next_sync_at
                        )
                        VALUES (:id, :user_id, :podcast_id, now())
                        """
                    ),
                    {
                        "id": _SUBSCRIPTION_ID,
                        "user_id": _USER_ID,
                        "podcast_id": _PODCAST_ID,
                    },
                )
            _assert_notification(listener, payload=_SUBSCRIPTION_ID)

            with engine.begin() as connection:
                connection.execute(
                    text(
                        """
                        INSERT INTO podcast_subscription_backfills (
                            id, subscription_id, cutoff_at, step_no, cursor,
                            processed_count, added_count
                        )
                        VALUES (:id, :subscription_id, now(), 0, NULL, 0, 0)
                        """
                    ),
                    {"id": _BACKFILL_ID, "subscription_id": _SUBSCRIPTION_ID},
                )
            _assert_notification(listener, payload=_SUBSCRIPTION_ID)
    finally:
        engine.dispose()
