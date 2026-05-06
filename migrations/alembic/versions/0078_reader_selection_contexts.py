"""Reader selection message contexts.

Revision ID: 0078
Revises: 0077
Create Date: 2026-05-06
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0078"
down_revision: str | None = "0077"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_OBJECT_TYPE_CHECK = (
    "object_type IS NULL OR object_type IN ('page', 'note_block', 'media', "
    "'highlight', 'conversation', 'message', 'podcast', 'content_chunk', 'contributor')"
)

_LEGACY_OBJECT_TYPE_CHECK = (
    "object_type IN ('page', 'note_block', 'media', 'highlight', 'conversation', "
    "'message', 'podcast', 'content_chunk', 'contributor')"
)

_KIND_SHAPE_CHECK = (
    "((context_kind = 'object_ref' AND object_type IS NOT NULL "
    "AND object_id IS NOT NULL AND locator_json IS NULL) OR "
    "(context_kind = 'reader_selection' AND object_type IS NULL "
    "AND object_id IS NULL AND source_media_id IS NOT NULL "
    "AND locator_json IS NOT NULL))"
)


def upgrade() -> None:
    op.add_column(
        "message_context_items",
        sa.Column(
            "context_kind",
            sa.Text(),
            nullable=False,
            server_default="object_ref",
        ),
    )
    op.add_column(
        "message_context_items",
        sa.Column("source_media_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "message_context_items",
        sa.Column("locator_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.execute("UPDATE message_context_items SET context_kind = 'object_ref'")

    op.drop_constraint(
        "ck_message_context_items_object_type", "message_context_items", type_="check"
    )
    op.alter_column("message_context_items", "object_type", nullable=True)
    op.alter_column("message_context_items", "object_id", nullable=True)

    op.create_check_constraint(
        "ck_message_context_items_context_kind",
        "message_context_items",
        "context_kind IN ('object_ref', 'reader_selection')",
    )
    op.create_check_constraint(
        "ck_message_context_items_object_type",
        "message_context_items",
        _OBJECT_TYPE_CHECK,
    )
    op.create_check_constraint(
        "ck_message_context_items_kind_shape",
        "message_context_items",
        _KIND_SHAPE_CHECK,
    )
    op.create_check_constraint(
        "ck_message_context_items_locator_json",
        "message_context_items",
        "locator_json IS NULL OR jsonb_typeof(locator_json) = 'object'",
    )
    op.create_index(
        "ix_message_context_items_source_media",
        "message_context_items",
        ["source_media_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_message_context_items_source_media", table_name="message_context_items")
    op.drop_constraint(
        "ck_message_context_items_locator_json", "message_context_items", type_="check"
    )
    op.drop_constraint(
        "ck_message_context_items_kind_shape", "message_context_items", type_="check"
    )
    op.drop_constraint(
        "ck_message_context_items_object_type", "message_context_items", type_="check"
    )
    op.drop_constraint(
        "ck_message_context_items_context_kind", "message_context_items", type_="check"
    )

    op.execute("DELETE FROM message_context_items WHERE context_kind = 'reader_selection'")
    op.alter_column("message_context_items", "object_id", nullable=False)
    op.alter_column("message_context_items", "object_type", nullable=False)
    op.create_check_constraint(
        "ck_message_context_items_object_type",
        "message_context_items",
        _LEGACY_OBJECT_TYPE_CHECK,
    )

    op.drop_column("message_context_items", "locator_json")
    op.drop_column("message_context_items", "source_media_id")
    op.drop_column("message_context_items", "context_kind")
