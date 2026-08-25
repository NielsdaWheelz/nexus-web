"""Durable Nexus adapter for the portable ``llm_tools`` execution kernel.

The portable executor owns validation, envelopes, and dispatch ordering.  This
module supplies the Nexus durability boundary: one lease-fenced position
recorder over the queue payload, one run-budget view over that same journal,
and the Chat audit projection committed with a terminal result.  Domain tool
handlers are composed below this boundary; no ambient principal or session is
used.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from types import MappingProxyType
from typing import TYPE_CHECKING, Any, Never, cast
from uuid import UUID

from llm_tools import (
    BoundaryFailure,
    BudgetState,
    DeclaredToolFailure,
    EffectId,
    ExecutionContext,
    ExecutorConfigurationDefect,
    HandlerSuccess,
    InvocationPosition,
    NoDeclaredError,
    PlanCatalogView,
    PositionState,
    Principal,
    PromptAttribute,
    PromptAttributeName,
    PromptJson,
    PromptSection,
    PromptSectionKind,
    PromptSections,
    Reservation,
    RunLimits,
    Scope,
    Settlement,
    ToolEffect,
    ToolId,
    ToolResult,
    canonical_json_bytes,
    render_prompt,
)
from llm_tools import (
    ReplayPolicy as PortableReplayPolicy,
)
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun
from nexus.errors import ApiError, ApiErrorCode
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    get_job,
    lock_running_job_claim,
)
from nexus.schemas.conversation import ChatRunToolResultEventPayload
from nexus.schemas.presence import Present, absent
from nexus.schemas.retrieval import RetrievalResultRef
from nexus.services.chat_run_citations import (
    CitationCandidateNumbering,
    number_tool_citation_candidates,
)
from nexus.services.chat_run_event_store import ChatRunEventEmitter, lock_chat_run_for_update
from nexus.services.chat_run_tools import (
    RecordKind,
    ToolModelOutput,
    ToolStepResult,
    bind_provider_tool_call_events,
    current_tool_record_identity,
    persist_current_tool_record,
    persist_tool_call_start,
)
from nexus.services.durable_step_journal import (
    Completed,
    Prepared,
    StepReplayState,
    ToolDispatchClaim,
    ToolExecutionIdentity,
    ToolExecutionReservation,
    ToolExecutionSettlement,
    ToolExecutionState,
    Uncertain,
    checkpoint_step_state,
    read_step_states,
    stable_generation_id,
)
from nexus.services.durable_step_journal import (
    ReplayPolicy as JournalReplayPolicy,
)
from nexus.services.retrieval_citation import RetrievalCitation, insert_retrieval_row
from nexus.services.tool_runtime import declarations as tool_declarations
from nexus.services.tool_runtime.declarations import CHAT_TOOL_DECLARATIONS

if TYPE_CHECKING:
    from nexus.services.tool_runtime.composition import FrozenToolOperation


# Pydantic's generic-model specialization cache is context-local.  Calling
# ``Present[type(value)]`` inside an MCP request thread can therefore create a
# same-named class that is not the class captured by these models' serializers
# at import time.  Freeze every constructor used by an unvalidated model_copy
# here, in the same import context as the durable model schema.
_PRESENT_STR = Present[str]
_PRESENT_TOOL_DISPATCH_CLAIM = Present[ToolDispatchClaim]
_PRESENT_TOOL_EXECUTION = Present[ToolExecutionState]
_PRESENT_TOOL_RESERVATION = Present[ToolExecutionReservation]
_PRESENT_TOOL_SETTLEMENT = Present[ToolExecutionSettlement]


@dataclass(frozen=True, slots=True)
class _ChatExecutionOwner:
    run_id: UUID
    conversation_id: UUID
    user_message_id: UUID
    assistant_message_id: UUID
    tool_call_index: int
    admitted_resource_uris: frozenset[str]
    provider_wire_name: str
    provider_arguments: dict[str, Any] | None


@dataclass(slots=True)
class _AuditProjection:
    scope: str
    requested_types: list[str] = field(default_factory=list)
    filters: dict[str, Any] = field(default_factory=dict)
    citations: list[RetrievalCitation] = field(default_factory=list)
    selected_citations: list[RetrievalCitation] = field(default_factory=list)
    created_refs: list[dict[str, Any]] = field(default_factory=list)
    provider_request_ids: list[str] = field(default_factory=list)
    search_query_fingerprint: str | None = None
    latency_ms: int | None = None


_BOUNDARY_ERROR_TYPES = {
    "BudgetExceeded",
    "DeadlineExceeded",
    "InvalidInput",
    "ToolUnavailable",
}


def _portable_result(raw: str) -> ToolResult:
    decoded = json.loads(raw)
    if not isinstance(decoded, dict) or decoded.get("type") not in {"Success", "Failure"}:
        raise AssertionError("completed tool position has a malformed portable result")
    expected = {"type", "value"} if decoded["type"] == "Success" else {"type", "error"}
    if set(decoded) != expected or not isinstance(
        decoded["value"] if decoded["type"] == "Success" else decoded["error"],
        dict,
    ):
        raise AssertionError("completed tool position has a malformed portable envelope")
    if canonical_json_bytes(decoded).decode("utf-8") != raw:
        raise AssertionError("completed tool result is not canonical JSON")
    # The durable identity selects the binding before this decoder is called;
    # the caller passes that exact spec-owned catalogue view below.
    return cast("ToolResult", decoded)


def _position_state(state: StepReplayState, *, catalog_view: PlanCatalogView) -> PositionState:
    if not isinstance(state.tool_execution, Present):
        raise ValueError("occupied durable position is not a tool execution")
    execution = state.tool_execution.value
    attempts = execution.abandoned_attempts
    if isinstance(execution.settlement, Present):
        attempts = execution.settlement.value.actual_attempts
    terminal = (
        _validated_portable_result(
            state.terminal_result.value,
            tool_id=execution.identity.tool_id,
            catalog_view=catalog_view,
        )
        if isinstance(state.terminal_result, Present)
        else None
    )
    if terminal is not None:
        _validate_reconciled_result_policy(
            terminal,
            tool_id=execution.identity.tool_id,
            catalog_view=catalog_view,
        )
    return PositionState(
        terminal_result=terminal,
        uncertain=state.dispatch_phase is Uncertain,
        actual_attempts=attempts,
    )


def _validated_portable_result(
    raw: str,
    *,
    tool_id: str,
    catalog_view: PlanCatalogView,
) -> ToolResult:
    decoded = _portable_result(raw)
    spec = catalog_view.spec(ToolId(tool_id))
    payload = decoded["value"] if decoded["type"] == "Success" else decoded["error"]
    assert isinstance(payload, dict)
    if decoded["type"] == "Failure" and payload.get("type") in _BOUNDARY_ERROR_TYPES:
        if set(payload) != {"type"}:
            raise AssertionError("completed boundary failure is not closed")
        return decoded
    target = spec.success_type if decoded["type"] == "Success" else spec.error_type
    if target is NoDeclaredError:
        raise AssertionError("tool without declared errors persisted a declared failure")
    try:
        adapter = TypeAdapter(target)
        validated = adapter.validate_json(canonical_json_bytes(payload), strict=True)
        projected = adapter.dump_python(validated, mode="json")
    except ValidationError as exc:
        raise AssertionError("completed tool result violates its selected declaration") from exc
    if canonical_json_bytes(projected) != canonical_json_bytes(payload):
        raise AssertionError("completed tool result differs from its strict projection")
    return decoded


def _journal_policy(policy: PortableReplayPolicy) -> JournalReplayPolicy:
    return JournalReplayPolicy(policy.value)


def _validate_reconciled_result_policy(
    result: ToolResult,
    *,
    tool_id: str,
    catalog_view: PlanCatalogView,
) -> None:
    """Enforce binding-owned result bounds on every accepted terminal."""

    if result["type"] != "Success" or tool_id != "web.search":
        return
    policy = catalog_view.binding(ToolId(tool_id)).policy_inputs
    max_results = policy.get("max_results")
    value = result["value"]
    results = value.get("results")
    if (
        not isinstance(max_results, int)
        or isinstance(max_results, bool)
        or max_results < 1
        or not isinstance(results, list)
    ):
        raise AssertionError("frozen web.search binding policy is malformed")
    if len(results) > max_results:
        raise AssertionError("web.search result exceeds its binding policy")


def _assert_operation_identity(
    operation: FrozenToolOperation,
    identity: ToolExecutionIdentity,
) -> Any:
    try:
        binding = operation.plan.catalog_view.binding(ToolId(identity.tool_id))
    except (KeyError, ValueError) as exc:
        raise ValueError("stored tool identity is absent from the frozen operation") from exc
    if (
        identity.tool_contract_revision != binding.spec.tool_contract_revision
        or identity.policy_revision != binding.policy_revision
        or identity.plan_revision != operation.plan.plan_revision
        or identity.replay_policy is not _journal_policy(binding.replay_policy)
    ):
        raise ValueError("stored tool identity differs from the frozen operation")
    return binding


def reconcile_uncertain_tool_completion(
    *,
    operation: FrozenToolOperation,
    state: StepReplayState,
    raw_result: str,
    settlement: ToolExecutionSettlement,
) -> StepReplayState:
    """Validate an operator-attached BilledOnce result into Completed state.

    This is deliberately pure: Chat and Dossier own their dead-job locking,
    journal checkpoint, requeue, and commit boundaries. They share this exact
    result/identity/accounting validator instead of growing parallel decoders.
    """

    if state.dispatch_phase is not Uncertain or not isinstance(state.tool_execution, Present):
        raise ValueError("only an uncertain tool position can attach a result")
    execution = state.tool_execution.value
    identity = execution.identity
    binding = _assert_operation_identity(operation, identity)
    if binding.replay_policy is not PortableReplayPolicy.BilledOnce:
        raise ValueError("attached result differs from the stored tool authority")
    if (
        not isinstance(state.request_fingerprint, Present)
        or state.request_fingerprint.value != identity.input_digest
        or isinstance(state.terminal_result, Present)
        or not isinstance(execution.reservation, Present)
        or not execution.reservation.value.accepted
        or isinstance(execution.settlement, Present)
        or not isinstance(execution.dispatch_claim, Present)
    ):
        raise ValueError("uncertain tool position is not attachable")

    reservation = execution.reservation.value
    if (
        settlement.actual_attempts < max(1, execution.abandoned_attempts)
        or settlement.actual_attempts > reservation.max_attempts
        or settlement.actual_output_bytes != len(raw_result.encode("utf-8"))
        or settlement.actual_output_bytes > reservation.max_output_bytes
    ):
        raise ValueError("attached settlement differs from the reserved tool work")
    try:
        result = _validated_portable_result(
            raw_result,
            tool_id=identity.tool_id,
            catalog_view=operation.plan.catalog_view,
        )
    except (AssertionError, json.JSONDecodeError) as exc:
        raise ValueError("attached result is not a strict portable tool result") from exc
    try:
        _validate_reconciled_result_policy(
            result,
            tool_id=identity.tool_id,
            catalog_view=operation.plan.catalog_view,
        )
    except AssertionError as exc:
        raise ValueError("attached result violates its frozen binding policy") from exc
    completed_execution = execution.model_copy(
        update={
            "dispatch_claim": absent(),
            "settlement": _PRESENT_TOOL_SETTLEMENT(value=settlement),
        }
    )
    completed = state.model_copy(
        update={
            "dispatch_phase": Completed,
            "terminal_result": _PRESENT_STR(value=raw_result),
            "tool_execution": _PRESENT_TOOL_EXECUTION(value=completed_execution),
        }
    )
    return StepReplayState.model_validate(completed.model_dump(mode="python"))


class _DurableBudgetState:
    """Run-budget view whose facts are the recorder's persisted reservations."""

    def __init__(self, recorder: NexusPositionRecorder, limits: RunLimits) -> None:
        self._recorder = recorder
        self._limits = limits

    @property
    def limits(self) -> RunLimits:
        return self._limits

    @property
    def remaining_elapsed_seconds(self) -> float:
        job = get_job(self._recorder.db, self._recorder.job_context.job_id)
        if job is None:
            return 0.0
        started_at = job.started_at or job.created_at
        if started_at.tzinfo is None:
            started_at = started_at.replace(tzinfo=UTC)
        elapsed = (datetime.now(UTC) - started_at.astimezone(UTC)).total_seconds()
        return max(0.0, float(self._limits.max_elapsed_seconds) - elapsed)

    def reserve(self, position: InvocationPosition, reservation: Reservation) -> bool:
        return self._recorder._budget_accepts(position, reservation)

    def settle(self, position: InvocationPosition, settlement: Settlement) -> None:
        self._recorder._validate_settlement(position, settlement)


