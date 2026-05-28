"""Backfill conversation_pinned_sources for existing singleton conversations.

resolve_singleton_conversation now auto-pins the singleton target on
creation (PR 5 of the chat tool-calling spec). Singletons created
before that code shipped have no pin, so the model has nothing to
cite as [N]. Backfill one pin (kind, target_id, title) per pre-existing
singleton conversation that has no matching pin.

Revision ID: 0120
Revises: 0119
Create Date: 2026-05-28
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0120"
down_revision: str | None = "0119"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO conversation_pinned_sources
            (conversation_id, ordinal, kind, target_id, title)
        SELECT
            cs.conversation_id,
            1,
            cs.kind,
            cs.target_id,
            COALESCE(
                CASE WHEN cs.kind = 'media' THEN m.title END,
                CASE WHEN cs.kind = 'library' THEN l.name END,
                'Source'
            )
        FROM chat_singletons cs
        LEFT JOIN media m ON cs.kind = 'media' AND m.id = cs.target_id
        LEFT JOIN libraries l ON cs.kind = 'library' AND l.id = cs.target_id
        WHERE NOT EXISTS (
            SELECT 1 FROM conversation_pinned_sources cps
            WHERE cps.conversation_id = cs.conversation_id
              AND cps.kind = cs.kind
              AND cps.target_id = cs.target_id
        )
        """
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0120 is not reversible")
