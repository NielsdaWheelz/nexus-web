"""The conversation owns its active leaf; a user turn owns its fork title.

Revision ID: 0261
Revises: 0260

conversation_active_paths folds into conversations.active_leaf_message_id (the
owner's row; ON DELETE SET NULL, so a deleted leaf falls back to the newest
message); conversation_branches folds into messages.fork_title (titled rows only:
an untitled branch row carries no data); messages.message_document goes (it is
derived from role and content, and the API now ships content), and so does
messages.branch_root_message_id (written, never read; it repeats the user turn's
parent).

upgrade() refuses, before any change, on rows the new shape cannot hold: a stored
document other than the one derived from (role, content), and a branch title on
a non-user message. Fix the rows (or this file) and retry.

What it loses, read-only (the owner's loss count):
    -- active paths of viewers other than the owner (chats are owner-only: expect 0)
    SELECT count(*) FROM conversation_active_paths p JOIN conversations c
      ON c.id = p.conversation_id WHERE p.viewer_user_id <> c.owner_user_id;
Plus every untitled branch row, every derived message_document and every
branch_root_message_id. Irreversible: the release's backup is the only copy.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0261"
down_revision: str | Sequence[str] | None = "0260"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PREFLIGHT = """
WITH bad AS (
    SELECT 'message_document not derived from role and content' AS what, m.id
    FROM messages m
    WHERE m.message_document <> jsonb_build_object(
        'type', 'message_document',
        'blocks', CASE WHEN m.content ~ '^[[:space:]]*$' THEN '[]'::jsonb
            ELSE jsonb_build_array(jsonb_build_object(
                'type', 'text',
                'format', CASE WHEN m.role = 'assistant' THEN 'markdown' ELSE 'plain' END,
                'text', m.content)) END)
    UNION ALL
    SELECT 'branch title on a non-user message', b.id
    FROM conversation_branches b JOIN messages m ON m.id = b.branch_user_message_id
    WHERE b.title IS NOT NULL AND m.role <> 'user'
)
SELECT what, count(*), (array_agg(id ORDER BY id))[1:10] FROM bad GROUP BY what ORDER BY what
"""

_UPGRADE = """
ALTER TABLE messages ADD COLUMN fork_title text,
    ADD CONSTRAINT ck_messages_fork_title CHECK (fork_title IS NULL
        OR (role = 'user' AND char_length(btrim(fork_title)) BETWEEN 1 AND 120));
UPDATE messages m SET fork_title = b.title FROM conversation_branches b
WHERE b.branch_user_message_id = m.id AND b.title IS NOT NULL;
DROP TABLE conversation_branches;

ALTER TABLE conversations ADD COLUMN active_leaf_message_id uuid,
    ADD CONSTRAINT conversations_active_leaf_message_id_fkey
        FOREIGN KEY (active_leaf_message_id) REFERENCES messages(id) ON DELETE SET NULL;
CREATE INDEX ix_conversations_active_leaf_message_id ON conversations (active_leaf_message_id)
    WHERE active_leaf_message_id IS NOT NULL;
UPDATE conversations c SET active_leaf_message_id = p.active_leaf_message_id
FROM conversation_active_paths p
WHERE p.conversation_id = c.id AND p.viewer_user_id = c.owner_user_id;
DROP TABLE conversation_active_paths;

ALTER TABLE messages DROP COLUMN message_document, DROP COLUMN branch_root_message_id;
"""


def upgrade() -> None:
    blocked = op.get_bind().execute(sa.text(_PREFLIGHT)).all()
    if blocked:
        raise RuntimeError(
            "0261 blocked: "
            + "; ".join(
                f"{what}: {count} rows, sample ids {', '.join(str(row_id) for row_id in ids)}"
                for what, count, ids in blocked
            )
        )
    # Multi-statement SQL goes straight to the DBAPI cursor, as 0236 does.
    with op.get_bind().connection.cursor() as cursor:
        cursor.execute(_UPGRADE)


def downgrade() -> None:
    raise NotImplementedError("0261 requires restoring the previous application and database")
