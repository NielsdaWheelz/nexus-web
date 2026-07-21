"""Unit tests for the single chat-failure projection + rerun-eligibility policy
owner (`nexus.services.chat_failure`; docs/cutovers/llm-provider-runtime-hard-
cutover.md §10)."""

from __future__ import annotations

from uuid import uuid4

import pytest

from nexus.db.models import ChatRun
from nexus.schemas.llm import (
    BudgetExceededChatFailure,
    CancelledChatFailure,
    ContextTooLargeChatFailure,
    IncompleteChatFailure,
    InvalidToolArgumentsChatFailure,
    ProviderUnavailableChatFailure,
    RateLimitedChatFailure,
    RefusedChatFailure,
    StreamInterruptedChatFailure,
    TimeoutChatFailure,
)
from nexus.schemas.presence import Absent, Present
from nexus.services.chat_failure import (
    TRANSIENT_CODES,
    chat_failure_projection,
    rerun_eligibility,
)

pytestmark = pytest.mark.unit

# Active profile id drawn from the real registry (services/llm_profiles.PROFILES);
# any id absent from that registry (retired/unknown/never-set) reads as inactive.
_ACTIVE_PROFILE_ID = "balanced"
_INACTIVE_PROFILE_ID = "retired-profile"

# One row per closed §10 code: (code, a valid origin for that code, the variant
# class, whether it carries `attempts`, whether it is ever conditionally
# rerunnable at all).
_CODE_TABLE: list[tuple[str, str | None, type, bool, bool]] = [
    ("refused", "provider_http", RefusedChatFailure, False, False),
    ("incomplete", "provider_response", IncompleteChatFailure, False, True),
    ("cancelled", None, CancelledChatFailure, False, True),
    ("context_too_large", "intent", ContextTooLargeChatFailure, False, False),
    ("invalid_tool_arguments", "tool_arguments", InvalidToolArgumentsChatFailure, False, True),
    ("budget_exceeded", "budget", BudgetExceededChatFailure, False, False),
    ("rate_limited", "provider_http", RateLimitedChatFailure, True, True),
    ("timeout", "transport", TimeoutChatFailure, True, True),
    ("provider_unavailable", "provider_http", ProviderUnavailableChatFailure, True, True),
    ("stream_interrupted", "provider_stream", StreamInterruptedChatFailure, True, True),
]

_ALL_CODES = [row[0] for row in _CODE_TABLE]


# A reasoning option the active ("balanced") profile actually offers; a run's
# selection must still resolve for its profile to count as rerunnable-active.
_ACTIVE_REASONING_OPTION_ID = "medium"


def _make_run(
    *,
    status: str,
    error_code: str | None,
    error_origin: str | None = None,
    support_id: str | None = None,
    profile_id: str | None = _ACTIVE_PROFILE_ID,
    reasoning_option_id: str | None = _ACTIVE_REASONING_OPTION_ID,
    provider: str | None = None,
    model_name: str | None = None,
    reasoning_effort: str | None = None,
) -> ChatRun:
    """A bare (unpersisted) ChatRun carrying only the facts this module reads.

    `provider`/`model_name`/`reasoning_effort` default to None (no resolved
    snapshot recorded ⇒ no drift evidence); pass them to exercise the §10
    changed-profile drift gate."""
    run = ChatRun()
    run.id = uuid4()
    run.owner_user_id = uuid4()
    run.conversation_id = uuid4()
    run.user_message_id = uuid4()
    run.assistant_message_id = uuid4()
    run.idempotency_key = f"test-{uuid4()}"
    run.payload_hash = "test-payload-hash"
    run.status = status
    run.profile_id = profile_id
    run.reasoning_option_id = reasoning_option_id
    run.provider = provider
    run.model_name = model_name
    run.reasoning_effort = reasoning_effort
    run.error_code = error_code
    run.error_origin = error_origin
    run.support_id = support_id
    return run


def _status_for(code: str) -> str:
    return "cancelled" if code == "cancelled" else "error"


# =============================================================================
# Not-a-failure and defect cases
# =============================================================================


@pytest.mark.parametrize("status", ["queued", "running", "complete"])
def test_non_terminal_run_projects_to_none(status: str) -> None:
    run = _make_run(status=status, error_code=None)
    assert chat_failure_projection(run, has_write_tool_attempt=False) is None


def test_defect_error_run_with_no_stored_code_projects_to_none() -> None:
    # §10: "A defect exposes no failure variant ... the existing terminal
    # failed run status plus support_id makes the screen boundary render the
    # same generic, non-rerunnable card."
    run = _make_run(status="error", error_code=None, support_id="deadbeef1234")
    assert chat_failure_projection(run, has_write_tool_attempt=False) is None


