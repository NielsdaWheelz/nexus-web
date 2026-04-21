"""Repair reader locator storage to the flat layered payload.

Revision ID: 0054
Revises: 0053
Create Date: 2026-04-21
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0054"
down_revision: str | None = "0053"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
FLAT_LOCATOR_CHECK = "locator IS NULL OR (jsonb_typeof(locator) = 'object' AND locator <> '{}'::jsonb)"


def upgrade() -> None:
    op.execute(
        """
        UPDATE reader_media_state
        SET locator = NULL
        WHERE locator = 'null'::jsonb
        """
    )

    op.execute(
        f"""
        UPDATE reader_media_state
        SET locator = jsonb_strip_nulls(
            jsonb_build_object(
                'source',
                CASE
                    WHEN locator ? 'fragment_id'
                     AND locator->>'fragment_id' ~* '{UUID_PATTERN}'
                    THEN locator->>'fragment_id'
                    ELSE NULL
                END,
                'text_offset',
                CASE
                    WHEN locator ? 'offset' THEN (locator->>'offset')::integer
                    ELSE NULL
                END,
                'position',
                CASE
                    WHEN locator ? 'offset'
                    THEN (floor((locator->>'offset')::numeric / 1024.0) + 1)::integer
                    ELSE NULL
                END
            )
        )
        WHERE locator IS NOT NULL
          AND jsonb_typeof(locator) = 'object'
          AND locator->>'type' = 'fragment_offset'
        """
    )

    op.execute(
        """
        UPDATE reader_media_state
        SET locator = jsonb_strip_nulls(
            jsonb_build_object(
                'page',
                CASE WHEN locator ? 'page' THEN (locator->>'page')::integer ELSE NULL END,
                'position',
                CASE WHEN locator ? 'page' THEN (locator->>'page')::integer ELSE NULL END,
                'zoom',
                CASE WHEN locator ? 'zoom' THEN (locator->>'zoom')::numeric ELSE NULL END
            )
        )
        WHERE locator IS NOT NULL
          AND jsonb_typeof(locator) = 'object'
          AND locator->>'type' = 'pdf_page'
        """
    )

    op.execute(
        """
        WITH nav_counts AS (
            SELECT media_id, COUNT(*)::integer AS total_sections
            FROM epub_nav_locations
            GROUP BY media_id
        )
        UPDATE reader_media_state AS state
        SET locator = jsonb_strip_nulls(
            jsonb_build_object(
                'source',
                COALESCE(nav.href_path, state.locator->>'section_id'),
                'anchor',
                nav.href_fragment,
                'progression',
                CASE
                    WHEN nav.ordinal IS NOT NULL THEN 0.0
                    ELSE NULL
                END,
                'total_progression',
                CASE
                    WHEN counts.total_sections IS NOT NULL AND counts.total_sections > 0
                    THEN LEAST(
                        1.0,
                        GREATEST(0.0, (GREATEST(nav.ordinal, 1) - 1)::numeric / counts.total_sections::numeric)
                    )
                    ELSE NULL
                END,
                'position',
                CASE WHEN nav.ordinal IS NOT NULL THEN GREATEST(nav.ordinal, 1) ELSE NULL END
            )
        )
        FROM epub_nav_locations AS nav
        LEFT JOIN nav_counts AS counts
          ON counts.media_id = nav.media_id
        WHERE state.locator IS NOT NULL
          AND jsonb_typeof(state.locator) = 'object'
          AND state.locator->>'type' = 'epub_section'
          AND state.media_id = nav.media_id
          AND state.locator->>'section_id' = nav.location_id
        """
    )

    op.execute(
        """
        UPDATE reader_media_state
        SET locator = jsonb_strip_nulls(
            jsonb_build_object(
                'source',
                locator->>'section_id'
            )
        )
        WHERE locator IS NOT NULL
          AND jsonb_typeof(locator) = 'object'
          AND locator->>'type' = 'epub_section'
        """
    )

    op.execute(
        """
        UPDATE reader_media_state
        SET locator = NULL
        WHERE locator IS NOT NULL
          AND (
                jsonb_typeof(locator) <> 'object'
                OR locator = '{}'::jsonb
              )
        """
    )

    op.drop_constraint("ck_reader_media_state_locator", "reader_media_state", type_="check")
    op.create_check_constraint(
        "ck_reader_media_state_locator",
        "reader_media_state",
        FLAT_LOCATOR_CHECK,
    )


def downgrade() -> None:
    op.drop_constraint("ck_reader_media_state_locator", "reader_media_state", type_="check")
    op.create_check_constraint(
        "ck_reader_media_state_locator",
        "reader_media_state",
        FLAT_LOCATOR_CHECK,
    )
