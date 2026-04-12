"""Curate model registry to fixed provider/model set for chat selection.

Revision ID: 0041
Revises: 0040
Create Date: 2026-04-12
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0041"
down_revision: str | None = "0040"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE models
        SET is_available = false
        WHERE provider IN ('openai', 'anthropic', 'gemini', 'deepseek')
          AND NOT (
            (provider = 'openai' AND model_name IN ('gpt-5.4', 'gpt-5.4-mini'))
            OR (
              provider = 'anthropic'
              AND (
                model_name IN ('claude-opus-4-6', 'claude-sonnet-4-6')
                OR model_name LIKE 'claude-haiku-4-5%'
              )
            )
            OR (
              provider = 'gemini'
              AND (
                model_name LIKE 'gemini-3.1-pro%'
                OR model_name LIKE 'gemini-3-flash%'
              )
            )
            OR (
              provider = 'deepseek'
              AND model_name IN ('deepseek-chat', 'deepseek-reasoner')
            )
          )
        """
    )

    op.execute(
        """
        INSERT INTO models (id, provider, model_name, max_context_tokens, is_available)
        VALUES
            (gen_random_uuid(), 'openai', 'gpt-5.4', 400000, true),
            (gen_random_uuid(), 'openai', 'gpt-5.4-mini', 400000, true),
            (gen_random_uuid(), 'anthropic', 'claude-opus-4-6', 1000000, true),
            (gen_random_uuid(), 'anthropic', 'claude-sonnet-4-6', 1000000, true),
            (gen_random_uuid(), 'anthropic', 'claude-haiku-4-5-20251001', 200000, true),
            (gen_random_uuid(), 'gemini', 'gemini-3.1-pro-preview', 1048576, true),
            (gen_random_uuid(), 'gemini', 'gemini-3-flash-preview', 1048576, true),
            (gen_random_uuid(), 'deepseek', 'deepseek-chat', 128000, true),
            (gen_random_uuid(), 'deepseek', 'deepseek-reasoner', 128000, true)
        ON CONFLICT (provider, model_name)
        DO UPDATE
            SET max_context_tokens = EXCLUDED.max_context_tokens,
                is_available = true
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE models
        SET is_available = false
        WHERE provider = 'openai' AND model_name = 'gpt-5.4'
        """
    )

    op.execute(
        """
        UPDATE models
        SET is_available = true
        WHERE provider IN ('openai', 'anthropic', 'gemini', 'deepseek')
          AND model_name IN (
            'gpt-5.4-mini',
            'gpt-4.1-nano',
            'claude-opus-4-6',
            'claude-sonnet-4-6',
            'claude-haiku-4-5-20251001',
            'gemini-2.5-pro',
            'gemini-2.5-flash',
            'deepseek-chat',
            'deepseek-reasoner'
          )
        """
    )
