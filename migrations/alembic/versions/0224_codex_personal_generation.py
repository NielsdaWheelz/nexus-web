"""Reset Chat/generation history and create the route-neutral generation ledger.

Revision ID: 0224
Revises: 0223
Create Date: 2026-08-31
"""

from __future__ import annotations

import hashlib
import re
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
_RESET_BLOCKING_JOB_STATUSES = ("pending", "running", "failed", "dead")
# Preflight still validates calls and journals before any mutation can begin.
_HEADLESS_RESETTABLE_DEAD_JOB_KINDS = ("synapse_scan",)
_RESETTABLE_ENRICHMENT_FAILURE_REASONS = (
    "no_provider",
    "rate_limit_rejected",
    "llm_rejected",
    "llm_failed",
    "parse_failed",
    "no_fields",
    "no_applicable_fields",
    "unexpected_error",
)
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

_RESET_OR_REPLACED_TABLES = frozenset(
    {
        "agent_turns",
        "chat_prompt_assemblies",
        "chat_run_events",
        "chat_run_turn_contexts",
        "chat_runs",
        "conversation_active_paths",
        "conversation_branches",
        "conversation_shares",
        "conversations",
        "llm_calls",
        "message_retrievals",
        "message_tool_calls",
        "messages",
        "token_budget_charges",
        "token_budget_daily_usage",
        "token_budget_reservations",
    }
)
_PARTIAL_DELETE_TABLES = frozenset(
    {
        "artifact_build_cancellations",
        "artifact_build_events",
        "artifact_build_failures",
        "artifact_builds",
        "artifact_idea_seeds",
        "artifact_learn_failures",
        "artifact_learn_requests",
        "artifact_learn_successes",
        "artifact_revisions",
        "artifacts",
        "background_jobs",
        "passage_anchors",
        "resource_edges",
        "resource_external_snapshots",
        "resource_grants",
        "resource_mutations",
        "resource_versions",
        "resource_view_states",
        "synapse_suppressions",
    }
)
# Every table from which this migration deletes or whose schema it replaces is
# a potential FK parent. Keeping the preflight inventory derived from the
# mutation plan makes a newly introduced child fail before any mutation.
_RESET_PARENT_TABLES = _RESET_OR_REPLACED_TABLES | _PARTIAL_DELETE_TABLES
_CLASSIFIED_RESET_FOREIGN_KEYS = frozenset(
    {
        ("artifact_build_cancellations", "build_id", "artifact_builds", "id"),
        ("artifact_build_events", "build_id", "artifact_builds", "id"),
        ("artifact_build_failures", "build_id", "artifact_builds", "id"),
        ("artifact_builds", "artifact_id", "artifacts", "id"),
        ("artifact_idea_seeds", "artifact_id", "artifacts", "id"),
        ("artifact_learn_failures", "request_id", "artifact_learn_requests", "id"),
        ("artifact_learn_successes", "artifact_id", "artifacts", "id"),
        ("artifact_learn_successes", "build_id", "artifact_builds", "id"),
        ("artifact_learn_successes", "request_id", "artifact_learn_requests", "id"),
        ("artifact_revisions", "build_id", "artifact_builds", "id"),
        ("artifacts", "current_revision_id", "artifact_revisions", "id"),
        ("background_job_capacity_leases", "job_id", "background_jobs", "id"),
        ("conversation_shares", "conversation_id", "conversations", "id"),
        ("messages", "conversation_id", "conversations", "id"),
        ("messages", "parent_message_id", "messages", "id"),
        ("messages", "branch_root_message_id", "messages", "id"),
        ("conversation_active_paths", "conversation_id", "conversations", "id"),
        ("conversation_active_paths", "active_leaf_message_id", "messages", "id"),
        ("conversation_branches", "conversation_id", "conversations", "id"),
        ("conversation_branches", "branch_user_message_id", "messages", "id"),
        ("message_tool_calls", "conversation_id", "conversations", "id"),
        ("message_tool_calls", "user_message_id", "messages", "id"),
        ("message_tool_calls", "assistant_message_id", "messages", "id"),
        ("message_retrievals", "tool_call_id", "message_tool_calls", "id"),
        ("media_source_attempts", "job_id", "background_jobs", "id"),
        ("chat_run_turn_contexts", "subject_context_edge_id", "resource_edges", "id"),
        ("oracle_reading_folios", "edge_id", "resource_edges", "id"),
        ("resource_view_states", "edge_id", "resource_edges", "id"),
        ("chat_runs", "conversation_id", "conversations", "id"),
        ("chat_runs", "user_message_id", "messages", "id"),
        ("chat_runs", "assistant_message_id", "messages", "id"),
        ("chat_run_turn_contexts", "chat_run_id", "chat_runs", "id"),
        ("chat_prompt_assemblies", "chat_run_id", "chat_runs", "id"),
        ("chat_prompt_assemblies", "conversation_id", "conversations", "id"),
        ("chat_prompt_assemblies", "assistant_message_id", "messages", "id"),
        ("chat_run_events", "run_id", "chat_runs", "id"),
    }
)
_NEW_GENERATION_TABLES = frozenset(
    {
        "assistant_write_authorships",
        "llm_calls",
        "llm_model_turn_continuations",
        "llm_model_turns",
        "llm_tool_positions",
    }
)
_EMPTY_AFTER_RESET_TABLES = frozenset(
    {
        "chat_prompt_assemblies",
        "chat_run_events",
        "chat_run_turn_contexts",
        "chat_runs",
        "conversation_active_paths",
        "conversation_branches",
        "conversation_shares",
        "conversations",
        "assistant_write_authorships",
        "llm_calls",
        "llm_model_turn_continuations",
        "llm_model_turns",
        "llm_tool_positions",
        "message_retrievals",
        "message_tool_calls",
        "messages",
    }
)
_IDENTIFIER = re.compile(r"^[a-z_][a-z0-9_]*$")
_CLASSIFIED_POLYMORPHIC_REFERENCES = frozenset(
    {
        ("resource_versions", "resource_scheme", "resource_id"),
        ("resource_view_states", "surface_scheme", "surface_id"),
        ("resource_view_states", "target_scheme", "target_id"),
        ("resource_edges", "source_scheme", "source_id"),
        ("resource_edges", "target_scheme", "target_id"),
        ("passage_anchors", "owner_scheme", "owner_id"),
        ("synapse_suppressions", "source_scheme", "source_id"),
        ("synapse_suppressions", "target_scheme", "target_id"),
        ("artifacts", "subject_scheme", "subject_id"),
        ("artifacts", "audience_scheme", "audience_id"),
        (
            "chat_run_turn_contexts",
            "requested_subject_scheme",
            "requested_subject_id",
        ),
        ("chat_run_turn_contexts", "subject_scheme", "subject_id"),
        ("resource_grants", "subject_scheme", "subject_id"),
    }
)


