"""One route-neutral authority, executor, and durable model-tool position ledger."""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Literal, Protocol, cast
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
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.async_session import open_async_session
from nexus.db.models import LLMCall, LLMToolPosition
from nexus.jobs.queue import JobExecutionContext, JobRow, get_job, lock_running_job_claim
from nexus.schemas.presence import Present
from nexus.services.agent_tool_grants import (
    AgentToolGrantClaims,
    GenerationToolGrantAuthority,
)
from nexus.services.durable_step_journal import stable_generation_id
from nexus.services.generation_spec import (
    GenerationSpec,
    decode_generation_spec_document,
    generation_fact_digest,
)
from nexus.services.llm_ledger import (
    GenerationRecord,
    LlmCallOwner,
    lock_active_generation_for_authority_in_current_transaction,
)
from nexus.services.tool_runtime.composition import (
    FrozenToolOperation,
    freeze_tool_plan_snapshot,
)

if TYPE_CHECKING:
    from nexus.services.generation_backend import (
        BackendToolExecutionRequest,
        BackendToolExecutionResult,
    )

type ToolEffectMode = Literal["ReadOnly", "AdditiveWrites"]
type ToolReplayStatus = Literal["Prepared", "Uncertain", "Completed"]
type ToolTransportKind = Literal["CodexMcp", "ProviderApi"]

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_MAX_TRANSPORT_CALL_ID_BYTES = 1_024


class ToolAuthorityRefused(RuntimeError):
    """The live generation, lease, claim, or frozen authority no longer matches."""


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
    scope_digest: str
    budget_digest: str
    reservation: dict[str, object] | None
    dispatch_claim: dict[str, object] | None
    abandoned_attempts: int
    result_evidence: dict[str, object] | None
    effect_identity: dict[str, object] | None
    settlement: dict[str, object] | None
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


class ToolExecutionProjection(Protocol):
    """Optional domain view below the canonical authority and position ledger."""

    @property
    def scope_label(self) -> str: ...

    def lock_owner(
        self,
        db: Session,
        *,
        user_id: UUID,
        owner: LlmCallOwner,
    ) -> None: ...

    def stage_started(
        self,
        db: Session,
        *,
        authority: ToolAuthority,
        position: ToolPositionRecord,
        provider_wire_name: str,
        arguments: Mapping[str, object],
    ) -> None: ...

    def stage_terminal(
        self,
        db: Session,
        *,
        authority: ToolAuthority,
        position: ToolPositionRecord,
        result: ToolResult,
        audit: Mapping[str, object],
    ) -> None: ...

    def render_output(
        self,
        db: Session,
        *,
        authority: ToolAuthority,
        position: ToolPositionRecord,
        result: ToolResult,
    ) -> str: ...

    def live_write_count(
        self,
        db: Session,
        *,
        authority: ToolAuthority,
    ) -> int | None: ...


