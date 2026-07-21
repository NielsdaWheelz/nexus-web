"""The single owner of chat failure projection and rerun-eligibility policy.

`docs/cutovers/llm-provider-runtime-hard-cutover.md` §10 ("Failure and
rerun"): `ChatRunOut`, message hydration, terminal SSE, reconnect folding, and
the trust trail all derive the same `ExpectedChatFailure` projection from
`ChatRun`; none stores or synthesizes a second failure. `chat_reruns.py` is
the only other reader of `rerun_eligibility` — it re-evaluates the same
policy in the rerun transaction against freshly queried facts; the UI's
`can_rerun` flag on an earlier read is never authority for the rerun itself.

`chat_failure_projection` derives purely from stored/caller-supplied facts,
never from a heuristic:

- `has_write_tool_attempt` is not a `ChatRun` column. It is computed by the
  caller from `message_tool_calls`/`chat_run_events` (see
  `compute_has_write_tool_attempt` below) exactly as the dossier's §10 EXISTS
  predicate specifies, and passed in.
- `attempts` (required only for the four transient codes) is likewise not a
  `ChatRun` column — migration 0186 adds no such column — so it is sourced by
  the caller from the run's terminal `llm_calls.attempt_count` row (see
  `compute_terminal_attempts` below) and passed in. This is the one place
  this module's signature necessarily diverges from the two-argument shape
  written in `.dossiers/nexus-backend-api.md`; the divergence follows the
  same "caller computes a derived fact, module applies pure policy to it"
  shape already established there for `has_write_tool_attempt`.
"""

from __future__ import annotations

from typing import Literal, cast

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun
from nexus.schemas.llm import (
    BudgetExceededChatFailure,
    CancelledChatFailure,
    ContextTooLargeChatFailure,
    ExpectedChatFailure,
    IncompleteChatFailure,
    InvalidToolArgumentsChatFailure,
    ProviderUnavailableChatFailure,
    RateLimitedChatFailure,
    RefusedChatFailure,
    StreamInterruptedChatFailure,
    TimeoutChatFailure,
)
from nexus.schemas.presence import Absent, Present, presence_from_nullable
from nexus.services.llm_profiles import profile as lookup_profile

# The closed §10 code set a terminal ChatRun can carry as error_code, plus the
# statusonly "cancelled" pseudo-code (ChatRun never stores error_code=
# 'cancelled'; run.status == 'cancelled' alone drives that variant).
#
# Refusal and budget denial reproduce identically on rerun (§10: "Refusal and
# budget denial are not rerunnable"). context_too_large is grouped here too:
# it is not named among the conditionally-rerunnable codes below, and
# rerunning the identical assembled context deterministically reproduces the
# same oversize outcome — INFERRED from the closed list's shape, not a
# literal spec sentence; flagged in the impl report.
_NEVER_RERUNNABLE_CODES = frozenset({"refused", "budget_exceeded", "context_too_large"})

# "can_rerun=true for incomplete, cancelled, invalid-tool-argument, and
# transient-exhaustion outcomes only while the exact profile remains active
# and no side-effecting write tool was attempted" (§10).
_CONDITIONALLY_RERUNNABLE_CODES = frozenset(
    {
        "incomplete",
        "cancelled",
        "invalid_tool_arguments",
        "rate_limited",
        "timeout",
        "provider_unavailable",
        "stream_interrupted",
    }
)

TRANSIENT_CODES = frozenset(
    {"rate_limited", "timeout", "provider_unavailable", "stream_interrupted"}
)

_REFUSED_ORIGINS: tuple[Literal["provider_http", "provider_stream"], ...] = (
    "provider_http",
    "provider_stream",
)
_INCOMPLETE_ORIGINS: tuple[Literal["provider_response"], ...] = ("provider_response",)
_CONTEXT_TOO_LARGE_ORIGINS: tuple[Literal["intent", "provider_http"], ...] = (
    "intent",
    "provider_http",
)
_INVALID_TOOL_ARGUMENTS_ORIGINS: tuple[Literal["tool_arguments"], ...] = ("tool_arguments",)
_BUDGET_EXCEEDED_ORIGINS: tuple[Literal["budget"], ...] = ("budget",)
_RATE_LIMITED_ORIGINS: tuple[Literal["provider_http"], ...] = ("provider_http",)
_TIMEOUT_ORIGINS: tuple[Literal["transport"], ...] = ("transport",)
_PROVIDER_UNAVAILABLE_ORIGINS: tuple[Literal["provider_http", "transport"], ...] = (
    "provider_http",
    "transport",
)
_STREAM_INTERRUPTED_ORIGINS: tuple[Literal["provider_stream"], ...] = ("provider_stream",)


