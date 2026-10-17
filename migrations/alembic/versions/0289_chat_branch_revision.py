"""Materialize chat leaves and initialize conditional branch revisions.

Revision ID: 0289
Revises: 0288

Every conversation gains branch_revision=0. A null stored leaf becomes the same
newest message (seq/id) today's read fallback selects; empty chats keep null.
Messages, runs, selections and all existing nonnull leaves are retained. Refuse
orphaned/cross-conversation parents, cycles, or a foreign/nonleaf effective leaf.
Writers must be stopped so validation and materialization share one graph.
"""

from alembic import op
import sqlalchemy as sa

revision = "0289"
down_revision = "0288"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    invalid_message = bind.scalar(
        sa.text(
            """
            SELECT m.id FROM messages m
            LEFT JOIN conversations c ON c.id = m.conversation_id
            LEFT JOIN messages p ON p.id = m.parent_message_id
            WHERE c.id IS NULL OR (m.parent_message_id IS NOT NULL AND (
                p.id IS NULL OR m.conversation_id <> p.conversation_id
            )) LIMIT 1
            """
        )
    )
    if invalid_message is not None:
        raise RuntimeError(f"0289 refuses an orphaned/foreign message parent: {invalid_message}")
    unrooted = bind.scalar(
        sa.text(
            """
            WITH RECURSIVE rooted AS (
                SELECT id FROM messages WHERE parent_message_id IS NULL
                UNION ALL
                SELECT m.id FROM messages m JOIN rooted p ON p.id = m.parent_message_id
            )
            SELECT m.id FROM messages m LEFT JOIN rooted r ON r.id = m.id
            WHERE r.id IS NULL LIMIT 1
            """
        )
    )
    if unrooted is not None:
        raise RuntimeError(f"0289 refuses an unrooted/cyclic message graph: {unrooted}")
    invalid_leaf = bind.scalar(
        sa.text(
            """
            SELECT c.id FROM conversations c
            CROSS JOIN LATERAL (
                SELECT COALESCE(c.active_leaf_message_id, (
                    SELECT m.id FROM messages m WHERE m.conversation_id = c.id
                    ORDER BY m.seq DESC, m.id DESC LIMIT 1
                )) AS id
            ) leaf
            LEFT JOIN messages selected ON selected.id = leaf.id
            WHERE leaf.id IS NOT NULL AND (
                selected.id IS NULL OR selected.conversation_id <> c.id
                OR EXISTS (SELECT 1 FROM messages child WHERE child.parent_message_id = leaf.id)
            ) LIMIT 1
            """
        )
    )
    if invalid_leaf is not None:
        raise RuntimeError(f"0289 refuses an invalid effective conversation leaf: {invalid_leaf}")
    op.add_column(
        "conversations",
        sa.Column("branch_revision", sa.Integer(), nullable=False, server_default="0"),
    )
    op.execute(
        """
        UPDATE conversations c SET active_leaf_message_id = (
            SELECT m.id FROM messages m WHERE m.conversation_id = c.id
            ORDER BY m.seq DESC, m.id DESC LIMIT 1
        ) WHERE c.active_leaf_message_id IS NULL
        """
    )


def downgrade() -> None:
    raise NotImplementedError("0289 is irreversible; restore the pre-release backup")
