"""One route-neutral authority, executor, and durable model-tool position ledger."""

from __future__ import annotations

import asyncio
import re
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Literal, cast
from uuid import UUID

from llm_tools import (
    BudgetState,
    EffectId,
    ExecutionContext,
    ExecutorConfigurationDefect,
    InvocationPosition,
    ParsedJson,
    PlanCatalogView,
    PositionState,
    Principal,
    ReplayPolicy,
    Reservation,
    RunLimits,
    Scope,
    Settlement,
    ToolEffect,
    ToolExecutor,
    ToolId,
    ToolResult,
    canonical_json_bytes,
    raw_input_digest,
)
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.async_session import open_async_session
from nexus.db.models import LLMCall, LLMToolPosition
from nexus.jobs.queue import JobExecutionContext, JobRow, get_job, lock_running_job_claim
from nexus.schemas.presence import Present
from nexus.services.durable_step_journal import stable_generation_id
from nexus.services.generation_spec import (
    GenerationSpec,
    generation_fact_digest,
)
from nexus.services.llm_ledger import (
    GenerationRecord,
    LlmCallOwner,
    lock_active_generation_for_authority_in_current_transaction,
)
from nexus.services.retrieval_citation import RetrievalCitation
from nexus.services.tool_runtime.catalog import FrozenToolOperation, freeze_tool_plan_snapshot

if TYPE_CHECKING:
    from nexus.services.artifacts.generation import DossierToolExecutionProjection
    from nexus.services.generation_backend import (
        BackendToolExecutionRequest,
        BackendToolExecutionResult,
    )
    from nexus.services.tool_runtime.chat_projection import ChatToolExecutionProjection

# A runtime import of either owner cycles back through this module; both are
# concrete classes, so the union stays exhaustive under pyright.
type ToolExecutionProjection = ChatToolExecutionProjection | DossierToolExecutionProjection

type ToolEffectMode = Literal["ReadOnly", "AdditiveWrites"]
type ToolReplayStatus = Literal["Prepared", "Uncertain", "Completed"]
type ToolTransportKind = Literal["ProviderApi"]

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_MAX_TRANSPORT_CALL_ID_BYTES = 1_024


class ToolAuthorityRefused(RuntimeError):
    """The live generation, lease, claim, or frozen authority no longer matches."""


class _LedgerModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class _ReservationDocument(_LedgerModel):
    """The ``reservation`` JSONB column this module solely writes."""

    accepted: bool
    calls: int = Field(ge=0)
    input_bytes: int = Field(ge=0)
    max_attempts: int = Field(ge=0)
    max_output_bytes: int = Field(ge=0)


class _DispatchClaimDocument(_LedgerModel):
    """The ``dispatch_claim`` JSONB column this module solely writes."""

    attempt_no: int = Field(ge=1)
    worker_id: str = Field(min_length=1)


@dataclass(frozen=True, slots=True)
class ToolPositionRecord:
    id: UUID
    generation_id: UUID
    generation_seq: int
    position: int
    transport_kind: ToolTransportKind
    model_turn_seq: int
    transport_call_id: str
    canonical_tool_id: str
    canonical_input_digest: str
    tool_contract_revision: str
    plan_revision: str
    binding_revision: str
    abandoned_attempts: int
    result_evidence: dict[str, object] | None
    effect_identity: dict[str, object] | None
    replay_status: ToolReplayStatus
    created_at: datetime
    completed_at: datetime | None

    @property
    def path(self) -> str:
        return f"generation/{self.generation_seq}/tool/{self.position}"


@dataclass(frozen=True, slots=True)
class ToolModelOutput:
    call_id: str
    output: str = field(repr=False)
    is_error: bool


@dataclass(frozen=True, slots=True)
class ModelToolExecutionResult:
    """Transport-neutral model result plus its optional durable tool position."""

    model_output: ToolModelOutput
    position: ToolPositionRecord | None


@dataclass(slots=True)
class ToolAuditProjection:
    """In-process audit view a handler stages for the terminal domain projection."""

    scope: str
    requested_types: list[str] = field(default_factory=list)
    filters: dict[str, Any] = field(default_factory=dict)
    citations: list[RetrievalCitation] = field(default_factory=list)
    selected_citations: list[RetrievalCitation] = field(default_factory=list)
    created_refs: list[dict[str, Any]] = field(default_factory=list)
    provider_request_ids: list[str] = field(default_factory=list)
    search_query_fingerprint: str | None = None
    latency_ms: int | None = None


