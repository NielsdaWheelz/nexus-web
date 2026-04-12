"""Expand LLM providers and update model registry.

Add DeepSeek as a new provider. Update model registry with current model IDs
from OpenAI, Anthropic, Gemini. Mark stale models as unavailable.

Revision ID: 0039
Revises: 0038
Create Date: 2026-04-11
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0039"
down_revision: str | None = "0038"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# New provider list for CHECK constraints
_PROVIDERS = "'openai', 'anthropic', 'gemini', 'deepseek'"


def upgrade() -> None:
    # ======================================================================
    # Step 1: Widen CHECK constraints to include 'deepseek'
    # ======================================================================
    for table, constraint_name in [
        ("models", "ck_models_provider"),
        ("message_llm", "ck_message_llm_provider"),
        ("user_api_keys", "ck_user_api_keys_provider"),
    ]:
        op.drop_constraint(constraint_name, table, type_="check")
        op.create_check_constraint(
            constraint_name,
            table,
            f"provider IN ({_PROVIDERS})",
        )

    # ======================================================================
    # Step 2: Mark stale models as unavailable
    # ======================================================================
    op.execute(
        """
        UPDATE models SET is_available = false
        WHERE model_name IN (
            'claude-sonnet-4-20250514',
            'claude-haiku-4-20250514',
            'gpt-4o',
            'gpt-4o-mini',
            'gemini-2.0-flash',
            'gemini-2.5-pro-preview-05-06'
        )
        """
    )

    # ======================================================================
    # Step 3: Insert new models
    # ======================================================================
    op.execute(
        """
        INSERT INTO models (id, provider, model_name, max_context_tokens, is_available)
        VALUES
            -- OpenAI: latest + cheap
            (gen_random_uuid(), 'openai', 'gpt-5.4-mini', 400000, true),
            (gen_random_uuid(), 'openai', 'gpt-4.1-nano', 1047576, true),
            -- Anthropic: current generation
            (gen_random_uuid(), 'anthropic', 'claude-opus-4-6', 1000000, true),
            (gen_random_uuid(), 'anthropic', 'claude-sonnet-4-6', 1000000, true),
            (gen_random_uuid(), 'anthropic', 'claude-haiku-4-5-20251001', 200000, true),
            -- Gemini: stable replacements
            (gen_random_uuid(), 'gemini', 'gemini-2.5-pro', 1048576, true),
            (gen_random_uuid(), 'gemini', 'gemini-2.5-flash', 1048576, true),
            -- DeepSeek: new provider
            (gen_random_uuid(), 'deepseek', 'deepseek-chat', 128000, true),
            (gen_random_uuid(), 'deepseek', 'deepseek-reasoner', 128000, true)
        ON CONFLICT DO NOTHING
        """
    )


def downgrade() -> None:
    # Remove new models
    op.execute(
        """
        DELETE FROM models
        WHERE model_name IN (
            'gpt-5.4-mini', 'gpt-4.1-nano',
            'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
            'gemini-2.5-pro', 'gemini-2.5-flash',
            'deepseek-chat', 'deepseek-reasoner'
        )
        """
    )

    # Restore stale models
    op.execute(
        """
        UPDATE models SET is_available = true
        WHERE model_name IN (
            'claude-sonnet-4-20250514',
            'claude-haiku-4-20250514',
            'gpt-4o',
            'gpt-4o-mini',
            'gemini-2.0-flash',
            'gemini-2.5-pro-preview-05-06'
        )
        """
    )

    # Restore original CHECK constraints
    _OLD_PROVIDERS = "'openai', 'anthropic', 'gemini'"
    for table, constraint_name in [
        ("models", "ck_models_provider"),
        ("message_llm", "ck_message_llm_provider"),
        ("user_api_keys", "ck_user_api_keys_provider"),
    ]:
        op.drop_constraint(constraint_name, table, type_="check")
        op.create_check_constraint(
            constraint_name,
            table,
            f"provider IN ({_OLD_PROVIDERS})",
        )