def _fail(message: str) -> None:
    raise RuntimeError(f"0224 preflight: {message}")


def _ids(rows: Sequence[Row[Any]]) -> list[str]:
    return [str(row[0]) for row in rows]


def _preflight(bind: sa.Connection) -> None:
    """Refuse live, uncertain, or unclassified state before any mutation."""

    nonterminal_llm_calls = bind.execute(
        sa.text("SELECT id FROM llm_calls WHERE outcome IS NULL ORDER BY id")
    ).all()
    if nonterminal_llm_calls:
        _fail(f"llm_calls must be terminal: {_ids(nonterminal_llm_calls)}")

    nonterminal_agent_turns = bind.execute(
        sa.text(
            "SELECT id FROM agent_turns WHERE outcome IS NULL OR completed_at IS NULL ORDER BY id"
        )
    ).all()
    if nonterminal_agent_turns:
        _fail(f"agent_turns must be terminal: {_ids(nonterminal_agent_turns)}")

    active_chat_runs = bind.execute(
        sa.text(
            "SELECT id FROM chat_runs "
            "WHERE status NOT IN ('complete', 'error', 'cancelled') ORDER BY id"
        )
    ).all()
    if active_chat_runs:
        _fail(f"chat runs must be terminal: {_ids(active_chat_runs)}")

    unsettled_tool_calls = bind.execute(
        sa.text(
            "SELECT id FROM message_tool_calls WHERE status IN ('pending', 'running') ORDER BY id"
        )
    ).all()
    if unsettled_tool_calls:
        _fail(f"Chat tool calls must be settled: {_ids(unsettled_tool_calls)}")

    active_jobs = bind.execute(
        sa.text(
            """
            SELECT id
            FROM background_jobs
            WHERE kind = ANY(CAST(:kinds AS text[]))
              AND status = ANY(CAST(:statuses AS text[]))
              AND NOT ((
                  status = 'dead'
                  AND (
                      kind = ANY(CAST(:headless_dead_kinds AS text[]))
                      OR (
                          kind = 'enrich_metadata'
                          AND attempts > 0
                          AND finished_at IS NOT NULL
                          AND lease_expires_at IS NULL
                          AND claimed_by IS NULL
                          AND error_code IS NOT NULL
                          AND (
                              result = jsonb_build_object(
                                  'status', 'failed',
                                  'reason', result ->> 'reason',
                                  'error_code', error_code
                              )
                              OR (
                                  result = jsonb_build_object(
                                      'status', 'failed',
                                      'reason', result ->> 'reason',
                                      'error_code', error_code,
                                      'provider', result ->> 'provider',
                                      'model', result ->> 'model',
                                      'attempted_providers', result -> 'attempted_providers'
                                  )
                                  AND result ->> 'provider' <> ''
                                  AND result ->> 'model' <> ''
                                  AND jsonb_typeof(result -> 'attempted_providers') = 'array'
                                  AND result -> 'attempted_providers' = (
                                      SELECT jsonb_agg(
                                          attempt.value
                                          ORDER BY attempt.ordinality
                                      )
                                      FROM jsonb_array_elements(
                                          CASE
                                              WHEN jsonb_typeof(
                                                  result -> 'attempted_providers'
                                              ) = 'array'
                                                  THEN result -> 'attempted_providers'
                                              ELSE '[]'::jsonb
                                          END
                                      ) WITH ORDINALITY AS attempt(value, ordinality)
                                      WHERE attempt.value = jsonb_build_object(
                                          'provider', attempt.value ->> 'provider',
                                          'model', attempt.value ->> 'model'
                                      )
                                        AND jsonb_typeof(attempt.value -> 'provider')
                                            = 'string'
                                        AND attempt.value ->> 'provider' <> ''
                                        AND jsonb_typeof(attempt.value -> 'model')
                                            = 'string'
                                        AND attempt.value ->> 'model' <> ''
                                  )
                                  AND result ->> 'provider'
                                      = result -> 'attempted_providers' -> -1 ->> 'provider'
                                  AND result ->> 'model'
                                      = result -> 'attempted_providers' -> -1 ->> 'model'
                              )
                          )
                          AND result ->> 'reason'
                              = ANY(CAST(:enrichment_failure_reasons AS text[]))
                      )
                  )
              ) IS TRUE)
            ORDER BY id
            """
        ),
        {
            "kinds": list(_GENERATION_JOB_KINDS),
            "statuses": list(_RESET_BLOCKING_JOB_STATUSES),
            "headless_dead_kinds": list(_HEADLESS_RESETTABLE_DEAD_JOB_KINDS),
            "enrichment_failure_reasons": list(_RESETTABLE_ENRICHMENT_FAILURE_REASONS),
        },
    ).all()
    if active_jobs:
        _fail(f"generation jobs must be drained: {_ids(active_jobs)}")

    generation_jobs_with_domain_attempts = bind.execute(
        sa.text(
            """
            SELECT attempts.id
            FROM media_source_attempts AS attempts
            JOIN background_jobs AS jobs ON jobs.id = attempts.job_id
            WHERE jobs.kind = ANY(CAST(:kinds AS text[]))
            ORDER BY attempts.id
            """
        ),
        {"kinds": list(_GENERATION_JOB_KINDS)},
    ).all()
    if generation_jobs_with_domain_attempts:
        _fail(
            "media source attempts reference reset generation jobs: "
            f"{_ids(generation_jobs_with_domain_attempts)}"
        )

    uncertain_jobs = bind.execute(
        sa.text(
            """
            SELECT id
            FROM background_jobs
            WHERE jsonb_path_exists(
                payload,
                '$.** ? (@.dispatch_phase == "Uncertain")'::jsonpath
            )
            ORDER BY id
            """
        )
    ).all()
    if uncertain_jobs:
        _fail(f"queue journals contain Uncertain dispatches: {_ids(uncertain_jobs)}")

    uncertain_learn_requests = bind.execute(
        sa.text(
            """
            SELECT id
            FROM artifact_learn_requests
            WHERE jsonb_path_exists(
                coordination,
                '$.** ? (@.dispatch_phase == "Uncertain")'::jsonpath
            )
            ORDER BY id
            """
        )
    ).all()
    if uncertain_learn_requests:
        _fail(
            "Learn coordination journals contain Uncertain dispatches: "
            f"{_ids(uncertain_learn_requests)}"
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

    active_learn = bind.execute(
        sa.text(
            """
            SELECT requests.id
            FROM artifact_learn_requests AS requests
            LEFT JOIN artifact_learn_successes AS successes
              ON successes.request_id = requests.id
            LEFT JOIN artifact_learn_failures AS failures
              ON failures.request_id = requests.id
            WHERE successes.request_id IS NULL AND failures.request_id IS NULL
            ORDER BY requests.id
            """
        )
    ).all()
    if active_learn:
        _fail(f"Learn requests must be terminal: {_ids(active_learn)}")

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
            f"Oracle failures use unsupported codes: {_ids(unsupported_oracle_failures)}"
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
        )
    ).all()
    if malformed_oracle_failures:
        _fail(
            f"Oracle failures require a matching terminal event: {_ids(malformed_oracle_failures)}"
        )

    _assert_reset_foreign_keys_are_classified(bind)
    _assert_polymorphic_references_are_classified(bind)


