"""LLM provider-runtime hard cutover — persistence half (spec
docs/cutovers/llm-provider-runtime-hard-cutover.md §11).

NUMBERING NOTE: chains on 0183, the current head of THIS worktree's versions
directory. Two other numbers are independently claimed by concurrent, not-yet
-merged work: 0184 (link-authoring worktree) and 0185 (main checkout,
podcast-listening `last_engaged_at`). This revision must be rechained (its
``down_revision`` updated to whatever lands directly on top of 0183) at merge
time, per the Phase D execution plan (.dossiers/PLAN.md).

Transform (spec §11):

1. Add non-FK product snapshots ``profile_id``/``reasoning_option_id``,
   resolved trust-trail snapshots ``provider``/``model_name``/
   ``reasoning_effort``, plus ``error_origin`` and ``support_id`` to
   ``chat_runs``.
2. Backfill those resolved/selection columns from the polymorphic ledger join
   ``llm_calls.owner_kind = 'chat_run' AND llm_calls.owner_id = chat_runs.id``,
   picking the row with
   ``row_number() over (partition by owner_id order by call_seq, created_at,
   id) = 1``. Wire ``provider``/``model_name``/``reasoning_effort`` come
   straight from that row's legacy ``provider_route``/``model_name``/
   ``reasoning_effort`` — never from ``models`` or ``chat_runs.reasoning``.
   The legacy literal ``'default'`` is not a new reasoning option: it clears
   the resolved effort AND both selection snapshots for that run (spec: "Set
   profile_id and reasoning_option_id only when the selected exact target and
   explicit effort exactly match the frozen cutover registry" — read as one
   joint gate over BOTH columns, not effort alone). A chat_run with no
   ``llm_calls`` history at all keeps every new column NULL.
3. A preflight aborts (no mutation) if any chat_run's ledger rows disagree
   with each other on (provider_route, model_name) or on a non-'default'
   reasoning_effort — the migration never guesses which call was
   representative.
4. In ``llm_calls``, collapse ``provider``/``provider_route`` into the
   surviving wire ``provider`` column. The old ``provider`` column already
   held the transport/wire value (ground-map-db.md: "provider = transport
   provider; provider_route = model.route or model.provider"), so this is a
   pure drop of ``provider_route`` with no data movement. Add nullable
   ``upstream_provider``, ``outcome``, ``catalog_revision``,
   ``request_fingerprint``, ``cache_strategy``, ``cache_ttl``,
   ``error_origin``, and ``error_code``; backfill the latter three (as
   ``outcome``/``error_origin``/``error_code``) through one frozen legacy
   ``error_class`` -> (outcome, origin, code) table (see
   ``_ERROR_CLASS_MAP`` below); every other legacy error_class, and any row
   with error_class NULL, gets an ``outcome`` derived from
   ``terminal_attempt_status`` alone and NULL origin/code. Then drop
   ``error_class``, ``ck_llm_calls_provider``, and
   ``ck_llm_calls_provider_route`` (the surviving-column check is dropped too
   — it rejects 'moonshot', which the new target union requires).
5. Drop ``messages.model_id``, ``messages.error_code``,
   ``chat_prompt_assemblies.model_id``, ``chat_runs.model_id``,
   ``chat_runs.reasoning``, ``ck_chat_runs_reasoning``, ``chat_runs.key_mode``,
   ``ck_chat_runs_key_mode``, and the obsolete key-mode ledger columns
   (``llm_calls.key_mode_requested``/``key_mode_used``).
6. Drop ``models`` and ``user_api_keys`` once every FK/consumer above is gone.

INFERRED, not literal spec text (flagged per Phase D instructions):

- ``_ERROR_CLASS_MAP`` itself: §11 point 4 says "map recognized legacy
  error_class values through one frozen migration table; unknown/free class
  names leave the new origin/code null" but does not enumerate the table.
  This migration derives it from the closed §9 origin/code leaf pairs
  (``TransientExhausted`` causes -> provider_http/rate_limited,
  transport/timeout, provider_http/provider_unavailable,
  provider_stream/stream_interrupted) plus the legacy error_class sources
  documented in .dossiers/ground-map-db.md line 35
  (``api_error_code_for_model_call`` + direct writes). Legacy classes with no
  cutover-side equivalent (invalid-key/quota/bad-request/no-key — all BYOK or
  generic-catch concepts the new runtime does not represent) map to NULL
  origin/code, matching the "unknown/free" fallback.
- ``outcome`` has no legacy column at all; it is derived from
  ``terminal_attempt_status`` ('success' -> succeeded, 'abandoned' ->
  cancelled, else -> failed), with two explicit legacy-error-class overrides
  ('E_CANCELLED' -> cancelled, 'E_LLM_INCOMPLETE' -> incomplete) since those
  two outcomes are not "failed" in the new closed ``CallOutcome`` union and
  would otherwise be misclassified by the terminal_attempt_status fallback.
- ``chat_runs.error_origin``/``chat_runs.support_id`` are new columns with no
  backfill source described in §11; they are added NULL for all historical
  rows (support_id is a runtime-generated terminalize-time value with no
  retroactive equivalent).
- ``catalog_revision``/``request_fingerprint``/``cache_strategy``/
  ``cache_ttl``/``upstream_provider`` have no legacy source; added NULL.

Downgrade is blocked: step 4/5/6 drop columns, checks, and two whole tables
with no reconstructable inverse (the collapsed provider/provider_route pair,
the error_class free-text detail, and every BYOK key row are gone for good).

Revision ID: 0186
Revises: 0183
Create Date: 2026-07-20
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0186"
down_revision: str | Sequence[str] | None = "0183"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The frozen cutover profile registry (services/llm_profiles.py PROFILES),
# transcribed here so the migration never imports live application code (the
# registry can drift after this migration ships; the historical backfill must
# not). Only the seven directly product-selectable profiles participate —
# the hidden OpenRouter operator row is never a historical chat selection.
# (profile_id, provider, model_name, valid reasoning_effort values)
_PROFILE_TARGETS: tuple[tuple[str, str, str, tuple[str, ...]], ...] = (
    ("fast", "openai", "gpt-5.6-luna", ("none", "low", "medium", "high", "xhigh", "max")),
    ("balanced", "openai", "gpt-5.6-terra", ("none", "low", "medium", "high", "xhigh", "max")),
    ("deep", "openai", "gpt-5.6-sol", ("none", "low", "medium", "high", "xhigh", "max")),
    ("claude", "anthropic", "claude-sonnet-5", ("low", "medium", "high", "xhigh", "max")),
    ("fable", "anthropic", "claude-fable-5", ("low", "medium", "high", "xhigh", "max")),
    ("gemini", "gemini", "gemini-3.5-flash", ("minimal", "low", "medium", "high")),
    ("kimi", "moonshot", "kimi-k3", ("low", "high", "max")),
)

# Frozen legacy llm_calls.error_class -> (error_origin, error_code) table (see
# module docstring "INFERRED" note). Only classes with a real cutover-side
# equivalent get a non-NULL pair; everything else (including error_class
# IS NULL) leaves both NULL.
_ERROR_CLASS_MAP: tuple[tuple[str, str, str], ...] = (
    ("E_LLM_INTERRUPTED", "provider_stream", "stream_interrupted"),
    ("E_LLM_RATE_LIMIT", "provider_http", "rate_limited"),
    ("E_LLM_TIMEOUT", "transport", "timeout"),
    ("E_LLM_PROVIDER_DOWN", "provider_http", "provider_unavailable"),
    ("E_LLM_CONTEXT_TOO_LARGE", "provider_response", "context_too_large"),
)


def _fail(phase: str, message: str) -> None:
    raise RuntimeError(f"0186 {phase}: {message}")


def _report(message: str) -> None:
    print(f"0186: {message}")


def _profile_match_case_sql(*, provider_col: str, model_col: str, effort_col: str) -> str:
    """A SQL CASE returning the matched profile_id, or NULL, from the given columns.

    Matches only when the (provider, model) pair is one of the frozen
    registry's seven targets AND effort is an explicit (non-'default') value
    that profile actually offers.
    """
    lines = ["CASE"]
    for profile_id, provider, model_name, options in _PROFILE_TARGETS:
        options_sql = ", ".join(f"'{o}'" for o in options)
        lines.append(
            f"  WHEN {provider_col} = '{provider}' AND {model_col} = '{model_name}'"
            f" AND {effort_col} IN ({options_sql}) THEN '{profile_id}'"
        )
    lines.append("  ELSE NULL")
    lines.append("END")
    return "\n".join(lines)


def _error_class_case_sql(*, target: str) -> str:
    """A SQL CASE selecting `outcome`/`error_origin`/`error_code` from error_class.

    `target` is one of "origin" or "code"; both read the same frozen table.
    """
    idx = {"origin": 1, "code": 2}[target]
    lines = ["CASE"]
    for row in _ERROR_CLASS_MAP:
        lines.append(f"  WHEN error_class = '{row[0]}' THEN '{row[idx]}'")
    lines.append("  ELSE NULL")
    lines.append("END")
    return "\n".join(lines)


def _preflight(bind) -> None:
    """SELECT-only validation (spec §11 point 3). No mutation; reports the
    exact offending chat_run ids so operators can inspect their ledger
    history before rerunning."""

    rows = bind.execute(
        sa.text(
            "SELECT owner_id FROM llm_calls"
            " WHERE owner_kind = 'chat_run'"
            " GROUP BY owner_id"
            " HAVING count(DISTINCT provider_route || chr(31) || model_name) > 1"
            "     OR count(DISTINCT reasoning_effort)"
            "          FILTER (WHERE reasoning_effort <> 'default') > 1"
            " ORDER BY owner_id"
        )
    ).fetchall()
    if rows:
        ids = [str(row[0]) for row in rows]
        _fail(
            "preflight",
            f"{len(ids)} chat_run id(s) have llm_calls rows that disagree with each"
            f" other on (provider_route, model_name) or on a non-'default'"
            f" reasoning_effort; the migration cannot guess which call was"
            f" representative — inspect and reconcile the ledger, then rerun: {ids}",
        )


def upgrade() -> None:
    bind = op.get_bind()

    # --- Preflight (spec §11 point 3; no mutation) -------------------------
    _preflight(bind)

    # --- chat_runs: add snapshot columns ------------------------------------
    op.execute("""
        ALTER TABLE chat_runs
            ADD COLUMN profile_id text NULL,
            ADD COLUMN reasoning_option_id text NULL,
            ADD COLUMN provider text NULL,
            ADD COLUMN model_name text NULL,
            ADD COLUMN reasoning_effort text NULL,
            ADD COLUMN error_origin text NULL,
            ADD COLUMN support_id text NULL
    """)

    # --- chat_runs: backfill from the polymorphic llm_calls join -----------
    # (spec §11 point 2; representative row = row_number() = 1 over
    # (call_seq, created_at, id); 'default' clears both the resolved effort
    # and the selection snapshots for that run — see module docstring.)
    profile_case = _profile_match_case_sql(
        provider_col="provider_route", model_col="model_name", effort_col="reasoning_effort"
    )
    result = bind.execute(
        sa.text(f"""
            WITH representative AS (
                SELECT
                    owner_id, provider_route, model_name, reasoning_effort,
                    row_number() OVER (
                        PARTITION BY owner_id ORDER BY call_seq ASC, created_at ASC, id ASC
                    ) AS rn
                FROM llm_calls
                WHERE owner_kind = 'chat_run'
            ),
            matched AS (
                SELECT
                    owner_id,
                    provider_route,
                    model_name,
                    reasoning_effort,
                    {profile_case} AS matched_profile_id
                FROM representative
                WHERE rn = 1
            )
            UPDATE chat_runs
            SET
                provider = matched.provider_route,
                model_name = matched.model_name,
                reasoning_effort = NULLIF(matched.reasoning_effort, 'default'),
                profile_id = matched.matched_profile_id,
                reasoning_option_id = CASE
                    WHEN matched.matched_profile_id IS NOT NULL THEN matched.reasoning_effort
                    ELSE NULL
                END
            FROM matched
            WHERE chat_runs.id = matched.owner_id
        """)
    )
    _report(f"backfilled {result.rowcount} chat_runs row(s) from llm_calls history")

    # --- llm_calls: add new columns ------------------------------------------
    op.execute("""
        ALTER TABLE llm_calls
            ADD COLUMN upstream_provider text NULL,
            ADD COLUMN outcome text NULL,
            ADD COLUMN catalog_revision text NULL,
            ADD COLUMN request_fingerprint text NULL,
            ADD COLUMN cache_strategy text NULL,
            ADD COLUMN cache_ttl text NULL,
            ADD COLUMN error_origin text NULL,
            ADD COLUMN error_code text NULL
    """)

    # --- llm_calls: backfill outcome/error_origin/error_code (spec §11 point
    # 4; frozen error_class table, see module docstring "INFERRED" note) -----
    origin_case = _error_class_case_sql(target="origin")
    code_case = _error_class_case_sql(target="code")
    result = bind.execute(
        sa.text(f"""
            UPDATE llm_calls
            SET
                outcome = CASE
                    WHEN error_class = 'E_CANCELLED' THEN 'cancelled'
                    WHEN error_class = 'E_LLM_INCOMPLETE' THEN 'incomplete'
                    WHEN terminal_attempt_status = 'success' THEN 'succeeded'
                    WHEN terminal_attempt_status = 'abandoned' THEN 'cancelled'
                    ELSE 'failed'
                END,
                error_origin = {origin_case},
                error_code = {code_case}
        """)
    )
    _report(f"backfilled outcome/error_origin/error_code on {result.rowcount} llm_calls row(s)")

    # --- llm_calls: collapse provider/provider_route, drop retired columns -
    # The surviving `provider` column already holds the wire value; only
    # `provider_route` is dropped (no data movement — spec §11 point 4).
    op.execute("ALTER TABLE llm_calls DROP CONSTRAINT ck_llm_calls_provider")
    op.execute("ALTER TABLE llm_calls DROP CONSTRAINT ck_llm_calls_provider_route")
    op.execute("""
        ALTER TABLE llm_calls
            DROP COLUMN error_class,
            DROP COLUMN key_mode_requested,
            DROP COLUMN key_mode_used,
            DROP COLUMN provider_route
    """)

    # --- messages: drop model_id (+ FK) and error_code ----------------------
    op.execute("ALTER TABLE messages DROP CONSTRAINT messages_model_id_fkey")
    op.execute("ALTER TABLE messages DROP COLUMN model_id, DROP COLUMN error_code")

    # --- chat_prompt_assemblies: drop model_id (+ FK) -----------------------
    op.execute(
        "ALTER TABLE chat_prompt_assemblies DROP CONSTRAINT chat_prompt_assemblies_model_id_fkey"
    )
    op.execute("ALTER TABLE chat_prompt_assemblies DROP COLUMN model_id")

    # --- chat_runs: drop model_id (+ FK), reasoning (+ check), key_mode
    # (+ check) — after the backfill above, which no longer needs them -------
    op.execute("ALTER TABLE chat_runs DROP CONSTRAINT chat_runs_model_id_fkey")
    op.execute("ALTER TABLE chat_runs DROP CONSTRAINT ck_chat_runs_reasoning")
    op.execute("ALTER TABLE chat_runs DROP CONSTRAINT ck_chat_runs_key_mode")
    op.execute("""
        ALTER TABLE chat_runs
            DROP COLUMN model_id,
            DROP COLUMN reasoning,
            DROP COLUMN key_mode
    """)

    # --- Drop models and user_api_keys once every FK/consumer above is gone -
    op.execute("DROP TABLE models")
    op.execute("DROP TABLE user_api_keys")


def downgrade() -> None:
    raise NotImplementedError(
        "0186 is a hard cutover migration and has no downgrade path: it drops"
        " the models and user_api_keys tables, the provider/provider_route"
        " and key-mode ledger columns, and every model_id FK, none of which is"
        " reconstructable from the collapsed post-cutover shape."
    )
