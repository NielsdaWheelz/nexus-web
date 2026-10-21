"""Retain authored identity bindings and media annotation generations.

Revision ID: 0303
Revises: 0302

Data effects: backfill every live page, note, highlight, user link and annotation
attachment. Link bindings retain stored source orientation. Already deleted ids
cannot be recovered. Refuse inconsistent attachment owners rather than choose a
new author. Writers must stop for this hard protocol cutover.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0303"
down_revision: str | Sequence[str] | None = "0302"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    inconsistent = op.get_bind().scalar(
        sa.text("""
        SELECT count(*) FROM resource_edges e
        LEFT JOIN note_blocks n ON n.id = CASE WHEN e.origin = 'highlight_note'
            THEN e.target_id ELSE e.source_id END
        LEFT JOIN highlights h ON e.origin = 'highlight_note' AND h.id = e.source_id
        WHERE e.origin IN ('highlight_note', 'link_note') AND (
            n.id IS NULL OR n.user_id <> e.user_id OR
            (e.origin = 'highlight_note' AND (h.id IS NULL OR h.user_id <> e.user_id OR
                e.source_scheme <> 'highlight' OR e.target_scheme <> 'note_block')) OR
            (e.origin = 'link_note' AND e.source_scheme <> 'note_block'))
    """)
    )
    if inconsistent:
        raise RuntimeError(
            f"0303 cannot convert {inconsistent} inconsistent authored attachments"
        )
    op.execute("""
        CREATE TABLE authored_identities (
            id uuid PRIMARY KEY,
            user_id uuid NOT NULL REFERENCES users(id),
            kind text NOT NULL,
            resource_id uuid NOT NULL,
            canonical_identity_id uuid REFERENCES authored_identities(id),
            source_ref text,
            created_at timestamptz NOT NULL DEFAULT now(),
            retired_at timestamptz,
            CONSTRAINT uq_authored_identities_kind_resource UNIQUE (kind, resource_id)
        )
    """)
    for table, kind in (
        ("pages", "page"),
        ("note_blocks", "note_block"),
        ("highlights", "highlight"),
    ):
        op.execute(
            sa.text(f"""
            INSERT INTO authored_identities(id,user_id,kind,resource_id,created_at)
            SELECT gen_random_uuid(),user_id,:kind,id,created_at FROM {table}
        """).bindparams(kind=kind)
        )
    op.execute("""
        INSERT INTO authored_identities(id,user_id,kind,resource_id,source_ref,created_at)
        SELECT gen_random_uuid(),user_id,'link',id,source_scheme || ':' || source_id::text,created_at
        FROM resource_edges WHERE origin IN ('user','highlight_note','link_note')
    """)
    op.create_index("ix_authored_identities_user", "authored_identities", ["user_id"])
    op.drop_constraint("ck_resource_versions_lane", "resource_versions", type_="check")


def downgrade() -> None:
    raise NotImplementedError("0303 is irreversible; restore the pre-release backup")
