"""current-only artifact identity cutover

Revision ID: 0138
Revises: 0137
Create Date: 2026-06-05

Nexus no longer preserves app-level artifact identity for current-only note,
search, transcript, PDF, library-intelligence, and Oracle projections.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0138"
down_revision: str | Sequence[str] | None = "0137"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE OR REPLACE FUNCTION _nexus_strip_artifact_identity(value jsonb)
        RETURNS jsonb
        LANGUAGE sql
        IMMUTABLE
        AS $$
            SELECT CASE
                WHEN value IS NULL THEN NULL
                WHEN jsonb_typeof(value) = 'object' THEN
                    COALESCE(
                        (
                            SELECT jsonb_object_agg(key, _nexus_strip_artifact_identity(child))
                            FROM jsonb_each(value) AS item(key, child)
                            WHERE key NOT IN (
                                'base_page_revision',
                                'base_revision',
                                'block_hashes',
                                'contentHash',
                                'contentSha256',
                                'content_hash',
                                'content_sha256',
                                'fileSha256',
                                'file_sha256',
                                'fingerprint',
                                'geometry_fingerprint',
                                'geometry_version',
                                'hash',
                                'manifestSha256',
                                'manifest_sha256',
                                'provider_request_hash',
                                'revision',
                                'sha256',
                                'sourceFingerprint',
                                'sourceVersion',
                                'source_fingerprint',
                                'source_sha256',
                                'source_version',
                                'stable_hash',
                                'stable_prefix_hash',
                                'transcriptVersionId',
                                'transcript_version_id',
                                'version'
                            )
                        ),
                        '{}'::jsonb
                    )
                WHEN jsonb_typeof(value) = 'array' THEN
                    COALESCE(
                        (
                            SELECT jsonb_agg(_nexus_strip_artifact_identity(child) ORDER BY ord)
                            FROM jsonb_array_elements(value) WITH ORDINALITY AS item(child, ord)
                        ),
                        '[]'::jsonb
                    )
                ELSE value
            END
        $$;
        """
    )

    op.execute(
        """
        UPDATE messages
        SET message_document = _nexus_strip_artifact_identity(message_document)
        """
    )
    op.alter_column(
        "messages",
        "message_document",
        server_default=sa.text("""'{"type":"message_document","blocks":[]}'::jsonb"""),
    )
    op.execute(
        """
        UPDATE message_retrievals
        SET context_ref = _nexus_strip_artifact_identity(context_ref),
            result_ref = _nexus_strip_artifact_identity(result_ref),
            locator = CASE
                WHEN locator IS NULL THEN NULL
                ELSE _nexus_strip_artifact_identity(locator)
            END
        """
    )
    op.execute(
        """
        UPDATE message_retrieval_candidate_ledgers
        SET result_ref = _nexus_strip_artifact_identity(result_ref),
            locator = CASE
                WHEN locator IS NULL THEN NULL
                ELSE _nexus_strip_artifact_identity(locator)
            END
        """
    )
    op.execute(
        """
        UPDATE message_tool_calls
        SET result_refs = _nexus_strip_artifact_identity(result_refs),
            selected_context_refs = _nexus_strip_artifact_identity(selected_context_refs)
        """
    )
    op.execute(
        """
        UPDATE media_source_attempts
        SET source_payload = _nexus_strip_artifact_identity(source_payload)
        """
    )

    op.drop_constraint("ck_pages_revision_positive", "pages", type_="check")
    op.drop_column("pages", "revision")

    op.drop_constraint("ck_note_blocks_revision_positive", "note_blocks", type_="check")
    op.drop_column("note_blocks", "revision")

    op.drop_index("idx_media_stale_pending_upload_cleanup", table_name="media")
    op.drop_index("uix_media_file_sha256", table_name="media")
    op.drop_column("media", "file_sha256")

    op.drop_constraint("ck_epub_resources_sha256_length", "epub_resources", type_="check")
    op.drop_column("epub_resources", "sha256")

    op.drop_constraint(
        "uix_ose_document_model_version",
        "object_search_embeddings",
        type_="unique",
    )
    op.execute("DELETE FROM object_search_embeddings")
    op.drop_constraint("ck_ose_index_version", "object_search_embeddings", type_="check")
    op.drop_constraint("ck_ose_content_hash_length", "object_search_embeddings", type_="check")
    op.drop_column("object_search_embeddings", "index_version")
    op.drop_column("object_search_embeddings", "content_hash")
    op.create_unique_constraint(
        "uix_ose_document_model",
        "object_search_embeddings",
        ["search_document_id", "embedding_model"],
    )

    op.drop_constraint("uix_osd_object_ref_version", "object_search_documents", type_="unique")
    op.execute("DELETE FROM object_search_documents")
    op.drop_constraint("ck_osd_index_version", "object_search_documents", type_="check")
    op.drop_constraint("ck_osd_content_hash_length", "object_search_documents", type_="check")
    op.drop_column("object_search_documents", "index_version")
    op.drop_column("object_search_documents", "content_hash")
    op.create_unique_constraint(
        "uix_osd_object_ref",
        "object_search_documents",
        ["user_id", "object_type", "object_id"],
    )

    op.drop_column("message_retrieval_candidate_ledgers", "source_version")
    op.drop_column("message_retrievals", "source_version")

    op.execute(
        """
        UPDATE chat_prompt_assemblies
        SET prompt_block_manifest = _nexus_strip_artifact_identity(prompt_block_manifest)
        """
    )
    op.drop_column("message_llm", "stable_prefix_hash")
    op.drop_constraint(
        "ck_chat_prompt_assemblies_stable_prefix_hash_length",
        "chat_prompt_assemblies",
        type_="check",
    )
    op.drop_constraint(
        "ck_chat_prompt_assemblies_provider_request_hash_length",
        "chat_prompt_assemblies",
        type_="check",
    )
    op.drop_column("chat_prompt_assemblies", "stable_prefix_hash")
    op.drop_column("chat_prompt_assemblies", "provider_request_hash")

    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                WITH normalized AS (
                    SELECT
                        pe.media_id,
                        pe.podcast_id,
                        'audio_url=' ||
                        regexp_replace(
                            lower(trim(coalesce(m.external_playback_url, ''))),
                            '\\s+',
                            ' ',
                            'g'
                        ) ||
                        E'\n' ||
                        'title=' ||
                        regexp_replace(lower(trim(coalesce(m.title, ''))), '\\s+', ' ', 'g') ||
                        E'\n' ||
                        'published_at=' ||
                        regexp_replace(
                            lower(trim(coalesce(m.published_date, pe.published_at::text, ''))),
                            '\\s+',
                            ' ',
                            'g'
                        ) AS next_fallback_identity
                    FROM podcast_episodes pe
                    JOIN media m ON m.id = pe.media_id
                )
                SELECT 1
                FROM normalized
                GROUP BY podcast_id, next_fallback_identity
                HAVING count(*) > 1
            ) THEN
                RAISE EXCEPTION
                    '0138 current-only cutover blocked: duplicate podcast episodes normalize to the same fallback_identity; resolve duplicate podcast media before migrating';
            END IF;

            IF EXISTS (
                WITH normalized AS (
                    SELECT
                        pe.media_id,
                        pe.podcast_id,
                        CASE
                            WHEN pe.provider_episode_id ~ '^feed-[0-9a-f]{40}$' THEN
                                'feed-title-' ||
                                COALESCE(
                                    NULLIF(
                                        trim(both '-' from regexp_replace(
                                            regexp_replace(
                                                lower(trim(coalesce(m.title, ''))),
                                                '\\s+',
                                                ' ',
                                                'g'
                                            ),
                                            '[^a-z0-9]+',
                                            '-',
                                            'g'
                                        )),
                                        ''
                                    ),
                                    'missing'
                                ) ||
                                '-published-' ||
                                COALESCE(
                                    NULLIF(
                                        trim(both '-' from regexp_replace(
                                            regexp_replace(
                                                lower(trim(coalesce(
                                                    m.published_date,
                                                    pe.published_at::text,
                                                    ''
                                                ))),
                                                '\\s+',
                                                ' ',
                                                'g'
                                            ),
                                            '[^a-z0-9]+',
                                            '-',
                                            'g'
                                        )),
                                        ''
                                    ),
                                    'missing'
                                )
                            ELSE pe.provider_episode_id
                        END AS next_provider_episode_id
                    FROM podcast_episodes pe
                    JOIN media m ON m.id = pe.media_id
                )
                SELECT 1
                FROM normalized
                GROUP BY podcast_id, next_provider_episode_id
                HAVING count(*) > 1
            ) THEN
                RAISE EXCEPTION
                    '0138 current-only cutover blocked: duplicate podcast episodes normalize to the same provider_episode_id; resolve duplicate podcast media before migrating';
            END IF;
        END $$;
        """
    )

    op.execute(
        """
        UPDATE podcast_episodes pe
        SET fallback_identity =
            'audio_url=' ||
            regexp_replace(lower(trim(coalesce(m.external_playback_url, ''))), '\\s+', ' ', 'g') ||
            E'\n' ||
            'title=' ||
            regexp_replace(lower(trim(coalesce(m.title, ''))), '\\s+', ' ', 'g') ||
            E'\n' ||
            'published_at=' ||
            regexp_replace(
                lower(trim(coalesce(m.published_date, pe.published_at::text, ''))),
                '\\s+',
                ' ',
                'g'
            )
        FROM media m
        WHERE m.id = pe.media_id
        """
    )
    op.execute(
        """
        UPDATE podcasts
        SET provider_podcast_id = 'opml-feed-url=' || feed_url
        WHERE provider_podcast_id ~ '^opml-[0-9a-f]{40}$'
        """
    )
    op.execute(
        """
        UPDATE podcast_episodes pe
        SET provider_episode_id =
            'feed-title-' ||
            COALESCE(
                NULLIF(
                    trim(both '-' from regexp_replace(
                        regexp_replace(lower(trim(coalesce(m.title, ''))), '\\s+', ' ', 'g'),
                        '[^a-z0-9]+',
                        '-',
                        'g'
                    )),
                    ''
                ),
                'missing'
            ) ||
            '-published-' ||
            COALESCE(
                NULLIF(
                    trim(both '-' from regexp_replace(
                        regexp_replace(
                            lower(trim(coalesce(m.published_date, pe.published_at::text, ''))),
                            '\\s+',
                            ' ',
                            'g'
                        ),
                        '[^a-z0-9]+',
                        '-',
                        'g'
                    )),
                    ''
                ),
                'missing'
            )
        FROM media m
        WHERE m.id = pe.media_id
          AND pe.provider_episode_id ~ '^feed-[0-9a-f]{40}$'
        """
    )

    op.execute(
        """
        DELETE FROM highlights h
        USING highlight_fragment_anchors hfa
        JOIN fragments f ON f.id = hfa.fragment_id
        WHERE h.id = hfa.highlight_id
          AND f.transcript_version_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1
              FROM podcast_transcript_versions ptv
              WHERE ptv.id = f.transcript_version_id
                AND ptv.is_active
          )
        """
    )
    op.execute(
        """
        DELETE FROM fragments f
        WHERE f.transcript_version_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1
              FROM podcast_transcript_versions ptv
              WHERE ptv.id = f.transcript_version_id
                AND ptv.is_active
          )
        """
    )
    op.execute(
        """
        DELETE FROM podcast_transcript_segments pts
        WHERE NOT EXISTS (
              SELECT 1
              FROM podcast_transcript_versions ptv
              WHERE ptv.id = pts.transcript_version_id
                AND ptv.is_active
        )
        """
    )
    op.drop_constraint("fk_fragments_transcript_version_id", "fragments", type_="foreignkey")
    op.drop_column("fragments", "transcript_version_id")
    op.drop_constraint(
        "uq_podcast_transcript_segments_version_idx",
        "podcast_transcript_segments",
        type_="unique",
    )
    op.drop_column("podcast_transcript_segments", "transcript_version_id")
    op.create_unique_constraint(
        "uq_podcast_transcript_segments_media_idx",
        "podcast_transcript_segments",
        ["media_id", "segment_idx"],
    )
    op.drop_index(
        "uix_podcast_transcript_versions_media_active",
        table_name="podcast_transcript_versions",
    )
    op.drop_index(
        "ix_highlight_transcript_anchors_version",
        table_name="highlight_transcript_anchors",
    )
    op.drop_table("highlight_transcript_anchors")
    op.drop_table("podcast_transcript_versions")

    op.execute("UPDATE message_retrievals SET evidence_span_id = NULL WHERE evidence_span_id IS NOT NULL")
    op.execute(
        """
        DELETE FROM object_links
        WHERE (a_type = 'content_chunk' AND a_id IN (SELECT id FROM content_chunks))
           OR (b_type = 'content_chunk' AND b_id IN (SELECT id FROM content_chunks))
        """
    )
    op.execute("DELETE FROM content_embeddings")
    op.execute("DELETE FROM content_chunk_parts")
    op.execute("DELETE FROM content_chunks")
    op.execute("DELETE FROM evidence_spans")
    op.execute("DELETE FROM content_blocks")

    op.drop_column("content_blocks", "index_run_id")
    op.drop_column("content_blocks", "source_snapshot_id")
    op.drop_constraint("ck_content_blocks_sha", "content_blocks", type_="check")
    op.drop_column("content_blocks", "text_sha256")
    op.create_unique_constraint(
        "uq_content_blocks_media_idx",
        "content_blocks",
        ["media_id", "block_idx"],
    )
    op.create_index(
        "ix_content_blocks_media_idx",
        "content_blocks",
        ["media_id", "block_idx"],
    )

    op.drop_column("evidence_spans", "index_run_id")
    op.drop_column("evidence_spans", "source_snapshot_id")
    op.drop_constraint("ck_evidence_spans_sha", "evidence_spans", type_="check")
    op.drop_column("evidence_spans", "span_sha256")
    op.create_index("ix_evidence_spans_media", "evidence_spans", ["media_id"])

    op.drop_column("content_chunks", "index_run_id")
    op.drop_column("content_chunks", "source_snapshot_id")
    op.drop_constraint("ck_content_chunks_sha", "content_chunks", type_="check")
    op.drop_column("content_chunks", "chunk_sha256")
    op.drop_column("content_chunks", "chunker_version")
    op.create_unique_constraint(
        "uq_content_chunks_media_idx",
        "content_chunks",
        ["media_id", "chunk_idx"],
    )
    op.create_index(
        "ix_content_chunks_media_idx",
        "content_chunks",
        ["media_id", "chunk_idx"],
    )

    op.drop_index("ix_content_embeddings_model", table_name="content_embeddings")
    op.drop_column("content_embeddings", "embedding_config_hash")
    op.drop_constraint("ck_content_embeddings_sha", "content_embeddings", type_="check")
    op.drop_column("content_embeddings", "embedding_sha256")
    op.drop_column("content_embeddings", "embedding_version")
    op.create_index(
        "ix_content_embeddings_model",
        "content_embeddings",
        ["embedding_provider", "embedding_model"],
    )

    op.drop_index(
        "ix_media_content_index_states_repair_waiting",
        table_name="media_content_index_states",
    )
    op.drop_column("media_content_index_states", "active_run_id")
    op.drop_column("media_content_index_states", "latest_run_id")
    op.drop_column("media_content_index_states", "active_embedding_config_hash")
    op.drop_column("media_content_index_states", "active_embedding_version")
    op.execute(
        """
        UPDATE media_content_index_states
        SET status = 'pending',
            status_reason = 'current_only_artifacts_cutover',
            active_embedding_provider = NULL,
            active_embedding_model = NULL,
            updated_at = now()
        """
    )
    op.create_index(
        "ix_media_content_index_states_repair_waiting",
        "media_content_index_states",
        ["updated_at", "media_id"],
        postgresql_where=sa.text("status IN ('pending', 'failed')"),
    )

    op.execute("DROP INDEX IF EXISTS ix_source_snapshots_transcript_run_version")
    op.drop_index("ix_source_snapshots_media_run", table_name="source_snapshots")
    op.drop_table("source_snapshots")
    op.drop_index("ix_content_index_runs_media", table_name="content_index_runs")
    op.drop_table("content_index_runs")

    op.drop_index("ix_hpa_geometry_lookup", table_name="highlight_pdf_anchors")
    op.drop_constraint("ck_hpa_geometry_version", "highlight_pdf_anchors", type_="check")
    op.drop_constraint("ck_hpa_match_version", "highlight_pdf_anchors", type_="check")
    op.drop_column("highlight_pdf_anchors", "geometry_version")
    op.drop_column("highlight_pdf_anchors", "geometry_fingerprint")
    op.drop_column("highlight_pdf_anchors", "plain_text_match_version")

    op.drop_constraint("ck_ppts_extract_version", "pdf_page_text_spans", type_="check")
    op.drop_column("pdf_page_text_spans", "text_extract_version")

    op.add_column(
        "library_intelligence_artifacts",
        sa.Column("status", sa.Text(), nullable=True),
    )
    op.add_column(
        "library_intelligence_artifacts",
        sa.Column("generator_model_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "library_intelligence_artifacts",
        sa.Column("published_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
    )
    op.add_column(
        "library_intelligence_artifacts",
        sa.Column("invalidated_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
    )
    op.add_column(
        "library_intelligence_artifacts",
        sa.Column("invalid_reason", sa.Text(), nullable=True),
    )
    op.execute(
        """
        UPDATE library_intelligence_artifacts a
        SET status = CASE
                WHEN v.status = 'superseded' THEN 'stale'
                ELSE COALESCE(v.status, 'building')
            END,
            generator_model_id = v.generator_model_id,
            published_at = v.published_at,
            invalidated_at = v.invalidated_at,
            invalid_reason = CASE
                WHEN v.invalid_reason = 'source_set_changed' THEN 'source_changed'
                ELSE v.invalid_reason
            END
        FROM library_intelligence_versions v
        WHERE v.id = a.active_version_id
        """
    )
    op.execute(
        """
        UPDATE library_intelligence_artifacts
        SET status = 'building'
        WHERE status IS NULL
        """
    )
    op.alter_column("library_intelligence_artifacts", "status", nullable=False)
    op.create_foreign_key(
        "fk_library_intelligence_artifacts_generator_model",
        "library_intelligence_artifacts",
        "models",
        ["generator_model_id"],
        ["id"],
    )
    op.create_check_constraint(
        "ck_library_intelligence_artifacts_status",
        "library_intelligence_artifacts",
        "status IN ('building', 'active', 'failed', 'stale')",
    )
    op.create_check_constraint(
        "ck_library_intelligence_artifacts_active_published",
        "library_intelligence_artifacts",
        "(status = 'active' AND published_at IS NOT NULL) OR (status != 'active')",
    )
    op.create_check_constraint(
        "ck_library_intelligence_artifacts_invalid_pair",
        "library_intelligence_artifacts",
        "(invalid_reason IS NULL AND invalidated_at IS NULL) "
        "OR (invalid_reason IS NOT NULL AND invalidated_at IS NOT NULL)",
    )

    op.execute(
        """
        DELETE FROM library_intelligence_evidence e
        USING library_intelligence_claims c
        WHERE e.claim_id = c.id
          AND NOT EXISTS (
              SELECT 1
              FROM library_intelligence_artifacts a
              WHERE a.active_version_id = c.version_id
          )
        """
    )
    op.execute(
        """
        DELETE FROM library_intelligence_claims c
        WHERE NOT EXISTS (
            SELECT 1
            FROM library_intelligence_artifacts a
            WHERE a.active_version_id = c.version_id
        )
        """
    )
    op.execute(
        """
        DELETE FROM library_intelligence_nodes n
        WHERE NOT EXISTS (
            SELECT 1
            FROM library_intelligence_artifacts a
            WHERE a.active_version_id = n.version_id
        )
        """
    )
    op.execute(
        """
        DELETE FROM library_intelligence_sections s
        WHERE NOT EXISTS (
            SELECT 1
            FROM library_intelligence_artifacts a
            WHERE a.active_version_id = s.version_id
        )
        """
    )

    for table_name in (
        "library_intelligence_sections",
        "library_intelligence_nodes",
        "library_intelligence_claims",
    ):
        op.add_column(
            table_name,
            sa.Column("artifact_id", postgresql.UUID(as_uuid=True), nullable=True),
        )
        op.execute(
            f"""
            UPDATE {table_name} t
            SET artifact_id = v.artifact_id
            FROM library_intelligence_versions v
            WHERE t.version_id = v.id
            """
        )
        op.alter_column(table_name, "artifact_id", nullable=False)

    op.drop_constraint("fk_library_intelligence_artifacts_active_version", "library_intelligence_artifacts", type_="foreignkey")
    op.drop_column("library_intelligence_artifacts", "active_version_id")

    op.drop_constraint("uix_library_intelligence_sections_kind", "library_intelligence_sections", type_="unique")
    op.drop_constraint("uix_library_intelligence_sections_ordinal", "library_intelligence_sections", type_="unique")
    op.drop_constraint("library_intelligence_sections_version_id_fkey", "library_intelligence_sections", type_="foreignkey")
    op.drop_column("library_intelligence_sections", "version_id")
    op.create_foreign_key(
        "library_intelligence_sections_artifact_id_fkey",
        "library_intelligence_sections",
        "library_intelligence_artifacts",
        ["artifact_id"],
        ["id"],
    )
    op.create_unique_constraint(
        "uix_library_intelligence_sections_kind",
        "library_intelligence_sections",
        ["artifact_id", "section_kind"],
    )
    op.create_unique_constraint(
        "uix_library_intelligence_sections_ordinal",
        "library_intelligence_sections",
        ["artifact_id", "ordinal"],
    )

    op.drop_index("idx_library_intelligence_nodes_version_type", table_name="library_intelligence_nodes")
    op.drop_constraint("uix_library_intelligence_nodes_slug", "library_intelligence_nodes", type_="unique")
    op.drop_constraint("library_intelligence_nodes_version_id_fkey", "library_intelligence_nodes", type_="foreignkey")
    op.drop_column("library_intelligence_nodes", "version_id")
    op.create_foreign_key(
        "library_intelligence_nodes_artifact_id_fkey",
        "library_intelligence_nodes",
        "library_intelligence_artifacts",
        ["artifact_id"],
        ["id"],
    )
    op.create_unique_constraint(
        "uix_library_intelligence_nodes_slug",
        "library_intelligence_nodes",
        ["artifact_id", "slug"],
    )
    op.create_index(
        "idx_library_intelligence_nodes_artifact_type",
        "library_intelligence_nodes",
        ["artifact_id", "node_type"],
    )

    op.drop_constraint("uix_library_intelligence_claims_version_ordinal", "library_intelligence_claims", type_="unique")
    op.drop_constraint("library_intelligence_claims_version_id_fkey", "library_intelligence_claims", type_="foreignkey")
    op.drop_column("library_intelligence_claims", "version_id")
    op.create_foreign_key(
        "library_intelligence_claims_artifact_id_fkey",
        "library_intelligence_claims",
        "library_intelligence_artifacts",
        ["artifact_id"],
        ["id"],
    )
    op.create_unique_constraint(
        "uix_library_intelligence_claims_artifact_ordinal",
        "library_intelligence_claims",
        ["artifact_id", "ordinal"],
    )

    op.execute(
        """
        UPDATE library_intelligence_builds
        SET status = 'failed',
            phase = 'failed',
            error_code = COALESCE(error_code, 'E_CURRENT_ONLY_CUTOVER'),
            finished_at = COALESCE(finished_at, now()),
            updated_at = now()
        WHERE status IN ('pending', 'running')
        """
    )
    op.drop_constraint("uix_library_intelligence_builds_idempotency_key", "library_intelligence_builds", type_="unique")
    op.drop_constraint("library_intelligence_builds_source_set_version_id_fkey", "library_intelligence_builds", type_="foreignkey")
    op.drop_column("library_intelligence_builds", "source_set_version_id")
    op.create_check_constraint(
        "ck_library_intelligence_builds_idempotency_key_length",
        "library_intelligence_builds",
        "char_length(idempotency_key) BETWEEN 1 AND 256",
    )
    op.create_index(
        "uix_library_intelligence_builds_inflight",
        "library_intelligence_builds",
        ["library_id", "artifact_kind"],
        unique=True,
        postgresql_where=sa.text("status IN ('pending', 'running')"),
    )

    op.drop_index(
        "idx_library_intelligence_versions_library_status",
        table_name="library_intelligence_versions",
    )
    op.drop_table("library_intelligence_versions")
    op.drop_index(
        "idx_library_source_set_items_version_included",
        table_name="library_source_set_items",
    )
    op.drop_table("library_source_set_items")
    op.drop_index(
        "idx_library_source_sets_library_created",
        table_name="library_source_set_versions",
    )
    op.drop_table("library_source_set_versions")

    op.execute("DROP INDEX IF EXISTS idx_oracle_reading_passages_citation_key")
    op.execute(
        """
        UPDATE oracle_reading_events
        SET payload = payload - 'source_ref'
        WHERE event_type = 'passage'
          AND payload ? 'source_ref'
        """
    )
    op.drop_constraint(
        "ck_oracle_reading_passages_source_ref_object",
        "oracle_reading_passages",
        type_="check",
    )
    op.drop_column("oracle_reading_passages", "source_ref")

    op.execute(
        """
        WITH current_corpus AS (
            SELECT id
            FROM oracle_corpus_set_versions
            ORDER BY created_at DESC, id DESC
            LIMIT 1
        ),
        image_map AS (
            SELECT old_image.id AS old_id,
                   current_image.id AS current_id
            FROM oracle_corpus_images old_image
            LEFT JOIN oracle_corpus_images current_image
              ON current_image.source_url = old_image.source_url
             AND current_image.corpus_set_version_id = (SELECT id FROM current_corpus)
            WHERE old_image.corpus_set_version_id IS DISTINCT FROM (
                SELECT id FROM current_corpus
            )
        )
        UPDATE oracle_readings r
        SET image_id = image_map.current_id
        FROM image_map
        WHERE r.image_id = image_map.old_id
        """
    )
    op.execute(
        """
        DELETE FROM oracle_corpus_passages p
        WHERE p.corpus_set_version_id IS DISTINCT FROM (
            SELECT id
            FROM oracle_corpus_set_versions
            ORDER BY created_at DESC, id DESC
            LIMIT 1
        )
        """
    )
    op.execute(
        """
        DELETE FROM oracle_corpus_images i
        WHERE i.corpus_set_version_id IS DISTINCT FROM (
            SELECT id
            FROM oracle_corpus_set_versions
            ORDER BY created_at DESC, id DESC
            LIMIT 1
        )
        """
    )
    op.execute(
        """
        DELETE FROM oracle_corpus_works w
        WHERE w.corpus_set_version_id IS DISTINCT FROM (
            SELECT id
            FROM oracle_corpus_set_versions
            ORDER BY created_at DESC, id DESC
            LIMIT 1
        )
        """
    )

    op.drop_constraint("ck_oracle_readings_prompt_version_length", "oracle_readings", type_="check")
    op.drop_constraint(
        "ck_oracle_readings_provider_request_hash_length",
        "oracle_readings",
        type_="check",
    )
    op.drop_constraint("oracle_readings_corpus_set_version_id_fkey", "oracle_readings", type_="foreignkey")
    op.drop_column("oracle_readings", "provider_request_hash")
    op.drop_column("oracle_readings", "prompt_version")
    op.drop_column("oracle_readings", "corpus_set_version_id")

    op.drop_index("idx_oracle_images_version_embedding", table_name="oracle_corpus_images")
    op.drop_constraint("uix_oracle_images_version_source_url", "oracle_corpus_images", type_="unique")
    op.drop_constraint("oracle_corpus_images_corpus_set_version_id_fkey", "oracle_corpus_images", type_="foreignkey")
    op.drop_constraint("ck_oracle_images_storage_key_sha256_match", "oracle_corpus_images", type_="check")
    op.drop_constraint("ck_oracle_images_sha256_hex", "oracle_corpus_images", type_="check")
    op.drop_constraint("ck_oracle_images_storage_key_shape", "oracle_corpus_images", type_="check")
    op.execute(
        """
        UPDATE oracle_corpus_images
        SET storage_key = 'oracle/plates/' ||
            left(
                COALESCE(
                    NULLIF(
                        trim(both '-' from regexp_replace(lower(work_title), '[^a-z0-9]+', '-', 'g')),
                        ''
                    ),
                    'plate'
                ),
                96
            ) ||
            '-' || substr(id::text, 1, 8) ||
            CASE content_type
                WHEN 'image/jpeg' THEN '.jpg'
                WHEN 'image/png' THEN '.png'
                ELSE '.webp'
            END
        """
    )
    op.create_check_constraint(
        "ck_oracle_images_storage_key_shape",
        "oracle_corpus_images",
        r"storage_key ~ '^oracle/plates/[a-z0-9][a-z0-9._-]{0,191}\.(jpg|png|webp)$'",
    )
    op.drop_column("oracle_corpus_images", "sha256")
    op.drop_column("oracle_corpus_images", "corpus_set_version_id")
    op.create_unique_constraint(
        "uix_oracle_images_source_url",
        "oracle_corpus_images",
        ["source_url"],
    )
    op.create_index(
        "idx_oracle_images_embedding",
        "oracle_corpus_images",
        ["embedding_model"],
    )

    op.drop_index("idx_oracle_passages_version_embedding", table_name="oracle_corpus_passages")
    op.drop_constraint("oracle_corpus_passages_corpus_set_version_id_fkey", "oracle_corpus_passages", type_="foreignkey")
    op.drop_column("oracle_corpus_passages", "corpus_set_version_id")
    op.create_index(
        "idx_oracle_passages_embedding",
        "oracle_corpus_passages",
        ["embedding_model"],
    )

    op.drop_constraint("uix_oracle_works_version_slug", "oracle_corpus_works", type_="unique")
    op.drop_constraint("oracle_corpus_works_corpus_set_version_id_fkey", "oracle_corpus_works", type_="foreignkey")
    op.drop_column("oracle_corpus_works", "corpus_set_version_id")
    op.create_unique_constraint("uix_oracle_works_slug", "oracle_corpus_works", ["slug"])

    op.drop_table("oracle_corpus_set_versions")
    op.execute("DROP FUNCTION _nexus_strip_artifact_identity(jsonb)")


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0138 is not reversible")
