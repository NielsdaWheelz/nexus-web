"""Drop generation crash replay: turns, continuations, step journals, replay columns.

Revision ID: 0269
Revises: 0268

Generation no longer survives a worker death: the dead attempt's generation fails
``interrupted`` and chat shows the failed run; background work reruns from scratch.
Writers and the codex host are stopped for this cutover. In order:

1. refuse a chat spec this migration cannot rewrite;
2. end every nonterminal chat run (``cancelled`` if asked, else ``error``/``interrupted``)
   with its message, open tool calls and one ``done`` event;
3. close every open ``llm_calls`` row ``Failed``/``interrupted``;
4. close every unfinished tool position as a timed-out failure (a committed write is
   always Completed, so no unknown effect hides here);
5. fail the dossier builds, oracle readings and media summaries whose job is dead;
6. keep a dossier build's completed web search as ``payload.web_picks``;
7. strip the step journal and frozen admissions from every job payload;
8. sum each generation's turn usage onto ``llm_calls.usage``;
9. add ``llm_calls.job_id``; drop the turn and continuation tables and replay columns;
10. rewrite ``chat_runs.generation_spec`` to the one spec shape;
11. rewrite retired failure codes to their successors (turn_limit, capacity, the
    metadata catalog/configuration codes).

Production at 0241 crosses 0246 and 0256 in the same upgrade, which delete every
chat run, ledger row and metadata job first, so steps 2-5, 8 and 10-11 touch no rows
there. Irreversible: the release's pre-migration backup is the only copy of the
replay state.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0269"
down_revision: str | Sequence[str] | None = "0268"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        DO $$ BEGIN
            IF EXISTS (
                SELECT 1 FROM chat_runs
                WHERE generation_spec->>'schema_version' IS DISTINCT FROM 'nexus-generation-spec.v3'
                   OR COALESCE(generation_spec#>>'{authority,kind}', '')
                      NOT IN ('CodexCallbacks', 'ProviderFunctions')
            ) THEN
                RAISE EXCEPTION '0269: a chat run carries a generation spec it cannot rewrite';
            END IF;
        END $$
    """)

    ended = "CASE WHEN r.cancel_requested_at IS NULL THEN 'error' ELSE 'cancelled' END"
    op.execute(f"""
        UPDATE messages m SET status = {ended}, updated_at = now()
        FROM chat_runs r
        WHERE r.status IN ('queued', 'running') AND m.id = r.assistant_message_id
    """)
    op.execute(f"""
        UPDATE message_tool_calls c SET status = {ended}, updated_at = now()
        FROM chat_runs r
        WHERE r.status IN ('queued', 'running')
          AND c.assistant_message_id = r.assistant_message_id
          AND c.status IN ('pending', 'running')
    """)
    op.execute(f"""
        INSERT INTO chat_run_events (run_id, seq, event_type, payload)
        SELECT r.id,
               COALESCE((SELECT max(e.seq) FROM chat_run_events e WHERE e.run_id = r.id), 0) + 1,
               'done',
               jsonb_build_object(
                   'status', {ended},
                   'error_code', CASE WHEN r.cancel_requested_at IS NULL
                       THEN '{{"kind": "Present", "value": "interrupted"}}'::jsonb
                       ELSE '{{"kind": "Absent"}}'::jsonb END,
                   'support_id', '{{"kind": "Absent"}}'::jsonb,
                   'publication_warning', '{{"kind": "Absent"}}'::jsonb,
                   'usage', 'null'::jsonb,
                   'final_chars', 'null'::jsonb,
                   'last_provider_event_seq', 'null'::jsonb,
                   'cancelled', r.cancel_requested_at IS NOT NULL)
        FROM chat_runs r WHERE r.status IN ('queued', 'running')
    """)
    op.execute(f"""
        UPDATE chat_runs r SET status = {ended},
            error_code = CASE WHEN r.cancel_requested_at IS NULL THEN 'interrupted'
                ELSE r.error_code END,
            completed_at = now(), updated_at = now()
        WHERE r.status IN ('queued', 'running')
    """)

    op.execute("""
        UPDATE llm_calls SET outcome = 'Failed', failure_code = 'interrupted', completed_at = now(),
            terminal = '{"kind": "Failed", "failure_code": "interrupted",
                         "detail": "open at the replay-removal release"}'::jsonb
        WHERE outcome IS NULL
    """)
    op.execute("""
        UPDATE llm_tool_positions SET replay_status = 'Completed', completed_at = now(),
            result_evidence = jsonb_build_object(
                'tool_result', '{"type": "Failure", "error": {"type": "DeadlineExceeded"}}'::jsonb)
                || CASE WHEN effect_identity IS NULL THEN '{}'::jsonb
                   ELSE '{"created_refs": []}'::jsonb END
        WHERE replay_status <> 'Completed'
    """)

    def dead(kind: str, key: str, column: str) -> str:
        return (
            "EXISTS (SELECT 1 FROM background_jobs j WHERE j.kind = "
            f"'{kind}' AND j.status = 'dead' AND j.payload->>'{key}' = {column}::text)"
        )

    op.execute(f"""
        UPDATE artifact_builds b SET status = 'failed', failure_code = 'RuntimeUnavailable',
            failure_detail = 'its job died before generation replay was removed',
            finished_at = now()
        WHERE b.status = 'active' AND {dead("dossier_build", "build_id", "b.id")}
    """)
    op.execute(f"""
        UPDATE oracle_readings r SET status = 'failed', error_code = 'runtime_unavailable',
            failed_at = now()
        WHERE r.status = 'pending' AND {dead("oracle_reading_generate", "reading_id", "r.id")}
    """)
    op.execute(f"""
        UPDATE media_summaries s SET status = 'failed', error_code = 'runtime_unavailable',
            updated_at = now()
        WHERE s.status = 'building' AND {dead("media_unit_build", "summary_id", "s.id")}
    """)

    op.execute("""
        UPDATE background_jobs SET payload = payload || jsonb_build_object('web_picks',
            (payload#>>'{coordination,research/web,terminal_result,value}')::jsonb)
        WHERE kind = 'dossier_build'
          AND payload#>>'{coordination,research/web,dispatch_phase}' = 'Completed'
    """)
    op.execute("""
        UPDATE background_jobs
        SET payload = payload - 'coordination' - 'generation_admissions'
            - 'generation_spec_fingerprint'
        WHERE payload ?| ARRAY['coordination', 'generation_admissions',
                               'generation_spec_fingerprint']
    """)

    op.add_column("llm_calls", sa.Column("usage", postgresql.JSONB(), nullable=True))
    op.execute("""
        UPDATE llm_calls c SET usage = jsonb_build_object(
                'input_tokens', t.input_tokens, 'output_tokens', t.output_tokens,
                'total_tokens', t.total_tokens, 'reasoning_tokens', NULL,
                'cache_read_input_tokens', NULL, 'cache_write_input_tokens', NULL)
        FROM (
            SELECT generation_id,
                   sum((usage->>'input_tokens')::bigint) AS input_tokens,
                   sum((usage->>'output_tokens')::bigint) AS output_tokens,
                   sum((usage->>'total_tokens')::bigint) AS total_tokens
            FROM llm_model_turns
            GROUP BY generation_id
            HAVING bool_and(COALESCE(
                jsonb_typeof(usage->'input_tokens') = 'number'
                AND jsonb_typeof(usage->'output_tokens') = 'number'
                AND jsonb_typeof(usage->'total_tokens') = 'number', false))
        ) t
        WHERE c.id = t.generation_id
    """)

    op.add_column("llm_calls", sa.Column("job_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.create_index(
        "ix_llm_calls_open_job",
        "llm_calls",
        ["job_id"],
        postgresql_where=sa.text("outcome IS NULL"),
    )
    op.drop_column("llm_calls", "generation_fingerprint")
    op.drop_column("llm_calls", "tool_principal_user_id")
    op.drop_table("llm_model_turn_continuations")
    op.drop_table("llm_model_turns")
    for column in (
        "reservation",
        "dispatch_claim",
        "abandoned_attempts",
        "settlement",
        "callback_reply",
    ):
        op.drop_column("llm_tool_positions", column)

    op.execute("""
        UPDATE chat_runs SET generation_spec = jsonb_build_object(
            'operation', generation_spec->'operation',
            'selection', generation_spec->'selection',
            'display_at_dispatch', generation_spec->'display_at_dispatch',
            'tool_plan', generation_spec#>'{authority,model_tool_plan_snapshot,value,plan_id}',
            'tool_scope', COALESCE(
                generation_spec#>'{authority,admitted_tool_scope,value,admitted_refs}',
                '[]'::jsonb),
            'effect_mode', generation_spec#>'{authority,tool_effect_mode,value}',
            'context_budget_tokens', generation_spec->'effective_context_budget_tokens',
            'output_budget_tokens', generation_spec->'effective_output_budget_tokens')
    """)

    op.execute("""
        UPDATE chat_runs SET error_code = CASE error_code
            WHEN 'turn_limit' THEN 'output_limit' ELSE 'runtime_unavailable' END
        WHERE error_code IN ('turn_limit', 'capacity_unavailable')
    """)
    op.execute("""
        UPDATE oracle_readings SET error_code = 'runtime_unavailable'
        WHERE error_code = 'capacity_unavailable'
    """)
    op.execute("""
        UPDATE artifact_builds SET failure_code = 'RuntimeUnavailable'
        WHERE failure_code = 'CapacityUnavailable'
    """)
    op.execute("""
        UPDATE background_jobs SET result = jsonb_set(result, '{reason}', '"model_unavailable"')
        WHERE kind = 'enrich_metadata'
          AND result->>'reason' IN ('catalog_unavailable', 'configuration_error')
    """)
    op.execute("""
        UPDATE background_jobs SET error_code = 'E_METADATA_MODEL_UNAVAILABLE'
        WHERE kind = 'enrich_metadata' AND error_code IN (
            'E_METADATA_CATALOG_UNAVAILABLE', 'E_METADATA_CONFIGURATION_ERROR',
            'E_GENERATION_CAPACITY_UNAVAILABLE')
    """)


def downgrade() -> None:
    raise NotImplementedError("0269 is an irreversible schema deletion")
