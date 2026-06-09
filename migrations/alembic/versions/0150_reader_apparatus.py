"""reader apparatus hard cutover

Revision ID: 0150
Revises: 0149
Create Date: 2026-06-08

Stores source-authored reader apparatus as a media-local derived read model:
states, items, and edges. The model is intentionally separate from generated
chat citations/message_retrievals.

Hard cutover: not reversible.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0150"
down_revision: str | Sequence[str] | None = "0149"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "reader_apparatus_states",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("media_kind", sa.Text(), nullable=False),
        sa.Column("source_fingerprint", sa.Text(), nullable=False),
        sa.Column("extractor_version", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("item_count", sa.Integer(), nullable=False),
        sa.Column("edge_count", sa.Integer(), nullable=False),
        sa.Column(
            "diagnostics",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('ready', 'empty', 'partial', 'unsupported', 'failed')",
            name="ck_reader_apparatus_states_status",
        ),
        sa.CheckConstraint("item_count >= 0", name="ck_reader_apparatus_states_item_count"),
        sa.CheckConstraint("edge_count >= 0", name="ck_reader_apparatus_states_edge_count"),
        sa.CheckConstraint(
            "(status IN ('ready', 'partial') AND item_count > 0) "
            "OR (status IN ('empty', 'unsupported', 'failed') "
            "AND item_count = 0 AND edge_count = 0)",
            name="ck_reader_apparatus_states_status_counts",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(diagnostics) = 'object'",
            name="ck_reader_apparatus_states_diagnostics",
        ),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"]),
        sa.UniqueConstraint("media_id", name="uq_reader_apparatus_states_media"),
        sa.UniqueConstraint("media_id", "id", name="uq_reader_apparatus_states_media_id"),
    )

    op.create_table(
        "reader_apparatus_items",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("state_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("stable_key", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("label", sa.Text(), nullable=True),
        sa.Column("body_text", sa.Text(), nullable=True),
        sa.Column("body_html_sanitized", sa.Text(), nullable=True),
        sa.Column("locator", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("locator_status", sa.Text(), nullable=False),
        sa.Column("confidence", sa.Text(), nullable=False),
        sa.Column("extraction_method", sa.Text(), nullable=False),
        sa.Column("source_ref", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("sort_key", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind IN ('footnote_ref', 'endnote_ref', 'bibliography_ref', "
            "'sidenote_ref', 'margin_note_ref', 'footnote', 'endnote', "
            "'bibliography_entry', 'sidenote', 'margin_note', 'reference_section')",
            name="ck_reader_apparatus_items_kind",
        ),
        sa.CheckConstraint(
            "locator_status IN ('exact', 'container', 'missing')",
            name="ck_reader_apparatus_items_locator_status",
        ),
        sa.CheckConstraint(
            "confidence IN ('exact', 'strong', 'probable')",
            name="ck_reader_apparatus_items_confidence",
        ),
        sa.CheckConstraint(
            "locator IS NULL OR jsonb_typeof(locator) = 'object'",
            name="ck_reader_apparatus_items_locator",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(source_ref) = 'object'",
            name="ck_reader_apparatus_items_source_ref",
        ),
        sa.CheckConstraint(
            "body_html_sanitized IS NULL OR kind IN ('footnote', 'endnote', "
            "'bibliography_entry', 'sidenote', 'margin_note', 'reference_section')",
            name="ck_reader_apparatus_items_body_html_target",
        ),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"]),
        sa.ForeignKeyConstraint(
            ["media_id", "state_id"],
            ["reader_apparatus_states.media_id", "reader_apparatus_states.id"],
        ),
        sa.UniqueConstraint("media_id", "stable_key", name="uq_reader_apparatus_items_key"),
        sa.UniqueConstraint(
            "media_id",
            "state_id",
            "id",
            name="uq_reader_apparatus_items_media_state_id",
        ),
    )

    op.create_table(
        "reader_apparatus_edges",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("state_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("stable_key", sa.Text(), nullable=False),
        sa.Column("from_item_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("to_item_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("relation", sa.Text(), nullable=False),
        sa.Column("confidence", sa.Text(), nullable=False),
        sa.Column("extraction_method", sa.Text(), nullable=False),
        sa.Column("source_ref", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("sort_key", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "relation IN ('points_to_note', 'points_to_endnote', "
            "'points_to_sidenote', 'points_to_margin_note', "
            "'cites_bibliography_entry', 'backlink_to_marker', 'contains_reference')",
            name="ck_reader_apparatus_edges_relation",
        ),
        sa.CheckConstraint(
            "confidence IN ('exact', 'strong', 'probable')",
            name="ck_reader_apparatus_edges_confidence",
        ),
        sa.CheckConstraint(
            "from_item_id <> to_item_id",
            name="ck_reader_apparatus_edges_not_self",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(source_ref) = 'object'",
            name="ck_reader_apparatus_edges_source_ref",
        ),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"]),
        sa.ForeignKeyConstraint(
            ["media_id", "state_id"],
            ["reader_apparatus_states.media_id", "reader_apparatus_states.id"],
        ),
        sa.ForeignKeyConstraint(
            ["media_id", "state_id", "from_item_id"],
            [
                "reader_apparatus_items.media_id",
                "reader_apparatus_items.state_id",
                "reader_apparatus_items.id",
            ],
        ),
        sa.ForeignKeyConstraint(
            ["media_id", "state_id", "to_item_id"],
            [
                "reader_apparatus_items.media_id",
                "reader_apparatus_items.state_id",
                "reader_apparatus_items.id",
            ],
        ),
        sa.UniqueConstraint("media_id", "stable_key", name="uq_reader_apparatus_edges_key"),
    )

    op.execute(
        """
        INSERT INTO reader_apparatus_states (
            media_id,
            media_kind,
            source_fingerprint,
            extractor_version,
            status,
            item_count,
            edge_count,
            diagnostics
        )
        SELECT
            media.id,
            media.kind,
            'sha256:'
                || encode(
                    digest(
                        'reader_apparatus_v1|' || media.id::text || '|' || media.kind || '|legacy',
                        'sha256'
                    ),
                    'hex'
                ),
            'reader_apparatus_v1',
            'unsupported',
            0,
            0,
            '{"reason": "legacy_source_semantics_unavailable"}'::jsonb
        FROM media
        WHERE media.kind IN ('web_article', 'epub', 'pdf')
          AND media.processing_status = 'ready_for_reading'
        """
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0145 is not reversible")