def _assert_reset_foreign_keys_are_classified(bind: sa.Connection) -> None:
    rows = bind.execute(
        sa.text(
            """
            SELECT child.relname, child_column.attname,
                   parent.relname, parent_column.attname
            FROM pg_constraint AS fk
            JOIN pg_class AS child ON child.oid = fk.conrelid
            JOIN pg_namespace AS child_namespace
              ON child_namespace.oid = child.relnamespace
            JOIN pg_class AS parent ON parent.oid = fk.confrelid
            CROSS JOIN LATERAL generate_subscripts(fk.conkey, 1) AS key(index)
            JOIN pg_attribute AS child_column
              ON child_column.attrelid = child.oid
             AND child_column.attnum = fk.conkey[key.index]
            JOIN pg_attribute AS parent_column
              ON parent_column.attrelid = parent.oid
             AND parent_column.attnum = fk.confkey[key.index]
            WHERE fk.contype = 'f'
              AND child_namespace.nspname = current_schema()
              AND parent.relname = ANY(CAST(:parents AS text[]))
            ORDER BY child.relname, child_column.attname
            """
        ),
        {"parents": sorted(_RESET_PARENT_TABLES)},
    ).all()
    observed = frozenset(tuple(str(value) for value in row) for row in rows)
    if observed != _CLASSIFIED_RESET_FOREIGN_KEYS:
        _fail(
            "reset foreign-key closure changed; "
            f"expected={sorted(_CLASSIFIED_RESET_FOREIGN_KEYS)!r} "
            f"observed={sorted(observed)!r}"
        )


def _assert_polymorphic_references_are_classified(bind: sa.Connection) -> None:
    rows = bind.execute(
        sa.text(
            """
            SELECT scheme.table_name, scheme.column_name, identity.column_name
            FROM information_schema.columns AS scheme
            JOIN information_schema.columns AS identity
              ON identity.table_schema = scheme.table_schema
             AND identity.table_name = scheme.table_name
             AND identity.column_name = left(scheme.column_name, -7) || '_id'
            WHERE scheme.table_schema = current_schema()
              AND right(scheme.column_name, 7) = '_scheme'
            ORDER BY scheme.table_name, scheme.column_name
            """
        )
    ).all()
    observed = frozenset(tuple(str(value) for value in row) for row in rows)
    if observed != _CLASSIFIED_POLYMORPHIC_REFERENCES:
        _fail(
            "polymorphic reference closure changed; "
            f"expected={sorted(_CLASSIFIED_POLYMORPHIC_REFERENCES)!r} "
            f"observed={sorted(observed)!r}"
        )


def _deleted_reference_predicate(scheme_column: str, identity_column: str) -> str:
    return f"""
        (({scheme_column} = 'conversation'
          AND {identity_column}::text IN (
            SELECT id::text FROM nx_0224_conversation_ids
          ))
         OR ({scheme_column} = 'message'
             AND {identity_column}::text IN (
               SELECT id::text FROM nx_0224_message_ids
             ))
         OR ({scheme_column} = 'artifact'
             AND {identity_column}::text IN (
               SELECT id::text FROM nx_0224_artifact_ids
             ))
         OR ({scheme_column} = 'artifact_revision'
             AND {identity_column}::text IN (
               SELECT id::text FROM nx_0224_revision_ids
             )))
    """


