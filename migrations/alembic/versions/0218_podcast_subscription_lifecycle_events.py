"""Push owner-checked Podcast subscription lifecycle state to the browser.

Revision ID: 0218
Revises: 0217
Create Date: 2026-08-18

The notification payload is only the stable subscription UUID. The API stream
always re-reads the viewer-owned snapshot, so notifications carry no state and
cannot authorize or leak a lifecycle transition.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0218"
down_revision: str | Sequence[str] | None = "0217"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE FUNCTION notify_podcast_subscription_lifecycle() RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        DECLARE
            subscription_identity uuid;
        BEGIN
            subscription_identity := CASE
                WHEN TG_OP = 'DELETE' THEN OLD.id
                ELSE NEW.id
            END;
            PERFORM pg_notify('podcast_subscription_events', subscription_identity::text);
            RETURN NULL;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE FUNCTION notify_podcast_subscription_backfill_lifecycle() RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        DECLARE
            subscription_identity uuid;
        BEGIN
            subscription_identity := CASE
                WHEN TG_OP = 'DELETE' THEN OLD.subscription_id
                ELSE NEW.subscription_id
            END;
            PERFORM pg_notify('podcast_subscription_events', subscription_identity::text);
            RETURN NULL;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER podcast_subscriptions_lifecycle_notify
        AFTER INSERT OR UPDATE OR DELETE ON podcast_subscriptions
        FOR EACH ROW EXECUTE FUNCTION notify_podcast_subscription_lifecycle()
        """
    )
    op.execute(
        """
        CREATE TRIGGER podcast_subscription_backfills_lifecycle_notify
        AFTER INSERT OR UPDATE OR DELETE ON podcast_subscription_backfills
        FOR EACH ROW EXECUTE FUNCTION notify_podcast_subscription_backfill_lifecycle()
        """
    )


def downgrade() -> None:
    raise RuntimeError("Hard cutover: 0218 is not reversible")