class NexusPositionRecorder:
    """Concrete lease-fenced position recorder over ``durable_step_journal``."""

    def __init__(
        self,
        *,
        db: Session,
        operation_id: UUID,
        claimed_job: JobRow,
        job_context: JobExecutionContext,
        position: InvocationPosition,
        limits: RunLimits,
        catalog_view: PlanCatalogView,
        chat: _ChatExecutionOwner | None,
    ) -> None:
        if claimed_job.id != job_context.job_id:
            raise ValueError("claimed job differs from its execution context")
        if claimed_job.status != "running":
            raise ValueError("durable tool execution requires a running job")
        if (
            claimed_job.claimed_by != job_context.worker_id
            or claimed_job.attempts != job_context.attempt_no
        ):
            raise ValueError("claimed job differs from its lease identity")
        self.db = db
        self.operation_id = operation_id
        self.job_context = job_context
        self.position = position
        self.catalog_view = catalog_view
        self.chat = chat
        self.audit = _AuditProjection(scope="conversation_context" if chat else "durable_operation")
        self.budgets = _DurableBudgetState(self, limits)

    @property
    def durable(self) -> bool:
        return True

    def _check_position(self, position: InvocationPosition) -> None:
        if position != self.position:
            raise ValueError("recorder received a different invocation position")

    def _lock_job(self) -> tuple[ChatRun | None, JobRow]:
        run: ChatRun | None = None
        if self.chat is not None:
            # ChatRun is the stream-sequence and cancellation serialization
            # row. Take it before the queue fence on every Chat checkpoint so
            # MCP terminal events cannot race worker-stream appends, and so
            # cancellation retains the single run -> job lock order.
            run = lock_chat_run_for_update(self.db, self.chat.run_id)
            if run is None:
                self.db.rollback()
                raise RuntimeError("durable Chat tool execution owner disappeared")
        if not lock_running_job_claim(self.db, context=self.job_context):
            self.db.rollback()
            raise RuntimeError("durable tool execution lost its queue lease")
        job = get_job(self.db, self.job_context.job_id)
        if job is None:
            self.db.rollback()
            raise RuntimeError("durable tool execution job disappeared")
        return run, job

    def _checkpoint(self, job: JobRow, state: StepReplayState) -> None:
        try:
            validated = StepReplayState.model_validate(state.model_dump(mode="python"))
            if not checkpoint_step_state(
                self.db,
                ctx=self.job_context,
                job=job,
                step_path=str(self.position),
                state=validated,
            ):
                raise RuntimeError("durable tool checkpoint lost its queue lease")
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise

    def _state(self, job: JobRow) -> StepReplayState | None:
        return read_step_states(job).get(str(self.position))

    def _tool_state(self, state: StepReplayState) -> ToolExecutionState:
        if not isinstance(state.tool_execution, Present):
            raise ValueError("durable position belongs to a non-tool step")
        return state.tool_execution.value

    def occupy(
        self,
        *,
        position: InvocationPosition,
        tool_id: ToolId,
        tool_contract_revision: str,
        policy_revision: str,
        plan_revision: str,
        input_digest: str,
        replay_policy: PortableReplayPolicy,
    ) -> PositionState:
        self._check_position(position)
        identity = ToolExecutionIdentity(
            tool_id=str(tool_id),
            tool_contract_revision=tool_contract_revision,
            policy_revision=policy_revision,
            plan_revision=plan_revision,
            input_digest=input_digest,
            replay_policy=_journal_policy(replay_policy),
        )
        if self.chat is not None:
            self.audit.scope = (
                "assistant_write"
                if _declaration(str(tool_id)).spec.effect is ToolEffect.Write
                else "conversation_context"
            )
        _run, job = self._lock_job()
        state = self._state(job)
        if state is not None:
            existing_execution = self._tool_state(state)
            if (
                state.generation_id != stable_generation_id(self.operation_id, str(position))
                or existing_execution.identity != identity
            ):
                self.db.rollback()
                raise ValueError("occupied position has a different tool identity")
            if self.chat is not None:
                self._assert_chat_row(identity)
            if (
                state.dispatch_phase is Uncertain
                and identity.replay_policy is JournalReplayPolicy.ReDispatchable
                and isinstance(existing_execution.reservation, Present)
                and existing_execution.reservation.value.max_attempts == 0
                and isinstance(existing_execution.dispatch_claim, Present)
                and self.job_context.attempt_no > existing_execution.dispatch_claim.value.attempt_no
            ):
                recovered_execution = existing_execution.model_copy(
                    update={"dispatch_claim": absent()}
                )
                recovered = state.model_copy(
                    update={
                        "dispatch_phase": Prepared,
                        "tool_execution": _PRESENT_TOOL_EXECUTION(value=recovered_execution),
                    }
                )
                self._checkpoint(job, recovered)
                return _position_state(recovered, catalog_view=self.catalog_view)
            self.db.commit()
            return _position_state(state, catalog_view=self.catalog_view)

        state = StepReplayState(
            generation_id=stable_generation_id(self.operation_id, str(position)),
            dispatch_phase=Prepared,
            request_fingerprint=_PRESENT_STR(value=input_digest),
            terminal_result=absent(),
            tool_execution=_PRESENT_TOOL_EXECUTION(value=ToolExecutionState(identity=identity)),
        )
        if self.chat is not None:
            run = self._chat_run()
            record_identity = current_tool_record_identity(
                canonical_tool_id=str(tool_id),
                canonical_input_sha256=input_digest,
                binding_policy_revision=policy_revision,
            )
            tool_call_id = persist_tool_call_start(
                self.db,
                run=run,
                tool_call_index=self.chat.tool_call_index,
                identity=record_identity,
                provider_wire_name=self.chat.provider_wire_name,
                scope=self.audit.scope,
                requested_types=[],
            )
            bind_provider_tool_call_events(
                self.db,
                run=run,
                tool_call_index=self.chat.tool_call_index,
                tool_call_id=tool_call_id,
            )
        self._checkpoint(job, state)
        return _position_state(state, catalog_view=self.catalog_view)

    def reserve(
        self,
        *,
        position: InvocationPosition,
        budgets: BudgetState,
        reservation: Reservation,
    ) -> bool:
        self._check_position(position)
        if budgets is not self.budgets:
            raise ValueError("position used a different durable budget owner")
        _run, job = self._lock_job()
        state = self._required_state(job)
        execution = self._tool_state(state)
        if isinstance(execution.reservation, Present):
            stored = execution.reservation.value
            if (
                stored.calls != reservation.calls
                or stored.input_bytes != reservation.input_bytes
                or stored.max_attempts != reservation.max_attempts
                or stored.max_output_bytes != reservation.max_output_bytes
            ):
                self.db.rollback()
                raise ValueError("durable tool budget reservation changed")
            self.db.commit()
            return stored.accepted
        proposed = ToolExecutionReservation(
            calls=reservation.calls,
            input_bytes=reservation.input_bytes,
            max_attempts=reservation.max_attempts,
            max_output_bytes=reservation.max_output_bytes,
            accepted=budgets.reserve(position, reservation),
        )
        if state.dispatch_phase is not Prepared:
            self.db.rollback()
            raise ValueError("only a prepared tool position may reserve budget")
        updated = state.model_copy(
            update={
                "tool_execution": _PRESENT_TOOL_EXECUTION(
                    value=execution.model_copy(
                        update={"reservation": _PRESENT_TOOL_RESERVATION(value=proposed)}
                    )
                )
            }
        )
        self._checkpoint(job, updated)
        return proposed.accepted

    def dispatch_started(
        self,
        *,
        position: InvocationPosition,
        replay_policy: PortableReplayPolicy,
    ) -> PositionState:
        self._check_position(position)
        locked_run, job = self._lock_job()
        state = self._required_state(job)
        execution = self._tool_state(state)
        if execution.identity.replay_policy is not _journal_policy(replay_policy):
            self.db.rollback()
            raise ValueError("durable tool replay policy changed")
        if state.dispatch_phase is Completed:
            self.db.commit()
            return _position_state(state, catalog_view=self.catalog_view)
        if state.dispatch_phase is Uncertain:
            self.db.commit()
            return PositionState(
                terminal_result=None,
                uncertain=True,
                actual_attempts=execution.abandoned_attempts,
            )
        if (
            not isinstance(execution.reservation, Present)
            or not execution.reservation.value.accepted
        ):
            self.db.rollback()
            raise ValueError("dispatch requires an accepted reservation")
        if locked_run is not None and (
            locked_run.status != "running" or locked_run.cancel_requested_at is not None
        ):
            # This is the cancellation/dispatch linearization point. The
            # pre-dispatch advisory check may race Cancel; this locked check
            # commits the terminal refusal while Cancel remains serialized on
            # the same ChatRun row, before any handler or external attempt.
            result: ToolResult = {
                "type": "Failure",
                "error": {"type": "DeadlineExceeded"},
            }
            terminal = self.terminalize_and_settle(
                position=position,
                budgets=self.budgets,
                result=result,
                settlement=Settlement(
                    actual_attempts=execution.abandoned_attempts,
                    actual_output_bytes=len(canonical_json_bytes(result)),
                ),
            )
            return PositionState(
                terminal_result=terminal,
                uncertain=False,
                actual_attempts=execution.abandoned_attempts,
            )
        updated_execution = execution.model_copy(
            update={
                "dispatch_claim": _PRESENT_TOOL_DISPATCH_CLAIM(
                    value=ToolDispatchClaim(
                        worker_id=self.job_context.worker_id,
                        attempt_no=self.job_context.attempt_no,
                    )
                )
            }
        )
        updated = state.model_copy(
            update={
                "dispatch_phase": Uncertain,
                "tool_execution": _PRESENT_TOOL_EXECUTION(value=updated_execution),
            }
        )
        self._checkpoint(job, updated)
        return PositionState(
            terminal_result=None,
            uncertain=False,
            actual_attempts=execution.abandoned_attempts,
        )

    def dispatch_abandoned(
        self,
        *,
        position: InvocationPosition,
        replay_policy: PortableReplayPolicy,
        actual_attempts: int,
        lease_recovered: bool,
    ) -> None:
        self._check_position(position)
        if replay_policy is not PortableReplayPolicy.ReDispatchable or not lease_recovered:
            raise ValueError("only verified ReDispatchable work may be re-admitted")
        _run, job = self._lock_job()
        state = self._required_state(job)
        execution = self._tool_state(state)
        if (
            state.dispatch_phase is not Uncertain
            or execution.identity.replay_policy is not JournalReplayPolicy.ReDispatchable
            or not isinstance(execution.reservation, Present)
            or not isinstance(execution.dispatch_claim, Present)
            or self.job_context.attempt_no <= execution.dispatch_claim.value.attempt_no
            or actual_attempts < execution.abandoned_attempts
        ):
            self.db.rollback()
            raise ValueError("durable abandoned-dispatch accounting conflicts")
        updated_execution = execution.model_copy(
            update={
                "abandoned_attempts": actual_attempts,
                "dispatch_claim": absent(),
            }
        )
        updated = state.model_copy(
            update={
                "dispatch_phase": Prepared,
                "tool_execution": _PRESENT_TOOL_EXECUTION(value=updated_execution),
            }
        )
        self._checkpoint(job, updated)

    def uncertain(self, *, position: InvocationPosition) -> None:
        self._check_position(position)
        _run, job = self._lock_job()
        state = self._required_state(job)
        if state.dispatch_phase is not Uncertain:
            self.db.rollback()
            raise ValueError("only a dispatched tool position may remain uncertain")
        self.db.commit()

    def terminalize_and_settle(
        self,
        *,
        position: InvocationPosition,
        budgets: BudgetState,
        result: ToolResult,
        settlement: Settlement,
    ) -> ToolResult:
        self._check_position(position)
        if budgets is not self.budgets:
            raise ValueError("position used a different durable budget owner")
        _run, job = self._lock_job()
        state = self._required_state(job)
        if state.dispatch_phase is Completed:
            self.db.commit()
            persisted = _position_state(state, catalog_view=self.catalog_view).terminal_result
            if persisted != result:
                raise ValueError("terminal result differs from completed durable position")
            return result
        execution = self._tool_state(state)
        if not isinstance(execution.reservation, Present):
            self.db.rollback()
            raise ValueError("terminal tool result has no reservation")
        stored_settlement = settlement
        if not execution.reservation.value.accepted:
            stored_settlement = Settlement(actual_attempts=0, actual_output_bytes=0)
        reservation = execution.reservation.value
        if (
            stored_settlement.actual_attempts < execution.abandoned_attempts
            or stored_settlement.actual_attempts > reservation.max_attempts
            or stored_settlement.actual_output_bytes > reservation.max_output_bytes
            or (
                not reservation.accepted
                and (
                    stored_settlement.actual_attempts != 0
                    or stored_settlement.actual_output_bytes != 0
                )
            )
        ):
            self.db.rollback()
            raise ValueError("durable tool settlement exceeds its reservation")
        budgets.settle(position, stored_settlement)
        updated_execution = execution.model_copy(
            update={
                "dispatch_claim": absent(),
                "settlement": _PRESENT_TOOL_SETTLEMENT(
                    value=ToolExecutionSettlement(
                        actual_attempts=stored_settlement.actual_attempts,
                        actual_output_bytes=stored_settlement.actual_output_bytes,
                    )
                ),
            }
        )
        updated = state.model_copy(
            update={
                "dispatch_phase": Completed,
                "terminal_result": _PRESENT_STR(value=canonical_json_bytes(result).decode("utf-8")),
                "tool_execution": _PRESENT_TOOL_EXECUTION(value=updated_execution),
            }
        )
        updated = StepReplayState.model_validate(updated.model_dump(mode="python"))
        try:
            if self.chat is not None:
                self._persist_chat_terminal(updated_execution.identity, result)
            if not checkpoint_step_state(
                self.db,
                ctx=self.job_context,
                job=job,
                step_path=str(position),
                state=updated,
            ):
                raise RuntimeError("durable terminal checkpoint lost its queue lease")
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise
        return result

    def stage_audit(
        self,
        *,
        scope: str,
        requested_types: list[str] | None = None,
        filters: dict[str, Any] | None = None,
        citations: list[RetrievalCitation] | None = None,
        selected_citations: list[RetrievalCitation] | None = None,
        created_refs: list[dict[str, Any]] | None = None,
        provider_request_ids: list[str] | None = None,
        search_query_fingerprint: str | None = None,
        latency_ms: int | None = None,
    ) -> None:
        self.audit = _AuditProjection(
            scope=scope,
            requested_types=list(requested_types or ()),
            filters=dict(filters or {}),
            citations=list(citations or ()),
            selected_citations=list(
                (citations or ()) if selected_citations is None else selected_citations
            ),
            created_refs=list(created_refs or ()),
            provider_request_ids=list(provider_request_ids or ()),
            search_query_fingerprint=search_query_fingerprint,
            latency_ms=latency_ms,
        )

    def _required_state(self, job: JobRow) -> StepReplayState:
        state = self._state(job)
        if state is None:
            self.db.rollback()
            raise ValueError("durable tool position was not occupied")
        return state

    def _budget_accepts(
        self,
        position: InvocationPosition,
        reservation: Reservation,
    ) -> bool:
        self._check_position(position)
        job = get_job(self.db, self.job_context.job_id)
        if job is None:
            return False
        accepted: list[ToolExecutionReservation] = []
        in_flight = 0
        for state in read_step_states(job).values():
            if not isinstance(state.tool_execution, Present):
                continue
            tool = state.tool_execution.value
            if not isinstance(tool.reservation, Present) or not tool.reservation.value.accepted:
                continue
            accepted.append(tool.reservation.value)
            if state.dispatch_phase is Uncertain:
                in_flight += 1
        limits = self.budgets.limits
        return (
            sum(item.calls for item in accepted) + reservation.calls <= limits.max_calls
            and sum(item.input_bytes for item in accepted) + reservation.input_bytes
            <= limits.max_input_bytes
            and sum(item.max_attempts for item in accepted) + reservation.max_attempts
            <= limits.max_external_attempts
            and sum(item.max_output_bytes for item in accepted) + reservation.max_output_bytes
            <= limits.max_output_bytes
            and in_flight < limits.max_in_flight
        )

    def _validate_settlement(
        self,
        position: InvocationPosition,
        settlement: Settlement,
    ) -> None:
        self._check_position(position)
        if settlement.actual_attempts < 0 or settlement.actual_output_bytes < 0:
            raise ValueError("tool settlement cannot be negative")

    def _chat_run(self) -> ChatRun:
        assert self.chat is not None
        run = self.db.get(ChatRun, self.chat.run_id)
        if run is None or (
            run.conversation_id != self.chat.conversation_id
            or run.user_message_id != self.chat.user_message_id
            or run.assistant_message_id != self.chat.assistant_message_id
        ):
            raise AssertionError("Chat execution owner changed durable identity")
        return run

    def _assert_chat_row(self, identity: ToolExecutionIdentity) -> None:
        assert self.chat is not None
        row = (
            self.db.execute(
                text(
                    """
                SELECT canonical_tool_id, record_kind, provider_wire_name,
                       canonical_input_sha256, tool_contract_revision,
                       binding_policy_revision
                FROM message_tool_calls
                WHERE assistant_message_id = :assistant_message_id
                  AND tool_call_index = :tool_call_index
                """
                ),
                {
                    "assistant_message_id": self.chat.assistant_message_id,
                    "tool_call_index": self.chat.tool_call_index,
                },
            )
            .mappings()
            .one_or_none()
        )
        expected = {
            "canonical_tool_id": identity.tool_id,
            "record_kind": RecordKind.current_execution.value,
            "canonical_input_sha256": identity.input_digest,
            "tool_contract_revision": identity.tool_contract_revision,
            "binding_policy_revision": identity.policy_revision,
        }
        if row is None or any(row[key] != value for key, value in expected.items()):
            self.db.rollback()
            raise ValueError("Chat tool row differs from occupied durable identity")
        if row["provider_wire_name"] not in {None, self.chat.provider_wire_name}:
            self.db.rollback()
            raise ValueError("Chat tool row differs from occupied durable identity")

    def _persist_chat_terminal(
        self,
        identity: ToolExecutionIdentity,
        result: ToolResult,
    ) -> None:
        assert self.chat is not None
        run = self._chat_run()
        if identity.tool_id == "web.search":
            self._stage_web_search_audit(result)
        _stage_chat_terminal_projection(
            self.db,
            run=run,
            chat=self.chat,
            identity=identity,
            result=result,
            audit=self.audit,
        )

    def _stage_web_search_audit(self, result: ToolResult) -> None:
        assert self.chat is not None
        self.audit = _build_web_search_audit(
            self.db,
            run=self._chat_run(),
            chat=self.chat,
            result=result,
            catalog_view=self.catalog_view,
        )