@dataclass(frozen=True, slots=True)
class _NoToolExecutionProjection:
    @property
    def scope_label(self) -> str:
        return "generation_scope"

    def lock_owner(
        self,
        db: Session,
        *,
        user_id: UUID,
        owner: LlmCallOwner,
    ) -> None:
        del db, user_id, owner

    def stage_started(
        self,
        db: Session,
        *,
        authority: ToolAuthority,
        position: ToolPositionRecord,
        provider_wire_name: str,
        arguments: Mapping[str, object],
    ) -> None:
        del db, authority, position, provider_wire_name, arguments

    def stage_terminal(
        self,
        db: Session,
        *,
        authority: ToolAuthority,
        position: ToolPositionRecord,
        result: ToolResult,
        audit: Mapping[str, object],
    ) -> None:
        del db, authority, position, result, audit

    def render_output(
        self,
        db: Session,
        *,
        authority: ToolAuthority,
        position: ToolPositionRecord,
        result: ToolResult,
    ) -> str:
        del db, authority, position
        return canonical_json_bytes(result).decode("utf-8")

    def live_write_count(
        self,
        db: Session,
        *,
        authority: ToolAuthority,
    ) -> int | None:
        del db, authority
        return None


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
    binding_revisions_digest: str
    budget_digest: str
    projection: ToolExecutionProjection = field(repr=False, compare=False)

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

        selected_projection: ToolExecutionProjection = projection or _NoToolExecutionProjection()

        def bind(db: Session) -> ToolAuthority:
            with db.begin():
                generation, spec, job = _lock_authority(
                    db,
                    user_id=user_id,
                    owner=owner,
                    generation_id=generation_id,
                    job_context=job_context,
                    projection=selected_projection,
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
                binding_revisions_digest=tool_binding_revisions_digest(plan),
                budget_digest=tool_budget_digest(plan, effect_mode=effect_mode),
                projection=selected_projection,
            )

        async with open_async_session(session_factory) as database:
            return await database.run_sync(bind)

    @property
    def scope_digest(self) -> str:
        scope = self.spec.admitted_tool_scope
        if not isinstance(scope, Present):
            raise AssertionError("tool authority lost its admitted scope")
        return generation_fact_digest(scope.value.model_dump(mode="json"))

    def position_path(self, position: int) -> str:
        if position < 1:
            raise ValueError("tool position must be positive")
        return f"generation/{self.generation_seq}/tool/{position}"

    def grant_authority(self) -> GenerationToolGrantAuthority:
        plan = self.spec.model_tool_plan_snapshot
        if not isinstance(plan, Present):
            raise AssertionError("tool authority lost its frozen plan")
        return GenerationToolGrantAuthority(
            user_id=self.user_id,
            generation_id=self.generation_id,
            job_id=self.job_context.job_id,
            worker_id=self.job_context.worker_id,
            attempt_no=self.job_context.attempt_no,
            generation_spec_fingerprint=self.spec.fingerprint,
            tool_plan_revision=plan.value.plan_revision,
            binding_revisions_digest=self.binding_revisions_digest,
            tool_scope_digest=self.scope_digest,
            tool_budget_digest=self.budget_digest,
            effect_mode=self.effect_mode,
        )

    def authorize_in_current_transaction(
        self,
        db: Session,
        claims: AgentToolGrantClaims,
    ) -> tuple[GenerationRecord, JobRow]:
        generation, spec, job = self._lock(db)
        expected = self.grant_authority()
        if (
            spec.fingerprint != self.spec.fingerprint
            or claims.sub != str(expected.user_id)
            or claims.generation_id != str(expected.generation_id)
            or claims.job_id != str(expected.job_id)
            or claims.worker_id != expected.worker_id
            or claims.attempt_no != expected.attempt_no
            or claims.generation_spec_fingerprint != expected.generation_spec_fingerprint
            or claims.tool_plan_revision != expected.tool_plan_revision
            or claims.binding_revisions_digest != expected.binding_revisions_digest
            or claims.tool_scope_digest != expected.tool_scope_digest
            or claims.tool_budget_digest != expected.tool_budget_digest
            or claims.effect_mode != expected.effect_mode
        ):
            raise ToolAuthorityRefused("bearer differs from frozen generation authority")
        return generation, job

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

        _validate_transport_identity(
            transport_kind=transport_kind,
            model_turn_seq=model_turn_seq,
            transport_call_id=transport_call_id,
        )
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
                generation, _spec, _job = self._lock(db)
                from nexus.services.tool_runtime.resource_scope import (
                    tool_arguments_within_admitted_scope,
                )

                if not tool_arguments_within_admitted_scope(
                    db,
                    tool_id=str(tool_id),
                    arguments=arguments,
                    admitted_resource_uris=self.admitted_resource_uris,
                ):
                    raise ToolAuthorityRefused("tool arguments widen the frozen resource scope")
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
                        authority=self,
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
                    scope_digest=self.scope_digest,
                    budget_digest=self.budget_digest,
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

    def read_positions(self, db: Session) -> tuple[ToolPositionRecord, ...]:
        rows = db.scalars(
            select(LLMToolPosition)
            .where(LLMToolPosition.generation_id == self.generation_id)
            .order_by(LLMToolPosition.position)
        ).all()
        return tuple(_position_record(row, generation_seq=self.generation_seq) for row in rows)

    def _lock(self, db: Session) -> tuple[GenerationRecord, GenerationSpec, JobRow]:
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
        if db.in_transaction():
            raise RuntimeError("tool budget clock requires a closed prior phase")
        with db.begin():
            _generation, _spec, job = self._recorder.authority._lock(db)
            database_now = db.scalar(func.clock_timestamp())
            if not isinstance(database_now, datetime):
                raise AssertionError("database clock did not return a timestamp")
            started_at = job.started_at or job.created_at
            if started_at.tzinfo is None:
                started_at = started_at.replace(tzinfo=UTC)
            elapsed = (database_now - started_at).total_seconds()
        return max(0.0, float(self._limits.max_elapsed_seconds) - elapsed)

    async def reserve(self, position: InvocationPosition, reservation: Reservation) -> bool:
        return await self._recorder.budget_accepts(position, reservation)

    async def settle(self, position: InvocationPosition, settlement: Settlement) -> None:
        self._recorder.validate_settlement(position, settlement)


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
        self.audit: dict[str, object] = {}
        self.budgets = _PositionBudgetState(
            self,
            authority.operation.profile.run_limits,
        )

    @property
    def durable(self) -> bool:
        return True

    @property
    def principal_id(self) -> UUID:
        return self.authority.user_id

    @property
    def admitted_resource_uris(self) -> frozenset[str]:
        return self.authority.admitted_resource_uris

    def stage_audit(self, **values: object) -> None:
        # The audit projection is an in-process downstream view.  Its values may
        # include typed citation records; only the canonical tool result and
        # position evidence cross the durable JSON boundary below.
        self.audit = dict(values)

    def live_write_count(self, db: Session) -> int:
        projected = self.authority.projection.live_write_count(db, authority=self.authority)
        if projected is None:
            raise ExecutorConfigurationDefect(
                "write-capable tool plan has no projection owning reverted writes"
            )
        return projected

    def authorize_effect_in_current_transaction(self, db: Session) -> None:
        self.authority._lock(db)

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
        def operation(_db: Session) -> PositionState:
            self._check_position(position)
            if self.db.in_transaction():
                raise RuntimeError("tool occupy requires a closed prior phase")
            with self.db.begin():
                self.authority._lock(self.db)
                row = _lock_position(
                    self.db,
                    self.authority.generation_id,
                    self.position_record.position,
                )
                record = _position_record(row, generation_seq=self.authority.generation_seq)
                _assert_position_identity(
                    record,
                    tool_id=tool_id,
                    input_digest=input_digest,
                    binding_revision=policy_revision,
                    tool_contract_revision=tool_contract_revision,
                    authority=self.authority,
                )
                if record.plan_revision != plan_revision:
                    raise ValueError("tool position plan revision changed")
                if (
                    record.replay_status == "Uncertain"
                    and replay_policy is ReplayPolicy.ReDispatchable
                ):
                    claim = _dispatch_claim(record)
                    if cast(int, claim["attempt_no"]) < self.authority.job_context.attempt_no:
                        row.replay_status = "Prepared"
                        row.dispatch_claim = None
                        self.db.flush()
                        record = _position_record(row, generation_seq=self.authority.generation_seq)
                self.position_record = record
                return _portable_position_state(record)

        return await self.database.run_sync(operation)

    async def reserve(
        self,
        *,
        position: InvocationPosition,
        budgets: BudgetState,
        reservation: Reservation,
    ) -> bool:
        def operation(_db: Session) -> bool:
            self._check_position(position)
            if budgets is not self.budgets:
                raise ValueError("position used a different durable budget owner")
            if self.db.in_transaction():
                raise RuntimeError("tool reservation requires a closed prior phase")
            with self.db.begin():
                self.authority._lock(self.db)
                row = _lock_position(
                    self.db,
                    self.authority.generation_id,
                    self.position_record.position,
                )
                requested = _reservation_document(reservation, accepted=False)
                if row.reservation is not None:
                    stored = _reservation(row)
                    if any(stored[key] != requested[key] for key in requested if key != "accepted"):
                        raise ValueError("durable tool budget reservation changed")
                    return cast(bool, stored["accepted"])
                if row.replay_status != "Prepared":
                    raise ValueError("only a prepared tool position may reserve budget")
                accepted = self._budget_accepts_in_current_transaction(self.db, reservation)
                row.reservation = _reservation_document(reservation, accepted=accepted)
                self.db.flush()
                return accepted

        return await self.database.run_sync(operation)

    async def dispatch_started(
        self,
        *,
        position: InvocationPosition,
        replay_policy: ReplayPolicy,
    ) -> PositionState:
        def operation(_db: Session) -> PositionState:
            self._check_position(position)
            if self.db.in_transaction():
                raise RuntimeError("tool dispatch requires a closed prior phase")
            with self.db.begin():
                self.authority._lock(self.db)
                row = _lock_position(
                    self.db,
                    self.authority.generation_id,
                    self.position_record.position,
                )
                record = _position_record(row, generation_seq=self.authority.generation_seq)
                if record.replay_status in {"Completed", "Uncertain"}:
                    return _portable_position_state(record)
                reservation = _reservation(row)
                if not reservation["accepted"]:
                    raise ValueError("dispatch requires an accepted reservation")
                binding = self.catalog_view.binding(ToolId(record.canonical_tool_id))
                if binding.replay_policy is not replay_policy:
                    raise ValueError("durable tool replay policy changed")
                row.dispatch_claim = {
                    "attempt_no": self.authority.job_context.attempt_no,
                    "worker_id": self.authority.job_context.worker_id,
                }
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
        def operation(_db: Session) -> None:
            self._check_position(position)
            if replay_policy is not ReplayPolicy.ReDispatchable or not lease_recovered:
                raise ValueError("only verified ReDispatchable work may be re-admitted")
            if self.db.in_transaction():
                raise RuntimeError("tool recovery requires a closed prior phase")
            with self.db.begin():
                self.authority._lock(self.db)
                row = _lock_position(
                    self.db,
                    self.authority.generation_id,
                    self.position_record.position,
                )
                if row.replay_status != "Uncertain":
                    raise ValueError("only uncertain tool work may be abandoned")
                _dispatch_claim(_position_record(row, generation_seq=self.authority.generation_seq))
                if actual_attempts < row.abandoned_attempts:
                    raise ValueError("abandoned tool attempt accounting moved backwards")
                row.abandoned_attempts = actual_attempts
                row.dispatch_claim = None
                row.replay_status = "Prepared"

        return await self.database.run_sync(operation)

    async def uncertain(self, *, position: InvocationPosition) -> None:
        def operation(_db: Session) -> None:
            self._check_position(position)
            if self.db.in_transaction():
                raise RuntimeError("tool uncertainty check requires a closed prior phase")
            with self.db.begin():
                self.authority._lock(self.db)
                row = _lock_position(
                    self.db,
                    self.authority.generation_id,
                    self.position_record.position,
                )
                if row.replay_status != "Uncertain":
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
        def operation(_db: Session) -> ToolResult:
            self._check_position(position)
            if budgets is not self.budgets:
                raise ValueError("position used a different durable budget owner")
            evidence = _tool_result_evidence(result)
            try:
                self.authority._lock(self.db)
                row = _lock_position(
                    self.db,
                    self.authority.generation_id,
                    self.position_record.position,
                )
                record = _position_record(row, generation_seq=self.authority.generation_seq)
                if record.replay_status == "Completed":
                    if record.result_evidence != evidence:
                        raise ValueError("terminal result differs from completed durable position")
                    self.position_record = record
                    self.db.commit()
                    return result
                reservation = _reservation(row)
                stored_settlement = settlement
                if not reservation["accepted"]:
                    stored_settlement = Settlement(actual_attempts=0, actual_output_bytes=0)
                self.validate_settlement(position, stored_settlement)
                if (
                    stored_settlement.actual_attempts < row.abandoned_attempts
                    or stored_settlement.actual_attempts > cast(int, reservation["max_attempts"])
                    or stored_settlement.actual_output_bytes
                    > cast(int, reservation["max_output_bytes"])
                ):
                    raise ValueError("durable tool settlement exceeds its reservation")
                row.result_evidence = evidence
                row.settlement = {
                    "actual_attempts": stored_settlement.actual_attempts,
                    "actual_output_bytes": stored_settlement.actual_output_bytes,
                }
                row.replay_status = "Completed"
                row.completed_at = func.now()
                self.db.flush()
                record = _position_record(row, generation_seq=self.authority.generation_seq)
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

    async def budget_accepts(self, position: InvocationPosition, reservation: Reservation) -> bool:
        def operation(_db: Session) -> bool:
            self._check_position(position)
            if self.db.in_transaction():
                raise RuntimeError("tool budget check requires a closed prior phase")
            with self.db.begin():
                self.authority._lock(self.db)
                return self._budget_accepts_in_current_transaction(self.db, reservation)

        return await self.database.run_sync(operation)

    def validate_settlement(
        self,
        position: InvocationPosition,
        settlement: Settlement,
    ) -> None:
        self._check_position(position)
        if settlement.actual_attempts < 0 or settlement.actual_output_bytes < 0:
            raise ValueError("tool settlement cannot be negative")

    async def render_output(self, result: ToolResult) -> str:
        def operation(_db: Session) -> str:
            if self.db.in_transaction():
                raise RuntimeError("tool output rendering requires a committed terminal phase")
            with self.db.begin():
                row = _lock_position(
                    self.db,
                    self.authority.generation_id,
                    self.position_record.position,
                )
                record = _position_record(row, generation_seq=self.authority.generation_seq)
                if record.replay_status != "Completed" or record.result_evidence != (
                    _tool_result_evidence(result)
                ):
                    raise ValueError("model output requires the completed durable tool result")
                return self.authority.projection.render_output(
                    self.db,
                    authority=self.authority,
                    position=record,
                    result=result,
                )

        return await self.database.run_sync(operation)

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
        accepted: list[dict[str, object]] = []
        in_flight = 0
        for row in rows:
            if row.reservation is not None:
                stored = _reservation(row)
                if stored["accepted"]:
                    accepted.append(stored)
            if row.replay_status == "Uncertain":
                in_flight += 1
        return (
            sum(cast(int, item["calls"]) for item in accepted) + reservation.calls
            <= limits.max_calls
            and sum(cast(int, item["input_bytes"]) for item in accepted) + reservation.input_bytes
            <= limits.max_input_bytes
            and sum(cast(int, item["max_attempts"]) for item in accepted) + reservation.max_attempts
            <= limits.max_external_attempts
            and sum(cast(int, item["max_output_bytes"]) for item in accepted)
            + reservation.max_output_bytes
            <= limits.max_output_bytes
            and in_flight < limits.max_in_flight
        )

    def _check_position(self, position: InvocationPosition) -> None:
        if position != self.position:
            raise ValueError("recorder received a different invocation position")


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
                self._authority._lock(db)

        try:
            await database.run_sync(check)
        except ToolAuthorityRefused:
            self._cancelled = True