@dataclass(frozen=True, slots=True)
class ToolAuthority:
    """Frozen plan/scope/budget authority fenced by one generation and job attempt."""

    session_factory: sessionmaker[Session] = field(repr=False, compare=False)
    user_id: UUID
    owner: LlmCallOwner
    generation_id: UUID
    generation_seq: int
    spec: GenerationSpec
    job_context: JobExecutionContext
    operation: FrozenToolOperation = field(repr=False, compare=False)
    effect_mode: ToolEffectMode
    admitted_resource_uris: frozenset[str]
    projection: ToolExecutionProjection | None = field(repr=False, compare=False)

    @classmethod
    async def from_claimed_generation_attempt(
        cls,
        *,
        session_factory: sessionmaker[Session],
        user_id: UUID,
        owner: LlmCallOwner,
        generation_id: UUID,
        job_context: JobExecutionContext,
        operation: FrozenToolOperation,
        projection: ToolExecutionProjection | None = None,
    ) -> ToolAuthority:
        """Bind executable handlers once to already-persisted semantic authority."""

        def bind(db: Session) -> ToolAuthority:
            with db.begin():
                generation, spec, job = _lock_authority(
                    db,
                    user_id=user_id,
                    owner=owner,
                    generation_id=generation_id,
                    job_context=job_context,
                    projection=projection,
                )
                plan, effect_mode, refs = _model_tool_facts(spec)
                if plan != freeze_tool_plan_snapshot(operation):
                    raise ToolAuthorityRefused("runtime operation differs from frozen plan")
                _assert_job_attempt(job, job_context)
            return cls(
                session_factory=session_factory,
                user_id=user_id,
                owner=owner,
                generation_id=generation_id,
                generation_seq=generation.generation_seq,
                spec=spec,
                job_context=job_context,
                operation=operation,
                effect_mode=effect_mode,
                admitted_resource_uris=refs,
                projection=projection,
            )

        async with open_async_session(session_factory) as database:
            return await database.run_sync(bind)

    def position_path(self, position: int) -> str:
        if position < 1:
            raise ValueError("tool position must be positive")
        return f"generation/{self.generation_seq}/tool/{position}"

    def lock_in_current_transaction(
        self,
        db: Session,
    ) -> tuple[GenerationRecord, GenerationSpec, JobRow]:
        """Re-fence the generation, projection owner, and worker lease."""

        generation, spec, job = _lock_authority(
            db,
            user_id=self.user_id,
            owner=self.owner,
            generation_id=self.generation_id,
            job_context=self.job_context,
            projection=self.projection,
        )
        if generation.generation_seq != self.generation_seq:
            raise ToolAuthorityRefused("generation sequence changed")
        if spec.fingerprint != self.spec.fingerprint:
            raise ToolAuthorityRefused("generation specification changed")
        _assert_job_attempt(job, self.job_context)
        return generation, spec, job

    async def prepare_position(
        self,
        *,
        transport_kind: ToolTransportKind,
        model_turn_seq: int,
        transport_call_id: str,
        tool_id: ToolId,
        input_digest: str,
        provider_wire_name: str,
        arguments: Mapping[str, object],
    ) -> ToolPositionRecord:
        """Replay or allocate one globally monotonic position before dispatch."""

        if model_turn_seq < 1:
            raise ValueError("model turn sequence must be positive")
        _validate_transport_call_id(transport_call_id)
        if not _SHA256_RE.fullmatch(input_digest):
            raise ValueError("tool input digest must be lowercase SHA-256")
        try:
            binding = self.operation.plan.catalog_view.binding(tool_id)
        except KeyError as error:
            raise ToolAuthorityRefused("tool is outside the frozen catalogue") from error
        plan = self.spec.model_tool_plan_snapshot
        if not isinstance(plan, Present) or not any(
            grant.id == str(tool_id) for grant in plan.value.grants
        ):
            raise ToolAuthorityRefused("tool is outside the frozen plan")

        def prepare(db: Session) -> ToolPositionRecord:
            with db.begin():
                generation, _spec, _job = self.lock_in_current_transaction(db)
                existing = db.scalar(
                    select(LLMToolPosition)
                    .where(
                        LLMToolPosition.generation_id == self.generation_id,
                        LLMToolPosition.transport_kind == transport_kind,
                        LLMToolPosition.model_turn_seq == model_turn_seq,
                        LLMToolPosition.transport_call_id == transport_call_id,
                    )
                    .with_for_update()
                )
                if existing is not None:
                    record = _position_record(existing, generation_seq=generation.generation_seq)
                    _assert_position_identity(
                        record,
                        tool_id=tool_id,
                        input_digest=input_digest,
                        binding_revision=binding.policy_revision,
                        tool_contract_revision=binding.spec.tool_contract_revision,
                        plan_revision=self.operation.plan.plan_revision,
                    )
                    return record
                next_position = db.scalar(
                    select(func.coalesce(func.max(LLMToolPosition.position), 0) + 1).where(
                        LLMToolPosition.generation_id == self.generation_id
                    )
                )
                if next_position is None:
                    raise AssertionError("tool position allocation returned no scalar")
                position = int(next_position)
                position_path = self.position_path(position)
                position_id = stable_generation_id(self.generation_id, position_path)
                effect_identity: dict[str, object] | None = None
                if binding.spec.effect is ToolEffect.Write:
                    effect_identity = {
                        "effect_id": str(position_id),
                        "generation_id": str(self.generation_id),
                        "position_path": position_path,
                    }
                row = LLMToolPosition(
                    id=position_id,
                    generation_id=self.generation_id,
                    position=position,
                    transport_kind=transport_kind,
                    model_turn_seq=model_turn_seq,
                    transport_call_id=transport_call_id,
                    canonical_tool_id=str(tool_id),
                    canonical_input_digest=input_digest,
                    tool_contract_revision=binding.spec.tool_contract_revision,
                    plan_revision=plan.value.plan_revision,
                    binding_revision=binding.policy_revision,
                    reservation=None,
                    dispatch_claim=None,
                    abandoned_attempts=0,
                    result_evidence=None,
                    effect_identity=effect_identity,
                    settlement=None,
                    replay_status="Prepared",
                )
                db.add(row)
                db.flush()
                record = _position_record(row, generation_seq=generation.generation_seq)
                if self.projection is not None:
                    self.projection.stage_started(
                        db,
                        authority=self,
                        position=record,
                        provider_wire_name=provider_wire_name,
                        arguments=arguments,
                    )
                return record

        async with open_async_session(self.session_factory) as database:
            return await database.run_sync(prepare)