def _stage_chat_terminal_projection(
    db: Session,
    *,
    run: ChatRun,
    chat: _ChatExecutionOwner,
    identity: ToolExecutionIdentity,
    result: ToolResult,
    audit: _AuditProjection,
) -> None:
    """Stage the sole Chat row/event/retrieval projection without committing."""

    declaration = _declaration(identity.tool_id)
    record_identity = current_tool_record_identity(
        canonical_tool_id=identity.tool_id,
        canonical_input_sha256=identity.input_digest,
        binding_policy_revision=identity.policy_revision,
    )
    is_error = result["type"] == "Failure"
    error_code = str(cast("dict[str, object]", result["error"])["type"]) if is_error else None
    result_refs = (
        audit.created_refs
        if declaration.spec.effect is ToolEffect.Write
        else [citation.result_ref_json() for citation in audit.citations]
    )
    event_results = [
        TypeAdapter(RetrievalResultRef).validate_python(citation.result_ref_json())
        for citation in audit.citations
    ]
    selected_context_refs = [citation.context_ref for citation in audit.selected_citations]
    tool_call_id = persist_current_tool_record(
        db,
        conversation_id=run.conversation_id,
        user_message_id=run.user_message_id,
        assistant_message_id=run.assistant_message_id,
        tool_call_index=chat.tool_call_index,
        identity=record_identity,
        provider_wire_name=chat.provider_wire_name,
        search_query_fingerprint=audit.search_query_fingerprint,
        scope=audit.scope,
        requested_types=audit.requested_types,
        result_refs=result_refs,
        selected_context_refs=selected_context_refs,
        provider_request_ids=audit.provider_request_ids,
        latency_ms=audit.latency_ms,
        status="error" if is_error else "complete",
        error_code=error_code,
        clear_reverted=declaration.spec.effect is ToolEffect.Write,
    )
    for ordinal, citation in enumerate(audit.citations):
        insert_retrieval_row(
            db,
            tool_call_id=tool_call_id,
            ordinal=ordinal,
            citation=citation,
            selected=citation in audit.selected_citations,
            scope=audit.scope,
            retrieval_status="retrieved",
        )
    event = ChatRunToolResultEventPayload(
        record_kind=RecordKind.current_execution.value,
        canonical_tool_id=identity.tool_id,
        provider_wire_name=chat.provider_wire_name,
        effect=declaration.spec.effect,
        result_kind=declaration.result_kind,
        activity_label=declaration.activity_label,
        error_type=error_code,
        canonical_input_sha256=identity.input_digest,
        tool_contract_revision=identity.tool_contract_revision,
        binding_policy_revision=identity.policy_revision,
        tool_call_id=tool_call_id,
        assistant_message_id=run.assistant_message_id,
        tool_call_index=chat.tool_call_index,
        status="error" if is_error else "complete",
        scope=audit.scope,
        types=audit.requested_types,
        filters=audit.filters,
        error_code=error_code,
        result_count=len(audit.citations),
        selected_count=len(audit.selected_citations),
        latency_ms=audit.latency_ms,
        provider_request_ids=audit.provider_request_ids,
        results=event_results,
    )
    ChatRunEventEmitter(db, run).tool_result(event)


