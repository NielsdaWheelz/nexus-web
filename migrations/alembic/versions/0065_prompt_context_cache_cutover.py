"""Add prompt context cache observability columns.

Revision ID: 0065
Revises: 0064
Create Date: 2026-04-30
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0065"
down_revision: str | None = "0064"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("message_llm", sa.Column("input_tokens", sa.Integer(), nullable=True))
    op.add_column("message_llm", sa.Column("output_tokens", sa.Integer(), nullable=True))
    op.add_column("message_llm", sa.Column("reasoning_tokens", sa.Integer(), nullable=True))
    op.add_column("message_llm", sa.Column("cache_write_input_tokens", sa.Integer(), nullable=True))
    op.add_column("message_llm", sa.Column("cache_read_input_tokens", sa.Integer(), nullable=True))
    op.add_column("message_llm", sa.Column("cached_input_tokens", sa.Integer(), nullable=True))
    op.add_column("message_llm", sa.Column("prompt_plan_version", sa.Text(), nullable=True))
    op.add_column("message_llm", sa.Column("stable_prefix_hash", sa.Text(), nullable=True))
    op.add_column("message_llm", sa.Column("provider_usage", postgresql.JSONB(), nullable=True))
    op.execute(
        """
        UPDATE message_llm
        SET input_tokens = prompt_tokens,
            output_tokens = completion_tokens
        """
    )
    op.create_check_constraint(
        "ck_message_llm_input_tokens",
        "message_llm",
        "input_tokens IS NULL OR input_tokens >= 0",
    )
    op.create_check_constraint(
        "ck_message_llm_output_tokens",
        "message_llm",
        "output_tokens IS NULL OR output_tokens >= 0",
    )
    op.create_check_constraint(
        "ck_message_llm_reasoning_tokens",
        "message_llm",
        "reasoning_tokens IS NULL OR reasoning_tokens >= 0",
    )
    op.create_check_constraint(
        "ck_message_llm_cache_write_tokens",
        "message_llm",
        "cache_write_input_tokens IS NULL OR cache_write_input_tokens >= 0",
    )
    op.create_check_constraint(
        "ck_message_llm_cache_read_tokens",
        "message_llm",
        "cache_read_input_tokens IS NULL OR cache_read_input_tokens >= 0",
    )
    op.create_check_constraint(
        "ck_message_llm_cached_input_tokens",
        "message_llm",
        "cached_input_tokens IS NULL OR cached_input_tokens >= 0",
    )
    op.create_check_constraint(
        "ck_message_llm_provider_usage_object",
        "message_llm",
        "provider_usage IS NULL OR jsonb_typeof(provider_usage) = 'object'",
    )
    op.drop_constraint("ck_message_llm_prompt_tokens", "message_llm", type_="check")
    op.drop_constraint("ck_message_llm_completion_tokens", "message_llm", type_="check")
    op.drop_column("message_llm", "prompt_tokens")
    op.drop_column("message_llm", "completion_tokens")

    op.add_column(
        "chat_prompt_assemblies",
        sa.Column(
            "prompt_plan_version",
            sa.Text(),
            server_default="prompt-plan-v1",
            nullable=False,
        ),
    )
    op.add_column(
        "chat_prompt_assemblies",
        sa.Column("stable_prefix_hash", sa.Text(), server_default="legacy", nullable=False),
    )
    op.add_column(
        "chat_prompt_assemblies",
        sa.Column(
            "cacheable_input_tokens_estimate",
            sa.Integer(),
            server_default="0",
            nullable=False,
        ),
    )
    op.add_column(
        "chat_prompt_assemblies",
        sa.Column(
            "prompt_block_manifest",
            postgresql.JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
    )
    op.add_column(
        "chat_prompt_assemblies",
        sa.Column("provider_request_hash", sa.Text(), server_default="legacy", nullable=False),
    )
    op.alter_column("chat_prompt_assemblies", "prompt_plan_version", server_default=None)
    op.alter_column("chat_prompt_assemblies", "stable_prefix_hash", server_default=None)
    op.alter_column(
        "chat_prompt_assemblies", "cacheable_input_tokens_estimate", server_default=None
    )
    op.alter_column("chat_prompt_assemblies", "provider_request_hash", server_default=None)
    op.create_check_constraint(
        "ck_chat_prompt_assemblies_prompt_plan_version_length",
        "chat_prompt_assemblies",
        "char_length(prompt_plan_version) BETWEEN 1 AND 128",
    )
    op.create_check_constraint(
        "ck_chat_prompt_assemblies_stable_prefix_hash_length",
        "chat_prompt_assemblies",
        "char_length(stable_prefix_hash) BETWEEN 1 AND 128",
    )
    op.create_check_constraint(
        "ck_chat_prompt_assemblies_provider_request_hash_length",
        "chat_prompt_assemblies",
        "char_length(provider_request_hash) BETWEEN 1 AND 128",
    )
    op.create_check_constraint(
        "ck_chat_prompt_assemblies_prompt_block_manifest_object",
        "chat_prompt_assemblies",
        "jsonb_typeof(prompt_block_manifest) = 'object'",
    )
    op.create_check_constraint(
        "ck_chat_prompt_assemblies_cacheable_tokens",
        "chat_prompt_assemblies",
        "cacheable_input_tokens_estimate >= 0",
    )


def downgrade() -> None:
    op.add_column("message_llm", sa.Column("prompt_tokens", sa.Integer(), nullable=True))
    op.add_column("message_llm", sa.Column("completion_tokens", sa.Integer(), nullable=True))
    op.execute(
        """
        UPDATE message_llm
        SET prompt_tokens = input_tokens,
            completion_tokens = output_tokens
        """
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

    op.drop_constraint(
        "ck_chat_prompt_assemblies_cacheable_tokens",
        "chat_prompt_assemblies",
        type_="check",
    )
    op.drop_constraint(
        "ck_chat_prompt_assemblies_prompt_block_manifest_object",
        "chat_prompt_assemblies",
        type_="check",
    )
    op.drop_constraint(
        "ck_chat_prompt_assemblies_provider_request_hash_length",
        "chat_prompt_assemblies",
        type_="check",
    )
    op.drop_constraint(
        "ck_chat_prompt_assemblies_stable_prefix_hash_length",
        "chat_prompt_assemblies",
        type_="check",
    )
    op.drop_constraint(
        "ck_chat_prompt_assemblies_prompt_plan_version_length",
        "chat_prompt_assemblies",
        type_="check",
    )
    op.drop_column("chat_prompt_assemblies", "provider_request_hash")
    op.drop_column("chat_prompt_assemblies", "prompt_block_manifest")
    op.drop_column("chat_prompt_assemblies", "cacheable_input_tokens_estimate")
    op.drop_column("chat_prompt_assemblies", "stable_prefix_hash")
    op.drop_column("chat_prompt_assemblies", "prompt_plan_version")

    op.drop_constraint("ck_message_llm_provider_usage_object", "message_llm", type_="check")
    op.drop_constraint("ck_message_llm_cached_input_tokens", "message_llm", type_="check")
    op.drop_constraint("ck_message_llm_cache_read_tokens", "message_llm", type_="check")
    op.drop_constraint("ck_message_llm_cache_write_tokens", "message_llm", type_="check")
    op.drop_constraint("ck_message_llm_reasoning_tokens", "message_llm", type_="check")
    op.drop_constraint("ck_message_llm_output_tokens", "message_llm", type_="check")
    op.drop_constraint("ck_message_llm_input_tokens", "message_llm", type_="check")
    op.drop_column("message_llm", "provider_usage")
    op.drop_column("message_llm", "stable_prefix_hash")
    op.drop_column("message_llm", "prompt_plan_version")
    op.drop_column("message_llm", "cached_input_tokens")
    op.drop_column("message_llm", "cache_read_input_tokens")
    op.drop_column("message_llm", "cache_write_input_tokens")
    op.drop_column("message_llm", "reasoning_tokens")
    op.drop_column("message_llm", "output_tokens")
    op.drop_column("message_llm", "input_tokens")