class _PositionBudgetState:
    def __init__(self, recorder: ToolPositionRecorder, limits: RunLimits) -> None:
        self._recorder = recorder
        self._limits = limits
        self.deadline = 0.0

    @property
    def limits(self) -> RunLimits:
        return self._limits

    @property
    def remaining_elapsed_seconds(self) -> float:
        return max(0.0, self.deadline - time.monotonic())

    async def refresh(self) -> None:
        observed_at = time.monotonic()
        remaining = await self._recorder.database.run_sync(self._remaining_at_database_clock)
        self.deadline = observed_at + remaining

    def _remaining_at_database_clock(self, db: Session) -> float:
        with db.begin():
            _generation, _spec, job = self._recorder.authority.lock_in_current_transaction(db)
            database_now = db.scalar(func.clock_timestamp())
            if not isinstance(database_now, datetime):
                raise AssertionError("database clock did not return a timestamp")
            started_at = job.started_at or job.created_at
            if started_at.tzinfo is None:
                started_at = started_at.replace(tzinfo=UTC)
            elapsed = (database_now - started_at).total_seconds()
        return max(0.0, float(self._limits.max_elapsed_seconds) - elapsed)

    async def reserve(self, position: InvocationPosition, reservation: Reservation) -> bool:
        del position
        return await self._recorder.budget_accepts(reservation)

    async def settle(self, position: InvocationPosition, settlement: Settlement) -> None:
        del position
        _validate_settlement(settlement)


