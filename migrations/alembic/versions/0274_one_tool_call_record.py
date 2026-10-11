"""One row per model tool call.

Revision ID: 0274
Revises: 0273

``tool_calls`` replaces ``llm_tool_positions``, ``message_tool_calls``,
``generation_effect_receipts`` and ``assistant_write_authorships``. A row's id is the
old position id (the effect id note/highlight sub-ids and memory submissions derive
from), so authorship, undo and deep links keep their identity. Writers are stopped.

1. every write receipt (including those 0246 preserved after deleting their positions)
   becomes a row: ``complete`` or ``error`` by its result, with its position's arguments
   and its chat answer when they survive;
2. every other chat position becomes a row with its chat row's status (``pending`` ->
   ``running``) and its conversation owner as principal; background read positions,
   which nothing reads, are dropped;
3. a gate refuses a tool id or created ref the contract does not know;
4. ``message_retrievals`` hang off their answer (``assistant_message_id``) and point at
   their call's row; the index-0 "attached context" pseudo calls are dropped and their
   retrievals keep ``tool_call_id`` null;
5. the four tables go, with the receipt owner and completion times, the chat rows' audit
   columns, scopes, error codes, record kinds, wire names, digests and revisions (no
   reader).

Production at 0241 crosses 0246 in the same upgrade, which deletes every position, chat
tool row and retrieval and preserves write receipts: there only step 1 moves rows.
Irreversible: the release's pre-migration backup is the only copy of the old tables.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0274"
down_revision: str | Sequence[str] | None = "0273"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE tool_calls (
            id uuid PRIMARY KEY,
            generation_id uuid NOT NULL,
            generation_seq integer NOT NULL CHECK (generation_seq >= 1),
            position integer NOT NULL CHECK (position >= 1),
            principal_user_id uuid NOT NULL REFERENCES users(id),
            assistant_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
            tool_id text NOT NULL CHECK (char_length(tool_id) BETWEEN 1 AND 128),
            arguments jsonb,
            result jsonb,
            created_refs jsonb NOT NULL DEFAULT '[]'
                CHECK (jsonb_typeof(created_refs) = 'array'),
            status text NOT NULL CHECK (status IN ('running', 'complete', 'error', 'cancelled')),
            created_at timestamptz NOT NULL DEFAULT now(),
            reverted_at timestamptz,
            CONSTRAINT uq_tool_calls_generation_position UNIQUE (generation_id, position)
        );

        INSERT INTO tool_calls (id, generation_id, generation_seq, position, principal_user_id,
            assistant_message_id, tool_id, arguments, result, created_refs, status,
            created_at, reverted_at)
        SELECT g.id, g.generation_id, g.generation_seq, g.tool_position, g.principal_user_id,
            m.assistant_message_id, g.canonical_tool_id, p.arguments -> 'value',
            g.result_evidence -> 'tool_result', g.result_evidence -> 'created_refs',
            CASE WHEN g.result_evidence #>> '{tool_result,type}' = 'Success'
                THEN 'complete' ELSE 'error' END,
            g.created_at, g.reverted_at
        FROM generation_effect_receipts g
        LEFT JOIN llm_tool_positions p ON p.id = g.id
        LEFT JOIN message_tool_calls m ON m.tool_position_id = g.id;

        INSERT INTO tool_calls (id, generation_id, generation_seq, position, principal_user_id,
            assistant_message_id, tool_id, arguments, result, created_refs, status,
            created_at, reverted_at)
        SELECT p.id, p.generation_id, c.generation_seq, p.position, v.owner_user_id,
            m.assistant_message_id, p.canonical_tool_id, p.arguments -> 'value',
            p.result_evidence -> 'tool_result',
            COALESCE(p.result_evidence -> 'created_refs', '[]'),
            CASE m.status WHEN 'pending' THEN 'running' ELSE m.status END,
            p.created_at, p.reverted_at
        FROM llm_tool_positions p
        JOIN message_tool_calls m ON m.tool_position_id = p.id
        JOIN conversations v ON v.id = m.conversation_id
        JOIN llm_calls c ON c.id = p.generation_id
        WHERE NOT EXISTS (SELECT 1 FROM tool_calls t WHERE t.id = p.id);

        DO $$ BEGIN
            IF EXISTS (
                SELECT 1 FROM tool_calls WHERE tool_id <> ALL (ARRAY[
                    'web.search', 'web.read', 'nexus.search', 'nexus.resource.read',
                    'nexus.document.search', 'nexus.resource.inspect', 'nexus.relations.list',
                    'nexus.library.add', 'nexus.note.create', 'nexus.highlight.create',
                    'nexus.edge.create', 'nexus.queue.add', 'memory.search', 'memory.open',
                    'memory.view', 'memory.zoom', 'memory.date', 'memory.save_note'])
            ) OR EXISTS (
                SELECT 1 FROM tool_calls t, jsonb_array_elements(t.created_refs) ref
                WHERE COALESCE(ref ->> 'kind', '') NOT IN
                        ('entry', 'note_block', 'highlight', 'edge', 'queue')
                    OR COALESCE(jsonb_typeof(ref -> 'id'), '') <> 'string'
                    OR COALESCE(jsonb_typeof(ref -> 'label'), '') <> 'string'
            ) THEN
                RAISE EXCEPTION '0274: a tool call or created ref the contract does not know';
            END IF;
        END $$;

        CREATE INDEX ix_tool_calls_answer ON tool_calls (assistant_message_id, position)
            WHERE assistant_message_id IS NOT NULL;
        CREATE INDEX ix_tool_calls_principal
            ON tool_calls (principal_user_id, created_at DESC, id DESC);
        CREATE INDEX ix_tool_calls_created_refs
            ON tool_calls USING gin (created_refs jsonb_path_ops);

        ALTER TABLE message_retrievals
            DROP CONSTRAINT message_retrievals_tool_call_id_fkey,
            ALTER COLUMN tool_call_id DROP NOT NULL,
            ADD COLUMN assistant_message_id uuid REFERENCES messages(id) ON DELETE CASCADE;
        UPDATE message_retrievals r
        SET assistant_message_id = m.assistant_message_id, tool_call_id = m.tool_position_id
        FROM message_tool_calls m WHERE m.id = r.tool_call_id;
        ALTER TABLE message_retrievals
            ALTER COLUMN assistant_message_id SET NOT NULL,
            ADD CONSTRAINT message_retrievals_tool_call_id_fkey
                FOREIGN KEY (tool_call_id) REFERENCES tool_calls(id);
        CREATE INDEX ix_message_retrievals_answer ON message_retrievals (assistant_message_id);
        CREATE UNIQUE INDEX uix_message_retrievals_attached_ordinal
            ON message_retrievals (assistant_message_id, ordinal) WHERE tool_call_id IS NULL;

        DROP TABLE message_tool_calls, assistant_write_authorships, generation_effect_receipts,
            llm_tool_positions;
    """)


def downgrade() -> None:
    raise NotImplementedError("0274 is irreversible; restore the release backup")
