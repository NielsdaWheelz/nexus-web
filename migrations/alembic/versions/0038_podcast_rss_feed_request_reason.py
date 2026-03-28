"""Allow rss_feed transcript reason and cache RSS transcript URL.

Revision ID: 0038
Revises: 0037
Create Date: 2026-03-28
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0038"
down_revision: str | None = "0037"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        "ck_podcast_transcription_jobs_request_reason",
        "podcast_transcription_jobs",
        type_="check",
    )
    op.create_check_constraint(
        "ck_podcast_transcription_jobs_request_reason",
        "podcast_transcription_jobs",
        (
            "request_reason IN ("
            "'episode_open', 'search', 'highlight', 'quote', 'background_warming', "
            "'operator_requeue', 'rss_feed'"
            ")"
        ),
    )

    op.drop_constraint(
        "ck_podcast_transcript_versions_request_reason",
        "podcast_transcript_versions",
        type_="check",
    )
    op.create_check_constraint(
        "ck_podcast_transcript_versions_request_reason",
        "podcast_transcript_versions",
        (
            "request_reason IN ("
            "'episode_open', 'search', 'highlight', 'quote', 'background_warming', "
            "'operator_requeue', 'rss_feed'"
            ")"
        ),
    )

    op.add_column("podcast_episodes", sa.Column("rss_transcript_url", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("podcast_episodes", "rss_transcript_url")

    op.execute(
        """
        UPDATE podcast_transcript_versions
        SET request_reason = 'episode_open'
        WHERE request_reason = 'rss_feed'
        """
    )
    op.drop_constraint(
        "ck_podcast_transcript_versions_request_reason",
        "podcast_transcript_versions",
        type_="check",
    )
    op.create_check_constraint(
        "ck_podcast_transcript_versions_request_reason",
        "podcast_transcript_versions",
        (
            "request_reason IN ("
            "'episode_open', 'search', 'highlight', 'quote', 'background_warming', "
            "'operator_requeue'"
            ")"
        ),
    )

    op.execute(
        """
        UPDATE podcast_transcription_jobs
        SET request_reason = 'episode_open'
        WHERE request_reason = 'rss_feed'
        """
    )
    op.drop_constraint(
        "ck_podcast_transcription_jobs_request_reason",
        "podcast_transcription_jobs",
        type_="check",
    )
    op.create_check_constraint(
        "ck_podcast_transcription_jobs_request_reason",
        "podcast_transcription_jobs",
        (
            "request_reason IN ("
            "'episode_open', 'search', 'highlight', 'quote', 'background_warming', "
            "'operator_requeue'"
            ")"
        ),
    )
