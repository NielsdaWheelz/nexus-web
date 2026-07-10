"""Grand Atlas: media_atlas_positions — persistent 2D corpus positions.

A dedicated spatial substrate for the grand atlas. Each work gets a normalized
``(x, y)`` in ``[0, 1]`` produced by the ``atlas_project_job`` PCA projection;
the canvas maps these to celestial coordinates at render time
(see grand-atlas-hard-cutover.md §4.2). Sole writer:
``services/atlas_projection.py``.

Revision ID: 0177
Revises: 0176
Create Date: 2026-07-10
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0177"
down_revision: str | Sequence[str] | None = "0176"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE media_atlas_positions (
            media_id           uuid        PRIMARY KEY
                                           REFERENCES media(id) ON DELETE CASCADE,
            x                  real        NOT NULL,
            y                  real        NOT NULL,
            projection_version int         NOT NULL DEFAULT 1,
            computed_at        timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT ck_media_atlas_positions_x_range CHECK (x >= 0.0 AND x <= 1.0),
            CONSTRAINT ck_media_atlas_positions_y_range CHECK (y >= 0.0 AND y <= 1.0),
            CONSTRAINT ck_media_atlas_positions_version_positive
                CHECK (projection_version >= 1)
        )
    """)
    op.execute("""
        COMMENT ON TABLE media_atlas_positions IS
          'Persistent 2D position for each work in the grand atlas, produced by the '
          'atlas_project_job PCA projection. x/y in [0,1]; maps to celestial coords '
          'at render time (see grand-atlas-hard-cutover.md 4.2). Sole writer: '
          'services/atlas_projection.py.'
    """)
    op.execute("""
        CREATE INDEX ix_media_atlas_positions_version
            ON media_atlas_positions (projection_version)
    """)


def downgrade() -> None:
    op.execute("DROP TABLE media_atlas_positions")
