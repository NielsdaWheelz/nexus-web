"""Hard-cut every generation onto the Codex-personal durable ledger.

Revision ID: 0224
Revises: 0223
Create Date: 2026-08-24
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql
from sqlalchemy.engine import Row

revision: str = "0224"
down_revision: str | Sequence[str] | None = "0223"
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
_HISTORICAL_DOSSIER_FAILURE_CODES = (
    "EntitlementDenied",
    "BudgetExceeded",
    "ProviderRefused",
    "ProviderIncomplete",
)
_HISTORICAL_ORACLE_FAILURE_CODES = (
    "defect",
    "E_INTERNAL",
    "E_BILLING_REQUIRED",
    "E_TOKEN_BUDGET_EXCEEDED",
    "budget_exceeded",
    "invalid_structured_output",
    "refused",
    "incomplete",
    "rate_limited",
    "provider_unavailable",
    "stream_interrupted",
)
_CURRENT_ORACLE_FAILURE_CODES = (
    "auth",
    "quota",
    "timeout",
    "output_limit",
    "invalid_output",
    "policy_violation",
    "runtime_unavailable",
    "capacity_unavailable",
    "context_too_large",
    "cancelled",
    "E_ORACLE_CORPUS_NOT_READY",
    "E_APP_SEARCH_FAILED",
    "E_GENERATION_SOURCE_CHANGED",
    "E_RATE_LIMITED",
)


def _fail(message: str) -> None:
    raise RuntimeError(f"0224 preflight: {message}")


def _ids(rows: Sequence[Row[Any]]) -> list[str]:
    return [str(row[0]) for row in rows]


def _preflight(bind: sa.Connection) -> None:
    """Refuse every live or legacy-dispatchable generation before mutation."""

    nonterminal_llm_calls = bind.execute(
        sa.text(
            """
            SELECT id
            FROM llm_calls
            WHERE outcome IS NULL
            ORDER BY id
            """
        )
    ).all()
    if nonterminal_llm_calls:
        _fail(f"legacy llm_calls must be terminal: {_ids(nonterminal_llm_calls)}")

    nonterminal_agent_turns = bind.execute(
        sa.text(
            """
            SELECT id
            FROM agent_turns
            WHERE outcome IS NULL OR completed_at IS NULL
            ORDER BY id
            """
        )
    ).all()
    if nonterminal_agent_turns:
        _fail(f"legacy agent_turns must be terminal: {_ids(nonterminal_agent_turns)}")

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

    unsupported_oracle_failures = bind.execute(
        sa.text(
            """
            SELECT id
            FROM oracle_readings
            WHERE status = 'failed'
              AND error_code != ALL(CAST(:codes AS text[]))
            ORDER BY id
            """
        ),
        {
            "codes": list(
                _CURRENT_ORACLE_FAILURE_CODES + _HISTORICAL_ORACLE_FAILURE_CODES
            )
        },
    ).all()
    if unsupported_oracle_failures:
        _fail(
            "Oracle failures use unsupported cutover codes: "
            f"{_ids(unsupported_oracle_failures)}"
        )

    malformed_oracle_failures = bind.execute(
        sa.text(
            """
            SELECT readings.id
            FROM oracle_readings AS readings
            LEFT JOIN LATERAL (
                SELECT events.event_type, events.payload
                FROM oracle_reading_events AS events
                WHERE events.reading_id = readings.id
                ORDER BY events.seq DESC
                LIMIT 1
            ) AS terminal ON true
            WHERE readings.status = 'failed'
              AND (
                  terminal.event_type IS DISTINCT FROM 'done'
                  OR terminal.payload ->> 'status' IS DISTINCT FROM 'failed'
                  OR terminal.payload ->> 'error_code'
                      IS DISTINCT FROM readings.error_code
              )
            ORDER BY readings.id
            """
        ),
    ).all()
    if malformed_oracle_failures:
        _fail(
            "Oracle failures require a matching terminal event: "
            f"{_ids(malformed_oracle_failures)}"
        )

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
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "owner_kind",
            "owner_id",
            "generation_seq",
            name="uq_llm_calls_owner_generation_seq",
        ),
    )


def _tag_historical_dossier_failure_events(bind: sa.Connection) -> None:
    """Give immutable pre-cutover failure replay explicit wire provenance."""

    op.drop_constraint(
        "ck_artifact_build_events_type",
        "artifact_build_events",
        type_="check",
    )
    bind.execute(
        sa.text(
            """
            UPDATE artifact_build_events
            SET event_type = 'HistoricalFailed'
            WHERE event_type = 'Failed'
              AND payload ->> 'failure_code' = ANY(CAST(:codes AS text[]))
            """
        ),
        {"codes": list(_HISTORICAL_DOSSIER_FAILURE_CODES)},
    )
    op.create_check_constraint(
        "ck_artifact_build_events_type",
        "artifact_build_events",
        "event_type IN ("
        "'Started', 'Progress', 'Succeeded', 'Failed', 'HistoricalFailed', 'Cancelled'"
        ")",
    )


def _tag_historical_oracle_failure_events(bind: sa.Connection) -> None:
    """Separate preserved provider-era failures from current Oracle writes."""

    op.drop_constraint(
        "ck_oracle_reading_events_type",
        "oracle_reading_events",
        type_="check",
    )
    bind.execute(
        sa.text(
            """
            UPDATE oracle_reading_events
            SET event_type = 'historical_done'
            WHERE event_type = 'done'
              AND payload ->> 'status' = 'failed'
              AND payload ->> 'error_code' = ANY(CAST(:codes AS text[]))
            """
        ),
        {"codes": list(_HISTORICAL_ORACLE_FAILURE_CODES)},
    )
    op.create_check_constraint(
        "ck_oracle_reading_events_type",
        "oracle_reading_events",
        "event_type IN ("
        "'meta', 'bind', 'argument', 'plate', 'passage', 'delta', 'omens', "
        "'done', 'historical_done'"
        ")",
    )


def upgrade() -> None:
    bind = op.get_bind()
    _preflight(bind)
    _tag_historical_dossier_failure_events(bind)
    _tag_historical_oracle_failure_events(bind)

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
    raise NotImplementedError(
        "0224 is an irreversible Codex-personal generation hard cutover"
    )