class _ToolTelemetry:
    def event(self, name: str, attributes: dict[str, Any]) -> None:
        del name, attributes


@dataclass(frozen=True, slots=True)
class GenerationToolExecutor:
    """Shared executor used by Provider API proposals and Codex MCP requests."""

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
            context = ExecutionContext(
                plan=self.authority.operation.plan,
                grant=self.authority.operation.plan.grant(tool_id),
                catalog_view=self.authority.operation.plan.catalog_view,
                position=recorder.position,
                recorder=recorder,
                effect_id=effect_id,
                budgets=recorder.budgets,
                principal=Principal(str(self.authority.user_id)),
                scope=Scope(self.authority.projection.scope_label),
                cancellation=cancellation,
                telemetry=_ToolTelemetry(),
            )
            result = await ToolExecutor.execute(binding, raw, context)
            output = await recorder.render_output(result)
            return ModelToolExecutionResult(
                model_output=ToolModelOutput(
                    call_id=transport_call_id,
                    output=output,
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
            grant = self.authority.operation.plan.grant(tool_id)
            await recorder.reserve(
                position=recorder.position,
                budgets=recorder.budgets,
                reservation=Reservation(
                    calls=1,
                    input_bytes=0,
                    max_attempts=grant.limits.max_attempts,
                    max_output_bytes=grant.limits.max_output_bytes,
                ),
            )
            await recorder.terminalize_and_settle(
                position=recorder.position,
                budgets=recorder.budgets,
                result=result,
                settlement=Settlement(actual_attempts=0, actual_output_bytes=0),
            )
            output = await recorder.render_output(result)
            return ModelToolExecutionResult(
                model_output=ToolModelOutput(
                    call_id=transport_call_id,
                    output=output,
                    is_error=True,
                ),
                position=recorder.position_record,
            )

    def refuse_unknown_call(self, *, transport_call_id: str) -> ModelToolExecutionResult:
        _validate_transport_call_id(transport_call_id)
        result: ToolResult = {"type": "Failure", "error": {"type": "InvalidInput"}}
        return ModelToolExecutionResult(
            model_output=ToolModelOutput(
                call_id=transport_call_id,
                output=canonical_json_bytes(result).decode("utf-8"),
                is_error=True,
            ),
            position=None,
        )


@dataclass(frozen=True, slots=True)
class GenerationToolAuthorityComposition:
    """Inputs that become executable only after the parent is durably active."""

    session_factory: sessionmaker[Session] = field(repr=False, compare=False)
    user_id: UUID
    owner: LlmCallOwner
    generation_id: UUID
    job_context: JobExecutionContext
    operation: FrozenToolOperation = field(repr=False, compare=False)
    projection: ToolExecutionProjection | None = field(default=None, repr=False, compare=False)

    async def open(self) -> GenerationToolExecutor:
        return GenerationToolExecutor(
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


@dataclass(slots=True)
class DeferredGenerationToolExecutor:
    """Provider-facing handle that opens authority after parent dispatch is armed."""

    composition: GenerationToolAuthorityComposition
    _executor: GenerationToolExecutor | None = field(default=None, init=False, repr=False)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False, repr=False)

    async def open(self) -> GenerationToolExecutor:
        async with self._lock:
            if self._executor is None:
                self._executor = await self.composition.open()
            return self._executor

    async def execute(
        self,
        request: BackendToolExecutionRequest,
    ) -> BackendToolExecutionResult:
        executor = await self.open()
        return await executor.execute(request)


async def compose_generation_tool_executor(
    *,
    session_factory: sessionmaker[Session],
    user_id: UUID,
    owner: LlmCallOwner,
    generation_id: UUID,
    job_context: JobExecutionContext,
    operation: FrozenToolOperation,
    projection: ToolExecutionProjection | None = None,
) -> GenerationToolExecutor:
    """Compose the one executable model-tool boundary for either transport."""

    return await GenerationToolAuthorityComposition(
        session_factory=session_factory,
        user_id=user_id,
        owner=owner,
        generation_id=generation_id,
        job_context=job_context,
        operation=operation,
        projection=projection,
    ).open()


def compose_deferred_generation_tool_executor(
    *,
    session_factory: sessionmaker[Session],
    user_id: UUID,
    owner: LlmCallOwner,
    generation_id: UUID,
    job_context: JobExecutionContext,
    operation: FrozenToolOperation,
    projection: ToolExecutionProjection | None = None,
) -> DeferredGenerationToolExecutor:
    """Compose before arm; open the same authority on the first provider proposal."""

    return DeferredGenerationToolExecutor(
        composition=GenerationToolAuthorityComposition(
            session_factory=session_factory,
            user_id=user_id,
            owner=owner,
            generation_id=generation_id,
            job_context=job_context,
            operation=operation,
            projection=projection,
        )
    )


def tool_binding_revisions_digest(plan: object) -> str:
    """Hash every executable declaration/binding/replay fact in grant order."""

    from nexus.services.tool_runtime.snapshots import FrozenToolPlanSnapshot

    if not isinstance(plan, FrozenToolPlanSnapshot):
        raise TypeError("tool binding digest requires a frozen tool plan")
    return generation_fact_digest(
        [
            {
                "binding_policy_revision": grant.binding_policy_revision,
                "id": grant.id,
                "implementation_revision": grant.implementation_revision,
                "replay_policy": grant.replay_policy,
                "tool_contract_revision": grant.tool_contract_revision,
            }
            for grant in plan.grants
        ]
    )


def tool_budget_digest(plan: object, *, effect_mode: ToolEffectMode) -> str:
    """Hash the exact run/tool/effect ceilings enforced by the executor."""

    from nexus.services.tool_runtime.snapshots import FrozenToolPlanSnapshot

    if not isinstance(plan, FrozenToolPlanSnapshot):
        raise TypeError("tool budget digest requires a frozen tool plan")
    return generation_fact_digest(
        {
            "effect_mode": effect_mode,
            "grants": [
                {"id": grant.id, "limits": grant.limits.model_dump(mode="json")}
                for grant in plan.grants
            ],
            "max_live_writes": plan.max_live_writes,
            "run_limits": plan.run_limits.model_dump(mode="json"),
        }
    )


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
    projection: ToolExecutionProjection,
) -> tuple[GenerationRecord, GenerationSpec, JobRow]:
    generation = lock_active_generation_for_authority_in_current_transaction(
        db,
        owner=owner,
        generation_id=generation_id,
    )
    if generation is None:
        raise ToolAuthorityRefused("generation is absent or terminal")
    try:
        spec = decode_generation_spec_document(generation.spec.value)
    except ValueError as error:
        raise AssertionError("persisted GenerationSpec violates semantic authority") from error
    projection.lock_owner(db, user_id=user_id, owner=owner)
    if not lock_running_job_claim(db, context=job_context):
        raise ToolAuthorityRefused("worker lease is absent or expired")
    job = get_job(db, job_context.job_id)
    if job is None:
        raise ToolAuthorityRefused("worker job disappeared")
    return generation, spec, job


def _model_tool_facts(
    spec: GenerationSpec,
) -> tuple[object, ToolEffectMode, frozenset[str]]:
    plan = spec.model_tool_plan_snapshot
    effect = spec.tool_effect_mode
    scope = spec.admitted_tool_scope
    scope_digest = spec.admitted_tool_scope_digest
    if not all(isinstance(value, Present) for value in (plan, effect, scope, scope_digest)):
        raise ToolAuthorityRefused("NoModelTools generation cannot acquire tool authority")
    assert isinstance(plan, Present)
    assert isinstance(effect, Present)
    assert isinstance(scope, Present)
    assert isinstance(scope_digest, Present)
    return plan.value, effect.value, frozenset(scope.value.admitted_refs)


def _assert_job_attempt(job: JobRow, context: JobExecutionContext) -> None:
    if (
        job.id != context.job_id
        or job.status != "running"
        or job.claimed_by != context.worker_id
        or job.attempts != context.attempt_no
    ):
        raise ToolAuthorityRefused("job differs from the claimed worker attempt")


def _validate_transport_identity(
    *,
    transport_kind: ToolTransportKind,
    model_turn_seq: int,
    transport_call_id: str,
) -> None:
    if transport_kind not in {"CodexMcp", "ProviderApi"}:
        raise ValueError("tool transport kind is unknown")
    if model_turn_seq < 1:
        raise ValueError("model turn sequence must be positive")
    _validate_transport_call_id(transport_call_id)


def _validate_transport_call_id(value: str) -> None:
    if (
        not isinstance(value, str)
        or not value
        or len(value.encode("utf-8")) > _MAX_TRANSPORT_CALL_ID_BYTES
    ):
        raise ValueError("transport call id must be bounded nonblank text")


def _assert_position_identity(
    record: ToolPositionRecord,
    *,
    tool_id: ToolId,
    input_digest: str,
    binding_revision: str,
    tool_contract_revision: str,
    authority: ToolAuthority,
) -> None:
    if (
        record.canonical_tool_id != str(tool_id)
        or record.canonical_input_digest != input_digest
        or record.tool_contract_revision != tool_contract_revision
        or record.binding_revision != binding_revision
        or record.plan_revision != authority.operation.plan.plan_revision
        or record.scope_digest != authority.scope_digest
        or record.budget_digest != authority.budget_digest
    ):
        raise ValueError("transport call identity was reused with different authority")


def _lock_position(db: Session, generation_id: UUID, position: int) -> LLMToolPosition:
    if position < 1:
        raise ValueError("tool position must be positive")
    row = db.scalar(
        select(LLMToolPosition)
        .where(
            LLMToolPosition.generation_id == generation_id,
            LLMToolPosition.position == position,
        )
        .with_for_update()
    )
    if row is None:
        raise ToolAuthorityRefused("tool position does not exist")
    return row


def _position_record(row: LLMToolPosition, *, generation_seq: int) -> ToolPositionRecord:
    if row.replay_status not in {"Prepared", "Uncertain", "Completed"}:
        raise AssertionError("persisted tool position has an unknown replay status")
    if row.transport_kind not in {"CodexMcp", "ProviderApi"}:
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
        scope_digest=row.scope_digest,
        budget_digest=row.budget_digest,
        reservation=cast(dict[str, object] | None, row.reservation),
        dispatch_claim=cast(dict[str, object] | None, row.dispatch_claim),
        abandoned_attempts=row.abandoned_attempts,
        result_evidence=cast(dict[str, object] | None, row.result_evidence),
        effect_identity=cast(dict[str, object] | None, row.effect_identity),
        settlement=cast(dict[str, object] | None, row.settlement),
        replay_status=cast(ToolReplayStatus, row.replay_status),
        created_at=row.created_at,
        completed_at=row.completed_at,
    )


