"""Drop the unwritten reader-apparatus and content-index columns and chunk parts.

Revision ID: 0231
Revises: 0230
Create Date: 2026-09-18
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0231"
down_revision: str | Sequence[str] | None = "0230"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_table("content_chunk_parts")

    op.drop_constraint(
        "ck_reader_apparatus_items_body_html_target",
        "reader_apparatus_items",
        type_="check",
    )
    op.drop_column("reader_apparatus_items", "body_html_sanitized")
    op.drop_column("reader_apparatus_states", "extractor_version")

    op.drop_constraint("ck_content_blocks_start", "content_blocks", type_="check")
    op.drop_constraint("ck_content_blocks_offsets", "content_blocks", type_="check")
    op.drop_constraint("ck_content_blocks_selector", "content_blocks", type_="check")
    op.drop_constraint("ck_content_blocks_metadata", "content_blocks", type_="check")
    op.drop_constraint("ck_content_blocks_extraction_confidence", "content_blocks", type_="check")
    op.drop_index("ix_content_blocks_parent_block_id", table_name="content_blocks")
    op.drop_column("content_blocks", "parent_block_id")
    op.drop_column("content_blocks", "selector")
    op.drop_column("content_blocks", "metadata")
    op.drop_column("content_blocks", "extraction_confidence")
    op.drop_column("content_blocks", "source_start_offset")
    op.drop_column("content_blocks", "source_end_offset")

    op.drop_constraint("ck_content_chunks_token_count", "content_chunks", type_="check")
    op.drop_column("content_chunks", "token_count")


def downgrade() -> None:
    raise NotImplementedError("0231 is an irreversible dead-schema hard cutover")
