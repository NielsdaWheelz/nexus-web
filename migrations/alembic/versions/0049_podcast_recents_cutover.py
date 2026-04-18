"""Rewrite legacy podcast subscription recents to the podcasts home.

Revision ID: 0049
Revises: 0048
Create Date: 2026-04-18
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0049"
down_revision: str | None = "0048"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE command_palette_recents podcasts
        SET
            created_at = LEAST(podcasts.created_at, legacy.created_at),
            last_used_at = GREATEST(podcasts.last_used_at, legacy.last_used_at),
            title_snapshot = 'Podcasts'
        FROM command_palette_recents legacy
        WHERE podcasts.user_id = legacy.user_id
          AND podcasts.href = '/podcasts'
          AND legacy.href = '/podcasts/subscriptions'
        """
    )
    op.execute(
        """
        DELETE FROM command_palette_recents legacy
        USING command_palette_recents podcasts
        WHERE legacy.user_id = podcasts.user_id
          AND legacy.href = '/podcasts/subscriptions'
          AND podcasts.href = '/podcasts'
        """
    )
    op.execute(
        """
        UPDATE command_palette_recents
        SET
            href = '/podcasts',
            title_snapshot = 'Podcasts'
        WHERE href = '/podcasts/subscriptions'
        """
    )


def downgrade() -> None:
    # Data cleanup only. Leave rewritten recents in place on downgrade.
    pass