class ToolPositionRecorder:
    """Portable ``ToolExecutor`` recorder backed only by ``llm_tool_positions``."""

    def __init__(
        self,
        *,
        db: AsyncSession,
        authority: ToolAuthority,
        position: ToolPositionRecord,
    ) -> None:
        self.database = db
        self.db = db.sync_session
        self.authority = authority
        self.position_record = position
        self.position = InvocationPosition(position.path)
        self.catalog_view: PlanCatalogView = authority.operation.plan.catalog_view
        self.max_live_writes = authority.operation.definition.max_live_writes
        self.audit = ToolAuditProjection(scope="conversation_context")
        self.budgets = _PositionBudgetState(self, authority.operation.profile.run_limits)

    @property
    def durable(self) -> bool:
        return True

    @property
    def principal_id(self) -> UUID:
        return self.authority.user_id

    @property
    def admitted_resource_uris(self) -> frozenset[str]:
        return self.authority.admitted_resource_uris

    def stage_audit(self, audit: ToolAuditProjection) -> None:
        self.audit = audit

    def live_write_count(self, db: Session) -> int:
        projection = self.authority.projection
        count = projection.live_write_count(db, authority=self.authority) if projection else None
        if count is None:
            raise ExecutorConfigurationDefect(
                "write-capable tool plan has no projection owning reverted writes"
            )
        return count

    def authorize_effect_in_current_transaction(self, db: Session) -> None:
        self.authority.lock_in_current_transaction(db)

    async def occupy(
        self,
        *,
        position: InvocationPosition,
        tool_id: ToolId,
        tool_contract_revision: str,
        policy_revision: str,
        plan_revision: str,
        input_digest: str,
        replay_policy: ReplayPolicy,
    ) -> PositionState:
        del position

        def operation(_db: Session) -> PositionState:
            with self.db.begin():
                self.authority.lock_in_current_transaction(self.db)
                row = self._lock_row()
                record = _position_record(row, generation_seq=self.authority.generation_seq)
                _assert_position_identity(
                    record,
                    tool_id=tool_id,
                    input_digest=input_digest,
                    binding_revision=policy_revision,
                    tool_contract_revision=tool_contract_revision,
                    plan_revision=plan_revision,
                )
                if (
                    record.replay_status == "Uncertain"
                    and replay_policy is ReplayPolicy.ReDispatchable
                    and _dispatch_claim(row).attempt_no < self.authority.job_context.attempt_no
                ):
                    row.replay_status = "Prepared"
                    row.dispatch_claim = None
                    self.db.flush()
                    record = _position_record(row, generation_seq=self.authority.generation_seq)
                self.position_record = record
                return _portable_position_state(row, record)

        return await self.database.run_sync(operation)

    async def reserve(
        self,
        *,
        position: InvocationPosition,
        budgets: BudgetState,
        reservation: Reservation,
    ) -> bool:
        del position, budgets

        def operation(_db: Session) -> bool:
            with self.db.begin():
                self.authority.lock_in_current_transaction(self.db)
                row = self._lock_row()
                if row.reservation is not None:
                    stored = _reservation(row)
                    if (
                        stored.calls,
                        stored.input_bytes,
                        stored.max_attempts,
                        stored.max_output_bytes,
                    ) != (
                        reservation.calls,
                        reservation.input_bytes,
                        reservation.max_attempts,
                        reservation.max_output_bytes,
                    ):
                        raise ValueError("durable tool budget reservation changed")
                    return stored.accepted
                if row.replay_status != "Prepared":
                    raise ValueError("only a prepared tool position may reserve budget")
                accepted = self._budget_accepts_in_current_transaction(self.db, reservation)
                row.reservation = _ReservationDocument(
                    accepted=accepted,
                    calls=reservation.calls,
                    input_bytes=reservation.input_bytes,
                    max_attempts=reservation.max_attempts,
                    max_output_bytes=reservation.max_output_bytes,
                ).model_dump(mode="json")
                self.db.flush()
                return accepted

        return await self.database.run_sync(operation)

    async def dispatch_started(
        self,
        *,
        position: InvocationPosition,
        replay_policy: ReplayPolicy,
    ) -> PositionState:
        del position

        def operation(_db: Session) -> PositionState:
            with self.db.begin():
                self.authority.lock_in_current_transaction(self.db)
                row = self._lock_row()
                record = _position_record(row, generation_seq=self.authority.generation_seq)
                if record.replay_status in {"Completed", "Uncertain"}:
                    return _portable_position_state(row, record)
                if not _reservation(row).accepted:
                    raise ValueError("dispatch requires an accepted reservation")
                binding = self.catalog_view.binding(ToolId(record.canonical_tool_id))
                if binding.replay_policy is not replay_policy:
                    raise ValueError("durable tool replay policy changed")
                row.dispatch_claim = _DispatchClaimDocument(
                    attempt_no=self.authority.job_context.attempt_no,
                    worker_id=self.authority.job_context.worker_id,
                ).model_dump(mode="json")
                row.replay_status = "Uncertain"
                self.db.flush()
                self.position_record = _position_record(
                    row,
                    generation_seq=self.authority.generation_seq,
                )
                return PositionState(
                    terminal_result=None,
                    uncertain=False,
                    actual_attempts=row.abandoned_attempts,
                )

        return await self.database.run_sync(operation)

    async def dispatch_abandoned(
        self,
        *,
        position: InvocationPosition,
        replay_policy: ReplayPolicy,
        actual_attempts: int,
        lease_recovered: bool,
    ) -> None:
        del position

        def operation(_db: Session) -> None:
            if replay_policy is not ReplayPolicy.ReDispatchable or not lease_recovered:
                raise ValueError("only verified ReDispatchable work may be re-admitted")
            with self.db.begin():
                self.authority.lock_in_current_transaction(self.db)
                row = self._lock_row()
                if row.replay_status != "Uncertain":
                    raise ValueError("only uncertain tool work may be abandoned")
                _dispatch_claim(row)
                if actual_attempts < row.abandoned_attempts:
                    raise ValueError("abandoned tool attempt accounting moved backwards")
                row.abandoned_attempts = actual_attempts
                row.dispatch_claim = None
                row.replay_status = "Prepared"

        return await self.database.run_sync(operation)

    async def uncertain(self, *, position: InvocationPosition) -> None:
        del position

        def operation(_db: Session) -> None:
            with self.db.begin():
                self.authority.lock_in_current_transaction(self.db)
                if self._lock_row().replay_status != "Uncertain":
                    raise ValueError("only dispatched tool work may remain uncertain")

        return await self.database.run_sync(operation)

    async def terminalize_and_settle(
        self,
        *,
        position: InvocationPosition,
        budgets: BudgetState,
        result: ToolResult,
        settlement: Settlement,
    ) -> ToolResult:
        del position, budgets

        def operation(_db: Session) -> ToolResult:
            evidence = {"tool_result": cast(object, result)}
            try:
                self.authority.lock_in_current_transaction(self.db)
                row = self._lock_row()
                record = _position_record(row, generation_seq=self.authority.generation_seq)
                if record.replay_status == "Completed":
                    if record.result_evidence != evidence:
                        raise ValueError("terminal result differs from completed durable position")
                    self.position_record = record
                    self.db.commit()
                    return result
                reservation = _reservation(row)
                stored = (
                    settlement
                    if reservation.accepted
                    else Settlement(actual_attempts=0, actual_output_bytes=0)
                )
                _validate_settlement(stored)
                if (
                    stored.actual_attempts < row.abandoned_attempts
                    or stored.actual_attempts > reservation.max_attempts
                    or stored.actual_output_bytes > reservation.max_output_bytes
                ):
                    raise ValueError("durable tool settlement exceeds its reservation")
                row.result_evidence = evidence
                row.settlement = {
                    "actual_attempts": stored.actual_attempts,
                    "actual_output_bytes": stored.actual_output_bytes,
                }
                row.replay_status = "Completed"
                row.completed_at = func.now()
                self.db.flush()
                record = _position_record(row, generation_seq=self.authority.generation_seq)
                if self.authority.projection is not None:
                    self.authority.projection.stage_terminal(
                        self.db,
                        authority=self.authority,
                        position=record,
                        result=result,
                        audit=self.audit,
                    )
                self.position_record = record
                # Handler-owned domain effects, the canonical terminal receipt, and
                # any optional projection become visible atomically.
                self.db.commit()
            except BaseException:
                self.db.rollback()
                raise
            return result

        return await self.database.run_sync(operation)

    async def budget_accepts(self, reservation: Reservation) -> bool:
        def operation(_db: Session) -> bool:
            with self.db.begin():
                self.authority.lock_in_current_transaction(self.db)
                return self._budget_accepts_in_current_transaction(self.db, reservation)

        return await self.database.run_sync(operation)

    async def render_output(self, result: ToolResult) -> str:
        def operation(_db: Session) -> str:
            if self.db.in_transaction():
                raise RuntimeError("tool output rendering requires a committed terminal phase")
            with self.db.begin():
                row = self._lock_row()
                record = _position_record(row, generation_seq=self.authority.generation_seq)
                if record.replay_status != "Completed" or record.result_evidence != {
                    "tool_result": cast(object, result)
                }:
                    raise ValueError("model output requires the completed durable tool result")
                projection = self.authority.projection
                if projection is None:
                    return canonical_json_bytes(result).decode("utf-8")
                return projection.render_output(
                    self.db,
                    authority=self.authority,
                    position=record,
                    result=result,
                )

        return await self.database.run_sync(operation)

    def _lock_row(self) -> LLMToolPosition:
        row = self.db.scalar(
            select(LLMToolPosition)
            .where(
                LLMToolPosition.generation_id == self.authority.generation_id,
                LLMToolPosition.position == self.position_record.position,
            )
            .with_for_update()
        )
        if row is None:
            raise ToolAuthorityRefused("tool position does not exist")
        return row

    def _budget_accepts_in_current_transaction(
        self,
        db: Session,
        reservation: Reservation,
    ) -> bool:
        limits = self.authority.operation.profile.run_limits
        rows = db.scalars(
            select(LLMToolPosition).where(
                LLMToolPosition.generation_id == self.authority.generation_id
            )
        ).all()
        accepted = [
            document
            for row in rows
            if row.reservation is not None and (document := _reservation(row)).accepted
        ]
        in_flight = sum(1 for row in rows if row.replay_status == "Uncertain")
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


