"""Sole durable writer for one logical generation's ``llm_calls`` row.

Each helper owns an immediately committed session. ``start_call`` persists the
requested product facts before dispatch. ``terminalize`` consumes only the
provider runtime's terminal outcome and records normalized terminal telemetry,
usage, attempts, and derived cost provenance. ``terminalize_defect`` closes a
row when trusted post-start execution reaches an impossible state.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from provider_runtime import Absent, Present, TokenUsage
from provider_runtime import CallOutcome as ProviderCallOutcome
from provider_runtime.types import Billability, FailureOrigin, Presence, ReasoningLevel
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import LLMCall
from nexus.logging import get_logger
from nexus.services.llm_outcomes import (
    attempt_trace_facts,
    outcome_failure_facts,
    terminal_cost_facts,
)
from nexus.services.llm_profiles import LlmOperation, LlmProfile
from nexus.services.redact import safe_kv

logger = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class LlmCallOwner:
    """The durable owner and billing account for one logical generation."""

    kind: Literal[
        "chat_run",
        "oracle_reading",
        "artifact_build",
        "artifact_learn_request",
        "media_summary",
        "synapse_scan",
        "dawn_write",
    ]
    id: UUID
    user_id: UUID


@dataclass(frozen=True, slots=True)
class TerminalFacts:
    """Settlement and support facts returned to the durable execution owner."""

    outcome_tag: Literal["succeeded", "refused", "incomplete", "cancelled", "failed"]
    billability: Billability
    usage: Presence[TokenUsage]
    support_id: Presence[str]


class ExistingTerminalCall(RuntimeError):
    """A replay found the terminal row for its stable logical generation."""

    def __init__(
        self,
        *,
        generation_id: UUID,
        outcome: str,
        origin: str | None,
        code: str | None,
        detail: str | None,
    ) -> None:
        super().__init__(f"generation_id={generation_id} already terminated as {outcome}")
        self.generation_id = generation_id
        self.outcome = outcome
        self.origin = origin
        self.code = code
        self.detail = detail


class AdmissionDenied(RuntimeError):
    """A pre-dispatch budget admission failed without provider I/O."""

    def __init__(
        self,
        *,
        origin: FailureOrigin,
        code: str,
        detail: str,
        cause: BaseException,
    ) -> None:
        super().__init__(detail)
        self.origin = origin
        self.code = code
        self.detail = detail
        self.cause = cause


def start_call(
    session_factory: sessionmaker[Session],
    *,
    generation_id: UUID,
    owner: LlmCallOwner,
    operation: LlmOperation,
    profile: LlmProfile,
    requested_reasoning: ReasoningLevel,
    streaming: bool,
    admit: Callable[[Session], None],
) -> UUID:
    """Atomically admit one replay-stable ledger row and budget reservation."""
    with session_factory() as db:
        _lock_owner(db, owner_kind=owner.kind, owner_id=owner.id)
        existing = db.get(LLMCall, generation_id)
        if existing is not None:
            _assert_start_identity(
                existing,
                owner=owner,
                operation=operation,
                profile=profile,
                requested_reasoning=requested_reasoning,
                streaming=streaming,
            )
            if existing.outcome is not None:
                raise ExistingTerminalCall(
                    generation_id=generation_id,
                    outcome=existing.outcome,
                    origin=existing.error_origin,
                    code=existing.error_code,
                    detail=existing.error_detail,
                )
            _admit_or_terminalize(db, existing, admit=admit)
            db.commit()
            return generation_id
        call_seq = _next_call_seq(db, owner)
        call = LLMCall(
            id=generation_id,
            owner_kind=owner.kind,
            owner_id=owner.id,
            call_seq=call_seq,
            provider=profile.target.provider,
            model_name=profile.target.model,
            llm_operation=operation,
            streaming=streaming,
            requested_reasoning=requested_reasoning,
            cost_status="missing_usage",
        )
        db.add(call)
        _admit_or_terminalize(db, call, admit=admit)
        db.commit()
    return generation_id


def _admit_or_terminalize(
    db: Session,
    call: LLMCall,
    *,
    admit: Callable[[Session], None],
) -> None:
    try:
        admit(db)
    except AdmissionDenied as exc:
        call.outcome = "failed"
        call.error_origin = exc.origin
        call.error_code = exc.code
        call.error_detail = exc.detail[:1000]
        call.attempt_count = 1
        call.retry_count = 0
        call.terminal_attempt_status = "terminal_error"
        call.total_cost_usd_micros = None
        call.cost_status = "missing_usage"
        call.cost_source = None
        call.cost_as_of = None
        db.commit()
        _log_terminal(
            generation_id=call.id,
            owner_kind=call.owner_kind,
            owner_id=call.owner_id,
            llm_operation=call.llm_operation,
            outcome_tag="failed",
            origin=exc.origin,
            code=exc.code,
            support_id=_support_id(call.id),
        )
        raise


def _assert_start_identity(
    call: LLMCall,
    *,
    owner: LlmCallOwner,
    operation: LlmOperation,
    profile: LlmProfile,
    requested_reasoning: ReasoningLevel,
    streaming: bool,
) -> None:
    expected = (
        owner.kind,
        owner.id,
        operation,
        profile.target.provider,
        profile.target.model,
        requested_reasoning,
        streaming,
    )
    actual = (
        call.owner_kind,
        call.owner_id,
        call.llm_operation,
        call.provider,
        call.model_name,
        call.requested_reasoning,
        call.streaming,
    )
    if actual != expected:
        raise AssertionError(
            f"generation_id={call.id} was reused with different immutable request facts"
        )


def terminalize(
    session_factory: sessionmaker[Session],
    *,
    generation_id: UUID,
    outcome: ProviderCallOutcome,
    latency_ms: int | None,
    settle: Callable[[Session, TerminalFacts], None],
) -> TerminalFacts:
    """Record one runtime terminal and return the settlement facts."""
    meta = outcome.meta
    outcome_facts = outcome_failure_facts(outcome)
    attempt_facts = attempt_trace_facts(
        meta.attempt_trace,
        outcome_tag=outcome_facts.outcome_tag,
    )
    cost_facts = terminal_cost_facts(meta)
    if not meta.registry_revision:
        raise AssertionError("terminal provider CallMeta has an empty registry revision")
    support_id = (
        _support_id(generation_id)
        if outcome_facts.outcome_tag in ("refused", "incomplete", "failed")
        else None
    )
    terminal_facts = TerminalFacts(
        outcome_tag=outcome_facts.outcome_tag,
        billability=meta.billability,
        usage=meta.usage,
        support_id=Present(support_id) if support_id is not None else Absent(),
    )

    with session_factory() as db:
        call = db.get(LLMCall, generation_id)
        if call is None:
            raise AssertionError(f"llm_calls row missing for generation_id={generation_id}")
        _lock_owner(db, owner_kind=call.owner_kind, owner_id=call.owner_id)
        db.refresh(call)
        if call.outcome is not None:
            raise AssertionError(
                f"generation_id={generation_id} already has terminal outcome={call.outcome}"
            )
        if (call.provider, call.model_name) != (meta.provider, meta.model):
            raise AssertionError(
                "provider runtime terminal target differs from requested ledger target: "
                f"requested={call.provider}/{call.model_name}, "
                f"terminal={meta.provider}/{meta.model}"
            )
        owner_kind, owner_id, llm_operation = call.owner_kind, call.owner_id, call.llm_operation

        call.outcome = outcome_facts.outcome_tag
        call.error_origin = outcome_facts.error_origin
        call.error_code = outcome_facts.error_code
        call.error_detail = outcome_facts.error_detail
        call.provider_request_id = _presence_value(meta.provider_request_id)
        call.upstream_provider = _presence_value(meta.upstream_provider)
        call.native_reasoning = _presence_value(meta.native_reasoning)
        call.registry_revision = meta.registry_revision
        call.latency_ms = latency_ms
        call.attempt_count = attempt_facts.attempt_count
        call.retry_count = attempt_facts.retry_count
        call.terminal_attempt_status = attempt_facts.terminal_attempt_status
        call.provider_attempts = attempt_facts.provider_attempts

        if isinstance(meta.usage, Present):
            usage = meta.usage.value
            call.input_tokens = usage.input_tokens
            call.output_tokens = usage.output_tokens
            call.total_tokens = usage.total_tokens
            call.reasoning_tokens = _presence_value(usage.reasoning_tokens)
            call.cache_write_input_tokens = _presence_value(usage.cache_write_input_tokens)
            call.cache_read_input_tokens = _presence_value(usage.cache_read_input_tokens)
        else:
            call.input_tokens = None
            call.output_tokens = None
            call.total_tokens = None
            call.reasoning_tokens = None
            call.cache_write_input_tokens = None
            call.cache_read_input_tokens = None

        call.total_cost_usd_micros = cost_facts.total_cost_usd_micros
        call.cost_status = cost_facts.cost_status
        call.cost_source = cost_facts.cost_source
        call.cost_as_of = cost_facts.cost_as_of
        settle(db, terminal_facts)
        db.commit()

    _log_terminal(
        generation_id=generation_id,
        owner_kind=owner_kind,
        owner_id=owner_id,
        llm_operation=llm_operation,
        outcome_tag=outcome_facts.outcome_tag,
        origin=outcome_facts.error_origin,
        code=outcome_facts.error_code,
        support_id=support_id,
    )
    return terminal_facts


def terminalize_defect(
    session_factory: sessionmaker[Session],
    *,
    generation_id: UUID,
    origin: FailureOrigin,
    code: str,
    detail: str,
    settle: Callable[[Session], None],
) -> str:
    """Close a started row after an impossible post-start execution state."""
    support_id = _support_id(generation_id)
    with session_factory() as db:
        call = db.get(LLMCall, generation_id)
        if call is None:
            raise AssertionError(f"llm_calls row missing for generation_id={generation_id}")
        _lock_owner(db, owner_kind=call.owner_kind, owner_id=call.owner_id)
        db.refresh(call)
        if call.outcome is not None:
            raise AssertionError(
                f"generation_id={generation_id} already has terminal outcome={call.outcome}"
            )
        owner_kind, owner_id, llm_operation = call.owner_kind, call.owner_id, call.llm_operation

        call.outcome = "failed"
        call.error_origin = origin
        call.error_code = code
        call.error_detail = detail[:1000]
        call.attempt_count = 1
        call.retry_count = 0
        call.terminal_attempt_status = "terminal_error"
        call.total_cost_usd_micros = None
        call.cost_status = "missing_usage"
        call.cost_source = None
        call.cost_as_of = None
        settle(db)
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


def _lock_owner(db: Session, *, owner_kind: str, owner_id: UUID) -> None:
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:owner_key, 0))"),
        {"owner_key": f"{owner_kind}:{owner_id}"},
    )
