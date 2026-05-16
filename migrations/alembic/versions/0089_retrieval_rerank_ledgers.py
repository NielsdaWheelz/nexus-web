"""Add retrieval candidate and rerank ledgers.

Revision ID: 0089_retrieval_rerank_ledgers
Revises: 0088
Create Date: 2026-05-14
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0089_retrieval_rerank_ledgers"
down_revision: str | None = "0088"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "message_retrieval_candidate_ledgers",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("tool_call_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("retrieval_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("result_type", sa.Text(), nullable=False),
        sa.Column("source_id", sa.Text(), nullable=False),
        sa.Column("score", sa.Float(), nullable=True),
        sa.Column("selected", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column(
            "included_in_prompt",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column("selection_status", sa.Text(), nullable=False),
        sa.Column("selection_reason", sa.Text(), nullable=False),
        sa.Column("result_ref", postgresql.JSONB(), nullable=False),
        sa.Column("locator", postgresql.JSONB(), nullable=True),
        sa.Column("source_version", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("ordinal >= 0", name="ck_retrieval_candidate_ledgers_ordinal"),
        sa.CheckConstraint(
            "char_length(result_type) BETWEEN 1 AND 64",
            name="ck_retrieval_candidate_ledgers_result_type",
        ),
        sa.CheckConstraint(
            "char_length(source_id) BETWEEN 1 AND 256",
            name="ck_retrieval_candidate_ledgers_source_id",
        ),
        sa.CheckConstraint(
            "score IS NULL OR score >= 0",
            name="ck_retrieval_candidate_ledgers_score",
        ),
        sa.CheckConstraint(
            """
            selection_status IN (
                'retrieved',
                'selected',
                'included_in_prompt',
                'excluded_by_budget',
                'excluded_by_scope',
                'web_result',
                'status'
            )
            """,
            name="ck_retrieval_candidate_ledgers_status",
        ),
        sa.CheckConstraint(
            "char_length(selection_reason) BETWEEN 1 AND 128",
            name="ck_retrieval_candidate_ledgers_reason",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(result_ref) = 'object'",
            name="ck_retrieval_candidate_ledgers_result_ref_object",
        ),
        sa.CheckConstraint(
            "locator IS NULL OR locator = 'null'::jsonb OR jsonb_typeof(locator) = 'object'",
            name="ck_retrieval_candidate_ledgers_locator_object",
        ),
        sa.ForeignKeyConstraint(["tool_call_id"], ["message_tool_calls.id"]),
        sa.ForeignKeyConstraint(["retrieval_id"], ["message_retrievals.id"]),
    )
    op.create_index(
        "idx_retrieval_candidate_ledgers_tool_call",
        "message_retrieval_candidate_ledgers",
        ["tool_call_id", "ordinal"],
    )
    op.create_index(
        "idx_retrieval_candidate_ledgers_retrieval",
        "message_retrieval_candidate_ledgers",
        ["retrieval_id"],
    )

    op.create_table(
        "message_rerank_ledgers",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("tool_call_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("strategy", sa.Text(), nullable=False),
        sa.Column("input_count", sa.Integer(), nullable=False),
        sa.Column("selected_count", sa.Integer(), nullable=False),
        sa.Column("budget_chars", sa.Integer(), nullable=True),
        sa.Column("selected_chars", sa.Integer(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column(
            "metadata",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "char_length(strategy) BETWEEN 1 AND 128",
            name="ck_message_rerank_ledgers_strategy",
        ),
        sa.CheckConstraint(
            "input_count >= 0 AND selected_count >= 0 AND selected_chars >= 0",
            name="ck_message_rerank_ledgers_counts",
        ),
        sa.CheckConstraint(
            "budget_chars IS NULL OR budget_chars >= 0",
            name="ck_message_rerank_ledgers_budget_chars",
        ),
        sa.CheckConstraint(
            "char_length(status) BETWEEN 1 AND 64",
            name="ck_message_rerank_ledgers_status",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(metadata) = 'object'",
            name="ck_message_rerank_ledgers_metadata_object",
        ),
        sa.ForeignKeyConstraint(["tool_call_id"], ["message_tool_calls.id"]),
    )
    op.create_index(
        "idx_message_rerank_ledgers_tool_call",
        "message_rerank_ledgers",
        ["tool_call_id", "created_at", "id"],
    )


def downgrade() -> None:
    op.drop_index("idx_message_rerank_ledgers_tool_call", table_name="message_rerank_ledgers")
    op.drop_table("message_rerank_ledgers")
    op.drop_index(
        "idx_retrieval_candidate_ledgers_retrieval",
        table_name="message_retrieval_candidate_ledgers",
    )
    op.drop_index(
        "idx_retrieval_candidate_ledgers_tool_call",
        table_name="message_retrieval_candidate_ledgers",
    )
    op.drop_table("message_retrieval_candidate_ledgers")
