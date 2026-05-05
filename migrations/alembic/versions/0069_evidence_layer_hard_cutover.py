"""Evidence layer hard cutover.

Revision ID: 0069
Revises: 0068
Create Date: 2026-05-03
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0069"
down_revision: str | None = "0068"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_content_chunks_embedding_vector_ann")
    op.execute("DROP INDEX IF EXISTS ix_content_chunks_embedding_model")
    op.execute("DROP INDEX IF EXISTS ix_content_chunks_fragment")
    op.execute("DROP INDEX IF EXISTS ix_content_chunks_transcript_version")
    op.execute("DROP INDEX IF EXISTS ix_content_chunks_media_source")
    op.execute("DROP INDEX IF EXISTS uq_content_chunks_transcript_version_idx")
    op.execute("DROP INDEX IF EXISTS uq_content_chunks_fragment_media_idx")
    op.drop_table("content_chunks")

    op.create_table(
        "content_index_runs",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("source_version", sa.Text(), nullable=False),
        sa.Column("extractor_version", sa.Text(), nullable=False),
        sa.Column("chunker_version", sa.Text(), nullable=False),
        sa.Column("embedding_provider", sa.Text(), nullable=False),
        sa.Column("embedding_model", sa.Text(), nullable=False),
        sa.Column("embedding_version", sa.Text(), nullable=False),
        sa.Column("embedding_config_hash", sa.Text(), nullable=False),
        sa.Column("started_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("finished_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("failure_code", sa.Text(), nullable=True),
        sa.Column("failure_message", sa.Text(), nullable=True),
        sa.Column("activated_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("deactivated_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("superseded_by_run_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "state IN ('pending', 'extracting', 'indexing', 'embedding', 'ready', "
            "'no_text', 'ocr_required', 'failed')",
            name="ck_content_index_runs_state",
        ),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"]),
        sa.ForeignKeyConstraint(["superseded_by_run_id"], ["content_index_runs.id"]),
    )
    op.create_index("ix_content_index_runs_media", "content_index_runs", ["media_id"])

    op.create_table(
        "source_snapshots",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("index_run_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_kind", sa.Text(), nullable=False),
        sa.Column("artifact_kind", sa.Text(), nullable=False),
        sa.Column("artifact_ref", sa.Text(), nullable=False),
        sa.Column("content_type", sa.Text(), nullable=False),
        sa.Column("byte_length", sa.BigInteger(), nullable=False),
        sa.Column("source_fingerprint", sa.Text(), nullable=False),
        sa.Column("source_version", sa.Text(), nullable=False),
        sa.Column("extractor_version", sa.Text(), nullable=False),
        sa.Column("content_sha256", sa.Text(), nullable=False),
        sa.Column("parent_snapshot_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("language", sa.Text(), nullable=True),
        sa.Column("metadata", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("byte_length >= 0", name="ck_source_snapshots_byte_length"),
        sa.CheckConstraint(
            "char_length(btrim(source_fingerprint)) > 0",
            name="ck_source_snapshots_fingerprint",
        ),
        sa.CheckConstraint(
            "char_length(content_sha256) = 64", name="ck_source_snapshots_sha"
        ),
        sa.CheckConstraint(
            "jsonb_typeof(metadata) = 'object'", name="ck_source_snapshots_metadata"
        ),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"]),
        sa.ForeignKeyConstraint(["index_run_id"], ["content_index_runs.id"]),
        sa.ForeignKeyConstraint(["parent_snapshot_id"], ["source_snapshots.id"]),
    )
    op.create_index(
        "ix_source_snapshots_media_run",
        "source_snapshots",
        ["media_id", "index_run_id"],
    )

    op.create_table(
        "content_blocks",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("index_run_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_snapshot_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("block_idx", sa.Integer(), nullable=False),
        sa.Column("block_kind", sa.Text(), nullable=False),
        sa.Column("canonical_text", sa.Text(), nullable=False),
        sa.Column("text_sha256", sa.Text(), nullable=False),
        sa.Column("extraction_confidence", sa.Float(), nullable=True),
        sa.Column("source_start_offset", sa.Integer(), nullable=False),
        sa.Column("source_end_offset", sa.Integer(), nullable=False),
        sa.Column("parent_block_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "heading_path", postgresql.JSONB(astext_type=sa.Text()), nullable=False
        ),
        sa.Column("locator", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("selector", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("metadata", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("block_idx >= 0", name="ck_content_blocks_block_idx"),
        sa.CheckConstraint("source_start_offset >= 0", name="ck_content_blocks_start"),
        sa.CheckConstraint(
            "source_end_offset >= source_start_offset",
            name="ck_content_blocks_offsets",
        ),
        sa.CheckConstraint(
            "char_length(text_sha256) = 64", name="ck_content_blocks_sha"
        ),
        sa.CheckConstraint(
            "jsonb_typeof(heading_path) = 'array'", name="ck_content_blocks_heading"
        ),
        sa.CheckConstraint(
            "jsonb_typeof(locator) = 'object'", name="ck_content_blocks_locator"
        ),
        sa.CheckConstraint(
            "jsonb_typeof(selector) = 'object'", name="ck_content_blocks_selector"
        ),
        sa.CheckConstraint(
            "jsonb_typeof(metadata) = 'object'", name="ck_content_blocks_metadata"
        ),
        sa.CheckConstraint(
            "extraction_confidence IS NULL OR "
            "(extraction_confidence >= 0 AND extraction_confidence <= 1)",
            name="ck_content_blocks_extraction_confidence",
        ),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"]),
        sa.ForeignKeyConstraint(["index_run_id"], ["content_index_runs.id"]),
        sa.ForeignKeyConstraint(["source_snapshot_id"], ["source_snapshots.id"]),
        sa.ForeignKeyConstraint(["parent_block_id"], ["content_blocks.id"]),
        sa.UniqueConstraint(
            "index_run_id", "block_idx", name="uq_content_blocks_run_idx"
        ),
    )
    op.create_index(
        "ix_content_blocks_media_run", "content_blocks", ["media_id", "index_run_id"]
    )

    op.create_table(
        "evidence_spans",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("index_run_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_snapshot_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("start_block_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("end_block_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("start_block_offset", sa.Integer(), nullable=False),
        sa.Column("end_block_offset", sa.Integer(), nullable=False),
        sa.Column("span_text", sa.Text(), nullable=False),
        sa.Column("span_sha256", sa.Text(), nullable=False),
        sa.Column("selector", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("citation_label", sa.Text(), nullable=False),
        sa.Column("resolver_kind", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("start_block_offset >= 0", name="ck_evidence_spans_start"),
        sa.CheckConstraint(
            "end_block_offset >= start_block_offset",
            name="ck_evidence_spans_offsets",
        ),
        sa.CheckConstraint(
            "char_length(span_sha256) = 64", name="ck_evidence_spans_sha"
        ),
        sa.CheckConstraint(
            "jsonb_typeof(selector) = 'object'", name="ck_evidence_spans_selector"
        ),
        sa.CheckConstraint(
            "resolver_kind IN ('web', 'epub', 'pdf', 'transcript')",
            name="ck_evidence_spans_resolver",
        ),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"]),
        sa.ForeignKeyConstraint(["index_run_id"], ["content_index_runs.id"]),
        sa.ForeignKeyConstraint(["source_snapshot_id"], ["source_snapshots.id"]),
        sa.ForeignKeyConstraint(["start_block_id"], ["content_blocks.id"]),
        sa.ForeignKeyConstraint(["end_block_id"], ["content_blocks.id"]),
    )
    op.create_index(
        "ix_evidence_spans_media_run", "evidence_spans", ["media_id", "index_run_id"]
    )

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
        sa.Column("index_run_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_snapshot_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "primary_evidence_span_id", postgresql.UUID(as_uuid=True), nullable=True
        ),
        sa.Column("chunk_idx", sa.Integer(), nullable=False),
        sa.Column("source_kind", sa.Text(), nullable=False),
        sa.Column("chunk_text", sa.Text(), nullable=False),
        sa.Column("chunk_sha256", sa.Text(), nullable=False),
        sa.Column("chunker_version", sa.Text(), nullable=False),
        sa.Column("token_count", sa.Integer(), nullable=False),
        sa.Column(
            "heading_path", postgresql.JSONB(astext_type=sa.Text()), nullable=False
        ),
        sa.Column(
            "summary_locator", postgresql.JSONB(astext_type=sa.Text()), nullable=False
        ),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "chunk_idx >= 0", name="ck_content_chunks_chunk_idx_non_negative"
        ),
        sa.CheckConstraint(
            "source_kind IN ('web_article', 'epub', 'pdf', 'transcript')",
            name="ck_content_chunks_source_kind",
        ),
        sa.CheckConstraint(
            "char_length(chunk_sha256) = 64", name="ck_content_chunks_sha"
        ),
        sa.CheckConstraint("token_count >= 0", name="ck_content_chunks_token_count"),
        sa.CheckConstraint(
            "jsonb_typeof(heading_path) = 'array'", name="ck_content_chunks_heading"
        ),
        sa.CheckConstraint(
            "jsonb_typeof(summary_locator) = 'object'", name="ck_content_chunks_locator"
        ),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"]),
        sa.ForeignKeyConstraint(["index_run_id"], ["content_index_runs.id"]),
        sa.ForeignKeyConstraint(["source_snapshot_id"], ["source_snapshots.id"]),
        sa.ForeignKeyConstraint(["primary_evidence_span_id"], ["evidence_spans.id"]),
        sa.UniqueConstraint(
            "index_run_id", "chunk_idx", name="uq_content_chunks_run_idx"
        ),
    )
    op.execute(
        """
        ALTER TABLE content_chunks
        ADD COLUMN chunk_text_tsv tsvector
        GENERATED ALWAYS AS (to_tsvector('english', chunk_text)) STORED
        """
    )
    op.create_index(
        "ix_content_chunks_media_run", "content_chunks", ["media_id", "index_run_id"]
    )
    op.create_index(
        "ix_content_chunks_run_idx", "content_chunks", ["index_run_id", "chunk_idx"]
    )
    op.create_index(
        "ix_content_chunks_text_tsv",
        "content_chunks",
        ["chunk_text_tsv"],
        postgresql_using="gin",
    )

    op.create_table(
        "content_chunk_parts",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("chunk_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("part_idx", sa.Integer(), nullable=False),
        sa.Column("block_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("block_start_offset", sa.Integer(), nullable=False),
        sa.Column("block_end_offset", sa.Integer(), nullable=False),
        sa.Column("chunk_start_offset", sa.Integer(), nullable=False),
        sa.Column("chunk_end_offset", sa.Integer(), nullable=False),
        sa.Column("separator_before", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("part_idx >= 0", name="ck_content_chunk_parts_part_idx"),
        sa.CheckConstraint(
            "block_start_offset >= 0", name="ck_content_chunk_parts_block_start"
        ),
        sa.CheckConstraint(
            "block_end_offset >= block_start_offset",
            name="ck_content_chunk_parts_block_offsets",
        ),
        sa.CheckConstraint(
            "chunk_start_offset >= 0", name="ck_content_chunk_parts_chunk_start"
        ),
        sa.CheckConstraint(
            "chunk_end_offset >= chunk_start_offset",
            name="ck_content_chunk_parts_chunk_offsets",
        ),
        sa.ForeignKeyConstraint(["chunk_id"], ["content_chunks.id"]),
        sa.ForeignKeyConstraint(["block_id"], ["content_blocks.id"]),
        sa.UniqueConstraint(
            "chunk_id", "part_idx", name="uq_content_chunk_parts_chunk_part"
        ),
    )
    op.create_index("ix_content_chunk_parts_chunk", "content_chunk_parts", ["chunk_id"])

    op.create_table(
        "content_embeddings",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("chunk_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("embedding_provider", sa.Text(), nullable=False),
        sa.Column("embedding_model", sa.Text(), nullable=False),
        sa.Column("embedding_version", sa.Text(), nullable=False),
        sa.Column("embedding_config_hash", sa.Text(), nullable=False),
        sa.Column("embedding_dimensions", sa.Integer(), nullable=False),
        sa.Column("embedding_sha256", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "embedding_dimensions > 0", name="ck_content_embeddings_dimensions"
        ),
        sa.CheckConstraint(
            "char_length(embedding_sha256) = 64", name="ck_content_embeddings_sha"
        ),
        sa.ForeignKeyConstraint(["chunk_id"], ["content_chunks.id"]),
    )
    op.execute("ALTER TABLE content_embeddings ADD COLUMN embedding_vector vector(256)")
    op.create_index(
        "ix_content_embeddings_model",
        "content_embeddings",
        [
            "embedding_provider",
            "embedding_model",
            "embedding_version",
            "embedding_config_hash",
        ],
    )
    op.execute(
        """
        CREATE INDEX ix_content_embeddings_vector_ann
        ON content_embeddings
        USING ivfflat (embedding_vector vector_cosine_ops)
        WITH (lists = 100)
        """
    )

    op.create_table(
        "media_content_index_states",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("active_run_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("latest_run_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("status_reason", sa.Text(), nullable=True),
        sa.Column("active_embedding_provider", sa.Text(), nullable=True),
        sa.Column("active_embedding_model", sa.Text(), nullable=True),
        sa.Column("active_embedding_version", sa.Text(), nullable=True),
        sa.Column("active_embedding_config_hash", sa.Text(), nullable=True),
        sa.Column(
            "updated_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'indexing', 'ready', 'no_text', 'ocr_required', 'failed')",
            name="ck_media_content_index_states_status",
        ),
        sa.ForeignKeyConstraint(["media_id"], ["media.id"]),
        sa.ForeignKeyConstraint(["active_run_id"], ["content_index_runs.id"]),
        sa.ForeignKeyConstraint(["latest_run_id"], ["content_index_runs.id"]),
        sa.UniqueConstraint("media_id", name="uq_media_content_index_states_media"),
    )
    op.execute(
        """
        INSERT INTO media_content_index_states (
            media_id,
            active_run_id,
            latest_run_id,
            status,
            status_reason,
            active_embedding_provider,
            active_embedding_model,
            active_embedding_version,
            active_embedding_config_hash,
            updated_at,
            created_at
        )
        SELECT
            m.id,
            NULL,
            NULL,
            'pending',
            'evidence_cutover_backfill',
            NULL,
            NULL,
            NULL,
            NULL,
            now(),
            now()
        FROM media m
        WHERE m.kind IN ('web_article', 'epub', 'pdf', 'podcast_episode')
          AND m.processing_status IN ('ready_for_reading', 'embedding', 'ready')
          AND (
              (
                  m.kind IN ('web_article', 'epub')
                  AND EXISTS (
                      SELECT 1
                      FROM fragments f
                      WHERE f.media_id = m.id
                        AND btrim(coalesce(f.canonical_text, '')) <> ''
                  )
              )
              OR (
                  m.kind = 'pdf'
                  AND (
                      btrim(coalesce(m.plain_text, '')) <> ''
                      OR EXISTS (
                          SELECT 1
                          FROM pdf_page_text_spans ppts
                          WHERE ppts.media_id = m.id
                      )
                      OR EXISTS (
                          SELECT 1
                          FROM media_file mf
                          WHERE mf.media_id = m.id
                      )
                  )
              )
              OR (
                  m.kind = 'podcast_episode'
                  AND EXISTS (
                      SELECT 1
                      FROM media_transcript_states mts
                      JOIN podcast_transcript_versions ptv
                        ON ptv.id = mts.active_transcript_version_id
                       AND ptv.media_id = mts.media_id
                      WHERE mts.media_id = m.id
                        AND mts.active_transcript_version_id IS NOT NULL
                        AND mts.transcript_state IN ('ready', 'partial')
                        AND mts.transcript_coverage IN ('partial', 'full')
                        AND EXISTS (
                            SELECT 1
                            FROM podcast_transcript_segments pts
                            WHERE pts.transcript_version_id = mts.active_transcript_version_id
                              AND btrim(coalesce(pts.canonical_text, '')) <> ''
                        )
                  )
              )
          )
        """
    )

    op.drop_constraint(
        "ck_message_retrievals_result_type", "message_retrievals", type_="check"
    )
    op.execute(
        """
        DELETE FROM message_retrievals
        WHERE result_type IN ('fragment', 'transcript_chunk', 'annotation')
        """
    )
    op.create_check_constraint(
        "ck_message_retrievals_result_type",
        "message_retrievals",
        """
        result_type IN (
            'page',
            'note_block',
            'media',
            'podcast',
            'content_chunk',
            'message',
            'contributor',
            'web_result'
        )
        """,
    )
    op.add_column(
        "message_retrievals",
        sa.Column("evidence_span_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_message_retrievals_evidence_span",
        "message_retrievals",
        "evidence_spans",
        ["evidence_span_id"],
        ["id"],
    )
    op.create_index(
        "idx_message_retrievals_evidence_span",
        "message_retrievals",
        ["evidence_span_id"],
    )
    op.add_column(
        "assistant_message_claim_evidence",
        sa.Column("evidence_span_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_assistant_claim_evidence_evidence_span",
        "assistant_message_claim_evidence",
        "evidence_spans",
        ["evidence_span_id"],
        ["id"],
    )
    op.create_index(
        "idx_assistant_claim_evidence_evidence_span",
        "assistant_message_claim_evidence",
        ["evidence_span_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "idx_assistant_claim_evidence_evidence_span",
        table_name="assistant_message_claim_evidence",
    )
    op.drop_constraint(
        "fk_assistant_claim_evidence_evidence_span",
        "assistant_message_claim_evidence",
        type_="foreignkey",
    )
    op.drop_column("assistant_message_claim_evidence", "evidence_span_id")
    op.drop_index(
        "idx_message_retrievals_evidence_span", table_name="message_retrievals"
    )
    op.drop_constraint(
        "fk_message_retrievals_evidence_span",
        "message_retrievals",
        type_="foreignkey",
    )
    op.drop_column("message_retrievals", "evidence_span_id")
    op.drop_constraint(
        "ck_message_retrievals_result_type", "message_retrievals", type_="check"
    )
    op.create_check_constraint(
        "ck_message_retrievals_result_type",
        "message_retrievals",
        """
        result_type IN (
            'page',
            'note_block',
            'media',
            'podcast',
            'fragment',
            'annotation',
            'message',
            'transcript_chunk',
            'web_result'
        )
        """,
    )

    op.drop_table("media_content_index_states")
    op.drop_index("ix_content_embeddings_vector_ann", table_name="content_embeddings")
    op.drop_index("ix_content_embeddings_model", table_name="content_embeddings")
    op.drop_table("content_embeddings")
    op.drop_index("ix_content_chunk_parts_chunk", table_name="content_chunk_parts")
    op.drop_table("content_chunk_parts")
    op.drop_index("ix_content_chunks_text_tsv", table_name="content_chunks")
    op.drop_index("ix_content_chunks_run_idx", table_name="content_chunks")
    op.drop_index("ix_content_chunks_media_run", table_name="content_chunks")
    op.drop_table("content_chunks")
    op.drop_index("ix_evidence_spans_media_run", table_name="evidence_spans")
    op.drop_table("evidence_spans")
    op.drop_index("ix_content_blocks_media_run", table_name="content_blocks")
    op.drop_table("content_blocks")
    op.drop_index("ix_source_snapshots_media_run", table_name="source_snapshots")
    op.drop_table("source_snapshots")
    op.drop_index("ix_content_index_runs_media", table_name="content_index_runs")
    op.drop_table("content_index_runs")

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
        sa.Column(
            "transcript_version_id", postgresql.UUID(as_uuid=True), nullable=True
        ),
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
        sa.ForeignKeyConstraint(["media_id"], ["media.id"]),
        sa.ForeignKeyConstraint(["fragment_id"], ["fragments.id"]),
        sa.ForeignKeyConstraint(
            ["transcript_version_id"], ["podcast_transcript_versions.id"]
        ),
    )
    op.execute("ALTER TABLE content_chunks ADD COLUMN embedding_vector vector(256)")
