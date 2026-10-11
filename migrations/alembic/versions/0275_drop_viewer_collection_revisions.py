"""Drop viewer collection revisions.

Revision ID: 0275
Revises: 0274

List continuations are keyset cursors bound to their viewer, scope and view
(services/collection_keyset.py); nothing reads or writes per-viewer collection
revisions. Drops viewer_collection_revisions with its rows (counters with no other
meaning: at most six per user; no table references it). Irreversible: the release's
pre-migration backup is the only copy.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0275"
down_revision: str | Sequence[str] | None = "0274"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_table("viewer_collection_revisions")


def downgrade() -> None:
    raise NotImplementedError("0275 is an irreversible schema deletion")
