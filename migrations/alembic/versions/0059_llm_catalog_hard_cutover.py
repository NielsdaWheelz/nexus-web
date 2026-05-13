"""Hard cut over LLM catalog to current provider model set.

Revision ID: 0059
Revises: 0056
Create Date: 2026-04-24
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0059"
down_revision: str | None = "0056"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE models
        SET is_available = false
        WHERE provider IN ('openai', 'anthropic', 'gemini', 'deepseek')
          AND NOT (
            (provider = 'openai' AND model_name IN ('gpt-5.5', 'gpt-5.4-mini'))
            OR (
              provider = 'anthropic'
              AND model_name IN (
                'claude-opus-4-7',
                'claude-sonnet-4-6',
                'claude-haiku-4-5-20251001'
              )
            )
            OR (
              provider = 'gemini'
              AND model_name IN ('gemini-3.1-pro-preview', 'gemini-3-flash-preview')
            )
            OR (
              provider = 'deepseek'
              AND model_name IN ('deepseek-v4-pro', 'deepseek-v4-flash')
            )
          )
        """
    )

    op.execute(
        """
        INSERT INTO models (id, provider, model_name, max_context_tokens, is_available)
        VALUES
            (gen_random_uuid(), 'openai', 'gpt-5.5', 400000, true),
            (gen_random_uuid(), 'openai', 'gpt-5.4-mini', 400000, true),
            (gen_random_uuid(), 'anthropic', 'claude-opus-4-7', 1000000, true),
            (gen_random_uuid(), 'anthropic', 'claude-sonnet-4-6', 1000000, true),
            (gen_random_uuid(), 'anthropic', 'claude-haiku-4-5-20251001', 200000, true),
            (gen_random_uuid(), 'gemini', 'gemini-3.1-pro-preview', 1048576, true),
            (gen_random_uuid(), 'gemini', 'gemini-3-flash-preview', 1048576, true),
            (gen_random_uuid(), 'deepseek', 'deepseek-v4-pro', 128000, true),
            (gen_random_uuid(), 'deepseek', 'deepseek-v4-flash', 128000, true)
        ON CONFLICT (provider, model_name)
        DO UPDATE
            SET max_context_tokens = EXCLUDED.max_context_tokens,
                is_available = true
        """
    )


def downgrade() -> None:
    pass