def _snapshot_reset_ids(bind: sa.Connection) -> None:
    for statement in (
        "CREATE TEMP TABLE nx_0224_conversation_ids ON COMMIT DROP AS SELECT id FROM conversations",
        "CREATE TEMP TABLE nx_0224_message_ids ON COMMIT DROP AS SELECT id FROM messages",
        "CREATE TEMP TABLE nx_0224_chat_run_ids ON COMMIT DROP AS SELECT id FROM chat_runs",
        "CREATE TEMP TABLE nx_0224_artifact_ids (id uuid PRIMARY KEY) ON COMMIT DROP",
    ):
        bind.execute(sa.text(statement))

    bind.execute(
        sa.text(
            """
            INSERT INTO nx_0224_artifact_ids (id)
            SELECT id
            FROM artifacts
            WHERE (subject_scheme = 'conversation'
                   AND subject_id::text IN (
                     SELECT id::text FROM nx_0224_conversation_ids
                   ))
               OR (subject_scheme = 'message'
                   AND subject_id::text IN (
                     SELECT id::text FROM nx_0224_message_ids
                   ))
               OR (audience_scheme = 'conversation'
                   AND audience_id IN (
                     SELECT id::text FROM nx_0224_conversation_ids
                   ))
               OR (audience_scheme = 'message'
                   AND audience_id IN (
                     SELECT id::text FROM nx_0224_message_ids
                   ))
            """
        )
    )
    while True:
        inserted = bind.execute(
            sa.text(
                """
                INSERT INTO nx_0224_artifact_ids (id)
                SELECT artifacts.id
                FROM artifacts
                WHERE artifacts.id NOT IN (SELECT id FROM nx_0224_artifact_ids)
                  AND (
                    (artifacts.subject_scheme = 'artifact'
                     AND artifacts.subject_id::text IN (
                       SELECT id::text FROM nx_0224_artifact_ids
                     ))
                    OR (artifacts.audience_scheme = 'artifact'
                        AND artifacts.audience_id IN (
                          SELECT id::text FROM nx_0224_artifact_ids
                        ))
                    OR (artifacts.subject_scheme = 'artifact_revision'
                        AND artifacts.subject_id::text IN (
                          SELECT revisions.id::text
                          FROM artifact_revisions AS revisions
                          JOIN artifact_builds AS builds
                            ON builds.id = revisions.build_id
                          WHERE builds.artifact_id IN (
                            SELECT id FROM nx_0224_artifact_ids
                          )
                        ))
                    OR (artifacts.audience_scheme = 'artifact_revision'
                        AND artifacts.audience_id IN (
                          SELECT revisions.id::text
                          FROM artifact_revisions AS revisions
                          JOIN artifact_builds AS builds
                            ON builds.id = revisions.build_id
                          WHERE builds.artifact_id IN (
                            SELECT id FROM nx_0224_artifact_ids
                          )
                        ))
                    OR artifacts.current_revision_id IN (
                      SELECT revisions.id
                      FROM artifact_revisions AS revisions
                      JOIN artifact_builds AS builds ON builds.id = revisions.build_id
                      WHERE builds.artifact_id IN (
                        SELECT id FROM nx_0224_artifact_ids
                      )
                    )
                  )
                ON CONFLICT (id) DO NOTHING
                """
            )
        )
        if inserted.rowcount == 0:
            break

    for statement in (
        "CREATE TEMP TABLE nx_0224_build_ids ON COMMIT DROP AS "
        "SELECT id FROM artifact_builds "
        "WHERE artifact_id IN (SELECT id FROM nx_0224_artifact_ids)",
        "CREATE TEMP TABLE nx_0224_revision_ids ON COMMIT DROP AS "
        "SELECT id FROM artifact_revisions "
        "WHERE build_id IN (SELECT id FROM nx_0224_build_ids)",
        "CREATE TEMP TABLE nx_0224_learn_request_ids ON COMMIT DROP AS "
        "SELECT DISTINCT request_id FROM artifact_learn_successes "
        "WHERE artifact_id IN (SELECT id FROM nx_0224_artifact_ids) "
        "OR build_id IN (SELECT id FROM nx_0224_build_ids)",
        "CREATE TEMP TABLE nx_0224_generation_job_ids ON COMMIT DROP AS "
        "SELECT id FROM background_jobs "
        "WHERE kind = ANY(CAST(:kinds AS text[]))",
    ):
        bind.execute(sa.text(statement), {"kinds": list(_GENERATION_JOB_KINDS)})

    edge_predicate = (
        _deleted_reference_predicate("source_scheme", "source_id")
        + " OR "
        + _deleted_reference_predicate("target_scheme", "target_id")
    )
    bind.execute(
        sa.text(
            "CREATE TEMP TABLE nx_0224_resource_edge_ids ON COMMIT DROP AS "
            f"SELECT id FROM resource_edges WHERE {edge_predicate}"
        )
    )
    view_predicate = (
        _deleted_reference_predicate("surface_scheme", "surface_id")
        + " OR "
        + _deleted_reference_predicate("target_scheme", "target_id")
    )
    bind.execute(
        sa.text(
            "CREATE TEMP TABLE nx_0224_resource_view_state_ids ON COMMIT DROP AS "
            "SELECT id FROM resource_view_states WHERE edge_id IN "
            "(SELECT id FROM nx_0224_resource_edge_ids) OR "
            f"{view_predicate}"
        )
    )
    _snapshot_external_snapshot_deletions(bind)


def _preflight_snapshot_closure(bind: sa.Connection) -> None:
    preserved_oracle_folios = bind.execute(
        sa.text(
            """
            SELECT edge_id
            FROM oracle_reading_folios
            WHERE edge_id IN (SELECT id FROM nx_0224_resource_edge_ids)
            ORDER BY edge_id
            """
        )
    ).all()
    if preserved_oracle_folios:
        _fail(
            "Oracle reading folios reference reset resource edges; preserve the "
            f"folio/edge boundary before cutover: {_ids(preserved_oracle_folios)}"
        )


_PRESERVATION_FILTERS: dict[str, str] = {
    "artifact_build_cancellations": (
        "build_id NOT IN (SELECT id FROM nx_0224_build_ids)"
    ),
    "artifact_build_events": "build_id NOT IN (SELECT id FROM nx_0224_build_ids)",
    "artifact_build_failures": "build_id NOT IN (SELECT id FROM nx_0224_build_ids)",
    "artifact_builds": "id NOT IN (SELECT id FROM nx_0224_build_ids)",
    "artifact_idea_seeds": "artifact_id NOT IN (SELECT id FROM nx_0224_artifact_ids)",
    "artifact_learn_failures": (
        "request_id NOT IN (SELECT request_id FROM nx_0224_learn_request_ids)"
    ),
    "artifact_learn_requests": (
        "id NOT IN (SELECT request_id FROM nx_0224_learn_request_ids)"
    ),
    "artifact_learn_successes": (
        "request_id NOT IN (SELECT request_id FROM nx_0224_learn_request_ids)"
    ),
    "artifact_revisions": "id NOT IN (SELECT id FROM nx_0224_revision_ids)",
    "artifacts": "id NOT IN (SELECT id FROM nx_0224_artifact_ids)",
    "background_jobs": "id NOT IN (SELECT id FROM nx_0224_generation_job_ids)",
    "passage_anchors": "NOT "
    + _deleted_reference_predicate("owner_scheme", "owner_id"),
    "resource_edges": "id NOT IN (SELECT id FROM nx_0224_resource_edge_ids)",
    "resource_external_snapshots": (
        "id NOT IN (SELECT id FROM nx_0224_external_snapshot_delete_ids)"
    ),
    "resource_grants": "NOT "
    + _deleted_reference_predicate("subject_scheme", "subject_id"),
    "resource_mutations": "NOT ("
    "split_part(mutation_scope, ':', 1) = 'resource' AND ("
    "(split_part(mutation_scope, ':', 2) = 'conversation' AND "
    "split_part(mutation_scope, ':', 3) IN "
    "(SELECT id::text FROM nx_0224_conversation_ids)) OR "
    "(split_part(mutation_scope, ':', 2) = 'message' AND "
    "split_part(mutation_scope, ':', 3) IN "
    "(SELECT id::text FROM nx_0224_message_ids)) OR "
    "(split_part(mutation_scope, ':', 2) = 'artifact' AND "
    "split_part(mutation_scope, ':', 3) IN "
    "(SELECT id::text FROM nx_0224_artifact_ids)) OR "
    "(split_part(mutation_scope, ':', 2) = 'artifact_revision' AND "
    "split_part(mutation_scope, ':', 3) IN "
    "(SELECT id::text FROM nx_0224_revision_ids))))",
    "resource_versions": "NOT "
    + _deleted_reference_predicate("resource_scheme", "resource_id"),
    "resource_view_states": (
        "id NOT IN (SELECT id FROM nx_0224_resource_view_state_ids)"
    ),
    "synapse_suppressions": "NOT ("
    + _deleted_reference_predicate("source_scheme", "source_id")
    + " OR "
    + _deleted_reference_predicate("target_scheme", "target_id")
    + ")",
}