def _build_web_search_audit(
    db: Session,
    *,
    run: ChatRun,
    chat: _ChatExecutionOwner,
    result: ToolResult,
    catalog_view: PlanCatalogView,
) -> _AuditProjection:
    """Mint Nexus snapshot identities for one portable web terminal."""

    from nexus.db.models import ResourceExternalSnapshot
    from nexus.ids import new_uuid7
    from nexus.schemas.retrieval import ExternalSnapshotId, ProviderResultRef
    from nexus.services.agent_tools.web_search import PersistedWebSearchCitation

    raw_input: object = chat.provider_arguments
    if raw_input is None:
        # Reconciliation reconstructs the admitted request from the MCP-owned
        # durable event because there is no live handler context by definition.
        raw_input = db.execute(
            text(
                """
                SELECT payload->'input'
                FROM chat_run_events
                WHERE run_id = :run_id
                  AND event_type = 'tool_call_done'
                  AND payload->>'tool_call_index' = :tool_call_index
                ORDER BY seq DESC
                LIMIT 1
                """
            ),
            {"run_id": chat.run_id, "tool_call_index": str(chat.tool_call_index)},
        ).scalar_one_or_none()
    projected_input: dict[str, object] | None = None
    if isinstance(raw_input, dict):
        input_type = catalog_view.spec(ToolId("web.search")).input_type
        try:
            validated_input = TypeAdapter(input_type).validate_json(
                canonical_json_bytes(raw_input),
                strict=True,
            )
            projected = TypeAdapter(input_type).dump_python(validated_input, mode="json")
        except ValidationError:
            pass
        else:
            if isinstance(projected, dict):
                projected_input = cast("dict[str, object]", projected)
    if projected_input is None and result["type"] == "Success":
        raise AssertionError("web.search success lacks its valid provider tool input")
    query = projected_input.get("query") if projected_input is not None else None
    if query is not None and not isinstance(query, str):
        raise AssertionError("web.search projected query is malformed")
    freshness_days = projected_input.get("freshness_days") if projected_input is not None else None
    audit = _AuditProjection(
        scope="public_web",
        requested_types=["mixed"],
        filters={
            "freshness_days": freshness_days,
            "allowed_domains": [],
            "blocked_domains": [],
        },
        search_query_fingerprint=(
            hashlib.sha256(query.encode("utf-8")).hexdigest() if query is not None else None
        ),
    )
    if result["type"] == "Failure":
        return audit

    value = cast("dict[str, Any]", result["value"])
    raw_hits = value.get("results")
    if not isinstance(raw_hits, list):
        raise AssertionError("web.search success omitted its closed result list")
    selected_indexes = _selected_web_result_indexes(
        raw_hits,
        catalog_view=catalog_view,
    )
    for index, raw_hit in enumerate(raw_hits):
        if not isinstance(raw_hit, dict):
            raise AssertionError("web.search success contains a malformed result")
        persisted = PersistedWebSearchCitation(
            external_snapshot_id=ExternalSnapshotId(new_uuid7()),
            provider_result_ref=ProviderResultRef(str(raw_hit["result_ref"])),
            title=str(raw_hit["title"]),
            url=str(raw_hit["url"]),
            display_url=str(raw_hit["display_url"]),
            snippet=str(raw_hit["snippet"]),
            extra_snippets=tuple(str(item) for item in raw_hit["extra_snippets"]),
            published_at=cast("str | None", raw_hit["published_at"]),
            source_name=cast("str | None", raw_hit["source_name"]),
            rank=int(raw_hit["rank"]),
            provider=str(raw_hit["provider"]),
            provider_request_id=cast("str | None", raw_hit["provider_request_id"]),
            selected=index in selected_indexes,
        )
        result_ref = persisted.retrieval_result_ref_json()
        db.add(
            ResourceExternalSnapshot(
                id=persisted.external_snapshot_id,
                user_id=run.owner_user_id,
                provider=persisted.provider,
                url=persisted.url,
                title=persisted.title,
                snippet=persisted.snippet,
                source_snapshot=result_ref,
            )
        )
        source_id = str(persisted.external_snapshot_id)
        citation = RetrievalCitation(
            result_type="web_result",
            source_id=source_id,
            title=persisted.title,
            source_label=None,
            snippet=persisted.snippet,
            deep_link=persisted.url,
            citation_target=f"external_snapshot:{source_id}",
            citation_label=None,
            locator=persisted.locator_json(),
            context_ref={"type": "web_result", "id": source_id},
            evidence_span_id=None,
            media_id=None,
            media_kind=None,
            score=1.0 / max(persisted.rank, 1),
            result_ref=result_ref,
            selected=persisted.selected,
        )
        audit.citations.append(citation)
        if persisted.selected:
            audit.selected_citations.append(citation)
    # Raw retrieval inserts reference these new snapshot rows; flush the ORM
    # identity owner without committing the caller's atomic terminal boundary.
    db.flush()
    provider_request_id = value.get("provider_request_id")
    if provider_request_id is not None and not isinstance(provider_request_id, str):
        raise AssertionError("web.search provider request id is malformed")
    audit.provider_request_ids = [provider_request_id] if provider_request_id else []
    return audit


def _selected_web_result_indexes(
    raw_hits: list[object],
    *,
    catalog_view: PlanCatalogView,
) -> frozenset[int]:
    """Select prompt citations under the frozen binding's canonical JSON budget."""

    policy = catalog_view.binding(ToolId("web.search")).policy_inputs
    selected_limit = policy.get("selected_results")
    context_chars = policy.get("context_chars")
    if (
        not isinstance(selected_limit, int)
        or isinstance(selected_limit, bool)
        or selected_limit < 1
        or not isinstance(context_chars, int)
        or isinstance(context_chars, bool)
        or context_chars < 1
    ):
        raise AssertionError("web.search binding lacks its bounded citation policy")
    selected: set[int] = set()
    total_chars = 0
    for index, raw_hit in enumerate(raw_hits[:selected_limit]):
        if not isinstance(raw_hit, dict):
            raise AssertionError("web.search success contains a malformed result")
        block_chars = len(canonical_json_bytes(raw_hit).decode("utf-8"))
        if total_chars + block_chars > context_chars:
            break
        selected.add(index)
        total_chars += block_chars
    return frozenset(selected)


