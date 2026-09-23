"""Upload sessions carry their input origin; media records browser-capture
identity; one media may hold several completed capture receipts; every
pre-cutover extension credential is revoked so old builds must reconnect.

Revision ID: 0241
Revises: 0240
Create Date: 2026-09-23
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0241"
down_revision: str | Sequence[str] | None = "0240"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("media_upload_sessions", sa.Column("input_origin", JSONB, nullable=True))
    op.execute("""UPDATE media_upload_sessions SET input_origin = '{"kind":"LocalFile"}'::jsonb""")
    op.alter_column("media_upload_sessions", "input_origin", nullable=False)
    op.drop_constraint(
        "uq_media_upload_sessions_published_media", "media_upload_sessions", type_="unique"
    )
    op.drop_constraint(
        "uq_media_upload_sessions_published_source_attempt",
        "media_upload_sessions",
        type_="unique",
    )
    op.create_index(
        "ix_media_upload_sessions_published_media", "media_upload_sessions", ["published_media_id"]
    )
    op.add_column("media", sa.Column("browser_capture_sha256", sa.Text(), nullable=True))
    op.create_index(
        "ix_media_browser_capture",
        "media",
        ["created_by_user_id", "kind", "browser_capture_sha256"],
        postgresql_where=sa.text("browser_capture_sha256 IS NOT NULL"),
    )
    op.execute("UPDATE extension_sessions SET revoked_at = now() WHERE revoked_at IS NULL")


def downgrade() -> None:
    raise NotImplementedError("0241 is an irreversible cutover")
