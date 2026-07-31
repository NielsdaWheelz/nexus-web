"""Hard-cut daily Pages, capture, and account calendar timezones.

Revision ID: 0205
Revises: 0204
Create Date: 2026-07-30
"""

from collections.abc import Sequence
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import sqlalchemy as sa
from alembic import op

revision: str = "0205"
down_revision: str | Sequence[str] | None = "0204"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _accepted_time_zone(value: str) -> bool:
    try:
        ZoneInfo(value)
    except (ValueError, ZoneInfoNotFoundError):
        return False
    return True


def upgrade() -> None:
    bind = op.get_bind()
    op.add_column(
        "users",
        sa.Column(
            "calendar_time_zone",
            sa.Text(),
            nullable=False,
            server_default="UTC",
        ),
    )

    selected_by_user: dict[object, str] = {}
    rows = bind.execute(
        sa.text(
            """
            SELECT user_id, time_zone
            FROM daily_note_pages
            WHERE deleted_at IS NULL
            ORDER BY user_id, updated_at DESC, created_at DESC, id DESC
            """
        )
    )
    for user_id, time_zone in rows:
        if user_id not in selected_by_user and _accepted_time_zone(time_zone):
            selected_by_user[user_id] = time_zone
    if selected_by_user:
        bind.execute(
            sa.text(
                """
                UPDATE users
                SET calendar_time_zone = :time_zone
                WHERE id = :user_id
                """
            ),
            [
                {"user_id": user_id, "time_zone": time_zone}
                for user_id, time_zone in selected_by_user.items()
            ],
        )

    bind.execute(sa.text("DELETE FROM daily_note_pages WHERE deleted_at IS NOT NULL"))
    op.rename_table("daily_note_pages", "daily_page_bindings")
    op.execute(
        """
        ALTER TABLE daily_page_bindings
        RENAME CONSTRAINT daily_note_pages_pkey
        TO daily_page_bindings_pkey
        """
    )
    op.execute(
        """
        ALTER TABLE daily_page_bindings
        RENAME CONSTRAINT daily_note_pages_user_id_fkey
        TO daily_page_bindings_user_id_fkey
        """
    )
    op.execute(
        """
        ALTER TABLE daily_page_bindings
        RENAME CONSTRAINT daily_note_pages_page_id_fkey
        TO daily_page_bindings_page_id_fkey
        """
    )
    op.execute(
        """
        ALTER TABLE daily_page_bindings
        RENAME CONSTRAINT uix_daily_note_pages_user_date
        TO uq_daily_page_bindings_user_date
        """
    )
    op.execute(
        """
        ALTER TABLE daily_page_bindings
        RENAME CONSTRAINT uix_daily_note_pages_user_page
        TO uq_daily_page_bindings_user_page
        """
    )
    op.drop_constraint(
        "ck_daily_note_pages_time_zone_length",
        "daily_page_bindings",
        type_="check",
    )
    op.drop_column("daily_page_bindings", "time_zone")
    op.drop_column("daily_page_bindings", "updated_at")
    op.drop_column("daily_page_bindings", "deleted_at")


def downgrade() -> None:
    raise RuntimeError("Hard cutover: 0205 is not reversible")
