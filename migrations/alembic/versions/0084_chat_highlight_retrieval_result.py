"""Add highlight retrieval results to chat.

Revision ID: 0084
Revises: 0083
Create Date: 2026-05-14
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0084"
down_revision = "0083"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column(
            "message_document",
            postgresql.JSONB(),
            nullable=True,
            server_default=sa.text(
                """'{"type":"message_document","version"\\:1,"blocks":[]}'::jsonb"""
            ),
        ),
    )
    op.execute(
        """
        UPDATE messages
        SET message_document = jsonb_build_object(
            'type', 'message_document',
            'version', 1,
            'blocks', CASE
                WHEN content = '' THEN '[]'::jsonb
                ELSE jsonb_build_array(
                    jsonb_build_object(
                        'type', 'text',
                        'format', CASE WHEN role = 'assistant' THEN 'markdown' ELSE 'plain' END,
                        'text', content
                    )
                )
            END
        )
        """
    )
    op.alter_column("messages", "message_document", nullable=False)
    op.create_check_constraint(
        "ck_messages_message_document_object",
        "messages",
        "jsonb_typeof(message_document) = 'object'",
    )

    op.drop_constraint("ck_chat_run_events_event_type", "chat_run_events", type_="check")
    op.create_check_constraint(
        "ck_chat_run_events_event_type",
        "chat_run_events",
        """
        event_type IN (
            'meta',
            'tool_call',
            'tool_result',
            'retrieval_result',
            'source_manifest_delta',
            'artifact_delta',
            'citation',
            'claim',
            'delta',
            'done'
        )
        """,
    )
    op.execute(
        "UPDATE chat_run_events "
        "SET event_type = 'retrieval_result' "
        "WHERE event_type = 'tool_result'"
    )
    op.drop_constraint("ck_chat_run_events_event_type", "chat_run_events", type_="check")
    op.create_check_constraint(
        "ck_chat_run_events_event_type",
        "chat_run_events",
        """
        event_type IN (
            'meta',
            'tool_call',
            'retrieval_result',
            'source_manifest_delta',
            'artifact_delta',
            'citation',
            'claim',
            'delta',
            'done'
        )
        """,
    )
    op.drop_constraint("ck_message_retrievals_result_type", "message_retrievals", type_="check")
    op.create_check_constraint(
        "ck_message_retrievals_result_type",
        "message_retrievals",
        """
        result_type IN (
            'page',
            'note_block',
            'highlight',
            'media',
            'podcast',
            'episode',
            'video',
            'content_chunk',
            'fragment',
            'message',
            'contributor',
            'web_result',
            'status'
        )
        """,
    )
    op.drop_constraint(
        "ck_message_context_items_object_type", "message_context_items", type_="check"
    )
    op.create_check_constraint(
        "ck_message_context_items_object_type",
        "message_context_items",
        """
        object_type IS NULL OR object_type IN (
            'page',
            'note_block',
            'media',
            'highlight',
            'conversation',
            'message',
            'podcast',
            'content_chunk',
            'fragment',
            'contributor'
        )
        """,
    )
    op.drop_constraint("ck_object_links_a_type", "object_links", type_="check")
    op.drop_constraint("ck_object_links_b_type", "object_links", type_="check")
    op.create_check_constraint(
        "ck_object_links_a_type",
        "object_links",
        "a_type IN ('page', 'note_block', 'media', 'highlight', 'conversation', "
        "'message', 'podcast', 'content_chunk', 'fragment', 'contributor')",
    )
    op.create_check_constraint(
        "ck_object_links_b_type",
        "object_links",
        "b_type IN ('page', 'note_block', 'media', 'highlight', 'conversation', "
        "'message', 'podcast', 'content_chunk', 'fragment', 'contributor')",
    )
    op.drop_constraint("ck_user_pinned_objects_type", "user_pinned_objects", type_="check")
    op.create_check_constraint(
        "ck_user_pinned_objects_type",
        "user_pinned_objects",
        "object_type IN ('page', 'note_block', 'media', 'highlight', 'conversation', "
        "'message', 'podcast', 'content_chunk', 'fragment', 'contributor')",
    )
    op.drop_constraint("ck_message_tool_calls_status", "message_tool_calls", type_="check")
    op.create_check_constraint(
        "ck_message_tool_calls_status",
        "message_tool_calls",
        "status IN ('pending', 'running', 'complete', 'error', 'cancelled')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_message_tool_calls_status", "message_tool_calls", type_="check")
    op.create_check_constraint(
        "ck_message_tool_calls_status",
        "message_tool_calls",
        "status IN ('pending', 'complete', 'error')",
    )
    op.execute(
        "DELETE FROM chat_run_events "
        "WHERE event_type IN ('source_manifest_delta', 'artifact_delta', 'claim')"
    )
    op.drop_constraint("ck_chat_run_events_event_type", "chat_run_events", type_="check")
    op.create_check_constraint(
        "ck_chat_run_events_event_type",
        "chat_run_events",
        "event_type IN ('meta', 'tool_call', 'retrieval_result', 'tool_result', 'citation', 'delta', 'done')",
    )
    op.execute(
        "UPDATE chat_run_events "
        "SET event_type = 'tool_result' "
        "WHERE event_type = 'retrieval_result'"
    )
    op.drop_constraint("ck_chat_run_events_event_type", "chat_run_events", type_="check")
    op.create_check_constraint(
        "ck_chat_run_events_event_type",
        "chat_run_events",
        "event_type IN ('meta', 'tool_call', 'tool_result', 'citation', 'delta', 'done')",
    )
    op.execute("DELETE FROM message_context_items WHERE object_type = 'fragment'")
    op.drop_constraint(
        "ck_message_context_items_object_type", "message_context_items", type_="check"
    )
    op.create_check_constraint(
        "ck_message_context_items_object_type",
        "message_context_items",
        """
        object_type IS NULL OR object_type IN (
            'page',
            'note_block',
            'media',
            'highlight',
            'conversation',
            'message',
            'podcast',
            'content_chunk',
            'contributor'
        )
        """,
    )
    op.execute("DELETE FROM object_links WHERE a_type = 'fragment' OR b_type = 'fragment'")
    op.drop_constraint("ck_object_links_a_type", "object_links", type_="check")
    op.drop_constraint("ck_object_links_b_type", "object_links", type_="check")
    op.create_check_constraint(
        "ck_object_links_a_type",
        "object_links",
        "a_type IN ('page', 'note_block', 'media', 'highlight', 'conversation', "
        "'message', 'podcast', 'content_chunk', 'contributor')",
    )
    op.create_check_constraint(
        "ck_object_links_b_type",
        "object_links",
        "b_type IN ('page', 'note_block', 'media', 'highlight', 'conversation', "
        "'message', 'podcast', 'content_chunk', 'contributor')",
    )
    op.execute("DELETE FROM user_pinned_objects WHERE object_type = 'fragment'")
    op.drop_constraint("ck_user_pinned_objects_type", "user_pinned_objects", type_="check")
    op.create_check_constraint(
        "ck_user_pinned_objects_type",
        "user_pinned_objects",
        "object_type IN ('page', 'note_block', 'media', 'highlight', 'conversation', "
        "'message', 'podcast', 'content_chunk', 'contributor')",
    )
    op.execute(
        "DELETE FROM message_retrievals "
        "WHERE result_type IN ('highlight', 'fragment', 'episode', 'video', 'status')"
    )
    op.drop_constraint("ck_message_retrievals_result_type", "message_retrievals", type_="check")
    op.create_check_constraint(
        "ck_message_retrievals_result_type",
        "message_retrievals",
        """
        result_type IN (
            'page',
            'note_block',
            'media',
            'podcast',
            'content_chunk',
            'message',
            'contributor',
            'web_result'
        )
        """,
    )
    op.drop_constraint("ck_messages_message_document_object", "messages", type_="check")
    op.drop_column("messages", "message_document")
