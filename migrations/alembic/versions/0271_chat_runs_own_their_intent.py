"""Chat runs own their frozen intent; chat rows cascade from their messages.

Revision ID: 0271
Revises: 0270

Writers are stopped for this cutover. In order:

1. ``chat_prompt_assemblies`` was a 1:1 mirror of ``chat_runs`` holding one jsonb: its
   ``generation_intent`` moves onto the run and the table goes (refuses if any run has
   no assembly; every run since 0246 has one);
2. ``chat_run_turn_contexts`` goes: it was written only for quote turns, whose prompt
   reads the user turn's snapshot, and nothing read it;
3. the frames no reader ever consumed (``meta``, ``assistant_activity``,
   ``citation_index``) and the never-written ``tool_call_delta`` are deleted, leaving
   seq gaps in historical logs (readers use ``seq > after``), and the type CHECK
   narrows to the six live types;
4. eight foreign keys rebuild with ``ON DELETE CASCADE``, so deleting a message or a
   conversation takes its runs, events, tool calls and retrievals, as the hand-ordered
   deletes did; ``messages.parent_message_id`` and ``chat_runs.owner_user_id`` keep
   NO ACTION;
5. the two ``chat_runs`` columns those cascades scan get an index;
6. ``message_retrievals.snippet_prefix``/``snippet_suffix`` go (never written).

Production at 0241 crosses 0246 in the same upgrade, which deletes every run, event,
assembly, tool call and retrieval first, so steps 1-3 and 6 touch no rows there.
Irreversible: the release's pre-migration backup is the only copy of the dropped
tables and frames.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0271"
down_revision: str | Sequence[str] | None = "0270"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_CASCADES = (
    ("chat_runs", "user_message_id", "messages"),
    ("chat_runs", "assistant_message_id", "messages"),
    ("chat_runs", "conversation_id", "conversations"),
    ("chat_run_events", "run_id", "chat_runs"),
    ("message_tool_calls", "conversation_id", "conversations"),
    ("message_tool_calls", "user_message_id", "messages"),
    ("message_tool_calls", "assistant_message_id", "messages"),
    ("message_retrievals", "tool_call_id", "message_tool_calls"),
)


def upgrade() -> None:
    op.execute("""
        ALTER TABLE chat_runs ADD COLUMN generation_intent jsonb;
        UPDATE chat_runs r SET generation_intent = a.generation_intent
        FROM chat_prompt_assemblies a WHERE a.chat_run_id = r.id;
        DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM chat_runs WHERE generation_intent IS NULL) THEN
                RAISE EXCEPTION '0271: a chat run has no prompt assembly to move';
            END IF;
        END $$;
        ALTER TABLE chat_runs ALTER COLUMN generation_intent SET NOT NULL;
        DROP TABLE chat_prompt_assemblies;
        DROP TABLE chat_run_turn_contexts;
    """)
    op.execute("""
        DELETE FROM chat_run_events
        WHERE event_type IN ('meta', 'assistant_activity', 'citation_index', 'tool_call_delta');
        ALTER TABLE chat_run_events DROP CONSTRAINT ck_chat_run_events_event_type,
            ADD CONSTRAINT ck_chat_run_events_event_type CHECK (event_type IN (
                'assistant_text_delta', 'tool_call_start', 'tool_call_done', 'tool_result',
                'context_ref_added', 'done'));
    """)
    for table, column, parent in _CASCADES:
        name = f"{table}_{column}_fkey"
        op.execute(f"""
            ALTER TABLE {table} DROP CONSTRAINT {name},
                ADD CONSTRAINT {name} FOREIGN KEY ({column})
                REFERENCES {parent}(id) ON DELETE CASCADE
        """)
    op.execute("""
        CREATE INDEX ix_chat_runs_user_message ON chat_runs (user_message_id);
        CREATE INDEX ix_chat_runs_conversation ON chat_runs (conversation_id);
        ALTER TABLE message_retrievals DROP COLUMN snippet_prefix, DROP COLUMN snippet_suffix;
    """)


def downgrade() -> None:
    raise NotImplementedError("0271 is an irreversible schema deletion")
