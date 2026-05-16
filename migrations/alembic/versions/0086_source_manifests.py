"""Add durable source manifests.

Revision ID: 0086_source_manifests
Revises: 0085_message_artifacts
Create Date: 2026-05-14
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0086_source_manifests"
down_revision = "0085_message_artifacts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "source_manifests",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("conversation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("assistant_message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("chat_run_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tool_call_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("tool_name", sa.Text(), nullable=False),
        sa.Column("tool_call_index", sa.Integer(), nullable=False),
        sa.Column("query_hash", sa.Text(), nullable=True),
        sa.Column("scope", sa.Text(), nullable=False),
        sa.Column(
            "filters", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        sa.Column(
            "requested_types",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("candidate_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("result_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("selected_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "included_in_prompt_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "excluded_by_budget_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "excluded_by_scope_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column("stale_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("unreadable_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("web_search_mode", sa.Text(), nullable=True),
        sa.Column(
            "index_versions",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "metadata", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "char_length(tool_name) BETWEEN 1 AND 128",
            name="ck_source_manifests_tool_name_length",
        ),
        sa.CheckConstraint(
            "tool_call_index >= 0",
            name="ck_source_manifests_tool_call_index",
        ),
        sa.CheckConstraint(
            "query_hash IS NULL OR char_length(query_hash) BETWEEN 1 AND 128",
            name="ck_source_manifests_query_hash_length",
        ),
        sa.CheckConstraint(
            "char_length(scope) BETWEEN 1 AND 256",
            name="ck_source_manifests_scope_length",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(filters) = 'object'",
            name="ck_source_manifests_filters_object",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(requested_types) = 'array'",
            name="ck_source_manifests_requested_types_array",
        ),
        sa.CheckConstraint(
            "candidate_count >= 0 AND result_count >= 0 AND selected_count >= 0 "
            "AND included_in_prompt_count >= 0 AND excluded_by_budget_count >= 0 "
            "AND excluded_by_scope_count >= 0 AND stale_count >= 0 AND unreadable_count >= 0",
            name="ck_source_manifests_counts_non_negative",
        ),
        sa.CheckConstraint(
            "web_search_mode IS NULL OR web_search_mode IN ('off', 'auto', 'required')",
            name="ck_source_manifests_web_search_mode",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(index_versions) = 'array'",
            name="ck_source_manifests_index_versions_array",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(metadata) = 'object'",
            name="ck_source_manifests_metadata_object",
        ),
        sa.CheckConstraint(
            "latency_ms IS NULL OR latency_ms >= 0",
            name="ck_source_manifests_latency_non_negative",
        ),
        sa.CheckConstraint(
            "char_length(status) BETWEEN 1 AND 64",
            name="ck_source_manifests_status_length",
        ),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"]),
        sa.ForeignKeyConstraint(["assistant_message_id"], ["messages.id"]),
        sa.ForeignKeyConstraint(["chat_run_id"], ["chat_runs.id"]),
        sa.ForeignKeyConstraint(["tool_call_id"], ["message_tool_calls.id"]),
        sa.UniqueConstraint(
            "chat_run_id",
            "tool_call_index",
            name="uix_source_manifests_run_tool_call_index",
        ),
    )


def downgrade() -> None:
    op.drop_table("source_manifests")
