"""Ready-only retained reader members and canonical query projections.

Revision ID: 0229
Revises: 0228
Create Date: 2026-09-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0229"
down_revision: str | Sequence[str] | None = "0228"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "highlight_pdf_anchors", sa.Column("source_sha256", sa.Text(), nullable=True)
    )
    op.create_table(
        "reader_publication_artifacts",
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("generation", sa.BigInteger(), nullable=False),
        sa.Column("path", sa.Text(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column("storage_path", sa.Text(), nullable=False),
        sa.Column("media_type", sa.Text(), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.Text(), nullable=False),
        sa.Column("archive_expanded_bytes", sa.BigInteger(), nullable=True),
        sa.Column("pdf_page_count", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("media_id", "generation", "path"),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"]),
    )
    op.create_index(
        "ix_reader_publication_artifacts_storage",
        "reader_publication_artifacts",
        ["storage_path"],
    )
    op.create_table(
        "reader_publication_units",
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("generation", sa.BigInteger(), nullable=False),
        sa.Column("unit_key", sa.Text(), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("fragment_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("fragment_idx", sa.Integer(), nullable=False),
        sa.Column("start_cp", sa.Integer(), nullable=False),
        sa.Column("end_cp", sa.Integer(), nullable=False),
        sa.Column("canonical_text", sa.Text(), nullable=False),
        sa.Column("word_boundaries", sa.ARRAY(sa.Integer()), nullable=False),
        sa.Column("embed_markers", postgresql.JSONB(), nullable=False),
        sa.PrimaryKeyConstraint("media_id", "generation", "unit_key"),
        sa.ForeignKeyConstraint(
            ["media_id", "generation", "unit_key"],
            [
                "reader_publication_artifacts.media_id",
                "reader_publication_artifacts.generation",
                "reader_publication_artifacts.path",
            ],
            name="fk_reader_publication_units_member",
        ),
        sa.UniqueConstraint(
            "media_id",
            "generation",
            "ordinal",
            name="uq_reader_publication_unit_ordinal",
        ),
    )
    op.create_index(
        "ix_reader_publication_unit_fragment",
        "reader_publication_units",
        ["media_id", "generation", "fragment_id", "start_cp", "ordinal"],
        postgresql_where=sa.text("end_cp > start_cp"),
    )
    op.create_index(
        "ix_reader_publication_nonempty_ordinal",
        "reader_publication_units",
        ["media_id", "generation", "ordinal"],
        postgresql_where=sa.text("end_cp > start_cp"),
    )
    # Retained-fragment ownership resolution constrains fragment_id alone and reads
    # only the owning media, so this access path leads with fragment_id and is not
    # partial: a zero-text unit still proves its fragment belonged to that media.
    op.create_index(
        "ix_reader_publication_unit_fragment_owner",
        "reader_publication_units",
        ["fragment_id", "media_id"],
    )
    op.create_table(
        "reader_publication_targets",
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("generation", sa.BigInteger(), nullable=False),
        sa.Column("target_id", sa.Text(), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("unit_key", sa.Text(), nullable=False),
        sa.Column("offset_cp", sa.Integer(), nullable=False),
        sa.Column("end_cp", sa.Integer(), nullable=True),
        sa.Column("href_path", sa.Text(), nullable=True),
        sa.Column("href_pathname", sa.Text(), nullable=True),
        sa.Column("anchor_id", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("media_id", "generation", "target_id"),
        sa.ForeignKeyConstraint(
            ["media_id", "generation", "unit_key"],
            [
                "reader_publication_units.media_id",
                "reader_publication_units.generation",
                "reader_publication_units.unit_key",
            ],
            name="fk_reader_publication_targets_unit",
        ),
    )
    op.create_index(
        "ix_reader_publication_target_order",
        "reader_publication_targets",
        ["media_id", "generation", "ordinal", "target_id"],
    )
    op.create_index(
        "ix_reader_publication_target_pathname",
        "reader_publication_targets",
        ["href_pathname"],
        postgresql_using="hash",
    )

    op.create_table(
        "reader_publication_anchors",
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("generation", sa.BigInteger(), nullable=False),
        sa.Column("anchor_key", sa.Text(), nullable=False),
        sa.Column("href_path", sa.Text(), nullable=False),
        sa.Column("anchor_id", sa.Text(), nullable=False),
        sa.Column("unit_key", sa.Text(), nullable=False),
        sa.Column("offset_cp", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("media_id", "generation", "anchor_key"),
        sa.ForeignKeyConstraint(
            ["media_id", "generation", "unit_key"],
            [
                "reader_publication_units.media_id",
                "reader_publication_units.generation",
                "reader_publication_units.unit_key",
            ],
            name="fk_reader_publication_anchors_unit",
        ),
    )

    op.create_table(
        "reader_publication_apparatus_items",
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("generation", sa.BigInteger(), nullable=False),
        sa.Column("item_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("stable_key", sa.Text(), nullable=False),
        sa.Column("sort_key", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("label", sa.Text(), nullable=True),
        sa.Column("body_text", sa.Text(), nullable=True),
        sa.Column(
            "label_codepoints",
            sa.Integer(),
            sa.Computed("char_length(label)", persisted=True),
            nullable=True,
        ),
        sa.Column(
            "body_codepoints",
            sa.Integer(),
            sa.Computed("char_length(body_text)", persisted=True),
            nullable=True,
        ),
        sa.Column("locator", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column(
            "location",
            postgresql.JSONB(none_as_null=True),
            sa.Computed(
                "locator - ARRAY['exact', 'prefix', 'suffix', 'text_quote_selector']::text[]",
                persisted=True,
            ),
            nullable=True,
        ),
        sa.Column("locator_status", sa.Text(), nullable=False),
        sa.Column("confidence", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("media_id", "generation", "item_id"),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"]),
        sa.UniqueConstraint(
            "media_id",
            "generation",
            "ordinal",
            name="uq_reader_publication_apparatus_order",
        ),
    )
    op.create_index(
        "ix_reader_publication_apparatus_identity",
        "reader_publication_apparatus_items",
        ["item_id", "generation"],
    )
    op.create_table(
        "reader_publication_apparatus_edges",
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("generation", sa.BigInteger(), nullable=False),
        sa.Column("edge_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("from_item_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("to_item_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("relation", sa.Text(), nullable=False),
        sa.Column("confidence", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("media_id", "generation", "edge_id"),
        sa.UniqueConstraint(
            "media_id",
            "generation",
            "ordinal",
            name="uq_reader_publication_apparatus_edge_order",
        ),
        *(
            sa.ForeignKeyConstraint(
                ["media_id", "generation", f"{endpoint}_item_id"],
                [
                    "reader_publication_apparatus_items.media_id",
                    "reader_publication_apparatus_items.generation",
                    "reader_publication_apparatus_items.item_id",
                ],
                name=f"fk_reader_publication_apparatus_{endpoint}",
            )
            for endpoint in ("from", "to")
        ),
    )
    for endpoint in ("from", "to"):
        op.create_index(
            f"ix_reader_publication_apparatus_{endpoint}",
            "reader_publication_apparatus_edges",
            ["media_id", "generation", f"{endpoint}_item_id", "ordinal"],
        )

    op.create_table(
        "reader_publication_search_sources",
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("generation", sa.BigInteger(), nullable=False),
        sa.Column("source_ordinal", sa.Integer(), nullable=False),
        sa.Column("fragment_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("raw_codepoints", sa.Integer(), nullable=False),
        sa.Column("normalized_codepoints", sa.Integer(), nullable=False),
        sa.Column("normalized_text", sa.Text(), nullable=False),
        sa.Column("canonical_text", sa.Text(), nullable=True),
        sa.Column("pdf_page_spans", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("pdf_quote_text_ready", sa.Boolean(), nullable=True),
        sa.Column(
            "pdf_page_heights", postgresql.JSONB(none_as_null=True), nullable=True
        ),
        sa.PrimaryKeyConstraint("media_id", "generation", "source_ordinal"),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"]),
    )
    op.create_table(
        "reader_publication_search_maps",
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("generation", sa.BigInteger(), nullable=False),
        sa.Column("source_ordinal", sa.Integer(), nullable=False),
        sa.Column("normalized_start", sa.Integer(), nullable=False),
        sa.Column("normalized_end", sa.Integer(), nullable=False),
        sa.Column("page_number", sa.Integer(), nullable=True),
        sa.Column("run_starts", sa.ARRAY(sa.Integer()), nullable=True),
        sa.Column("raw_deltas", sa.ARRAY(sa.Integer()), nullable=True),
        sa.PrimaryKeyConstraint(
            "media_id", "generation", "source_ordinal", "normalized_start"
        ),
        sa.ForeignKeyConstraint(
            ["media_id", "generation", "source_ordinal"],
            [
                "reader_publication_search_sources.media_id",
                "reader_publication_search_sources.generation",
                "reader_publication_search_sources.source_ordinal",
            ],
            name="fk_reader_search_map_source",
        ),
    )


def downgrade() -> None:
    raise NotImplementedError(
        "0229 retains reader revisions and has no destructive downgrade"
    )