def _portable_position_state(record: ToolPositionRecord) -> PositionState:
    result = None
    if record.result_evidence is not None:
        result = _result_from_evidence(record.result_evidence)
    attempts = record.abandoned_attempts
    if record.settlement is not None:
        attempts = cast(int, record.settlement["actual_attempts"])
    return PositionState(
        terminal_result=result,
        uncertain=record.replay_status == "Uncertain",
        actual_attempts=attempts,
    )


def _reservation_document(reservation: Reservation, *, accepted: bool) -> dict[str, object]:
    return {
        "accepted": accepted,
        "calls": reservation.calls,
        "input_bytes": reservation.input_bytes,
        "max_attempts": reservation.max_attempts,
        "max_output_bytes": reservation.max_output_bytes,
    }


def _reservation(row: LLMToolPosition) -> dict[str, object]:
    value = row.reservation
    if not isinstance(value, dict) or set(value) != {
        "accepted",
        "calls",
        "input_bytes",
        "max_attempts",
        "max_output_bytes",
    }:
        raise ValueError("tool position has no valid budget reservation")
    if type(value["accepted"]) is not bool or any(
        type(value[key]) is not int or cast(int, value[key]) < 0
        for key in ("calls", "input_bytes", "max_attempts", "max_output_bytes")
    ):
        raise ValueError("tool position budget reservation is malformed")
    return cast(dict[str, object], value)


