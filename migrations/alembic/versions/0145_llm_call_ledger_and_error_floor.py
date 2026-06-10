"""llm call ledger (polymorphic llm_calls) + run-parent error floor

Revision ID: 0145
Revises: 0144
Create Date: 2026-06-09

Generation-run harness S2. ``message_llm`` (chat-only, one row per assistant
message, written only when finalize had a model+key in hand) generalizes into
``llm_calls``: one row **per provider call**, owned polymorphically by the run
parent (0143 owner pattern), written by the sole-writer ``services/llm_ledger``
on success AND failure. Historical chat rows migrate via the
``chat_runs.assistant_message_id`` join (``call_seq`` = 1; the tool loop
overwrote usage per iteration, so one row is all history ever had);
``reasoning_effort`` comes from the run row. Rows whose message has no chat run
are dropped.

Error floor: every run parent gets a place for operator-facing failure detail —
``chat_runs.error_detail``, LI revision + media summary ``error_code``/
``error_detail``, and ``oracle_readings.error_message`` renamed ``error_detail``
(its ``ck_oracle_readings_failed_has_error`` CHECK references only
``error_code``/``failed_at``, so the rename needs no constraint surgery).
``oracle_readings.interpretation_text`` becomes a canonical column (events are
replay, not store), backfilled from each reading's ``delta`` event payloads;
``generator_model_id`` is dropped (zero writers or readers; llm_calls
supersedes it).

Hard cutover: not reversible (drops message_llm).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0145"
down_revision: str | Sequence[str] | None = "0144"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # (A) The polymorphic per-provider-call ledger. A NULL token count passes
    # the combined >= 0 CHECK (NULL comparisons are not FALSE), so one terse
    # constraint covers all seven nullable counters.
    op.execute("""
        CREATE TABLE llm_calls (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            owner_kind text NOT NULL,
            owner_id uuid NOT NULL,
            call_seq integer NOT NULL,
            provider text NOT NULL,
            model_name text NOT NULL,
            llm_operation text NOT NULL,
            streaming boolean NOT NULL,
            reasoning_effort text NOT NULL,
            key_mode_requested text NOT NULL,
            key_mode_used text NOT NULL,
            input_tokens integer NULL,
            output_tokens integer NULL,
            total_tokens integer NULL,
            reasoning_tokens integer NULL,
            cache_write_input_tokens integer NULL,
            cache_read_input_tokens integer NULL,
            cached_input_tokens integer NULL,
            latency_ms integer NULL,
            error_class text NULL,
            error_detail text NULL,
            provider_request_id text NULL,
            provider_usage jsonb NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT ck_llm_calls_owner_kind CHECK (
                owner_kind IN (
                    'chat_run', 'oracle_reading', 'li_revision',
                    'media_summary', 'media_enrichment'
                )
            ),
            CONSTRAINT ck_llm_calls_call_seq_positive CHECK (call_seq >= 1),
            CONSTRAINT ck_llm_calls_provider CHECK (
                provider IN ('openai', 'anthropic', 'gemini', 'deepseek')
            ),
            CONSTRAINT ck_llm_calls_token_counts_non_negative CHECK (
                input_tokens >= 0 AND output_tokens >= 0 AND total_tokens >= 0
                AND reasoning_tokens >= 0 AND cache_write_input_tokens >= 0
                AND cache_read_input_tokens >= 0 AND cached_input_tokens >= 0
            ),
            CONSTRAINT ck_llm_calls_provider_usage_object CHECK (
                provider_usage IS NULL OR jsonb_typeof(provider_usage) = 'object'
            ),
            CONSTRAINT uq_llm_calls_owner_call_seq UNIQUE (owner_kind, owner_id, call_seq)
        )
    """)
    op.execute("CREATE INDEX ix_llm_calls_owner ON llm_calls (owner_kind, owner_id)")

    # (B) Migrate the chat-only history. chat_runs.assistant_message_id has no
    # unique constraint, so DISTINCT ON picks the newest run per message; each
    # run has exactly one assistant message, so (owner, call_seq=1) stays
    # unique. message_llm lacks reasoning_effort; the run's requested mode is
    # the honest value (the executor passes run.reasoning straight through).
    op.execute("""
        INSERT INTO llm_calls (
            owner_kind, owner_id, call_seq, provider, model_name, llm_operation,
            streaming, reasoning_effort, key_mode_requested, key_mode_used,
            input_tokens, output_tokens, total_tokens, reasoning_tokens,
            cache_write_input_tokens, cache_read_input_tokens, cached_input_tokens,
            latency_ms, error_class, provider_request_id, provider_usage, created_at
        )
        SELECT DISTINCT ON (ml.message_id)
            'chat_run', cr.id, 1, ml.provider, ml.model_name, 'chat_send',
            true, cr.reasoning, ml.key_mode_requested, ml.key_mode_used,
            ml.input_tokens, ml.output_tokens, ml.total_tokens, ml.reasoning_tokens,
            ml.cache_write_input_tokens, ml.cache_read_input_tokens, ml.cached_input_tokens,
            ml.latency_ms, ml.error_class, ml.provider_request_id, ml.provider_usage,
            ml.created_at
        FROM message_llm ml
        JOIN chat_runs cr ON cr.assistant_message_id = ml.message_id
        ORDER BY ml.message_id, cr.created_at DESC, cr.id DESC
    """)
    op.execute("DROP TABLE message_llm")

    # (C) Run-parent error floor (run_kit.mark_terminal is the sole writer).
    op.add_column("chat_runs", sa.Column("error_detail", sa.Text(), nullable=True))
    op.add_column(
        "library_intelligence_artifact_revisions",
        sa.Column("error_code", sa.Text(), nullable=True),
    )
    op.add_column(
        "library_intelligence_artifact_revisions",
        sa.Column("error_detail", sa.Text(), nullable=True),
    )
    op.add_column("media_summaries", sa.Column("error_code", sa.Text(), nullable=True))
    op.add_column("media_summaries", sa.Column("error_detail", sa.Text(), nullable=True))
    op.alter_column("oracle_readings", "error_message", new_column_name="error_detail")

    # (D) Interpretation becomes a canonical column; backfill by concatenating
    # each reading's delta payload text in seq order (the writer emits one
    # delta per reading; concatenation is order-safe either way).
    op.add_column("oracle_readings", sa.Column("interpretation_text", sa.Text(), nullable=True))
    op.execute("""
        UPDATE oracle_readings r
        SET interpretation_text = d.interpretation_text
        FROM (
            SELECT reading_id, string_agg(payload->>'text', '' ORDER BY seq) AS interpretation_text
            FROM oracle_reading_events
            WHERE event_type = 'delta' AND payload ? 'text'
            GROUP BY reading_id
        ) d
        WHERE d.reading_id = r.id
    """)
    op.drop_column("oracle_readings", "generator_model_id")


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0145 is not reversible")
