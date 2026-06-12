"""Assistant message trust trail hard cutover.

Revision ID: 0155
Revises: 0154
Create Date: 2026-06-12
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0155"
down_revision: str | Sequence[str] | None = "0154"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        UPDATE messages
        SET message_document = jsonb_set(
            message_document,
            '{blocks}',
            COALESCE(
                (
                    SELECT jsonb_agg(block ORDER BY ordinal)
                    FROM jsonb_array_elements(message_document->'blocks')
                      WITH ORDINALITY AS item(block, ordinal)
                    WHERE block->>'type' = 'text'
                ),
                '[]'::jsonb
            ),
            true
        )
        WHERE jsonb_typeof(message_document->'blocks') = 'array'
          AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements(message_document->'blocks') AS block
              WHERE block->>'type' <> 'text'
          )
    """)
    op.execute("""
        UPDATE chat_run_events
        SET payload = jsonb_set(payload, '{citation_edge_id}', 'null'::jsonb, true)
        WHERE event_type = 'reference_added'
          AND NOT payload ? 'citation_edge_id'
    """)
    op.create_index(
        "idx_chat_prompt_assemblies_assistant_message",
        "chat_prompt_assemblies",
        ["assistant_message_id"],
    )
    op.create_index(
        "idx_chat_run_events_run_event_type_seq",
        "chat_run_events",
        ["run_id", "event_type", "seq"],
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0155 is not reversible")