def _dispatch_claim(record: ToolPositionRecord) -> dict[str, object]:
    claim = record.dispatch_claim
    if (
        not isinstance(claim, dict)
        or set(claim) != {"attempt_no", "worker_id"}
        or type(claim["attempt_no"]) is not int
        or cast(int, claim["attempt_no"]) < 1
        or not isinstance(claim["worker_id"], str)
        or not claim["worker_id"]
    ):
        raise ValueError("uncertain tool position lacks its dispatch claim")
    return claim


def _tool_result_evidence(result: ToolResult) -> dict[str, object]:
    return _json_object({"tool_result": cast(object, result)}, "tool result evidence")


def _result_from_evidence(evidence: Mapping[str, object]) -> ToolResult:
    if set(evidence) != {"tool_result"} or not isinstance(evidence["tool_result"], dict):
        raise AssertionError("completed tool result evidence is malformed")
    result = cast(dict[str, object], evidence["tool_result"])
    if result.get("type") == "Success":
        if set(result) != {"type", "value"} or not isinstance(result["value"], dict):
            raise AssertionError("completed tool success evidence is malformed")
    elif result.get("type") == "Failure":
        if set(result) != {"type", "error"} or not isinstance(result["error"], dict):
            raise AssertionError("completed tool failure evidence is malformed")
    else:
        raise AssertionError("completed tool result evidence has an unknown variant")
    return cast(ToolResult, result)


def _json_object(value: Mapping[str, object], label: str) -> dict[str, object]:
    try:
        encoded = json.dumps(
            dict(value),
            ensure_ascii=True,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        decoded = json.loads(encoded)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} is not canonical JSON") from error
    if not isinstance(decoded, dict):
        raise ValueError(f"{label} must be a JSON object")
    return cast(dict[str, object], decoded)


__all__ = [
    "DeferredGenerationToolExecutor",
    "GenerationToolAuthorityComposition",
    "GenerationToolExecutor",
    "ModelToolExecutionResult",
    "ToolAuthority",
    "ToolAuthorityRefused",
    "ToolEffectMode",
    "ToolExecutionProjection",
    "ToolModelOutput",
    "ToolPositionRecord",
    "ToolPositionRecorder",
    "ToolReplayStatus",
    "ToolTransportKind",
    "compose_deferred_generation_tool_executor",
    "compose_generation_tool_executor",
    "read_tool_positions",
    "tool_binding_revisions_digest",
    "tool_budget_digest",
]