class _AuthorityCancellation:
    def __init__(self, authority: ToolAuthority) -> None:
        self._authority = authority
        self._cancelled = False

    @property
    def cancelled(self) -> bool:
        return self._cancelled

    async def refresh(self, database: AsyncSession) -> None:
        def check(db: Session) -> None:
            with db.begin():
                self._authority.lock_in_current_transaction(db)

        try:
            await database.run_sync(check)
        except ToolAuthorityRefused:
            self._cancelled = True


class _ToolTelemetry:
    def event(self, name: str, attributes: dict[str, Any]) -> None:
        del name, attributes


@dataclass(frozen=True, slots=True)
class GenerationToolExecutor:
    """Execute admitted Provider API tool proposals."""

    authority: ToolAuthority

    async def execute(
        self,
        request: BackendToolExecutionRequest,
    ) -> BackendToolExecutionResult:
        from provider_runtime.tool_adapter import (
            CanonicalToolCall,
            RejectedToolArguments,
            RejectedToolCall,
        )

        from nexus.services.generation_backend import BackendToolExecutionResult

        if request.generation_id != self.authority.generation_id:
            raise ToolAuthorityRefused("provider proposal names a different generation")
        proposal = request.proposal
        if isinstance(proposal, CanonicalToolCall):
            result = await self.execute_canonical(
                transport_kind="ProviderApi",
                model_turn_seq=request.child_seq,
                transport_call_id=proposal.provider_call_id,
                provider_wire_name=str(proposal.tool_id),
                tool_id=proposal.tool_id,
                arguments=proposal.arguments,
            )
        elif isinstance(proposal, RejectedToolArguments):
            result = await self.refuse_known_call(
                transport_kind="ProviderApi",
                model_turn_seq=request.child_seq,
                transport_call_id=proposal.provider_call_id,
                provider_wire_name=str(proposal.tool_id),
                tool_id=proposal.tool_id,
                reason=proposal.reason,
            )
        elif isinstance(proposal, RejectedToolCall):
            result = self.refuse_unknown_call(transport_call_id=proposal.provider_call_id)
        else:
            raise TypeError("provider proposal has an unknown closed variant")
        return BackendToolExecutionResult(
            provider_call_id=result.model_output.call_id,
            output=result.model_output.output,
            is_error=result.model_output.is_error,
        )

    async def execute_canonical(
        self,
        *,
        transport_kind: ToolTransportKind,
        model_turn_seq: int,
        transport_call_id: str,
        provider_wire_name: str,
        tool_id: ToolId,
        arguments: Mapping[str, object],
    ) -> ModelToolExecutionResult:
        raw = ParsedJson(dict(arguments))
        record = await self.authority.prepare_position(
            transport_kind=transport_kind,
            model_turn_seq=model_turn_seq,
            transport_call_id=transport_call_id,
            tool_id=tool_id,
            input_digest=raw_input_digest(raw),
            provider_wire_name=provider_wire_name,
            arguments=arguments,
        )
        async with open_async_session(self.authority.session_factory) as db:
            recorder = ToolPositionRecorder(db=db, authority=self.authority, position=record)
            await recorder.budgets.refresh()
            cancellation = _AuthorityCancellation(self.authority)
            await cancellation.refresh(db)
            binding = self.authority.operation.plan.catalog_view.binding(tool_id)
            effect_id = None
            if binding.spec.effect is ToolEffect.Write:
                identity = record.effect_identity
                if identity is None or not isinstance(identity.get("effect_id"), str):
                    raise AssertionError("write tool position lacks its stable effect identity")
                effect_id = EffectId(cast(str, identity["effect_id"]))
            projection = self.authority.projection
            context = ExecutionContext(
                plan=self.authority.operation.plan,
                grant=self.authority.operation.plan.grant(tool_id),
                catalog_view=self.authority.operation.plan.catalog_view,
                position=recorder.position,
                recorder=recorder,
                effect_id=effect_id,
                budgets=recorder.budgets,
                principal=Principal(str(self.authority.user_id)),
                scope=Scope(projection.scope_label if projection else "generation_scope"),
                cancellation=cancellation,
                telemetry=_ToolTelemetry(),
            )
            result = await ToolExecutor.execute(binding, raw, context)
            return ModelToolExecutionResult(
                model_output=ToolModelOutput(
                    call_id=transport_call_id,
                    output=await recorder.render_output(result),
                    is_error=result["type"] == "Failure",
                ),
                position=recorder.position_record,
            )

    async def refuse_known_call(
        self,
        *,
        transport_kind: ToolTransportKind,
        model_turn_seq: int,
        transport_call_id: str,
        provider_wire_name: str,
        tool_id: ToolId,
        reason: Literal["InvalidJson", "InputTooLarge"],
    ) -> ModelToolExecutionResult:
        record = await self.authority.prepare_position(
            transport_kind=transport_kind,
            model_turn_seq=model_turn_seq,
            transport_call_id=transport_call_id,
            tool_id=tool_id,
            input_digest=generation_fact_digest(
                {"kind": "RejectedToolArguments", "reason": reason}
            ),
            provider_wire_name=provider_wire_name,
            arguments={"refusal": reason},
        )
        async with open_async_session(self.authority.session_factory) as db:
            recorder = ToolPositionRecorder(db=db, authority=self.authority, position=record)
            result: ToolResult = {
                "type": "Failure",
                "error": {"type": "InvalidInput" if reason == "InvalidJson" else "BudgetExceeded"},
            }
            limits = self.authority.operation.plan.grant(tool_id).limits
            await recorder.reserve(
                position=recorder.position,
                budgets=recorder.budgets,
                reservation=Reservation(
                    calls=1,
                    input_bytes=0,
                    max_attempts=limits.max_attempts,
                    max_output_bytes=limits.max_output_bytes,
                ),
            )
            await recorder.terminalize_and_settle(
                position=recorder.position,
                budgets=recorder.budgets,
                result=result,
                settlement=Settlement(actual_attempts=0, actual_output_bytes=0),
            )
            return ModelToolExecutionResult(
                model_output=ToolModelOutput(
                    call_id=transport_call_id,
                    output=await recorder.render_output(result),
                    is_error=True,
                ),
                position=recorder.position_record,
            )

    def refuse_unknown_call(self, *, transport_call_id: str) -> ModelToolExecutionResult:
        """Answer an unpublished provider tool name as an error result so the model
        self-corrects; an unresolvable name has no canonical position to record."""
        _validate_transport_call_id(transport_call_id)
        result: ToolResult = {"type": "Failure", "error": {"type": "ToolUnavailable"}}
        return ModelToolExecutionResult(
            model_output=ToolModelOutput(
                call_id=transport_call_id,
                output=canonical_json_bytes(result).decode("utf-8"),
                is_error=True,
            ),
            position=None,
        )