def _quoted_identifier(identifier: str) -> str:
    if _IDENTIFIER.fullmatch(identifier) is None:
        _fail(f"unsafe PostgreSQL identifier in preservation inventory: {identifier!r}")
    return f'"{identifier}"'


def _snapshot_external_snapshot_deletions(bind: sa.Connection) -> None:
    bind.execute(
        sa.text(
            """
            CREATE TEMP TABLE nx_0224_external_snapshot_candidates ON COMMIT DROP AS
            SELECT DISTINCT snapshots.id
            FROM resource_external_snapshots AS snapshots
            JOIN message_retrievals AS retrievals
              ON retrievals.source_id = snapshots.id::text
            WHERE retrievals.result_type = 'web_result'
            """
        )
    )
    surviving_references: list[str] = []
    for table, scheme_column, identity_column in sorted(
        _CLASSIFIED_POLYMORPHIC_REFERENCES
    ):
        if table in _RESET_OR_REPLACED_TABLES:
            continue
        row_filter = _PRESERVATION_FILTERS.get(table)
        filter_sql = f" AND ({row_filter})" if row_filter is not None else ""
        surviving_references.append(
            "EXISTS (SELECT 1 FROM "
            f"{_quoted_identifier(table)} WHERE "
            f"{_quoted_identifier(scheme_column)} = 'external_snapshot' AND "
            f"{_quoted_identifier(identity_column)}::text = candidates.id::text"
            f"{filter_sql})"
        )
    if not surviving_references:
        _fail("polymorphic inventory has no external-snapshot reference owners")
    bind.execute(
        sa.text(
            "CREATE TEMP TABLE nx_0224_external_snapshot_delete_ids ON COMMIT DROP AS "
            "SELECT candidates.id FROM nx_0224_external_snapshot_candidates AS candidates "
            "WHERE NOT (" + " OR ".join(surviving_references) + ")"
        )
    )


def _table_primary_keys(bind: sa.Connection) -> dict[str, tuple[str, ...]]:
    rows = bind.execute(
        sa.text(
            """
            SELECT tables.table_name,
                   array_agg(attributes.attname ORDER BY keys.ordinality)
            FROM information_schema.tables AS tables
            JOIN pg_namespace AS namespaces
              ON namespaces.nspname = tables.table_schema
            JOIN pg_class AS relations
              ON relations.relnamespace = namespaces.oid
             AND relations.relname = tables.table_name
            JOIN pg_constraint AS constraints
              ON constraints.conrelid = relations.oid
             AND constraints.contype = 'p'
            CROSS JOIN LATERAL unnest(constraints.conkey)
              WITH ORDINALITY AS keys(attribute_number, ordinality)
            JOIN pg_attribute AS attributes
              ON attributes.attrelid = relations.oid
             AND attributes.attnum = keys.attribute_number
            WHERE tables.table_schema = current_schema()
              AND tables.table_type = 'BASE TABLE'
            GROUP BY tables.table_name
            ORDER BY tables.table_name
            """
        )
    ).all()
    primary_keys = {
        str(row[0]): tuple(str(column) for column in row[1]) for row in rows
    }
    tables = {
        str(row[0])
        for row in bind.execute(
            sa.text(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = current_schema() "
                "AND table_type = 'BASE TABLE'"
            )
        )
    }
    missing = sorted(tables - set(primary_keys))
    if missing:
        _fail(f"preservation inventory requires primary keys: {missing!r}")
    return primary_keys


def _preservation_query(
    table: str,
    primary_key_columns: tuple[str, ...],
    row_filter: str | None,
) -> str:
    json_values = ", ".join(
        _quoted_identifier(column) for column in primary_key_columns
    )
    where = f" WHERE {row_filter}" if row_filter is not None else ""
    return (
        f"SELECT jsonb_build_array({json_values})::text AS identity "
        f"FROM {_quoted_identifier(table)}{where}"
    )


def _manifest_facts(rows: Sequence[Row[Any]]) -> tuple[int, str]:
    identities = sorted(str(row[0]) for row in rows)
    digest = hashlib.sha256("\n".join(identities).encode()).hexdigest()
    return len(identities), digest


def _record_preservation_manifest(
    bind: sa.Connection,
) -> dict[str, tuple[tuple[str, ...], str | None]]:
    if set(_PRESERVATION_FILTERS) != _PARTIAL_DELETE_TABLES:
        _fail(
            "partial-delete inventory changed; "
            f"parents={sorted(_PARTIAL_DELETE_TABLES)!r} "
            f"filters={sorted(_PRESERVATION_FILTERS)!r}"
        )
    bind.execute(
        sa.text(
            """
            CREATE TEMP TABLE nx_0224_preservation_manifest (
                family text PRIMARY KEY,
                row_count bigint NOT NULL,
                primary_key_digest text NOT NULL
            ) ON COMMIT DROP
            """
        )
    )
    primary_keys = _table_primary_keys(bind)
    preserved_tables = set(primary_keys) - _RESET_OR_REPLACED_TABLES
    unclassified_filters = set(_PRESERVATION_FILTERS) - preserved_tables
    if unclassified_filters:
        _fail(
            "partial-preservation tables are absent or reset-classified: "
            f"{sorted(unclassified_filters)!r}"
        )
    plan = {
        table: (primary_keys[table], _PRESERVATION_FILTERS.get(table))
        for table in sorted(preserved_tables)
    }
    for table, (columns, row_filter) in plan.items():
        family = f"table:{table}"
        query = _preservation_query(table, columns, row_filter)
        row_count, digest = _manifest_facts(bind.execute(sa.text(query)).all())
        bind.execute(
            sa.text(
                "INSERT INTO nx_0224_preservation_manifest "
                "(family, row_count, primary_key_digest) "
                "VALUES (:family, :row_count, :digest)"
            ),
            {"family": family, "row_count": row_count, "digest": digest},
        )
    return plan