def chat_failure_projection(
    run: ChatRun,
    *,
    has_write_tool_attempt: bool,
    attempts: int | None = None,
) -> ExpectedChatFailure | None:
    """Project one `ChatRun`'s stored facts onto the closed `ExpectedChatFailure`
    union, or `None` for a run that is not a card-bearing failure at all (still
    running/queued/complete, or a defect with no stored closed code — §10:
    "A defect exposes no failure variant ... the existing terminal failed run
    status plus support_id makes the screen boundary render the same generic,
    non-rerunnable card").

    `attempts` is required (and used) only for the four transient codes; pass
    `compute_terminal_attempts(db, run)` for those. Every other code ignores it.
    """
    support_id = presence_from_nullable(run.support_id)
    profile_active = _profile_active(run.profile_id)

    code = "cancelled" if run.status == "cancelled" else run.error_code
    if code is None:
        return None
    if code not in _NEVER_RERUNNABLE_CODES and code not in _CONDITIONALLY_RERUNNABLE_CODES:
        # justify-defect: see the matching guard at the bottom of this
        # function — the closed code set is exhaustively covered by the two
        # sets above. Checked up front so the failure mode is this function's
        # own message, not rerun_eligibility's.
        raise AssertionError(
            f"chat_failure_projection: unrecognized ChatRun.error_code {code!r} (run_id={run.id})"
        )

    can_rerun = rerun_eligibility(
        error_code=code,
        run_status=run.status,
        profile_active=profile_active,
        has_write_tool_attempt=has_write_tool_attempt,
    )

    if code == "cancelled":
        return CancelledChatFailure(support_id=support_id, can_rerun=can_rerun)
    if code == "refused":
        return RefusedChatFailure(
            origin=_origin(run, code, _REFUSED_ORIGINS),
            support_id=support_id,
            can_rerun=can_rerun,
        )
    if code == "incomplete":
        return IncompleteChatFailure(
            origin=_origin(run, code, _INCOMPLETE_ORIGINS),
            support_id=support_id,
            can_rerun=can_rerun,
        )
    if code == "context_too_large":
        return ContextTooLargeChatFailure(
            origin=_origin(run, code, _CONTEXT_TOO_LARGE_ORIGINS),
            support_id=support_id,
            can_rerun=can_rerun,
        )
    if code == "invalid_tool_arguments":
        return InvalidToolArgumentsChatFailure(
            origin=_origin(run, code, _INVALID_TOOL_ARGUMENTS_ORIGINS),
            support_id=support_id,
            can_rerun=can_rerun,
        )
    if code == "budget_exceeded":
        return BudgetExceededChatFailure(
            origin=_origin(run, code, _BUDGET_EXCEEDED_ORIGINS),
            support_id=support_id,
            can_rerun=can_rerun,
        )
    if code in TRANSIENT_CODES:
        if attempts is None:
            # justify-defect: every transient code is written by the terminal
            # fold from a TransientExhausted leaf, which always carries
            # attempts (§9). A caller reaching this without supplying
            # attempts (from compute_terminal_attempts) has a broken query,
            # not a legitimately absent fact.
            raise AssertionError(
                f"chat_failure_projection: attempts is required to project "
                f"ChatRun.error_code {code!r} (run_id={run.id})"
            )
        return _transient_variant(run, code, attempts, support_id, can_rerun)

    # justify-defect: ChatRun.error_code is written exactly once by the
    # terminal fold from the closed §9/§10 code set; any other stored value is
    # a broken write invariant, not a legitimately unrecognized product state.
    raise AssertionError(
        f"chat_failure_projection: unrecognized ChatRun.error_code {code!r} (run_id={run.id})"
    )


def _transient_variant(
    run: ChatRun,
    code: str,
    attempts: int,
    support_id: Absent | Present[str],
    can_rerun: bool,
) -> ExpectedChatFailure:
    if code == "rate_limited":
        return RateLimitedChatFailure(
            origin=_origin(run, code, _RATE_LIMITED_ORIGINS),
            attempts=attempts,
            support_id=support_id,
            can_rerun=can_rerun,
        )
    if code == "timeout":
        return TimeoutChatFailure(
            origin=_origin(run, code, _TIMEOUT_ORIGINS),
            attempts=attempts,
            support_id=support_id,
            can_rerun=can_rerun,
        )
    if code == "provider_unavailable":
        return ProviderUnavailableChatFailure(
            origin=_origin(run, code, _PROVIDER_UNAVAILABLE_ORIGINS),
            attempts=attempts,
            support_id=support_id,
            can_rerun=can_rerun,
        )
    return StreamInterruptedChatFailure(
        origin=_origin(run, code, _STREAM_INTERRUPTED_ORIGINS),
        attempts=attempts,
        support_id=support_id,
        can_rerun=can_rerun,
    )


