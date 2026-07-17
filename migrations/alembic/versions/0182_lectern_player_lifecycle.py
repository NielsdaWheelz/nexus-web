"""Lectern + global player lifecycle: teardown intent, watermark, heartbeat
fencing, dead CHECK removal, and non-cascading user/media FKs.

Hard cutover of the shared consumption/listening/attention storage shape (spec
docs/cutovers/lectern-player-lifecycle-hard-cutover.md §3.1/§4/§5.3/§5.4):

1. preflight — abort if any ``consumption_queue_items`` row still carries the
   dead ``auto_playlist`` source; that provenance needs an explicit
   disposition before the source CHECK below is dropped (spec §4);
2. create ``media_teardown_intents`` — presence excludes a media row from
   public visibility and blocks new references (spec §3.1); the primary key is
   application-generated (UUIDv7 via ``nexus.ids.new_uuid7``, not a database
   default);
3. add ``podcast_subscriptions.auto_queue_watermark_at`` (spec §5.3);
4. add ``media_source_attempts.signed_upload_expires_at`` and conservatively
   backfill every still-pending signed-upload attempt (``uploaded_pdf_file`` /
   ``uploaded_epub_file`` — the only source types
   ``accept_uploaded_file_source`` creates for signed browser uploads — with
   status ``accepted`` or ``queued``) to database ``now() + 300 seconds``, the
   capped signed-URL TTL (spec §3.1 "Browser direct upload");
5. drop (do not replace) ``ck_consumption_queue_items_source`` and
   ``ck_consumption_overrides_status`` — persistence adapters alone own the
   enum vocabulary now (spec §4; docs/rules/database.md forbids
   business-invariant CHECKs);
6. clamp any pre-cutover ``podcast_listening_states.playback_speed`` outside the
   new wire bound ``[0.25, 3]`` (the old CHECK only enforced ``> 0``) into range,
   then add ``podcast_listening_states.{write_revision,reset_epoch}``, non-null
   defaulting to zero (spec §5.4). Without the clamp, a legacy out-of-range row
   makes ``ListeningStateOut``/``FooterAudioActivation`` construction raise on
   read, 500ing that viewer's whole Lectern;
7. recreate the user/media foreign keys on ``consumption_queue_items``,
   ``consumption_overrides``, ``podcast_listening_states``, and
   ``reading_sessions`` under stable explicit non-cascading names, discovering
   the deployed (ORM-unnamed, Postgres-default) names from PostgreSQL rather
   than assuming a name absent from the ORM — exactly as 0180 did for
   ``reader_media_state``. There is no product user-delete flow yet, so the
   user FK restricts deletion until a complete account-lifecycle cutover (spec
   §2 non-goals); media teardown already deletes child rows itself through its
   own owners.

Revision ID: 0182
Revises: 0181
Create Date: 2026-07-16
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0182"
down_revision: str | Sequence[str] | None = "0181"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The four in-scope tables whose user/media FKs move to stable non-cascading
# names (spec §7 "Create" bullet); all point at users.id / media.id.
_FK_OWNER_TABLES: tuple[str, ...] = (
    "consumption_queue_items",
    "consumption_overrides",
    "podcast_listening_states",
    "reading_sessions",
)


def _drop_all_foreign_keys(table: str) -> None:
    """Drop every FK constraint currently on ``table``, whatever Postgres named
    it. Mirrors 0180's ``reader_media_state`` precedent: these FKs were added
    via unnamed ``ForeignKey(...)``/``REFERENCES`` clauses, so the deployed name
    is Postgres's own default rather than anything the ORM chose."""

    op.execute(f"""
        DO $$
        DECLARE
            fk_name text;
        BEGIN
            FOR fk_name IN
                SELECT con.conname
                FROM pg_constraint con
                WHERE con.conrelid = '{table}'::regclass
                  AND con.contype = 'f'
            LOOP
                EXECUTE format('ALTER TABLE {table} DROP CONSTRAINT %I', fk_name);
            END LOOP;
        END $$
    """)