def _assert_preservation_manifest(
    bind: sa.Connection,
    plan: dict[str, tuple[tuple[str, ...], str | None]],
) -> None:
    expected = {
        str(row.family): (int(row.row_count), str(row.primary_key_digest))
        for row in bind.execute(
            sa.text(
                "SELECT family, row_count, primary_key_digest "
                "FROM nx_0224_preservation_manifest ORDER BY family"
            )
        )
    }
    current_tables = set(_table_primary_keys(bind))
    current_preserved_tables = (
        current_tables - _RESET_OR_REPLACED_TABLES - _NEW_GENERATION_TABLES
    )
    if current_preserved_tables != set(plan):
        raise RuntimeError(
            "0224 preservation table set changed; "
            f"expected={sorted(plan)!r} observed={sorted(current_preserved_tables)!r}"
        )
    observed = {}
    for table, (columns, row_filter) in plan.items():
        query = _preservation_query(table, columns, row_filter)
        observed[f"table:{table}"] = _manifest_facts(bind.execute(sa.text(query)).all())
    if observed != expected:
        raise RuntimeError(
            f"0224 preservation manifest mismatch; expected={expected!r} observed={observed!r}"
        )
    bind.execute(sa.text("DROP TABLE nx_0224_preservation_manifest"))


def _tag_historical_failures(bind: sa.Connection) -> None:
    op.drop_constraint(
        "ck_artifact_build_events_type", "artifact_build_events", type_="check"
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

    op.drop_constraint(
        "ck_oracle_reading_events_type", "oracle_reading_events", type_="check"
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


def _delete_resource_closure(bind: sa.Connection) -> None:
    bind.execute(
        sa.text(
            "DELETE FROM resource_view_states "
            "WHERE id IN (SELECT id FROM nx_0224_resource_view_state_ids)"
        )
    )
    bind.execute(
        sa.text(
            "DELETE FROM resource_edges WHERE id IN (SELECT id FROM nx_0224_resource_edge_ids)"
        )
    )
    bind.execute(
        sa.text(
            "DELETE FROM resource_versions WHERE "
            + _deleted_reference_predicate("resource_scheme", "resource_id")
        )
    )
    bind.execute(
        sa.text(
            "DELETE FROM resource_grants WHERE "
            + _deleted_reference_predicate("subject_scheme", "subject_id")
        )
    )
    bind.execute(
        sa.text(
            "DELETE FROM passage_anchors WHERE "
            + _deleted_reference_predicate("owner_scheme", "owner_id")
        )
    )
    bind.execute(
        sa.text(
            "DELETE FROM synapse_suppressions WHERE "
            + _deleted_reference_predicate("source_scheme", "source_id")
            + " OR "
            + _deleted_reference_predicate("target_scheme", "target_id")
        )
    )
    bind.execute(
        sa.text(
            """
            DELETE FROM resource_mutations
            WHERE (
                split_part(mutation_scope, ':', 1) = 'resource'
                AND (
                    (split_part(mutation_scope, ':', 2) = 'conversation'
                     AND split_part(mutation_scope, ':', 3) IN (
                       SELECT id::text FROM nx_0224_conversation_ids
                     ))
                    OR (split_part(mutation_scope, ':', 2) = 'message'
                        AND split_part(mutation_scope, ':', 3) IN (
                          SELECT id::text FROM nx_0224_message_ids
                        ))
                    OR (split_part(mutation_scope, ':', 2) = 'artifact'
                        AND split_part(mutation_scope, ':', 3) IN (
                          SELECT id::text FROM nx_0224_artifact_ids
                        ))
                    OR (split_part(mutation_scope, ':', 2) = 'artifact_revision'
                        AND split_part(mutation_scope, ':', 3) IN (
                          SELECT id::text FROM nx_0224_revision_ids
                        ))
                )
            )
            """
        )
    )


def _delete_conversation_artifacts(bind: sa.Connection) -> None:
    bind.execute(
        sa.text(
            "UPDATE artifacts SET current_revision_id = NULL "
            "WHERE id IN (SELECT id FROM nx_0224_artifact_ids)"
        )
    )
    bind.execute(
        sa.text(
            "DELETE FROM artifact_learn_successes "
            "WHERE request_id IN (SELECT request_id FROM nx_0224_learn_request_ids)"
        )
    )
    bind.execute(
        sa.text(
            "DELETE FROM artifact_learn_failures "
            "WHERE request_id IN (SELECT request_id FROM nx_0224_learn_request_ids)"
        )
    )
    bind.execute(
        sa.text(
            "DELETE FROM artifact_learn_requests "
            "WHERE id IN (SELECT request_id FROM nx_0224_learn_request_ids)"
        )
    )
    bind.execute(
        sa.text(
            "DELETE FROM artifact_idea_seeds "
            "WHERE artifact_id IN (SELECT id FROM nx_0224_artifact_ids)"
        )
    )
    for table in (
        "artifact_build_events",
        "artifact_revisions",
        "artifact_build_failures",
        "artifact_build_cancellations",
    ):
        bind.execute(
            sa.text(
                f"DELETE FROM {table} WHERE build_id IN (SELECT id FROM nx_0224_build_ids)"
            )
        )
    bind.execute(
        sa.text(
            "DELETE FROM artifact_builds WHERE id IN (SELECT id FROM nx_0224_build_ids)"
        )
    )
    bind.execute(
        sa.text(
            "DELETE FROM artifacts WHERE id IN (SELECT id FROM nx_0224_artifact_ids)"
        )
    )


def _delete_chat_and_generation_history(bind: sa.Connection) -> None:
    for statement in (
        "DELETE FROM chat_run_events",
        "DELETE FROM chat_prompt_assemblies",
        "DELETE FROM chat_run_turn_contexts",
        "DELETE FROM message_retrievals",
        "DELETE FROM message_tool_calls",
        "DELETE FROM conversation_active_paths",
        "DELETE FROM conversation_branches",
        "DELETE FROM conversation_shares",
        "DELETE FROM chat_runs",
        "DELETE FROM messages",
        "DELETE FROM conversations",
        "UPDATE background_job_capacity_leases "
        "SET job_id = NULL, worker_id = NULL, attempt_no = NULL, "
        "lease_expires_at = NULL, updated_at = now() "
        "WHERE job_id IN (SELECT id FROM nx_0224_generation_job_ids)",
        "DELETE FROM background_jobs WHERE id IN (SELECT id FROM nx_0224_generation_job_ids)",
        "DELETE FROM resource_external_snapshots snapshots "
        "WHERE snapshots.id IN (SELECT id FROM nx_0224_external_snapshot_delete_ids)",
        "DELETE FROM llm_calls",
    ):
        bind.execute(sa.text(statement))


def _drop_historical_generation_schema() -> None:
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

    for column in (
        "reasoning_option_id",
        "provider",
        "error_origin",
        "profile_id",
        "tool_profile_id",
        "tool_profile_revision",
        "tool_profile_snapshot",
        "model_name",
        "reasoning_effort",
    ):
        op.drop_column("chat_runs", column)

    op.add_column(
        "chat_runs",
        sa.Column(
            "generation_spec",
            postgresql.JSONB(astext_type=sa.Text(), none_as_null=True),
            nullable=False,
        ),
    )
    op.add_column(
        "chat_prompt_assemblies",
        sa.Column(
            "generation_intent",
            postgresql.JSONB(astext_type=sa.Text(), none_as_null=True),
            nullable=False,
        ),
    )
    op.add_column(
        "chat_prompt_assemblies",
        sa.Column("generation_intent_digest", sa.Text(), nullable=False),
    )


def _create_generation_schema() -> None:
    op.create_table(
        "llm_calls",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("owner_kind", sa.Text(), nullable=False),
        sa.Column("owner_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("generation_seq", sa.Integer(), nullable=False),
        sa.Column(
            "generation_spec",
            postgresql.JSONB(astext_type=sa.Text(), none_as_null=True),
            nullable=False,
        ),
        sa.Column("generation_fingerprint", sa.Text(), nullable=False),
        sa.Column("outcome", sa.Text(), nullable=True),
        sa.Column("failure_code", sa.Text(), nullable=True),
        sa.Column(
            "terminal",
            postgresql.JSONB(astext_type=sa.Text(), none_as_null=True),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("completed_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "owner_kind",
            "owner_id",
            "generation_seq",
            name="uq_llm_calls_owner_generation_seq",
        ),
    )
    op.create_table(
        "llm_model_turns",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("generation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("turn_seq", sa.Integer(), nullable=False),
        sa.Column("request_fingerprint", sa.Text(), nullable=False),
        sa.Column(
            "route_request_identity",
            postgresql.JSONB(astext_type=sa.Text(), none_as_null=True),
            nullable=False,
        ),
        sa.Column(
            "terminal",
            postgresql.JSONB(astext_type=sa.Text(), none_as_null=True),
            nullable=True,
        ),
        sa.Column(
            "usage",
            postgresql.JSONB(astext_type=sa.Text(), none_as_null=True),
            nullable=True,
        ),
        sa.Column(
            "billability",
            postgresql.JSONB(astext_type=sa.Text(), none_as_null=True),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "dispatch_started_at", postgresql.TIMESTAMP(timezone=True), nullable=True
        ),
        sa.Column("accepted_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("completed_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["generation_id"], ["llm_calls.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "generation_id",
            "turn_seq",
            name="uq_llm_model_turns_generation_turn_seq",
        ),
    )
    op.create_table(
        "llm_model_turn_continuations",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("generation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "source_model_turn_id", postgresql.UUID(as_uuid=True), nullable=False
        ),
        sa.Column("successor_turn_seq", sa.Integer(), nullable=False),
        sa.Column("target_fingerprint", sa.Text(), nullable=False),
        sa.Column("codec_id", sa.Text(), nullable=False),
        sa.Column("policy_revision", sa.Text(), nullable=False),
        sa.Column("envelope_version", sa.Text(), nullable=False),
        sa.Column("nonce", sa.LargeBinary(), nullable=False),
        sa.Column("ciphertext", sa.LargeBinary(), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["generation_id"], ["llm_calls.id"]),
        sa.ForeignKeyConstraint(["source_model_turn_id"], ["llm_model_turns.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "source_model_turn_id",
            name="uq_llm_model_turn_continuations_source_turn",
        ),
        sa.UniqueConstraint(
            "generation_id",
            "successor_turn_seq",
            name="uq_llm_model_turn_continuations_successor_turn",
        ),
    )
    op.create_table(
        "llm_tool_positions",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("generation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("transport_kind", sa.Text(), nullable=False),
        sa.Column("model_turn_seq", sa.Integer(), nullable=False),
        sa.Column("transport_call_id", sa.Text(), nullable=False),
        sa.Column("canonical_tool_id", sa.Text(), nullable=False),
        sa.Column("canonical_input_digest", sa.Text(), nullable=False),
        sa.Column("tool_contract_revision", sa.Text(), nullable=False),
        sa.Column("plan_revision", sa.Text(), nullable=False),
        sa.Column("binding_revision", sa.Text(), nullable=False),
        sa.Column("scope_digest", sa.Text(), nullable=False),
        sa.Column("budget_digest", sa.Text(), nullable=False),
        sa.Column(
            "reservation",
            postgresql.JSONB(astext_type=sa.Text(), none_as_null=True),
            nullable=True,
        ),
        sa.Column(
            "dispatch_claim",
            postgresql.JSONB(astext_type=sa.Text(), none_as_null=True),
            nullable=True,
        ),
        sa.Column("abandoned_attempts", sa.Integer(), nullable=False),
        sa.Column(
            "result_evidence",
            postgresql.JSONB(astext_type=sa.Text(), none_as_null=True),
            nullable=True,
        ),
        sa.Column(
            "effect_identity",
            postgresql.JSONB(astext_type=sa.Text(), none_as_null=True),
            nullable=True,
        ),
        sa.Column(
            "settlement",
            postgresql.JSONB(astext_type=sa.Text(), none_as_null=True),
            nullable=True,
        ),
        sa.Column("replay_status", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("completed_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["generation_id"], ["llm_calls.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "generation_id",
            "position",
            name="uq_llm_tool_positions_generation_position",
        ),
        sa.UniqueConstraint(
            "generation_id",
            "transport_kind",
            "model_turn_seq",
            "transport_call_id",
            name="uq_llm_tool_positions_transport_call",
        ),
    )
    op.add_column(
        "message_tool_calls",
        sa.Column("tool_position_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_message_tool_calls_tool_position",
        "message_tool_calls",
        "llm_tool_positions",
        ["tool_position_id"],
        ["id"],
    )
    op.create_unique_constraint(
        "uq_message_tool_calls_tool_position",
        "message_tool_calls",
        ["tool_position_id"],
    )
    op.create_table(
        "assistant_write_authorships",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tool_position_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("target_kind", sa.Text(), nullable=False),
        sa.Column("target_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["tool_position_id"],
            ["llm_tool_positions.id"],
            name="fk_assistant_write_authorships_tool_position",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "target_kind",
            "target_id",
            name="uq_assistant_write_authorships_target",
        ),
    )
    op.create_index(
        "ix_assistant_write_authorships_tool_position",
        "assistant_write_authorships",
        ["tool_position_id", "created_at", "id"],
    )


def _assert_final_reset(bind: sa.Connection) -> None:
    nonempty = {
        table: int(
            bind.scalar(sa.text(f"SELECT count(*) FROM {_quoted_identifier(table)}"))
            or 0
        )
        for table in sorted(_EMPTY_AFTER_RESET_TABLES)
    }
    nonempty = {table: count for table, count in nonempty.items() if count != 0}
    if nonempty:
        raise RuntimeError(f"0224 reset left historical rows: {nonempty!r}")

    residual_queries = {
        "artifacts": (
            "SELECT count(*) FROM artifacts WHERE id IN (SELECT id FROM nx_0224_artifact_ids)"
        ),
        "artifact_builds": (
            "SELECT count(*) FROM artifact_builds WHERE id IN (SELECT id FROM nx_0224_build_ids)"
        ),
        "artifact_revisions": (
            "SELECT count(*) FROM artifact_revisions WHERE id IN "
            "(SELECT id FROM nx_0224_revision_ids)"
        ),
        "artifact_learn_requests": (
            "SELECT count(*) FROM artifact_learn_requests WHERE id IN "
            "(SELECT request_id FROM nx_0224_learn_request_ids)"
        ),
        "background_jobs": (
            "SELECT count(*) FROM background_jobs WHERE id IN "
            "(SELECT id FROM nx_0224_generation_job_ids)"
        ),
        "resource_edges": (
            "SELECT count(*) FROM resource_edges WHERE id IN "
            "(SELECT id FROM nx_0224_resource_edge_ids)"
        ),
        "resource_external_snapshots": (
            "SELECT count(*) FROM resource_external_snapshots WHERE id IN "
            "(SELECT id FROM nx_0224_external_snapshot_delete_ids)"
        ),
        "resource_view_states": (
            "SELECT count(*) FROM resource_view_states WHERE id IN "
            "(SELECT id FROM nx_0224_resource_view_state_ids)"
        ),
    }
    residuals = {
        owner: int(bind.scalar(sa.text(query)) or 0)
        for owner, query in residual_queries.items()
    }
    residuals = {owner: count for owner, count in residuals.items() if count != 0}
    if residuals:
        raise RuntimeError(f"0224 reset left closure rows: {residuals!r}")

    for table, scheme_column, identity_column in sorted(
        _CLASSIFIED_POLYMORPHIC_REFERENCES
    ):
        predicate = (
            f"{_quoted_identifier(scheme_column)} IN ('conversation', 'message') OR "
            + _deleted_reference_predicate(scheme_column, identity_column)
        )
        dangling = bind.scalar(
            sa.text(
                f"SELECT 1 FROM {_quoted_identifier(table)} WHERE {predicate} LIMIT 1"
            )
        )
        if dangling is not None:
            raise RuntimeError(
                "0224 reset left dangling polymorphic reference in "
                f"{table}.{scheme_column}/{identity_column}"
            )

        deleted_external_reference = bind.scalar(
            sa.text(
                f"SELECT 1 FROM {_quoted_identifier(table)} WHERE "
                f"{_quoted_identifier(scheme_column)} = 'external_snapshot' AND "
                f"{_quoted_identifier(identity_column)}::text IN ("
                "SELECT id::text FROM nx_0224_external_snapshot_delete_ids"
                ") LIMIT 1"
            )
        )
        if deleted_external_reference is not None:
            raise RuntimeError(
                "0224 reset deleted an externally referenced snapshot from "
                f"{table}.{scheme_column}/{identity_column}"
            )

    mutation_residue = bind.scalar(
        sa.text(
            "SELECT 1 FROM resource_mutations WHERE NOT ("
            + _PRESERVATION_FILTERS["resource_mutations"]
            + ") LIMIT 1"
        )
    )
    if mutation_residue is not None:
        raise RuntimeError("0224 reset left a Chat-owned resource mutation")

    dropped_tables = {
        str(row[0])
        for row in bind.execute(
            sa.text(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = current_schema() "
                "AND table_name = ANY(CAST(:tables AS text[]))"
            ),
            {
                "tables": [
                    "agent_turns",
                    "token_budget_charges",
                    "token_budget_daily_usage",
                    "token_budget_reservations",
                ]
            },
        )
    }
    if dropped_tables:
        raise RuntimeError(
            f"0224 reset left retired generation tables: {sorted(dropped_tables)!r}"
        )

    retired_columns = {
        (str(row[0]), str(row[1]))
        for row in bind.execute(
            sa.text(
                """
                SELECT table_name, column_name
                FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND (
                    (table_name = 'chat_runs' AND column_name = ANY(CAST(:chat AS text[])))
                    OR (table_name = 'billing_entitlement_overrides'
                        AND column_name = ANY(CAST(:billing AS text[])))
                  )
                """
            ),
            {
                "chat": [
                    "error_origin",
                    "model_name",
                    "profile_id",
                    "provider",
                    "reasoning_effort",
                    "reasoning_option_id",
                    "tool_profile_id",
                    "tool_profile_revision",
                    "tool_profile_snapshot",
                ],
                "billing": [
                    "platform_token_limit_monthly",
                    "platform_token_quota_mode",
                ],
            },
        )
    }
    if retired_columns:
        raise RuntimeError(
            f"0224 reset left retired generation columns: {sorted(retired_columns)!r}"
        )


def upgrade() -> None:
    bind = op.get_bind()
    _preflight(bind)
    _snapshot_reset_ids(bind)
    _preflight_snapshot_closure(bind)
    preservation_plan = _record_preservation_manifest(bind)
    _tag_historical_failures(bind)
    _delete_resource_closure(bind)
    _delete_conversation_artifacts(bind)
    _delete_chat_and_generation_history(bind)
    _drop_historical_generation_schema()
    _create_generation_schema()
    _assert_final_reset(bind)
    _assert_preservation_manifest(bind, preservation_plan)


def downgrade() -> None:
    raise NotImplementedError(
        "0224 is an irreversible generation-backends hard cutover"
    )