@dataclass(slots=True)
class DeferredGenerationToolExecutor:
    """Provider-facing handle that opens authority after parent dispatch is armed."""

    session_factory: sessionmaker[Session] = field(repr=False, compare=False)
    user_id: UUID
    owner: LlmCallOwner
    generation_id: UUID
    job_context: JobExecutionContext
    operation: FrozenToolOperation = field(repr=False, compare=False)
    projection: ToolExecutionProjection | None = field(default=None, repr=False, compare=False)
    _executor: GenerationToolExecutor | None = field(default=None, init=False, repr=False)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False, repr=False)

    async def open(self) -> GenerationToolExecutor:
        async with self._lock:
            if self._executor is None:
                self._executor = GenerationToolExecutor(
                    authority=await ToolAuthority.from_claimed_generation_attempt(
                        session_factory=self.session_factory,
                        user_id=self.user_id,
                        owner=self.owner,
                        generation_id=self.generation_id,
                        job_context=self.job_context,
                        operation=self.operation,
                        projection=self.projection,
                    )
                )
            return self._executor

    async def execute(
        self,
        request: BackendToolExecutionRequest,
    ) -> BackendToolExecutionResult:
        executor = await self.open()
        return await executor.execute(request)


def read_tool_positions(db: Session, *, generation_id: UUID) -> tuple[ToolPositionRecord, ...]:
    generation = db.get(LLMCall, generation_id)
    if generation is None:
        return ()
    rows = db.scalars(
        select(LLMToolPosition)
        .where(LLMToolPosition.generation_id == generation_id)
        .order_by(LLMToolPosition.position)
    ).all()
    return tuple(_position_record(row, generation_seq=generation.generation_seq) for row in rows)


