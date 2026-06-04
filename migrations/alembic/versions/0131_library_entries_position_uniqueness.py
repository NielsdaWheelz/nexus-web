"""library_entries: deferrable position uniqueness + non-cascading FKs

Revision ID: 0131
Revises: 0130
Create Date: 2026-06-03

Library-entries ownership hard cutover, Slice 7. `library_entries.py` is now the sole
writer of the table and the single owner of the position total order. This migration
makes the per-library position a DB invariant and removes the FK cascades the app no
longer relies on:

- A one-time renormalize-all densifies every library's positions to 0..n-1 by the
  canonical order, clearing any legacy duplicate positions left by older paths.
- UNIQUE (library_id, position) DEFERRABLE INITIALLY DEFERRED makes a second/colliding
  position unrepresentable. DEFERRABLE so the renormalizer and the unnest reorder — both
  whole-set permutations — validate at COMMIT rather than mid-statement. It is safe
  because `library_entries.ensure_entry` serializes appends per library with a library-row
  lock (Key Decision 6/8).
- The redundant non-unique ix_library_entries_library_position is dropped; the unique
  constraint's index serves the same (library_id, position) lookups, and
  ix_library_entries_library_order remains for ordered reads.
- The media_id/podcast_id ON DELETE CASCADE FKs (and the library_id ORM/DDL mismatch from
  0047) are recreated non-cascading. Cleanup is explicit in application code
  (database.md), and after the entry/closure/media-deletion cutover every delete path
  removes entries explicitly.
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0131"
down_revision: str | Sequence[str] | None = "0130"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        WITH ordered AS (
            SELECT id, ROW_NUMBER() OVER (
                PARTITION BY library_id ORDER BY position ASC, created_at DESC, id DESC
            ) - 1 AS new_position
            FROM library_entries
        )
        UPDATE library_entries le
        SET position = ordered.new_position
        FROM ordered
        WHERE le.id = ordered.id AND le.position <> ordered.new_position
    """)

    op.execute(
        "ALTER TABLE library_entries "
        "ADD CONSTRAINT uq_library_entries_library_position "
        "UNIQUE (library_id, position) DEFERRABLE INITIALLY DEFERRED"
    )

    op.drop_index("ix_library_entries_library_position", table_name="library_entries")

    op.drop_constraint("library_entries_media_id_fkey", "library_entries", type_="foreignkey")
    op.drop_constraint("library_entries_podcast_id_fkey", "library_entries", type_="foreignkey")
    op.drop_constraint("library_entries_library_id_fkey", "library_entries", type_="foreignkey")
    op.create_foreign_key(
        "library_entries_media_id_fkey", "library_entries", "media", ["media_id"], ["id"]
    )
    op.create_foreign_key(
        "library_entries_podcast_id_fkey", "library_entries", "podcasts", ["podcast_id"], ["id"]
    )
    op.create_foreign_key(
        "library_entries_library_id_fkey", "library_entries", "libraries", ["library_id"], ["id"]
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0131 is not reversible")
