"""Exhaustive provider-runtime outcome normalization for the LLM ledger."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Literal, assert_never

from provider_runtime import (
    Absent,
    CallMeta,
    CallOutcome,
    Cancelled,
    Failed,
    Incomplete,
    Present,
    Refused,
    Succeeded,
    estimate_cost,
)
from provider_runtime.types import (
    AttemptRecord,
    ExpectedModelFailure,
    FinalAttempt,
    InvalidStructuredOutput,
    InvalidToolArguments,
    ProviderContextTooLarge,
    ProviderHttpUnavailable,
    ProviderRateLimit,
    ProviderStreamInterrupted,
    ProviderTimeout,
    TransientCause,
    TransientExhausted,
    TransportUnavailable,
)

type OutcomeTag = Literal["succeeded", "refused", "incomplete", "cancelled", "failed"]
type ErrorOrigin = Literal[
    "transport",
    "provider_http",
    "provider_stream",
    "provider_response",
    "tool_arguments",
]
type ErrorCode = Literal[
    "refused",
    "incomplete",
    "context_too_large",
    "invalid_tool_arguments",
    "invalid_structured_output",
    "rate_limited",
    "timeout",
    "provider_unavailable",
    "stream_interrupted",
]
type CostStatus = Literal["estimated", "missing_usage", "missing_pricing"]
type TerminalAttemptStatus = Literal["success", "terminal_error", "abandoned"]


@dataclass(frozen=True, slots=True)
class OutcomeFailureFacts:
    outcome_tag: OutcomeTag
    error_origin: ErrorOrigin | None
    error_code: ErrorCode | None
    error_detail: str | None


@dataclass(frozen=True, slots=True)
class TerminalCostFacts:
    total_cost_usd_micros: int | None
    cost_status: CostStatus
    cost_source: str | None
    cost_as_of: date | None

    def __post_init__(self) -> None:
        if self.cost_status == "estimated":
            if (
                self.total_cost_usd_micros is None
                or self.cost_source is None
                or not self.cost_source
                or self.cost_as_of is None
            ):
                raise AssertionError("estimated LLM cost is missing amount or provenance")
            return
        if (
            self.total_cost_usd_micros is not None
            or self.cost_source is not None
            or self.cost_as_of is not None
        ):
            raise AssertionError(f"{self.cost_status} LLM cost cannot carry estimated facts")


@dataclass(frozen=True, slots=True)
class AttemptTraceFacts:
    attempt_count: int
    retry_count: int
    terminal_attempt_status: TerminalAttemptStatus
    provider_attempts: list[dict[str, object]]


@dataclass(frozen=True, slots=True)
class _FailureFacts:
    error_origin: ErrorOrigin
    error_code: ErrorCode
    error_detail: str | None = None


def outcome_failure_facts(outcome: CallOutcome) -> OutcomeFailureFacts:
    """Map every closed provider terminal to Nexus's one ledger vocabulary."""
    match outcome:
        case Succeeded():
            return OutcomeFailureFacts("succeeded", None, None, None)
        case Refused(safe_detail=detail):
            return OutcomeFailureFacts("refused", "provider_http", "refused", detail)
        case Incomplete(status="refused", safe_detail=safe_detail):
            return OutcomeFailureFacts(
                "refused",
                "provider_stream",
                "refused",
                _presence_value(safe_detail),
            )
        case Incomplete(safe_detail=safe_detail):
            return OutcomeFailureFacts(
                "incomplete",
                "provider_response",
                "incomplete",
                _presence_value(safe_detail),
            )
        case Cancelled():
            return OutcomeFailureFacts("cancelled", None, None, None)
        case Failed(failure=failure):
            facts = _expected_failure_facts(failure)
            return OutcomeFailureFacts(
                "failed",
                facts.error_origin,
                facts.error_code,
                facts.error_detail,
            )
        case _:
            assert_never(outcome)


