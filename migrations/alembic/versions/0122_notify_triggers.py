"""Notify triggers for push-based SSE.

Add Postgres AFTER triggers that ``pg_notify`` on row changes for the three
tables whose progress is streamed to clients: ``chat_run_events``,
``oracle_reading_events``, and ``media``. Each trigger publishes the affected
id (cast to text) on a static per-table channel.

This backs push-based SSE: the API ``LISTEN``s on these channels and re-reads
the affected rows when notified, replacing polling per docs/rules/polling.md
(prefer push- or event-driven designs over polling).

Revision ID: 0122
Revises: 0121
Create Date: 2026-05-28
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0122"
down_revision: str | None = "0121"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # chat_run_events: notify the run id on every inserted event.
    op.execute(
        """
        CREATE FUNCTION notify_chat_run_event() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            PERFORM pg_notify('chat_run_events', NEW.run_id::text);
            RETURN NULL;
        END;
        $$;
        """
    )
    op.execute(
        """
        CREATE TRIGGER chat_run_events_notify
        AFTER INSERT ON chat_run_events
        FOR EACH ROW EXECUTE FUNCTION notify_chat_run_event();
        """
    )

    # oracle_reading_events: notify the reading id on every inserted event.
    op.execute(
        """
        CREATE FUNCTION notify_oracle_reading_event() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            PERFORM pg_notify('oracle_reading_events', NEW.reading_id::text);
            RETURN NULL;
        END;
        $$;
        """
    )
    op.execute(
        """
        CREATE TRIGGER oracle_reading_events_notify
        AFTER INSERT ON oracle_reading_events
        FOR EACH ROW EXECUTE FUNCTION notify_oracle_reading_event();
        """
    )

    # media: notify the media id on every update. The SSE consumer dedupes via
    # a payload diff, so an unconditional per-update notify is correct.
    op.execute(
        """
        CREATE FUNCTION notify_media_change() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            PERFORM pg_notify('media_events', NEW.id::text);
            RETURN NULL;
        END;
        $$;
        """
    )
    op.execute(
        """
        CREATE TRIGGER media_notify
        AFTER UPDATE ON media
        FOR EACH ROW EXECUTE FUNCTION notify_media_change();
        """
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0122 is not reversible")
