"""Add durable chat-run turn context.

Revision ID: 0161
Revises: 0160
Create Date: 2026-06-16
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0161"
down_revision: str | Sequence[str] | None = "0160"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

RESOURCE_SCHEME_CHECK = """
    'media', 'library', 'evidence_span', 'content_chunk',
    'highlight', 'page', 'note_block', 'fragment',
    'conversation', 'message', 'oracle_reading',
    'oracle_corpus_passage', 'library_intelligence_artifact',
    'library_intelligence_revision', 'external_snapshot',
    'contributor', 'podcast', 'tag'
"""


def upgrade() -> None:
    op.execute("""
        UPDATE messages
        SET branch_anchor_kind = 'none',
            branch_anchor = '{"kind":"none"}'::jsonb
        WHERE branch_anchor_kind = 'reader_context'
    """)
    op.execute("ALTER TABLE messages DROP CONSTRAINT ck_messages_branch_anchor_kind")
    op.execute("""
        ALTER TABLE messages ADD CONSTRAINT ck_messages_branch_anchor_kind
        CHECK (branch_anchor_kind IN ('none', 'assistant_message', 'assistant_selection'))
    """)
    op.execute(f"""
        CREATE TABLE chat_run_turn_contexts (
            chat_run_id uuid PRIMARY KEY REFERENCES chat_runs(id) ON DELETE CASCADE,
            requested_subject_scheme text NULL,
            requested_subject_id uuid NULL,
            subject_scheme text NULL,
            subject_id uuid NULL,
            subject_context_edge_id uuid NULL REFERENCES resource_edges(id) ON DELETE SET NULL,
            reader_selection_media_id uuid NULL,
            reader_selection_highlight_id uuid NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT ck_chat_run_turn_contexts_requested_subject_pair CHECK (
                (requested_subject_scheme IS NULL) = (requested_subject_id IS NULL)
            ),
            CONSTRAINT ck_chat_run_turn_contexts_subject_pair CHECK (
                (subject_scheme IS NULL) = (subject_id IS NULL)
            ),
            CONSTRAINT ck_chat_run_turn_contexts_reader_selection_pair CHECK (
                (reader_selection_media_id IS NULL) = (reader_selection_highlight_id IS NULL)
            ),
            CONSTRAINT ck_chat_run_turn_contexts_has_anchor CHECK (
                subject_id IS NOT NULL OR reader_selection_highlight_id IS NOT NULL
            ),
            CONSTRAINT ck_chat_run_turn_contexts_requested_subject_scheme CHECK (
                requested_subject_scheme IS NULL
                OR requested_subject_scheme IN ({RESOURCE_SCHEME_CHECK})
            ),
            CONSTRAINT ck_chat_run_turn_contexts_subject_scheme CHECK (
                subject_scheme IS NULL OR subject_scheme IN ({RESOURCE_SCHEME_CHECK})
            )
        )
    """)
    op.execute("""
        CREATE INDEX idx_chat_run_turn_contexts_subject
        ON chat_run_turn_contexts (subject_scheme, subject_id)
    """)


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0161 is not reversible")
