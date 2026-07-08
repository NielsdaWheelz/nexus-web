"""Library entry page snapshots.

Revision ID: 0170
Revises: 0169
Create Date: 2026-07-07
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0170"
down_revision: str | Sequence[str] | None = "0169"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE library_entry_page_snapshots (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            viewer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
            sort text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            expires_at timestamptz NOT NULL
        )
    """)
    op.execute("""
        CREATE TABLE library_entry_page_snapshot_items (
            snapshot_id uuid NOT NULL REFERENCES library_entry_page_snapshots(id) ON DELETE CASCADE,
            ordinal integer NOT NULL,
            entry_id uuid NOT NULL,
            PRIMARY KEY (snapshot_id, ordinal),
            CONSTRAINT uq_library_entry_page_snapshot_items_entry UNIQUE (snapshot_id, entry_id)
        )
    """)
    op.create_index(
        "ix_library_entry_page_snapshots_expires_at",
        "library_entry_page_snapshots",
        ["expires_at"],
    )
    op.create_index(
        "ix_library_entry_page_snapshots_scope",
        "library_entry_page_snapshots",
        ["viewer_user_id", "library_id", "sort", "created_at"],
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0170 is not reversible")