def upgrade() -> None:
    bind = op.get_bind()

    # (1) Preflight (spec §4). Zero rows expected; abort loudly rather than
    # silently dropping the CHECK out from under an undecided provenance value.
    auto_playlist_count = int(
        bind.exec_driver_sql(
            "SELECT count(*) FROM consumption_queue_items WHERE source = 'auto_playlist'"
        ).scalar_one()
    )
    if auto_playlist_count:
        raise RuntimeError(
            f"0182 preflight: {auto_playlist_count} consumption_queue_items row(s) carry "
            "source='auto_playlist'; this provenance needs an explicit disposition before "
            "ck_consumption_queue_items_source is dropped "
            "(docs/cutovers/lectern-player-lifecycle-hard-cutover.md §4)"
        )

    # (2) Media teardown intent (spec §3.1). No server default on id: intent
    # creation is application-generated UUIDv7, not a database function.
    op.execute("""
        CREATE TABLE media_teardown_intents (
            id          uuid        PRIMARY KEY,
            media_id    uuid        NOT NULL,
            created_at  timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT fk_media_teardown_intents_media
                FOREIGN KEY (media_id) REFERENCES media(id),
            CONSTRAINT uq_media_teardown_intents_media
                UNIQUE (media_id)
        )
    """)

    # (3) Auto-subscription eligibility watermark (spec §5.3).
    op.execute("""
        ALTER TABLE podcast_subscriptions
            ADD COLUMN auto_queue_watermark_at timestamptz NULL
    """)

    # (4) Signed direct-upload expiry (spec §3.1 "Browser direct upload").
    op.execute("""
        ALTER TABLE media_source_attempts
            ADD COLUMN signed_upload_expires_at timestamptz NULL
    """)
    op.execute("""
        UPDATE media_source_attempts
        SET signed_upload_expires_at = now() + interval '300 seconds'
        WHERE source_type IN ('uploaded_pdf_file', 'uploaded_epub_file')
          AND status IN ('accepted', 'queued')
    """)

    # (5) Drop (do not replace) the source/status CHECKs (spec §4).
    op.execute(
        "ALTER TABLE consumption_queue_items DROP CONSTRAINT ck_consumption_queue_items_source"
    )
    op.execute("ALTER TABLE consumption_overrides DROP CONSTRAINT ck_consumption_overrides_status")

    # (6) Clamp any pre-cutover out-of-range playback_speed into the new wire
    # bound [0.25, 3] before extending the row shape (spec §5.4). The old CHECK
    # (ck_podcast_listening_states_playback_speed_positive) only enforced > 0, so
    # a legacy row could carry any positive value; left unclamped, it would make
    # ListeningStateOut/FooterAudioActivation construction raise on read and 500
    # that viewer's whole Lectern.
    op.execute("""
        UPDATE podcast_listening_states
        SET playback_speed = LEAST(3.0, GREATEST(0.25, playback_speed))
        WHERE playback_speed < 0.25 OR playback_speed > 3.0
    """)

    # Listening heartbeat fencing tokens (spec §5.4); new rows start at zero.
    op.execute("""
        ALTER TABLE podcast_listening_states
            ADD COLUMN write_revision integer NOT NULL DEFAULT 0
    """)
    op.execute("""
        ALTER TABLE podcast_listening_states
            ADD COLUMN reset_epoch integer NOT NULL DEFAULT 0
    """)

    # (7) Recreate user/media FKs under stable explicit non-cascading names.
    for table in _FK_OWNER_TABLES:
        _drop_all_foreign_keys(table)
        op.execute(f"""
            ALTER TABLE {table}
                ADD CONSTRAINT fk_{table}_user
                    FOREIGN KEY (user_id) REFERENCES users(id),
                ADD CONSTRAINT fk_{table}_media
                    FOREIGN KEY (media_id) REFERENCES media(id)
        """)


def downgrade() -> None:
    # (7) Restore the original Postgres-default-named cascading FKs.
    for table in _FK_OWNER_TABLES:
        op.execute(f"""
            ALTER TABLE {table}
                DROP CONSTRAINT fk_{table}_user,
                DROP CONSTRAINT fk_{table}_media
        """)
        op.execute(f"""
            ALTER TABLE {table}
                ADD CONSTRAINT {table}_user_id_fkey
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                ADD CONSTRAINT {table}_media_id_fkey
                    FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
        """)

    # (6) Drop heartbeat fencing tokens.
    op.execute("ALTER TABLE podcast_listening_states DROP COLUMN write_revision")
    op.execute("ALTER TABLE podcast_listening_states DROP COLUMN reset_epoch")

    # (5) Restore the dropped CHECKs to their pre-0182 vocabularies (0175/0172).
    op.execute("""
        ALTER TABLE consumption_queue_items
            ADD CONSTRAINT ck_consumption_queue_items_source
                CHECK (source IN ('manual', 'auto_subscription', 'auto_playlist', 'assistant'))
    """)
    op.execute("""
        ALTER TABLE consumption_overrides
            ADD CONSTRAINT ck_consumption_overrides_status
                CHECK (status IN ('unread', 'finished'))
    """)

    # (4) Drop signed-upload expiry (the backfilled values are discarded with it).
    op.execute("ALTER TABLE media_source_attempts DROP COLUMN signed_upload_expires_at")

    # (3) Drop the auto-subscription watermark.
    op.execute("ALTER TABLE podcast_subscriptions DROP COLUMN auto_queue_watermark_at")

    # (2) Drop the teardown-intent table.
    op.execute("DROP TABLE media_teardown_intents")
