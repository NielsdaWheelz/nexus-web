"""Cut EPUB artifacts and transcript chunks to package/read-model tables.

Revision ID: 0064
Revises: 0063
Create Date: 2026-04-29
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0064"
down_revision: str | None = "0063"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.execute(
        """
        UPDATE reader_media_state rms
        SET locator = NULL,
            updated_at = now()
        FROM media m
        WHERE rms.media_id = m.id
          AND m.kind = 'epub'
          AND rms.locator IS NOT NULL
        """
    )
    op.execute(
        """
        DELETE FROM highlights h
        USING media m
        WHERE h.anchor_media_id = m.id
          AND m.kind = 'epub'
          AND h.anchor_kind = 'fragment_offsets'
        """
    )
    op.execute(
        """
        DELETE FROM fragment_blocks fb
        USING fragments f, media m
        WHERE fb.fragment_id = f.id
          AND f.media_id = m.id
          AND m.kind = 'epub'
        """
    )
    op.execute(
        """
        DELETE FROM epub_nav_locations
        WHERE media_id IN (SELECT id FROM media WHERE kind = 'epub')
        """
    )
    op.execute(
        """
        DELETE FROM epub_toc_nodes
        WHERE media_id IN (SELECT id FROM media WHERE kind = 'epub')
        """
    )
    op.execute(
        """
        DELETE FROM fragments
        WHERE media_id IN (SELECT id FROM media WHERE kind = 'epub')
        """
    )

    op.drop_index("uix_epub_toc_nodes_media_order", table_name="epub_toc_nodes")
    op.add_column(
        "epub_toc_nodes",
        sa.Column("nav_type", sa.Text(), server_default="toc", nullable=False),
    )
    op.create_check_constraint(
        "ck_epub_toc_nodes_nav_type",
        "epub_toc_nodes",
        "nav_type IN ('toc', 'landmarks', 'page_list')",
    )
    op.create_index(
        "uix_epub_toc_nodes_media_nav_order",
        "epub_toc_nodes",
        ["media_id", "nav_type", "order_key"],
        unique=True,
    )

    op.create_table(
        "epub_fragment_sources",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("fragment_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("package_href", sa.Text(), nullable=False),
        sa.Column("manifest_item_id", sa.Text(), nullable=False),
        sa.Column("spine_itemref_id", sa.Text(), nullable=True),
        sa.Column("media_type", sa.Text(), nullable=False),
        sa.Column("linear", sa.Boolean(), nullable=False),
        sa.Column("reading_order", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "char_length(package_href) BETWEEN 1 AND 2048",
            name="ck_epub_fragment_sources_href_length",
        ),
        sa.CheckConstraint(
            "char_length(manifest_item_id) BETWEEN 1 AND 255",
            name="ck_epub_fragment_sources_manifest_id_length",
        ),
        sa.CheckConstraint(
            "spine_itemref_id IS NULL OR char_length(spine_itemref_id) BETWEEN 1 AND 255",
            name="ck_epub_fragment_sources_itemref_id_length",
        ),
        sa.CheckConstraint(
            "reading_order >= 0",
            name="ck_epub_fragment_sources_reading_order",
        ),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"]),
        sa.ForeignKeyConstraint(["fragment_id"], ["fragments.id"]),
        sa.UniqueConstraint("media_id", "fragment_id", name="uq_epub_fragment_sources_fragment"),
        sa.UniqueConstraint("media_id", "package_href", name="uq_epub_fragment_sources_href"),
    )
    op.create_index(
        "ix_epub_fragment_sources_media_order",
        "epub_fragment_sources",
        ["media_id", "reading_order"],
    )

    op.create_table(
        "epub_resources",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("manifest_item_id", sa.Text(), nullable=True),
        sa.Column("package_href", sa.Text(), nullable=False),
        sa.Column("asset_key", sa.Text(), nullable=False),
        sa.Column("storage_path", sa.Text(), nullable=False),
        sa.Column("content_type", sa.Text(), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.Text(), nullable=False),
        sa.Column("fallback_item_id", sa.Text(), nullable=True),
        sa.Column("properties", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "char_length(package_href) BETWEEN 1 AND 2048",
            name="ck_epub_resources_href_length",
        ),
        sa.CheckConstraint(
            "char_length(asset_key) BETWEEN 1 AND 2048",
            name="ck_epub_resources_asset_key_length",
        ),
        sa.CheckConstraint("size_bytes >= 0", name="ck_epub_resources_size_non_negative"),
        sa.CheckConstraint("char_length(sha256) = 64", name="ck_epub_resources_sha256_length"),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"]),
        sa.UniqueConstraint("media_id", "package_href", name="uq_epub_resources_href"),
        sa.UniqueConstraint("media_id", "asset_key", name="uq_epub_resources_asset_key"),
    )
    op.create_index("ix_epub_resources_media", "epub_resources", ["media_id"])

    op.create_table(
        "content_chunks",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("fragment_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("transcript_version_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("chunk_idx", sa.Integer(), nullable=False),
        sa.Column("source_kind", sa.Text(), nullable=False),
        sa.Column("chunk_text", sa.Text(), nullable=False),
        sa.Column("start_offset", sa.Integer(), nullable=True),
        sa.Column("end_offset", sa.Integer(), nullable=True),
        sa.Column("t_start_ms", sa.BigInteger(), nullable=True),
        sa.Column("t_end_ms", sa.BigInteger(), nullable=True),
        sa.Column("heading", sa.Text(), nullable=True),
        sa.Column("locator", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("embedding", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("embedding_model", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "chunk_idx >= 0",
            name="ck_content_chunks_chunk_idx_non_negative",
        ),
        sa.CheckConstraint(
            "source_kind IN ('fragment', 'transcript')",
            name="ck_content_chunks_source_kind",
        ),
        sa.CheckConstraint(
            """
            (
                source_kind = 'fragment'
                AND fragment_id IS NOT NULL
                AND transcript_version_id IS NULL
                AND start_offset IS NOT NULL
                AND end_offset IS NOT NULL
                AND start_offset >= 0
                AND end_offset > start_offset
                AND t_start_ms IS NULL
                AND t_end_ms IS NULL
            )
            OR (
                source_kind = 'transcript'
                AND fragment_id IS NULL
                AND transcript_version_id IS NOT NULL
                AND start_offset IS NULL
                AND end_offset IS NULL
                AND t_start_ms IS NOT NULL
                AND t_end_ms IS NOT NULL
                AND t_start_ms >= 0
                AND t_end_ms > t_start_ms
            )
            """,
            name="ck_content_chunks_locator_shape",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(embedding) = 'array'",
            name="ck_content_chunks_embedding_array",
        ),
        sa.CheckConstraint(
            "locator IS NULL OR jsonb_typeof(locator) = 'object'",
            name="ck_content_chunks_locator_object",
        ),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"]),
        sa.ForeignKeyConstraint(["fragment_id"], ["fragments.id"]),
        sa.ForeignKeyConstraint(["transcript_version_id"], ["podcast_transcript_versions.id"]),
    )
    op.execute("ALTER TABLE content_chunks ADD COLUMN embedding_vector vector(256)")
    op.create_index(
        "uq_content_chunks_fragment_media_idx",
        "content_chunks",
        ["media_id", "chunk_idx"],
        unique=True,
        postgresql_where=sa.text("source_kind = 'fragment'"),
    )
    op.create_index(
        "uq_content_chunks_transcript_version_idx",
        "content_chunks",
        ["transcript_version_id", "chunk_idx"],
        unique=True,
        postgresql_where=sa.text("source_kind = 'transcript'"),
    )
    op.create_index(
        "ix_content_chunks_media_source",
        "content_chunks",
        ["media_id", "source_kind", "chunk_idx"],
    )
    op.create_index(
        "ix_content_chunks_transcript_version",
        "content_chunks",
        ["transcript_version_id"],
    )
    op.create_index("ix_content_chunks_fragment", "content_chunks", ["fragment_id"])
    op.create_index("ix_content_chunks_embedding_model", "content_chunks", ["embedding_model"])
    op.execute(
        """
        CREATE INDEX ix_content_chunks_embedding_vector_ann
        ON content_chunks
        USING ivfflat (embedding_vector vector_cosine_ops)
        WITH (lists = 100)
        """
    )

    op.execute(
        """
        INSERT INTO content_chunks (
            id,
            media_id,
            fragment_id,
            transcript_version_id,
            chunk_idx,
            source_kind,
            chunk_text,
            start_offset,
            end_offset,
            t_start_ms,
            t_end_ms,
            heading,
            locator,
            embedding,
            embedding_vector,
            embedding_model,
            created_at
        )
        SELECT
            id,
            media_id,
            NULL,
            transcript_version_id,
            chunk_idx,
            'transcript',
            chunk_text,
            NULL,
            NULL,
            t_start_ms,
            t_end_ms,
            NULL,
            '{}'::jsonb,
            embedding,
            embedding_vector,
            embedding_model,
            created_at
        FROM podcast_transcript_chunks
        """
    )
    op.drop_table("podcast_transcript_chunks")


def downgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.create_table(
        "podcast_transcript_chunks",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("transcript_version_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("chunk_idx", sa.Integer(), nullable=False),
        sa.Column("chunk_text", sa.Text(), nullable=False),
        sa.Column("t_start_ms", sa.BigInteger(), nullable=False),
        sa.Column("t_end_ms", sa.BigInteger(), nullable=False),
        sa.Column("embedding", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("embedding_model", sa.Text(), server_default="hash_v1", nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "chunk_idx >= 0",
            name="ck_podcast_transcript_chunks_chunk_idx_non_negative",
        ),
        sa.CheckConstraint(
            "t_start_ms >= 0 AND t_end_ms > t_start_ms",
            name="ck_podcast_transcript_chunks_time_offsets_valid",
        ),
        sa.ForeignKeyConstraint(
            ["transcript_version_id"],
            ["podcast_transcript_versions.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"], ondelete="CASCADE"),
        sa.UniqueConstraint(
            "transcript_version_id",
            "chunk_idx",
            name="uq_podcast_transcript_chunks_version_idx",
        ),
    )
    op.create_index(
        "ix_podcast_transcript_chunks_media_start",
        "podcast_transcript_chunks",
        ["media_id", "t_start_ms", "chunk_idx"],
    )
    op.execute("ALTER TABLE podcast_transcript_chunks ADD COLUMN embedding_vector vector(256)")
    op.create_index(
        "ix_podcast_transcript_chunks_embedding_model",
        "podcast_transcript_chunks",
        ["embedding_model"],
    )
    op.execute(
        """
        CREATE INDEX ix_podcast_transcript_chunks_embedding_vector_ann
        ON podcast_transcript_chunks
        USING ivfflat (embedding_vector vector_cosine_ops)
        WITH (lists = 100)
        """
    )
    op.execute(
        """
        INSERT INTO podcast_transcript_chunks (
            id,
            transcript_version_id,
            media_id,
            chunk_idx,
            chunk_text,
            t_start_ms,
            t_end_ms,
            embedding,
            embedding_vector,
            embedding_model,
            created_at
        )
        SELECT
            id,
            transcript_version_id,
            media_id,
            chunk_idx,
            chunk_text,
            t_start_ms,
            t_end_ms,
            embedding,
            embedding_vector,
            embedding_model,
            created_at
        FROM content_chunks
        WHERE source_kind = 'transcript'
          AND transcript_version_id IS NOT NULL
          AND t_start_ms IS NOT NULL
          AND t_end_ms IS NOT NULL
        """
    )

    op.drop_index("ix_content_chunks_embedding_vector_ann", table_name="content_chunks")
    op.drop_index("ix_content_chunks_embedding_model", table_name="content_chunks")
    op.drop_index("ix_content_chunks_fragment", table_name="content_chunks")
    op.drop_index("ix_content_chunks_transcript_version", table_name="content_chunks")
    op.drop_index("ix_content_chunks_media_source", table_name="content_chunks")
    op.execute("DROP INDEX IF EXISTS uq_content_chunks_transcript_version_idx")
    op.execute("DROP INDEX IF EXISTS uq_content_chunks_fragment_media_idx")
    op.drop_table("content_chunks")

    op.drop_index("ix_epub_resources_media", table_name="epub_resources")
    op.drop_table("epub_resources")
    op.drop_index("ix_epub_fragment_sources_media_order", table_name="epub_fragment_sources")
    op.drop_table("epub_fragment_sources")
    op.drop_index("uix_epub_toc_nodes_media_nav_order", table_name="epub_toc_nodes")
    op.drop_constraint("ck_epub_toc_nodes_nav_type", "epub_toc_nodes", type_="check")
    op.drop_column("epub_toc_nodes", "nav_type")
    op.create_index(
        "uix_epub_toc_nodes_media_order",
        "epub_toc_nodes",
        ["media_id", "order_key"],
        unique=True,
    )
