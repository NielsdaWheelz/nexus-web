"""Persist completion and remove furthest-point progression.

Revision ID: 0265
Revises: 0264

Writers must be stopped and the database backed up before this cutover.
Existing effective finished/unread states survive; completion history is untouched.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0265"
down_revision: str | Sequence[str] | None = "0264"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        INSERT INTO consumption_overrides (user_id, media_id, status, revision)
        SELECT engagement.user_id, engagement.media_id, 'finished', 1
        FROM reader_engagement_states engagement
        JOIN media ON media.id = engagement.media_id
        LEFT JOIN consumption_overrides override
          ON override.user_id = engagement.user_id AND override.media_id = engagement.media_id
        WHERE media.kind <> 'podcast_episode'
          AND engagement.max_total_progression >= 0.95
          AND override.media_id IS NULL
    """)
    op.execute("""
        INSERT INTO consumption_overrides (user_id, media_id, status, revision)
        SELECT listening.user_id, listening.media_id, 'finished', 1
        FROM podcast_listening_states listening
        JOIN podcast_episodes episode ON episode.media_id = listening.media_id
        LEFT JOIN consumption_overrides override
          ON override.user_id = listening.user_id AND override.media_id = listening.media_id
        WHERE override.media_id IS NULL
          AND COALESCE(listening.duration_ms, episode.duration_seconds * 1000) > 0
          AND listening.position_ms::float8
              / NULLIF(COALESCE(listening.duration_ms, episode.duration_seconds * 1000), 0) >= 0.95
    """)
    op.execute("""
        INSERT INTO reader_media_state (user_id, media_id, locator, revision)
        SELECT user_id, media_id, NULL, 1
        FROM consumption_overrides WHERE status = 'unread'
        ON CONFLICT (user_id, media_id) DO UPDATE
        SET revision = reader_media_state.revision + 1, updated_at = now()
    """)
    op.execute("""
        INSERT INTO podcast_listening_states (
            user_id, media_id, reset_epoch
        )
        SELECT override.user_id, override.media_id, 1
        FROM consumption_overrides override
        JOIN media ON media.id = override.media_id
        WHERE override.status = 'unread' AND media.kind = 'podcast_episode'
        ON CONFLICT (user_id, media_id) DO UPDATE
        SET reset_epoch = podcast_listening_states.reset_epoch + 1,
            updated_at = now()
    """)
    op.drop_constraint(
        "ck_reader_engagement_states_max_total_progression",
        "reader_engagement_states",
        type_="check",
    )
    op.drop_column("reader_engagement_states", "max_total_progression")


def downgrade() -> None:
    raise NotImplementedError("0265 requires restoring the verified pre-cutover database backup")
