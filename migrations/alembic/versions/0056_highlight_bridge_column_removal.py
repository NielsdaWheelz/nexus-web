"""Remove legacy highlight bridge columns after the typed-anchor cutover.

Revision ID: 0056
Revises: 0055
Create Date: 2026-04-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0056"
down_revision: str | None = "0055"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_HFA_DELETE_FUNCTION = "delete_fragment_highlight_after_anchor_delete"
_HFA_DELETE_TRIGGER = "trg_highlight_fragment_anchor_delete_core"


def upgrade() -> None:
    # Backfill any residual fragment highlights that still only carry the
    # old bridge fields so the canonical anchor row remains the source of truth.
    op.execute(
        """
        UPDATE highlights AS h
        SET anchor_kind = 'fragment_offsets',
            anchor_media_id = f.media_id
        FROM fragments AS f
        WHERE h.fragment_id = f.id
          AND h.fragment_id IS NOT NULL
          AND h.start_offset IS NOT NULL
          AND h.end_offset IS NOT NULL
          AND (h.anchor_kind IS NULL OR h.anchor_kind = 'fragment_offsets')
          AND (h.anchor_media_id IS NULL OR h.anchor_media_id = f.media_id)
        """
    )

    op.execute(
        """
        INSERT INTO highlight_fragment_anchors (
            highlight_id,
            fragment_id,
            start_offset,
            end_offset
        )
        SELECT
            h.id,
            h.fragment_id,
            h.start_offset,
            h.end_offset
        FROM highlights AS h
        WHERE h.anchor_kind = 'fragment_offsets'
          AND h.fragment_id IS NOT NULL
          AND h.start_offset IS NOT NULL
          AND h.end_offset IS NOT NULL
          AND NOT EXISTS (
                SELECT 1
                FROM highlight_fragment_anchors AS hfa
                WHERE hfa.highlight_id = h.id
          )
        """
    )

    # Deleting a fragment now deletes the fragment anchor row first. This
    # trigger removes the owning logical highlight so annotations and transcript
    # anchors still cascade exactly as before.
    op.execute(
        f"""
        CREATE FUNCTION {_HFA_DELETE_FUNCTION}()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            DELETE FROM highlights
            WHERE id = OLD.highlight_id
              AND anchor_kind = 'fragment_offsets';
            RETURN NULL;
        END;
        $$;
        """
    )
    op.execute(
        f"""
        CREATE TRIGGER {_HFA_DELETE_TRIGGER}
        AFTER DELETE ON highlight_fragment_anchors
        FOR EACH ROW
        EXECUTE FUNCTION {_HFA_DELETE_FUNCTION}();
        """
    )

    op.drop_index("uix_highlights_user_fragment_offsets", table_name="highlights")
    op.drop_constraint("ck_highlights_fragment_bridge", "highlights", type_="check")
    op.drop_column("highlights", "end_offset")
    op.drop_column("highlights", "start_offset")
    op.drop_column("highlights", "fragment_id")


def downgrade() -> None:
    op.add_column("highlights", sa.Column("fragment_id", sa.UUID(), nullable=True))
    op.add_column("highlights", sa.Column("start_offset", sa.Integer(), nullable=True))
    op.add_column("highlights", sa.Column("end_offset", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_highlights_fragment_id",
        "highlights",
        "fragments",
        ["fragment_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_check_constraint(
        "ck_highlights_fragment_bridge",
        "highlights",
        "(fragment_id IS NOT NULL AND start_offset IS NOT NULL "
        "AND end_offset IS NOT NULL AND start_offset >= 0 "
        "AND end_offset > start_offset) "
        "OR (fragment_id IS NULL AND start_offset IS NULL "
        "AND end_offset IS NULL)",
    )

    op.execute(
        """
        UPDATE highlights AS h
        SET fragment_id = hfa.fragment_id,
            start_offset = hfa.start_offset,
            end_offset = hfa.end_offset
        FROM highlight_fragment_anchors AS hfa
        WHERE hfa.highlight_id = h.id
          AND h.anchor_kind = 'fragment_offsets'
        """
    )

    op.create_index(
        "uix_highlights_user_fragment_offsets",
        "highlights",
        ["user_id", "fragment_id", "start_offset", "end_offset"],
        unique=True,
    )

    op.execute(f"DROP TRIGGER {_HFA_DELETE_TRIGGER} ON highlight_fragment_anchors")
    op.execute(f"DROP FUNCTION {_HFA_DELETE_FUNCTION}()")
