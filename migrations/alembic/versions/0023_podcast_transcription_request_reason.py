"""Add request_reason to podcast transcription jobs.

Revision ID: 0023
Revises: 0022
Create Date: 2026-03-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0023"
down_revision: str | None = "0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "podcast_transcription_jobs",
        sa.Column(
            "request_reason",
            sa.Text(),
            nullable=False,
            server_default="episode_open",
        ),
    )
    op.create_check_constraint(
        "ck_podcast_transcription_jobs_request_reason",
        "podcast_transcription_jobs",
        (
            "request_reason IN ("
            "'episode_open', "
            "'search', "
            "'highlight', "
            "'quote', "
            "'background_warming', "
            "'operator_requeue'"
            ")"
        ),
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_podcast_transcription_jobs_request_reason",
        "podcast_transcription_jobs",
        type_="check",
    )
    op.drop_column("podcast_transcription_jobs", "request_reason")
