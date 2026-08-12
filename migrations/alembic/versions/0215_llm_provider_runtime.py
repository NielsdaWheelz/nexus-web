"""Hard-cut the LLM provider ledger and prompt audit facts to runtime v2.

Revision ID: 0215
Revises: 0214
Create Date: 2026-08-11
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0215"
down_revision: str | Sequence[str] | None = "0214"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _fail(message: str) -> None:
    raise RuntimeError(f"0215 preflight: {message}")


def _refuse_live_chat_coordination(bind: sa.engine.Connection) -> None:
    rows = bind.execute(
        sa.text(
            """
            SELECT id, status
            FROM background_jobs
            WHERE kind = 'chat_run' AND status <> 'succeeded'
            ORDER BY id
            """
        )
    ).all()
    if not rows:
        return
    details = ", ".join(f"{row.id}:{row.status}" for row in rows)
    _fail(
        f"{len(rows)} non-succeeded chat_run job(s) still own durable coordination; "
        f"repair to completion or domain-cancel before retrying: {details}"
    )


def _refuse_running_non_chat_llm_jobs(bind: sa.engine.Connection) -> None:
    rows = bind.execute(
        sa.text(
            """
            SELECT id, kind
            FROM background_jobs
            WHERE status = 'running'
              AND kind = ANY(CAST(:kinds AS text[]))
            ORDER BY kind, id
            """
        ),
        {
            "kinds": [
                "dossier_build",
                "oracle_reading_generate",
                "media_unit_build",
                "enrich_metadata",
                "synapse_scan",
                "dawn_write_job",
            ]
        },
    ).all()
    if not rows:
        return
    details = ", ".join(f"{row.kind}:{row.id}" for row in rows)
    _fail(
        f"{len(rows)} running non-chat LLM job(s) still own old-runtime execution; "
        f"stop both worker lanes and drain or fail them before retrying: {details}"
    )


def _rewrite_prompt_manifests() -> None:
    op.execute(
        """
        UPDATE chat_prompt_assemblies
        SET prompt_block_manifest =
            CASE
                WHEN jsonb_typeof(prompt_block_manifest -> 'blocks') = 'array'
                THEN jsonb_set(
                    prompt_block_manifest - 'cacheable_input_tokens_estimate',
                    '{blocks}',
                    COALESCE(
                        (
                            SELECT jsonb_agg(
                                block
                                    - 'cache_policy'
                                    - 'privacy_scope'
                                    - 'required_provider_capability'
                                ORDER BY ordinal
                            )
                            FROM jsonb_array_elements(prompt_block_manifest -> 'blocks')
                                WITH ORDINALITY AS manifest_blocks(block, ordinal)
                        ),
                        '[]'::jsonb
                    ),
                    false
                )
                ELSE prompt_block_manifest - 'cacheable_input_tokens_estimate'
            END,
            dropped_items = COALESCE(
                (
                    SELECT jsonb_agg(
                        CASE
                            WHEN jsonb_typeof(item -> 'blocks') = 'array'
                            THEN jsonb_set(
                                item,
                                '{blocks}',
                                COALESCE(
                                    (
                                        SELECT jsonb_agg(
                                            block
                                                - 'cache_policy'
                                                - 'privacy_scope'
                                                - 'required_provider_capability'
                                            ORDER BY block_ordinal
                                        )
                                        FROM jsonb_array_elements(item -> 'blocks')
                                            WITH ORDINALITY AS item_blocks(
                                                block,
                                                block_ordinal
                                            )
                                    ),
                                    '[]'::jsonb
                                ),
                                false
                            )
                            ELSE item
                        END
                        ORDER BY item_ordinal
                    )
                    FROM jsonb_array_elements(dropped_items)
                        WITH ORDINALITY AS dropped(item, item_ordinal)
                ),
                '[]'::jsonb
            ),
            budget_breakdown = budget_breakdown - 'reserved_reasoning_tokens'
        """
    )


def _assert_no_manifest_residue(bind: sa.engine.Connection) -> None:
    residue = bind.execute(
        sa.text(
            """
            SELECT id
            FROM chat_prompt_assemblies
            WHERE prompt_block_manifest @? '$.**.cacheable_input_tokens_estimate'
               OR prompt_block_manifest @? '$.**.cache_policy'
               OR prompt_block_manifest @? '$.**.privacy_scope'
               OR prompt_block_manifest @? '$.**.required_provider_capability'
               OR dropped_items @? '$.**.cache_policy'
               OR dropped_items @? '$.**.privacy_scope'
               OR dropped_items @? '$.**.required_provider_capability'
               OR budget_breakdown @? '$.**.reserved_reasoning_tokens'
            ORDER BY id
            """
        )
    ).all()
    if residue:
        ids = ", ".join(str(row.id) for row in residue)
        raise RuntimeError(
            "0215 manifest rewrite left retired cache/reasoning fields in "
            f"chat_prompt_assemblies: {ids}"
        )


def upgrade() -> None:
    bind = op.get_bind()

    # Old chat intent payloads have no v2 reader. Refuse every live/suspended
    # journal before the first mutation; succeeded queue rows are expendable
    # coordination, while chat_runs/messages/events remain durable domain data.
    _refuse_live_chat_coordination(bind)
    _refuse_running_non_chat_llm_jobs(bind)
    op.execute("DELETE FROM background_jobs WHERE kind = 'chat_run' AND status = 'succeeded'")

    op.execute(
        """
        ALTER TABLE llm_calls
            ADD COLUMN requested_reasoning text NULL,
            ADD COLUMN native_reasoning text NULL,
            ADD COLUMN registry_revision text NULL,
            ADD COLUMN cost_source text NULL,
            ADD COLUMN cost_as_of date NULL
        """
    )
    op.execute(
        """
        UPDATE llm_calls
        SET native_reasoning = CASE
                WHEN catalog_revision IS NOT NULL THEN reasoning_effort
                ELSE NULL
            END,
            cost_source = CASE
                WHEN cost_status = 'estimated' THEN 'provider-runtime-v1'
                ELSE NULL
            END,
            cost_as_of = NULL,
            cost_status = CASE
                WHEN cost_status = 'not_token_priced' THEN 'missing_pricing'
                ELSE cost_status
            END
        """
    )

    _rewrite_prompt_manifests()

    # These checks encode retired business correlations or name columns that
    # are about to disappear. The final schema deliberately does not replace
    # them; terminal correlation is validated at the application write owner.
    op.execute(
        """
        ALTER TABLE llm_calls
            DROP CONSTRAINT ck_llm_calls_token_counts_non_negative,
            DROP CONSTRAINT ck_llm_calls_provider_usage_object,
            DROP CONSTRAINT ck_llm_calls_cost_status,
            DROP CONSTRAINT ck_llm_calls_input_cost_non_negative,
            DROP CONSTRAINT ck_llm_calls_output_cost_non_negative,
            DROP CONSTRAINT ck_llm_calls_cache_write_cost_non_negative,
            DROP CONSTRAINT ck_llm_calls_cache_read_cost_non_negative,
            DROP CONSTRAINT ck_llm_calls_reasoning_cost_non_negative,
            DROP CONSTRAINT ck_llm_calls_pricing_snapshot_object
        """
    )
    op.execute(
        """
        ALTER TABLE chat_prompt_assemblies
            DROP CONSTRAINT ck_chat_prompt_assemblies_token_budget,
            DROP CONSTRAINT ck_chat_prompt_assemblies_cacheable_tokens
        """
    )
    op.execute(
        """
        ALTER TABLE llm_calls
            DROP COLUMN reasoning_effort,
            DROP COLUMN catalog_revision,
            DROP COLUMN request_fingerprint,
            DROP COLUMN cache_strategy,
            DROP COLUMN cache_ttl,
            DROP COLUMN cached_input_tokens,
            DROP COLUMN input_cost_usd_micros,
            DROP COLUMN output_cost_usd_micros,
            DROP COLUMN cache_write_cost_usd_micros,
            DROP COLUMN cache_read_cost_usd_micros,
            DROP COLUMN reasoning_cost_usd_micros,
            DROP COLUMN pricing_snapshot,
            DROP COLUMN provider_usage
        """
    )
    op.execute(
        """
        ALTER TABLE chat_prompt_assemblies
            DROP COLUMN cacheable_input_tokens_estimate,
            DROP COLUMN reserved_reasoning_tokens
        """
    )

    _assert_no_manifest_residue(bind)


def downgrade() -> None:
    raise NotImplementedError(
        "0215 is an irreversible hard cutover: retired provider plans, accounting "
        "components, cache facts, and old chat coordination are not reconstructable"
    )
