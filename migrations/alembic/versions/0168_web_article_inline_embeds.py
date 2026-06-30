"""Web article inline embeds hard cutover.

Revision ID: 0168
Revises: 0167
Create Date: 2026-06-29
"""

from collections.abc import Sequence

from alembic import op
from sqlalchemy import text

revision: str = "0168"
down_revision: str | Sequence[str] | None = "0167"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE media_source_attempts DROP CONSTRAINT ck_media_source_attempts_source_type"
    )
    op.execute("""
        ALTER TABLE media_source_attempts ADD CONSTRAINT ck_media_source_attempts_source_type
        CHECK (
            source_type IN (
                'generic_web_url',
                'x_author_thread',
                'x_post',
                'youtube_video',
                'remote_pdf_url',
                'remote_epub_url',
                'uploaded_pdf_file',
                'uploaded_epub_file',
                'browser_article_capture',
                'browser_pdf_capture',
                'browser_epub_capture',
                'podcast_episode_transcript',
                'video_transcript'
            )
        )
    """)

    op.execute("ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_origin")
    op.execute("""
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_origin
        CHECK (
            origin IN (
                'user', 'citation', 'system', 'note_body', 'highlight_note',
                'synapse', 'document_embed'
            )
        )
    """)

    op.execute("""
        CREATE TABLE document_embed_artifact_states (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            media_id uuid NOT NULL REFERENCES media(id),
            source_attempt_id uuid REFERENCES media_source_attempts(id),
            status text NOT NULL,
            total_count integer NOT NULL DEFAULT 0,
            resolved_count integer NOT NULL DEFAULT 0,
            unsupported_count integer NOT NULL DEFAULT 0,
            failed_count integer NOT NULL DEFAULT 0,
            extraction_error_code text,
            extraction_error_message text,
            diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT uq_document_embed_artifact_states_media UNIQUE (media_id)
        )
    """)

    op.execute("""
        CREATE TABLE document_embeds (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            media_id uuid NOT NULL REFERENCES media(id),
            fragment_id uuid REFERENCES fragments(id),
            source_attempt_id uuid REFERENCES media_source_attempts(id),
            ordinal integer NOT NULL,
            occurrence_key text NOT NULL,
            provider text NOT NULL,
            embed_kind text NOT NULL,
            source_shape text NOT NULL,
            resolution_status text NOT NULL,
            source_url text,
            canonical_source_url text,
            provider_target_ref text,
            target_media_id uuid REFERENCES media(id),
            title text,
            description text,
            thumbnail_url text,
            authored_text text,
            placeholder_text text NOT NULL,
            source_start_offset integer,
            source_end_offset integer,
            canonical_start_offset integer,
            canonical_end_offset integer,
            document_order_key text NOT NULL,
            error_code text,
            error_message text,
            diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT uq_document_embeds_media_ordinal UNIQUE (media_id, ordinal),
            CONSTRAINT uq_document_embeds_media_key UNIQUE (media_id, occurrence_key)
        )
    """)
    op.create_index(
        "idx_document_embeds_media_order",
        "document_embeds",
        ["media_id", "ordinal", "id"],
    )
    op.create_index(
        "idx_document_embeds_fragment_order",
        "document_embeds",
        ["fragment_id", "ordinal", "id"],
        postgresql_where=text("fragment_id IS NOT NULL"),
    )
    op.create_index(
        "idx_document_embeds_target_media",
        "document_embeds",
        ["target_media_id"],
        postgresql_where=text("target_media_id IS NOT NULL"),
    )
    op.create_index(
        "idx_document_embeds_resolution",
        "document_embeds",
        ["resolution_status", "updated_at", "id"],
        postgresql_where=text("resolution_status IN ('pending', 'resolving', 'failed')"),
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0168 is not reversible")
