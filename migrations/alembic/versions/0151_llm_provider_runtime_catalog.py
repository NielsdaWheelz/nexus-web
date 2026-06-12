"""llm provider runtime catalog cutover

Revision ID: 0151
Revises: 0150
Create Date: 2026-06-11

Adds OpenRouter and Cloudflare to the provider constraints and model registry.
DeepSeek is removed from the active provider contract.

Hard cutover: not reversible.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0151"
down_revision: str | Sequence[str] | None = "0150"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_RUNTIME_PROVIDER_CHECK = (
    "provider IN ('openai', 'anthropic', 'gemini', 'openrouter', 'cloudflare')"
)
_KEY_PROVIDER_CHECK = "provider IN ('openai', 'anthropic', 'gemini', 'openrouter')"


def _replace_provider_check(table: str, constraint_name: str, check_sql: str) -> None:
    op.execute(f"ALTER TABLE IF EXISTS {table} DROP CONSTRAINT IF EXISTS {constraint_name}")
    op.execute(f"""
        DO $$
        BEGIN
            IF to_regclass('public.{table}') IS NOT NULL THEN
                ALTER TABLE {table}
                ADD CONSTRAINT {constraint_name} CHECK ({check_sql});
            END IF;
        END $$;
    """)


def upgrade() -> None:
    op.execute("""
        DELETE FROM chat_prompt_assemblies
        WHERE model_id IN (
            SELECT id FROM models
            WHERE provider = 'anthropic'
              AND model_name = 'claude-opus-4-7'
        )
    """)
    op.execute("""
        DELETE FROM chat_run_events
        WHERE run_id IN (
            SELECT id FROM chat_runs
            WHERE model_id IN (
                SELECT id FROM models
                WHERE provider = 'anthropic'
                  AND model_name = 'claude-opus-4-7'
            )
        )
    """)
    op.execute("""
        DELETE FROM chat_runs
        WHERE model_id IN (
            SELECT id FROM models
            WHERE provider = 'anthropic'
              AND model_name = 'claude-opus-4-7'
        )
    """)
    op.execute("""
        DELETE FROM models
        WHERE provider = 'anthropic'
          AND model_name = 'claude-opus-4-7'
    """)
    op.execute("""
        DELETE FROM chat_prompt_assemblies
        WHERE model_id IN (SELECT id FROM models WHERE provider = 'deepseek')
    """)
    op.execute("""
        DELETE FROM chat_run_events
        WHERE run_id IN (
            SELECT id FROM chat_runs
            WHERE model_id IN (SELECT id FROM models WHERE provider = 'deepseek')
        )
    """)
    op.execute("""
        DELETE FROM chat_runs
        WHERE model_id IN (SELECT id FROM models WHERE provider = 'deepseek')
    """)
    op.execute("DELETE FROM llm_calls WHERE provider = 'deepseek'")
    op.execute("DELETE FROM user_api_keys WHERE provider IN ('deepseek', 'cloudflare')")
    op.execute("DELETE FROM models WHERE provider = 'deepseek'")

    _replace_provider_check("models", "ck_models_provider", _RUNTIME_PROVIDER_CHECK)
    _replace_provider_check("llm_calls", "ck_llm_calls_provider", _RUNTIME_PROVIDER_CHECK)
    _replace_provider_check("user_api_keys", "ck_user_api_keys_provider", _KEY_PROVIDER_CHECK)

    op.execute("""
        ALTER TABLE llm_calls
            ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 1,
            ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS terminal_attempt_status text NOT NULL DEFAULT 'success',
            ADD COLUMN IF NOT EXISTS provider_attempts jsonb NULL
    """)
    op.execute("""
        ALTER TABLE llm_calls
            DROP CONSTRAINT IF EXISTS ck_llm_calls_attempt_counts,
            DROP CONSTRAINT IF EXISTS ck_llm_calls_terminal_attempt_status,
            DROP CONSTRAINT IF EXISTS ck_llm_calls_provider_attempts_array
    """)
    op.execute("""
        ALTER TABLE llm_calls
            ADD CONSTRAINT ck_llm_calls_attempt_counts
                CHECK (
                    attempt_count >= 1
                    AND retry_count >= 0
                    AND retry_count <= attempt_count - 1
                ),
            ADD CONSTRAINT ck_llm_calls_terminal_attempt_status
                CHECK (
                    terminal_attempt_status IN (
                        'success', 'retryable_error', 'terminal_error', 'abandoned'
                    )
                ),
            ADD CONSTRAINT ck_llm_calls_provider_attempts_array
                CHECK (provider_attempts IS NULL OR jsonb_typeof(provider_attempts) = 'array')
    """)

    op.execute("""
        WITH catalog(provider, model_name, max_context_tokens, is_available) AS (
            VALUES
                ('openrouter', 'moonshotai/kimi-k2.6', 262144, true),
                ('openrouter', 'openai/gpt-5.5', 1050000, true),
                ('openrouter', 'openai/gpt-5.4-mini', 400000, true),
                ('cloudflare', '@cf/openai/gpt-oss-20b', 128000, true),
                ('anthropic', 'claude-opus-4-8', 1000000, true)
        )
        INSERT INTO models (id, provider, model_name, max_context_tokens, is_available)
        SELECT
            gen_random_uuid(),
            catalog.provider,
            catalog.model_name,
            catalog.max_context_tokens,
            catalog.is_available
        FROM catalog
        ON CONFLICT (provider, model_name)
        DO UPDATE SET
            max_context_tokens = EXCLUDED.max_context_tokens,
            is_available = EXCLUDED.is_available
    """)


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0151 is not reversible")
