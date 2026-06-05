"""durable media source attempts

Revision ID: 0133
Revises: 0132
Create Date: 2026-06-04

Accepted source-ingest requests must survive provider, network, storage, and
extraction failures. This table is the durable source-acquisition command log
and retry state for those accepted requests.
"""

from collections.abc import Sequence

from alembic import op
from sqlalchemy import text

# revision identifiers, used by Alembic.
revision: str = "0133"
down_revision: str | Sequence[str] | None = "0132"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE media_source_attempts (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            media_id uuid NOT NULL REFERENCES media(id),
            created_by_user_id uuid REFERENCES users(id),
            source_type text NOT NULL,
            attempt_no integer NOT NULL,
            run_count integer NOT NULL DEFAULT 0,
            status text NOT NULL,
            intent_key text NOT NULL,
            idempotency_key text,
            requested_url text,
            canonical_source_url text,
            provider text,
            provider_target_ref text,
            source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
            request_id text,
            job_id uuid REFERENCES background_jobs(id) ON DELETE SET NULL,
            error_code text,
            error_message text,
            retry_after_seconds integer,
            started_at timestamptz,
            finished_at timestamptz,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT ck_media_source_attempts_source_type CHECK (
                source_type IN (
                    'generic_web_url',
                    'x_author_thread',
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
            ),
            CONSTRAINT ck_media_source_attempts_status CHECK (
                status IN ('accepted', 'queued', 'running', 'succeeded', 'failed', 'superseded')
            ),
            CONSTRAINT ck_media_source_attempts_attempt_no CHECK (attempt_no >= 1),
            CONSTRAINT ck_media_source_attempts_run_count CHECK (run_count >= 0),
            CONSTRAINT ck_media_source_attempts_source_payload CHECK (
                jsonb_typeof(source_payload) = 'object'
            ),
            CONSTRAINT ck_media_source_attempts_idempotency_user CHECK (
                idempotency_key IS NULL OR created_by_user_id IS NOT NULL
            ),
            CONSTRAINT ck_media_source_attempts_requested_url_length CHECK (
                requested_url IS NULL OR char_length(requested_url) <= 2048
            ),
            CONSTRAINT ck_media_source_attempts_canonical_source_url_length CHECK (
                canonical_source_url IS NULL OR char_length(canonical_source_url) <= 2048
            ),
            CONSTRAINT ck_media_source_attempts_retry_after CHECK (
                retry_after_seconds IS NULL OR retry_after_seconds >= 0
            ),
            CONSTRAINT uq_media_source_attempts_media_attempt UNIQUE (media_id, attempt_no)
        )
    """)
    op.execute("""
        CREATE INDEX idx_media_source_attempts_media_created
            ON media_source_attempts (media_id, created_at DESC, id DESC)
    """)
    op.create_index(
        "idx_media_source_attempts_status_updated",
        "media_source_attempts",
        ["status", "updated_at", "id"],
    )
    op.create_index(
        "idx_media_source_attempts_request_id",
        "media_source_attempts",
        ["request_id"],
        postgresql_where=text("request_id IS NOT NULL"),
    )
    op.create_index(
        "idx_media_source_attempts_source_type_status_updated",
        "media_source_attempts",
        ["source_type", "status", "updated_at", "id"],
    )
    op.create_index(
        "idx_media_source_attempts_provider_target",
        "media_source_attempts",
        ["provider", "provider_target_ref", "created_at", "id"],
        postgresql_where=text("provider IS NOT NULL AND provider_target_ref IS NOT NULL"),
    )
    op.create_index(
        "uq_media_source_attempts_idempotency",
        "media_source_attempts",
        ["created_by_user_id", "idempotency_key"],
        unique=True,
        postgresql_where=text("idempotency_key IS NOT NULL"),
    )
    op.execute("""
        ALTER TABLE external_provider_events
            ADD CONSTRAINT fk_external_provider_events_source_attempt
            FOREIGN KEY (source_attempt_id)
            REFERENCES media_source_attempts(id)
        """)
    op.execute("""
        WITH classified AS (
            SELECT
                m.id AS media_id,
                m.created_by_user_id,
                CASE
                    WHEN m.kind = 'web_article'
                         AND (
                            m.provider = 'x'
                            OR COALESCE(m.requested_url, '') ~* '(x|twitter)\\.com/.*/status'
                            OR COALESCE(m.canonical_source_url, '') ~* '(x|twitter)\\.com/.*/status'
                            OR COALESCE(m.canonical_url, '') ~* '(x|twitter)\\.com/.*/status'
                         )
                        THEN 'x_author_thread'
                    WHEN m.kind = 'web_article'
                        THEN 'generic_web_url'
                    WHEN m.kind = 'video'
                         AND (
                            m.provider = 'youtube'
                            OR m.provider_id IS NOT NULL
                            OR COALESCE(m.requested_url, '') ~* '(youtube\\.com|youtu\\.be)'
                            OR COALESCE(m.canonical_source_url, '') ~* '(youtube\\.com|youtu\\.be)'
                            OR COALESCE(m.canonical_url, '') ~* '(youtube\\.com|youtu\\.be)'
                         )
                        THEN 'youtube_video'
                    WHEN m.kind = 'video'
                        THEN 'video_transcript'
                    WHEN m.kind = 'podcast_episode'
                        THEN 'podcast_episode_transcript'
                    WHEN m.kind = 'pdf' AND mf.media_id IS NULL
                        THEN 'remote_pdf_url'
                    WHEN m.kind = 'epub' AND mf.media_id IS NULL
                        THEN 'remote_epub_url'
                    WHEN m.kind = 'pdf'
                        THEN 'uploaded_pdf_file'
                    WHEN m.kind = 'epub'
                        THEN 'uploaded_epub_file'
                END AS source_type,
                CASE
                    WHEN m.processing_status::text = 'failed'
                        THEN 'failed'
                    WHEN m.processing_status::text IN ('pending', 'extracting')
                        THEN 'queued'
                    ELSE 'succeeded'
                END AS attempt_status,
                m.requested_url,
                COALESCE(m.canonical_source_url, m.canonical_url, m.requested_url) AS canonical_source_url,
                m.provider,
                CASE
                    WHEN m.kind = 'web_article' THEN COALESCE(
                        substring(m.provider_id from '^post:([0-9]+)$'),
                        substring(m.requested_url from '/statuses?/([0-9]+)'),
                        substring(m.canonical_source_url from '/statuses?/([0-9]+)'),
                        substring(m.canonical_url from '/statuses?/([0-9]+)')
                    )
                    WHEN m.kind = 'video' THEN COALESCE(
                        m.provider_id,
                        substring(m.requested_url from '[?&]v=([A-Za-z0-9_-]{6,})'),
                        substring(m.canonical_source_url from '[?&]v=([A-Za-z0-9_-]{6,})'),
                        substring(m.canonical_url from '[?&]v=([A-Za-z0-9_-]{6,})'),
                        substring(m.requested_url from 'youtu\\.be/([A-Za-z0-9_-]{6,})'),
                        substring(m.canonical_source_url from 'youtu\\.be/([A-Za-z0-9_-]{6,})'),
                        substring(m.canonical_url from 'youtu\\.be/([A-Za-z0-9_-]{6,})'),
                        substring(m.requested_url from '/shorts/([A-Za-z0-9_-]{6,})'),
                        substring(m.canonical_source_url from '/shorts/([A-Za-z0-9_-]{6,})'),
                        substring(m.canonical_url from '/shorts/([A-Za-z0-9_-]{6,})'),
                        substring(m.requested_url from '/embed/([A-Za-z0-9_-]{6,})'),
                        substring(m.canonical_source_url from '/embed/([A-Za-z0-9_-]{6,})'),
                        substring(m.canonical_url from '/embed/([A-Za-z0-9_-]{6,})')
                    )
                END AS provider_target_ref,
                jsonb_strip_nulls(jsonb_build_object(
                    'backfilled', true,
                    'media_kind', m.kind,
                    'media_status', m.processing_status::text,
                    'file_sha256', m.file_sha256,
                    'storage_path', mf.storage_path,
                    'content_type', mf.content_type,
                    'size_bytes', mf.size_bytes
                )) AS source_payload,
                m.processing_attempts,
                m.last_error_code,
                m.last_error_message,
                m.processing_started_at,
                m.failed_at,
                m.processing_completed_at,
                m.created_at,
                m.updated_at
            FROM media m
            LEFT JOIN media_file mf ON mf.media_id = m.id
            WHERE m.kind IN ('web_article', 'video', 'podcast_episode', 'pdf', 'epub')
        )
        INSERT INTO media_source_attempts (
            media_id,
            created_by_user_id,
            source_type,
            attempt_no,
            run_count,
            status,
            intent_key,
            requested_url,
            canonical_source_url,
            provider,
            provider_target_ref,
            source_payload,
            error_code,
            error_message,
            started_at,
            finished_at,
            created_at,
            updated_at
        )
        SELECT
            media_id,
            created_by_user_id,
            source_type,
            1,
            GREATEST(COALESCE(processing_attempts, 0), 0),
            attempt_status,
            'backfill:' || source_type || ':' || media_id::text,
            requested_url,
            canonical_source_url,
            provider,
            provider_target_ref,
            source_payload,
            CASE WHEN attempt_status = 'failed' THEN last_error_code END,
            CASE WHEN attempt_status = 'failed' THEN last_error_message END,
            processing_started_at,
            CASE
                WHEN attempt_status = 'failed' THEN failed_at
                WHEN attempt_status = 'succeeded' THEN processing_completed_at
            END,
            created_at,
            updated_at
        FROM classified
        WHERE source_type IS NOT NULL
    """)


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0133 is not reversible")