def _lock_authority(
    db: Session,
    *,
    user_id: UUID,
    owner: LlmCallOwner,
    generation_id: UUID,
    job_context: JobExecutionContext,
    projection: ToolExecutionProjection | None,
) -> tuple[GenerationRecord, GenerationSpec, JobRow]:
    generation = lock_active_generation_for_authority_in_current_transaction(
        db,
        owner=owner,
        generation_id=generation_id,
    )
    if generation is None:
        raise ToolAuthorityRefused("generation is absent or terminal")
    spec = generation.spec
    if projection is not None:
        projection.lock_owner(db, user_id=user_id, owner=owner)
    if not lock_running_job_claim(db, context=job_context):
        raise ToolAuthorityRefused("worker lease is absent or expired")
    job = get_job(db, job_context.job_id)
    if job is None:
        raise ToolAuthorityRefused("worker job disappeared")
    return generation, spec, job


def _model_tool_facts(spec: GenerationSpec) -> tuple[object, ToolEffectMode, frozenset[str]]:
    plan = spec.model_tool_plan_snapshot
    effect = spec.tool_effect_mode
    scope = spec.admitted_tool_scope
    if not all(isinstance(value, Present) for value in (plan, effect, scope)):
        raise ToolAuthorityRefused("NoModelTools generation cannot acquire tool authority")
    assert isinstance(plan, Present)
    assert isinstance(effect, Present)
    assert isinstance(scope, Present)
    return plan.value, effect.value, frozenset(scope.value.admitted_refs)


