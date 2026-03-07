"""Add podcast transcription job lifecycle state fields.

Revision ID: 0021
Revises: 0020
Create Date: 2026-03-06
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0021"
down_revision: str | None = "0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "podcast_transcription_jobs",
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "podcast_transcription_jobs",
        sa.Column("started_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    op.add_column(
        "podcast_transcription_jobs",
        sa.Column("completed_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )

    op.drop_constraint(
        "ck_podcast_transcription_jobs_status",
        "podcast_transcription_jobs",
        type_="check",
    )
    op.create_check_constraint(
        "ck_podcast_transcription_jobs_status",
        "podcast_transcription_jobs",
        "status IN ('pending', 'running', 'completed', 'failed')",
    )
    op.create_check_constraint(
        "ck_podcast_transcription_jobs_attempts_non_negative",
        "podcast_transcription_jobs",
        "attempts >= 0",
    )


def downgrade() -> None:
    # Older status constraint does not allow "running".
    # Normalize in-flight rows before restoring the previous check.
    op.execute(
        sa.text("""
        UPDATE podcast_transcription_jobs
        SET status = 'pending'
        WHERE status = 'running'
        """)
    )

    op.drop_constraint(
        "ck_podcast_transcription_jobs_attempts_non_negative",
        "podcast_transcription_jobs",
        type_="check",
    )
    op.drop_constraint(
        "ck_podcast_transcription_jobs_status",
        "podcast_transcription_jobs",
        type_="check",
    )
    op.create_check_constraint(
        "ck_podcast_transcription_jobs_status",
        "podcast_transcription_jobs",
        "status IN ('pending', 'completed', 'failed')",
    )

    op.drop_column("podcast_transcription_jobs", "completed_at")
    op.drop_column("podcast_transcription_jobs", "started_at")
    op.drop_column("podcast_transcription_jobs", "attempts")