def test_cancelled_status_drives_the_cancelled_variant_regardless_of_error_code() -> None:
    # ChatRun never stores error_code='cancelled'; status alone drives it, and
    # projection must not consult a stray error_code on a cancelled row.
    run = _make_run(status="cancelled", error_code=None)
    result = chat_failure_projection(run, has_write_tool_attempt=False)
    assert isinstance(result, CancelledChatFailure)


# =============================================================================
# Per-code variant shape (origin, attempts, support_id)
# =============================================================================


@pytest.mark.parametrize("code,origin,variant_cls,carries_attempts,_conditional", _CODE_TABLE)
def test_projection_builds_the_correct_variant(
    code: str,
    origin: str | None,
    variant_cls: type,
    carries_attempts: bool,
    _conditional: bool,
) -> None:
    run = _make_run(
        status=_status_for(code),
        error_code=None if code == "cancelled" else code,
        error_origin=origin,
        support_id="abc123def456",
    )
    attempts = 3 if carries_attempts else None
    result = chat_failure_projection(run, has_write_tool_attempt=False, attempts=attempts)

    assert isinstance(result, variant_cls)
    assert result.code == code
    assert result.support_id == Present[str](value="abc123def456")
    if origin is not None:
        assert result.origin == origin
    if carries_attempts:
        assert result.attempts == 3


def test_absent_support_id_when_run_has_no_support_id() -> None:
    run = _make_run(status="error", error_code="refused", error_origin="provider_http")
    result = chat_failure_projection(run, has_write_tool_attempt=False)
    assert isinstance(result, RefusedChatFailure)
    assert result.support_id == Absent()


# F2 (§10 576-579): an unrepresentable terminal state degrades on the READ path
# to the generic non-rerunnable card (failure=None) plus a loud operator log —
# never an AssertionError that 500s ChatRunOut / hydration / SSE-fold / trust
# trail. (The write side that produces these columns stays strict.)


@pytest.mark.parametrize("code", [c for c in TRANSIENT_CODES])
def test_transient_code_without_attempts_degrades_to_none(code: str) -> None:
    origin = next(row[1] for row in _CODE_TABLE if row[0] == code)
    run = _make_run(status="error", error_code=code, error_origin=origin)
    assert chat_failure_projection(run, has_write_tool_attempt=False, attempts=None) is None


def test_invalid_origin_for_a_code_degrades_to_none() -> None:
    # 'transport' is not a valid origin for 'refused' (only provider_http /
    # provider_stream are) — an unrepresentable terminal, not a read outage.
    run = _make_run(status="error", error_code="refused", error_origin="transport")
    assert chat_failure_projection(run, has_write_tool_attempt=False) is None


def test_unrecognized_error_code_degrades_to_none() -> None:
    run = _make_run(status="error", error_code="not_a_real_code")
    assert chat_failure_projection(run, has_write_tool_attempt=False) is None


# =============================================================================
# F1: changed-profile drift makes a conditionally-rerunnable outcome
# non-rerunnable (§10: "a retired, uncertified, or CHANGED profile makes
# can_rerun=false; rerun never remaps a historical target").
# =============================================================================


def test_retired_profile_makes_conditionally_rerunnable_not_rerunnable() -> None:
    run = _make_run(status="error", error_code="incomplete", error_origin="provider_response",
                    profile_id=_INACTIVE_PROFILE_ID)
    result = chat_failure_projection(run, has_write_tool_attempt=False)
    assert isinstance(result, IncompleteChatFailure)
    assert result.can_rerun is False


def test_missing_reasoning_option_selection_is_not_rerunnable() -> None:
    run = _make_run(status="error", error_code="incomplete", error_origin="provider_response",
                    reasoning_option_id=None)
    result = chat_failure_projection(run, has_write_tool_attempt=False)
    assert isinstance(result, IncompleteChatFailure)
    assert result.can_rerun is False


def test_reasoning_option_no_longer_offered_is_not_rerunnable() -> None:
    # 'minimal' is offered by gemini, not by the active 'balanced' profile.
    run = _make_run(status="error", error_code="incomplete", error_origin="provider_response",
                    reasoning_option_id="minimal")
    result = chat_failure_projection(run, has_write_tool_attempt=False)
    assert result is not None
    assert result.can_rerun is False


def test_drifted_target_snapshot_makes_it_not_rerunnable() -> None:
    # Operator repointed the profile: the run's recorded resolved target no
    # longer matches what 'balanced' resolves to today (openai/gpt-5.6-terra).
    run = _make_run(status="error", error_code="incomplete", error_origin="provider_response",
                    provider="anthropic", model_name="claude-sonnet-5")
    result = chat_failure_projection(run, has_write_tool_attempt=False)
    assert isinstance(result, IncompleteChatFailure)
    assert result.can_rerun is False


