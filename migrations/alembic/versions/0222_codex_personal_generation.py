"""Hard-cut every generation onto the Codex-personal durable ledger.

Revision ID: 0222
Revises: 0221
Create Date: 2026-08-24
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql
from sqlalchemy.engine import Row

revision: str = "0222"
down_revision: str | Sequence[str] | None = "0221"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_GENERATION_JOB_KINDS = (
    "enrich_metadata",
    "chat_run",
    "dossier_build",
    "oracle_reading_generate",
    "media_unit_build",
    "synapse_scan",
    "dawn_write_job",
)
_ACTIVE_JOB_STATUSES = ("pending", "running", "failed", "dead")
_LLM_CALL_GENERATION_SEQ_CHECK = "generation_seq >= 1"
_LLM_CALL_OWNER_OPERATION_CHECK = """
(
    operation = 'metadata_enrichment' AND owner_kind = 'media_enrichment'
) OR (
    operation = 'media_summary' AND owner_kind = 'media_summary'
) OR (
    operation = 'synapse' AND owner_kind = 'synapse_scan'
) OR (
    operation = 'dawn_write' AND owner_kind = 'dawn_write'
) OR (
    operation = 'oracle' AND owner_kind = 'oracle_reading'
) OR (
    operation IN (
        'dossier_page',
        'dossier_note',
        'dossier_media',
        'dossier_conversation',
        'dossier_library',
        'dossier_podcast',
        'dossier_contributor',
        'dossier_idea'
    ) AND owner_kind = 'artifact_build'
) OR (
    operation = 'dossier_idea_resolve' AND owner_kind = 'artifact_learn_request'
) OR (
    operation = 'chat' AND owner_kind = 'chat_run'
)
"""
_LLM_CALL_PLAN_CAPABILITY_CHECK = """
plan_revision = 'codex-generation.2026-08-24.2'
AND (
    operation IN (
        'metadata_enrichment',
        'media_summary',
        'synapse',
        'dossier_page',
        'dossier_note',
        'dossier_idea_resolve'
    )
    AND plan_id = 'routine'
    AND model_name = 'gpt-5.6-luna'
    AND reasoning_effort = 'low'
    AND capability_kind = 'Synthesis'
    OR operation IN (
        'dawn_write',
        'oracle',
        'dossier_media',
        'dossier_conversation'
    )
    AND plan_id = 'standard'
    AND model_name = 'gpt-5.6-terra'
    AND reasoning_effort = 'medium'
    AND capability_kind = 'Synthesis'
    OR operation IN (
        'dossier_library',
        'dossier_podcast',
        'dossier_contributor',
        'dossier_idea'
    )
    AND plan_id = 'thorough'
    AND model_name = 'gpt-5.6-terra'
    AND reasoning_effort = 'high'
    AND capability_kind = 'Synthesis'
    OR operation = 'chat'
    AND capability_kind = 'ChatTools'
    AND (
        plan_id = 'routine'
        AND model_name = 'gpt-5.6-luna'
        AND reasoning_effort = 'low'
        OR plan_id = 'standard'
        AND model_name = 'gpt-5.6-terra'
        AND reasoning_effort = 'medium'
        OR plan_id = 'deep'
        AND model_name = 'gpt-5.6-sol'
        AND reasoning_effort = 'high'
    )
)
"""
_LLM_CALL_ROUTE_CHECK = """
backend = 'codex'
AND transport = 'sdk'
AND auth_profile = 'codex-personal'
"""
_LLM_CALL_FINGERPRINTS_CHECK = """
request_fingerprint ~ '^[0-9a-f]{64}$'
AND output_schema_fingerprint ~ '^[0-9a-f]{64}$'
AND (
    operation = 'chat'
    AND output_schema_fingerprint =
        '3f0d42022e6069f00f4048e3a091c1b225e739ef73e2d0a9fcee8986da69e9e7'
    AND tool_plan_fingerprint IS NOT NULL
    AND tool_plan_fingerprint =
        '62494626c69ba139121e1b761e4e2def6ca50ccf1ebfde551f8de061efef049c'
    OR operation <> 'chat' AND tool_plan_fingerprint IS NULL
)
"""
_LLM_CALL_SESSION_REF_CHECK = """
session_ref IS NULL OR (
    jsonb_typeof(session_ref) = 'object'
    AND session_ref ?& ARRAY[
        'schema_version',
        'backend',
        'transport',
        'native_session_id',
        'profile_key',
        'state_root_fingerprint',
        'cwd_fingerprint'
    ]
    AND session_ref - ARRAY[
        'schema_version',
        'backend',
        'transport',
        'native_session_id',
        'profile_key',
        'state_root_fingerprint',
        'cwd_fingerprint'
    ] = '{}'::jsonb
    AND jsonb_typeof(session_ref->'schema_version') = 'string'
    AND jsonb_typeof(session_ref->'backend') = 'string'
    AND jsonb_typeof(session_ref->'transport') = 'string'
    AND jsonb_typeof(session_ref->'native_session_id') = 'string'
    AND jsonb_typeof(session_ref->'profile_key') = 'string'
    AND jsonb_typeof(session_ref->'state_root_fingerprint') = 'string'
    AND jsonb_typeof(session_ref->'cwd_fingerprint') = 'string'
    AND session_ref->>'schema_version' = 'agent-session-ref.v1'
    AND session_ref->>'backend' = backend
    AND session_ref->>'transport' = transport
    AND session_ref->>'profile_key' = auth_profile
    AND char_length(session_ref->>'native_session_id') BETWEEN 1 AND 256
    AND session_ref->>'state_root_fingerprint' ~ '^[0-9a-f]{64}$'
    AND session_ref->>'cwd_fingerprint' ~ '^[0-9a-f]{64}$'
)
"""
_LLM_CALL_USAGE_CHECK = """
(
    input_tokens IS NULL
    AND output_tokens IS NULL
    AND total_tokens IS NULL
    AND reasoning_tokens IS NULL
    AND cache_read_input_tokens IS NULL
    AND cache_write_input_tokens IS NULL
) OR (
    input_tokens IS NOT NULL AND input_tokens >= 0
    AND output_tokens IS NOT NULL AND output_tokens >= 0
    AND total_tokens IS NOT NULL AND total_tokens >= 0
    AND (reasoning_tokens IS NULL OR reasoning_tokens >= 0)
    AND (cache_read_input_tokens IS NULL OR cache_read_input_tokens >= 0)
    AND (cache_write_input_tokens IS NULL OR cache_write_input_tokens >= 0)
)
"""
# Host acceptance precedes SDK session open. Accepted failure/cancellation may
# therefore have no session reference; accepted success may not.
_LLM_CALL_LIFECYCLE_CHECK = """
(
    outcome IS NULL
    AND completed_at IS NULL
    AND accepted_at IS NULL
    AND session_ref IS NULL
    AND error_code IS NULL
    AND error_detail IS NULL
    AND input_tokens IS NULL
    AND output_tokens IS NULL
    AND total_tokens IS NULL
    AND reasoning_tokens IS NULL
    AND cache_read_input_tokens IS NULL
    AND cache_write_input_tokens IS NULL
    AND sdk_version IS NULL
    AND runtime_version IS NULL
    AND latency_ms IS NULL
) OR (
    accepted_at IS NULL
    AND completed_at IS NOT NULL
    AND session_ref IS NULL
    AND input_tokens IS NULL
    AND output_tokens IS NULL
    AND total_tokens IS NULL
    AND reasoning_tokens IS NULL
    AND cache_read_input_tokens IS NULL
    AND cache_write_input_tokens IS NULL
    AND sdk_version IS NULL
    AND runtime_version IS NULL
    AND latency_ms IS NULL
    AND (
        outcome = 'Failed'
        AND error_code IS NOT NULL
        AND error_code IN (
            'auth',
            'quota',
            'timeout',
            'output_limit',
            'invalid_output',
            'policy_violation',
            'runtime_unavailable',
            'capacity_unavailable',
            'context_too_large',
            'defect'
        )
        AND error_detail IS NOT NULL
        AND char_length(error_detail) <= 1000
        AND error_detail ~ '[^[:space:]]'
        OR outcome = 'Cancelled'
        AND error_code IS NULL
        AND error_detail IS NOT NULL
        AND char_length(error_detail) <= 1000
        AND error_detail ~ '[^[:space:]]'
    )
) OR (
    accepted_at IS NOT NULL
    AND completed_at IS NOT NULL
    AND sdk_version IS NOT NULL
    AND char_length(sdk_version) BETWEEN 1 AND 128
    AND runtime_version IS NOT NULL
    AND char_length(runtime_version) BETWEEN 1 AND 128
    AND latency_ms IS NOT NULL
    AND latency_ms >= 0
    AND (
        outcome = 'Succeeded'
        AND session_ref IS NOT NULL
        AND error_code IS NULL
        AND error_detail IS NULL
        OR outcome = 'Failed'
        AND error_code IS NOT NULL
        AND error_code IN (
            'auth',
            'quota',
            'timeout',
            'output_limit',
            'invalid_output',
            'policy_violation',
            'runtime_unavailable',
            'capacity_unavailable',
            'context_too_large',
            'defect'
        )
        AND error_detail IS NOT NULL
        AND char_length(error_detail) <= 1000
        AND error_detail ~ '[^[:space:]]'
        OR outcome = 'Cancelled'
        AND error_code IS NULL
        AND error_detail IS NOT NULL
        AND char_length(error_detail) <= 1000
        AND error_detail ~ '[^[:space:]]'
    )
)
"""


def _fail(message: str) -> None:
    raise RuntimeError(f"0222 preflight: {message}")


def _ids(rows: Sequence[Row[Any]]) -> list[str]:
    return [str(row[0]) for row in rows]


def _preflight(bind: sa.Connection) -> None:
    """Refuse every live or legacy-dispatchable generation before mutation."""

    active_jobs = bind.execute(
        sa.text(
            """
            SELECT id
            FROM background_jobs
            WHERE kind = ANY(CAST(:kinds AS text[]))
              AND status = ANY(CAST(:statuses AS text[]))
            ORDER BY id
            """
        ),
        {"kinds": list(_GENERATION_JOB_KINDS), "statuses": list(_ACTIVE_JOB_STATUSES)},
    ).all()
    if active_jobs:
        _fail(f"generation jobs must be drained: {_ids(active_jobs)}")

    active_chat_runs = bind.execute(
        sa.text(
            """
            SELECT id FROM chat_runs
            WHERE status NOT IN ('complete', 'error', 'cancelled')
            ORDER BY id
            """
        )
    ).all()
    if active_chat_runs:
        _fail(f"chat runs must be terminal: {_ids(active_chat_runs)}")

    active_builds = bind.execute(
        sa.text(
            """
            SELECT builds.id
            FROM artifact_builds AS builds
            LEFT JOIN artifact_revisions AS revisions ON revisions.build_id = builds.id
            LEFT JOIN artifact_build_failures AS failures ON failures.build_id = builds.id
            LEFT JOIN artifact_build_cancellations AS cancellations
              ON cancellations.build_id = builds.id
            WHERE revisions.id IS NULL
              AND failures.id IS NULL
              AND cancellations.id IS NULL
            ORDER BY builds.id
            """
        )
    ).all()
    if active_builds:
        _fail(f"artifact builds must have a terminal child: {_ids(active_builds)}")

    uncertain_jobs = bind.execute(
        sa.text(
            """
            SELECT jobs.id
            FROM background_jobs AS jobs
            CROSS JOIN LATERAL jsonb_each(
                CASE
                    WHEN jsonb_typeof(jobs.payload->'coordination') = 'object'
                    THEN jobs.payload->'coordination'
                    ELSE '{}'::jsonb
                END
            ) AS step(path, state)
            WHERE step.state->>'dispatch_phase' = 'Uncertain'
            ORDER BY jobs.id
            """
        )
    ).all()
    if uncertain_jobs:
        _fail(f"queue journals contain Uncertain generations: {_ids(uncertain_jobs)}")

    incompatible_learn = bind.execute(
        sa.text(
            """
            SELECT requests.id
            FROM artifact_learn_requests AS requests
            LEFT JOIN artifact_learn_successes AS successes
              ON successes.request_id = requests.id
            LEFT JOIN artifact_learn_failures AS failures
              ON failures.request_id = requests.id
            WHERE successes.request_id IS NULL
              AND failures.request_id IS NULL
              AND (
                  requests.coordination <> '{}'::jsonb
                  OR requests.resolver_lease_expires_at IS NOT NULL
              )
            ORDER BY requests.id
            """
        )
    ).all()
    if incompatible_learn:
        _fail(
            f"pending Learn requests retain pre-cutover resolver state: {_ids(incompatible_learn)}"
        )

    legacy_intents = bind.execute(
        sa.text(
            """
            SELECT id
            FROM background_jobs
            WHERE jsonb_typeof(payload->'coordination') = 'object'
              AND (
                  payload::text LIKE '%generate_intent%'
                  OR payload::text LIKE '%continuation%'
              )
            ORDER BY id
            """
        )
    ).all()
    if legacy_intents:
        _fail(
            "queue journals retain GenerateIntentState or ContinuationState: "
            f"{_ids(legacy_intents)}"
        )


def _create_generation_ledger() -> None:
    op.create_table(
        "llm_calls",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("owner_kind", sa.Text(), nullable=False),
        sa.Column("owner_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("generation_seq", sa.Integer(), nullable=False),
        sa.Column("operation", sa.Text(), nullable=False),
        sa.Column("plan_id", sa.Text(), nullable=False),
        sa.Column("plan_revision", sa.Text(), nullable=False),
        sa.Column("backend", sa.Text(), nullable=False),
        sa.Column("transport", sa.Text(), nullable=False),
        sa.Column("auth_profile", sa.Text(), nullable=False),
        sa.Column("model_name", sa.Text(), nullable=False),
        sa.Column("reasoning_effort", sa.Text(), nullable=False),
        sa.Column("capability_kind", sa.Text(), nullable=False),
        sa.Column("request_fingerprint", sa.Text(), nullable=False),
        sa.Column("output_schema_fingerprint", sa.Text(), nullable=False),
        sa.Column("tool_plan_fingerprint", sa.Text(), nullable=True),
        sa.Column("streaming", sa.Boolean(), nullable=False),
        sa.Column(
            "session_ref",
            postgresql.JSONB(astext_type=sa.Text(), none_as_null=True),
            nullable=True,
        ),
        sa.Column("outcome", sa.Text(), nullable=True),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column("error_detail", sa.Text(), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("total_tokens", sa.Integer(), nullable=True),
        sa.Column("reasoning_tokens", sa.Integer(), nullable=True),
        sa.Column("cache_read_input_tokens", sa.Integer(), nullable=True),
        sa.Column("cache_write_input_tokens", sa.Integer(), nullable=True),
        sa.Column("sdk_version", sa.Text(), nullable=True),
        sa.Column("runtime_version", sa.Text(), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("accepted_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("completed_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.CheckConstraint(
            _LLM_CALL_GENERATION_SEQ_CHECK,
            name="ck_llm_calls_generation_seq_positive",
        ),
        sa.CheckConstraint(
            _LLM_CALL_OWNER_OPERATION_CHECK,
            name="ck_llm_calls_owner_operation",
        ),
        sa.CheckConstraint(
            _LLM_CALL_PLAN_CAPABILITY_CHECK,
            name="ck_llm_calls_plan_capability",
        ),
        sa.CheckConstraint(_LLM_CALL_ROUTE_CHECK, name="ck_llm_calls_route"),
        sa.CheckConstraint(
            _LLM_CALL_FINGERPRINTS_CHECK,
            name="ck_llm_calls_fingerprints",
        ),
        sa.CheckConstraint(
            _LLM_CALL_SESSION_REF_CHECK,
            name="ck_llm_calls_session_ref",
        ),
        sa.CheckConstraint(_LLM_CALL_USAGE_CHECK, name="ck_llm_calls_usage"),
        sa.CheckConstraint(
            _LLM_CALL_LIFECYCLE_CHECK,
            name="ck_llm_calls_lifecycle",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "owner_kind",
            "owner_id",
            "generation_seq",
            name="uq_llm_calls_owner_generation_seq",
        ),
    )
    op.create_index("ix_llm_calls_owner", "llm_calls", ["owner_kind", "owner_id"])


def upgrade() -> None:
    bind = op.get_bind()
    _preflight(bind)

    op.execute("DELETE FROM llm_calls")
    op.drop_table("llm_calls")
    op.drop_table("agent_turns")
    op.drop_table("token_budget_charges")
    op.drop_table("token_budget_reservations")
    op.drop_table("token_budget_daily_usage")

    op.drop_constraint(
        "ck_billing_entitlement_overrides_platform_token_limit",
        "billing_entitlement_overrides",
        type_="check",
    )
    op.drop_constraint(
        "ck_billing_entitlement_overrides_platform_token_quota_mode",
        "billing_entitlement_overrides",
        type_="check",
    )
    op.drop_column("billing_entitlement_overrides", "platform_token_limit_monthly")
    op.drop_column("billing_entitlement_overrides", "platform_token_quota_mode")

    op.drop_column("chat_runs", "reasoning_option_id")
    op.drop_column("chat_runs", "provider")
    op.drop_column("chat_runs", "error_origin")

    _create_generation_ledger()
    bind.execute(
        sa.text(
            """
            UPDATE background_jobs
            SET payload = jsonb_set(payload, '{capacity_wait_index}', '0'::jsonb, true),
                updated_at = clock_timestamp()
            WHERE kind = ANY(CAST(:kinds AS text[]))
            """
        ),
        {"kinds": list(_GENERATION_JOB_KINDS)},
    )


def downgrade() -> None:
    raise NotImplementedError("0222 is an irreversible Codex-personal generation hard cutover")
