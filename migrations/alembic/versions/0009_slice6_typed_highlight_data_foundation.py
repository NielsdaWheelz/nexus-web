"""Slice 6 PR-01 — typed-highlight data foundation

Revision ID: 0009
Revises: 0008
Create Date: 2026-02-24

Additive schema/model groundwork for unified logical highlights with typed
anchors and PDF quote-text artifacts.  No public behavior changes.

Key changes:
- Add media.plain_text and media.page_count for PDF text readiness
- Add highlights.anchor_kind and highlights.anchor_media_id (dormant until pr-02)
- Convert highlights fragment columns to transitional nullable bridge
- Create highlight_fragment_anchors (1:1 anchor subtype)
- Create highlight_pdf_anchors (1:1 anchor subtype + quote-match metadata)
- Create highlight_pdf_quads (geometry segments)
- Create pdf_page_text_spans (page-indexed offsets into media.plain_text)

Rollout posture:
- Greenfield-safe: assumes zero existing highlight data in production.
- All new columns on highlights are nullable with no DB defaults.
- Legacy fragment columns become nullable but retain conditional validity
  checks (the "compatibility bridge") so existing fragment inserts work.
- Existing unique index on (user_id, fragment_id, start_offset, end_offset)
  is retained; PostgreSQL NULL-distinct semantics prevent false conflicts
  for future non-fragment rows with NULL fragment columns.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ======================================================================
    # Step 1: Extend media table for PDF text readiness
    # ======================================================================
    op.add_column("media", sa.Column("plain_text", sa.Text(), nullable=True))
    op.add_column("media", sa.Column("page_count", sa.Integer(), nullable=True))
    op.create_check_constraint(
        "ck_media_page_count_positive",
        "media",
        "page_count IS NULL OR page_count >= 1",
    )

    # ======================================================================
    # Step 2: Add typed-highlight logical fields to highlights (dormant)
    # ======================================================================
    op.add_column("highlights", sa.Column("anchor_kind", sa.Text(), nullable=True))
    op.add_column(
        "highlights", sa.Column("anchor_media_id", sa.UUID(), nullable=True)
    )
    op.create_foreign_key(
        "fk_highlights_anchor_media_id",
        "highlights",
        "media",
        ["anchor_media_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_check_constraint(
        "ck_highlights_anchor_fields_paired_null",
        "highlights",
        "(anchor_kind IS NULL AND anchor_media_id IS NULL) "
        "OR (anchor_kind IS NOT NULL AND anchor_media_id IS NOT NULL)",
    )
    op.create_check_constraint(
        "ck_highlights_anchor_kind_valid",
        "highlights",
        "anchor_kind IS NULL OR anchor_kind IN ('fragment_offsets', 'pdf_page_geometry')",
    )

    # ======================================================================
    # Step 3: Transitional nullable bridge for legacy fragment columns
    # ======================================================================
    op.drop_constraint("ck_highlights_offsets_valid", "highlights", type_="check")
    op.alter_column("highlights", "fragment_id", nullable=True)
    op.alter_column("highlights", "start_offset", nullable=True)
    op.alter_column("highlights", "end_offset", nullable=True)
    op.create_check_constraint(
        "ck_highlights_fragment_bridge",
        "highlights",
        "(fragment_id IS NOT NULL AND start_offset IS NOT NULL "
        "AND end_offset IS NOT NULL AND start_offset >= 0 "
        "AND end_offset > start_offset) "
        "OR (fragment_id IS NULL AND start_offset IS NULL "
        "AND end_offset IS NULL)",
    )

    # ======================================================================
    # Step 4: Create highlight_fragment_anchors (1:1 subtype)
    # ======================================================================
    op.create_table(
        "highlight_fragment_anchors",
        sa.Column(
            "highlight_id",
            sa.UUID(),
            sa.ForeignKey("highlights.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "fragment_id",
            sa.UUID(),
            sa.ForeignKey("fragments.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("start_offset", sa.Integer(), nullable=False),
        sa.Column("end_offset", sa.Integer(), nullable=False),
    )
    op.create_check_constraint(
        "ck_hfa_offsets_valid",
        "highlight_fragment_anchors",
        "start_offset >= 0 AND end_offset > start_offset",
    )

    # ======================================================================
    # Step 5: Create highlight_pdf_anchors (1:1 subtype + quote-match)
    # ======================================================================
    op.create_table(
        "highlight_pdf_anchors",
        sa.Column(
            "highlight_id",
            sa.UUID(),
            sa.ForeignKey("highlights.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "media_id",
            sa.UUID(),
            sa.ForeignKey("media.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("page_number", sa.Integer(), nullable=False),
        sa.Column("geometry_version", sa.SmallInteger(), nullable=False),
        sa.Column("geometry_fingerprint", sa.Text(), nullable=False),
        sa.Column("sort_top", sa.Numeric(), nullable=False),
        sa.Column("sort_left", sa.Numeric(), nullable=False),
        sa.Column("plain_text_match_version", sa.SmallInteger(), nullable=True),
        sa.Column(
            "plain_text_match_status",
            sa.Text(),
            nullable=False,
            server_default="pending",
        ),
        sa.Column("plain_text_start_offset", sa.Integer(), nullable=True),
        sa.Column("plain_text_end_offset", sa.Integer(), nullable=True),
        sa.Column("rect_count", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_check_constraint(
        "ck_hpa_page_number", "highlight_pdf_anchors", "page_number >= 1"
    )
    op.create_check_constraint(
        "ck_hpa_geometry_version", "highlight_pdf_anchors", "geometry_version >= 1"
    )
    op.create_check_constraint(
        "ck_hpa_rect_count", "highlight_pdf_anchors", "rect_count >= 1"
    )
    op.create_check_constraint(
        "ck_hpa_match_status",
        "highlight_pdf_anchors",
        "plain_text_match_status IN "
        "('pending', 'unique', 'ambiguous', 'no_match', 'empty_exact')",
    )
    op.create_check_constraint(
        "ck_hpa_match_version",
        "highlight_pdf_anchors",
        "plain_text_match_version IS NULL OR plain_text_match_version >= 1",
    )
    op.create_check_constraint(
        "ck_hpa_match_offsets_non_negative",
        "highlight_pdf_anchors",
        "(plain_text_start_offset IS NULL OR plain_text_start_offset >= 0) "
        "AND (plain_text_end_offset IS NULL OR plain_text_end_offset >= 0)",
    )
    op.create_check_constraint(
        "ck_hpa_match_offsets_paired_null",
        "highlight_pdf_anchors",
        "(plain_text_start_offset IS NULL AND plain_text_end_offset IS NULL) "
        "OR (plain_text_start_offset IS NOT NULL AND plain_text_end_offset IS NOT NULL)",
    )
    op.create_index(
        "ix_hpa_media_page_sort",
        "highlight_pdf_anchors",
        ["media_id", "page_number", "sort_top", "sort_left"],
    )
    op.create_index(
        "ix_hpa_geometry_lookup",
        "highlight_pdf_anchors",
        ["media_id", "page_number", "geometry_version", "geometry_fingerprint"],
    )

    # ======================================================================
    # Step 6: Create highlight_pdf_quads (geometry segments)
    # ======================================================================
    op.create_table(
        "highlight_pdf_quads",
        sa.Column(
            "highlight_id",
            sa.UUID(),
            sa.ForeignKey("highlights.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("quad_idx", sa.Integer(), nullable=False),
        sa.Column("x1", sa.Numeric(), nullable=False),
        sa.Column("y1", sa.Numeric(), nullable=False),
        sa.Column("x2", sa.Numeric(), nullable=False),
        sa.Column("y2", sa.Numeric(), nullable=False),
        sa.Column("x3", sa.Numeric(), nullable=False),
        sa.Column("y3", sa.Numeric(), nullable=False),
        sa.Column("x4", sa.Numeric(), nullable=False),
        sa.Column("y4", sa.Numeric(), nullable=False),
        sa.PrimaryKeyConstraint("highlight_id", "quad_idx"),
    )
    op.create_check_constraint(
        "ck_hpq_quad_idx", "highlight_pdf_quads", "quad_idx >= 0"
    )

    # ======================================================================
    # Step 7: Create pdf_page_text_spans (page-indexed plain_text offsets)
    # ======================================================================
    op.create_table(
        "pdf_page_text_spans",
        sa.Column(
            "media_id",
            sa.UUID(),
            sa.ForeignKey("media.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("page_number", sa.Integer(), nullable=False),
        sa.Column("start_offset", sa.Integer(), nullable=False),
        sa.Column("end_offset", sa.Integer(), nullable=False),
        sa.Column("text_extract_version", sa.SmallInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("media_id", "page_number"),
    )
    op.create_check_constraint(
        "ck_ppts_page_number", "pdf_page_text_spans", "page_number >= 1"
    )
    op.create_check_constraint(
        "ck_ppts_start_offset", "pdf_page_text_spans", "start_offset >= 0"
    )
    op.create_check_constraint(
        "ck_ppts_offsets_valid", "pdf_page_text_spans", "end_offset >= start_offset"
    )
    op.create_check_constraint(
        "ck_ppts_extract_version",
        "pdf_page_text_spans",
        "text_extract_version >= 1",
    )


def downgrade() -> None:
    # --- Drop new tables (reverse creation order) ---
    op.drop_table("pdf_page_text_spans")
    op.drop_table("highlight_pdf_quads")

    op.drop_index("ix_hpa_geometry_lookup", table_name="highlight_pdf_anchors")
    op.drop_index("ix_hpa_media_page_sort", table_name="highlight_pdf_anchors")
    op.drop_table("highlight_pdf_anchors")

    op.drop_table("highlight_fragment_anchors")

    # --- Restore highlights to pre-0009 state ---
    op.drop_constraint("ck_highlights_fragment_bridge", "highlights", type_="check")
    op.alter_column("highlights", "end_offset", nullable=False)
    op.alter_column("highlights", "start_offset", nullable=False)
    op.alter_column("highlights", "fragment_id", nullable=False)
    op.create_check_constraint(
        "ck_highlights_offsets_valid",
        "highlights",
        "start_offset >= 0 AND end_offset > start_offset",
    )

    op.drop_constraint(
        "ck_highlights_anchor_kind_valid", "highlights", type_="check"
    )
    op.drop_constraint(
        "ck_highlights_anchor_fields_paired_null", "highlights", type_="check"
    )
    op.drop_constraint(
        "fk_highlights_anchor_media_id", "highlights", type_="foreignkey"
    )
    op.drop_column("highlights", "anchor_media_id")
    op.drop_column("highlights", "anchor_kind")

    # --- Restore media to pre-0009 state ---
    op.drop_constraint("ck_media_page_count_positive", "media", type_="check")
    op.drop_column("media", "page_count")
    op.drop_column("media", "plain_text")
