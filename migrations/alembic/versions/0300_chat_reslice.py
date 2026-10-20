"""Chat re-slice: one start frame per tool call, no write-only retrieval columns, and a
refusal of every stored shape the rewritten readers cannot read.

Revision ID: 0300
Revises: 0299

Writers stopped (release runbook). Irreversible: the pre-release backup is the rollback.
Data effects: ``tool_call_done`` frames are deleted (each repeats its call's
``tool_call_start``; replay reads ``seq > after``, so the gaps are harmless); stored
``done`` frames lose ``usage`` (replay emits them as stored; the llm ledger keeps usage);
eight ``message_retrievals`` columns nothing reads are dropped, with their CHECKs (their
facts stay in ``result_ref`` and ``captured_evidence``). Frozen prompts are kept. Nothing
a reader shows changes.
"""

from collections.abc import Sequence

from alembic import op
from sqlalchemy import text

revision: str = "0300"
down_revision: str | Sequence[str] | None = "0299"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_KEYS = "ARRAY(SELECT jsonb_object_keys(m.branch_anchor))"
_SELECTION = "ARRAY['client_selection_id','exact','message_id','offset_status','prefix','suffix']"
_ID = "m.branch_anchor->>'message_id' ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'"


def _text(key: str, low: int, high: int, null: bool = False) -> str:
    """The anchor's string value within the wire model's length bounds."""
    kinds = "('string', 'null')" if null else "('string')"
    return (
        f"jsonb_typeof(m.branch_anchor->'{key}') IN {kinds}"
        f" AND coalesce(length(m.branch_anchor->>'{key}'), {low}) BETWEEN {low} AND {high}"
    )


# reason -> a query counting the rows that have it; any nonzero count refuses.
_REFUSALS = {
    "assistant message without its run (the trail reads run and context as present)": """
        SELECT count(*) FROM messages m
        WHERE m.role = 'assistant'
          AND NOT EXISTS (SELECT 1 FROM chat_runs r WHERE r.assistant_message_id = m.id)""",
    "tool frame without its tool_calls row (stream replay joins by answer and position)": """
        SELECT count(*) FROM chat_run_events e JOIN chat_runs r ON r.id = e.run_id
        WHERE e.event_type IN ('tool_call_start', 'tool_result')
          AND NOT EXISTS (SELECT 1 FROM tool_calls t
                          WHERE t.assistant_message_id = r.assistant_message_id
                            AND t.position = CAST(e.payload->>'tool_call_index' AS int))""",
    "live run without its chat_run job (every tree read projects the job)": """
        SELECT count(*) FROM chat_runs r
        WHERE r.status NOT IN ('complete', 'error', 'cancelled')
          AND NOT EXISTS (SELECT 1 FROM background_jobs j
                          WHERE j.dedupe_key = 'chat_run:' || CAST(r.id AS text))""",
    "stored leaf that is not a childless message of its chat, or a missing one": """
        SELECT count(*) FROM conversations c
        WHERE (c.active_leaf_message_id IS NULL) <> NOT EXISTS
                (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
           OR (c.active_leaf_message_id IS NOT NULL AND NOT EXISTS
                (SELECT 1 FROM messages m WHERE m.id = c.active_leaf_message_id
                                            AND m.conversation_id = c.id))
           OR EXISTS (SELECT 1 FROM messages ch
                      WHERE ch.parent_message_id = c.active_leaf_message_id)""",
    "branch anchor outside the typed union (its keys and values)": f"""
        SELECT count(*) FROM messages m
        WHERE NOT coalesce(CASE m.branch_anchor_kind
            WHEN 'none' THEN m.branch_anchor = '{{}}'::jsonb
            WHEN 'assistant_message' THEN {_KEYS} = ARRAY['message_id'] AND {_ID}
            WHEN 'assistant_selection' THEN {_KEYS} <@ {_SELECTION} AND {_KEYS} @> {_SELECTION}
                AND {_ID} AND m.branch_anchor->>'offset_status' = 'unmapped'
                AND {_text("exact", 1, 20000)} AND m.branch_anchor->>'exact' ~ '\\S'
                AND {_text("prefix", 0, 1000, null=True)} AND {_text("suffix", 0, 1000, null=True)}
                AND {_text("client_selection_id", 1, 128)}
            ELSE false END, false)""",
    "retrieval with no resource identity (neither citation target nor captured owner)": """
        SELECT count(*) FROM message_retrievals
        WHERE result_ref->>'citation_target' IS NULL
          AND captured_evidence->'target'->>'owner_ref' IS NULL""",
}


def upgrade() -> None:
    conn = op.get_bind()
    found = {reason: conn.execute(text(sql)).scalar_one() for reason, sql in _REFUSALS.items()}
    refused = [f"{count} x {reason}" for reason, count in found.items() if count]
    if refused:
        raise RuntimeError(
            "0300 refuses stored chat rows it cannot convert:\n" + "\n".join(refused)
        )
    op.execute("DELETE FROM chat_run_events WHERE event_type = 'tool_call_done'")
    op.execute("UPDATE chat_run_events SET payload = payload - 'usage' WHERE event_type = 'done'")
    op.execute(
        """
        ALTER TABLE chat_run_events DROP CONSTRAINT ck_chat_run_events_event_type,
            ADD CONSTRAINT ck_chat_run_events_event_type CHECK (event_type IN (
                'assistant_text_delta', 'tool_call_start', 'tool_result',
                'context_ref_added', 'done'))
        """
    )
    for column in (
        "source_title",
        "section_label",
        "exact_snippet",
        "deep_link",
        "score",
        "scope",
        "retrieval_status",
        "included_in_prompt",
    ):
        op.drop_column("message_retrievals", column)


def downgrade() -> None:
    raise RuntimeError("0300 is irreversible; restore the pre-release backup")
