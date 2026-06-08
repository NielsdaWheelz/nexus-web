"""notes & pages evidence unification: polymorphic content-index owner

Revision ID: 0143
Revises: 0142
Create Date: 2026-06-07

Generalizes the content/evidence pipeline owner from media_id to a polymorphic
(owner_kind, owner_id) so a page is a first-class indexable document alongside
media. Renames media_content_index_states -> content_index_states and extends the
source_kind/resolver_kind domains with 'note'. Behavior-preserving for media: every
existing row backfills to owner_kind='media', owner_id=media_id.

The owner is intentionally FK-less (a single column cannot reference two parent
tables); integrity is held by explicit application cleanup (database.md). Dropping
media_id auto-drops its dependent unique/index/FK, matching the 0138 pattern.

Hard cutover: not reversible.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0143"
down_revision: str | Sequence[str] | None = "0142"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _add_owner(table: str) -> None:
    """Add (owner_kind, owner_id), backfill from media_id, enforce, drop media_id."""
    op.add_column(table, sa.Column("owner_kind", sa.Text(), nullable=True))
    op.add_column(table, sa.Column("owner_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.execute(f"UPDATE {table} SET owner_kind = 'media', owner_id = media_id")
    op.alter_column(table, "owner_kind", nullable=False)
    op.alter_column(table, "owner_id", nullable=False)
    op.create_check_constraint(
        f"ck_{table}_owner_kind", table, "owner_kind IN ('media', 'page')"
    )
    # Auto-drops the media_id unique constraint, index, and FK (0138 pattern).
    op.drop_column(table, "media_id")


def upgrade() -> None:
    _add_owner("content_blocks")
    op.create_unique_constraint(
        "uq_content_blocks_owner_idx",
        "content_blocks",
        ["owner_kind", "owner_id", "block_idx"],
    )
    op.create_index(
        "ix_content_blocks_owner_idx",
        "content_blocks",
        ["owner_kind", "owner_id", "block_idx"],
    )

    _add_owner("evidence_spans")
    op.drop_constraint("ck_evidence_spans_resolver", "evidence_spans", type_="check")
    op.create_check_constraint(
        "ck_evidence_spans_resolver",
        "evidence_spans",
        "resolver_kind IN ('web', 'epub', 'pdf', 'transcript', 'note')",
    )
    op.create_index("ix_evidence_spans_owner", "evidence_spans", ["owner_kind", "owner_id"])

    _add_owner("content_chunks")
    op.drop_constraint("ck_content_chunks_source_kind", "content_chunks", type_="check")
    op.create_check_constraint(
        "ck_content_chunks_source_kind",
        "content_chunks",
        "source_kind IN ('web_article', 'epub', 'pdf', 'transcript', 'note')",
    )
    op.create_unique_constraint(
        "uq_content_chunks_owner_idx",
        "content_chunks",
        ["owner_kind", "owner_id", "chunk_idx"],
    )
    op.create_index(
        "ix_content_chunks_owner_idx",
        "content_chunks",
        ["owner_kind", "owner_id", "chunk_idx"],
    )

    op.rename_table("media_content_index_states", "content_index_states")
    _add_owner("content_index_states")
    op.drop_constraint(
        "ck_media_content_index_states_status", "content_index_states", type_="check"
    )
    op.create_check_constraint(
        "ck_content_index_states_status",
        "content_index_states",
        "status IN ('pending', 'indexing', 'ready', 'no_text', 'ocr_required', 'failed')",
    )
    op.create_unique_constraint(
        "uq_content_index_states_owner", "content_index_states", ["owner_kind", "owner_id"]
    )
    op.create_index(
        "ix_content_index_states_repair_waiting",
        "content_index_states",
        ["updated_at", "owner_kind", "owner_id"],
        postgresql_where=sa.text("status IN ('pending', 'failed')"),
    )
    op.create_index(
        "ix_content_index_states_repair_indexing",
        "content_index_states",
        ["updated_at", "owner_kind", "owner_id"],
        postgresql_where=sa.text("status = 'indexing'"),
    )

    # Drop the never-finished object_search substrate; notes now live in content_chunks.
    op.drop_table("object_search_embeddings")
    op.drop_table("object_search_documents")


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0141 is not reversible")