def _origin[T: str](run: ChatRun, code: str, allowed: tuple[T, ...]) -> T:
    origin = run.error_origin
    if origin not in allowed:
        # justify-defect: each code fixes its valid origin Literal(s) at write
        # time (schemas/llm.py); a stored origin outside that set is a broken
        # terminal-fold invariant, not a legitimate product state.
        raise AssertionError(
            f"chat_failure_projection: ChatRun.error_origin {origin!r} is not valid for "
            f"error_code {code!r} (run_id={run.id}); allowed origins: {allowed!r}"
        )
    return cast(T, origin)


def _profile_active(profile_id: str | None) -> bool:
    """A run with no stored profile snapshot (legacy backfilled row, or a run
    that failed before profile resolution) has nothing to rerun against."""
    if profile_id is None:
        return False
    return lookup_profile(profile_id) is not None


def rerun_eligibility(
    *,
    error_code: str,
    run_status: str,
    profile_active: bool,
    has_write_tool_attempt: bool,
) -> bool:
    """The one rerun-eligibility policy (§10). `chat_failure_projection` fills
    every variant's `can_rerun` with it; `chat_reruns` re-evaluates it in the
    rerun transaction against freshly queried facts — never trusting an
    earlier read's `can_rerun` as authority.

    `run_status` gates on top of `error_code`: a rerun source must actually be
    terminal in the state its code implies (`cancelled` code only ever a
    `cancelled` run; every other code only ever an `error` run). A mismatch
    is treated as ineligible rather than a defect, since it can only arise
    from stale/racing input, not a write-time invariant this module owns.
    """
    expected_status = "cancelled" if error_code == "cancelled" else "error"
    if run_status != expected_status:
        return False

    if error_code in _NEVER_RERUNNABLE_CODES:
        return False
    if error_code in _CONDITIONALLY_RERUNNABLE_CODES:
        return profile_active and not has_write_tool_attempt

    # justify-defect: see chat_failure_projection's matching guard — the
    # closed code set is exhaustively covered by the two sets above.
    raise AssertionError(f"rerun_eligibility: unrecognized error_code {error_code!r}")


def compute_has_write_tool_attempt(db: Session, run: ChatRun) -> bool:
    """Caller-side helper for the `has_write_tool_attempt` fact (§10 dossier
    contract): true iff a durable write-tool call event or a
    `message_tool_calls.scope='assistant_write'` row exists for this run's
    assistant message, regardless of completion/revert state. This is
    deliberately not `chat_run_tools.assistant_write_tool_call_count`, which
    counts only committed, non-reverted rows for the per-run write cap — §10
    disqualifies rerun on any attempt at all, reverted or not.

    Imports `WRITE_TOOL_NAMES` lazily: `agent_tools.writes` sits behind a
    long, currently-broken (mid-cutover) import chain unrelated to failure
    policy (through `schemas.conversation` -> the pre-cutover `llm_catalog`
    module other Phase D slices are deleting), and this module must stay
    importable on its own right now. Reuses the single write-tool-name source
    rather than duplicating it once that chain is clean.
    """
    from nexus.services.agent_tools.writes import WRITE_TOOL_NAMES

    return bool(
        db.execute(
            text("""
                SELECT EXISTS (
                    SELECT 1 FROM message_tool_calls
                    WHERE assistant_message_id = :assistant_message_id
                      AND scope = 'assistant_write'
                )
                OR EXISTS (
                    SELECT 1 FROM chat_run_events
                    WHERE run_id = :run_id
                      AND event_type IN ('tool_call_start', 'tool_call_done')
                      AND payload ->> 'tool_name' = ANY(:tool_names)
                )
            """),
            {
                "assistant_message_id": run.assistant_message_id,
                "run_id": run.id,
                "tool_names": list(WRITE_TOOL_NAMES),
            },
        ).scalar_one()
    )


def compute_terminal_attempts(db: Session, run: ChatRun) -> int | None:
    """Caller-side helper for the `attempts` fact the transient variants carry.
    `ChatRun` stores no attempts column (migration 0186 adds none); this reads
    `attempt_count` off the run's terminal `llm_calls` row (highest
    `call_seq` for `owner_kind='chat_run', owner_id=run.id`) instead. `None`
    if the run has no ledger history at all.
    """
    return db.execute(
        text("""
            SELECT attempt_count FROM llm_calls
            WHERE owner_kind = 'chat_run' AND owner_id = :run_id
            ORDER BY call_seq DESC
            LIMIT 1
        """),
        {"run_id": run.id},
    ).scalar_one_or_none()