def _assert_job_attempt(job: JobRow, context: JobExecutionContext) -> None:
    if (
        job.id != context.job_id
        or job.status != "running"
        or job.claimed_by != context.worker_id
        or job.attempts != context.attempt_no
    ):
        raise ToolAuthorityRefused("job differs from the claimed worker attempt")


def _validate_transport_call_id(value: str) -> None:
    if not value or len(value.encode("utf-8")) > _MAX_TRANSPORT_CALL_ID_BYTES:
        raise ValueError("transport call id must be bounded nonblank text")


def _validate_settlement(settlement: Settlement) -> None:
    if settlement.actual_attempts < 0 or settlement.actual_output_bytes < 0:
        raise ValueError("tool settlement cannot be negative")


def _assert_position_identity(
    record: ToolPositionRecord,
    *,
    tool_id: ToolId,
    input_digest: str,
    binding_revision: str,
    tool_contract_revision: str,
    plan_revision: str,
) -> None:
    if (
        record.canonical_tool_id != str(tool_id)
        or record.canonical_input_digest != input_digest
        or record.tool_contract_revision != tool_contract_revision
        or record.binding_revision != binding_revision
        or record.plan_revision != plan_revision
    ):
        raise ValueError("transport call identity was reused with different authority")


def _position_record(row: LLMToolPosition, *, generation_seq: int) -> ToolPositionRecord:
    if row.replay_status not in {"Prepared", "Uncertain", "Completed"}:
        raise AssertionError("persisted tool position has an unknown replay status")
    if row.transport_kind != "ProviderApi":
        raise AssertionError("persisted tool position has an unknown transport")
    return ToolPositionRecord(
        id=row.id,
        generation_id=row.generation_id,
        generation_seq=generation_seq,
        position=row.position,
        transport_kind=cast(ToolTransportKind, row.transport_kind),
        model_turn_seq=row.model_turn_seq,
        transport_call_id=row.transport_call_id,
        canonical_tool_id=row.canonical_tool_id,
        canonical_input_digest=row.canonical_input_digest,
        tool_contract_revision=row.tool_contract_revision,
        plan_revision=row.plan_revision,
        binding_revision=row.binding_revision,
        abandoned_attempts=row.abandoned_attempts,
        result_evidence=cast(dict[str, object] | None, row.result_evidence),
        effect_identity=cast(dict[str, object] | None, row.effect_identity),
        replay_status=cast(ToolReplayStatus, row.replay_status),
        created_at=row.created_at,
        completed_at=row.completed_at,
    )


def _portable_position_state(row: LLMToolPosition, record: ToolPositionRecord) -> PositionState:
    attempts = record.abandoned_attempts
    settlement = row.settlement
    if isinstance(settlement, dict) and isinstance(settlement.get("actual_attempts"), int):
        attempts = cast(int, settlement["actual_attempts"])
    return PositionState(
        terminal_result=(
            cast(ToolResult, record.result_evidence["tool_result"])
            if record.result_evidence is not None
            else None
        ),
        uncertain=record.replay_status == "Uncertain",
        actual_attempts=attempts,
    )


def _reservation(row: LLMToolPosition) -> _ReservationDocument:
    return _ReservationDocument.model_validate(row.reservation)


def _dispatch_claim(row: LLMToolPosition) -> _DispatchClaimDocument:
    return _DispatchClaimDocument.model_validate(row.dispatch_claim)


__all__ = [
    "DeferredGenerationToolExecutor",
    "GenerationToolExecutor",
    "ModelToolExecutionResult",
    "ToolAuditProjection",
    "ToolAuthority",
    "ToolAuthorityRefused",
    "ToolEffectMode",
    "ToolExecutionProjection",
    "ToolModelOutput",
    "ToolPositionRecord",
    "ToolPositionRecorder",
    "ToolReplayStatus",
    "ToolTransportKind",
    "read_tool_positions",
]
