"""Add podcast quota reservation/commit columns.

Revision ID: 0025
Revises: 0024
Create Date: 2026-03-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0025"
down_revision: str | None = "0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "podcast_transcription_usage_daily",
        sa.Column("minutes_reserved", sa.Integer(), nullable=False, server_default="0"),
    )
    op.drop_constraint(
        "ck_podcast_transcription_usage_daily_minutes_non_negative",
        "podcast_transcription_usage_daily",
        type_="check",
    )
    op.create_check_constraint(
        "ck_podcast_transcription_usage_daily_non_negative",
        "podcast_transcription_usage_daily",
        "minutes_used >= 0 AND minutes_reserved >= 0",
    )

    op.add_column(
        "podcast_transcription_jobs",
        sa.Column("reserved_minutes", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "podcast_transcription_jobs",
        sa.Column("reservation_usage_date", sa.Date(), nullable=True),
    )
    op.create_check_constraint(
        "ck_podcast_transcription_jobs_reserved_minutes_non_negative",
        "podcast_transcription_jobs",
        "reserved_minutes >= 0",
    )

    # Lift in-flight jobs from legacy pre-charged semantics into explicit reservations.
    op.execute(
        """
        UPDATE podcast_transcription_jobs j
        SET
            reserved_minutes = GREATEST(
                1,
                CEIL(COALESCE(pe.duration_seconds, 60)::numeric / 60.0)::int
            ),
            reservation_usage_date = COALESCE(
                (j.updated_at AT TIME ZONE 'UTC')::date,
                (now() AT TIME ZONE 'UTC')::date
            )
        FROM podcast_episodes pe
        WHERE pe.media_id = j.media_id
          AND j.status IN ('pending', 'running')
          AND COALESCE(j.reserved_minutes, 0) = 0
        """
    )
    op.execute(
        """
        WITH pending_reservations AS (
            SELECT
                j.requested_by_user_id AS user_id,
                j.reservation_usage_date AS usage_date,
                SUM(j.reserved_minutes)::int AS reserved_total
            FROM podcast_transcription_jobs j
            WHERE j.status IN ('pending', 'running')
              AND j.requested_by_user_id IS NOT NULL
              AND j.reservation_usage_date IS NOT NULL
              AND j.reserved_minutes > 0
            GROUP BY j.requested_by_user_id, j.reservation_usage_date
        )
        INSERT INTO podcast_transcription_usage_daily (
            user_id,
            usage_date,
            minutes_used,
            minutes_reserved,
            updated_at
        )
        SELECT
            pr.user_id,
            pr.usage_date,
            0,
            0,
            now()
        FROM pending_reservations pr
        ON CONFLICT (user_id, usage_date) DO NOTHING
        """
    )
    op.execute(
        """
        WITH pending_reservations AS (
            SELECT
                j.requested_by_user_id AS user_id,
                j.reservation_usage_date AS usage_date,
                SUM(j.reserved_minutes)::int AS reserved_total
            FROM podcast_transcription_jobs j
            WHERE j.status IN ('pending', 'running')
              AND j.requested_by_user_id IS NOT NULL
              AND j.reservation_usage_date IS NOT NULL
              AND j.reserved_minutes > 0
            GROUP BY j.requested_by_user_id, j.reservation_usage_date
        )
        UPDATE podcast_transcription_usage_daily u
        SET
            minutes_used = GREATEST(u.minutes_used - pr.reserved_total, 0),
            minutes_reserved = u.minutes_reserved + pr.reserved_total,
            updated_at = now()
        FROM pending_reservations pr
        WHERE u.user_id = pr.user_id
          AND u.usage_date = pr.usage_date
        """
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_podcast_transcription_jobs_reserved_minutes_non_negative",
        "podcast_transcription_jobs",
        type_="check",
    )
    op.drop_column("podcast_transcription_jobs", "reservation_usage_date")
    op.drop_column("podcast_transcription_jobs", "reserved_minutes")

    op.drop_constraint(
        "ck_podcast_transcription_usage_daily_non_negative",
        "podcast_transcription_usage_daily",
        type_="check",
    )
    op.create_check_constraint(
        "ck_podcast_transcription_usage_daily_minutes_non_negative",
        "podcast_transcription_usage_daily",
        "minutes_used >= 0",
    )
    op.drop_column("podcast_transcription_usage_daily", "minutes_reserved")
