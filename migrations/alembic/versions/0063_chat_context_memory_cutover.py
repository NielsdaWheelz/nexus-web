"""Add chat context memory tables.

Revision ID: 0063
Revises: 0062
Create Date: 2026-04-28
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0063"
down_revision: str | None = "0062"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "conversation_memory_items",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("conversation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), server_default="active", nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("source_required", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column("valid_from_seq", sa.Integer(), nullable=True),
        sa.Column("valid_through_seq", sa.Integer(), nullable=True),
        sa.Column("supersedes_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_by_message_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("prompt_version", sa.Text(), nullable=False),
        sa.Column("memory_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("invalid_reason", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            """
            kind IN (
                'goal',
                'constraint',
                'decision',
                'correction',
                'open_question',
                'task',
                'assistant_commitment',
                'user_preference',
                'source_claim'
            )
            """,
            name="ck_conversation_memory_items_kind",
        ),
        sa.CheckConstraint(
            "status IN ('active', 'superseded', 'invalid')",
            name="ck_conversation_memory_items_status",
        ),
        sa.CheckConstraint(
            "char_length(btrim(body)) BETWEEN 1 AND 4000",
            name="ck_conversation_memory_items_body_length",
        ),
        sa.CheckConstraint(
            "confidence >= 0 AND confidence <= 1", name="ck_conversation_memory_items_confidence"
        ),
        sa.CheckConstraint(
            """
            (valid_from_seq IS NULL OR valid_from_seq >= 1)
            AND (valid_through_seq IS NULL OR valid_through_seq >= 1)
            AND (
                valid_from_seq IS NULL
                OR valid_through_seq IS NULL
                OR valid_from_seq <= valid_through_seq
            )
            """,
            name="ck_conversation_memory_items_valid_seq",
        ),
        sa.CheckConstraint(
            "supersedes_id IS NULL OR supersedes_id != id",
            name="ck_conversation_memory_items_not_self_supersedes",
        ),
        sa.CheckConstraint(
            "kind != 'source_claim' OR source_required",
            name="ck_conversation_memory_items_source_claim_requires_source",
        ),
        sa.CheckConstraint(
            "char_length(prompt_version) BETWEEN 1 AND 128",
            name="ck_conversation_memory_items_prompt_version_length",
        ),
        sa.CheckConstraint(
            "memory_version >= 1", name="ck_conversation_memory_items_memory_version"
        ),
        sa.CheckConstraint(
            """
            (
                status = 'invalid'
                AND invalid_reason IN (
                    'prompt_version_changed',
                    'source_deleted',
                    'source_permission_changed',
                    'source_stale',
                    'validation_failed'
                )
            )
            OR (
                status != 'invalid'
                AND invalid_reason IS NULL
            )
            """,
            name="ck_conversation_memory_items_invalid_reason",
        ),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by_message_id"], ["messages.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["supersedes_id"], ["conversation_memory_items.id"], ondelete="SET NULL"
        ),
    )
    op.create_index(
        "idx_conversation_memory_items_active",
        "conversation_memory_items",
        ["conversation_id", "status", "prompt_version", "valid_from_seq"],
    )

    op.create_table(
        "conversation_memory_item_sources",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("memory_item_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("source_ref", postgresql.JSONB(), nullable=False),
        sa.Column("evidence_role", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("ordinal >= 0", name="ck_conversation_memory_item_sources_ordinal"),
        sa.CheckConstraint(
            "jsonb_typeof(source_ref) = 'object'",
            name="ck_conversation_memory_item_sources_source_ref_object",
        ),
        sa.CheckConstraint(
            """
            source_ref ? 'type'
            AND source_ref ->> 'type' IN (
                'message',
                'message_context',
                'message_retrieval',
                'app_context_ref',
                'web_result'
            )
            """,
            name="ck_conversation_memory_item_sources_source_ref_type",
        ),
        sa.CheckConstraint(
            """
            source_ref ? 'id'
            AND jsonb_typeof(source_ref -> 'id') = 'string'
            AND char_length(source_ref ->> 'id') BETWEEN 1 AND 256
            """,
            name="ck_conversation_memory_item_sources_source_ref_id",
        ),
        sa.CheckConstraint(
            "evidence_role IN ('supports', 'contradicts', 'supersedes', 'context')",
            name="ck_conversation_memory_item_sources_evidence_role",
        ),
        sa.ForeignKeyConstraint(
            ["memory_item_id"], ["conversation_memory_items.id"], ondelete="CASCADE"
        ),
        sa.UniqueConstraint(
            "memory_item_id", "ordinal", name="uix_conversation_memory_item_sources_item_ordinal"
        ),
    )

    op.execute(
        """
        CREATE FUNCTION enforce_conversation_memory_required_sources()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        DECLARE
            required_item_id uuid;
        BEGIN
            IF TG_TABLE_NAME = 'conversation_memory_item_sources' AND TG_OP = 'DELETE' THEN
                required_item_id := OLD.memory_item_id;
            ELSIF TG_TABLE_NAME = 'conversation_memory_item_sources' THEN
                required_item_id := NEW.memory_item_id;
            ELSE
                required_item_id := NEW.id;
            END IF;

            IF EXISTS (
                SELECT 1
                FROM conversation_memory_items item
                WHERE item.id = required_item_id
                  AND item.source_required
                  AND NOT EXISTS (
                      SELECT 1
                      FROM conversation_memory_item_sources source
                      WHERE source.memory_item_id = item.id
                  )
            ) THEN
                RAISE EXCEPTION 'source_required memory item requires at least one source'
                    USING ERRCODE = '23514';
            END IF;

            RETURN NULL;
        END;
        $$;
        """
    )
    op.execute(
        """
        CREATE CONSTRAINT TRIGGER conversation_memory_items_required_sources
        AFTER INSERT OR UPDATE ON conversation_memory_items
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION enforce_conversation_memory_required_sources()
        """
    )
    op.execute(
        """
        CREATE CONSTRAINT TRIGGER conversation_memory_item_sources_required_sources
        AFTER INSERT OR UPDATE OR DELETE ON conversation_memory_item_sources
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION enforce_conversation_memory_required_sources()
        """
    )

    op.create_table(
        "conversation_state_snapshots",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("conversation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("covered_through_seq", sa.Integer(), nullable=False),
        sa.Column("state_text", sa.Text(), nullable=False),
        sa.Column(
            "state_json", postgresql.JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False
        ),
        sa.Column(
            "source_refs", postgresql.JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False
        ),
        sa.Column(
            "memory_item_ids",
            postgresql.JSONB(),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("prompt_version", sa.Text(), nullable=False),
        sa.Column("snapshot_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("status", sa.Text(), server_default="active", nullable=False),
        sa.Column("invalid_reason", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "covered_through_seq >= 1", name="ck_conversation_state_snapshots_covered_seq"
        ),
        sa.CheckConstraint(
            "char_length(btrim(state_text)) BETWEEN 1 AND 20000",
            name="ck_conversation_state_snapshots_state_text_length",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(state_json) = 'object'",
            name="ck_conversation_state_snapshots_state_json_object",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(source_refs) = 'array'",
            name="ck_conversation_state_snapshots_source_refs_array",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(memory_item_ids) = 'array'",
            name="ck_conversation_state_snapshots_memory_item_ids_array",
        ),
        sa.CheckConstraint(
            "char_length(prompt_version) BETWEEN 1 AND 128",
            name="ck_conversation_state_snapshots_prompt_version_length",
        ),
        sa.CheckConstraint(
            "snapshot_version >= 1", name="ck_conversation_state_snapshots_snapshot_version"
        ),
        sa.CheckConstraint(
            "status IN ('active', 'superseded', 'invalid')",
            name="ck_conversation_state_snapshots_status",
        ),
        sa.CheckConstraint(
            """
            (
                status = 'invalid'
                AND invalid_reason IN (
                    'prompt_version_changed',
                    'source_deleted',
                    'source_permission_changed',
                    'source_stale',
                    'validation_failed'
                )
            )
            OR (
                status != 'invalid'
                AND invalid_reason IS NULL
            )
            """,
            name="ck_conversation_state_snapshots_invalid_reason",
        ),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"], ondelete="CASCADE"),
    )
    op.create_index(
        "uix_conversation_state_snapshots_active",
        "conversation_state_snapshots",
        ["conversation_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )

    op.create_table(
        "chat_prompt_assemblies",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("chat_run_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("conversation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("assistant_message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("model_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("prompt_version", sa.Text(), nullable=False),
        sa.Column("assembler_version", sa.Text(), nullable=False),
        sa.Column("snapshot_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("max_context_tokens", sa.Integer(), nullable=False),
        sa.Column("reserved_output_tokens", sa.Integer(), nullable=False),
        sa.Column("reserved_reasoning_tokens", sa.Integer(), nullable=False),
        sa.Column("input_budget_tokens", sa.Integer(), nullable=False),
        sa.Column("estimated_input_tokens", sa.Integer(), nullable=False),
        sa.Column(
            "included_message_ids",
            postgresql.JSONB(),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "included_memory_item_ids",
            postgresql.JSONB(),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "included_retrieval_ids",
            postgresql.JSONB(),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "included_context_refs",
            postgresql.JSONB(),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "dropped_items",
            postgresql.JSONB(),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "budget_breakdown",
            postgresql.JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "char_length(prompt_version) BETWEEN 1 AND 128",
            name="ck_chat_prompt_assemblies_prompt_version_length",
        ),
        sa.CheckConstraint(
            "char_length(assembler_version) BETWEEN 1 AND 128",
            name="ck_chat_prompt_assemblies_assembler_version_length",
        ),
        sa.CheckConstraint(
            """
            max_context_tokens > 0
            AND reserved_output_tokens >= 0
            AND reserved_reasoning_tokens >= 0
            AND input_budget_tokens >= 0
            AND estimated_input_tokens >= 0
            AND input_budget_tokens + reserved_output_tokens + reserved_reasoning_tokens
                <= max_context_tokens
            AND estimated_input_tokens <= input_budget_tokens
            """,
            name="ck_chat_prompt_assemblies_token_budget",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(included_message_ids) = 'array'",
            name="ck_chat_prompt_assemblies_message_ids_array",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(included_memory_item_ids) = 'array'",
            name="ck_chat_prompt_assemblies_memory_item_ids_array",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(included_retrieval_ids) = 'array'",
            name="ck_chat_prompt_assemblies_retrieval_ids_array",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(included_context_refs) = 'array'",
            name="ck_chat_prompt_assemblies_context_refs_array",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(dropped_items) = 'array'",
            name="ck_chat_prompt_assemblies_dropped_items_array",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(budget_breakdown) = 'object'",
            name="ck_chat_prompt_assemblies_budget_breakdown_object",
        ),
        sa.ForeignKeyConstraint(["chat_run_id"], ["chat_runs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["assistant_message_id"], ["messages.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["model_id"], ["models.id"]),
        sa.ForeignKeyConstraint(
            ["snapshot_id"], ["conversation_state_snapshots.id"], ondelete="SET NULL"
        ),
        sa.UniqueConstraint("chat_run_id", name="uix_chat_prompt_assemblies_chat_run"),
    )


def downgrade() -> None:
    op.drop_table("chat_prompt_assemblies")
    op.drop_index(
        "uix_conversation_state_snapshots_active", table_name="conversation_state_snapshots"
    )
    op.drop_table("conversation_state_snapshots")
    op.execute(
        "DROP TRIGGER conversation_memory_item_sources_required_sources ON conversation_memory_item_sources"
    )
    op.execute(
        "DROP TRIGGER conversation_memory_items_required_sources ON conversation_memory_items"
    )
    op.execute("DROP FUNCTION enforce_conversation_memory_required_sources()")
    op.drop_table("conversation_memory_item_sources")
    op.drop_index("idx_conversation_memory_items_active", table_name="conversation_memory_items")
    op.drop_table("conversation_memory_items")