def stage_reconciled_chat_tool_terminal(
    *,
    db: Session,
    operation: FrozenToolOperation,
    run: ChatRun,
    tool_call_index: int,
    identity: ToolExecutionIdentity,
    result: ToolResult,
) -> None:
    """Stage one operator-attached Chat terminal through the live projection owner.

    The caller owns the dead-job lock, journal checkpoint, requeue, and atomic
    commit. This function requires the already-occupied current row and refuses
    a second terminal projection instead of silently replaying side effects.
    """

    binding = _assert_operation_identity(operation, identity)
    if binding.replay_policy is not PortableReplayPolicy.BilledOnce:
        raise ValueError("only BilledOnce Chat tools accept reconciled terminals")
    if tool_call_index < 1:
        raise ValueError("Chat tool-call index must be positive")
    stored_run = db.get(ChatRun, run.id)
    if stored_run is None or (
        stored_run.conversation_id != run.conversation_id
        or stored_run.user_message_id != run.user_message_id
        or stored_run.assistant_message_id != run.assistant_message_id
        or stored_run.owner_user_id != run.owner_user_id
    ):
        raise ValueError("Chat run differs from the reconciled execution owner")
    raw_result = canonical_json_bytes(result).decode("utf-8")
    if (
        _validated_portable_result(
            raw_result,
            tool_id=identity.tool_id,
            catalog_view=operation.plan.catalog_view,
        )
        != result
    ):
        raise ValueError("reconciled Chat result differs from its strict projection")

    row = (
        db.execute(
            text(
                """
                SELECT id, canonical_tool_id, record_kind, provider_wire_name,
                       canonical_input_sha256, tool_contract_revision,
                       binding_policy_revision, status, error_code
                FROM message_tool_calls
                WHERE assistant_message_id = :assistant_message_id
                  AND tool_call_index = :tool_call_index
                FOR UPDATE
                """
            ),
            {
                "assistant_message_id": stored_run.assistant_message_id,
                "tool_call_index": tool_call_index,
            },
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise ValueError("Chat tool row is not the occupied reconciliable position")
    if dict(row) != {
        "id": row["id"],
        "canonical_tool_id": identity.tool_id,
        "record_kind": RecordKind.current_execution.value,
        "provider_wire_name": identity.tool_id,
        "canonical_input_sha256": identity.input_digest,
        "tool_contract_revision": identity.tool_contract_revision,
        "binding_policy_revision": identity.policy_revision,
        "status": "running",
        "error_code": None,
    }:
        raise ValueError("Chat tool row is not the occupied reconciliable position")
    prior_terminal = db.execute(
        text(
            """
            SELECT 1
            FROM chat_run_events
            WHERE run_id = :run_id
              AND event_type = 'tool_result'
              AND payload->>'tool_call_id' = :tool_call_id
            LIMIT 1
            """
        ),
        {"run_id": stored_run.id, "tool_call_id": str(row["id"])},
    ).scalar_one_or_none()
    if prior_terminal is not None:
        raise ValueError("Chat tool position already has a terminal projection")

    chat = _ChatExecutionOwner(
        run_id=stored_run.id,
        conversation_id=stored_run.conversation_id,
        user_message_id=stored_run.user_message_id,
        assistant_message_id=stored_run.assistant_message_id,
        tool_call_index=tool_call_index,
        admitted_resource_uris=frozenset(),
        provider_wire_name=identity.tool_id,
        provider_arguments=None,
    )
    audit = _AuditProjection(scope="conversation_context")
    if identity.tool_id == "web.search":
        audit = _build_web_search_audit(
            db,
            run=stored_run,
            chat=chat,
            result=result,
            catalog_view=operation.plan.catalog_view,
        )
    _stage_chat_terminal_projection(
        db,
        run=stored_run,
        chat=chat,
        identity=identity,
        result=result,
        audit=audit,
    )


def _declaration(tool_id: str) -> Any:
    matches = [entry for entry in CHAT_TOOL_DECLARATIONS if str(entry.spec.id) == tool_id]
    if len(matches) != 1:
        raise AssertionError(f"unknown canonical tool declaration: {tool_id!r}")
    return matches[0]


class _ChatCancellation:
    def __init__(self, db: Session, run_id: UUID) -> None:
        self._db = db
        self._run_id = run_id

    @property
    def cancelled(self) -> bool:
        return bool(
            self._db.execute(
                text("SELECT cancel_requested_at IS NOT NULL FROM chat_runs WHERE id = :id"),
                {"id": self._run_id},
            ).scalar_one()
        )


class _NexusTelemetry:
    def event(self, name: str, attributes: dict[str, Any]) -> None:
        del name, attributes


def make_durable_execution_context(
    *,
    db: Session,
    operation: FrozenToolOperation,
    operation_id: UUID,
    claimed_job: JobRow,
    job_context: JobExecutionContext,
    durable_step_path: str,
    tool_id: ToolId,
    principal: Principal,
    scope: Scope,
    effect_id: EffectId | None,
    cancellation: Any,
    telemetry: Any,
) -> ExecutionContext:
    """Build one explicit generic context over a claimed durable Nexus job."""

    position = InvocationPosition(durable_step_path)
    grant = operation.plan.grant(tool_id)
    recorder = NexusPositionRecorder(
        db=db,
        operation_id=operation_id,
        claimed_job=claimed_job,
        job_context=job_context,
        position=position,
        limits=operation.profile.run_limits,
        catalog_view=operation.plan.catalog_view,
        chat=None,
    )
    return ExecutionContext(
        plan=operation.plan,
        grant=grant,
        catalog_view=operation.plan.catalog_view,
        position=position,
        recorder=recorder,
        effect_id=effect_id,
        budgets=recorder.budgets,
        principal=principal,
        scope=scope,
        cancellation=cancellation,
        telemetry=telemetry,
    )


def make_chat_execution_context(
    *,
    db: Session,
    operation: FrozenToolOperation,
    run: ChatRun,
    claimed_job: JobRow,
    job_context: JobExecutionContext,
    durable_step_path: str,
    tool_call_index: int,
    admitted_resource_uris: tuple[str, ...],
    tool_id: ToolId,
    effect_id: EffectId | None,
    provider_wire_name: str,
    provider_arguments: dict[str, Any],
) -> ExecutionContext:
    """Build the explicit Chat context frozen by admission and queue claim."""

    if tool_call_index < 1:
        raise ValueError("Chat tool-call index must be positive")
    if durable_step_path.rsplit("/", 1)[-1] != str(tool_call_index):
        raise ValueError("Chat durable position differs from its tool-call index")
    binding = operation.plan.catalog_view.binding(tool_id)
    expected_effect_id = EffectId(str(stable_generation_id(run.id, durable_step_path)))
    if binding.spec.effect is ToolEffect.Write:
        if effect_id != expected_effect_id:
            raise ValueError("Chat write effect id differs from its durable position")
    elif effect_id is not None:
        raise ValueError("Chat read tool must not carry an effect id")
    admitted = tuple(dict.fromkeys(admitted_resource_uris))
    if any(not uri for uri in admitted):
        raise ValueError("Chat admitted resource URIs must be non-empty")
    position = InvocationPosition(durable_step_path)
    chat = _ChatExecutionOwner(
        run_id=run.id,
        conversation_id=run.conversation_id,
        user_message_id=run.user_message_id,
        assistant_message_id=run.assistant_message_id,
        tool_call_index=tool_call_index,
        admitted_resource_uris=frozenset(admitted),
        provider_wire_name=provider_wire_name,
        provider_arguments=dict(provider_arguments),
    )
    recorder = NexusPositionRecorder(
        db=db,
        operation_id=run.id,
        claimed_job=claimed_job,
        job_context=job_context,
        position=position,
        limits=operation.profile.run_limits,
        catalog_view=operation.plan.catalog_view,
        chat=chat,
    )
    return ExecutionContext(
        plan=operation.plan,
        grant=operation.plan.grant(tool_id),
        catalog_view=operation.plan.catalog_view,
        position=position,
        recorder=recorder,
        effect_id=effect_id,
        budgets=recorder.budgets,
        principal=Principal(str(run.owner_user_id)),
        scope=Scope("conversation_context"),
        cancellation=_ChatCancellation(db, run.id),
        telemetry=_NexusTelemetry(),
    )


def chat_tool_execution_receipt(
    context: ExecutionContext,
    *,
    result: ToolResult,
    provider_call_id: str,
    starting_citation_ordinal: int,
) -> ToolStepResult:
    """Project a completed portable result into Chat's durable model bridge."""

    recorder = context.recorder
    if not isinstance(recorder, NexusPositionRecorder) or recorder.chat is None:
        raise ValueError("Chat receipt requires a Nexus Chat execution context")
    chat = recorder.chat
    job = get_job(recorder.db, recorder.job_context.job_id)
    if job is None:
        raise ValueError("Chat receipt lost its durable job")
    state = read_step_states(job).get(str(recorder.position))
    if state is None or state.dispatch_phase is not Completed:
        raise ValueError("Chat receipt requires a completed durable tool position")
    identity = recorder._tool_state(state).identity
    receipt = stage_chat_tool_execution_receipt(
        db=recorder.db,
        catalog_view=recorder.catalog_view,
        run=recorder._chat_run(),
        tool_call_index=chat.tool_call_index,
        identity=identity,
        provider_wire_name=chat.provider_wire_name,
        result=result,
        provider_call_id=provider_call_id,
        starting_citation_ordinal=starting_citation_ordinal,
    )
    recorder.db.commit()
    return receipt


def recover_chat_tool_execution_receipt(
    *,
    db: Session,
    operation: FrozenToolOperation,
    run: ChatRun,
    tool_call_index: int,
    identity: ToolExecutionIdentity,
    raw_result: str,
    provider_wire_name: str,
    provider_call_id: str,
    starting_citation_ordinal: int,
) -> ToolStepResult:
    """Rebuild the outer MCP receipt from an already-completed inner position.

    This is a projection repair, not a tool replay.  The completed portable
    result, occupied identity, current row, terminal event, and citation cursor
    must all agree before the caller may atomically attach the receipt to its
    queue-owned MCP journal.
    """

    _assert_operation_identity(operation, identity)
    result = _validated_portable_result(
        raw_result,
        tool_id=identity.tool_id,
        catalog_view=operation.plan.catalog_view,
    )
    _validate_reconciled_result_policy(
        result,
        tool_id=identity.tool_id,
        catalog_view=operation.plan.catalog_view,
    )
    return stage_chat_tool_execution_receipt(
        db=db,
        catalog_view=operation.plan.catalog_view,
        run=run,
        tool_call_index=tool_call_index,
        identity=identity,
        provider_wire_name=provider_wire_name,
        result=result,
        provider_call_id=provider_call_id,
        starting_citation_ordinal=starting_citation_ordinal,
    )


def stage_chat_tool_execution_receipt(
    *,
    db: Session,
    catalog_view: PlanCatalogView,
    run: ChatRun,
    tool_call_index: int,
    identity: ToolExecutionIdentity,
    provider_wire_name: str,
    result: ToolResult,
    provider_call_id: str,
    starting_citation_ordinal: int,
) -> ToolStepResult:
    """Stage the single strict Chat receipt projection without committing."""

    validated_result = _validated_portable_result(
        canonical_json_bytes(result).decode("utf-8"),
        tool_id=identity.tool_id,
        catalog_view=catalog_view,
    )
    if validated_result != result:
        raise ValueError("Chat receipt result differs from its strict tool projection")
    if tool_call_index < 1 or starting_citation_ordinal < 1:
        raise ValueError("Chat receipt position and citation cursor must be positive")
    expected_error = (
        str(cast("dict[str, object]", result["error"])["type"])
        if result["type"] == "Failure"
        else None
    )
    row = (
        db.execute(
            text(
                """
                SELECT id, canonical_tool_id, record_kind, provider_wire_name,
                       canonical_input_sha256, tool_contract_revision,
                       binding_policy_revision, status, error_code
                FROM message_tool_calls
                WHERE assistant_message_id = :assistant_message_id
                  AND tool_call_index = :tool_call_index
                FOR UPDATE
                """
            ),
            {
                "assistant_message_id": run.assistant_message_id,
                "tool_call_index": tool_call_index,
            },
        )
        .mappings()
        .one()
    )
    expected_row = {
        "canonical_tool_id": identity.tool_id,
        "record_kind": RecordKind.current_execution.value,
        "provider_wire_name": provider_wire_name,
        "canonical_input_sha256": identity.input_digest,
        "tool_contract_revision": identity.tool_contract_revision,
        "binding_policy_revision": identity.policy_revision,
        "status": "error" if result["type"] == "Failure" else "complete",
        "error_code": expected_error,
    }
    if any(row[field] != value for field, value in expected_row.items()):
        raise ValueError("Chat receipt row differs from its completed durable identity")
    event_payload = db.execute(
        text(
            """
            SELECT payload
            FROM chat_run_events
            WHERE run_id = :run_id
              AND event_type = 'tool_result'
              AND payload->>'tool_call_id' = :tool_call_id
            ORDER BY seq DESC
            LIMIT 1
            """
        ),
        {"run_id": run.id, "tool_call_id": str(row["id"])},
    ).scalar_one()
    event = ChatRunToolResultEventPayload.model_validate(event_payload)
    if (
        event.tool_call_id != row["id"]
        or event.assistant_message_id != run.assistant_message_id
        or event.tool_call_index != tool_call_index
        or event.canonical_tool_id != identity.tool_id
        or event.provider_wire_name != provider_wire_name
        or event.canonical_input_sha256 != identity.input_digest
        or event.tool_contract_revision != identity.tool_contract_revision
        or event.binding_policy_revision != identity.policy_revision
        or event.status != expected_row["status"]
        or event.error_code != expected_error
    ):
        raise ValueError("Chat receipt event differs from its completed durable identity")
    numbering = number_tool_citation_candidates(
        db,
        tool_call_id=row["id"],
        start_ordinal=starting_citation_ordinal,
    )
    return ToolStepResult(
        tool_call_id=row["id"],
        canonical_tool_id=row["canonical_tool_id"],
        record_kind=RecordKind.current_execution,
        canonical_input_sha256=row["canonical_input_sha256"],
        tool_contract_revision=row["tool_contract_revision"],
        binding_policy_revision=row["binding_policy_revision"],
        tool_call_index=tool_call_index,
        model_output=ToolModelOutput(
            call_id=provider_call_id,
            output=_render_chat_tool_result(result, numbering),
            is_error=result["type"] == "Failure",
        ),
        next_citation_ordinal=numbering.next_ordinal,
        result_event=event,
    )


def _render_chat_tool_result(
    result: ToolResult,
    numbering: CitationCandidateNumbering,
) -> str:
    citable_rows = tuple(row for row in numbering.rows if row.candidate_ordinal is not None)
    if not citable_rows:
        return canonical_json_bytes(result).decode("utf-8")
    sections = [
        PromptSection(
            kind=PromptSectionKind("payload"),
            attributes=(),
            body=PromptJson(cast(Any, result)),
        )
    ]
    sections.extend(
        PromptSection(
            kind=PromptSectionKind("tool_citation"),
            attributes=(
                PromptAttribute(
                    PromptAttributeName("n"),
                    cast(int, row.candidate_ordinal),
                ),
                PromptAttribute(
                    PromptAttributeName("retrieval_ordinal"),
                    row.retrieval_ordinal,
                ),
            ),
            body=PromptJson(cast(Any, row.result_ref)),
        )
        for row in citable_rows
    )
    return render_prompt(
        PromptSection(
            kind=PromptSectionKind("tool_result"),
            attributes=(),
            body=PromptSections(sections),
        )
    )


def _chat_recorder(context: ExecutionContext) -> NexusPositionRecorder:
    recorder = context.recorder
    if not isinstance(recorder, NexusPositionRecorder) or recorder.chat is None:
        raise ExecutorConfigurationDefect("Nexus tools require an explicit Chat execution owner")
    try:
        principal = UUID(str(context.principal))
    except ValueError as exc:
        raise ExecutorConfigurationDefect("Nexus principal is not a UUID") from exc
    run = recorder._chat_run()
    if principal != run.owner_user_id:
        raise ExecutorConfigurationDefect("Nexus principal differs from the Chat owner")
    return recorder


def _declared_failure(error: object) -> Never:
    raise DeclaredToolFailure(error, actual_attempts=0)


def _resource_unavailable() -> Never:
    _declared_failure(tool_declarations.ResourceUnavailable(type="ResourceUnavailable"))


def _collapse_expected_unavailable(
    exc: ApiError,
    *,
    allowed_codes: frozenset[ApiErrorCode],
) -> Never:
    """Collapse only reviewed owner denials; every other API error defects."""

    if exc.code in allowed_codes:
        _resource_unavailable()
    raise exc


def _parse_ref_or_unavailable(uri: str) -> Any:
    from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref

    parsed = parse_resource_ref(uri)
    if isinstance(parsed, ResourceRefParseFailure):
        _resource_unavailable()
    return parsed


def _admitted_target(
    recorder: NexusPositionRecorder,
    uri: str,
    *,
    allow_derived_read: bool = False,
) -> Any:
    """Return the parsed target after the operation-owned frozen admission set."""

    from nexus.services.tool_runtime.resource_scope import resource_uri_is_admitted

    assert recorder.chat is not None
    if not resource_uri_is_admitted(
        recorder.db,
        uri=uri,
        admitted_resource_uris=recorder.chat.admitted_resource_uris,
        allow_derived_read=allow_derived_read,
    ):
        _resource_unavailable()
    return _parse_ref_or_unavailable(uri)


def _assert_visible(recorder: NexusPositionRecorder, uri: str) -> Any:
    from nexus.services.resource_graph.resolve import assert_ref_visible

    ref = _admitted_target(recorder, uri)
    try:
        assert_ref_visible(
            recorder.db, viewer_id=UUID(str(recorder._chat_run().owner_user_id)), ref=ref
        )
    except ApiError as exc:
        _collapse_expected_unavailable(
            exc,
            allowed_codes=frozenset({ApiErrorCode.E_NOT_FOUND}),
        )
    return ref


def _snapshot_revision(value: object) -> str:
    return hashlib.sha256(canonical_json_bytes(cast("Any", value))).hexdigest()


def _citation_locator(citation: RetrievalCitation | None) -> str | None:
    if citation is None or citation.locator is None:
        return None
    encoded = json.dumps(citation.locator, sort_keys=True, separators=(",", ":"))
    return encoded if len(encoded) <= 512 else f"sha256:{_snapshot_revision(citation.locator)}"


def _evidence(
    context: ExecutionContext,
    *,
    resource_uri: str,
    material: object,
    citation: RetrievalCitation | None = None,
    content: str | None = None,
) -> tool_declarations.NexusEvidence:
    excerpt_id = None
    if citation is not None and citation.evidence_span_id is not None:
        try:
            excerpt_id = UUID(citation.evidence_span_id)
        except ValueError:
            excerpt_id = None
    return tool_declarations.NexusEvidence(
        admission_scope=str(context.scope),
        citation_target=(citation.citation_target if citation else None) or resource_uri,
        content_sha256=(
            hashlib.sha256(content.encode("utf-8")).hexdigest() if content is not None else None
        ),
        context_ref=resource_uri,
        excerpt_id=excerpt_id,
        locator=_citation_locator(citation),
        observed_at=None,
        resource_uri=resource_uri,
        snapshot_revision=None if content is not None else _snapshot_revision(material),
    )


def _citation_for_ref(
    recorder: NexusPositionRecorder,
    *,
    result_type: str | None,
    source_id: str,
    filters: dict[str, Any],
) -> RetrievalCitation | None:
    if result_type is None:
        return None
    from nexus.services.retrieval_citation import citation_from_search_result
    from nexus.services.search import get_search_result

    try:
        result = get_search_result(
            recorder.db,
            UUID(str(recorder._chat_run().owner_user_id)),
            result_type,
            source_id,
        )
        return citation_from_search_result(result, filters=filters)
    except ApiError as exc:
        if exc.code is ApiErrorCode.E_NOT_FOUND:
            return None
        raise


def _kind_for_result_type(result_type: str) -> str:
    from nexus.services.search.kinds import KIND_TO_RESULT_TYPES

    matches = [
        kind for kind, result_types in KIND_TO_RESULT_TYPES.items() if result_type in result_types
    ]
    if len(matches) != 1:
        raise AssertionError(f"search result type lacks one public kind: {result_type!r}")
    return matches[0]


def _plain_search_snippet(snippet: str) -> str:
    """Remove the search owner's two trusted match-marker tags for tool JSON."""

    return snippet.replace("<b>", "").replace("</b>", "")


def _selected_nexus_search_citations(
    citations: Sequence[RetrievalCitation],
    *,
    catalog_view: PlanCatalogView,
) -> list[RetrievalCitation]:
    """Select ranked result refs under the frozen Nexus-search prompt budget."""

    policy_inputs = catalog_view.binding(ToolId("nexus.search")).policy_inputs
    policy = policy_inputs.get("result_policy")
    if not isinstance(policy, Mapping):
        raise AssertionError("nexus.search binding lacks its result policy")
    max_results = policy.get("max_results")
    selected_limit = policy.get("selected_results")
    context_chars = policy.get("context_chars")
    if any(
        not isinstance(value, int) or isinstance(value, bool) or value < 1
        for value in (max_results, selected_limit, context_chars)
    ):
        raise AssertionError("nexus.search binding has a malformed result policy")
    assert isinstance(max_results, int)
    assert isinstance(selected_limit, int)
    assert isinstance(context_chars, int)
    if selected_limit > max_results or len(citations) > max_results:
        raise AssertionError("nexus.search results exceed the frozen binding policy")
    selected: list[RetrievalCitation] = []
    total_bytes = 0
    for citation in citations[:selected_limit]:
        result_ref_bytes = len(canonical_json_bytes(citation.result_ref_json()))
        if total_bytes + result_ref_bytes > context_chars:
            break
        selected.append(citation)
        total_bytes += result_ref_bytes
    return selected


def _run_search(
    value: tool_declarations.NexusSearchInput,
    context: ExecutionContext,
) -> HandlerSuccess[tool_declarations.NexusSearchSuccess]:
    from nexus.services.agent_tools.app_search import (
        APP_SEARCH_LIMIT,
    )
    from nexus.services.resource_graph.context import search_scope_refs_for_conversation
    from nexus.services.resource_items.capabilities import resource_can_be_app_search_scope
    from nexus.services.retrieval_citation import citation_from_search_result
    from nexus.services.search.batch import search_scopes
    from nexus.services.search.query import build_search_query
    from nexus.services.search.scope import scope_from_uri
    from nexus.services.search.telemetry import hash_query

    recorder = _chat_recorder(context)
    assert recorder.chat is not None
    viewer_id = UUID(str(context.principal))
    requested_scopes = list(value.scopes or ())
    if value.scopes is None:
        requested_scopes = [
            ref.uri
            for ref in search_scope_refs_for_conversation(
                recorder.db,
                viewer_id=viewer_id,
                conversation_id=recorder.chat.conversation_id,
            )
            if ref.uri in recorder.chat.admitted_resource_uris
        ]
    scopes = []
    for uri in requested_scopes:
        ref = _admitted_target(recorder, uri)
        if not resource_can_be_app_search_scope(ref):
            _resource_unavailable()
        scopes.append(scope_from_uri(uri))
    limit = value.limit or APP_SEARCH_LIMIT
    query = build_search_query(
        text=value.query,
        raw_kinds=list(value.kinds) if value.kinds is not None else None,
        raw_formats=list(value.formats) if value.formats is not None else None,
        raw_authors=list(value.authors) if value.authors is not None else None,
        raw_roles=list(value.roles) if value.roles is not None else None,
        scope=scope_from_uri("all"),
        cursor=None,
        limit=limit,
    )
    filters = {
        key: list(items)
        for key, items in (
            ("kinds", value.kinds),
            ("formats", value.formats),
            ("authors", value.authors),
            ("roles", value.roles),
        )
        if items is not None
    }
    if not scopes:
        recorder.stage_audit(
            scope="conversation_context",
            requested_types=list(query.effective_result_types),
            filters=filters,
            citations=[],
            selected_citations=[],
            search_query_fingerprint=hash_query(value.query),
        )
        return HandlerSuccess(
            tool_declarations.NexusSearchSuccess(matches=[], total_candidates=0),
            actual_attempts=0,
        )
    try:
        response = search_scopes(recorder.db, viewer_id, query, scopes)
    except ApiError as exc:
        _collapse_expected_unavailable(
            exc,
            allowed_codes=frozenset(
                {
                    ApiErrorCode.E_NOT_FOUND,
                    ApiErrorCode.E_CONVERSATION_NOT_FOUND,
                }
            ),
        )
    citations = [citation_from_search_result(item, filters=filters) for item in response.results]
    matches = [
        tool_declarations.NexusSearchMatch(
            evidence=_evidence(
                context,
                resource_uri=item.resource_ref,
                material=item.model_dump(mode="json"),
                citation=citation,
            ),
            excerpt=item.snippet[:300],
            kind=cast("Any", _kind_for_result_type(item.type)),
            score=min(1.0, max(0.0, float(item.score))),
            title=item.title[:150],
            uri=item.resource_ref,
        )
        for item, citation in zip(response.results, citations, strict=True)
    ]
    selected = _selected_nexus_search_citations(
        citations,
        catalog_view=recorder.catalog_view,
    )
    recorder.stage_audit(
        scope=",".join(requested_scopes) if requested_scopes else "conversation_context",
        requested_types=list(query.effective_result_types),
        filters=filters,
        citations=citations,
        selected_citations=selected,
        search_query_fingerprint=hash_query(value.query),
    )
    return HandlerSuccess(
        tool_declarations.NexusSearchSuccess(
            matches=matches,
            total_candidates=len(matches) + int(bool(response.page.has_more)),
        ),
        actual_attempts=0,
    )


def _run_resource_read(
    value: tool_declarations.ResourceReadInput,
    context: ExecutionContext,
) -> HandlerSuccess[tool_declarations.ResourceReadSuccess]:
    from nexus.services.agent_tools.read_resource import execute_read_resource

    recorder = _chat_recorder(context)
    _admitted_target(recorder, value.uri, allow_derived_read=True)
    assert recorder.chat is not None
    result = execute_read_resource(
        recorder.db,
        viewer_id=UUID(str(context.principal)),
        conversation_id=recorder.chat.conversation_id,
        uri=value.uri,
    )
    if result.is_error:
        if result.error_code in {"not_readable", "scope_not_readable"}:
            _declared_failure(tool_declarations.Unreadable(type="Unreadable"))
        if result.error_code in {
            "invalid_uri",
            "missing",
            "not_in_context_refs",
            "unknown_scheme",
        }:
            _resource_unavailable()
        raise AssertionError(f"unmapped resource-read refusal: {result.error_code!r}")
    if result.kind == "too_large":
        _declared_failure(tool_declarations.TooLarge(type="TooLarge"))
    citation = _citation_for_ref(
        recorder,
        result_type=result.citation_result_type,
        source_id=result.citation_source_id or "",
        filters={"uri": value.uri},
    )
    # The domain reader distinguishes storage-shaped body kinds more finely
    # than the canonical tool contract. This exhaustive reviewed projection
    # preserves their body semantics while keeping one closed model vocabulary.
    kind = {
        "artifact": "artifact",
        "artifact_revision": "artifact",
        "content_chunk": "section",
        "conversation": "section",
        "evidence_span": "section",
        "full": "full",
        "message": "section",
        "note_block": "section",
        "oracle_passage_anchor": "section",
        "oracle_reading": "oracle_reading",
        "page": "section",
        "page_range": "page_range",
        "quote": "quote",
        "reader_apparatus_item": "section",
        "section": "section",
    }.get(result.kind or "")
    if kind is None:
        raise AssertionError(f"unmapped successful resource-read kind: {result.kind!r}")
    evidence = _evidence(
        context,
        resource_uri=value.uri,
        material={"kind": kind, "uri": value.uri},
        citation=citation,
        content=result.body,
    )
    citations = [citation] if citation is not None else []
    recorder.stage_audit(
        scope="conversation_context",
        filters={"uri": value.uri},
        citations=citations,
    )
    return HandlerSuccess(
        tool_declarations.ResourceReadSuccess(
            evidence=evidence,
            kind=cast("Any", kind),
            text=result.body,
            uri=value.uri,
        ),
        actual_attempts=0,
    )


def _run_document_search(
    value: tool_declarations.DocumentSearchInput,
    context: ExecutionContext,
) -> HandlerSuccess[tool_declarations.DocumentSearchSuccess]:
    from nexus.services.retrieval_citation import citation_from_search_result
    from nexus.services.search import search
    from nexus.services.search.query import build_search_query
    from nexus.services.search.scope import scope_from_uri

    recorder = _chat_recorder(context)
    _assert_visible(recorder, value.uri)
    query = build_search_query(
        text=value.query,
        raw_kinds=["documents"],
        raw_formats=None,
        raw_authors=None,
        raw_roles=None,
        scope=scope_from_uri(value.uri),
        cursor=None,
        limit=value.limit or 8,
    )
    try:
        response = search(recorder.db, UUID(str(context.principal)), query)
    except ApiError as exc:
        _collapse_expected_unavailable(
            exc,
            allowed_codes=frozenset({ApiErrorCode.E_NOT_FOUND}),
        )
    citations = [
        citation_from_search_result(item, filters={"uri": value.uri, "query": value.query})
        for item in response.results
    ]
    matches = [
        tool_declarations.DocumentSearchMatch(
            evidence=_evidence(
                context,
                resource_uri=item.resource_ref,
                material=item.model_dump(mode="json"),
                citation=citation,
            ),
            ordinal=ordinal,
            score=min(1.0, max(0.0, float(item.score))),
            text=_plain_search_snippet(item.snippet)[:2000],
            title=item.title[:500],
            uri=item.resource_ref,
        )
        for ordinal, (item, citation) in enumerate(zip(response.results, citations, strict=True))
    ]
    recorder.stage_audit(
        scope=value.uri,
        requested_types=list(query.effective_result_types),
        filters={"uri": value.uri},
        citations=citations,
    )
    return HandlerSuccess(
        tool_declarations.DocumentSearchSuccess(matches=matches, uri=value.uri),
        actual_attempts=0,
    )


def _run_resource_inspect(
    value: tool_declarations.ResourceInspectInput,
    context: ExecutionContext,
) -> HandlerSuccess[tool_declarations.ResourceInspectSuccess]:
    from nexus.services.agent_tools.inspect_resource import execute_inspect_resource

    recorder = _chat_recorder(context)
    ref = _admitted_target(recorder, value.uri)
    assert recorder.chat is not None
    result = execute_inspect_resource(
        recorder.db,
        viewer_id=UUID(str(context.principal)),
        conversation_id=recorder.chat.conversation_id,
        uri=value.uri,
    )
    if result.is_error:
        if result.error_code == "not_inspectable":
            _declared_failure(tool_declarations.Uninspectable(type="Uninspectable"))
        if result.error_code in {
            "invalid_uri",
            "missing",
            "not_in_context_refs",
            "unknown_scheme",
        }:
            _resource_unavailable()
        raise AssertionError(f"unmapped resource-inspect refusal: {result.error_code!r}")
    if result.document_map is None:
        raise AssertionError("successful resource inspection omitted its document map")
    document_map = result.document_map
    sections = [
        tool_declarations.ResourceInspectSection(
            fragment_id=section.fragment_id,
            label=section.label[:310],
            ordinal=section.ordinal,
            page_end=section.page_end,
            page_start=section.page_start,
            parent_label=section.parent_label[:310] if section.parent_label else None,
            preview=section.preview[:470],
            read_uri=section.read_uri,
            section_kind=cast("Any", section.section_kind),
            t_end_ms=section.t_end_ms,
            t_start_ms=section.t_start_ms,
        )
        for section in document_map.sections
    ]
    result_type = {"podcast_episode": "episode", "video": "video"}.get(
        document_map.kind,
        "media",
    )
    citation = _citation_for_ref(
        recorder,
        result_type=result_type,
        source_id=str(ref.id),
        filters={"uri": value.uri},
    )
    material = {
        "kind": document_map.kind,
        "sections": [section.model_dump(mode="json") for section in sections],
        "title": document_map.title,
        "total_sections": document_map.total_sections,
    }
    recorder.stage_audit(
        scope="conversation_context",
        filters={"uri": value.uri},
        citations=[citation] if citation is not None else [],
    )
    return HandlerSuccess(
        tool_declarations.ResourceInspectSuccess(
            evidence=_evidence(
                context,
                resource_uri=value.uri,
                material=material,
                citation=citation,
            ),
            media_kind=cast("Any", document_map.kind),
            sections=sections,
            title=document_map.title,
            total_sections=document_map.total_sections,
            uri=value.uri,
        ),
        actual_attempts=0,
    )


def _run_relations_list(
    value: tool_declarations.RelationsListInput,
    context: ExecutionContext,
) -> HandlerSuccess[tool_declarations.RelationsListSuccess]:
    from nexus.services.resource_graph.connections import query_connections
    from nexus.services.resource_graph.schemas import ConnectionFilters, ConnectionQuery
    from nexus.services.resource_items.capabilities import resource_citation_result_type

    recorder = _chat_recorder(context)
    ref = _assert_visible(recorder, value.uri)
    page = query_connections(
        recorder.db,
        viewer_id=UUID(str(context.principal)),
        query=ConnectionQuery(
            refs=(ref,),
            direction=value.direction,
            rollup="exact",
            filters=ConnectionFilters(
                kinds=tuple(value.kinds) if value.kinds is not None else None
            ),
            limit=value.limit or 100,
            cursor=None,
        ),
    )
    relations = [
        tool_declarations.RelationMatch(
            direction=item.direction,
            edge_id=item.edge_id,
            kind=item.kind,
            rationale=item.snapshot.excerpt[:150]
            if item.snapshot and item.snapshot.excerpt
            else None,
            source_label=item.source.label[:150] if item.source.label else None,
            source_uri=item.source_ref.uri,
            target_label=item.target.label[:150] if item.target.label else None,
            target_uri=item.target_ref.uri,
        )
        for item in page.items
    ]
    citation = _citation_for_ref(
        recorder,
        result_type=resource_citation_result_type(ref),
        source_id=str(ref.id),
        filters={"uri": value.uri},
    )
    material = [item.model_dump(mode="json") for item in relations]
    recorder.stage_audit(
        scope="conversation_context",
        filters={"uri": value.uri},
        citations=[citation] if citation is not None else [],
    )
    return HandlerSuccess(
        tool_declarations.RelationsListSuccess(
            evidence=_evidence(
                context,
                resource_uri=value.uri,
                material=material,
                citation=citation,
            ),
            relations=relations,
            uri=value.uri,
        ),
        actual_attempts=0,
    )


_WRITE_CAP = 8


def _write_tool_ids() -> tuple[str, ...]:
    return tuple(
        str(entry.spec.id)
        for entry in tool_declarations.NEXUS_TOOL_DECLARATIONS
        if entry.spec.effect is ToolEffect.Write
    )


def _write_refusal(exc: BaseException, *, tool_id: str) -> None:
    from nexus.services.agent_tools.writes import WriteToolRefusal

    if isinstance(exc, WriteToolRefusal):
        error = {
            "library_not_found": tool_declarations.ResourceUnavailable(type="ResourceUnavailable"),
            "library_ambiguous": tool_declarations.TargetAmbiguous(type="TargetAmbiguous"),
            "quote_not_found": tool_declarations.QuoteNotFound(type="QuoteNotFound"),
            "quote_ambiguous": tool_declarations.QuoteAmbiguous(type="QuoteAmbiguous"),
        }.get(exc.error_code)
        if exc.error_code == "invalid_arguments":
            raise BoundaryFailure("InvalidInput", actual_attempts=0) from exc
        if error is None:
            raise AssertionError(f"unmapped write refusal: {exc.error_code}") from exc
        _declared_failure(error)
    if isinstance(exc, ApiError):
        if (
            tool_id == "nexus.library.add"
            and exc.code
            in {
                ApiErrorCode.E_BILLING_REQUIRED,
                ApiErrorCode.E_MEDIA_DELETING,
                ApiErrorCode.E_PODCAST_SUBSCRIPTION_REQUIRED,
            }
        ) or (
            tool_id == "nexus.queue.add"
            and exc.code in {ApiErrorCode.E_LIMIT, ApiErrorCode.E_MEDIA_DELETING}
        ):
            _resource_unavailable()
        if tool_id == "nexus.library.add" and exc.code is ApiErrorCode.E_PODCAST_REPLACES_EPISODES:
            _declared_failure(tool_declarations.TargetAmbiguous(type="TargetAmbiguous"))
        if tool_id == "nexus.highlight.create" and exc.code is ApiErrorCode.E_HIGHLIGHT_CONFLICT:
            _declared_failure(tool_declarations.Conflict(type="Conflict"))
        if tool_id == "nexus.edge.create" and exc.code is ApiErrorCode.E_INVALID_REQUEST:
            _declared_failure(tool_declarations.Conflict(type="Conflict"))
        if exc.code in {
            ApiErrorCode.E_NOT_FOUND,
            ApiErrorCode.E_LIBRARY_NOT_FOUND,
            ApiErrorCode.E_MEDIA_NOT_FOUND,
            ApiErrorCode.E_FORBIDDEN,
            ApiErrorCode.E_LIBRARY_FORBIDDEN,
            ApiErrorCode.E_OWNER_REQUIRED,
            ApiErrorCode.E_DEFAULT_LIBRARY_FORBIDDEN,
        }:
            _resource_unavailable()
    raise exc


def _run_write(
    value: Any,
    context: ExecutionContext,
    *,
    tool_id: str,
    mutate: Callable[[Session, UUID, UUID, dict[str, Any]], Any],
) -> HandlerSuccess[Any]:
    from nexus.services.agent_tools import writes
    from nexus.services.chat_run_tools import assistant_write_tool_call_count

    recorder = _chat_recorder(context)
    assert recorder.chat is not None
    if context.effect_id is None:
        raise ExecutorConfigurationDefect("Nexus write lacks its stable effect id")
    viewer_id = UUID(str(context.principal))
    if (
        assistant_write_tool_call_count(
            recorder.db,
            assistant_message_id=recorder.chat.assistant_message_id,
            canonical_tool_ids=_write_tool_ids(),
        )
        >= _WRITE_CAP
    ):
        _declared_failure(tool_declarations.WriteCapReached(type="WriteCapReached"))
    arguments = value.model_dump(mode="json")
    for key in ("resource_uri", "page_uri", "media_uri", "source_uri", "target_uri"):
        uri = arguments.get(key)
        if isinstance(uri, str):
            _admitted_target(recorder, uri)
    # Linearize cancellation immediately before the domain mutation and retain
    # the run lock through ToolExecutor's terminal row/event/journal commit.
    # Cancel-first means no effect; effect-first means cancellation happened
    # after a fully committed tool result.
    locked_run = lock_chat_run_for_update(recorder.db, recorder.chat.run_id)
    if (
        locked_run is None
        or locked_run.status != "running"
        or locked_run.cancel_requested_at is not None
    ):
        raise BoundaryFailure("DeadlineExceeded", actual_attempts=0)
    try:
        with recorder.db.begin_nested():
            effect = mutate(
                recorder.db,
                viewer_id,
                UUID(str(context.effect_id)),
                arguments,
            )
    except (writes.WriteToolRefusal, ApiError) as exc:
        _write_refusal(exc, tool_id=tool_id)
        raise AssertionError("write refusal translation returned") from exc
    success_type = _declaration(tool_id).spec.success_type
    success = success_type.model_validate(effect.output)
    recorder.stage_audit(
        scope="assistant_write",
        created_refs=effect.created_refs,
    )
    return HandlerSuccess(success, actual_attempts=0)


def _mutate_library(
    db: Session, viewer_id: UUID, effect_id: UUID, arguments: dict[str, Any]
) -> Any:
    from nexus.services.agent_tools.writes import add_to_library

    del effect_id
    return add_to_library(db, viewer_id, arguments)


def _mutate_note(db: Session, viewer_id: UUID, effect_id: UUID, arguments: dict[str, Any]) -> Any:
    from nexus.services.agent_tools.writes import create_note

    return create_note(db, viewer_id, effect_id, arguments)


def _mutate_highlight(
    db: Session, viewer_id: UUID, effect_id: UUID, arguments: dict[str, Any]
) -> Any:
    from nexus.services.agent_tools.writes import create_highlight

    return create_highlight(db, viewer_id, effect_id, arguments)


def _mutate_edge(db: Session, viewer_id: UUID, effect_id: UUID, arguments: dict[str, Any]) -> Any:
    from nexus.services.agent_tools.writes import create_assistant_edge

    del effect_id
    return create_assistant_edge(db, viewer_id, arguments)


def _mutate_queue(db: Session, viewer_id: UUID, effect_id: UUID, arguments: dict[str, Any]) -> Any:
    from nexus.services.agent_tools.writes import add_to_queue

    del effect_id
    return add_to_queue(db, viewer_id, arguments)


def _run_library_add(value: Any, context: ExecutionContext) -> HandlerSuccess[Any]:
    return _run_write(
        value,
        context,
        tool_id="nexus.library.add",
        mutate=_mutate_library,
    )


def _run_note_create(value: Any, context: ExecutionContext) -> HandlerSuccess[Any]:
    return _run_write(value, context, tool_id="nexus.note.create", mutate=_mutate_note)


def _run_highlight_create(value: Any, context: ExecutionContext) -> HandlerSuccess[Any]:
    return _run_write(
        value,
        context,
        tool_id="nexus.highlight.create",
        mutate=_mutate_highlight,
    )


def _run_edge_create(value: Any, context: ExecutionContext) -> HandlerSuccess[Any]:
    return _run_write(value, context, tool_id="nexus.edge.create", mutate=_mutate_edge)


def _run_queue_add(value: Any, context: ExecutionContext) -> HandlerSuccess[Any]:
    return _run_write(value, context, tool_id="nexus.queue.add", mutate=_mutate_queue)


type _NexusHandler = Callable[[Any, ExecutionContext], HandlerSuccess[Any]]

_NEXUS_HANDLERS: Mapping[str, _NexusHandler] = MappingProxyType(
    {
        "nexus.search": _run_search,
        "nexus.resource.read": _run_resource_read,
        "nexus.document.search": _run_document_search,
        "nexus.resource.inspect": _run_resource_inspect,
        "nexus.relations.list": _run_relations_list,
        "nexus.library.add": _run_library_add,
        "nexus.note.create": _run_note_create,
        "nexus.highlight.create": _run_highlight_create,
        "nexus.edge.create": _run_edge_create,
        "nexus.queue.add": _run_queue_add,
    }
)


class NexusToolExecution:
    """Stateless dispatch from canonical binding identity to domain adapter."""

    async def execute(
        self,
        *,
        tool_id: ToolId,
        value: object,
        context: ExecutionContext,
    ) -> HandlerSuccess[Any]:
        try:
            handler = _NEXUS_HANDLERS[str(tool_id)]
        except KeyError as exc:
            raise ExecutorConfigurationDefect(
                f"Nexus execution has no handler for {tool_id!s}"
            ) from exc
        return handler(value, context)


__all__ = [
    "NexusPositionRecorder",
    "NexusToolExecution",
    "chat_tool_execution_receipt",
    "make_chat_execution_context",
    "make_durable_execution_context",
    "reconcile_uncertain_tool_completion",
    "recover_chat_tool_execution_receipt",
    "stage_reconciled_chat_tool_terminal",
]