def terminal_cost_facts(meta: CallMeta) -> TerminalCostFacts:
    """Derive the terminal cost tri-state without inventing usage or pricing."""
    cost = estimate_cost(meta)
    match meta.usage:
        case Absent():
            if isinstance(cost, Present):
                raise AssertionError("provider runtime priced a call with absent usage")
            return TerminalCostFacts(None, "missing_usage", None, None)
        case Present():
            pass
        case _:
            assert_never(meta.usage)

    match cost:
        case Absent():
            return TerminalCostFacts(None, "missing_pricing", None, None)
        case Present(value=estimate):
            return TerminalCostFacts(
                estimate.amount_usd_micros,
                "estimated",
                estimate.source,
                estimate.as_of,
            )
        case _:
            assert_never(cost)


def attempt_trace_facts(
    trace: tuple[AttemptRecord, ...],
    *,
    outcome_tag: OutcomeTag,
) -> AttemptTraceFacts:
    """Validate and serialize the runtime-owned attempt trace once."""
    if not trace:
        raise AssertionError("terminal provider CallMeta has an empty attempt trace")
    for expected_attempt, record in enumerate(trace, start=1):
        if record.attempt != expected_attempt:
            raise AssertionError(
                "terminal provider attempt trace is not contiguous: "
                f"expected {expected_attempt}, got {record.attempt}"
            )
        is_last = expected_attempt == len(trace)
        if is_last != isinstance(record.signal, FinalAttempt):
            raise AssertionError("only the final provider attempt may carry FinalAttempt")

    match outcome_tag:
        case "succeeded":
            terminal_status: TerminalAttemptStatus = "success"
        case "cancelled":
            terminal_status = "abandoned"
        case "refused" | "incomplete" | "failed":
            terminal_status = "terminal_error"
        case _:
            assert_never(outcome_tag)
    return AttemptTraceFacts(
        attempt_count=len(trace),
        retry_count=len(trace) - 1,
        terminal_attempt_status=terminal_status,
        provider_attempts=[_attempt_json(record) for record in trace],
    )


def _expected_failure_facts(failure: ExpectedModelFailure) -> _FailureFacts:
    match failure:
        case ProviderContextTooLarge():
            return _FailureFacts("provider_http", "context_too_large")
        case InvalidToolArguments(safe_detail=detail):
            return _FailureFacts("tool_arguments", "invalid_tool_arguments", detail)
        case InvalidStructuredOutput(safe_detail=detail):
            return _FailureFacts("provider_response", "invalid_structured_output", detail)
        case TransientExhausted(cause=cause):
            return _transient_cause_facts(cause)
        case _:
            assert_never(failure)


def _transient_cause_facts(cause: TransientCause) -> _FailureFacts:
    match cause:
        case ProviderRateLimit():
            return _FailureFacts("provider_http", "rate_limited")
        case ProviderTimeout():
            return _FailureFacts("transport", "timeout")
        case ProviderHttpUnavailable():
            return _FailureFacts("provider_http", "provider_unavailable")
        case TransportUnavailable():
            return _FailureFacts("transport", "provider_unavailable")
        case ProviderStreamInterrupted():
            return _FailureFacts("provider_stream", "stream_interrupted")
        case _:
            assert_never(cause)


def _attempt_json(record: AttemptRecord) -> dict[str, object]:
    entry: dict[str, object] = {
        "attempt": record.attempt,
        "started_at_ms": record.started_at_ms,
        "ended_at_ms": record.ended_at_ms,
    }
    status_code = _presence_value(record.status_code)
    if status_code is not None:
        entry["status_code"] = status_code
    match record.signal:
        case FinalAttempt():
            entry["signal"] = "final"
        case ProviderRateLimit(retry_after=retry_after):
            facts = _transient_cause_facts(record.signal)
            entry["origin"] = facts.error_origin
            entry["code"] = facts.error_code
            retry_after_value = _presence_value(retry_after)
            if retry_after_value is not None:
                entry["retry_after"] = retry_after_value
        case (
            ProviderTimeout()
            | ProviderHttpUnavailable()
            | TransportUnavailable()
            | ProviderStreamInterrupted()
        ):
            facts = _transient_cause_facts(record.signal)
            entry["origin"] = facts.error_origin
            entry["code"] = facts.error_code
        case _:
            assert_never(record.signal)
    return entry


def _presence_value[T](value: Present[T] | Absent) -> T | None:
    match value:
        case Present(value=present):
            return present
        case Absent():
            return None
        case _:
            assert_never(value)
