"""Cut reader media state to a flat layered locator resource.

Revision ID: 0051
Revises: 0050
Create Date: 2026-04-20
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0051"
down_revision: str | None = "0050"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "reader_media_state",
        sa.Column("id", sa.UUID(), nullable=True, server_default=sa.text("gen_random_uuid()")),
    )
    op.add_column(
        "reader_media_state",
        sa.Column("locator", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column(
        "reader_media_state",
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=True,
            server_default=sa.text("now()"),
        ),
    )

    op.execute(
        """
        UPDATE reader_media_state
        SET
            id = COALESCE(id, gen_random_uuid()),
            created_at = COALESCE(created_at, updated_at, now()),
            updated_at = COALESCE(updated_at, now())
        """
    )

    op.execute(
        """
        UPDATE reader_media_state
        SET locator = jsonb_strip_nulls(
            jsonb_build_object(
                'source',
                CASE WHEN fragment_id IS NOT NULL THEN fragment_id::text ELSE NULL END,
                'text_offset',
                "offset",
                'position',
                CASE
                    WHEN "offset" IS NOT NULL THEN (floor("offset" / 1024.0) + 1)::integer
                    ELSE NULL
                END
            )
        )
        WHERE locator_kind = 'fragment_offset' AND "offset" IS NOT NULL
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
                COALESCE(nav.href_path, state.section_id),
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
        WHERE state.locator_kind = 'epub_section'
          AND state.media_id = nav.media_id
          AND state.section_id = nav.location_id
        """
    )

    op.execute(
        """
        UPDATE reader_media_state
        SET locator = jsonb_strip_nulls(
            jsonb_build_object(
                'page',
                page,
                'position',
                page,
                'zoom',
                zoom
            )
        )
        WHERE locator_kind = 'pdf_page' AND page IS NOT NULL
        """
    )

    op.alter_column("reader_media_state", "id", nullable=False)
    op.alter_column("reader_media_state", "created_at", nullable=False)

    for constraint_name in (
        "ck_reader_media_state_locator_kind",
        "ck_reader_media_state_offset",
        "ck_reader_media_state_page",
        "ck_reader_media_state_zoom",
    ):
        op.drop_constraint(constraint_name, "reader_media_state", type_="check")

    for column_name in ("locator_kind", "fragment_id", "offset", "section_id", "page", "zoom"):
        op.drop_column("reader_media_state", column_name)

    op.drop_constraint("reader_media_state_pkey", "reader_media_state", type_="primary")
    op.create_primary_key("reader_media_state_pkey", "reader_media_state", ["id"])
    op.create_unique_constraint(
        "uq_reader_media_state_user_media",
        "reader_media_state",
        ["user_id", "media_id"],
    )
    op.create_check_constraint(
        "ck_reader_media_state_locator",
        "reader_media_state",
        "locator IS NULL OR (jsonb_typeof(locator) = 'object' AND locator <> '{}'::jsonb)",
    )


def downgrade() -> None:
    op.add_column("reader_media_state", sa.Column("locator_kind", sa.Text(), nullable=True))
    op.add_column("reader_media_state", sa.Column("fragment_id", sa.UUID(), nullable=True))
    op.add_column("reader_media_state", sa.Column("offset", sa.Integer(), nullable=True))
    op.add_column("reader_media_state", sa.Column("section_id", sa.Text(), nullable=True))
    op.add_column("reader_media_state", sa.Column("page", sa.Integer(), nullable=True))
    op.add_column("reader_media_state", sa.Column("zoom", sa.Numeric(5, 2), nullable=True))

    op.execute(
        """
        WITH epub_rows AS (
            SELECT state.id AS state_id, nav.location_id
            FROM reader_media_state AS state
            JOIN epub_nav_locations AS nav
              ON nav.media_id = state.media_id
             AND nav.href_path = state.locator->>'source'
             AND (
                    state.locator->>'anchor' IS NULL
                    OR nav.href_fragment = state.locator->>'anchor'
                 )
            WHERE state.locator ? 'source'
              AND state.locator->>'source' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        )
        UPDATE reader_media_state AS state
        SET
            locator_kind = 'epub_section',
            section_id = epub_rows.location_id
        FROM epub_rows
        WHERE state.id = epub_rows.state_id
        """
    )

    op.execute(
        """
        UPDATE reader_media_state
        SET
            locator_kind = 'fragment_offset',
            fragment_id = CASE
                WHEN locator->>'source' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                THEN (locator->>'source')::uuid
                ELSE NULL
            END,
            "offset" = CASE
                WHEN locator ? 'text_offset' THEN (locator->>'text_offset')::integer
                ELSE NULL
            END
        WHERE locator_kind IS NULL
          AND locator ? 'source'
          AND locator ? 'text_offset'
        """
    )

    op.execute(
        """
        UPDATE reader_media_state
        SET
            locator_kind = 'pdf_page',
            page = CASE WHEN locator ? 'page' THEN (locator->>'page')::integer ELSE NULL END,
            zoom = CASE WHEN locator ? 'zoom' THEN (locator->>'zoom')::numeric ELSE NULL END
        WHERE locator_kind IS NULL
          AND locator ? 'page'
        """
    )

    op.create_foreign_key(
        "reader_media_state_fragment_id_fkey",
        "reader_media_state",
        "fragments",
        ["fragment_id"],
        ["id"],
        ondelete="SET NULL",
    )

    op.drop_constraint("ck_reader_media_state_locator", "reader_media_state", type_="check")
    op.drop_constraint("uq_reader_media_state_user_media", "reader_media_state", type_="unique")
    op.drop_constraint("reader_media_state_pkey", "reader_media_state", type_="primary")
    op.create_primary_key("reader_media_state_pkey", "reader_media_state", ["user_id", "media_id"])

    op.create_check_constraint(
        "ck_reader_media_state_locator_kind",
        "reader_media_state",
        "locator_kind IS NULL OR locator_kind IN ('fragment_offset', 'epub_section', 'pdf_page')",
    )
    op.create_check_constraint(
        "ck_reader_media_state_offset",
        "reader_media_state",
        '"offset" IS NULL OR "offset" >= 0',
    )
    op.create_check_constraint(
        "ck_reader_media_state_page",
        "reader_media_state",
        "page IS NULL OR page >= 1",
    )
    op.create_check_constraint(
        "ck_reader_media_state_zoom",
        "reader_media_state",
        "zoom IS NULL OR (zoom BETWEEN 0.25 AND 4.0)",
    )

    op.drop_column("reader_media_state", "created_at")
    op.drop_column("reader_media_state", "locator")
    op.drop_column("reader_media_state", "id")
