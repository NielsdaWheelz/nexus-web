"""Amanuensis: the assistant edge origin + per-tool-call undo state.

Adds the ``assistant`` edge origin (the house agent's hand) to the
``resource_edges`` origin/snapshot CHECKs — a widened copy of the synapse shape
(adds ``page`` and ``highlight`` endpoints, keeps the mandatory rationale
snapshot, no ordinal). Five CHECK changes: three widened enumerations, two new
assistant-shape guards. Plus ``message_tool_calls.reverted_at`` for the undo
lifecycle (amanuensis §5.6). Additive only — no data migration, no backfill.

Revision ID: 0176
Revises: 0175
Create Date: 2026-07-10
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0176"
down_revision: str | Sequence[str] | None = "0175"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 5.1 widen the origin enum
    op.execute("ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_origin")
    op.execute(
        """
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_origin CHECK (
            origin IN (
                'user', 'citation', 'system', 'note_body', 'highlight_note',
                'synapse', 'document_embed', 'assistant'
            )
        )
        """
    )

    # 5.2 widen snapshot-origin
    op.execute("ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_snapshot_origin")
    op.execute(
        """
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_snapshot_origin CHECK (
            snapshot IS NULL OR origin IN ('citation', 'synapse', 'assistant')
        )
        """
    )

    # 5.3 widen snapshot-has-ordinal (bare rationale snapshots for synapse + assistant)
    op.execute("ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_snapshot_has_ordinal")
    op.execute(
        """
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_snapshot_has_ordinal CHECK (
            snapshot IS NULL OR ordinal IS NOT NULL OR origin IN ('synapse', 'assistant')
        )
        """
    )

    # 5.4 new: assistant snapshot must carry a non-empty excerpt rationale
    op.execute(
        """
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_assistant_snapshot_excerpt
        CHECK (
            origin != 'assistant'
            OR (
                snapshot IS NOT NULL
                AND snapshot ? 'excerpt'
                AND jsonb_typeof(snapshot->'excerpt') = 'string'
                AND btrim(snapshot->>'excerpt') <> ''
            )
        )
        """
    )

    # 5.5 new: assistant edges are bare, restricted to the library graph endpoints
    op.execute(
        """
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_assistant_shape CHECK (
            origin != 'assistant'
            OR (
                source_scheme IN ('media', 'page', 'note_block', 'highlight')
                AND target_scheme IN ('media', 'page', 'note_block', 'highlight')
                AND source_order_key IS NULL
                AND target_order_key IS NULL
                AND ordinal IS NULL
            )
        )
        """
    )

    # 5.6 undo lifecycle column
    op.execute("ALTER TABLE message_tool_calls ADD COLUMN reverted_at timestamptz NULL")


def downgrade() -> None:
    op.execute("ALTER TABLE message_tool_calls DROP COLUMN reverted_at")

    op.execute("ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_assistant_shape")
    op.execute(
        "ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_assistant_snapshot_excerpt"
    )

    op.execute("ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_snapshot_has_ordinal")
    op.execute(
        """
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_snapshot_has_ordinal CHECK (
            snapshot IS NULL OR ordinal IS NOT NULL OR origin = 'synapse'
        )
        """
    )

    op.execute("ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_snapshot_origin")
    op.execute(
        """
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_snapshot_origin CHECK (
            snapshot IS NULL OR origin IN ('citation', 'synapse')
        )
        """
    )

    op.execute("ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_origin")
    op.execute(
        """
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_origin CHECK (
            origin IN (
                'user', 'citation', 'system', 'note_body', 'highlight_note',
                'synapse', 'document_embed'
            )
        )
        """
    )
