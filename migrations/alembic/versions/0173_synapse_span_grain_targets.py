"""Synapse span-grain targets: widen ck_resource_edges_synapse_shape.

The resonance engine can now write ``origin='synapse'`` edges targeting an
``evidence_span`` (passage grain), not only ``media``/``note_block`` (object
grain). One CHECK widen; no new table, column, or origin.

Revision ID: 0173
Revises: 0172
Create Date: 2026-07-08
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0173"
down_revision: str | Sequence[str] | None = "0172"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_synapse_shape")
    op.execute("""
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_synapse_shape CHECK (
            origin != 'synapse'
            OR (
                source_scheme IN ('media', 'page', 'note_block', 'highlight')
                AND target_scheme IN ('media', 'note_block', 'evidence_span')
                AND source_order_key IS NULL
                AND target_order_key IS NULL
                AND ordinal IS NULL
            )
        )
    """)


def downgrade() -> None:
    # Data-dependent downgrade (mirrors 0149): span-grain synapse edges cannot
    # satisfy the narrowed two-scheme target set, so they must be deleted before
    # the constraint is restored.
    op.execute(
        "DELETE FROM resource_edges"
        " WHERE origin = 'synapse' AND target_scheme = 'evidence_span'"
    )
    op.execute("ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_synapse_shape")
    op.execute("""
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_synapse_shape CHECK (
            origin != 'synapse'
            OR (
                source_scheme IN ('media', 'page', 'note_block', 'highlight')
                AND target_scheme IN ('media', 'note_block')
                AND source_order_key IS NULL
                AND target_order_key IS NULL
                AND ordinal IS NULL
            )
        )
    """)
