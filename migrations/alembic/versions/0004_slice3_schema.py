"""Slice 3 schema - Chat, Conversations, Messages, LLM Infrastructure

Revision ID: 0004
Revises: 0003
Create Date: 2026-01-25

This migration adds all Slice 3 tables for the chat system:

Chat core:
- conversation: User-owned chat threads with sharing modes
- models: LLM model registry (provider, pricing, availability)
- message: Messages within conversations with seq ordering

LLM metadata + keys:
- message_llm: Per-assistant-message LLM execution metadata
- user_api_key: Encrypted BYOK API keys per provider
- idempotency_keys: Request deduplication for message sends

Context + sharing:
- message_context: Links messages to context objects (media/highlight/annotation)
- conversation_media: Derived table tracking media↔conversation relationships
- conversation_share: Library sharing for conversations

Content blocks:
- fragment_block: Block boundary index for context window computation

Search indexes:
- Generated stored tsvector columns + GIN indexes for keyword search

Per constitution and S3 spec invariants:
- conversation belongs to exactly one user
- sharing=private forbids conversation_share rows
- sharing=library requires ≥1 conversation_share rows
- message seq is strictly increasing per conversation
- status=pending only valid for role=assistant
- exactly one target FK in message_context
- fragment_blocks are contiguous and cover entire canonical_text
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ==========================================================================
    # Step 1: Create conversation table
    # ==========================================================================
    op.create_table(
        "conversations",
        sa.Column(
            "id",
            sa.UUID(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "owner_user_id",
            sa.UUID(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("sharing", sa.Text(), nullable=False, server_default="private"),
        sa.Column("next_seq", sa.Integer(), nullable=False, server_default="1"),
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
    )

    # Conversation constraints
    op.create_check_constraint(
        "ck_conversations_sharing",
        "conversations",
        "sharing IN ('private', 'library', 'public')",
    )
    op.create_check_constraint(
        "ck_conversations_next_seq_positive",
        "conversations",
        "next_seq >= 1",
    )

    # Conversation indexes
    op.create_index(
        "idx_conversations_owner_updated_at",
        "conversations",
        ["owner_user_id", sa.text("updated_at DESC")],
    )

    # ==========================================================================
    # Step 2: Create conversation_share table
    # ==========================================================================
    op.create_table(
        "conversation_shares",
        sa.Column(
            "conversation_id",
            sa.UUID(),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "library_id",
            sa.UUID(),
            sa.ForeignKey("libraries.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("conversation_id", "library_id"),
    )

    # ==========================================================================
    # Step 3: Create models table (LLM registry)
    # ==========================================================================
    op.create_table(
        "models",
        sa.Column(
            "id",
            sa.UUID(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("model_name", sa.Text(), nullable=False),
        sa.Column("max_context_tokens", sa.Integer(), nullable=False),
        sa.Column("cost_per_1k_input_tokens_usd", sa.Integer(), nullable=True),
        sa.Column("cost_per_1k_output_tokens_usd", sa.Integer(), nullable=True),
        sa.Column("is_available", sa.Boolean(), nullable=False, server_default="true"),
    )

    # Models constraints
    op.create_check_constraint(
        "ck_models_provider",
        "models",
        "provider IN ('openai', 'anthropic', 'gemini')",
    )
    op.create_check_constraint(
        "ck_models_max_context_positive",
        "models",
        "max_context_tokens > 0",
    )
    op.create_unique_constraint(
        "uix_models_provider_model_name",
        "models",
        ["provider", "model_name"],
    )

    # ==========================================================================
    # Step 4: Create message table
    # ==========================================================================
    op.create_table(
        "messages",
        sa.Column(
            "id",
            sa.UUID(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "conversation_id",
            sa.UUID(),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="complete"),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column(
            "model_id",
            sa.UUID(),
            sa.ForeignKey("models.id", ondelete="SET NULL"),
            nullable=True,
        ),
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
    )

    # Message constraints
    op.create_check_constraint(
        "ck_messages_seq_positive",
        "messages",
        "seq >= 1",
    )
    op.create_check_constraint(
        "ck_messages_role",
        "messages",
        "role IN ('user', 'assistant', 'system')",
    )
    op.create_check_constraint(
        "ck_messages_status",
        "messages",
        "status IN ('pending', 'complete', 'error')",
    )
    # Critical invariant: pending status only valid for assistant messages
    op.create_check_constraint(
        "ck_messages_pending_only_assistant",
        "messages",
        "(status != 'pending' OR role = 'assistant')",
    )

    # Message unique constraint: (conversation_id, seq)
    op.create_unique_constraint(
        "uix_messages_conversation_seq",
        "messages",
        ["conversation_id", "seq"],
    )

    # Message indexes
    op.create_index(
        "idx_messages_conversation_seq",
        "messages",
        ["conversation_id", "seq"],
    )

    # ==========================================================================
    # Step 5: Create message_llm table (LLM execution metadata)
    # ==========================================================================
    op.create_table(
        "message_llm",
        sa.Column(
            "message_id",
            sa.UUID(),
            sa.ForeignKey("messages.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("model_name", sa.Text(), nullable=False),
        sa.Column("prompt_tokens", sa.Integer(), nullable=True),
        sa.Column("completion_tokens", sa.Integer(), nullable=True),
        sa.Column("total_tokens", sa.Integer(), nullable=True),
        sa.Column("key_mode_requested", sa.Text(), nullable=False),
        sa.Column("key_mode_used", sa.Text(), nullable=False),
        sa.Column("cost_usd_micros", sa.Integer(), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("error_class", sa.Text(), nullable=True),
        sa.Column("prompt_version", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )

    # message_llm constraints
    op.create_check_constraint(
        "ck_message_llm_provider",
        "message_llm",
        "provider IN ('openai', 'anthropic', 'gemini')",
    )
    op.create_check_constraint(
        "ck_message_llm_key_mode_requested",
        "message_llm",
        "key_mode_requested IN ('auto', 'byok_only', 'platform_only')",
    )
    op.create_check_constraint(
        "ck_message_llm_key_mode_used",
        "message_llm",
        "key_mode_used IN ('platform', 'byok')",
    )
    op.create_check_constraint(
        "ck_message_llm_prompt_tokens",
        "message_llm",
        "prompt_tokens IS NULL OR prompt_tokens >= 0",
    )
    op.create_check_constraint(
        "ck_message_llm_completion_tokens",
        "message_llm",
        "completion_tokens IS NULL OR completion_tokens >= 0",
    )
    op.create_check_constraint(
        "ck_message_llm_total_tokens",
        "message_llm",
        "total_tokens IS NULL OR total_tokens >= 0",
    )
    op.create_check_constraint(
        "ck_message_llm_cost",
        "message_llm",
        "cost_usd_micros IS NULL OR cost_usd_micros >= 0",
    )
    op.create_check_constraint(
        "ck_message_llm_latency",
        "message_llm",
        "latency_ms IS NULL OR latency_ms >= 0",
    )

    # ==========================================================================
    # Step 6: Create user_api_key table (BYOK encrypted keys)
    # ==========================================================================
    op.create_table(
        "user_api_keys",
        sa.Column(
            "id",
            sa.UUID(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            sa.UUID(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("provider", sa.Text(), nullable=False),
        # Nullable to support secure revocation (wipe ciphertext to NULL)
        sa.Column("encrypted_key", sa.LargeBinary(), nullable=True),
        sa.Column("key_nonce", sa.LargeBinary(), nullable=True),
        sa.Column("master_key_version", sa.Integer(), nullable=True, server_default="1"),
        sa.Column("key_fingerprint", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="untested"),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("last_tested_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )

    # user_api_key constraints
    op.create_check_constraint(
        "ck_user_api_keys_provider",
        "user_api_keys",
        "provider IN ('openai', 'anthropic', 'gemini')",
    )
    # Allow NULL for master_key_version (wiped on revoke)
    op.create_check_constraint(
        "ck_user_api_keys_master_key_version",
        "user_api_keys",
        "master_key_version IS NULL OR master_key_version > 0",
    )
    op.create_check_constraint(
        "ck_user_api_keys_status",
        "user_api_keys",
        "status IN ('untested', 'valid', 'invalid', 'revoked')",
    )
    # Nonce must be exactly 24 bytes for XChaCha20-Poly1305, or NULL (wiped on revoke)
    op.create_check_constraint(
        "ck_user_api_keys_nonce_len",
        "user_api_keys",
        "key_nonce IS NULL OR octet_length(key_nonce) = 24",
    )

    # Unique constraint: one key per provider per user
    op.create_unique_constraint(
        "uix_user_api_keys_user_provider",
        "user_api_keys",
        ["user_id", "provider"],
    )

    # ==========================================================================
    # Step 7: Create idempotency_keys table
    # ==========================================================================
    op.create_table(
        "idempotency_keys",
        sa.Column(
            "user_id",
            sa.UUID(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column("payload_hash", sa.Text(), nullable=False),
        sa.Column(
            "user_message_id",
            sa.UUID(),
            sa.ForeignKey("messages.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "assistant_message_id",
            sa.UUID(),
            sa.ForeignKey("messages.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("user_id", "key"),
    )

    # idempotency_keys constraints
    op.create_check_constraint(
        "ck_idempotency_keys_key_length",
        "idempotency_keys",
        "length(key) >= 1 AND length(key) <= 128",
    )

    # idempotency_keys indexes
    op.create_index(
        "idx_idempotency_keys_user_created",
        "idempotency_keys",
        ["user_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "idx_idempotency_keys_expires_at",
        "idempotency_keys",
        ["expires_at"],
    )

    # ==========================================================================
    # Step 8: Create message_context table
    # ==========================================================================
    op.create_table(
        "message_contexts",
        sa.Column(
            "id",
            sa.UUID(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "message_id",
            sa.UUID(),
            sa.ForeignKey("messages.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("target_type", sa.Text(), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column(
            "media_id",
            sa.UUID(),
            sa.ForeignKey("media.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "highlight_id",
            sa.UUID(),
            sa.ForeignKey("highlights.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "annotation_id",
            sa.UUID(),
            sa.ForeignKey("annotations.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )

    # message_context constraints
    # v1 supports only media/highlight/annotation as context targets
    op.create_check_constraint(
        "ck_message_contexts_target_type",
        "message_contexts",
        "target_type IN ('media', 'highlight', 'annotation')",
    )
    op.create_check_constraint(
        "ck_message_contexts_ordinal_non_negative",
        "message_contexts",
        "ordinal >= 0",
    )
    # Exactly one FK must be non-null
    op.create_check_constraint(
        "ck_message_contexts_one_target",
        "message_contexts",
        """(
            (CASE WHEN media_id IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN highlight_id IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN annotation_id IS NOT NULL THEN 1 ELSE 0 END)
        ) = 1""",
    )

    # message_context unique constraint: ordinal unique per message
    op.create_unique_constraint(
        "uix_message_contexts_message_ordinal",
        "message_contexts",
        ["message_id", "ordinal"],
    )

    # message_context indexes
    op.create_index(
        "idx_message_contexts_message",
        "message_contexts",
        ["message_id"],
    )

    # ==========================================================================
    # Step 9: Create conversation_media table (derived)
    # ==========================================================================
    op.create_table(
        "conversation_media",
        sa.Column(
            "conversation_id",
            sa.UUID(),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "media_id",
            sa.UUID(),
            sa.ForeignKey("media.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "last_message_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("conversation_id", "media_id"),
    )

    # conversation_media indexes
    op.create_index(
        "idx_conversation_media_media",
        "conversation_media",
        ["media_id"],
    )

    # ==========================================================================
    # Step 10: Create fragment_block table
    # ==========================================================================
    op.create_table(
        "fragment_blocks",
        sa.Column(
            "id",
            sa.UUID(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "fragment_id",
            sa.UUID(),
            sa.ForeignKey("fragments.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("block_idx", sa.Integer(), nullable=False),
        sa.Column("start_offset", sa.Integer(), nullable=False),
        sa.Column("end_offset", sa.Integer(), nullable=False),
        sa.Column("block_type", sa.Text(), nullable=True),
        sa.Column("is_empty", sa.Boolean(), nullable=False, server_default="false"),
    )

    # fragment_block constraints
    op.create_check_constraint(
        "ck_fragment_blocks_block_idx",
        "fragment_blocks",
        "block_idx >= 0",
    )
    op.create_check_constraint(
        "ck_fragment_blocks_start_offset",
        "fragment_blocks",
        "start_offset >= 0",
    )
    op.create_check_constraint(
        "ck_fragment_blocks_offsets",
        "fragment_blocks",
        "end_offset >= start_offset",
    )

    # fragment_block unique constraint
    op.create_unique_constraint(
        "uix_fragment_blocks_fragment_idx",
        "fragment_blocks",
        ["fragment_id", "block_idx"],
    )

    # fragment_block indexes
    op.create_index(
        "idx_fragment_blocks_fragment_offsets",
        "fragment_blocks",
        ["fragment_id", "start_offset", "end_offset"],
    )

    # ==========================================================================
    # Step 11: Add generated tsvector columns to existing tables
    # ==========================================================================

    # Add title_tsv to media table
    op.add_column(
        "media",
        sa.Column(
            "title_tsv",
            sa.dialects.postgresql.TSVECTOR(),
            sa.Computed("to_tsvector('english', coalesce(title, ''))", persisted=True),
        ),
    )

    # Add canonical_text_tsv to fragments table
    op.add_column(
        "fragments",
        sa.Column(
            "canonical_text_tsv",
            sa.dialects.postgresql.TSVECTOR(),
            sa.Computed("to_tsvector('english', coalesce(canonical_text, ''))", persisted=True),
        ),
    )

    # Add body_tsv to annotations table
    op.add_column(
        "annotations",
        sa.Column(
            "body_tsv",
            sa.dialects.postgresql.TSVECTOR(),
            sa.Computed("to_tsvector('english', coalesce(body, ''))", persisted=True),
        ),
    )

    # Add content_tsv to messages table
    op.add_column(
        "messages",
        sa.Column(
            "content_tsv",
            sa.dialects.postgresql.TSVECTOR(),
            sa.Computed("to_tsvector('english', coalesce(content, ''))", persisted=True),
        ),
    )

    # ==========================================================================
    # Step 12: Create GIN indexes for full-text search
    # Note: In production with large tables, consider CREATE INDEX CONCURRENTLY
    # ==========================================================================
    op.create_index(
        "idx_media_title_tsv",
        "media",
        ["title_tsv"],
        postgresql_using="gin",
    )
    op.create_index(
        "idx_fragments_canonical_text_tsv",
        "fragments",
        ["canonical_text_tsv"],
        postgresql_using="gin",
    )
    op.create_index(
        "idx_annotations_body_tsv",
        "annotations",
        ["body_tsv"],
        postgresql_using="gin",
    )
    op.create_index(
        "idx_messages_content_tsv",
        "messages",
        ["content_tsv"],
        postgresql_using="gin",
    )

    # ==========================================================================
    # Step 13: Seed models table with initial LLM models
    # Per PR-03 spec: seed rows for models table so GET /models has data
    # Cost fields left NULL initially (filled in when billing is implemented)
    # ==========================================================================
    op.execute(
        """
        INSERT INTO models (id, provider, model_name, max_context_tokens, is_available)
        VALUES
            -- OpenAI models
            (gen_random_uuid(), 'openai', 'gpt-4o-mini', 128000, true),
            (gen_random_uuid(), 'openai', 'gpt-4o', 128000, true),
            -- Anthropic models
            (gen_random_uuid(), 'anthropic', 'claude-sonnet-4-20250514', 200000, true),
            (gen_random_uuid(), 'anthropic', 'claude-haiku-4-20250514', 200000, true),
            -- Gemini models
            (gen_random_uuid(), 'gemini', 'gemini-2.0-flash', 1000000, true),
            (gen_random_uuid(), 'gemini', 'gemini-2.5-pro-preview-05-06', 1000000, true)
        ON CONFLICT DO NOTHING
        """
    )


def downgrade() -> None:
    # ==========================================================================
    # Step 1: Drop GIN indexes
    # ==========================================================================
    op.drop_index("idx_messages_content_tsv", table_name="messages")
    op.drop_index("idx_annotations_body_tsv", table_name="annotations")
    op.drop_index("idx_fragments_canonical_text_tsv", table_name="fragments")
    op.drop_index("idx_media_title_tsv", table_name="media")

    # ==========================================================================
    # Step 2: Drop generated tsvector columns
    # ==========================================================================
    op.drop_column("messages", "content_tsv")
    op.drop_column("annotations", "body_tsv")
    op.drop_column("fragments", "canonical_text_tsv")
    op.drop_column("media", "title_tsv")

    # ==========================================================================
    # Step 3: Drop fragment_blocks table
    # ==========================================================================
    op.drop_index("idx_fragment_blocks_fragment_offsets", table_name="fragment_blocks")
    op.drop_constraint("uix_fragment_blocks_fragment_idx", "fragment_blocks", type_="unique")
    op.drop_constraint("ck_fragment_blocks_offsets", "fragment_blocks", type_="check")
    op.drop_constraint("ck_fragment_blocks_start_offset", "fragment_blocks", type_="check")
    op.drop_constraint("ck_fragment_blocks_block_idx", "fragment_blocks", type_="check")
    op.drop_table("fragment_blocks")

    # ==========================================================================
    # Step 4: Drop conversation_media table
    # ==========================================================================
    op.drop_index("idx_conversation_media_media", table_name="conversation_media")
    op.drop_table("conversation_media")

    # ==========================================================================
    # Step 5: Drop message_contexts table
    # ==========================================================================
    op.drop_index("idx_message_contexts_message", table_name="message_contexts")
    op.drop_constraint("uix_message_contexts_message_ordinal", "message_contexts", type_="unique")
    op.drop_constraint("ck_message_contexts_one_target", "message_contexts", type_="check")
    op.drop_constraint("ck_message_contexts_ordinal_non_negative", "message_contexts", type_="check")
    op.drop_constraint("ck_message_contexts_target_type", "message_contexts", type_="check")
    op.drop_table("message_contexts")

    # ==========================================================================
    # Step 6: Drop idempotency_keys table
    # ==========================================================================
    op.drop_index("idx_idempotency_keys_expires_at", table_name="idempotency_keys")
    op.drop_index("idx_idempotency_keys_user_created", table_name="idempotency_keys")
    op.drop_constraint("ck_idempotency_keys_key_length", "idempotency_keys", type_="check")
    op.drop_table("idempotency_keys")

    # ==========================================================================
    # Step 7: Drop user_api_keys table
    # ==========================================================================
    op.drop_constraint("uix_user_api_keys_user_provider", "user_api_keys", type_="unique")
    op.drop_constraint("ck_user_api_keys_nonce_len", "user_api_keys", type_="check")
    op.drop_constraint("ck_user_api_keys_status", "user_api_keys", type_="check")
    op.drop_constraint("ck_user_api_keys_master_key_version", "user_api_keys", type_="check")
    op.drop_constraint("ck_user_api_keys_provider", "user_api_keys", type_="check")
    op.drop_table("user_api_keys")

    # ==========================================================================
    # Step 8: Drop message_llm table
    # ==========================================================================
    op.drop_constraint("ck_message_llm_latency", "message_llm", type_="check")
    op.drop_constraint("ck_message_llm_cost", "message_llm", type_="check")
    op.drop_constraint("ck_message_llm_total_tokens", "message_llm", type_="check")
    op.drop_constraint("ck_message_llm_completion_tokens", "message_llm", type_="check")
    op.drop_constraint("ck_message_llm_prompt_tokens", "message_llm", type_="check")
    op.drop_constraint("ck_message_llm_key_mode_used", "message_llm", type_="check")
    op.drop_constraint("ck_message_llm_key_mode_requested", "message_llm", type_="check")
    op.drop_constraint("ck_message_llm_provider", "message_llm", type_="check")
    op.drop_table("message_llm")

    # ==========================================================================
    # Step 9: Drop messages table
    # ==========================================================================
    op.drop_index("idx_messages_conversation_seq", table_name="messages")
    op.drop_constraint("uix_messages_conversation_seq", "messages", type_="unique")
    op.drop_constraint("ck_messages_pending_only_assistant", "messages", type_="check")
    op.drop_constraint("ck_messages_status", "messages", type_="check")
    op.drop_constraint("ck_messages_role", "messages", type_="check")
    op.drop_constraint("ck_messages_seq_positive", "messages", type_="check")
    op.drop_table("messages")

    # ==========================================================================
    # Step 10: Drop models table
    # ==========================================================================
    op.drop_constraint("uix_models_provider_model_name", "models", type_="unique")
    op.drop_constraint("ck_models_max_context_positive", "models", type_="check")
    op.drop_constraint("ck_models_provider", "models", type_="check")
    op.drop_table("models")

    # ==========================================================================
    # Step 11: Drop conversation_shares table
    # ==========================================================================
    op.drop_table("conversation_shares")

    # ==========================================================================
    # Step 12: Drop conversations table
    # ==========================================================================
    op.drop_index("idx_conversations_owner_updated_at", table_name="conversations")
    op.drop_constraint("ck_conversations_next_seq_positive", "conversations", type_="check")
    op.drop_constraint("ck_conversations_sharing", "conversations", type_="check")
    op.drop_table("conversations")