def test_matching_target_snapshot_stays_rerunnable() -> None:
    # Snapshot matches the current 'balanced' resolution ⇒ no drift ⇒ rerunnable.
    run = _make_run(status="error", error_code="incomplete", error_origin="provider_response",
                    provider="openai", model_name="gpt-5.6-terra",
                    reasoning_effort=_ACTIVE_REASONING_OPTION_ID)
    result = chat_failure_projection(run, has_write_tool_attempt=False)
    assert isinstance(result, IncompleteChatFailure)
    assert result.can_rerun is True


# =============================================================================
# rerun_eligibility policy shape
# =============================================================================


@pytest.mark.parametrize("code", ["refused", "budget_exceeded", "context_too_large"])
def test_never_rerunnable_codes_ignore_profile_and_write_tool_state(code: str) -> None:
    for profile_active in (True, False):
        for has_write_tool_attempt in (True, False):
            assert (
                rerun_eligibility(
                    error_code=code,
                    run_status="error",
                    profile_active=profile_active,
                    has_write_tool_attempt=has_write_tool_attempt,
                )
                is False
            )


@pytest.mark.parametrize(
    "code", ["incomplete", "cancelled", "invalid_tool_arguments", *TRANSIENT_CODES]
)
def test_conditionally_rerunnable_codes_require_active_profile_and_no_write_tool(
    code: str,
) -> None:
    status = _status_for(code)
    assert (
        rerun_eligibility(
            error_code=code, run_status=status, profile_active=True, has_write_tool_attempt=False
        )
        is True
    )
    assert (
        rerun_eligibility(
            error_code=code, run_status=status, profile_active=False, has_write_tool_attempt=False
        )
        is False
    )
    assert (
        rerun_eligibility(
            error_code=code, run_status=status, profile_active=True, has_write_tool_attempt=True
        )
        is False
    )
    assert (
        rerun_eligibility(
            error_code=code, run_status=status, profile_active=False, has_write_tool_attempt=True
        )
        is False
    )


def test_rerun_eligibility_rejects_a_status_code_mismatch() -> None:
    # 'incomplete' would otherwise be eligible; a run_status of 'cancelled'
    # (or anything but 'error') for a non-cancelled code is stale/racing input.
    assert (
        rerun_eligibility(
            error_code="incomplete",
            run_status="cancelled",
            profile_active=True,
            has_write_tool_attempt=False,
        )
        is False
    )
    # 'cancelled' code only ever pairs with a 'cancelled' run.
    assert (
        rerun_eligibility(
            error_code="cancelled",
            run_status="error",
            profile_active=True,
            has_write_tool_attempt=False,
        )
        is False
    )


def test_rerun_eligibility_rejects_unrecognized_error_code() -> None:
    with pytest.raises(AssertionError, match="unrecognized error_code"):
        rerun_eligibility(
            error_code="not_a_real_code",
            run_status="error",
            profile_active=True,
            has_write_tool_attempt=False,
        )


# =============================================================================
# Exhaustive agreement: projection.can_rerun == rerun_eligibility(...) for
# every (error_code, profile_active, has_write_tool_attempt) combination, at
# each code's natural run_status.
# =============================================================================


@pytest.mark.parametrize("code,origin,_variant_cls,carries_attempts,_conditional", _CODE_TABLE)
@pytest.mark.parametrize("profile_active", [True, False])
@pytest.mark.parametrize("has_write_tool_attempt", [True, False])
def test_projection_and_rerun_eligibility_agree_for_every_code(
    code: str,
    origin: str | None,
    _variant_cls: type,
    carries_attempts: bool,
    _conditional: bool,
    profile_active: bool,
    has_write_tool_attempt: bool,
) -> None:
    status = _status_for(code)
    run = _make_run(
        status=status,
        error_code=None if code == "cancelled" else code,
        error_origin=origin,
        profile_id=_ACTIVE_PROFILE_ID if profile_active else _INACTIVE_PROFILE_ID,
    )
    attempts = 2 if carries_attempts else None

    projected = chat_failure_projection(
        run, has_write_tool_attempt=has_write_tool_attempt, attempts=attempts
    )
    assert projected is not None

    direct = rerun_eligibility(
        error_code=code,
        run_status=status,
        profile_active=profile_active,
        has_write_tool_attempt=has_write_tool_attempt,
    )

    assert projected.can_rerun == direct


def test_exhaustive_agreement_covers_every_closed_code() -> None:
    assert set(_ALL_CODES) == {
        "refused",
        "incomplete",
        "cancelled",
        "context_too_large",
        "invalid_tool_arguments",
        "budget_exceeded",
        "rate_limited",
        "timeout",
        "provider_unavailable",
        "stream_interrupted",
    }
