"""The single owner of chat failure projection and rerun-eligibility policy.

`docs/cutovers/generation-backends-hard-cutover.md` §3.3 ("Chat")
contract") requires `ChatRunOut`, message hydration, terminal SSE, reconnect
folding, and the trust trail to derive the same `ExpectedChatFailure`
projection from `ChatRun`; none stores or synthesizes a second failure.
`chat_run_candidates.py` is the only other authority reader of
`rerun_eligibility` — it
re-evaluates the same policy in the rerun transaction against freshly queried
facts; the UI's `can_rerun` flag on an earlier read is never authority for the
rerun itself.

`chat_failure_projection` derives purely from stored/caller-supplied facts,
never from a heuristic:

- Selection eligibility is supplied from the current catalog observation that
  also builds `RunSelectionOut`; failure projection never rereads catalog or
  reconstructs selection state from dispatch columns.
- The final cutover deliberately removed the historical write-attempt rerun
  prohibition. A rerun is always a new `ReadOnly` admission, so an earlier
  additive-write grant can never carry into it.
"""

from __future__ import annotations

from nexus.db.models import ChatRun
from nexus.logging import get_logger
from nexus.schemas.llm import (
    AssistantUnavailableChatFailure,
    CancelledChatFailure,
    ContextTooLargeChatFailure,
    ExpectedChatFailure,
    IncompleteChatFailure,
    InvalidOutputChatFailure,
    OperatorDefectChatFailure,
)

logger = get_logger(__name__)


class _UnrepresentableTerminal(Exception):
    """Internal signal: a stored terminal state cannot be projected onto the
    closed `ExpectedChatFailure` union. On the read path this degrades to the
    generic non-rerunnable card (`failure=None`), never a 500 — see
    `chat_failure_projection`. The write side stays strict."""


# The closed §10 code set a terminal ChatRun can carry as error_code, plus the
# statusonly "cancelled" pseudo-code (ChatRun never stores error_code=
# 'cancelled'; run.status == 'cancelled' alone drives that variant).
#
# These outcomes are deterministic or operator-owned and therefore never
# expose a rerun affordance.
_NEVER_RERUNNABLE_CODES = frozenset({"context_too_large", "invalid_output", "operator_defect"})

# The current contract permits rerun only for incomplete, cancelled, and
# assistant-unavailable outcomes while the exact selection remains selectable.
_CONDITIONALLY_RERUNNABLE_CODES = frozenset(
    {
        "incomplete",
        "cancelled",
        "assistant_unavailable",
    }
)

_CODE_MAP = {
    "timeout": "incomplete",
    "output_limit": "incomplete",
    "auth": "assistant_unavailable",
    "quota": "assistant_unavailable",
    "capacity_unavailable": "assistant_unavailable",
    "runtime_unavailable": "assistant_unavailable",
    "policy_violation": "operator_defect",
    "runtime_defect": "operator_defect",
}


def chat_failure_projection(
    run: ChatRun,
    *,
    selection_selectable: bool,
) -> ExpectedChatFailure | None:
    """Project one `ChatRun`'s stored facts onto the closed `ExpectedChatFailure`
    union, or `None` for a run that is not a card-bearing failure at all. A
    corrupted or future terminal that has no representable closed code also
    projects to the generic non-rerunnable card.

    A terminal state this projection cannot represent degrades here to
    `failure=None` (the generic non-rerunnable card) plus a loud operator log —
    never an `AssertionError` that would 500 `ChatRunOut`, message hydration,
    terminal SSE folding, or the trust trail. The write-side invariants that
    produce `ChatRun.error_code` stay strict.
    """
    try:
        return _project_failure(
            run,
            selection_selectable=selection_selectable,
        )
    except _UnrepresentableTerminal as exc:
        logger.error(
            "chat_failure.unrepresentable_terminal",
            run_id=str(run.id),
            error_code=run.error_code,
            run_status=run.status,
            reason=str(exc),
        )
        return None


def _project_failure(
    run: ChatRun,
    *,
    selection_selectable: bool,
) -> ExpectedChatFailure | None:
    code = "cancelled" if run.status == "cancelled" else run.error_code
    if code is None:
        return None
    code = _CODE_MAP.get(code, code)
    if code not in _NEVER_RERUNNABLE_CODES and code not in _CONDITIONALLY_RERUNNABLE_CODES:
        # The closed code set is exhaustively covered by the two sets above;
        # any other stored value is an unrepresentable terminal: generic card
        # on read and a loud operator signal.
        raise _UnrepresentableTerminal(f"unrecognized ChatRun.error_code {code!r}")

    can_rerun = rerun_eligibility(
        error_code=code,
        run_status=run.status,
        selection_selectable=selection_selectable,
    )

    if code == "cancelled":
        return CancelledChatFailure(can_rerun=can_rerun)
    if code == "incomplete":
        return IncompleteChatFailure(can_rerun=can_rerun)
    if code == "context_too_large":
        return ContextTooLargeChatFailure()
    if code == "invalid_output":
        return InvalidOutputChatFailure()
    if code == "assistant_unavailable":
        return AssistantUnavailableChatFailure(can_rerun=can_rerun)
    if code == "operator_defect":
        return OperatorDefectChatFailure()

    # Unreachable given the up-front guard; kept as a total-match backstop.
    raise _UnrepresentableTerminal(f"unrecognized ChatRun.error_code {code!r}")


def rerun_eligibility(
    *,
    error_code: str,
    run_status: str,
    selection_selectable: bool,
) -> bool:
    """The one rerun-eligibility policy (§10). `chat_failure_projection` fills
    every variant's `can_rerun` with it; `chat_run_candidates` re-evaluates it in the
    rerun transaction against freshly queried facts — never trusting an
    earlier read's `can_rerun` as authority. The caller must supply the current
    exact selection's server-owned selectability observation.

    `run_status` gates on top of `error_code`: a rerun source must actually be
    terminal in the state its code implies (`cancelled` code only ever a
    `cancelled` run; every other code only ever an `error` run). A mismatch
    is treated as ineligible rather than a defect, since it can only arise
    from stale/racing input, not a write-time invariant this module owns.
    """
    code = _CODE_MAP.get(error_code, error_code)
    expected_status = "cancelled" if code == "cancelled" else "error"
    if run_status != expected_status:
        return False

    if code in _NEVER_RERUNNABLE_CODES:
        return False
    if code in _CONDITIONALLY_RERUNNABLE_CODES:
        return selection_selectable

    # justify-defect: see chat_failure_projection's matching guard — the
    # closed code set is exhaustively covered by the two sets above.
    raise AssertionError(f"rerun_eligibility: unrecognized error_code {error_code!r}")
