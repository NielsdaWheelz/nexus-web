"""Attention ledger: reading_sessions + consumption_overrides.

Records every contiguous reading/listening episode as a first-class
``reading_sessions`` row and an explicit ``consumption_overrides`` verb. The
migration seeds sessions from existing reader/listening state so read-state
continuity survives the cutover with no code fallback (hard-cutover doctrine).

Revision ID: 0172
Revises: 0171
Create Date: 2026-07-08
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0172"
down_revision: str | Sequence[str] | None = "0171"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # (A) reading_sessions — one row per contiguous engagement episode.
    op.execute("""
        CREATE TABLE reading_sessions (
            id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            media_id        uuid        NOT NULL REFERENCES media(id) ON DELETE CASCADE,
            device_id       text        NOT NULL,
            started_at      timestamptz NOT NULL DEFAULT now(),
            last_active_at  timestamptz NOT NULL DEFAULT now(),
            dwell_ms        bigint      NOT NULL DEFAULT 0,
            max_progression real,
            spans           jsonb       NOT NULL DEFAULT '[]',

            CONSTRAINT ck_reading_sessions_dwell_non_negative
                CHECK (dwell_ms >= 0),
            CONSTRAINT ck_reading_sessions_max_progression
                CHECK (max_progression IS NULL
                       OR (max_progression >= 0.0 AND max_progression <= 1.0)),
            CONSTRAINT ck_reading_sessions_spans_array
                CHECK (jsonb_typeof(spans) = 'array'),
            CONSTRAINT ck_reading_sessions_device_id_len
                CHECK (char_length(device_id) <= 128)
        )
    """)
    # Hot session-continuity query: most recent session within the gap window.
    op.execute("""
        CREATE INDEX ix_reading_sessions_user_media_active
            ON reading_sessions (user_id, media_id, last_active_at DESC)
    """)
    # attention_on_day query: sessions by calendar date.
    op.execute("""
        CREATE INDEX ix_reading_sessions_user_started
            ON reading_sessions (user_id, started_at DESC)
    """)

    # (B) consumption_overrides — explicit user read-state override verb.
    op.execute("""
        CREATE TABLE consumption_overrides (
            user_id     uuid    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            media_id    uuid    NOT NULL REFERENCES media(id) ON DELETE CASCADE,
            status      text    NOT NULL,
            created_at  timestamptz NOT NULL DEFAULT now(),

            PRIMARY KEY (user_id, media_id),

            CONSTRAINT ck_consumption_overrides_status
                CHECK (status IN ('unread', 'finished'))
        )
    """)

    # (C) Data seed — preserve read-state continuity on day 1 without a code
    # fallback. Seeded rows carry device_id='__migrated__' for future identity.
    #
    # dwell_ms=30001 (> SESSION_DWELL_IN_PROGRESS_MS) on every seeded row so a
    # started-but-not-finished item derives "in_progress" from the session dwell,
    # exactly as the deleted _audio_read_state / _doc_read_state returned for any
    # started position. Without this floor a partially-played podcast (dwell 0,
    # 0 < progression < 0.95) would silently regress to "unread".
    op.execute("""
        INSERT INTO reading_sessions (id, user_id, media_id, device_id,
            started_at, last_active_at, dwell_ms, max_progression, spans)
        SELECT
            gen_random_uuid(),
            pls.user_id,
            pls.media_id,
            '__migrated__',
            pls.updated_at,
            pls.updated_at,
            30001,
            CASE
                WHEN pls.is_completed THEN 1.0
                WHEN pls.duration_ms > 0
                    THEN LEAST(pls.position_ms::real / pls.duration_ms, 1.0)
                ELSE NULL
            END,
            '[]'::jsonb
        FROM podcast_listening_states pls
        WHERE pls.is_completed OR pls.position_ms > 0
    """)
    # Reader docs with a saved scroll position. max_progression carries the
    # committed text progression from the locator (web/epub/transcript locators
    # store locations.total_progression) so a fully-read doc (>= 0.95) still
    # derives "finished", exactly as the deleted _doc_read_state did. PDF locators
    # carry no total_progression -> NULL, and dwell_ms=30001 keeps them
    # "in_progress" (finished PDFs are not distinguishable from the locator).
    op.execute("""
        INSERT INTO reading_sessions (id, user_id, media_id, device_id,
            started_at, last_active_at, dwell_ms, max_progression, spans)
        SELECT
            gen_random_uuid(),
            rms.user_id,
            rms.media_id,
            '__migrated__',
            rms.updated_at,
            rms.updated_at,
            30001,
            CASE
                WHEN (rms.locator -> 'locations' ->> 'total_progression') IS NULL
                    THEN NULL
                ELSE LEAST(1.0, GREATEST(0.0,
                    (rms.locator -> 'locations' ->> 'total_progression')::double precision))
            END,
            '[]'::jsonb
        FROM reader_media_state rms
        WHERE rms.locator IS NOT NULL
    """)


def downgrade() -> None:
    op.execute("DROP TABLE consumption_overrides")
    op.execute("DROP TABLE reading_sessions")
