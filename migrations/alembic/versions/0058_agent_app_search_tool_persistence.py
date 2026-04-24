"""Add durable assistant app-search tool persistence.

Revision ID: 0058
Revises: 0057
Create Date: 2026-04-24
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0058"
down_revision: str | None = "0057"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "message_tool_calls",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("conversation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("assistant_message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tool_name", sa.Text(), nullable=False),
        sa.Column("tool_call_index", sa.Integer(), nullable=False),
        sa.Column("query_hash", sa.Text(), nullable=True),
        sa.Column("scope", sa.Text(), server_default="all", nullable=False),
        sa.Column(
            "requested_types",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("semantic", sa.Boolean(), server_default="false", nullable=False),
        sa.Column(
            "result_refs",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "selected_context_refs",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "provider_request_ids",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("status", sa.Text(), server_default="pending", nullable=False),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "char_length(tool_name) BETWEEN 1 AND 128",
            name="ck_message_tool_calls_tool_name_length",
        ),
        sa.CheckConstraint(
            "tool_call_index >= 0",
            name="ck_message_tool_calls_index_non_negative",
        ),
        sa.CheckConstraint(
            "query_hash IS NULL OR char_length(query_hash) BETWEEN 1 AND 128",
            name="ck_message_tool_calls_query_hash_length",
        ),
        sa.CheckConstraint(
            "char_length(scope) BETWEEN 1 AND 256",
            name="ck_message_tool_calls_scope_length",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(requested_types) = 'array'",
            name="ck_message_tool_calls_requested_types_array",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(result_refs) = 'array'",
            name="ck_message_tool_calls_result_refs_array",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(selected_context_refs) = 'array'",
            name="ck_message_tool_calls_selected_context_refs_array",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(provider_request_ids) = 'array'",
            name="ck_message_tool_calls_provider_request_ids_array",
        ),
        sa.CheckConstraint(
            "latency_ms IS NULL OR latency_ms >= 0",
            name="ck_message_tool_calls_latency_non_negative",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'complete', 'error')",
            name="ck_message_tool_calls_status",
        ),
        sa.ForeignKeyConstraint(
            ["conversation_id"],
            ["conversations.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_message_id"],
            ["messages.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["assistant_message_id"],
            ["messages.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "assistant_message_id",
            "tool_call_index",
            name="uix_message_tool_calls_assistant_index",
        ),
    )
    op.create_index(
        "idx_message_tool_calls_conversation_created",
        "message_tool_calls",
        ["conversation_id", "created_at"],
    )
    op.create_index(
        "idx_message_tool_calls_user_message",
        "message_tool_calls",
        ["user_message_id", "tool_call_index"],
    )
    op.create_index(
        "idx_message_tool_calls_assistant_message",
        "message_tool_calls",
        ["assistant_message_id", "tool_call_index"],
    )
    op.create_index(
        "idx_message_tool_calls_tool_status",
        "message_tool_calls",
        ["tool_name", "status"],
    )

    op.create_table(
        "message_retrievals",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("tool_call_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("result_type", sa.Text(), nullable=False),
        sa.Column("source_id", sa.Text(), nullable=False),
        sa.Column("media_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "context_ref",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column(
            "result_ref",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column("deep_link", sa.Text(), nullable=True),
        sa.Column("score", sa.Float(), nullable=True),
        sa.Column("selected", sa.Boolean(), server_default="false", nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "ordinal >= 0",
            name="ck_message_retrievals_ordinal_non_negative",
        ),
        sa.CheckConstraint(
            """
            result_type IN (
                'media',
                'podcast',
                'fragment',
                'annotation',
                'message',
                'transcript_chunk'
            )
            """,
            name="ck_message_retrievals_result_type",
        ),
        sa.CheckConstraint(
            "char_length(source_id) BETWEEN 1 AND 128",
            name="ck_message_retrievals_source_id_length",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(context_ref) = 'object'",
            name="ck_message_retrievals_context_ref_object",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(result_ref) = 'object'",
            name="ck_message_retrievals_result_ref_object",
        ),
        sa.CheckConstraint(
            "score IS NULL OR score >= 0",
            name="ck_message_retrievals_score_non_negative",
        ),
        sa.ForeignKeyConstraint(
            ["tool_call_id"],
            ["message_tool_calls.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["media_id"],
            ["media.id"],
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "tool_call_id",
            "ordinal",
            name="uix_message_retrievals_tool_call_ordinal",
        ),
    )
    op.create_index(
        "idx_message_retrievals_tool_call_selected",
        "message_retrievals",
        ["tool_call_id", "selected", "ordinal"],
    )
    op.create_index(
        "idx_message_retrievals_media",
        "message_retrievals",
        ["media_id"],
    )
    op.create_index(
        "idx_message_retrievals_result_type",
        "message_retrievals",
        ["result_type"],
    )


def downgrade() -> None:
    op.drop_index("idx_message_retrievals_result_type", table_name="message_retrievals")
    op.drop_index("idx_message_retrievals_media", table_name="message_retrievals")
    op.drop_index("idx_message_retrievals_tool_call_selected", table_name="message_retrievals")
    op.drop_table("message_retrievals")

    op.drop_index("idx_message_tool_calls_tool_status", table_name="message_tool_calls")
    op.drop_index("idx_message_tool_calls_assistant_message", table_name="message_tool_calls")
    op.drop_index("idx_message_tool_calls_user_message", table_name="message_tool_calls")
    op.drop_index("idx_message_tool_calls_conversation_created", table_name="message_tool_calls")
    op.drop_table("message_tool_calls")
