"""Reader progress continuity: versioned canonical cursor rows.

Hard cutover of ``reader_media_state`` to one non-null locator plus a
monotonically increasing ``revision`` conflict token per user/media row:

1. delete legacy rows with a null locator (the removed public clear path);
2. remove the legacy locator CHECK rather than replacing it — locator validity
   is enforced by schemas/services which defect on invalid trusted rows;
3. make locator non-null and add revision defaulting existing rows to 1;
4. recreate both FKs under explicit stable names with default non-cascading
   behavior, discovering the deployed names from PostgreSQL rather than
   assuming names absent from the ORM (media deletion already removes child
   rows itself; there is no product user-delete flow, so the user FK restricts
   deletion until that lifecycle is explicitly designed);
5. backfill a zero-dwell ``reading_sessions`` row for every post-0172 cursor
   row that has no session, so document engagement recency survives reading
   ``reading_sessions`` instead of ``reader_media_state.updated_at`` once
   attention-only writes stop incidentally touching the cursor row.

Revision ID: 0180
Revises: 0179
Create Date: 2026-07-16

Numbering note: revision id "0179" belongs to the lightweight-author-dedup
cutover, which was deployed to production from its branch before this
migration merged; this migration therefore chains after it as ``0180``.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0180"
down_revision: str | Sequence[str] | None = "0179"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # (1) Null-locator rows were the removed clear semantics; a canonical
    # cursor row always carries a position.
    op.execute("DELETE FROM reader_media_state WHERE locator IS NULL")

    # (2) Remove the legacy locator CHECK (named by the ORM since creation).
    op.execute("""
        ALTER TABLE reader_media_state
            DROP CONSTRAINT ck_reader_media_state_locator
    """)

    # (3) Non-null locator + revision conflict token.
    op.execute("""
        ALTER TABLE reader_media_state
            ALTER COLUMN locator SET NOT NULL
    """)
    op.execute("""
        ALTER TABLE reader_media_state
            ADD COLUMN revision bigint NOT NULL DEFAULT 1
    """)

    # (4) Recreate both FKs under stable explicit names. The deployed names
    # were never set by the ORM, so discover and drop whatever PostgreSQL has.
    op.execute("""
        DO $$
        DECLARE
            fk_name text;
        BEGIN
            FOR fk_name IN
                SELECT con.conname
                FROM pg_constraint con
                WHERE con.conrelid = 'reader_media_state'::regclass
                  AND con.contype = 'f'
            LOOP
                EXECUTE format(
                    'ALTER TABLE reader_media_state DROP CONSTRAINT %I', fk_name
                );
            END LOOP;
        END $$
    """)
    op.execute("""
        ALTER TABLE reader_media_state
            ADD CONSTRAINT fk_reader_media_state_user
                FOREIGN KEY (user_id) REFERENCES users(id),
            ADD CONSTRAINT fk_reader_media_state_media
                FOREIGN KEY (media_id) REFERENCES media(id)
    """)

    # (5) Migration 0172 seeded sessions for rows existing then; cursor rows
    # created since by open/save-with-negligible-dwell may still lack one.
    # Zero dwell — this closes the recency gap without inventing dwell.
    # PDF locators carry no locations.total_progression -> NULL, matching 0172.
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
            0,
            -- GREATEST/LEAST ignore NULLs, so guard explicitly: a locator
            -- without locations.total_progression must stay NULL, not 0.0.
            CASE
                WHEN (rms.locator->'locations'->>'total_progression') IS NULL
                    THEN NULL
                ELSE LEAST(1.0, GREATEST(0.0,
                    (rms.locator->'locations'->>'total_progression')::double precision
                ))
            END,
            '[]'::jsonb
        FROM reader_media_state rms
        WHERE NOT EXISTS (
            SELECT 1
            FROM reading_sessions rs
            WHERE rs.user_id = rms.user_id
              AND rs.media_id = rms.media_id
        )
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE reader_media_state
            DROP CONSTRAINT fk_reader_media_state_user,
            DROP CONSTRAINT fk_reader_media_state_media
    """)
    op.execute("""
        ALTER TABLE reader_media_state
            ADD CONSTRAINT reader_media_state_user_id_fkey
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            ADD CONSTRAINT reader_media_state_media_id_fkey
                FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
    """)
    op.execute("ALTER TABLE reader_media_state DROP COLUMN revision")
    op.execute("ALTER TABLE reader_media_state ALTER COLUMN locator DROP NOT NULL")
    op.execute("""
        ALTER TABLE reader_media_state
            ADD CONSTRAINT ck_reader_media_state_locator
                CHECK (locator IS NULL
                       OR (jsonb_typeof(locator) = 'object'
                           AND locator <> '{}'::jsonb))
    """)
    op.execute("""
        DELETE FROM reading_sessions
        WHERE device_id = '__migrated__' AND dwell_ms = 0
    """)
