"""Repair media content index state primary key.

Revision ID: 0075
Revises: 0074
Create Date: 2026-05-04
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0075"
down_revision: str | None = "0074"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        DO $$
        DECLARE
            primary_key_name text;
            primary_key_columns text[];
        BEGIN
            IF to_regclass('public.media_content_index_states') IS NULL THEN
                RETURN;
            END IF;

            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'media_content_index_states'
                  AND column_name = 'id'
            ) THEN
                ALTER TABLE media_content_index_states
                ADD COLUMN id uuid DEFAULT gen_random_uuid();
            END IF;

            UPDATE media_content_index_states
            SET id = gen_random_uuid()
            WHERE id IS NULL;

            ALTER TABLE media_content_index_states
            ALTER COLUMN id SET DEFAULT gen_random_uuid();

            ALTER TABLE media_content_index_states
            ALTER COLUMN id SET NOT NULL;

            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conrelid = 'media_content_index_states'::regclass
                  AND conname = 'uq_media_content_index_states_media'
            ) THEN
                ALTER TABLE media_content_index_states
                ADD CONSTRAINT uq_media_content_index_states_media UNIQUE (media_id);
            END IF;

            SELECT
                c.conname,
                array_agg(a.attname ORDER BY key.ordinality)
            INTO primary_key_name, primary_key_columns
            FROM pg_constraint c
            JOIN unnest(c.conkey) WITH ORDINALITY AS key(attnum, ordinality) ON true
            JOIN pg_attribute a
              ON a.attrelid = c.conrelid
             AND a.attnum = key.attnum
            WHERE c.conrelid = 'media_content_index_states'::regclass
              AND c.contype = 'p'
            GROUP BY c.conname;

            IF primary_key_name IS NOT NULL
               AND primary_key_columns IS DISTINCT FROM ARRAY['id']::text[] THEN
                EXECUTE format(
                    'ALTER TABLE media_content_index_states DROP CONSTRAINT %I',
                    primary_key_name
                );
                primary_key_name := NULL;
            END IF;

            IF primary_key_name IS NULL THEN
                ALTER TABLE media_content_index_states
                ADD CONSTRAINT pk_media_content_index_states PRIMARY KEY (id);
            END IF;
        END $$;
        """
    )


def downgrade() -> None:
    pass
