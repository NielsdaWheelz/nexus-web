"""Retain native article discovery, current publication and capture intent.

Revision ID: 0295
Revises: 0294

Old X media remain uninspected; no content, captures or annotations are rewritten.
Supersession ownership is recovered only from its original attempt or an exact
surviving ingest job. Unprovable ownership stays null, so replay of that old id
is refused rather than assigned to the surviving media's potentially different
owner. New supersessions retain their original actor before teardown.

Existing browser origins and article attempts acquire a null article binding;
their stored packets and hashes are unchanged. Unfinished canonical-article
uploads must be captured again. No current article publication is fabricated.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0295"
down_revision: str | Sequence[str] | None = "0294"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE media_source_attempts DROP CONSTRAINT ck_media_source_attempts_source_type;
        ALTER TABLE media_source_attempts ADD CONSTRAINT ck_media_source_attempts_source_type
        CHECK (source_type IN (
            'generic_web_url', 'x_author_thread', 'x_post', 'x_article', 'youtube_video',
            'remote_pdf_url', 'remote_epub_url', 'uploaded_pdf_file', 'uploaded_epub_file',
            'browser_article_capture', 'browser_pdf_capture', 'browser_epub_capture',
            'podcast_episode_transcript', 'email_message'
        ));
        CREATE TABLE x_article_inspections (
            thread_media_id uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
            carrier_post_id text NOT NULL CHECK (carrier_post_id ~ '^[0-9]+$'),
            article_id text CHECK (article_id ~ '^[0-9]+$'),
            article_media_id uuid REFERENCES media(id) ON DELETE SET NULL,
            PRIMARY KEY (thread_media_id, carrier_post_id),
            CHECK (article_id IS NOT NULL OR article_media_id IS NULL)
        );
        CREATE INDEX ix_x_article_inspections_article ON x_article_inspections(article_media_id);
        CREATE TABLE x_article_sources (
            media_id uuid PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
            source_attempt_id uuid NOT NULL REFERENCES media_source_attempts(id),
            completeness text NOT NULL
        );
        UPDATE media_upload_sessions
        SET input_origin = input_origin || jsonb_build_object('x_article_binding', NULL)
        WHERE input_origin->>'kind' = 'BrowserCapture';
        UPDATE media_source_attempts
        SET source_payload = source_payload || jsonb_build_object('x_article_binding', NULL)
        WHERE source_type = 'browser_article_capture';
        ALTER TABLE media_source_supersessions ADD COLUMN created_by_user_id uuid
            REFERENCES users(id) ON DELETE SET NULL;
        UPDATE media_source_supersessions s SET created_by_user_id = a.created_by_user_id
        FROM media_source_attempts a WHERE a.id = s.source_attempt_id;
        UPDATE media_source_supersessions s SET created_by_user_id = proof.actor_id::uuid
        FROM (
            SELECT j.payload->>'attempt_id' AS attempt_id, min(u.id::text) AS actor_id
            FROM background_jobs j JOIN users u ON u.id::text = j.payload->>'actor_user_id'
            WHERE j.kind = 'ingest_media_source'
            GROUP BY j.payload->>'attempt_id' HAVING count(DISTINCT u.id) = 1
        ) proof
        WHERE s.created_by_user_id IS NULL AND proof.attempt_id = s.source_attempt_id::text;
    """)


def downgrade() -> None:
    raise NotImplementedError("0295 is irreversible; restore the pre-release backup")
