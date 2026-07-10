"""Post Room: email ingest address — CHECK widenings + dedupe index.

Adds ``email_message`` to the ``media_source_attempts.source_type`` allowlist
and ``email`` to the ``contributor_external_ids.authority`` allowlist. Adds a
partial unique index ``uix_media_email_provider_id`` on ``(provider,
provider_id)`` for email-message deduplication by ``Message-ID``.

All three changes are additive; downgrade fails loud if live rows carry the new
values (greenfield-drop discipline — forward-only in practice).

Revision ID: 0178
Revises: 0177
Create Date: 2026-07-10
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0178"
down_revision: str | Sequence[str] | None = "0177"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1. Widen ck_media_source_attempts_source_type (+email_message, 14 values total).
    op.drop_constraint(
        "ck_media_source_attempts_source_type",
        "media_source_attempts",
        type_="check",
    )
    op.create_check_constraint(
        "ck_media_source_attempts_source_type",
        "media_source_attempts",
        """source_type IN (
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
            'video_transcript',
            'email_message'
        )""",
    )

    # 2. Widen ck_contributor_external_ids_authority (+email).
    op.drop_constraint(
        "ck_contributor_external_ids_authority",
        "contributor_external_ids",
        type_="check",
    )
    op.create_check_constraint(
        "ck_contributor_external_ids_authority",
        "contributor_external_ids",
        "authority IN ('orcid', 'isni', 'viaf', 'wikidata', 'openalex', 'lcnaf', "
        "'podcast_index', 'rss', 'youtube', 'gutenberg', 'email')",
    )

    # 3. Partial unique index for email dedupe by Message-ID.
    op.create_index(
        "uix_media_email_provider_id",
        "media",
        ["provider", "provider_id"],
        unique=True,
        postgresql_where="provider = 'email' AND provider_id IS NOT NULL",
    )


def downgrade() -> None:
    # Fail loudly if live email rows exist — documented greenfield-drop discipline.
    op.drop_index(
        "uix_media_email_provider_id",
        table_name="media",
    )

    op.drop_constraint(
        "ck_contributor_external_ids_authority",
        "contributor_external_ids",
        type_="check",
    )
    op.create_check_constraint(
        "ck_contributor_external_ids_authority",
        "contributor_external_ids",
        "authority IN ('orcid', 'isni', 'viaf', 'wikidata', 'openalex', 'lcnaf', "
        "'podcast_index', 'rss', 'youtube', 'gutenberg')",
    )

    op.drop_constraint(
        "ck_media_source_attempts_source_type",
        "media_source_attempts",
        type_="check",
    )
    op.create_check_constraint(
        "ck_media_source_attempts_source_type",
        "media_source_attempts",
        """source_type IN (
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
        )""",
    )
