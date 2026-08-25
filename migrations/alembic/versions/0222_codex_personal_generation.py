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

    uncertain_learn = bind.execute(
        sa.text(
            """
            SELECT requests.id
            FROM artifact_learn_requests AS requests
            CROSS JOIN LATERAL jsonb_each(
                CASE
                    WHEN jsonb_typeof(requests.coordination) = 'object'
                    THEN requests.coordination
                    ELSE '{}'::jsonb
                END
            ) AS step(path, state)
            WHERE step.state->>'dispatch_phase' = 'Uncertain'
            ORDER BY requests.id
            """
        )
    ).all()
    if uncertain_learn:
        _fail(f"Learn journals contain Uncertain generations: {_ids(uncertain_learn)}")

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
        sa.CheckConstraint(
            "owner_kind IN ("
            "'chat_run', 'oracle_reading', 'artifact_build', "
            "'artifact_learn_request', 'media_summary', 'synapse_scan', "
            "'dawn_write', 'media_enrichment'"
            ")",
            name="ck_llm_calls_owner_kind",
        ),
        sa.CheckConstraint(
            "outcome IS NULL OR outcome IN ('Succeeded', 'Cancelled', 'Failed')",
            name="ck_llm_calls_outcome",
        ),
        sa.CheckConstraint(
            "operation IN ("
            "'metadata_enrichment', 'media_summary', 'synapse', 'dawn_write', 'oracle', "
            "'dossier_page', 'dossier_note', 'dossier_media', 'dossier_conversation', "
            "'dossier_library', 'dossier_podcast', 'dossier_contributor', "
            "'dossier_idea', 'dossier_idea_resolve', 'chat'"
            ")",
            name="ck_llm_calls_operation",
        ),
        sa.CheckConstraint(
            "(owner_kind = 'media_enrichment' AND operation = 'metadata_enrichment') OR "
            "(owner_kind = 'media_summary' AND operation = 'media_summary') OR "
            "(owner_kind = 'synapse_scan' AND operation = 'synapse') OR "
            "(owner_kind = 'dawn_write' AND operation = 'dawn_write') OR "
            "(owner_kind = 'oracle_reading' AND operation = 'oracle') OR "
            "(owner_kind = 'artifact_build' AND operation IN ("
            "'dossier_page', 'dossier_note', 'dossier_media', 'dossier_conversation', "
            "'dossier_library', 'dossier_podcast', 'dossier_contributor', 'dossier_idea'"
            ")) OR "
            "(owner_kind = 'artifact_learn_request' AND operation = 'dossier_idea_resolve') OR "
            "(owner_kind = 'chat_run' AND operation = 'chat')",
            name="ck_llm_calls_owner_operation",
        ),
        sa.CheckConstraint(
            "(operation IN ("
            "'metadata_enrichment', 'media_summary', 'synapse', 'dossier_page', "
            "'dossier_note', 'dossier_idea_resolve'"
            ") AND plan_id = 'routine') OR "
            "(operation IN ("
            "'dawn_write', 'oracle', 'dossier_media', 'dossier_conversation'"
            ") AND plan_id = 'standard') OR "
            "(operation IN ("
            "'dossier_library', 'dossier_podcast', 'dossier_contributor', 'dossier_idea'"
            ") AND plan_id = 'thorough') OR "
            "(operation = 'chat' AND plan_id IN ('routine', 'standard', 'deep'))",
            name="ck_llm_calls_operation_plan",
        ),
        sa.CheckConstraint(
            "(plan_id = 'routine' AND model_name = 'gpt-5.6-luna' "
            "AND reasoning_effort = 'low') OR "
            "(plan_id = 'standard' AND model_name = 'gpt-5.6-terra' "
            "AND reasoning_effort = 'medium') OR "
            "(plan_id = 'thorough' AND model_name = 'gpt-5.6-terra' "
            "AND reasoning_effort = 'high') OR "
            "(plan_id = 'deep' AND model_name = 'gpt-5.6-sol' "
            "AND reasoning_effort = 'high')",
            name="ck_llm_calls_plan_target",
        ),
        sa.CheckConstraint(
            "backend = 'codex' AND transport = 'sdk' "
            "AND auth_profile = 'codex-personal'",
            name="ck_llm_calls_route",
        ),
        sa.CheckConstraint(
            "(operation = 'chat' AND capability_kind = 'ChatTools' "
            "AND tool_plan_fingerprint IS NOT NULL) OR "
            "(operation <> 'chat' AND capability_kind = 'Synthesis' "
            "AND tool_plan_fingerprint IS NULL)",
            name="ck_llm_calls_capability",
        ),
        sa.CheckConstraint(
            "request_fingerprint ~ '^[0-9a-f]{64}$' "
            "AND output_schema_fingerprint ~ '^[0-9a-f]{64}$' "
            "AND (tool_plan_fingerprint IS NULL "
            "OR tool_plan_fingerprint ~ '^[0-9a-f]{64}$')",
            name="ck_llm_calls_fingerprints",
        ),
        sa.CheckConstraint(
            "char_length(plan_revision) BETWEEN 1 AND 128 "
            "AND (error_detail IS NULL OR char_length(error_detail) <= 1000)",
            name="ck_llm_calls_bounded_text",
        ),
        sa.CheckConstraint(
            "error_code IS NULL OR error_code IN ("
            "'auth', 'quota', 'timeout', 'output_limit', 'invalid_output', "
            "'policy_violation', 'runtime_unavailable', 'capacity_unavailable', "
            "'context_too_large', 'defect'"
            ")",
            name="ck_llm_calls_error_code",
        ),
        sa.CheckConstraint(
            "(outcome = 'Failed') = (error_code IS NOT NULL)",
            name="ck_llm_calls_failure_shape",
        ),
        sa.CheckConstraint(
            "(input_tokens IS NULL AND output_tokens IS NULL AND total_tokens IS NULL "
            "AND reasoning_tokens IS NULL AND cache_read_input_tokens IS NULL "
            "AND cache_write_input_tokens IS NULL) OR "
            "(input_tokens >= 0 AND output_tokens >= 0 AND total_tokens >= 0 "
            "AND (reasoning_tokens IS NULL OR reasoning_tokens >= 0) "
            "AND (cache_read_input_tokens IS NULL OR cache_read_input_tokens >= 0) "
            "AND (cache_write_input_tokens IS NULL OR cache_write_input_tokens >= 0))",
            name="ck_llm_calls_usage",
        ),
        sa.CheckConstraint(
            "session_ref IS NULL OR (jsonb_typeof(session_ref) = 'object' "
            "AND session_ref->>'backend' = backend "
            "AND session_ref->>'transport' = transport "
            "AND session_ref->>'profile_key' = auth_profile)",
            name="ck_llm_calls_session_route",
        ),
        sa.CheckConstraint(
            "(outcome IS NULL AND completed_at IS NULL AND accepted_at IS NULL "
            "AND session_ref IS NULL AND error_code IS NULL AND error_detail IS NULL "
            "AND input_tokens IS NULL AND output_tokens IS NULL AND total_tokens IS NULL "
            "AND reasoning_tokens IS NULL AND cache_read_input_tokens IS NULL "
            "AND cache_write_input_tokens IS NULL AND sdk_version IS NULL "
            "AND runtime_version IS NULL AND latency_ms IS NULL) OR "
            "(outcome IS NOT NULL AND completed_at IS NOT NULL AND ("
            "(accepted_at IS NULL AND outcome = 'Failed' AND session_ref IS NULL "
            "AND input_tokens IS NULL AND output_tokens IS NULL AND total_tokens IS NULL "
            "AND reasoning_tokens IS NULL AND cache_read_input_tokens IS NULL "
            "AND cache_write_input_tokens IS NULL AND sdk_version IS NULL "
            "AND runtime_version IS NULL AND latency_ms IS NULL) OR "
            "(accepted_at IS NOT NULL AND sdk_version IS NOT NULL "
            "AND runtime_version IS NOT NULL AND latency_ms >= 0 "
            "AND error_code IS DISTINCT FROM 'capacity_unavailable'))) ",
            name="ck_llm_calls_lifecycle",
        ),
        sa.CheckConstraint(
            "generation_seq > 0",
            name="ck_llm_calls_generation_seq_positive",
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
