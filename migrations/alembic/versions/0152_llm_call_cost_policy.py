"""llm call cost policy ledger fields

Revision ID: 0152
Revises: 0151
Create Date: 2026-06-11

Adds provider route and shared-runtime cost policy fields to llm_calls.

Hard cutover: not reversible.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0152"
down_revision: str | Sequence[str] | None = "0151"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_RUNTIME_PROVIDER_CHECK = (
    "provider_route IN ('openai', 'anthropic', 'gemini', 'openrouter', 'cloudflare')"
)


def upgrade() -> None:
    op.execute("""
        ALTER TABLE llm_calls
            ADD COLUMN IF NOT EXISTS provider_route text NULL,
            ADD COLUMN IF NOT EXISTS input_cost_usd_micros bigint NULL,
            ADD COLUMN IF NOT EXISTS output_cost_usd_micros bigint NULL,
            ADD COLUMN IF NOT EXISTS cache_write_cost_usd_micros bigint NULL,
            ADD COLUMN IF NOT EXISTS cache_read_cost_usd_micros bigint NULL,
            ADD COLUMN IF NOT EXISTS reasoning_cost_usd_micros bigint NULL,
            ADD COLUMN IF NOT EXISTS total_cost_usd_micros bigint NULL,
            ADD COLUMN IF NOT EXISTS cost_status text NULL,
            ADD COLUMN IF NOT EXISTS pricing_snapshot jsonb NULL
    """)
    op.execute("""
        UPDATE llm_calls
        SET provider_route = provider
        WHERE provider_route IS NULL
    """)
    op.execute("""
        UPDATE llm_calls
        SET cost_status = CASE
            WHEN input_tokens IS NULL
                AND output_tokens IS NULL
                AND total_tokens IS NULL
                AND reasoning_tokens IS NULL
                AND cache_write_input_tokens IS NULL
                AND cache_read_input_tokens IS NULL
                AND cached_input_tokens IS NULL
                THEN 'missing_usage'
            ELSE 'missing_pricing'
        END
        WHERE cost_status IS NULL
    """)
    op.execute("""
        UPDATE llm_calls
        SET pricing_snapshot = jsonb_build_object(
            'pricing_source', 'provider_runtime.catalog.DEFAULT_CATALOG',
            'provider', provider,
            'model', model_name,
            'route', provider_route,
            'cache_write_ttl', NULL,
            'pricing', jsonb_build_object(
                'input_per_million', NULL,
                'output_per_million', NULL,
                'cached_input_per_million', NULL,
                'cache_write_per_million_by_ttl', jsonb_build_object(),
                'reasoning_per_million', NULL,
                'reasoning_billing_mode', 'unknown',
                'applies_up_to_input_tokens', NULL,
                'source_url', NULL,
                'verified_at', NULL,
                'currency', 'USD',
                'unit', 'per_million_tokens'
            )
        )
        WHERE pricing_snapshot IS NULL
    """)
    op.execute("""
        ALTER TABLE llm_calls
            ALTER COLUMN provider_route SET NOT NULL,
            ALTER COLUMN cost_status SET NOT NULL
    """)
    op.execute("""
        ALTER TABLE llm_calls
            DROP CONSTRAINT IF EXISTS ck_llm_calls_provider_route,
            DROP CONSTRAINT IF EXISTS ck_llm_calls_cost_status,
            DROP CONSTRAINT IF EXISTS ck_llm_calls_input_cost_non_negative,
            DROP CONSTRAINT IF EXISTS ck_llm_calls_output_cost_non_negative,
            DROP CONSTRAINT IF EXISTS ck_llm_calls_cache_write_cost_non_negative,
            DROP CONSTRAINT IF EXISTS ck_llm_calls_cache_read_cost_non_negative,
            DROP CONSTRAINT IF EXISTS ck_llm_calls_reasoning_cost_non_negative,
            DROP CONSTRAINT IF EXISTS ck_llm_calls_total_cost_non_negative,
            DROP CONSTRAINT IF EXISTS ck_llm_calls_pricing_snapshot_object
    """)
    op.execute(f"""
        ALTER TABLE llm_calls
            ADD CONSTRAINT ck_llm_calls_provider_route CHECK ({_RUNTIME_PROVIDER_CHECK}),
            ADD CONSTRAINT ck_llm_calls_cost_status
                CHECK (
                    cost_status IN (
                        'estimated',
                        'missing_pricing',
                        'missing_usage',
                        'not_token_priced'
                    )
                ),
            ADD CONSTRAINT ck_llm_calls_input_cost_non_negative
                CHECK (input_cost_usd_micros IS NULL OR input_cost_usd_micros >= 0),
            ADD CONSTRAINT ck_llm_calls_output_cost_non_negative
                CHECK (output_cost_usd_micros IS NULL OR output_cost_usd_micros >= 0),
            ADD CONSTRAINT ck_llm_calls_cache_write_cost_non_negative
                CHECK (cache_write_cost_usd_micros IS NULL OR cache_write_cost_usd_micros >= 0),
            ADD CONSTRAINT ck_llm_calls_cache_read_cost_non_negative
                CHECK (cache_read_cost_usd_micros IS NULL OR cache_read_cost_usd_micros >= 0),
            ADD CONSTRAINT ck_llm_calls_reasoning_cost_non_negative
                CHECK (reasoning_cost_usd_micros IS NULL OR reasoning_cost_usd_micros >= 0),
            ADD CONSTRAINT ck_llm_calls_total_cost_non_negative
                CHECK (total_cost_usd_micros IS NULL OR total_cost_usd_micros >= 0),
            ADD CONSTRAINT ck_llm_calls_pricing_snapshot_object
                CHECK (pricing_snapshot IS NULL OR jsonb_typeof(pricing_snapshot) = 'object')
    """)


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0152 is not reversible")
