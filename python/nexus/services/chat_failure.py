"""The single owner of chat failure projection and rerun-eligibility policy.

``ChatRunOut``, message hydration, terminal SSE folding and the trust trail all
derive the same ``ExpectedChatFailure`` from ``ChatRun``; none stores a second
failure. A rerun receives the current fixed chat tool plan as a new admission.
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

# Deterministic or operator-owned outcomes never expose a rerun affordance.
_NEVER_RERUNNABLE_CODES = frozenset({"context_too_large", "invalid_output", "operator_defect"})
_CONDITIONALLY_RERUNNABLE_CODES = frozenset({"incomplete", "cancelled", "assistant_unavailable"})

_CODE_MAP = {
    "timeout": "incomplete",
    "output_limit": "incomplete",
    "turn_limit": "incomplete",
    "auth": "assistant_unavailable",
    "quota": "assistant_unavailable",
    "capacity_unavailable": "assistant_unavailable",
    "runtime_unavailable": "assistant_unavailable",
    "policy_violation": "operator_defect",
}

_FAILURES = {
    "cancelled": CancelledChatFailure,
    "incomplete": IncompleteChatFailure,
    "assistant_unavailable": AssistantUnavailableChatFailure,
}
_UNCONDITIONAL_FAILURES = {
    "context_too_large": ContextTooLargeChatFailure,
    "invalid_output": InvalidOutputChatFailure,
    "operator_defect": OperatorDefectChatFailure,
}


def chat_failure_projection(run: ChatRun) -> ExpectedChatFailure | None:
    """Project a terminal run onto the closed failure union, or ``None``.

    A stored terminal this projection cannot represent degrades to ``None`` (the
    generic non-rerunnable card) plus a loud operator log, never a 500. The
    write-side invariants that produce ``ChatRun.error_code`` stay strict.
    """

    code = "cancelled" if run.status == "cancelled" else run.error_code
    if code is None:
        return None
    code = _CODE_MAP.get(code, code)
    unconditional = _UNCONDITIONAL_FAILURES.get(code)
    if unconditional is not None:
        return unconditional()
    conditional = _FAILURES.get(code)
    if conditional is None:
        logger.error(
            "chat_failure.unrepresentable_terminal",
            run_id=str(run.id),
            error_code=run.error_code,
            run_status=run.status,
        )
        return None
    return conditional(
        can_rerun=rerun_eligibility(
            error_code=code,
            run_status=run.status,
        )
    )


def rerun_eligibility(
    *,
    error_code: str,
    run_status: str,
) -> bool:
    """The one rerun-eligibility policy, re-evaluated inside the rerun transaction.

    ``run_status`` gates on top of ``error_code``: a rerun source must actually
    be terminal in the state its code implies. A mismatch is ineligible rather
    than a defect — it can only arise from stale or racing input.
    """

    code = _CODE_MAP.get(error_code, error_code)
    if run_status != ("cancelled" if code == "cancelled" else "error"):
        return False
    if code in _NEVER_RERUNNABLE_CODES:
        return False
    if code in _CONDITIONALLY_RERUNNABLE_CODES:
        return True
    raise AssertionError(f"rerun_eligibility: unrecognized error_code {error_code!r}")
