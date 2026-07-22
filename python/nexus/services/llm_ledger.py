"""The LLM-call ledger: sole writer of ``llm_calls``.

Three helpers, each opening its own dedicated, immediately-committed session
from a caller-supplied ``session_factory`` (never a shared long-lived
transaction spanning a provider dispatch):

- :func:`start_call` allocates a generation id, allocates ``call_seq`` for the
  owner, and INSERTs the durable start row — before any provider dispatch, so
  a crash mid-call still leaves a row for recovery.
- :func:`commit_plan_facts` UPDATEs the row with the finalized plan's facts
  once a token-budget reservation succeeds.
- :func:`terminalize` / :func:`terminalize_defect` UPDATE the row with the
  terminal outcome (from a real provider dispatch, or a pre-dispatch defect,
  respectively) and log the one structured terminal event.

:class:`LlmCallOwner` is the run parent a call is attributed to; ``user_id``
is the billing-scoped account :mod:`nexus.services.llm_execution` checks
entitlements/reserves budget against (distinct from ``id``, the owning run's
own id — a chat run's ``owner_user_id``, an oracle reading's viewer id, etc.).

``nexus.services.llm_execution`` is the sole caller of this module; it owns
the 8-step order these helpers implement pieces of. See
``docs/cutovers/llm-provider-runtime-hard-cutover.md`` §9/§11.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from uuid import UUID, uuid4

from provider_runtime import (
    Absent,
    Accounting,
    AttemptRecord,
    Billability,
    Cancelled,
    CostBreakdown,
    Failed,
    FailureOrigin,
    FinalAttempt,
    FinalizedProviderCall,
    Incomplete,
    InvalidToolArguments,
    Presence,
    Present,
    ProviderRateLimit,
    Refused,
    Succeeded,
    TokenUsage,
    TransientExhausted,
    cost_from_accounting,
    failure_code,
    failure_origin,
)
from provider_runtime import (
    CallOutcome as ProviderCallOutcome,
)
from provider_runtime import (
    cache_strategy as plan_cache_strategy,
)
from provider_runtime import (
    cache_ttl as plan_cache_ttl,
)
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import LLMCall
from nexus.logging import get_logger
from nexus.services.llm_profiles import LlmOperation, LlmProfile
from nexus.services.redact import safe_kv

logger = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class LlmCallOwner:
    """The run parent a provider call is attributed to in the ledger.

    ``id`` names the owning row (chat run, oracle reading, ...); ``user_id``
    is the billing-scoped account the entitlement check and token-budget
    reservation in ``llm_execution`` run against.
    """

    kind: Literal[
        "chat_run",
        "oracle_reading",
        "artifact_revision",
        "media_summary",
        "media_enrichment",
        "synapse_scan",
        "dawn_write",
    ]
    id: UUID
    user_id: UUID


@dataclass(frozen=True, slots=True)
class TerminalFacts:
    """What :func:`execute_generation`/:func:`execute_generation_stream` need
    from a terminalized row to settle the reservation and build their return
    value: the outcome's billability + usage (settlement, §9 step 7) and the
    support id (Present only for refused/incomplete/failed terminals)."""

    outcome_tag: Literal["succeeded", "refused", "incomplete", "cancelled", "failed"]
    billability: Billability
    usage: Presence[TokenUsage]
    support_id: Presence[str]


def start_call(
    session_factory: sessionmaker[Session],
    *,
    owner: LlmCallOwner,
    operation: LlmOperation,
    profile: LlmProfile,
    streaming: bool,
) -> UUID:
    """Allocate a generation id + ``call_seq`` and INSERT the durable start
    row, committed before any provider dispatch (§9 step 2)."""
    generation_id = uuid4()
    with session_factory() as db:
        call_seq = _next_call_seq(db, owner)
        db.add(
            LLMCall(
                id=generation_id,
                owner_kind=owner.kind,
                owner_id=owner.id,
                call_seq=call_seq,
                provider=profile.target.provider,
                model_name=profile.target.model,
                llm_operation=operation,
                streaming=streaming,
                reasoning_effort=profile.default_reasoning_option_id,
                cost_status="missing_usage",
            )
        )
        db.commit()
    return generation_id


def commit_plan_facts(
    session_factory: sessionmaker[Session],
    *,
    generation_id: UUID,
    profile: LlmProfile,
    plan: FinalizedProviderCall,
) -> None:
    """UPDATE the row with the finalized plan's facts, committed once the
    token-budget reservation for this generation has already succeeded (§9
    step 4 — reserve precedes this commit)."""
    with session_factory() as db:
        call = db.get(LLMCall, generation_id)
        if call is None:
            raise AssertionError(f"llm_calls row missing for generation_id={generation_id}")
        call.provider = profile.target.provider
        call.model_name = profile.target.model
        call.reasoning_effort = plan.native_reasoning
        call.catalog_revision = plan.catalog_revision
        call.request_fingerprint = plan.request_fingerprint
        call.cache_strategy = plan_cache_strategy(plan.cache_plan)
        call.cache_ttl = plan_cache_ttl(plan.cache_plan)
        call.pricing_snapshot = _accounting_snapshot(plan.accounting)
        db.commit()


def terminalize(
    session_factory: sessionmaker[Session],
    *,
    generation_id: UUID,
    outcome: ProviderCallOutcome,
    accounting: Presence[Accounting],
    latency_ms: int | None,
) -> TerminalFacts:
    """UPDATE the row with a real dispatch outcome's terminal facts, commit,
    and log the one structured terminal event (§9 steps 6+8)."""
    meta = outcome.meta
    outcome_tag, origin, code, detail = _outcome_tag_facts(outcome)
    support_id = (
        _support_id(generation_id) if outcome_tag in ("refused", "incomplete", "failed") else None
    )
    cost: CostBreakdown | None = None
    if isinstance(meta.usage, Present) and isinstance(accounting, Present):
        cost = cost_from_accounting(accounting.value, meta.usage.value)
    attempt_fields = _attempt_fields(meta.attempt_trace, outcome_tag=outcome_tag)

    with session_factory() as db:
        call = db.get(LLMCall, generation_id)
        if call is None:
            raise AssertionError(f"llm_calls row missing for generation_id={generation_id}")
        owner_kind, owner_id, llm_operation = call.owner_kind, call.owner_id, call.llm_operation

        call.outcome = outcome_tag
        call.error_origin = origin
        call.error_code = code
        call.error_detail = detail
        call.provider_request_id = _presence_value(meta.provider_request_id)
        call.upstream_provider = _presence_value(meta.upstream_provider)
        call.latency_ms = latency_ms
        call.attempt_count = attempt_fields.attempt_count
        call.retry_count = attempt_fields.retry_count
        call.terminal_attempt_status = attempt_fields.terminal_attempt_status
        call.provider_attempts = attempt_fields.provider_attempts

        if isinstance(meta.usage, Present):
            usage = meta.usage.value
            call.input_tokens = usage.input_tokens
            call.output_tokens = usage.output_tokens
            call.total_tokens = usage.total_tokens
            call.reasoning_tokens = _presence_value(usage.reasoning_tokens) or 0
            call.cache_write_input_tokens = _presence_value(usage.cache_write_input_tokens) or 0
            call.cache_read_input_tokens = _presence_value(usage.cache_read_input_tokens) or 0
            if cost is not None:
                call.input_cost_usd_micros = cost.input_cost_usd_micros
                call.output_cost_usd_micros = cost.output_cost_usd_micros
                call.cache_write_cost_usd_micros = cost.cache_write_cost_usd_micros
                call.cache_read_cost_usd_micros = cost.cache_read_cost_usd_micros
                call.reasoning_cost_usd_micros = cost.reasoning_cost_usd_micros
                call.total_cost_usd_micros = cost.total_cost_usd_micros
                call.cost_status = "estimated"
            else:
                # usage reported but no plan/accounting to price it against
                # (should not occur on the dispatch path; defensive only).
                call.cost_status = "missing_pricing"
        else:
            call.cost_status = "missing_usage"

        db.commit()

    _log_terminal(
        generation_id=generation_id,
        owner_kind=owner_kind,
        owner_id=owner_id,
        llm_operation=llm_operation,
        outcome_tag=outcome_tag,
        origin=origin,
        code=code,
        support_id=support_id,
    )
    return TerminalFacts(
        outcome_tag=outcome_tag,
        billability=meta.billability,
        usage=meta.usage,
        support_id=Present(support_id) if support_id is not None else Absent(),
    )


def terminalize_defect(
    session_factory: sessionmaker[Session],
    *,
    generation_id: UUID,
    origin: FailureOrigin,
    code: str,
    detail: str,
) -> str:
    """UPDATE the row for a pre-dispatch or dispatch-boundary defect terminal
    (entitlement/budget denial has no row at all — this is never called for
    that case). Always yields a support id (defect terminals always fail)."""
    support_id = _support_id(generation_id)
    with session_factory() as db:
        call = db.get(LLMCall, generation_id)
        if call is None:
            raise AssertionError(f"llm_calls row missing for generation_id={generation_id}")
        owner_kind, owner_id, llm_operation = call.owner_kind, call.owner_id, call.llm_operation

        call.outcome = "failed"
        call.error_origin = origin
        call.error_code = code
        call.error_detail = detail[:1000]
        call.attempt_count = 1
        call.retry_count = 0
        call.terminal_attempt_status = "terminal_error"
        call.cost_status = "missing_usage"
        db.commit()

    _log_terminal(
        generation_id=generation_id,
        owner_kind=owner_kind,
        owner_id=owner_id,
        llm_operation=llm_operation,
        outcome_tag="failed",
        origin=origin,
        code=code,
        support_id=support_id,
    )
    return support_id


def _log_terminal(
    *,
    generation_id: UUID,
    owner_kind: str,
    owner_id: UUID,
    llm_operation: str,
    outcome_tag: str,
    origin: str | None,
    code: str | None,
    support_id: str | None,
) -> None:
    fields = safe_kv(
        generation_id=str(generation_id),
        owner_kind=owner_kind,
        owner_id=str(owner_id),
        llm_operation=llm_operation,
        outcome=outcome_tag,
        origin=origin,
        code=code,
        support_id=support_id,
    )
    if outcome_tag == "succeeded":
        logger.info("llm_call.terminalized", **fields)
    else:
        logger.error("llm_call.terminalized", **fields)


def _support_id(generation_id: UUID) -> str:
    return generation_id.hex[:12]


def _presence_value[T](presence: Presence[T]) -> T | None:
    return presence.value if isinstance(presence, Present) else None


def _outcome_tag_facts(
    outcome: ProviderCallOutcome,
) -> tuple[
    Literal["succeeded", "refused", "incomplete", "cancelled", "failed"],
    str | None,
    str | None,
    str | None,
]:
    if isinstance(outcome, Succeeded):
        return "succeeded", None, None, None
    if isinstance(outcome, Refused):
        return "refused", "provider_http", "refused", outcome.safe_detail
    if isinstance(outcome, Incomplete):
        detail = _presence_value(outcome.safe_detail)
        if outcome.status == "refused":
            return "refused", "provider_stream", "refused", detail
        return "incomplete", "provider_response", "incomplete", detail
    if isinstance(outcome, Cancelled):
        return "cancelled", None, None, None
    if isinstance(outcome, Failed):
        return (
            "failed",
            failure_origin(outcome.failure),
            failure_code(outcome.failure),
            _failure_detail(outcome.failure),
        )
    raise AssertionError(f"unhandled provider_runtime.CallOutcome variant: {outcome!r}")


def _failure_detail(failure: object) -> str | None:
    if isinstance(failure, InvalidToolArguments):
        return failure.safe_detail
    return None


@dataclass(frozen=True, slots=True)
class _AttemptFields:
    attempt_count: int
    retry_count: int
    terminal_attempt_status: str
    provider_attempts: list[dict[str, object]] | None


def _attempt_fields(
    trace: tuple[AttemptRecord, ...],
    *,
    outcome_tag: str,
) -> _AttemptFields:
    terminal_attempt_status = {"succeeded": "success", "cancelled": "abandoned"}.get(
        outcome_tag, "terminal_error"
    )
    if not trace:
        return _AttemptFields(
            attempt_count=1,
            retry_count=0,
            terminal_attempt_status=terminal_attempt_status,
            provider_attempts=None,
        )
    return _AttemptFields(
        attempt_count=len(trace),
        retry_count=max(0, len(trace) - 1),
        terminal_attempt_status=terminal_attempt_status,
        provider_attempts=[_attempt_json(record) for record in trace],
    )


def _attempt_json(record: AttemptRecord) -> dict[str, object]:
    entry: dict[str, object] = {
        "attempt": record.attempt,
        "started_at_ms": record.started_at_ms,
        "ended_at_ms": record.ended_at_ms,
    }
    status_code = _presence_value(record.status_code)
    if status_code is not None:
        entry["status_code"] = status_code
    if isinstance(record.signal, FinalAttempt):
        entry["signal"] = "final"
        return entry
    cause = record.signal
    transient = TransientExhausted(attempts=record.attempt, cause=cause)
    entry["origin"] = failure_origin(transient)
    entry["code"] = failure_code(transient)
    if isinstance(cause, ProviderRateLimit):
        retry_after = _presence_value(cause.retry_after)
        if retry_after is not None:
            entry["retry_after"] = retry_after
    return entry


def _accounting_snapshot(accounting: Accounting) -> dict[str, object]:
    return {
        "currency": accounting.currency,
        "input_rate": accounting.input_rate,
        "output_rate": accounting.output_rate,
        "cache_write_rate": accounting.cache_write_rate,
        "cache_read_rate": accounting.cache_read_rate,
        "reasoning_billed_outside_output": accounting.reasoning_billed_outside_output,
        "platform_token_reservation": accounting.platform_token_reservation,
        "maximum_cost_estimate_usd_micros": accounting.maximum_cost_estimate_usd_micros,
    }


def _next_call_seq(db: Session, owner: LlmCallOwner) -> int:
    return int(
        db.execute(
            text(
                "SELECT COALESCE(MAX(call_seq), 0) + 1 FROM llm_calls "
                "WHERE owner_kind = :kind AND owner_id = :id"
            ),
            {"kind": owner.kind, "id": owner.id},
        ).scalar_one()
    )
